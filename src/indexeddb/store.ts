/**
 * IndexedDBStore — browser IndexedDB implementation of `EntityStore`.
 *
 * Two layouts share one object store, separated by storage-key prefix.
 * IDB's structured clone preserves typed values natively
 * (`Uint8Array`, `Date`, `BigInt`, plain JSON), so records are stored
 * verbatim — no JSON encoding step on the way in or out.
 *
 * - `BYTES_ENTITY` → record `{ uri, payload }` keyed by `uri` (the
 *   original byte-store layout — existing deployments keep working).
 * - any other schema → record `{ uri, record }` keyed by
 *   `__entities__/{entityName}/{originalUri}`. The `__entities__/`
 *   prefix isolates entity slots from byte slots in the cursor's
 *   ordered key space.
 *
 * ## Lifecycle
 *
 * `entitySupport(schema)` is pure — it plans the field set and computes
 * a collision signature. `provisionEntity(meta)` writes a tiny meta
 * record (`__meta__/{name}`) holding the signature; subsequent
 * `entityStatus(meta)` reads it back. Same-name different-shape
 * provisioning throws.
 *
 * IDB needs an `onupgradeneeded` to create object stores, but since we
 * use a single store for everything, schema migrations are not required
 * to grow new entities.
 *
 * ## Read params
 *
 * `fn=ls` / `fn=count` are shallow direct-leaves only: cursor over the
 * `uri_index` bounded by `[storageKey, storageKey + ￿)`, keep records
 * whose remainder under the prefix has no further `/`. Standard params
 * (`limit`/`page`/`sortBy=uri`/`sortOrder`/`format=uris`) are honoured
 * via cursor walking — `format=uris` and `count` skip loading payloads
 * via `openKeyCursor`.
 *
 * `fn=find` (v2 §3.5) is the deep counterpart: same cursor, same
 * range, no `rest.includes("/")` tail cutoff. With `pushDownFind:
 * false` the handler returns every descendant under the prefix and
 * dispatch applies the glob, sort, cursor, limit, format, and appends
 * the cursor-as-trailing-slot. IDB has no engine for glob/regex
 * push-down — its cursor only honours key-range and direction — so
 * dispatch's post-filter path is the honest fit (same shape as memory
 * PR #84).
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
import { computeSignature, type FieldPlan, planFields } from "./fields.ts";

const STORE_NAME = "IndexedDBStore";

const ENTITY_PREFIX = "__entities__/";
const META_PREFIX = "__meta__/";

interface StoredBytes {
  uri: string;
  payload: Uint8Array;
}

interface StoredEntity {
  uri: string;
  record: EntityRecord;
}

interface StoredMeta {
  uri: string;
  signature: string;
}

// Minimal IndexedDB type definitions for cross-platform compatibility.
interface IDBDatabase {
  name: string;
  version: number;
  objectStoreNames: { contains(name: string): boolean };
  close(): void;
  transaction(
    storeNames: string | string[],
    mode?: "readonly" | "readwrite",
  ): IDBTransaction;
  // deno-lint-ignore no-explicit-any
  createObjectStore(name: string, options?: any): IDBObjectStore;
}

interface IDBTransaction {
  objectStore(name: string): IDBObjectStore;
}

interface IDBObjectStore {
  // deno-lint-ignore no-explicit-any
  get(key: any): IDBRequest;
  // deno-lint-ignore no-explicit-any
  put(value: any): IDBRequest;
  // deno-lint-ignore no-explicit-any
  delete(key: any): IDBRequest;
  index(name: string): IDBIndex;
  // deno-lint-ignore no-explicit-any
  createIndex(name: string, keyPath: string): any;
}

interface IDBIndex {
  // deno-lint-ignore no-explicit-any
  openCursor(range?: any, direction?: "next" | "prev"): IDBRequest;
  // deno-lint-ignore no-explicit-any
  openKeyCursor(range?: any, direction?: "next" | "prev"): IDBRequest;
}

interface IDBRequest {
  // deno-lint-ignore no-explicit-any
  result: any;
  error: Error | null;
  // deno-lint-ignore no-explicit-any
  onsuccess: ((this: IDBRequest, ev: any) => void) | null;
  // deno-lint-ignore no-explicit-any
  onerror: ((this: IDBRequest, ev: any) => void) | null;
}

interface IDBOpenDBRequest extends IDBRequest {
  // deno-lint-ignore no-explicit-any
  onupgradeneeded: ((this: IDBOpenDBRequest, ev: any) => void) | null;
}

interface IDBKeyRange {
  // deno-lint-ignore no-explicit-any
  bound(lower: any, upper: any, lowerOpen?: boolean, upperOpen?: boolean): any;
}

interface IDBFactory {
  open(name: string, version?: number): IDBOpenDBRequest;
}

// deno-lint-ignore no-explicit-any
const idbKeyRange: IDBKeyRange | undefined = (globalThis as any).IDBKeyRange;

/**
 * IndexedDBStore-specific entity handle.
 *
 * `storageRoot` is the storage-key prefix under which records of this
 * entity live (`""` for BYTES_ENTITY, `__entities__/{name}/` for
 * custom). `isBytes` selects the legacy bytes record shape vs the
 * verbatim `EntityRecord` shape. `fields`/`declared`/`bytesFields`
 * drive write-time validation and stream normalisation;
 * `signature` is used for collision detection.
 */
