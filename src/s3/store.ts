/**
 * S3Store — Amazon S3 implementation of `EntityStore`.
 *
 * One backend, many entities. Layouts:
 *
 * - `BYTES_ENTITY` → object key `{prefix}{uriToKey(uri)}.bin` holding
 *   the raw payload bytes (existing layout — no migration).
 * - any other schema → object key
 *   `{prefix}entities/{entityName}/{uriToKey(uri)}.bin` holding a
 *   JSON-encoded record. Per-field canonical `TYPE_TAGS` round-trip
 *   the JSON boundary (bytes → base64, bigint → string, timestamp →
 *   ISO-8601 — see `./fields.ts`).
 *
 * ## Lifecycle
 *
 * `entitySupport(schema)` is pure — it plans the field set and computes
 * a collision signature. `provisionEntity(meta)` writes a tiny meta
 * object at `{prefix}__meta__/entities/{name}` holding the signature;
 * subsequent `entityStatus(meta)` reads it back.
 *
 * ## Read params
 *
 * `fn=ls` / `fn=count` are shallow direct-leaves only: `listObjects`
 * under the entity's key range, filter to direct-child `.bin` keys
 * (no further `/`). Standard params (`limit`/`page`/`sortBy=uri`/
 * `sortOrder`/`format`) are applied in memory; `format=uris` and
 * `count` skip the per-leaf `getObject`.
 *
 * `fn=find` is the recursive variant (v2 spec §3.3, §3.5): S3's
 * `listObjects(prefix)` already walks every key under the prefix
 * (the flat keyspace is what S3 returns natively — the shallow
 * `tail.includes("/")` drop in `_listChildUris` is an in-process
 * filter we omit for find). Dispatch applies the glob post-filter,
 * sort, cursor, and pagination on top. We declare `pushDownFind:
 * false` honestly: the *prefix* is pushed down (S3 supports nothing
 * else), but the §3.3 glob grammar (`?`, `*`, `**`, mid-`**`) is
 * richer than what S3's list API expresses, so the glob match still
 * happens in dispatch.
 *
 * ### Known limit: listObjects pagination
 *
 * S3's `ListObjectsV2` returns at most 1000 keys per response and
 * paginates via `ContinuationToken`. The current `S3Executor.listObjects`
 * contract returns a flat `string[]` — executors are expected to walk
 * the continuation themselves and concatenate. The in-tree integration
 * executor (`./integration.test.ts`) does NOT yet paginate, so any
 * entity holding >1000 records will silently truncate in the
 * integration suite. Production executors built on the AWS SDK
 * (e.g. via `@aws-sdk/client-s3`'s paginator) get this for free.
 *
 * ### Push-down matrix
 *
 * - `pushDownPattern`: not advertised — dispatch runs the glob.
 * - `pushDownCursor`: not advertised — dispatch slices in JS.
 * - `pushDownSortBy`: not advertised — dispatch sorts in JS.
 * - `pushDownFind`: false (see above).
 * - `pushDownCount`: not advertised — S3 has no efficient COUNT
 *   (a COUNT translation would require streaming every key under
 *   the prefix and tallying). For deep counts (`**`), dispatch
 *   walks via the find handler and returns the length.
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
import type { S3Executor } from "./mod.ts";

const STORE_NAME = "S3Store";
const EXT = ".bin";

const ENTITY_KEY_PREFIX = "entities";
const META_KEY_PREFIX = "__meta__/entities";

/** `protocol://host/path` → `protocol_host/path`. */
function uriToKey(uri: string): string {
  return uri.replace("://", "_").replace(/^\//, "");
}

/** Inverse of `uriToKey` with `.bin` suffix stripping. */
function keyTailToUri(tail: string): string {
  const noExt = tail.endsWith(EXT) ? tail.slice(0, -EXT.length) : tail;
  return noExt.replace("_", "://");
}

/**
 * S3Store-specific entity handle.
 *
 * `keyPrefix` is the S3 key root for this entity's objects (the
 * store's `prefix` for BYTES_ENTITY, plus `entities/{name}/` for
 * custom). `isBytes` selects the raw-payload object body vs the
 * JSON-encoded record body. `fields`/`declared`/`bytesFields` drive
 * write-time validation and encoding; `signature` is used for
 * collision detection.
 */
export interface S3EntityMeta extends EntityMeta {
  readonly keyPrefix: string;
  readonly isBytes: boolean;
  readonly fields: readonly FieldPlan[];
  readonly declared: ReadonlySet<string>;
  readonly bytesFields: ReadonlySet<string>;
  readonly signature: string;
}

function isBytesSchema(schema: EntitySchema): boolean {
  return schema.name === BYTES_ENTITY.name;
}

export class S3Store implements EntityStore<S3EntityMeta> {
  private readonly bucket: string;
  private readonly executor: S3Executor;
  private readonly prefix: string;

  constructor(bucket: string, executor: S3Executor, prefix?: string) {
    if (!bucket) throw new Error("bucket is required");
    if (!executor) throw new Error("executor is required");

    this.bucket = bucket;
    this.executor = executor;
    this.prefix = prefix ?? "";
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  entitySupport(schema: EntitySchema): S3EntityMeta {
    if (isBytesSchema(schema)) {
      const fields: FieldPlan[] = [{ name: "payload", tag: "bytes" }];
      return {
        support: {
          entity: schema.name,
          supported: ["payload"],
          unsupported: [],
        },
        keyPrefix: this.prefix,
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
      keyPrefix: `${this.prefix}${ENTITY_KEY_PREFIX}/${schema.name}/`,
      isBytes: false,
      fields,
      declared,
      bytesFields,
      signature: computeSignature(schema.name, fields),
    };
  }

  async entityStatus(meta: S3EntityMeta): Promise<"live" | "unprovisioned"> {
    const recorded = await this._readMetaSignature(meta.support.entity);
    if (recorded === null) return "unprovisioned";
    return recorded === meta.signature ? "live" : "unprovisioned";
  }

  async provisionEntity(meta: S3EntityMeta): Promise<void> {
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
    await this.executor.putObject(
      this._metaKey(meta.support.entity),
      new TextEncoder().encode(meta.signature),
      "text/plain",
    );
  }

  // ── Write ────────────────────────────────────────────────────────

  async write(
    meta: S3EntityMeta,
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
          await this.executor.putObject(
            this._dataKey(meta, uri),
            payload,
            "application/octet-stream",
          );
        } else {
          const normalised = await this._normaliseBytesFields(
            record,
            meta.bytesFields,
          );
          const json = JSON.stringify(encodeRecord(meta.fields, normalised));
          await this.executor.putObject(
            this._dataKey(meta, uri),
            new TextEncoder().encode(json),
            "application/json",
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
    meta: S3EntityMeta,
    urls: string[],
  ): Promise<Output<T>[]> {
    return dispatchRead<T>(urls, STORE_NAME, {
      read: (p) => this._readOne(meta, p.uri) as Promise<T | undefined>,
      ls: (p) => this._ls(meta, p) as Promise<Output<T>[] | string[]>,
      count: (p) => this._count(meta, p),
      find: (p) => this._find(meta, p) as Promise<Output<T>[] | string[]>,
      // The handler returns every descendant URI under the prefix;
      // dispatch's `compileSaveGlob` post-filter applies the §3.3
      // grammar (`?`, `*`, `**`, mid-`**`). S3's list API only
      // expresses prefix matching, so push-down stops at the prefix.
      pushDownFind: false,
    });
  }

  private async _readOne(
    meta: S3EntityMeta,
    uri: string,
  ): Promise<EntityRecord | undefined> {
    const stream = await this.executor.getObject(this._dataKey(meta, uri));
    if (!stream) return undefined;
    if (meta.isBytes) return { payload: stream };
    try {
      const bytes = await new Response(stream).bytes();
      const text = new TextDecoder().decode(bytes);
      return decodeRecord(meta.fields, JSON.parse(text));
    } catch {
      return undefined;
    }
  }

  /** List direct-child URIs under a prefix (no recursion into sub-prefixes). */
  private async _listChildUris(
    meta: S3EntityMeta,
    prefixUri: string,
  ): Promise<string[]> {
    const keyPrefix = `${meta.keyPrefix}${uriToKey(prefixUri)}`;
    const keys = await this.executor.listObjects(keyPrefix);
    const uris: string[] = [];
    for (const key of keys) {
      if (!key.endsWith(EXT)) continue;
      const tail = key.slice(keyPrefix.length);
      if (tail.includes("/")) continue;
      uris.push(`${prefixUri}${keyTailToUri(tail)}`);
    }
    return uris;
  }

  /**
   * List every descendant URI under a prefix (deep walk). Powers
   * `fn=find`. Unlike `_listChildUris`, this keeps keys whose tail
   * contains `/` — S3's `listObjects(prefix)` already returns every
   * key under the prefix (flat keyspace), so the recursive walk is
   * "the same call without the shallow drop". Dispatch's
   * `compileSaveGlob` post-filter then applies the user's deep glob
   * pattern (e.g. `**` or `**` + `/sub/*.md`), sort, cursor, and
   * pagination.
   *
   * Pagination: relies on `S3Executor.listObjects` to walk
   * continuation tokens itself (see the module-level comment about
   * the in-tree integration executor's known truncation).
   */
  private async _listAllDescendantUris(
    meta: S3EntityMeta,
    prefixUri: string,
  ): Promise<string[]> {
    const keyPrefix = `${meta.keyPrefix}${uriToKey(prefixUri)}`;
    const keys = await this.executor.listObjects(keyPrefix);
    const uris: string[] = [];
    for (const key of keys) {
      if (!key.endsWith(EXT)) continue;
      const tail = key.slice(keyPrefix.length);
      uris.push(`${prefixUri}${keyTailToUri(tail)}`);
    }
    return uris;
  }

  private async _ls(
    meta: S3EntityMeta,
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

  private async _count(meta: S3EntityMeta, parsed: ParsedUrl): Promise<number> {
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

  /**
   * `fn=find` handler: deep walk under the prefix, return Output[] or
   * string[] depending on `format`. dispatch runs the glob post-filter,
   * sort, pagination, and cursor slot on top.
   */
  private async _find(
    meta: S3EntityMeta,
    parsed: ParsedUrl,
  ): Promise<Output<EntityRecord>[] | string[]> {
    validateReadParams(parsed.params, STORE_NAME);
    const format = parsed.params.format ?? "full";
    const uris = await this._listAllDescendantUris(meta, parsed.uri);

    if (format === "uris") return uris;

    const out: Output<EntityRecord>[] = [];
    for (const uri of uris) {
      const rec = await this._readOne(meta, uri);
      if (rec !== undefined) out.push([uri, rec]);
    }
    return out;
  }

  // ── Delete ───────────────────────────────────────────────────────

  async delete(meta: S3EntityMeta, uris: string[]): Promise<DeleteResult[]> {
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
        await this.executor.deleteObject(this._dataKey(meta, uri));
        results.push({ success: true });
      } catch (err) {
        results.push({
          success: false,
          ...storageFailure(err, "Delete failed", uri),
        });
      }
    }
    return results;
  }

  // ── Status / capabilities ────────────────────────────────────────

  async status(): Promise<StatusResult> {
    try {
      const ok = await this.executor.headBucket();
      if (!ok) {
        return {
          status: "unhealthy",
          message: `Bucket not accessible: ${this.bucket}`,
          fns: ["read", "ls", "find", "count"],
        };
      }
      const schema = await this._listProvisionedEntities();
      return {
        status: "healthy",
        message: "S3 store is operational",
        schema: schema.map((s) => `entity:${s}`),
        fns: ["read", "ls", "find", "count"],
        details: { bucket: this.bucket, prefix: this.prefix || "(none)" },
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

  /** Full S3 key for a record under an entity. */
  private _dataKey(meta: S3EntityMeta, uri: string): string {
    return `${meta.keyPrefix}${uriToKey(uri)}${EXT}`;
  }

  /** Full S3 key for an entity's meta object. */
  private _metaKey(entityName: string): string {
    return `${this.prefix}${META_KEY_PREFIX}/${entityName}`;
  }

  /**
   * Read the persisted signature for an entity, or `null` if no
   * provisioning record exists.
   */
  private async _readMetaSignature(
    entityName: string,
  ): Promise<string | null> {
    try {
      const stream = await this.executor.getObject(this._metaKey(entityName));
      if (!stream) return null;
      const bytes = await new Response(stream).bytes();
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }

  /**
   * Scan the meta keyspace for every provisioned entity name. Used by
   * `status()` to advertise the entities a peer can talk to.
   */
  private async _listProvisionedEntities(): Promise<string[]> {
    const metaKeyPrefix = `${this.prefix}${META_KEY_PREFIX}/`;
    try {
      const keys = await this.executor.listObjects(metaKeyPrefix);
      return keys
        .map((k) => k.slice(metaKeyPrefix.length))
        .filter((k) => k.length > 0 && !k.includes("/"));
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
