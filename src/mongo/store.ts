/**
 * MongoStore — MongoDB implementation of `EntityStore`.
 *
 * One layout for every schema: a per-entity collection named
 * `{prefix}_{entity}_data` with a `uri` primary key and one document
 * key per supported field, plus `createdAt` / `updatedAt`.
 * `BYTES_ENTITY` is just an entity with one `payload` field of BSON
 * binary — no legacy special case.
 *
 * ## Lifecycle
 *
 * `entitySupport(schema)` is pure — it runs `planFields` and returns
 * a `MongoEntityMeta` with the target collection name, declared field
 * set, bytes-field set, canonical-tag-per-field signature, and the
 * support report. No IO.
 *
 * `provisionEntity(meta)` materialises the entity:
 *
 *   1. Reads the meta collection `{prefix}_meta` for a prior entry
 *      under `meta.support.entity`.
 *   2. If found with a matching signature → no-op (idempotent).
 *   3. If found with a different signature → throws (collision: a
 *      same-name entity is already live in a different shape).
 *   4. Otherwise: creates the entity collection, creates the `uri`
 *      index, and upserts the meta entry.
 *
 * `entityStatus(meta)` reads the meta collection and reports `"live"`
 * only when the stored signature matches. Mongo is schemaless on the
 * wire — without an explicit meta record there is nothing to
 * introspect, so the meta collection is how shape collisions get
 * detected (the same approach MemoryStore uses; the SQL backends get
 * the same guarantee for free via column-type introspection).
 *
 * Writes/reads/deletes consume the meta directly: no per-call cache
 * gate. The store enforces the extras check (a record with keys not
 * declared in `meta` produces a per-entry write failure); value-type
 * enforcement is left to higher layers because Mongo will accept any
 * value at the BSON level.
 *
 * `fn=ls` / `fn=count` push down to MongoDB via a regex prefix filter
 * on `uri` that enforces the shallow-direct-leaves contract
 * (`^<prefix>[^/]+$`).
 *
 * Mongo does not provide a portable single-collection batch
 * write/delete primitive that fits the package's per-entry result
 * contract, so writes happen one document at a time and
 * `capabilities.atomicBatch` is `false`. Stream-shaped values on
 * bytes fields are collected to `Uint8Array` up front per entry.
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
import { patternToRegexBody, validateReadParams } from "../read.ts";
import type { EntityStore } from "../entity-store.ts";
import {
  type EntityMeta,
  type EntityRecord,
  type EntitySchema,
  type EntitySupport,
  TYPE_TAGS,
} from "../entity.ts";
import { IDENTIFIER_PATTERN, isValidIdentifier } from "../identifiers.ts";
import type { StoreCapabilities, StoreWriteResult } from "../types.ts";
import { computeSignature, type FieldPlan, planFields } from "./fields.ts";
import type { MongoExecutor } from "./mod.ts";

const STORE_NAME = "MongoStore";

/**
 * MongoStore-specific entity handle.
 *
 * `collectionName` is the prefixed-and-suffixed target collection
 * (`{prefix}_{entity}_data`); `fields` are the planned user fields
 * (without the always-present `uri`, `createdAt`, `updatedAt`);
 * `declared` is the set of user field names for the per-write extras
 * check; `bytesFields` drives stream normalisation. `signature` is
 * the canonical string used by the meta collection for collision
 * detection.
 */
export interface MongoEntityMeta extends EntityMeta {
  readonly collectionName: string;
  readonly fields: readonly FieldPlan[];
  readonly declared: ReadonlySet<string>;
  readonly bytesFields: ReadonlySet<string>;
  readonly signature: string;
}

/** Escape special regex characters for safe use in a `$regex` filter. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalise a Mongo document field into a `Uint8Array`. The driver may
 * surface BSON `Binary` (which exposes `.buffer`) or a raw
 * `Uint8Array` depending on options.
 */
function docToBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (
    value && typeof value === "object" &&
    "buffer" in (value as Record<string, unknown>) &&
    (value as { buffer: unknown }).buffer instanceof Uint8Array
  ) {
    return (value as { buffer: Uint8Array }).buffer;
  }
  if (
    value && typeof value === "object" &&
    "buffer" in (value as Record<string, unknown>) &&
    (value as { buffer: unknown }).buffer instanceof ArrayBuffer
  ) {
    return new Uint8Array((value as { buffer: ArrayBuffer }).buffer);
  }
  throw new Error(`${STORE_NAME}: unexpected payload type ${typeof value}`);
}

function entityCollectionName(prefix: string, entityName: string): string {
  if (!isValidIdentifier(entityName)) {
    throw new Error(
      `${STORE_NAME}: entity name '${entityName}' must match ${IDENTIFIER_PATTERN.source}`,
    );
  }
  return `${prefix}_${entityName}_data`;
}

function metaCollectionName(prefix: string): string {
  return `${prefix}_meta`;
}

export class MongoStore implements EntityStore<MongoEntityMeta> {
  private readonly collectionPrefix: string;
  private readonly executor: MongoExecutor;

  constructor(collectionPrefix: string, executor: MongoExecutor) {
    if (!collectionPrefix) throw new Error("collectionPrefix is required");
    if (!isValidIdentifier(collectionPrefix)) {
      throw new Error(
        `collectionPrefix must match ${IDENTIFIER_PATTERN.source}; got '${collectionPrefix}'`,
      );
    }
    if (!executor) throw new Error("executor is required");

    this.collectionPrefix = collectionPrefix;
    this.executor = executor;
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  entitySupport(schema: EntitySchema): MongoEntityMeta {
    const { fields, unsupported } = planFields(schema.fields);
    const support: EntitySupport = {
      entity: schema.name,
      supported: fields.map((f) => f.name),
      unsupported,
    };
    return {
      support,
      collectionName: entityCollectionName(this.collectionPrefix, schema.name),
      fields,
      declared: new Set(fields.map((f) => f.name)),
      bytesFields: new Set(
        fields.filter((f) => f.tag === TYPE_TAGS.BYTES).map((f) => f.name),
      ),
      signature: computeSignature(schema.name, fields),
    };
  }

  async entityStatus(
    meta: MongoEntityMeta,
  ): Promise<"live" | "unprovisioned"> {
    const metaDoc = await this.executor
      .collection(metaCollectionName(this.collectionPrefix))
      .findOne({ _id: meta.support.entity });
    if (!metaDoc) return "unprovisioned";
    return metaDoc.signature === meta.signature ? "live" : "unprovisioned";
  }

  async provisionEntity(meta: MongoEntityMeta): Promise<void> {
    const metaColl = this.executor.collection(
      metaCollectionName(this.collectionPrefix),
    );
    const existing = await metaColl.findOne({ _id: meta.support.entity });
    if (existing) {
      if (existing.signature !== meta.signature) {
        throw new Error(
          `${STORE_NAME}: entity '${meta.support.entity}' is already ` +
            `provisioned with a different shape at collection '${meta.collectionName}'`,
        );
      }
      return;
    }
    await this.executor.createCollection(meta.collectionName);
    await this.executor.collection(meta.collectionName).createIndex({ uri: 1 });
    await metaColl.updateOne(
      { _id: meta.support.entity },
      { $set: { _id: meta.support.entity, signature: meta.signature } },
      { upsert: true },
    );
  }

  // ── Write ────────────────────────────────────────────────────────

  async write(
    meta: MongoEntityMeta,
    entries: { uri: string; record: EntityRecord }[],
  ): Promise<StoreWriteResult[]> {
    if (entries.length === 0) return [];
    const out: StoreWriteResult[] = new Array(entries.length);
    const coll = this.executor.collection(meta.collectionName);

    for (let i = 0; i < entries.length; i++) {
      const { uri, record } = entries[i];
      const extras = Object.keys(record).filter((k) => !meta.declared.has(k));
      if (extras.length > 0) {
        out[i] = {
          success: false,
          ...storageFailure(
            new Error(
              `${STORE_NAME}: record contains keys not declared in schema '${meta.support.entity}': ${
                extras.join(", ")
              }`,
            ),
            "Schema mismatch",
            uri,
          ),
        };
        continue;
      }
      try {
        const doc = await buildDocument(meta, uri, record);
        await coll.updateOne(
          { uri },
          {
            $set: { ...doc, updatedAt: new Date() },
            $setOnInsert: { createdAt: new Date() },
          },
          { upsert: true },
        );
        out[i] = { success: true };
      } catch (err) {
        out[i] = {
          success: false,
          ...storageFailure(err, "Write failed", uri),
        };
      }
    }
    return out;
  }

  // ── Read ─────────────────────────────────────────────────────────

  read<T = EntityRecord | undefined>(
    meta: MongoEntityMeta,
    urls: string[],
  ): Promise<Output<T>[]> {
    return dispatchRead<T>(urls, STORE_NAME, {
      read: (p) => this._readOne(meta, p.uri),
      ls: (p) => this._ls(meta, p),
      count: (p) => this._count(meta, p),
      pushDownPattern: true,
      pushDownCursor: true,
      pushDownSortBy: true,
    });
  }

  async delete(
    meta: MongoEntityMeta,
    uris: string[],
  ): Promise<DeleteResult[]> {
    if (uris.length === 0) return [];
    const coll = this.executor.collection(meta.collectionName);
    const out: DeleteResult[] = new Array(uris.length);
    for (let i = 0; i < uris.length; i++) {
      try {
        await coll.deleteOne({ uri: uris[i] });
        out[i] = { success: true };
      } catch (err) {
        out[i] = {
          success: false,
          ...storageFailure(err, "Delete failed", uris[i]),
        };
      }
    }
    return out;
  }

  // ── Status / capabilities ────────────────────────────────────────

  async status(): Promise<StatusResult> {
    try {
      const ok = await this.executor.ping();
      if (!ok) {
        return {
          status: "unhealthy",
          message: "MongoDB ping failed",
          fns: ["read", "ls", "count"],
        };
      }
      return {
        status: "healthy",
        message: "MongoDB store is operational",
        fns: ["read", "ls", "count"],
        details: { collectionPrefix: this.collectionPrefix },
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

  private async _readOne(
    meta: MongoEntityMeta,
    uri: string,
  ): Promise<EntityRecord | undefined> {
    const doc = await this.executor.collection(meta.collectionName).findOne({
      uri,
    });
    if (!doc) return undefined;
    if (meta.fields.length === 0) return {};
    return adaptDocForRead(meta, doc);
  }

  /**
   * Compose the Mongo filter for shallow-direct-leaves under
   * `prefixUri`, optionally tightened by a glob `pattern` (regex body
   * spliced in place of `[^/]+`) and a `cursor` (`$gt` or `$lt` on
   * `uri` matching the active sort order).
   */
  private _leafFilter(
    prefixUri: string,
    pattern?: string,
    cursor?: string,
    sortOrder?: string,
  ): Record<string, unknown> {
    const body = pattern !== undefined ? patternToRegexBody(pattern) : "[^/]+";
    const uriFilter: Record<string, unknown> = {
      $regex: `^${escapeRegex(prefixUri)}${body}$`,
    };
    if (cursor !== undefined) {
      uriFilter[sortOrder === "desc" ? "$lt" : "$gt"] = cursor;
    }
    return { uri: uriFilter };
  }

  private async _ls(
    meta: MongoEntityMeta,
    parsed: ParsedUrl,
  ): Promise<Output[] | string[]> {
    validateReadParams(parsed.params, STORE_NAME);
    const { params } = parsed;
    const format = params.format ?? "full";

    const options: Parameters<
      ReturnType<MongoExecutor["collection"]>["findMany"]
    >[1] = {};
    // sortBy: "uri" sorts on the implicit URI key; any other value
    // must be a declared field. Dispatch only routes non-uri sortBy
    // through here when pushDownSortBy is true, which it is for this
    // backend; we still gate on meta.declared so an unrecognised
    // field falls through to no sort rather than a Mongo error.
    if (params.sortBy === "uri") {
      options.sort = { uri: params.sortOrder === "desc" ? -1 : 1 };
    } else if (
      params.sortBy !== undefined && meta.declared.has(params.sortBy)
    ) {
      options.sort = {
        [params.sortBy]: params.sortOrder === "desc" ? -1 : 1,
      };
    }
    if (params.limit !== undefined) {
      const page = params.page ?? 1;
      options.limit = params.limit;
      options.skip = (page - 1) * params.limit;
    }
    if (format === "uris") {
      options.projection = { uri: 1, _id: 0 };
    }

    const docs = await this.executor.collection(meta.collectionName).findMany(
      this._leafFilter(
        parsed.uri,
        params.pattern,
        params.cursor,
        params.sortOrder,
      ),
      options,
    );

    if (format === "uris") return docs.map((d) => d.uri as string);
    return docs.map((d): Output => [
      d.uri as string,
      adaptDocForRead(meta, d),
    ]);
  }

  private async _count(
    meta: MongoEntityMeta,
    parsed: ParsedUrl,
  ): Promise<number> {
    return await this.executor.collection(meta.collectionName).countDocuments(
      this._leafFilter(
        parsed.uri,
        parsed.params.pattern,
        parsed.params.cursor,
        parsed.params.sortOrder,
      ),
    );
  }
}

/**
 * Build the document to upsert: `uri` + every declared field, with
 * stream-shaped bytes fields collected up front so a stream failure
 * surfaces as a per-entry write failure (caught by the caller) before
 * any I/O against the collection.
 */
async function buildDocument(
  meta: MongoEntityMeta,
  uri: string,
  record: EntityRecord,
): Promise<Record<string, unknown>> {
  const doc: Record<string, unknown> = { uri };
  for (const field of meta.fields) {
    const value = record[field.name];
    if (value === undefined) continue;
    if (meta.bytesFields.has(field.name)) {
      if (value === null) {
        doc[field.name] = null;
        continue;
      }
      if (value instanceof Uint8Array) {
        doc[field.name] = value;
        continue;
      }
      if (value instanceof ReadableStream) {
        doc[field.name] = await toBytes(value);
        continue;
      }
      throw new Error(
        `${STORE_NAME}: field '${field.name}' must be Uint8Array or ReadableStream, got ${typeof value}`,
      );
    }
    doc[field.name] = adaptValueForWrite(field, value);
  }
  return doc;
}

function adaptValueForWrite(field: FieldPlan, value: unknown): unknown {
  if (value === null) return null;
  if (field.tag === TYPE_TAGS.TIMESTAMP) {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "number") return new Date(value).toISOString();
    return value;
  }
  return value;
}

function adaptDocForRead(
  meta: MongoEntityMeta,
  doc: Record<string, unknown>,
): EntityRecord {
  const rec: EntityRecord = {};
  for (const field of meta.fields) {
    const v = doc[field.name];
    if (v === undefined || v === null) {
      rec[field.name] = undefined;
      continue;
    }
    if (field.tag === TYPE_TAGS.BYTES) {
      rec[field.name] = docToBytes(v);
    } else if (field.tag === TYPE_TAGS.TIMESTAMP) {
      rec[field.name] = v instanceof Date ? v : new Date(v as string);
    } else {
      rec[field.name] = v;
    }
  }
  return rec;
}
