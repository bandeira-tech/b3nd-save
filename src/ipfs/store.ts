/**
 * IpfsStore — IPFS implementation of `EntityStore`.
 *
 * One backend, many entities. Layouts:
 *
 * - `BYTES_ENTITY` → block holding the payload bytes verbatim. URI →
 *   CID is tracked in an in-memory index under the entity bucket
 *   `"bytes"`.
 * - any other schema → block holding a JSON-encoded record. URI → CID
 *   is tracked in a separate in-memory index under the entity name.
 *   Per-field canonical `TYPE_TAGS` round-trip the JSON boundary
 *   (bytes → base64, bigint → string, timestamp → ISO-8601 — see
 *   `./fields.ts`).
 *
 * ## Lifecycle
 *
 * `entitySupport(schema)` is pure — it plans the field set and computes
 * a collision signature. `provisionEntity(meta)` allocates the
 * in-memory bucket and records the signature; subsequent
 * `entityStatus(meta)` returns `"live"` only when the bucket's
 * signature matches the meta exactly. Same-name different-shape
 * provisioning throws.
 *
 * Note: IPFS itself has no concept of provisioning — the bucket lives
 * only in memory inside this store instance. A fresh process must
 * re-call `provisionEntity` before write/delete (read returns misses
 * naturally), mirroring how Memory works for an in-process store.
 *
 * ## Read params
 *
 * `fn=ls` / `fn=count` are shallow direct-leaves only: scan the
 * entity's in-memory URI → CID index, keep URIs whose remainder under
 * the prefix has no further `/`. Standard params (`limit`/`page`/
 * `sortBy=uri`/`sortOrder`/`format`) are applied in memory;
 * `format=uris` and `count` skip per-leaf `cat`.
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
import type { IpfsExecutor } from "./mod.ts";

const STORE_NAME = "IpfsStore";

interface IndexEntry {
  cid: string;
}

interface EntityBucket {
  readonly signature: string;
  readonly index: Map<string, IndexEntry>;
}

/**
 * IpfsStore-specific entity handle.
 *
 * `isBytes` selects the raw-payload block layout vs the JSON-encoded
 * record block layout. `fields`/`declared`/`bytesFields` drive
 * write-time validation and encoding; `signature` is used for
 * collision detection in `entityStatus` / `provisionEntity`.
 */
export interface IpfsEntityMeta extends EntityMeta {
  readonly isBytes: boolean;
  readonly fields: readonly FieldPlan[];
  readonly declared: ReadonlySet<string>;
  readonly bytesFields: ReadonlySet<string>;
  readonly signature: string;
}

function isBytesSchema(schema: EntitySchema): boolean {
  return schema.name === BYTES_ENTITY.name;
}

export class IpfsStore implements EntityStore<IpfsEntityMeta> {
  private readonly executor: IpfsExecutor;
  private readonly buckets = new Map<string, EntityBucket>();

  constructor(executor: IpfsExecutor) {
    if (!executor) throw new Error("executor is required");
    this.executor = executor;
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  entitySupport(schema: EntitySchema): IpfsEntityMeta {
    if (isBytesSchema(schema)) {
      const fields: FieldPlan[] = [{ name: "payload", tag: "bytes" }];
      return {
        support: {
          entity: schema.name,
          supported: ["payload"],
          unsupported: [],
        },
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
      isBytes: false,
      fields,
      declared,
      bytesFields,
      signature: computeSignature(schema.name, fields),
    };
  }

  // deno-lint-ignore require-await
  async entityStatus(meta: IpfsEntityMeta): Promise<"live" | "unprovisioned"> {
    const bucket = this.buckets.get(meta.support.entity);
    if (!bucket) return "unprovisioned";
    return bucket.signature === meta.signature ? "live" : "unprovisioned";
  }

  // deno-lint-ignore require-await
  async provisionEntity(meta: IpfsEntityMeta): Promise<void> {
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
      index: new Map(),
    });
  }

  // ── Write ────────────────────────────────────────────────────────

