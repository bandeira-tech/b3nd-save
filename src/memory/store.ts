/**
 * MemoryStore — in-memory reference implementation of `EntityStore`.
 *
 * One flat `Map<uri, EntityRecord>` per provisioned entity, keyed by
 * the entity's name. `BYTES_ENTITY` is just another entity here — its
 * records sit in the same map as any custom entity.
 *
 * ## Lifecycle
 *
 * `entitySupport(schema)` is pure: it walks the schema's fields,
 * picks the first recognised `TYPE_TAGS` entry per field as the
 * canonical tag, and returns the operational handle (declared field
 * set, bytes-field set, signature for collision detection, support
 * report). `provisionEntity(meta)` allocates the bucket and stores
 * the meta's signature so future collisions can be detected.
 * `entityStatus(meta)` returns `"live"` only when the cached
 * signature matches `meta` exactly — a same-name-different-shape
 * schema reports `"unprovisioned"`, where "shape" includes the
 * canonical type tag of each field (so changing `["string"]` to
 * `["bigint"]` on an existing field name is a collision, mirroring
 * what SQL backends catch via column-type introspection).
 *
 * Writes/reads/deletes consume the meta directly: there is no
 * per-call cache lookup gate. If `meta`'s bucket does not exist on
 * this store, `write` and `delete` surface the medium's natural
 * "not provisioned" storage failure per entry; `read` returns misses.
 *
 * ## Validation
 *
 * A record under `meta` may only contain keys declared in
 * `meta.declared`. Extra keys produce a per-entry
 * `StoreWriteResult` failure. The store does not coerce.
 *
 * `payload: ReadableStream` (and any other field whose type tag is
 * `"bytes"`) is collected to `Uint8Array` via `toBytes` before the
 * record lands in the bucket. That coercion runs for every entity
 * that declares a bytes field; nothing about it is bytes-entity-
 * specific.
 */

