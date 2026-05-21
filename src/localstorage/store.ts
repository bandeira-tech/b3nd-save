/**
 * LocalStorageStore — browser localStorage implementation of Store.
 *
 * Pure mechanical byte storage with no protocol awareness. Uses
 * `localStorage` as a flat key→string KV. Payload bytes are
 * base64-encoded since `localStorage` values are strings.
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

import { decodeBase64, encodeBase64 } from "@bandeira-tech/b3nd-core";
import type { ParsedUrl } from "@bandeira-tech/b3nd-core/url";
import { dispatchRead } from "../dispatch.ts";
import { storageFailure } from "../errors.ts";
import { toBytes } from "../payload.ts";
import { applyReadParams } from "../read.ts";
import type {
  StoreCapabilities,
  StoreEntry,
  StoreWriteResult,
} from "../types.ts";

const STORE_NAME = "LocalStorageStore";

export class LocalStorageStore implements EntityStore<BytesOnlyEntityMeta> {
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

  private getKey(uri: string): string {
    return `${this.keyPrefix}${uri}`;
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

    for (const entry of entries) {
      try {
        const bytes = await toBytes(entry.payload);
        this.storage.setItem(this.getKey(entry.uri), encodeBase64(bytes));
        results.push({ success: true });
      } catch (err) {
        results.push({
          success: false,
          ...storageFailure(err, "Write failed", entry.uri),
        });
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

  private _readOne(uri: string): Uint8Array | undefined {
    const serialized = this.storage.getItem(this.getKey(uri));
    if (serialized === null) return undefined;
    return decodeBase64(serialized);
  }

  /**
   * Walk localStorage once, returning `[uri, bytes]` for every entry
   * whose URI is `prefix + <segment>` with no further `/`. Subtree-only
   * paths are excluded by the slash check.
   */
  private _directLeaves(prefixUri: string): Output[] {
    const prefixKey = this.getKey(prefixUri);
    const out: Output[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key || !key.startsWith(prefixKey)) continue;
      const rest = key.substring(prefixKey.length);
      if (rest === "" || rest.includes("/")) continue;
      const childUri = `${prefixUri}${rest}`;
      out.push([childUri, this._readOne(childUri)]);
    }
    return out;
  }

  private _ls(parsed: ParsedUrl): Output[] | string[] {
    return applyReadParams(
      this._directLeaves(parsed.uri),
      parsed.params,
      STORE_NAME,
    );
  }

  private _count(parsed: ParsedUrl): number {
    if (parsed.params.pattern !== undefined) {
      throw new Error(`${STORE_NAME}: pattern filter not supported`);
    }
    return this._directLeaves(parsed.uri).length;
  }

  private _deleteBytes(uris: string[]): Promise<DeleteResult[]> {
    const results: DeleteResult[] = [];

    for (const uri of uris) {
      try {
        this.storage.removeItem(this.getKey(uri));
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

  // ── Status ───────────────────────────────────────────────────────

  status(): Promise<StatusResult> {
    try {
      const testKey = `${this.keyPrefix}__health_check__`;
      this.storage.setItem(testKey, "ok");
      this.storage.removeItem(testKey);
      return Promise.resolve({
        status: "healthy",
        schema: [],
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
}
