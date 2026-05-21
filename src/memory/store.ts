/**
 * MemoryStore — in-memory reference implementation of `EntityStore`.
 *
 * One flat `Map<uri, EntityRecord>` per ensured entity. `BYTES_ENTITY`
 * is just another entity here — its records sit in `records.get("bytes")`
 * with a single `payload` field. No special-case storage, no tree.
 *
 * `fn=ls` / `fn=count` enforce the package-wide shallow-direct-leaves
 * contract: entries under `prefix` whose remainder has no further `/`.
 *
 * Validation is strict: a record under `schema` may only contain keys
 * declared in `schema.fields`. Extra keys produce a per-entry
 * `StoreWriteResult` failure. The store does not coerce.
 *
 * `payload: ReadableStream` (and any other field whose type tag is
 * `"bytes"`) is collected to `Uint8Array` via `toBytes` before the
 * record lands in the bucket. That coercion runs for every entity that
 * declares a bytes field; nothing about it is bytes-entity-specific.
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
  type EntityRecord,
  type EntitySchema,
  type EntitySupport,
  TYPE_TAGS,
} from "../entity.ts";

const KNOWN_TAGS: ReadonlySet<string> = new Set(Object.values(TYPE_TAGS));

interface EntityMeta {
  declared: ReadonlySet<string>;
  bytesFields: ReadonlySet<string>;
  support: EntitySupport;
}

export class MemoryStore implements EntityStore {
  private readonly records = new Map<string, Map<string, EntityRecord>>();
  private readonly entities = new Map<string, EntityMeta>();

  // ── Entity provisioning ──────────────────────────────────────────

  // deno-lint-ignore require-await
  async ensureEntity(schema: EntitySchema): Promise<EntitySupport> {
    const cached = this.entities.get(schema.name);
    if (cached) return cached.support;

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

    const meta: EntityMeta = {
      declared: new Set(supported),
      bytesFields,
      support: { entity: schema.name, supported, unsupported },
    };
    this.entities.set(schema.name, meta);
    if (!this.records.has(schema.name)) {
      this.records.set(schema.name, new Map());
    }
    return meta.support;
  }

  // ── Write ────────────────────────────────────────────────────────

  async write(
    schema: EntitySchema,
    entries: { uri: string; record: EntityRecord }[],
  ): Promise<StoreWriteResult[]> {
    let meta = this.entities.get(schema.name);
    if (!meta) {
      await this.ensureEntity(schema);
      meta = this.entities.get(schema.name)!;
    }
    const bucket = this.records.get(schema.name)!;
    const results: StoreWriteResult[] = [];

    for (const { uri, record } of entries) {
      const extras = Object.keys(record).filter((k) => !meta.declared.has(k));
      if (extras.length > 0) {
        results.push({
          success: false,
          ...storageFailure(
            new Error(
              `record contains keys not declared in schema '${schema.name}': ${
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
        bucket.set(uri, normalised);
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
    schema: EntitySchema,
    urls: string[],
  ): Promise<Output<T>[]> {
    const bucket = this.records.get(schema.name);
    return urls.map((url) => {
      const parsed = parseUrl(url);
      switch (parsed.fn) {
        case "read":
          return [url, bucket?.get(parsed.uri) as T];
        case "ls":
          return [url, this._list(bucket, parsed) as T];
        case "count":
          return [url, this._count(bucket, parsed) as T];
        default:
          throw new Error(`MemoryStore: unsupported fn '${parsed.fn}'`);
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
      throw new Error("MemoryStore: pattern filter not supported");
    }
    if (params.sortBy !== undefined && params.sortBy !== "uri") {
      throw new Error(`MemoryStore: unsupported sortBy: ${params.sortBy}`);
    }
    const format = params.format ?? "full";
    if (format !== "full" && format !== "uris") {
      throw new Error(`MemoryStore: unsupported format: ${format}`);
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
      throw new Error("MemoryStore: pattern filter not supported");
    }
    return this._walk(bucket, parsed.uri).length;
  }

  // ── Delete ───────────────────────────────────────────────────────

  delete(schema: EntitySchema, uris: string[]): Promise<DeleteResult[]> {
    const bucket = this.records.get(schema.name);
    const results: DeleteResult[] = [];
    for (const uri of uris) {
      try {
        bucket?.delete(uri);
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
      schema: [...this.entities.keys()].map((n) => `entity:${n}`),
      fns: ["read", "ls", "count"],
    });
  }

  capabilities(): StoreCapabilities {
    return { atomicBatch: false };
  }
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
