/**
 * S3Store — Amazon S3 implementation of Store.
 *
 * Pure mechanical byte storage with no protocol awareness. One S3
 * object per entry. Object body is the payload bytes verbatim; the
 * store is opaque.
 *
 * `fn=ls` / `fn=count` are shallow direct-leaves only: list objects
 * under the URI's key prefix, then filter to keys whose remainder
 * contains no further `/`. The `format=uris` fast path returns the
 * URIs without issuing `getObject`; `format=full` only fetches the
 * selected page.
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
import { validateReadParams } from "../read.ts";
import type {
  StoreCapabilities,
  StoreEntry,
  StoreWriteResult,
} from "../types.ts";
import type { S3Executor } from "./mod.ts";

const STORE_NAME = "S3Store";
const EXT = ".bin";

/** `protocol://host/path` → `protocol_host/path`. */
function uriToKey(uri: string): string {
  return uri.replace("://", "_").replace(/^\//, "");
}

/** Inverse of `uriToKey` with `.bin` suffix stripping. */
function keyTailToUri(tail: string): string {
  const noExt = tail.endsWith(EXT) ? tail.slice(0, -EXT.length) : tail;
  return noExt.replace("_", "://");
}

export class S3Store implements EntityStore<BytesOnlyEntityMeta> {
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
        await this.executor.putObject(
          this._resolveKey(entry.uri),
          entry.payload,
          "application/octet-stream",
        );
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

  private async _readOne(
    uri: string,
  ): Promise<ReadableStream<Uint8Array> | undefined> {
    const content = await this.executor.getObject(this._resolveKey(uri));
    return content ?? undefined;
  }

  /** List direct-child URIs under a prefix (no recursion into sub-prefixes). */
  private async _listChildUris(prefixUri: string): Promise<string[]> {
    const keyPrefix = `${this.prefix}${uriToKey(prefixUri)}`;
    const keys = await this.executor.listObjects(keyPrefix);
    const uris: string[] = [];
    for (const key of keys) {
      if (!key.endsWith(EXT)) continue;
      const tail = key.slice(keyPrefix.length);
      if (tail.includes("/")) continue; // nested, not a direct leaf
      uris.push(`${prefixUri}${keyTailToUri(tail)}`);
    }
    return uris;
  }

  private async _ls(parsed: ParsedUrl): Promise<Output[] | string[]> {
    validateReadParams(parsed.params, STORE_NAME);
    const { params } = parsed;
    const format = params.format ?? "full";

    let uris = await this._listChildUris(parsed.uri);

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

    const out: Output[] = [];
    for (const uri of uris) {
      out.push([uri, await this._readOne(uri)]);
    }
    return out;
  }

  private async _count(parsed: ParsedUrl): Promise<number> {
    if (parsed.params.pattern !== undefined) {
      throw new Error(`${STORE_NAME}: pattern filter not supported`);
    }
    return (await this._listChildUris(parsed.uri)).length;
  }

  private async _deleteBytes(uris: string[]): Promise<DeleteResult[]> {
    const results: DeleteResult[] = [];

    for (const uri of uris) {
      try {
        await this.executor.deleteObject(this._resolveKey(uri));
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

  // ── Status ───────────────────────────────────────────────────────

  async status(): Promise<StatusResult> {
    try {
      const ok = await this.executor.headBucket();
      if (!ok) {
        return {
          status: "unhealthy",
          message: `Bucket not accessible: ${this.bucket}`,
          fns: ["read", "ls", "count"],
        };
      }
      return {
        status: "healthy",
        message: "S3 store is operational",
        fns: ["read", "ls", "count"],
        details: {
          bucket: this.bucket,
          prefix: this.prefix || "(none)",
        },
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

  private _resolveKey(uri: string): string {
    return `${this.prefix}${uriToKey(uri)}${EXT}`;
  }
}
