/**
 * IpfsStore — IPFS implementation of Store.
 *
 * Pure mechanical byte storage with no protocol awareness. Writes
 * pinned IPFS objects and maintains an in-memory `uri → CID` index
 * for lookups. The block body is the payload bytes verbatim.
 *
 * `fn=ls` / `fn=count` are shallow direct-leaves only: scan the
 * in-memory index, keep URIs whose remainder under the prefix has no
 * further `/`.
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
import type { IpfsExecutor } from "./mod.ts";

const STORE_NAME = "IpfsStore";

interface IndexEntry {
  cid: string;
}

export class IpfsStore implements EntityStore<BytesOnlyEntityMeta> {
  private readonly executor: IpfsExecutor;
  private readonly index = new Map<string, IndexEntry>();

  constructor(executor: IpfsExecutor) {
    if (!executor) throw new Error("executor is required");
    this.executor = executor;
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
        const cid = await this.executor.add(entry.payload);
        await this.executor.pin(cid);

        // Unpin the old CID if this URI was already indexed
        const existing = this.index.get(entry.uri);
        if (existing) {
          try {
            await this.executor.unpin(existing.cid);
          } catch {
            // Old CID may already be unpinned — ignore
          }
        }

        this.index.set(entry.uri, { cid });
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
    const entry = this.index.get(uri);
    if (!entry) return undefined;
    try {
      return await this.executor.cat(entry.cid);
    } catch {
      return undefined;
    }
  }

  /** Shallow direct-leaves from the in-memory URI index. */
  private _directLeafUris(prefixUri: string): string[] {
    const out: string[] = [];
    for (const uri of this.index.keys()) {
      if (!uri.startsWith(prefixUri)) continue;
      const tail = uri.slice(prefixUri.length);
      if (tail === "" || tail.includes("/")) continue;
      out.push(uri);
    }
    return out;
  }

  private async _ls(parsed: ParsedUrl): Promise<Output[] | string[]> {
    validateReadParams(parsed.params, STORE_NAME);
    const { params } = parsed;
    const format = params.format ?? "full";

    let uris = this._directLeafUris(parsed.uri);

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

  private _count(parsed: ParsedUrl): number {
    if (parsed.params.pattern !== undefined) {
      throw new Error(`${STORE_NAME}: pattern filter not supported`);
    }
    return this._directLeafUris(parsed.uri).length;
  }

  private async _deleteBytes(uris: string[]): Promise<DeleteResult[]> {
    const results: DeleteResult[] = [];

    for (const uri of uris) {
      try {
        const entry = this.index.get(uri);
        if (entry) {
          try {
            await this.executor.unpin(entry.cid);
          } catch {
            // CID may already be unpinned — ignore
          }
          this.index.delete(uri);
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

  // ── Status ───────────────────────────────────────────────────────

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

      // Derive schema from indexed URIs
      const programs = new Set<string>();
      for (const uri of this.index.keys()) {
        try {
          const url = new URL(uri);
          programs.add(`${url.protocol}//${url.hostname}`);
        } catch {
          // skip malformed URIs
        }
      }

      return {
        status: "healthy",
        schema: [...programs],
        fns: ["read", "ls", "count"],
        details: { indexedUris: this.index.size },
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
}
