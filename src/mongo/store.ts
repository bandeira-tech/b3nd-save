/**
 * MongoStore — MongoDB implementation of Store.
 *
 * Pure mechanical byte storage with no protocol awareness. Uses an
 * injected MongoExecutor so the package does not depend on a specific
 * MongoDB driver. Payload is stored as a BSON `Binary` value (the
 * `mongodb` driver maps `Uint8Array` to it transparently).
 *
 * `fn=ls`/`fn=count` push down to a regex prefix query that enforces
 * the shallow-direct-leaves contract: `^<prefix>[^/]+$`.
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
import type { MongoExecutor } from "./mod.ts";

const STORE_NAME = "MongoStore";

/** Escape special regex characters for safe use in a RegExp pattern. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalize a Mongo document field into a `Uint8Array`. The driver may
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
  throw new Error(`MongoStore: unexpected payload type ${typeof value}`);
}

export class MongoStore implements EntityStore<BytesOnlyEntityMeta> {
  private readonly collectionName: string;
  private readonly executor: MongoExecutor;

  constructor(collectionName: string, executor: MongoExecutor) {
    if (!collectionName) throw new Error("collectionName is required");
    if (!executor) throw new Error("executor is required");

    this.collectionName = collectionName;
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
        const bytes = await toBytes(entry.payload);
        await this.executor.updateOne(
          { uri: entry.uri },
          {
            $set: {
              uri: entry.uri,
              payload: bytes,
              updatedAt: new Date(),
            },
          },
          { upsert: true },
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

  private async _readOne(uri: string): Promise<Uint8Array | undefined> {
    const doc = await this.executor.findOne({ uri });
    if (!doc) return undefined;
    return docToBytes(doc.payload);
  }

  /** Build the shallow-direct-leaves regex filter for a prefix. */
  private _leafFilter(prefixUri: string): Record<string, unknown> {
    return { uri: { $regex: `^${escapeRegex(prefixUri)}[^/]+$` } };
  }

  private async _ls(parsed: ParsedUrl): Promise<Output[] | string[]> {
    validateReadParams(parsed.params, STORE_NAME);
    const { params } = parsed;
    const format = params.format ?? "full";

    const options: Parameters<MongoExecutor["findMany"]>[1] = {};
    if (params.sortBy === "uri") {
      options.sort = { uri: params.sortOrder === "desc" ? -1 : 1 };
    }
    if (params.limit !== undefined) {
      const page = params.page ?? 1;
      options.limit = params.limit;
      options.skip = (page - 1) * params.limit;
    }
    if (format === "uris") {
      options.projection = { uri: 1, _id: 0 };
    }

    const docs = await this.executor.findMany(
      this._leafFilter(parsed.uri),
      options,
    );

    if (format === "uris") return docs.map((d) => d.uri as string);
    return docs.map((d): Output => [d.uri as string, docToBytes(d.payload)]);
  }

  private async _count(parsed: ParsedUrl): Promise<number> {
    if (parsed.params.pattern !== undefined) {
      throw new Error(`${STORE_NAME}: pattern filter not supported`);
    }
    return await this.executor.countDocuments(this._leafFilter(parsed.uri));
  }

  private async _deleteBytes(uris: string[]): Promise<DeleteResult[]> {
    const results: DeleteResult[] = [];

    for (const uri of uris) {
      try {
        await this.executor.deleteOne({ uri });
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
        details: { collectionName: this.collectionName },
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
