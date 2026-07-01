/**
 * FsStore — Filesystem implementation of `EntityStore`.
 *
 * The store is naive: URIs it is handed ARE relative filesystem paths
 * under `rootDir`, and record payloads ARE the bytes written to those
 * paths. No URI rewriting, no bytes/typed bifurcation, no field
 * planning. Only `BYTES_ENTITY` is supported — any other schema is
 * rejected at `entitySupport` time. Callers that want typed storage
 * or a custom on-disk shape supply that via a `SaveClient` mapper.
 *
 * ## Lifecycle
 *
 * `entitySupport(schema)` is pure — it validates the schema is
 * `BYTES_ENTITY` and returns the operational handle (root path,
 * signature for collision detection).
 * `provisionEntity(meta)` writes a tiny meta file at
 * `{rootDir}/.b3nd/entities/{name}` holding the signature; subsequent
 * `entityStatus(meta)` reads it back. Same-name different-shape
 * provisioning throws. The bookkeeping dir is dot-prefixed so an app
 * that points `rootDir` straight at a tree it also serves/walks keeps
 * the store's metadata out of the way — conventional dotfile-skipping
 * walkers ignore it, and it won't collide with content.
 *
 * ## Read params
 *
 * `fn=ls` / `fn=count` (without a glob) are shallow direct-leaves only:
 * `listFiles` on the prefix's directory (== `{rootDir}/{prefixUri}`),
 * filter to direct-child files (no further `/`), apply standard
 * params (`limit`/`page`/`sortBy=uri`/`sortOrder`/`format`) in memory
 * before opening file streams.
 *
 * `fn=find` is the recursive variant (v2 spec §3.3, §3.5): the store
 * calls `executor.walkFiles` on the prefix directory and yields the
 * full subtree as URIs. The glob post-filter, pagination, sort, and
 * cursor slot are all applied by `dispatchRead` (`pushDownFind: false`).
 *
 * ## URI safety
 *
 * The store rejects URIs containing `..` segments or leading `/` at
 * write/read/delete time — everything else is treated as an opaque
 * relative path. The caller's mapper is responsible for producing
 * path-safe URIs; the store's validation is a defense-in-depth check,
 * not a sanitizer.
 */

