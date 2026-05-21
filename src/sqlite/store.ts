/**
 * SqliteStore — SQLite implementation of Store.
 *
 * Pure mechanical byte storage with no protocol awareness. Pushes
 * fn=ls/fn=count down to SQL using the shallow-direct-leaves
 * predicate: `uri LIKE ? || '%' AND uri NOT LIKE ? || '%/%'`.
 *
 * Uses an injected synchronous SqliteExecutor; results are wrapped in
 * Promise.resolve() to satisfy the async Store interface. `payload`
 * is a BLOB; the store does not inspect or transform its contents.
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
import type { SqliteExecutor } from "./mod.ts";

const STORE_NAME = "SqliteStore";

function rowToBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  throw new Error(`SqliteStore: unexpected payload type ${typeof value}`);
}

export class SqliteStore implements EntityStore<BytesOnlyEntityMeta> {
  private readonly tableName: string;
  private readonly executor: SqliteExecutor;

  constructor(tablePrefix: string, executor: SqliteExecutor) {
    if (!tablePrefix) throw new Error("tablePrefix is required");
    if (!executor) throw new Error("executor is required");

    this.tableName = `${tablePrefix}_data`;
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
    if (entries.length === 0) return [];

    // Collect streams up front: the executor is synchronous (BLOB
    // wants bytes), and we don't want to await mid-transaction.
    const prepared = await Promise.all(
      entries.map(async (e) => ({
        uri: e.uri,
        bytes: await toBytes(e.payload),
      })),
    );

    // `capabilities.atomicBatch` is true: the whole batch commits or
    // nothing does. On failure every result is `{ success: false }`
    // with the same root-cause error.
    try {
      this.executor.transaction((tx) => {
        for (const entry of prepared) {
          tx.query(
            `INSERT INTO ${this.tableName} (uri, payload, updated_at)
             VALUES (?, ?, datetime('now'))
             ON CONFLICT(uri) DO UPDATE SET
               payload = excluded.payload,
               updated_at = datetime('now')`,
            [entry.uri, entry.bytes],
          );
        }
      });
      return entries.map(() => ({ success: true }));
    } catch (err) {
      const failure = storageFailure(err, "Write failed");
      return entries.map(() => ({ success: false, ...failure }));
    }
  }

  private _readBytes(urls: string[]): Promise<Output<unknown>[]> {
    return dispatchRead<unknown>(urls, STORE_NAME, {
      read: (p) => this._readOne(p.uri),
      ls: (p) => this._ls(p),
      count: (p) => this._count(p),
    });
  }

  private _readOne(uri: string): Uint8Array | undefined {
    const result = this.executor.query(
      `SELECT payload FROM ${this.tableName} WHERE uri = ?`,
      [uri],
    );
    if (!result.rows.length) return undefined;
    return rowToBytes(result.rows[0].payload);
  }

  private _ls(parsed: ParsedUrl): Output[] | string[] {
    validateReadParams(parsed.params, STORE_NAME);
    const { params } = parsed;
    const format = params.format ?? "full";

    const select = format === "uris" ? "uri" : "uri, payload";
    const order = params.sortBy === "uri"
      ? ` ORDER BY uri ${params.sortOrder === "desc" ? "DESC" : "ASC"}`
      : "";

    let sql =
      `SELECT ${select} FROM ${this.tableName} WHERE uri LIKE ? || '%' AND uri NOT LIKE ? || '%/%'${order}`;
    const args: unknown[] = [parsed.uri, parsed.uri];

    if (params.limit !== undefined) {
      const page = params.page ?? 1;
      sql += ` LIMIT ? OFFSET ?`;
      args.push(params.limit, (page - 1) * params.limit);
    }

    const result = this.executor.query(sql, args);
    const rows = result.rows as Array<{ uri: string; payload?: unknown }>;

    if (format === "uris") return rows.map((r) => r.uri);
    return rows.map((r): Output => [r.uri, rowToBytes(r.payload)]);
  }

  private _count(parsed: ParsedUrl): number {
    if (parsed.params.pattern !== undefined) {
      throw new Error(`${STORE_NAME}: pattern filter not supported`);
    }
    const result = this.executor.query(
      `SELECT COUNT(*) AS n FROM ${this.tableName} WHERE uri LIKE ? || '%' AND uri NOT LIKE ? || '%/%'`,
      [parsed.uri, parsed.uri],
    );
    const row = result.rows[0] as { n: number } | undefined;
    return row?.n ?? 0;
  }

  private _deleteBytes(uris: string[]): Promise<DeleteResult[]> {
    if (uris.length === 0) return Promise.resolve([]);

    // Atomic batch: every uri either deletes together or not at all.
    try {
      this.executor.transaction((tx) => {
        for (const uri of uris) {
          tx.query(
            `DELETE FROM ${this.tableName} WHERE uri = ?`,
            [uri],
          );
        }
      });
      return Promise.resolve(uris.map(() => ({ success: true })));
    } catch (err) {
      const failure = storageFailure(err, "Delete failed");
      return Promise.resolve(
        uris.map(() => ({ success: false, ...failure })),
      );
    }
  }

  // ── Status ───────────────────────────────────────────────────────

  status(): Promise<StatusResult> {
    try {
      this.executor.query("SELECT 1");
      return Promise.resolve({
        status: "healthy",
        message: "SQLite store is operational",
        fns: ["read", "ls", "count"],
        details: { tableName: this.tableName },
      });
    } catch (error) {
      return Promise.resolve({
        status: "unhealthy",
        message: error instanceof Error ? error.message : String(error),
        fns: ["read", "ls", "count"],
      });
    }
  }

  capabilities(): StoreCapabilities {
    return { atomicBatch: true };
  }
}
