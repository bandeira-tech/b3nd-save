/**
 * LocalStorageStore — browser localStorage implementation of `EntityStore`.
 *
 * One backend, many entities. Layouts:
 *
 * - `BYTES_ENTITY` → key `{keyPrefix}{uri}` with a base64-encoded
 *   payload string. Matches the original bytes-only layout, so
 *   existing deployments keep working without migration.
 * - any other schema → key `{keyPrefix}entities/{entityName}/{uri}`
 *   with a JSON-encoded record string. Per-field canonical tags
 *   round-trip the JSON boundary (bytes → base64, bigint → string,
 *   timestamp → ISO-8601 — see `./fields.ts`).
 *
 * ## Lifecycle
 *
 * `entitySupport(schema)` is pure — it plans the field set and computes
 * a signature for collision detection. `provisionEntity(meta)` writes a
 * tiny bookkeeping key (`{keyPrefix}__meta__/entities/{name}`) holding
 * the signature; subsequent `entityStatus(meta)` reads it back and
 * compares. Same-name different-shape provisioning throws.
 *
 * Writes/reads/deletes consume the meta directly: there is no per-call
 * cache lookup gate. If `meta`'s bookkeeping is missing on the medium,
 * `write` and `delete` surface a `"not provisioned"` storage failure
 * per entry; `read` returns misses.
 *
 * ## Read params
 *
 * `fn=ls` / `fn=count` are shallow direct-leaves only. localStorage has
 * no indexable cursor, so `_directLeaves` walks all keys once under the
 * entity's `keyRoot` and standard params (`limit`/`page`/`sortBy`
 * `=uri`/`sortOrder`/`format`) are applied in memory via
 * `applyReadParams` from `../read.ts`.
 */