import type {
  DeleteResult,
  Output,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import type { ParsedUrl } from "../url.ts";
import { dispatchRead } from "../dispatch.ts";
import { storageFailure } from "../errors.ts";
import { validateReadParams } from "../read.ts";
import type { EntityStore } from "../entity-store.ts";
import {
  BYTES_ENTITY,
  type EntityMeta,
  type EntityRecord,
  type EntitySchema,
} from "../entity.ts";
import type { StoreCapabilities, StoreWriteResult } from "../types.ts";
import type { FsExecutor } from "./mod.ts";

const STORE_NAME = "FsStore";
const META_DIR = ".b3nd/entities";
const BYTES_SIGNATURE = "bytes:v1";

/**
 * FsStore-specific entity handle.
 *
 * `signature` is used for collision detection at provision time. All
 * FsStore metas today have the same signature (only BYTES_ENTITY is
 * supported), but the field is kept so future changes to the on-disk
 * meta shape trigger the same collision path.
 */
export interface FsEntityMeta extends EntityMeta {
  readonly signature: string;
}

/**
 * Validate that a URI is safe to use as a relative filesystem path
 * under `rootDir`. Rejects `..` segments (path traversal) and leading
 * `/` (absolute paths). Everything else is passed through as-is —
 * mappers own path shape.
 */
function assertPathSafe(uri: string): void {
  if (uri.startsWith("/")) {
    throw new Error(
      `${STORE_NAME}: URI must not start with '/'; got '${uri}'`,
    );
  }
  const parts = uri.split("/");
  for (const p of parts) {
    if (p === "..") {
      throw new Error(
        `${STORE_NAME}: URI must not contain '..' segments; got '${uri}'`,
      );
    }
  }
}

export class FsStore implements EntityStore<FsEntityMeta> {
  private readonly rootDir: string;
  private readonly executor: FsExecutor;

  constructor(rootDir: string, executor: FsExecutor) {
    if (!rootDir) throw new Error("rootDir is required");
    if (!executor) throw new Error("executor is required");

    this.rootDir = rootDir.replace(/\/+$/, "");
    this.executor = executor;
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  entitySupport(schema: EntitySchema): FsEntityMeta {
    if (schema.name !== BYTES_ENTITY.name) {
      throw new Error(
        `${STORE_NAME}: only BYTES_ENTITY is supported. Compose a ` +
          `SaveClient mapper to encode typed records to bytes upstream.`,
      );
    }
    return {
      support: {
        entity: schema.name,
        supported: ["payload"],
        unsupported: [],
      },
      signature: BYTES_SIGNATURE,
    };
  }

  async entityStatus(meta: FsEntityMeta): Promise<"live" | "unprovisioned"> {
    const recorded = await this._readMetaSignature(meta.support.entity);
    if (recorded === null) return "unprovisioned";
    return recorded === meta.signature ? "live" : "unprovisioned";
  }

  async provisionEntity(meta: FsEntityMeta): Promise<void> {
    const recorded = await this._readMetaSignature(meta.support.entity);
    if (recorded !== null) {
      if (recorded !== meta.signature) {
        throw new Error(
          `${STORE_NAME}: entity '${meta.support.entity}' is already ` +
            `provisioned with a different shape`,
        );
      }
      return;
    }
    const path = this._metaPath(meta.support.entity);
    await this.executor.writeFile(
      path,
      new TextEncoder().encode(meta.signature),
    );
  }

  // ── Write ────────────────────────────────────────────────────────

  async write(
    meta: FsEntityMeta,
    entries: { uri: string; record: EntityRecord }[],
  ): Promise<StoreWriteResult[]> {
    if (entries.length === 0) return [];
    if (
      (await this._readMetaSignature(meta.support.entity)) !== meta.signature
    ) {
      return entries.map(({ uri }) => ({
        success: false,
        ...storageFailure(
          new Error(
            `${STORE_NAME}: entity '${meta.support.entity}' is not provisioned`,
          ),
          "Entity not provisioned",
          uri,
        ),
      }));
    }
    const results: StoreWriteResult[] = [];
    for (const { uri, record } of entries) {
      try {
        assertPathSafe(uri);
        const payload = record.payload;
        if (
          !(payload instanceof Uint8Array) &&
          !(payload instanceof ReadableStream)
        ) {
          throw new Error(
            "BYTES_ENTITY record.payload must be Uint8Array or ReadableStream",
          );
        }
        await this.executor.writeFile(this._dataPath(uri), payload);
        results.push({ success: true });
      } catch (err) {
        results.push({
          success: false,
          ...storageFailure(err, "Write failed", uri),
        });
      }
    }
    return results;
  }

  // ── Read ─────────────────────────────────────────────────────────

  read<T = EntityRecord | undefined>(
    _meta: FsEntityMeta,
    urls: string[],
  ): Promise<Output<T>[]> {
    return dispatchRead<T>(urls, STORE_NAME, {
      read: (p) => this._readOne(p.uri) as Promise<T | undefined>,
      ls: (p) => this._ls(p) as Promise<Output<T>[] | string[]>,
      count: (p) => this._count(p),
      find: (p) => this._find(p) as Promise<Output<T>[] | string[]>,
      // The fs handler does not interpret the glob — it returns every
      // descendant URI; dispatch's `compileSaveGlob` post-filter does
      // the matching. Keeping the executor interface free of glob
      // semantics (Deno's `walk` has its own glob notion that does NOT
      // match the §3.3 grammar). See PR design note.
      pushDownFind: false,
    });
  }

  private async _readOne(uri: string): Promise<EntityRecord | undefined> {
    try {
      assertPathSafe(uri);
      const stream = await this.executor.readFile(this._dataPath(uri));
      return { payload: stream };
    } catch {
      return undefined;
    }
  }

  /** List direct-child URIs under a prefix (no recursion). */
  private async _listChildUris(prefixUri: string): Promise<string[]> {
    assertPathSafe(prefixUri);
    let files: string[];
    try {
      files = await this.executor.listFiles(this._dirForPrefix(prefixUri));
    } catch {
      return [];
    }
    const base = prefixUri.replace(/\/+$/, "");
    return files
      .filter((f) => !f.includes("/"))
      .map((f) => (base ? `${base}/${f}` : f));
  }

  /**
   * List every descendant URI under a prefix (deep, recursive). Drives
   * `fn=find` — `dispatchRead` then applies the glob, sort, cursor, and
   * pagination on the result.
   *
   * Yields URIs as they come out of `executor.walkFiles`. Order is
   * whatever the executor produces (Deno's `walk` is unspecified);
   * dispatch's `sortBy=uri` / `sortBy=leaf` paths cover ordering when
   * the caller asks for it.
   */
  private async _listAllDescendantUris(prefixUri: string): Promise<string[]> {
    assertPathSafe(prefixUri);
    const dir = this._dirForPrefix(prefixUri);
    const base = prefixUri.replace(/\/+$/, "");
    const out: string[] = [];
    try {
      for await (const relPath of this.executor.walkFiles(dir)) {
        out.push(base ? `${base}/${relPath}` : relPath);
      }
    } catch {
      return [];
    }
    return out;
  }

  private async _ls(
    parsed: ParsedUrl,
  ): Promise<Output<EntityRecord>[] | string[]> {
    validateReadParams(parsed.params, STORE_NAME);
    const { params } = parsed;
    const format = params.format ?? "full";

    let uris = await this._listChildUris(parsed.uri);

    if (params.sortBy === "uri") {
      const dir = params.sortOrder === "desc" ? -1 : 1;
      uris = [...uris].sort((a, b) => a.localeCompare(b) * dir);
    }
    if (params.limit !== undefined) {
      const page = params.page ?? 1;
      const start = (page - 1) * params.limit;
      uris = uris.slice(start, start + params.limit);
    }

    if (format === "uris") return uris;

    const out: Output<EntityRecord>[] = [];
    for (const uri of uris) {
      const rec = await this._readOne(uri);
      if (rec !== undefined) out.push([uri, rec]);
    }
    return out;
  }

  /**
   * `fn=find` handler: deep walk under the prefix, return Output[] or
   * string[] depending on `format`. dispatch runs the glob post-filter,
   * cursor slot, and pagination on top.
   *
   * `sortBy=uri` is handled here (the dispatch contract is: every
   * backend handles native uri-sort itself; dispatch only post-sorts
   * non-uri sortBy values). Without this, Deno's `walk` yields entries
   * in directory-traversal order, which is unstable across platforms
   * and not what `sortBy=uri` callers expect.
   */
  private async _find(
    parsed: ParsedUrl,
  ): Promise<Output<EntityRecord>[] | string[]> {
    validateReadParams(parsed.params, STORE_NAME);
    const { params } = parsed;
    const format = params.format ?? "full";
    let uris = await this._listAllDescendantUris(parsed.uri);

    if (params.sortBy === "uri") {
      const dir = params.sortOrder === "desc" ? -1 : 1;
      uris = [...uris].sort((a, b) => a.localeCompare(b) * dir);
    }

    if (format === "uris") return uris;

    const out: Output<EntityRecord>[] = [];
    for (const uri of uris) {
      const rec = await this._readOne(uri);
      if (rec !== undefined) out.push([uri, rec]);
    }
    return out;
  }

  private async _count(parsed: ParsedUrl): Promise<number> {
    if (parsed.params.pattern !== undefined) {
      // Filtered count routes through dispatch's ls-and-count path,
      // which strips `pattern` before calling our `ls` handler — we
      // should never see `params.pattern` here. Throw loudly if we do:
      // it means dispatch's contract changed and the post-filter is
      // about to silently undercount.
      throw new Error(`${STORE_NAME}: pattern filter not supported`);
    }
    return (await this._listChildUris(parsed.uri)).length;
  }

  // ── Delete ───────────────────────────────────────────────────────

  async delete(meta: FsEntityMeta, uris: string[]): Promise<DeleteResult[]> {
    if (uris.length === 0) return [];
    if (
      (await this._readMetaSignature(meta.support.entity)) !== meta.signature
    ) {
      return uris.map((uri) => ({
        success: false,
        ...storageFailure(
          new Error(
            `${STORE_NAME}: entity '${meta.support.entity}' is not provisioned`,
          ),
          "Entity not provisioned",
          uri,
        ),
      }));
    }
    const results: DeleteResult[] = [];
    for (const uri of uris) {
      try {
        assertPathSafe(uri);
        await this.executor.removeFile(this._dataPath(uri));
        results.push({ success: true });
      } catch {
        // File may not exist — succeed silently (matches the
        // miss-is-not-an-error convention).
        results.push({ success: true });
      }
    }
    return results;
  }

  // ── Status / capabilities ────────────────────────────────────────

  async status(): Promise<StatusResult> {
    try {
      const rootExists = await this.executor.exists(this.rootDir);
      if (!rootExists) {
        return {
          status: "unhealthy",
          message: `Root directory not found: ${this.rootDir}`,
          fns: ["read", "ls", "find", "count"],
        };
      }
      const schema = await this._listProvisionedEntities();
      return {
        status: "healthy",
        message: "Filesystem store is operational",
        schema: schema.map((s) => `entity:${s}`),
        fns: ["read", "ls", "find", "count"],
        details: { rootDir: this.rootDir },
      };
    } catch (error) {
      return {
        status: "unhealthy",
        message: error instanceof Error ? error.message : String(error),
        fns: ["read", "ls", "find", "count"],
      };
    }
  }

  capabilities(): StoreCapabilities {
    return { atomicBatch: false };
  }

  // ── Internals ────────────────────────────────────────────────────

  /** Full on-disk path for a record's URI. */
  private _dataPath(uri: string): string {
    return `${this.rootDir}/${uri}`;
  }

  /** Directory under which direct-leaf records of a prefix URI live. */
  private _dirForPrefix(prefixUri: string): string {
    const rel = prefixUri.replace(/\/+$/, "");
    return rel ? `${this.rootDir}/${rel}` : this.rootDir;
  }

  /** Full on-disk path for an entity's meta record. */
  private _metaPath(entityName: string): string {
    return `${this.rootDir}/${META_DIR}/${entityName}`;
  }

  /**
   * Read the persisted signature for an entity, or `null` if no
   * provisioning record exists. Used by both `entityStatus` and the
   * write/delete provisioning gate.
   */
  private async _readMetaSignature(
    entityName: string,
  ): Promise<string | null> {
    const path = this._metaPath(entityName);
    try {
      if (!(await this.executor.exists(path))) return null;
      const stream = await this.executor.readFile(path);
      const bytes = await new Response(stream).bytes();
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }

  /**
   * Scan the meta directory for every provisioned entity name. Used by
   * `status()` to advertise the entities a peer can talk to.
   */
  private async _listProvisionedEntities(): Promise<string[]> {
    const dir = `${this.rootDir}/${META_DIR}`;
    try {
      if (!(await this.executor.exists(dir))) return [];
      const files = await this.executor.listFiles(dir);
      return files.filter((f) => !f.includes("/"));
    } catch {
      return [];
    }
  }
}
