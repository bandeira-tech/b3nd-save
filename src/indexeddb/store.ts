/**
 * IndexedDBStore — browser IndexedDB implementation of Store.
 *
 * Pure mechanical byte storage with no protocol awareness. Uses
 * IndexedDB for large-scale persistent browser storage. IndexedDB's
 * structured clone preserves `Uint8Array` natively.
 *
 * `fn=ls` / `fn=count` are shallow direct-leaves only: cursor over
 * the `uri_index`, keep records whose URI is `prefix + <segment>`
 * with no further `/`. The `format=uris` fast path and `count` only
 * touch the index key — they never load the full record's payload.
 */

import type {
  DeleteResult,
  Output,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import {
  bytesOnlyDelete,
  type BytesOnlyEntityMeta,
  bytesOnlyEntitySupport,
  bytesOnlyRead,
  bytesOnlyWrite,
} from "../byte-entity-shim.ts";
import type { EntityStore } from "../entity-store.ts";
import type { EntityRecord, EntitySchema } from "../entity.ts";

import type { ParsedUrl } from "@bandeira-tech/b3nd-core/url";
import { dispatchRead } from "../dispatch.ts";
import { storageFailure } from "../errors.ts";
import { toBytes } from "../payload.ts";
import { validateReadParams } from "../read.ts";
import type {
  StoreCapabilities,
  StoreEntry,
  StoreWriteResult,
} from "../types.ts";

const STORE_NAME = "IndexedDBStore";

interface StoredRecord {
  uri: string;
  payload: Uint8Array;
}

// Minimal IndexedDB type definitions for cross-platform compatibility
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

export class IndexedDBStore implements EntityStore<BytesOnlyEntityMeta> {
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

  // ── EntityStore surface ──────────────────────────────────────────

  entitySupport(schema: EntitySchema): BytesOnlyEntityMeta {
    return bytesOnlyEntitySupport(schema);
  }

  entityStatus(meta: BytesOnlyEntityMeta): Promise<"live" | "unprovisioned"> {
    return Promise.resolve(meta.isBytes ? "live" : "unprovisioned");
  }

  provisionEntity(_meta: BytesOnlyEntityMeta): Promise<void> {
    return Promise.resolve();
  }

  write(
    meta: BytesOnlyEntityMeta,
    entries: { uri: string; record: EntityRecord }[],
  ): Promise<StoreWriteResult[]> {
    return bytesOnlyWrite(
      meta,
      STORE_NAME,
      entries,
      (e) => this._writeBytes(e),
    );
  }

  read<T = EntityRecord | undefined>(
    meta: BytesOnlyEntityMeta,
    urls: string[],
  ): Promise<Output<T>[]> {
    return bytesOnlyRead<T>(
      meta,
      STORE_NAME,
      urls,
      (u) => this._readBytes(u),
    );
  }

  delete(meta: BytesOnlyEntityMeta, uris: string[]): Promise<DeleteResult[]> {
    return bytesOnlyDelete(
      meta,
      STORE_NAME,
      uris,
      (u) => this._deleteBytes(u),
    );
  }

  // ── Byte ops (BYTES_ENTITY routing) ──────────────────────────────

  private async _writeBytes(
    entries: StoreEntry[],
  ): Promise<StoreWriteResult[]> {
    const results: StoreWriteResult[] = [];

    // Collect any streams to bytes BEFORE opening the IDB transaction.
    // An IDB transaction stays alive only across IDB-callback
    // microtasks; awaiting a non-IDB promise (like draining a
    // ReadableStream) yields long enough for the transaction to
    // auto-commit, after which subsequent put()s either throw
    // `TransactionInactiveError` or silently no-op depending on the
    // implementation. fake-indexeddb is permissive about this; real
    // Chromium is not.
    let prepared: StoredRecord[];
    try {
      prepared = await Promise.all(
        entries.map(async (e): Promise<StoredRecord> => ({
          uri: e.uri,
          payload: await toBytes(e.payload),
        })),
      );
    } catch (err) {
      const failure = storageFailure(err, "Write failed");
      return entries.map(() => ({ success: false, ...failure }));
    }

    try {
      const store = await this.getStore("readwrite");

      for (const record of prepared) {
        try {
          await new Promise<void>((resolve, reject) => {
            const request = store.put(record);
            request.onsuccess = () => resolve();
            request.onerror = () =>
              reject(
                new Error(`Failed to write ${record.uri}: ${request.error}`),
              );
          });
          results.push({ success: true });
        } catch (err) {
          results.push({
            success: false,
            ...storageFailure(err, "Write failed", record.uri),
          });
        }
      }
    } catch (err) {
      // Outer failure (e.g. db open) — every entry fails with the same
      // root cause; no per-entry uri since the failure isn't entry-scoped.
      const failure = storageFailure(err, "Write failed");
      for (const _ of entries) {
        results.push({ success: false, ...failure });
      }
    }

    return results;
  }

  private _readBytes(urls: string[]): Promise<Output<unknown>[]> {
    return dispatchRead<unknown>(urls, STORE_NAME, {
      read: (p) => this._readOne(p.uri),
      ls: (p) => this._ls(p),
      count: (p) => this._count(p),
    });
  }

  private async _readOne(uri: string): Promise<Uint8Array | undefined> {
    try {
      const store = await this.getStore();
      return await new Promise<Uint8Array | undefined>((resolve) => {
        const request = store.get(uri);
        request.onsuccess = () => {
          const record = request.result as StoredRecord | undefined;
          resolve(record ? record.payload : undefined);
        };
        request.onerror = () => resolve(undefined);
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Open a cursor over the `uri_index` constrained to the prefix.
   * Returns URIs (and optionally records) that are direct leaves
   * under `prefixUri` — i.e. `prefixUri + <segment>` with no further
   * `/`. Honours sortOrder and limit/page via cursor walking.
   */
  private async _walkLeaves(
    parsed: ParsedUrl,
    onlyUris: boolean,
  ): Promise<Array<{ uri: string; payload?: Uint8Array }>> {
    const { uri: prefix, params } = parsed;
    const desc = params.sortBy === "uri" && params.sortOrder === "desc";
    const direction = desc ? "prev" : "next";
    const limit = params.limit;
    const offset = limit !== undefined ? ((params.page ?? 1) - 1) * limit : 0;

    // Bound the cursor to `[prefix, prefix + ￿)` — both ends
    // inclusive of the prefix, exclusive of anything past the high
    // surrogate. Fall back to a full scan if IDBKeyRange isn't
    // available in this environment.
    const range = this.keyRange
      ? this.keyRange.bound(prefix, prefix + "￿", false, false)
      : undefined;

    const store = await this.getStore();
    const index = store.index("uri_index");

    return await new Promise<Array<{ uri: string; payload?: Uint8Array }>>(
      (resolve, reject) => {
        const out: Array<{ uri: string; payload?: Uint8Array }> = [];
        let skipped = 0;
        const request = onlyUris
          ? index.openKeyCursor(range, direction)
          : index.openCursor(range, direction);

        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(out);
            return;
          }

          const key = (onlyUris ? cursor.key : cursor.value.uri) as string;
          if (!key.startsWith(prefix)) {
            resolve(out);
            return;
          }
          const tail = key.slice(prefix.length);
          if (tail === "" || tail.includes("/")) {
            cursor.continue();
            return;
          }

          if (skipped < offset) {
            skipped++;
            cursor.continue();
            return;
          }

          if (onlyUris) {
            out.push({ uri: key });
          } else {
            out.push({ uri: key, payload: cursor.value.payload });
          }

          if (limit !== undefined && out.length >= limit) {
            resolve(out);
            return;
          }
          cursor.continue();
        };
        request.onerror = () =>
          reject(request.error ?? new Error("Cursor failed"));
      },
    );
  }

  private async _ls(parsed: ParsedUrl): Promise<Output[] | string[]> {
    validateReadParams(parsed.params, STORE_NAME);
    const format = parsed.params.format ?? "full";
    const onlyUris = format === "uris";

    try {
      const entries = await this._walkLeaves(parsed, onlyUris);
      if (onlyUris) return entries.map((e) => e.uri);
      return entries.map((e): Output => [e.uri, e.payload]);
    } catch {
      return [];
    }
  }

  private async _count(parsed: ParsedUrl): Promise<number> {
    if (parsed.params.pattern !== undefined) {
      throw new Error(`${STORE_NAME}: pattern filter not supported`);
    }
    try {
      const entries = await this._walkLeaves(parsed, true);
      return entries.length;
    } catch {
      return 0;
    }
  }

  private async _deleteBytes(uris: string[]): Promise<DeleteResult[]> {
    const results: DeleteResult[] = [];

    try {
      const store = await this.getStore("readwrite");

      for (const uri of uris) {
        try {
          await new Promise<void>((resolve, reject) => {
            const request = store.delete(uri);
            request.onsuccess = () => resolve();
            request.onerror = () =>
              reject(new Error(`Failed to delete ${uri}: ${request.error}`));
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
      // Outer failure — every uri fails with the same root cause.
      const failure = storageFailure(err, "Delete failed");
      for (const _ of uris) {
        results.push({ success: false, ...failure });
      }
    }

    return results;
  }

  // ── Status ───────────────────────────────────────────────────────

  async status(): Promise<StatusResult> {
    try {
      await this.initDB();
      return {
        status: "healthy",
        schema: [],
        fns: ["read", "ls", "count"],
      };
    } catch {
      return {
        status: "unhealthy",
        schema: [],
        fns: ["read", "ls", "count"],
      };
    }
  }

  capabilities(): StoreCapabilities {
    return { atomicBatch: false };
  }
}
