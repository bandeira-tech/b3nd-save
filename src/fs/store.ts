/**
 * FsStore — Filesystem implementation of `EntityStore`.
 *
 * One backend, many entities. Layouts:
 *
 * - `BYTES_ENTITY` → file at `{rootDir}/{uriToRelPath(uri)}` holding
 *   the raw payload bytes (existing layout — no migration).
 * - any other schema → file at
 *   `{rootDir}/entities/{entityName}/{uriToRelPath(uri)}` holding a
 *   JSON-encoded record. Per-field canonical `TYPE_TAGS` round-trip
 *   the JSON boundary (bytes → base64, bigint → string, timestamp →
 *   ISO-8601 — see `./fields.ts`).
 *
 * ## Lifecycle
 *
 * `entitySupport(schema)` is pure — it plans the field set and computes
 * a collision signature. `provisionEntity(meta)` writes a tiny meta
 * file at `{rootDir}/__meta__/entities/{name}` holding the signature;
 * subsequent `entityStatus(meta)` reads it back. Same-name
 * different-shape provisioning throws.
 *
 * ## Read params
 *
 * `fn=ls` / `fn=count` (without a glob) are shallow direct-leaves only:
 * `listFiles` on the prefix's mapped directory, filter to direct-child
 * `.bin` files, apply standard params (`limit`/`page`/`sortBy=uri`/
 * `sortOrder`/`format`) in memory before opening file streams.
 *
 * `fn=find` is the recursive variant (v2 spec §3.3, §3.5): the store
 * calls `executor.walkFiles` on the prefix's mapped directory and
 * yields the full subtree as URIs. The glob post-filter, pagination,
 * sort, and cursor slot are all applied by `dispatchRead` (we register
 * the `find` handler with `pushDownFind: false` because letting the
 * dispatch's `compileSaveGlob` pipeline run keeps the executor
 * interface free of glob semantics — see the design note in the
 * coordination room for why we didn't push the glob into the executor).
 */