import type {
  DeleteResult,
  Output,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { decodeBase64, encodeBase64 } from "@bandeira-tech/b3nd-core";
import type { ParsedUrl } from "../url.ts";
import { dispatchRead } from "../dispatch.ts";
import { storageFailure } from "../errors.ts";
import { toBytes } from "../payload.ts";
import { applyReadParams } from "../read.ts";
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

const STORE_NAME = "LocalStorageStore";

const ENTITY_PREFIX = "entities/";
const META_PREFIX = "__meta__/entities/";

/**
 * LocalStorageStore-specific entity handle.
 *
 * `keyRoot` is the full localStorage prefix under which records live
 * (e.g. `b3nd:entities/users/`). `isBytes` selects the legacy
 * base64-bytes value format vs the JSON record format. `fields`,
 * `declared`, and `bytesFields` drive write-time validation and
 * encoding; `signature` is used for collision detection in
 * `entityStatus` / `provisionEntity`.
 */
export interface LocalStorageEntityMeta extends EntityMeta {
  readonly keyRoot: string;
  readonly isBytes: boolean;
  readonly fields: readonly FieldPlan[];
  readonly declared: ReadonlySet<string>;
  readonly bytesFields: ReadonlySet<string>;
  readonly signature: string;
}

function isBytesSchema(schema: EntitySchema): boolean {
  return schema.name === BYTES_ENTITY.name;
}

export class LocalStorageStore implements EntityStore<LocalStorageEntityMeta> {
  private readonly keyPrefix: string;
  private readonly storage: Storage;

  constructor(config: {
    keyPrefix?: string;
    storage?: Storage;
  } = {}) {
    this.keyPrefix = config.keyPrefix || "b3nd:";
    this.storage = config.storage ||
      (typeof localStorage !== "undefined" ? localStorage : null!);

    if (!this.storage) {
      throw new Error("localStorage is not available in this environment");
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  entitySupport(schema: EntitySchema): LocalStorageEntityMeta {
    if (isBytesSchema(schema)) {
      const fields: FieldPlan[] = [{ name: "payload", tag: "bytes" }];
      return {
        support: {
          entity: schema.name,
          supported: ["payload"],
          unsupported: [],
        },
        keyRoot: this.keyPrefix,
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
      keyRoot: `${this.keyPrefix}${ENTITY_PREFIX}${schema.name}/`,
      isBytes: false,
      fields,
      declared,
      bytesFields,
      signature: computeSignature(schema.name, fields),
    };
  }

  entityStatus(
    meta: LocalStorageEntityMeta,
  ): Promise<"live" | "unprovisioned"> {
    const recorded = this._readMetaSignature(meta.support.entity);
    if (recorded === null) return Promise.resolve("unprovisioned");
    return Promise.resolve(
      recorded === meta.signature ? "live" : "unprovisioned",
    );
  }

  // deno-lint-ignore require-await
  async provisionEntity(meta: LocalStorageEntityMeta): Promise<void> {
    const recorded = this._readMetaSignature(meta.support.entity);
    if (recorded !== null) {
      if (recorded !== meta.signature) {
        throw new Error(
          `${STORE_NAME}: entity '${meta.support.entity}' is already ` +
            `provisioned with a different shape`,
        );
      }
      return;
    }
    this.storage.setItem(
      `${this.keyPrefix}${META_PREFIX}${meta.support.entity}`,
      meta.signature,
    );
  }

  // ── Write ────────────────────────────────────────────────────────

  async write(
    meta: LocalStorageEntityMeta,
    entries: { uri: string; record: EntityRecord }[],
  ): Promise<StoreWriteResult[]> {
    if (entries.length === 0) return [];
    if (this._readMetaSignature(meta.support.entity) !== meta.signature) {
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
          const bytes = await toBytes(payload);
          this.storage.setItem(`${meta.keyRoot}${uri}`, encodeBase64(bytes));
        } else {
          const normalised = await this._normaliseBytesFields(
            record,
            meta.bytesFields,
          );
          const encoded = encodeRecord(meta.fields, normalised);
          this.storage.setItem(
            `${meta.keyRoot}${uri}`,
            JSON.stringify(encoded),
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
    meta: LocalStorageEntityMeta,
    urls: string[],
  ): Promise<Output<T>[]> {
    return dispatchRead<T>(urls, STORE_NAME, {
      read: (p) => Promise.resolve(this._readOne(meta, p.uri) as T | undefined),
      ls: (p) => Promise.resolve(this._ls(meta, p) as Output<T>[] | string[]),
      count: (p) => Promise.resolve(this._count(meta, p)),
    });
  }

  private _readOne(
    meta: LocalStorageEntityMeta,
    uri: string,
  ): EntityRecord | undefined {
    const stored = this.storage.getItem(`${meta.keyRoot}${uri}`);
    if (stored === null) return undefined;
    if (meta.isBytes) return { payload: decodeBase64(stored) };
    return decodeRecord(meta.fields, JSON.parse(stored));
  }

  /**
   * Walk localStorage once, returning `Output<EntityRecord>` for every
   * key under `meta.keyRoot` whose remainder is `uri + <segment>` with
   * no further `/`. Subtree-only paths are excluded by the slash check.
   */
  private _directLeaves(
    meta: LocalStorageEntityMeta,
    uri: string,
  ): Output<EntityRecord>[] {
    const prefixKey = `${meta.keyRoot}${uri}`;
    const out: Output<EntityRecord>[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key || !key.startsWith(prefixKey)) continue;
      const rest = key.substring(prefixKey.length);
      if (rest === "" || rest.includes("/")) continue;
      const childUri = `${uri}${rest}`;
      const record = this._readOne(meta, childUri);
      if (record !== undefined) out.push([childUri, record]);
    }
    return out;
  }

  private _ls(
    meta: LocalStorageEntityMeta,
    parsed: ParsedUrl,
  ): Output<EntityRecord>[] | string[] {
    return applyReadParams(
      this._directLeaves(meta, parsed.uri),
      parsed.params,
      STORE_NAME,
    ) as Output<EntityRecord>[] | string[];
  }

  private _count(meta: LocalStorageEntityMeta, parsed: ParsedUrl): number {
    if (parsed.params.pattern !== undefined) {
      throw new Error(`${STORE_NAME}: pattern filter not supported`);
    }
    return this._directLeaves(meta, parsed.uri).length;
  }

  // ── Delete ───────────────────────────────────────────────────────

  delete(
    meta: LocalStorageEntityMeta,
    uris: string[],
  ): Promise<DeleteResult[]> {
    if (uris.length === 0) return Promise.resolve([]);
    if (this._readMetaSignature(meta.support.entity) !== meta.signature) {
      return Promise.resolve(uris.map((uri) => ({
        success: false,
        ...storageFailure(
          new Error(
            `${STORE_NAME}: entity '${meta.support.entity}' is not provisioned`,
          ),
          "Entity not provisioned",
          uri,
        ),
      })));
    }
    const results: DeleteResult[] = [];
    for (const uri of uris) {
      try {
        this.storage.removeItem(`${meta.keyRoot}${uri}`);
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
    try {
      const testKey = `${this.keyPrefix}__health_check__`;
      this.storage.setItem(testKey, "ok");
      this.storage.removeItem(testKey);
      const schema: string[] = [];
      const metaPrefix = `${this.keyPrefix}${META_PREFIX}`;
      for (let i = 0; i < this.storage.length; i++) {
        const k = this.storage.key(i);
        if (!k || !k.startsWith(metaPrefix)) continue;
        schema.push(`entity:${k.slice(metaPrefix.length)}`);
      }
      return Promise.resolve({
        status: "healthy",
        schema,
        fns: ["read", "ls", "count"],
      });
    } catch {
      return Promise.resolve({
        status: "unhealthy",
        schema: [],
        fns: ["read", "ls", "count"],
      });
    }
  }

  capabilities(): StoreCapabilities {
    return { atomicBatch: false };
  }

  // ── Internals ────────────────────────────────────────────────────

  private _readMetaSignature(entityName: string): string | null {
    return this.storage.getItem(
      `${this.keyPrefix}${META_PREFIX}${entityName}`,
    );
  }

  /**
   * Collect any `ReadableStream` values on `bytes`-tagged fields into
   * `Uint8Array` and return a shallow-copied record. Non-stream values
   * pass through; matches the normalisation pattern used by Memory and
   * Postgres.
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