import type {
  DeleteResult,
  Output,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import type { ParsedUrl } from "../url.ts";
import { parseUrl } from "../url.ts";
import { patternToRegex, projectRecord } from "../read.ts";
import { storageFailure } from "../errors.ts";
import { toBytes } from "../payload.ts";
import type { StoreCapabilities, StoreWriteResult } from "../types.ts";
import type { EntityStore } from "../entity-store.ts";
import {
  type EntityMeta,
  type EntityRecord,
  type EntitySchema,
  type EntitySupport,
  TYPE_TAGS,
} from "../entity.ts";

const STORE_NAME = "MemoryStore";
const KNOWN_TAGS: ReadonlySet<string> = new Set(Object.values(TYPE_TAGS));

/**
 * MemoryStore-specific entity handle.
 *
 * `declared` and `bytesFields` drive the per-write extras check and
 * bytes-field normalisation. `signature` is the canonical string for
 * collision detection in `entityStatus` / `provisionEntity`.
 */
export interface MemoryEntityMeta extends EntityMeta {
  readonly declared: ReadonlySet<string>;
  readonly bytesFields: ReadonlySet<string>;
  readonly signature: string;
}

interface Bucket {
  readonly signature: string;
  readonly records: Map<string, EntityRecord>;
}

export class MemoryStore implements EntityStore<MemoryEntityMeta> {
  private readonly buckets = new Map<string, Bucket>();

  // ── Lifecycle ────────────────────────────────────────────────────

  entitySupport(schema: EntitySchema): MemoryEntityMeta {
    const supported: string[] = [];
    const unsupported: { name: string; reason: string }[] = [];
    const bytesFields = new Set<string>();
    // Per-field canonical tag — the first recognised TYPE_TAGS entry in
    // declaration order, matching how SQL backends pick a column type.
    // Two schemas that resolve to different canonical tags for the same
    // field name carry incompatible expectations and must collide.
    const canonical = new Map<string, string>();

    for (const field of schema.fields) {
      const first = field.type.find((t) => KNOWN_TAGS.has(t));
      if (first === undefined) {
        unsupported.push({
          name: field.name,
          reason: field.type.length === 0
            ? "field declares no type tags"
            : `no recognised tag in [${field.type.join(", ")}]`,
        });
        continue;
      }
      supported.push(field.name);
      canonical.set(field.name, first);
      if (first === TYPE_TAGS.BYTES) bytesFields.add(field.name);
    }

    const support: EntitySupport = {
      entity: schema.name,
      supported,
      unsupported,
    };
    return {
      support,
      declared: new Set(supported),
      bytesFields,
      signature: computeSignature(schema.name, canonical),
    };
  }

  // deno-lint-ignore require-await
  async entityStatus(
    meta: MemoryEntityMeta,
  ): Promise<"live" | "unprovisioned"> {
    const bucket = this.buckets.get(meta.support.entity);
    if (!bucket) return "unprovisioned";
    return bucket.signature === meta.signature ? "live" : "unprovisioned";
  }

  // deno-lint-ignore require-await
  async provisionEntity(meta: MemoryEntityMeta): Promise<void> {
    const existing = this.buckets.get(meta.support.entity);
    if (existing) {
      if (existing.signature !== meta.signature) {
        throw new Error(
          `${STORE_NAME}: entity '${meta.support.entity}' is already ` +
            `provisioned with a different shape`,
        );
      }
      return;
    }
    this.buckets.set(meta.support.entity, {
      signature: meta.signature,
      records: new Map(),
    });
  }

  // ── Write ────────────────────────────────────────────────────────

  async write(
    meta: MemoryEntityMeta,
    entries: { uri: string; record: EntityRecord }[],
  ): Promise<StoreWriteResult[]> {
    const bucket = this.buckets.get(meta.support.entity);
    const results: StoreWriteResult[] = [];

    for (const { uri, record } of entries) {
      if (!bucket) {
        results.push({
          success: false,
          ...storageFailure(
            new Error(
              `${STORE_NAME}: entity '${meta.support.entity}' is not provisioned`,
            ),
            "Entity not provisioned",
            uri,
          ),
        });
        continue;
      }
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
        const normalised = needsBytesNormalisation(record, meta.bytesFields)
          ? await normaliseBytesFields(record, meta.bytesFields)
          : { ...record };
        bucket.records.set(uri, normalised);
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

  // deno-lint-ignore require-await
  async read<T = EntityRecord | undefined>(
    meta: MemoryEntityMeta,
    urls: string[],
  ): Promise<Output<T>[]> {
    const bucket = this.buckets.get(meta.support.entity);
    return urls.map((url) => {
      const parsed = parseUrl(url);
      const fields = parsed.params.fields;
      switch (parsed.fn) {
        case "read": {
          const record = bucket?.records.get(parsed.uri);
          if (fields && fields.length > 0) {
            return [url, projectRecord(record, fields) as T];
          }
          return [url, record as T];
        }
        case "ls":
          return [url, this._list(bucket?.records, parsed) as T];
        case "count":
          return [url, this._count(bucket?.records, parsed) as T];
        default:
          throw new Error(`${STORE_NAME}: unsupported fn '${parsed.fn}'`);
      }
    });
  }

  private _walk(
    bucket: Map<string, EntityRecord> | undefined,
    uri: string,
  ): Output<EntityRecord>[] {
    if (!bucket) return [];
    const prefix = uri.endsWith("/") ? uri : `${uri}/`;
    const out: Output<EntityRecord>[] = [];
    for (const [k, rec] of bucket) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (rest.length === 0 || rest.includes("/")) continue;
      out.push([k, rec]);
    }
    return out;
  }

  private _list(
    bucket: Map<string, EntityRecord> | undefined,
    parsed: ParsedUrl,
  ): unknown {
    const { params } = parsed;
    if (params.cursor !== undefined && params.page !== undefined) {
      throw new Error(
        `${STORE_NAME}: cursor and page cannot be combined — pick one pagination mode`,
      );
    }
    if (params.sortBy !== undefined && params.sortBy !== "uri") {
      throw new Error(`${STORE_NAME}: unsupported sortBy: ${params.sortBy}`);
    }
    const format = params.format ?? "full";
    if (format !== "full" && format !== "uris") {
      throw new Error(`${STORE_NAME}: unsupported format: ${format}`);
    }

    let entries = this._walk(bucket, parsed.uri);
    if (params.pattern !== undefined) {
      const re = patternToRegex(params.pattern);
      entries = entries.filter(([uri]) =>
        re.test(uri.slice(parsed.uri.length))
      );
    }
    if (params.sortBy === "uri") {
      const dir = params.sortOrder === "desc" ? -1 : 1;
      entries = [...entries].sort(([a], [b]) => a.localeCompare(b) * dir);
    }
    if (params.cursor !== undefined) {
      const cursor = params.cursor;
      const desc = params.sortOrder === "desc";
      entries = entries.filter(([uri]) =>
        desc ? uri.localeCompare(cursor) < 0 : uri.localeCompare(cursor) > 0
      );
    }
    if (params.limit !== undefined) {
      const start = params.cursor !== undefined
        ? 0
        : ((params.page ?? 1) - 1) * params.limit;
      entries = entries.slice(start, start + params.limit);
    }
    if (format === "uris") return entries.map(([uri]) => uri);
    if (params.fields && params.fields.length > 0) {
      const allow = params.fields;
      return entries.map(([uri, rec]): Output<EntityRecord> => [
        uri,
        projectRecord(rec, allow),
      ]);
    }
    return entries;
  }

  private _count(
    bucket: Map<string, EntityRecord> | undefined,
    parsed: ParsedUrl,
  ): number {
    const { params } = parsed;
    if (params.pattern !== undefined || params.cursor !== undefined) {
      const reTest = params.pattern !== undefined
        ? patternToRegex(params.pattern)
        : null;
      const cursor = params.cursor;
      const desc = params.sortOrder === "desc";
      return this._walk(bucket, parsed.uri).filter(([uri]) => {
        if (reTest && !reTest.test(uri.slice(parsed.uri.length))) return false;
        if (cursor !== undefined) {
          return desc
            ? uri.localeCompare(cursor) < 0
            : uri.localeCompare(cursor) > 0;
        }
        return true;
      }).length;
    }
    return this._walk(bucket, parsed.uri).length;
  }

  // ── Delete ───────────────────────────────────────────────────────

  delete(
    meta: MemoryEntityMeta,
    uris: string[],
  ): Promise<DeleteResult[]> {
    const bucket = this.buckets.get(meta.support.entity);
    const results: DeleteResult[] = [];
    for (const uri of uris) {
      if (!bucket) {
        results.push({
          success: false,
          ...storageFailure(
            new Error(
              `${STORE_NAME}: entity '${meta.support.entity}' is not provisioned`,
            ),
            "Entity not provisioned",
            uri,
          ),
        });
        continue;
      }
      try {
        bucket.records.delete(uri);
        results.push({ success: true });
      } catch (err) {
        results.push({
          success: false,
          ...storageFailure(err, "Delete failed", uri),
        });
      }
    }
    return Promise.resolve(results);
  }

  // ── Status / capabilities ────────────────────────────────────────

  status(): Promise<StatusResult> {
    return Promise.resolve({
      status: "healthy",
      schema: [...this.buckets.keys()].map((n) => `entity:${n}`),
      fns: ["read", "ls", "count"],
    });
  }

  capabilities(): StoreCapabilities {
    return { atomicBatch: false };
  }
}

/**
 * Canonical signature for collision detection. Two metas produced
 * from semantically-identical schemas (same name, same set of
 * supported fields, same canonical type tag per field) yield the same
 * string; any shape difference — including a field whose tag changed
 * from `"string"` to `"bigint"` — yields a different one.
 *
 * Matches the granularity SQL backends get for free via column-type
 * introspection: a tag swap on an existing field is a collision even
 * though the field name is unchanged.
 */
function computeSignature(
  name: string,
  canonical: ReadonlyMap<string, string>,
): string {
  const fields = [...canonical.entries()]
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({ name, fields });
}

/**
 * Quick predicate: does the record have a `ReadableStream` (or a
 * non-bytes value that needs to be rejected) on any of its bytes
 * fields? Lets the write hot path skip the async normalisation step
 * when every value is already a `Uint8Array`.
 */
function needsBytesNormalisation(
  record: EntityRecord,
  bytesFields: ReadonlySet<string>,
): boolean {
  for (const name of bytesFields) {
    const v = record[name];
    if (v === undefined || v === null) continue;
    if (v instanceof Uint8Array) continue;
    return true;
  }
  return false;
}

/**
 * Collect any `ReadableStream` values on `bytes`-tagged fields into
 * `Uint8Array` and return a shallow-copied record. Non-stream values
 * pass through; this is the same coercion every backend with a
 * non-streaming write path performs, generalised across fields.
 */
async function normaliseBytesFields(
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