  async write(
    meta: IpfsEntityMeta,
    entries: { uri: string; record: EntityRecord }[],
  ): Promise<StoreWriteResult[]> {
    if (entries.length === 0) return [];
    const bucket = this.buckets.get(meta.support.entity);
    if (!bucket || bucket.signature !== meta.signature) {
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
        let body: Uint8Array | ReadableStream<Uint8Array>;
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
          body = payload;
        } else {
          const normalised = await this._normaliseBytesFields(
            record,
            meta.bytesFields,
          );
          const json = JSON.stringify(encodeRecord(meta.fields, normalised));
          body = new TextEncoder().encode(json);
        }
        const cid = await this.executor.add(body);
        await this.executor.pin(cid);

        const existing = bucket.index.get(uri);
        if (existing) {
          try {
            await this.executor.unpin(existing.cid);
          } catch {
            // Old CID may already be unpinned — ignore.
          }
        }
        bucket.index.set(uri, { cid });
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
    meta: IpfsEntityMeta,
    urls: string[],
  ): Promise<Output<T>[]> {
    return dispatchRead<T>(urls, STORE_NAME, {
      read: (p) => this._readOne(meta, p.uri) as Promise<T | undefined>,
      ls: (p) => this._ls(meta, p) as Promise<Output<T>[] | string[]>,
      count: (p) => Promise.resolve(this._count(meta, p)),
    });
  }

  private async _readOne(
    meta: IpfsEntityMeta,
    uri: string,
  ): Promise<EntityRecord | undefined> {
    const bucket = this.buckets.get(meta.support.entity);
    if (!bucket) return undefined;
    const entry = bucket.index.get(uri);
    if (!entry) return undefined;
    try {
      const stream = await this.executor.cat(entry.cid);
      if (meta.isBytes) return { payload: stream };
      const bytes = await new Response(stream).bytes();
      const text = new TextDecoder().decode(bytes);
      return decodeRecord(meta.fields, JSON.parse(text));
    } catch {
      return undefined;
    }
  }

  /** Shallow direct-leaves from the entity's in-memory URI index. */
  private _directLeafUris(meta: IpfsEntityMeta, prefixUri: string): string[] {
    const bucket = this.buckets.get(meta.support.entity);
    if (!bucket) return [];
    const out: string[] = [];
    for (const uri of bucket.index.keys()) {
      if (!uri.startsWith(prefixUri)) continue;
      const tail = uri.slice(prefixUri.length);
      if (tail === "" || tail.includes("/")) continue;
      out.push(uri);
    }
    return out;
  }

  private async _ls(
    meta: IpfsEntityMeta,
    parsed: ParsedUrl,
  ): Promise<Output<EntityRecord>[] | string[]> {
    validateReadParams(parsed.params, STORE_NAME);
    const { params } = parsed;
    const format = params.format ?? "full";

    let uris = this._directLeafUris(meta, parsed.uri);
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

  private _count(meta: IpfsEntityMeta, parsed: ParsedUrl): number {
    if (parsed.params.pattern !== undefined) {
      throw new Error(`${STORE_NAME}: pattern filter not supported`);
    }
    return this._directLeafUris(meta, parsed.uri).length;
  }

  // ── Delete ───────────────────────────────────────────────────────

  async delete(meta: IpfsEntityMeta, uris: string[]): Promise<DeleteResult[]> {
    if (uris.length === 0) return [];
    const bucket = this.buckets.get(meta.support.entity);
    if (!bucket || bucket.signature !== meta.signature) {
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
        const entry = bucket.index.get(uri);
        if (entry) {
          try {
            await this.executor.unpin(entry.cid);
          } catch {
            // CID may already be unpinned — ignore.
          }
          bucket.index.delete(uri);
        }
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
      const online = await this.executor.isOnline();
      if (!online) {
        return {
          status: "unhealthy",
          message: "IPFS node is not reachable",
          fns: ["read", "ls", "count"],
        };
      }

      let indexedUris = 0;
      for (const bucket of this.buckets.values()) {
        indexedUris += bucket.index.size;
      }
      return {
        status: "healthy",
        schema: [...this.buckets.keys()].map((n) => `entity:${n}`),
        fns: ["read", "ls", "count"],
        details: { indexedUris },
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