import type {
  DeleteResult,
  Output,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import type { ParsedUrl } from "../url.ts";
import { dispatchRead } from "../dispatch.ts";
import { storageFailure } from "../errors.ts";
import { toBytes } from "../payload.ts";
import { validateReadParams } from "../read.ts";
import type { EntityStore } from "../entity-store.ts";
import {
  BYTES_ENTITY,
  type EntityMeta,
  type EntityRecord,
  type EntitySchema,
} from "../entity.ts";
import { IDENTIFIER_PATTERN, isValidIdentifier } from "../identifiers.ts";
import type { StoreCapabilities, StoreWriteResult } from "../types.ts";
import {
  computeSignature,
  decodeRecord,
  encodeRecord,
  type FieldPlan,
  planFields,
} from "../json-fields.ts";
import type { FsExecutor } from "./mod.ts";

const STORE_NAME = "FsStore";
const EXT = ".bin";

const ENTITY_DIR = "entities";
const META_DIR = "__meta__/entities";

/**
 * Convert a URI to a relative filesystem path.
 * `protocol://host/path` becomes `protocol_host/path.bin`.
 *
 * Only the FIRST `://` is rewritten — embedded `://` (rare but legal
 * in protocol-tunneling uris) stays in the path.
 */
function uriToRelPath(uri: string): string {
  return uri.replace("://", "_") + EXT;
}

/**
 * Convert a relative filesystem path back to a URI.
 * `protocol_host/path.bin` becomes `protocol://host/path`.
 */
function relPathToUri(relPath: string): string {
  const withoutExt = relPath.endsWith(EXT)
    ? relPath.slice(0, -EXT.length)
    : relPath;
  return withoutExt.replace("_", "://");
}

/**
 * FsStore-specific entity handle.
 *
 * `pathPrefix` is the on-disk root for this entity's records
 * (`{rootDir}` for BYTES_ENTITY, `{rootDir}/entities/{name}` for
 * custom). `isBytes` selects the raw-payload-file layout vs the
 * JSON-encoded record layout. `fields`/`declared`/`bytesFields` drive
 * write-time validation and encoding; `signature` is used for
 * collision detection.
 */
export interface FsEntityMeta extends EntityMeta {
  readonly pathPrefix: string;
  readonly isBytes: boolean;
  readonly fields: readonly FieldPlan[];
  readonly declared: ReadonlySet<string>;
  readonly bytesFields: ReadonlySet<string>;
  readonly signature: string;
}

function isBytesSchema(schema: EntitySchema): boolean {
  return schema.name === BYTES_ENTITY.name;
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
    if (isBytesSchema(schema)) {
      const fields: FieldPlan[] = [{ name: "payload", tag: "bytes" }];
      return {
        support: {
          entity: schema.name,
          supported: ["payload"],
          unsupported: [],
        },
        pathPrefix: this.rootDir,
        isBytes: true,
        fields,
        declared: new Set(["payload"]),
        bytesFields: new Set(["payload"]),
        signature: computeSignature(schema.name, fields),
      };
    }
    if (!isValidIdentifier(schema.name)) {
      throw new Error(
        `${STORE_NAME}: entity name '${schema.name}' must match ${IDENTIFIER_PATTERN.source}`,
      );
    }
    const { fields, unsupported } = planFields(schema.fields);
    const declared = new Set(fields.map((f) => f.name));
    const bytesFields = new Set(
      fields.filter((f) => f.tag === "bytes").map((f) => f.name),
    );
    return {
      support: {
        entity: schema.name,
        supported: fields.map((f) => f.name),
        unsupported,
      },
      pathPrefix: `${this.rootDir}/${ENTITY_DIR}/${schema.name}`,
      isBytes: false,
      fields,
      declared,
      bytesFields,
      signature: computeSignature(schema.name, fields),
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
      const extras = Object.keys(record).filter((k) => !meta.declared.has(k));
      if (extras.length > 0) {
        results.push({
          success: false,
          ...storageFailure(
            new Error(
              `record contains keys not declared in schema '${meta.support.entity}': ${
                extras.join(", ")
              }`,
            ),
            "Schema mismatch",
            uri,
          ),
        });
        continue;
      }
      try {
        if (meta.isBytes) {
          const payload = record.payload;
          if (
            !(payload instanceof Uint8Array) &&
            !(payload instanceof ReadableStream)
          ) {
            throw new Error(
              "BYTES_ENTITY record.payload must be Uint8Array or ReadableStream",
            );
          }
          await this.executor.writeFile(this._dataPath(meta, uri), payload);
        } else {
          const normalised = await this._normaliseBytesFields(
            record,
            meta.bytesFields,
          );
          const json = JSON.stringify(encodeRecord(meta.fields, normalised));
          await this.executor.writeFile(
            this._dataPath(meta, uri),
            new TextEncoder().encode(json),
          );
        }
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
    meta: FsEntityMeta,
    urls: string[],
  ): Promise<Output<T>[]> {
    return dispatchRead<T>(urls, STORE_NAME, {
      read: (p) => this._readOne(meta, p.uri) as Promise<T | undefined>,
      ls: (p) => this._ls(meta, p) as Promise<Output<T>[] | string[]>,
      count: (p) => this._count(meta, p),
      find: (p) => this._find(meta, p) as Promise<Output<T>[] | string[]>,
      // The fs handler does not interpret the glob — it returns every
      // descendant URI; dispatch's `compileSaveGlob` post-filter does
      // the matching. Keeping the executor interface free of glob
      // semantics (Deno's `walk` has its own glob notion that does NOT
      // match the §3.3 grammar). See PR design note.
      pushDownFind: false,
    });
  }

  private async _readOne(
    meta: FsEntityMeta,
    uri: string,
  ): Promise<EntityRecord | undefined> {
    try {
      const stream = await this.executor.readFile(this._dataPath(meta, uri));
      if (meta.isBytes) return { payload: stream };
      const bytes = await new Response(stream).bytes();
      const text = new TextDecoder().decode(bytes);
      return decodeRecord(meta.fields, JSON.parse(text));
    } catch {
      return undefined;
    }
  }

  /** List direct-child URIs under a prefix (no recursion). */
  private async _listChildUris(
    meta: FsEntityMeta,
    prefixUri: string,
  ): Promise<string[]> {
    let files: string[];
    try {
      files = await this.executor.listFiles(
        this._dirForPrefix(meta, prefixUri),
      );
    } catch {
      return [];
    }
    const relDir = uriToRelPath(prefixUri).slice(0, -EXT.length).replace(
      /\/+$/,
      "",
    );
    return files
      .filter((f) => f.endsWith(EXT) && !f.includes("/"))
      .map((f) => relPathToUri(`${relDir}/${f}`));
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
  private async _listAllDescendantUris(
    meta: FsEntityMeta,
    prefixUri: string,
  ): Promise<string[]> {
    const dir = this._dirForPrefix(meta, prefixUri);
    const relDir = uriToRelPath(prefixUri).slice(0, -EXT.length).replace(
      /\/+$/,
      "",
    );
    const out: string[] = [];
    try {
      for await (const relPath of this.executor.walkFiles(dir)) {
        if (!relPath.endsWith(EXT)) continue;
        // The walk yields paths relative to `dir`; combining with
        // `relDir` gives the relative-to-rootDir form `relPathToUri`
        // expects. When `relDir` is empty (prefix is the entity root),
        // the relPath is already root-relative.
        const composed = relDir ? `${relDir}/${relPath}` : relPath;
        out.push(relPathToUri(composed));
      }
    } catch {
      return [];
    }
    return out;
  }

  private async _ls(
    meta: FsEntityMeta,
    parsed: ParsedUrl,
  ): Promise<Output<EntityRecord>[] | string[]> {
    validateReadParams(parsed.params, STORE_NAME);
    const { params } = parsed;
    const format = params.format ?? "full";

    let uris = await this._listChildUris(meta, parsed.uri);

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
      const rec = await this._readOne(meta, uri);
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
    meta: FsEntityMeta,
    parsed: ParsedUrl,
  ): Promise<Output<EntityRecord>[] | string[]> {
    validateReadParams(parsed.params, STORE_NAME);
    const { params } = parsed;
    const format = params.format ?? "full";
    let uris = await this._listAllDescendantUris(meta, parsed.uri);

    if (params.sortBy === "uri") {
      const dir = params.sortOrder === "desc" ? -1 : 1;
      uris = [...uris].sort((a, b) => a.localeCompare(b) * dir);
    }

    if (format === "uris") return uris;

    const out: Output<EntityRecord>[] = [];
    for (const uri of uris) {
      const rec = await this._readOne(meta, uri);
      if (rec !== undefined) out.push([uri, rec]);
    }
    return out;
  }

  private async _count(meta: FsEntityMeta, parsed: ParsedUrl): Promise<number> {
    if (parsed.params.pattern !== undefined) {
      // Filtered count routes through dispatch's ls-and-count path,
      // which strips `pattern` before calling our `ls` handler — we
      // should never see `params.pattern` here. Throw loudly if we do:
      // it means dispatch's contract changed and the post-filter is
      // about to silently undercount.
      throw new Error(`${STORE_NAME}: pattern filter not supported`);
    }
    return (await this._listChildUris(meta, parsed.uri)).length;
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
        await this.executor.removeFile(this._dataPath(meta, uri));
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

  /** Full on-disk path for a record under an entity. */
  private _dataPath(meta: FsEntityMeta, uri: string): string {
    return `${meta.pathPrefix}/${uriToRelPath(uri)}`;
  }

  /** Directory under which an entity's direct-leaf records live. */
  private _dirForPrefix(meta: FsEntityMeta, prefixUri: string): string {
    const rel = uriToRelPath(prefixUri).slice(0, -EXT.length).replace(
      /\/+$/,
      "",
    );
    return rel ? `${meta.pathPrefix}/${rel}` : meta.pathPrefix;
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

  /**
   * Collect any `ReadableStream` values on `bytes`-tagged fields into
   * `Uint8Array` and return a shallow-copied record.
   */
  private async _normaliseBytesFields(
    record: EntityRecord,
    bytesFields: ReadonlySet<string>,
  ): Promise<EntityRecord> {
    const out: EntityRecord = { ...record };
    for (const name of bytesFields) {
      const v = out[name];
      if (v === undefined || v === null) continue;
      if (v instanceof Uint8Array) continue;
      if (v instanceof ReadableStream) {
        out[name] = await toBytes(v);
        continue;
      }
      throw new Error(
        `field '${name}' must be Uint8Array or ReadableStream, got ${typeof v}`,
      );
    }
    return out;
  }
}
