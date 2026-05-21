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
 * marks the ones whose tags it recognises, and returns the
 * operational handle (declared field set, bytes-field set, signature
 * for collision detection, support report). `provisionEntity(meta)`
 * allocates the bucket and stores the meta's signature so future
 * collisions can be detected. `entityStatus(meta)` returns `"live"`
 * only when the cached signature matches `meta` exactly — a
 * same-name-different-shape schema reports `"unprovisioned"`.
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
import type { ParsedUrl } from "@bandeira-tech/b3nd-core/url";
import { parseUrl } from "@bandeira-tech/b3nd-core/url";
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

    for (const field of schema.fields) {
      const recognised = field.type.filter((t) => KNOWN_TAGS.has(t));
      if (recognised.length === 0) {
        unsupported.push({
          name: field.name,
          reason: field.type.length === 0
            ? "field declares no type tags"
            : `no recognised tag in [${field.type.join(", ")}]`,
        });
        continue;
      }
      supported.push(field.name);
      if (recognised.includes(TYPE_TAGS.BYTES)) bytesFields.add(field.name);
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
      signature: computeSignature(schema.name, supported, bytesFields),
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
      switch (parsed.fn) {
        case "read":
          return [url, bucket?.records.get(parsed.uri) as T];
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
    if (params.pattern !== undefined) {
      throw new Error(`${STORE_NAME}: pattern filter not supported`);
    }
    if (params.sortBy !== undefined && params.sortBy !== "uri") {
      throw new Error(`${STORE_NAME}: unsupported sortBy: ${params.sortBy}`);
    }
    const format = params.format ?? "full";
    if (format !== "full" && format !== "uris") {
      throw new Error(`${STORE_NAME}: unsupported format: ${format}`);
    }

    let entries = this._walk(bucket, parsed.uri);
    if (params.sortBy === "uri") {
      const dir = params.sortOrder === "desc" ? -1 : 1;
      entries = [...entries].sort(([a], [b]) => a.localeCompare(b) * dir);
    }
    if (params.limit !== undefined) {
      const page = params.page ?? 1;
      const start = (page - 1) * params.limit;
      entries = entries.slice(start, start + params.limit);
    }
    if (format === "uris") return entries.map(([uri]) => uri);
    return entries;
  }

  private _count(
    bucket: Map<string, EntityRecord> | undefined,
    parsed: ParsedUrl,
  ): number {
    if (parsed.params.pattern !== undefined) {
      throw new Error(`${STORE_NAME}: pattern filter not supported`);
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
 * from semantically-identical schemas (same name, same supported
 * fields, same bytes fields) yield the same string; any shape
 * difference yields a different one.
 */
function computeSignature(
  name: string,
  supported: string[],
  bytesFields: ReadonlySet<string>,
): string {
  const sup = [...supported].sort();
  const bytes = [...bytesFields].sort();
  return JSON.stringify({ name, sup, bytes });
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