export interface IndexedDBEntityMeta extends EntityMeta {
  readonly storageRoot: string;
  readonly isBytes: boolean;
  readonly fields: readonly FieldPlan[];
  readonly declared: ReadonlySet<string>;
  readonly bytesFields: ReadonlySet<string>;
  readonly signature: string;
}

function isBytesSchema(schema: EntitySchema): boolean {
  return schema.name === BYTES_ENTITY.name;
}

export class IndexedDBStore implements EntityStore<IndexedDBEntityMeta> {
  private readonly databaseName: string;
  private readonly storeName: string;
  private readonly version: number;
  private readonly indexedDB: IDBFactory;
  private readonly keyRange: IDBKeyRange | undefined;
  private db: IDBDatabase | null = null;

  constructor(config: {
    databaseName?: string;
    storeName?: string;
    version?: number;
    // deno-lint-ignore no-explicit-any
    indexedDB?: any;
    // deno-lint-ignore no-explicit-any
    IDBKeyRange?: any;
  } = {}) {
    this.databaseName = config.databaseName || "b3nd";
    this.storeName = config.storeName || "records";
    this.version = config.version || 1;
    this.indexedDB = config.indexedDB ||
      // deno-lint-ignore no-explicit-any
      ((globalThis as any).indexedDB ?? null);
    this.keyRange = config.IDBKeyRange ?? idbKeyRange;

    if (!this.indexedDB) {
      throw new Error("IndexedDB is not available in this environment");
    }
  }

