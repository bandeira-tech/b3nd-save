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
 * `fn=ls` / `fn=count` are shallow direct-leaves only: `listFiles` on
 * the prefix's mapped directory, filter to direct-child `.bin` files,
 * apply standard params (`limit`/`page`/`sortBy=uri`/`sortOrder`/
 * `format`) in memory before opening file streams.
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
import type { StoreCapabilities, StoreWriteResult } from "../types.ts";
import {
  computeSignature,
  decodeRecord,
  encodeRecord,
  type FieldPlan,
  planFields,
} from "./fields.ts";
import type { FsExecutor } from "./mod.ts";

const STORE_NAME = "FsStore";
const EXT = ".bin";
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;
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
    if (!NAME_PATTERN.test(schema.name)) {
      throw new Error(
        `${STORE_NAME}: entity name '${schema.name}' must match ${NAME_PATTERN.source}`,
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

  private async _count(meta: FsEntityMeta, parsed: ParsedUrl): Promise<number> {
    if (parsed.params.pattern !== undefined) {
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
          fns: ["read", "ls", "count"],
        };
      }
      const schema = await this._listProvisionedEntities();
      return {
        status: "healthy",
        message: "Filesystem store is operational",
        schema: schema.map((s) => `entity:${s}`),
        fns: ["read", "ls", "count"],
        details: { rootDir: this.rootDir },
      };
    } catch (error) {
      return {
        status: "unhealthy",
        message: error instanceof Error ? error.message : String(error),
        fns: ["read", "ls", "count"],
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