  private initDB(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);

    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.indexedDB.open(this.databaseName, this.version);
      request.onerror = () =>
        reject(new Error(`Failed to open IndexedDB: ${request.error}`));
      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };
      request.onupgradeneeded = () => {
        const db = request.result as IDBDatabase;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, {
            keyPath: "uri",
          });
          store.createIndex("uri_index", "uri");
        }
      };
    });
  }

  private async getStore(
    mode: "readonly" | "readwrite" = "readonly",
  ): Promise<IDBObjectStore> {
    const db = await this.initDB();
    return db.transaction([this.storeName], mode).objectStore(this.storeName);
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  entitySupport(schema: EntitySchema): IndexedDBEntityMeta {
    if (isBytesSchema(schema)) {
      const fields: FieldPlan[] = [{ name: "payload", tag: "bytes" }];
      return {
        support: {
          entity: schema.name,
          supported: ["payload"],
          unsupported: [],
        },
        storageRoot: "",
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
      storageRoot: `${ENTITY_PREFIX}${schema.name}/`,
      isBytes: false,
      fields,
      declared,
      bytesFields,
      signature: computeSignature(schema.name, fields),
    };
  }

  async entityStatus(
    meta: IndexedDBEntityMeta,
  ): Promise<"live" | "unprovisioned"> {
    const recorded = await this._readMetaSignature(meta.support.entity);
    if (recorded === null) return "unprovisioned";
    return recorded === meta.signature ? "live" : "unprovisioned";
  }

  async provisionEntity(meta: IndexedDBEntityMeta): Promise<void> {
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
    const doc: StoredMeta = {
      uri: `${META_PREFIX}${meta.support.entity}`,
      signature: meta.signature,
    };
    const store = await this.getStore("readwrite");
    await new Promise<void>((resolve, reject) => {
      const req = store.put(doc);
      req.onsuccess = () => resolve();
      req.onerror = () =>
        reject(new Error(`Failed to write entity meta: ${req.error}`));
    });
  }

  // ── Write ────────────────────────────────────────────────────────

  async write(
    meta: IndexedDBEntityMeta,
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

    // Validate + collect streams BEFORE opening the IDB transaction.
    // IDB transactions stay alive only across IDB-callback microtasks;
    // awaiting a non-IDB promise (like draining a ReadableStream)
    // yields long enough for the transaction to auto-commit.
    const out: StoreWriteResult[] = new Array(entries.length);
    const prepared: { idx: number; doc: StoredBytes | StoredEntity }[] = [];
    for (let i = 0; i < entries.length; i++) {
      const { uri, record } = entries[i];
      const extras = Object.keys(record).filter((k) => !meta.declared.has(k));
      if (extras.length > 0) {
        out[i] = {
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
        };
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
          prepared.push({ idx: i, doc: { uri, payload: bytes } });
        } else {
          const normalised = await this._normaliseBytesFields(
            record,
            meta.bytesFields,
          );
          prepared.push({
            idx: i,
            doc: { uri: `${meta.storageRoot}${uri}`, record: normalised },
          });
        }
      } catch (err) {
        out[i] = {
          success: false,
          ...storageFailure(err, "Write failed", uri),
        };
      }
    }

    if (prepared.length === 0) return out;

    try {
      const store = await this.getStore("readwrite");
      for (const { idx, doc } of prepared) {
        try {
          await new Promise<void>((resolve, reject) => {
            const req = store.put(doc);
            req.onsuccess = () => resolve();
            req.onerror = () =>
              reject(
                new Error(`Failed to write ${doc.uri}: ${req.error}`),
              );
          });
          out[idx] = { success: true };
        } catch (err) {
          out[idx] = {
            success: false,
            ...storageFailure(err, "Write failed", entries[idx].uri),
          };
        }
      }
    } catch (err) {
      const failure = storageFailure(err, "Write failed");
      for (const { idx } of prepared) {
        out[idx] = { success: false, ...failure };
      }
    }
    return out;
  }

  // ── Read ─────────────────────────────────────────────────────────

  read<T = EntityRecord | undefined>(
    meta: IndexedDBEntityMeta,
    urls: string[],
  ): Promise<Output<T>[]> {
    return dispatchRead<T>(urls, STORE_NAME, {
      read: (p) => this._readOne(meta, p.uri) as Promise<T | undefined>,
      ls: (p) => this._ls(meta, p) as Promise<Output<T>[] | string[]>,
      count: (p) => this._count(meta, p),
      // v2 §3.5: find walks every descendant under the prefix (no
      // shallow `/` cutoff). With `pushDownFind: false`, dispatch
      // strips pattern/cursor/limit/page before calling, then applies
      // the glob, sort, cursor, limit, format, and appends the cursor-
      // as-trailing-slot on the returned rows. IDB has no engine for
      // glob/regex push-down — only key-range + direction — so the
      // honest shape mirrors memory PR #84: handler returns the raw
      // deep walk, dispatch does the rest.
      find: (p) => this._find(meta, p) as Promise<Output<T>[] | string[]>,
    });
  }

  private async _readOne(
    meta: IndexedDBEntityMeta,
    uri: string,
  ): Promise<EntityRecord | undefined> {
    try {
      const store = await this.getStore();
      const storageKey = meta.isBytes ? uri : `${meta.storageRoot}${uri}`;
      return await new Promise<EntityRecord | undefined>((resolve) => {
        const req = store.get(storageKey);
        req.onsuccess = () => {
          const doc = req.result;
          if (!doc) return resolve(undefined);
          if (meta.isBytes) {
            resolve({ payload: (doc as StoredBytes).payload });
          } else {
            resolve((doc as StoredEntity).record);
          }
        };
        req.onerror = () => resolve(undefined);
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Cursor over `uri_index` constrained to `[meta.storageRoot+prefix,
   * meta.storageRoot+prefix+￿)`. Honours `sortOrder=desc` via `prev`
   * direction and `limit`/`page` via cursor walking + skipping.
   *
   * `shallow` selects the walk shape:
   *   - `true`  → only direct leaves (the `rest.includes("/")` tail
   *     cutoff). Powers `fn=ls` and shallow `fn=count`.
   *   - `false` → every descendant under the prefix, any depth. Powers
   *     `fn=find` (v2 §3.5). Dispatch applies the glob, sort, cursor,
   *     limit, format on top.
   *
   * Either way the exact-prefix match (`tail === ""`) is skipped — the
   * URL identifies the parent, not a child of itself.
   */
  private async _walkLeaves(
    meta: IndexedDBEntityMeta,
    parsed: ParsedUrl,
    onlyKeys: boolean,
    shallow: boolean,
  ): Promise<Array<{ uri: string; doc?: StoredBytes | StoredEntity }>> {
    const { uri: prefix, params } = parsed;
    const desc = params.sortBy === "uri" && params.sortOrder === "desc";
    const direction = desc ? "prev" : "next";
    const limit = params.limit;
    const offset = limit !== undefined ? ((params.page ?? 1) - 1) * limit : 0;

    const lower = `${meta.storageRoot}${prefix}`;
    const upper = `${lower}￿`;
    const range = this.keyRange
      ? this.keyRange.bound(lower, upper, false, false)
      : undefined;

    const store = await this.getStore();
    const index = store.index("uri_index");

    return await new Promise<
      Array<{ uri: string; doc?: StoredBytes | StoredEntity }>
    >((resolve, reject) => {
      const out: Array<{ uri: string; doc?: StoredBytes | StoredEntity }> = [];
      let skipped = 0;
      const request = onlyKeys
        ? index.openKeyCursor(range, direction)
        : index.openCursor(range, direction);

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(out);
          return;
        }
        const storedKey = (onlyKeys ? cursor.key : cursor.value.uri) as string;
        if (!storedKey.startsWith(lower)) {
          resolve(out);
          return;
        }
        const tail = storedKey.slice(lower.length);
        if (tail === "" || (shallow && tail.includes("/"))) {
          cursor.continue();
          return;
        }
        if (skipped < offset) {
          skipped++;
          cursor.continue();
          return;
        }
        const originalUri = `${prefix}${tail}`;
        out.push(
          onlyKeys
            ? { uri: originalUri }
            : { uri: originalUri, doc: cursor.value },
        );
        if (limit !== undefined && out.length >= limit) {
          resolve(out);
          return;
        }
        cursor.continue();
      };
      request.onerror = () =>
        reject(request.error ?? new Error("Cursor failed"));
    });
  }

  private async _ls(
    meta: IndexedDBEntityMeta,
    parsed: ParsedUrl,
  ): Promise<Output<EntityRecord>[] | string[]> {
    validateReadParams(parsed.params, STORE_NAME);
    const format = parsed.params.format ?? "full";
    const onlyKeys = format === "uris";

    try {
      const entries = await this._walkLeaves(meta, parsed, onlyKeys, true);
      if (onlyKeys) return entries.map((e) => e.uri);
      return entries.map((e): Output<EntityRecord> => {
        if (!e.doc) return [e.uri, undefined as unknown as EntityRecord];
        if (meta.isBytes) {
          return [e.uri, { payload: (e.doc as StoredBytes).payload }];
        }
        return [e.uri, (e.doc as StoredEntity).record];
      });
    } catch {
      return [];
    }
  }

  /**
   * v2 §3.5: recursive walk under the prefix. Same cursor as `_ls` with
   * `shallow=false` so the `tail.includes("/")` cutoff is dropped —
   * every descendant flows through, any depth. By the time dispatch
   * calls us (with `pushDownFind: false`), it has stripped
   * pattern/cursor/limit/page from `parsed.params`; sortBy is forced to
   * `"uri"`; format may be either `"full"` or `"uris"`. The handler
   * returns the raw deep walk in that format; dispatch handles glob
   * post-filter, sort, cursor, limit, and the cursor-as-trailing-slot.
   */
  private async _find(
    meta: IndexedDBEntityMeta,
    parsed: ParsedUrl,
  ): Promise<Output<EntityRecord>[] | string[]> {
    validateReadParams(parsed.params, STORE_NAME);
    const format = parsed.params.format ?? "full";
    const onlyKeys = format === "uris";

    try {
      const entries = await this._walkLeaves(meta, parsed, onlyKeys, false);
      if (onlyKeys) return entries.map((e) => e.uri);
      return entries.map((e): Output<EntityRecord> => {
        if (!e.doc) return [e.uri, undefined as unknown as EntityRecord];
        if (meta.isBytes) {
          return [e.uri, { payload: (e.doc as StoredBytes).payload }];
        }
        return [e.uri, (e.doc as StoredEntity).record];
      });
    } catch {
      return [];
    }
  }

  private async _count(
    meta: IndexedDBEntityMeta,
    parsed: ParsedUrl,
  ): Promise<number> {
    if (parsed.params.pattern !== undefined) {
      throw new Error(`${STORE_NAME}: pattern filter not supported`);
    }
    try {
      const entries = await this._walkLeaves(meta, parsed, true, true);
      return entries.length;
    } catch {
      return 0;
    }
  }

  // ── Delete ───────────────────────────────────────────────────────

  async delete(
    meta: IndexedDBEntityMeta,
    uris: string[],
  ): Promise<DeleteResult[]> {
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
    try {
      const store = await this.getStore("readwrite");
      for (const uri of uris) {
        try {
          const storageKey = meta.isBytes ? uri : `${meta.storageRoot}${uri}`;
          await new Promise<void>((resolve, reject) => {
            const req = store.delete(storageKey);
            req.onsuccess = () => resolve();
            req.onerror = () =>
              reject(new Error(`Failed to delete ${uri}: ${req.error}`));
          });
          results.push({ success: true });
        } catch (err) {
          results.push({
            success: false,
            ...storageFailure(err, "Delete failed", uri),
          });
        }
      }
    } catch (err) {
      const failure = storageFailure(err, "Delete failed");
      for (const _ of uris) results.push({ success: false, ...failure });
    }
    return results;
  }

  // ── Status / capabilities ────────────────────────────────────────

  async status(): Promise<StatusResult> {
    try {
      await this.initDB();
      const schema = await this._listProvisionedEntities();
      return {
        status: "healthy",
        schema: schema.map((s) => `entity:${s}`),
        fns: ["read", "ls", "count", "find"],
      };
    } catch {
      return {
        status: "unhealthy",
        schema: [],
        fns: ["read", "ls", "count", "find"],
      };
    }
  }

  capabilities(): StoreCapabilities {
    return { atomicBatch: false };
  }

  // ── Internals ────────────────────────────────────────────────────

  /**
   * Read the persisted signature for an entity's meta record. Returns
   * `null` if no provisioning record exists. The meta record lives at
   * `__meta__/{name}` in the same object store as data records, so a
   * single object-store cursor sees both layouts without needing a
   * separate IDB store.
   */
  private async _readMetaSignature(
    entityName: string,
  ): Promise<string | null> {
    try {
      const store = await this.getStore();
      return await new Promise<string | null>((resolve) => {
        const req = store.get(`${META_PREFIX}${entityName}`);
        req.onsuccess = () => {
          const doc = req.result as StoredMeta | undefined;
          resolve(doc ? doc.signature : null);
        };
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  /**
   * Scan the meta keyspace for every provisioned entity name. Used by
   * `status()` to advertise the entities a peer can talk to.
   */
  private async _listProvisionedEntities(): Promise<string[]> {
    if (!this.keyRange) return [];
    const range = this.keyRange.bound(META_PREFIX, `${META_PREFIX}￿`);
    const store = await this.getStore();
    const index = store.index("uri_index");
    return await new Promise<string[]>((resolve, reject) => {
      const out: string[] = [];
      const req = index.openKeyCursor(range, "next");
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(out);
        const key = cursor.key as string;
        if (!key.startsWith(META_PREFIX)) return resolve(out);
        out.push(key.slice(META_PREFIX.length));
        cursor.continue();
      };
      req.onerror = () => reject(req.error ?? new Error("Meta cursor failed"));
    });
  }

  /**
   * Collect any `ReadableStream` values on `bytes`-tagged fields into
   * `Uint8Array` and return a shallow-copied record. Non-stream values
   * pass through; matches the normalisation pattern used by Memory,
   * Postgres, and LocalStorage.
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
