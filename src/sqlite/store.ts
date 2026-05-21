/**
 * SqliteStore — SQLite implementation of `EntityStore`.
 *
 * One layout for every schema: `{prefix}_{entity}_data` with `uri TEXT
 * PRIMARY KEY` and one column per supported field, typed by the
 * canonical `TYPE_TAGS` it carries (see `./columns.ts`). `BYTES_ENTITY`
 * is just an entity with one `payload BLOB` column — no legacy
 * special case.
 *
 * ## Lifecycle
 *
 * `entitySupport(schema)` is pure — it runs `planColumns` and returns
 * a `SqliteEntityMeta` with the target table name, column plans,
 * bytes-column set, and the support report. No IO.
 *
 * `provisionEntity(meta)` runs `CREATE TABLE IF NOT EXISTS` and then
 * verifies the live shape matches the meta (catches same-name-
 * different-shape collisions). `entityStatus(meta)` performs the same
 * check in isolation via `pragma_table_info`.
 *
 * Writes/reads/deletes consume the meta directly: no per-call cache
 * gate. If the table is not provisioned, SQLite raises a
 * "no such table" error; the standard `storageFailure` wrap surfaces
 * it per entry.
 *
 * `fn=ls` / `fn=count` push down to SQL — the shallow-direct-leaves
 * predicate (`uri LIKE prefix% AND uri NOT LIKE prefix%/%`) is
 * enforced in the WHERE clause against the entity's table.
 *
 * Writes are wrapped in a transaction (`capabilities.atomicBatch =
 * true`). Stream-shaped values on `BLOB` columns are collected to
 * `Uint8Array` *before* the transaction opens, so a stream failure
 * can't leave a half-applied commit.
 */

import type {
  DeleteResult,
  Output,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import type { ParsedUrl } from "@bandeira-tech/b3nd-core/url";
import { dispatchRead } from "../dispatch.ts";
import { storageFailure } from "../errors.ts";
import { toBytes } from "../payload.ts";
import { validateReadParams } from "../read.ts";
import type { EntityStore } from "../entity-store.ts";
import type {
  EntityMeta,
  EntityRecord,
  EntitySchema,
  EntitySupport,
} from "../entity.ts";
import type { StoreCapabilities, StoreWriteResult } from "../types.ts";
import { type ColumnPlan, planColumns } from "./columns.ts";
import type { SqliteExecutor } from "./mod.ts";

const STORE_NAME = "SqliteStore";

const TABLE_PREFIX = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * SqliteStore-specific entity handle.
 *
 * `tableName` is the prefixed-and-suffixed target table; `columns`
 * are the planned user columns (without the always-present `uri`,
 * `created_at`, `updated_at`); `declared` is the set of user column
 * names for the per-write extras check; `bytesColumns` drives
 * pre-transaction stream normalisation.
 */
export interface SqliteEntityMeta extends EntityMeta {
  readonly tableName: string;
  readonly columns: readonly ColumnPlan[];
  readonly declared: ReadonlySet<string>;
  readonly bytesColumns: ReadonlySet<string>;
}

/** Coerce a sqlite `BLOB` row value into a `Uint8Array`. */
function rowToBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  throw new Error(`${STORE_NAME}: unexpected payload type ${typeof value}`);
}

function entityTableName(tablePrefix: string, entityName: string): string {
  if (!TABLE_PREFIX.test(entityName)) {
    throw new Error(
      `${STORE_NAME}: entity name '${entityName}' must match ${TABLE_PREFIX.source}`,
    );
  }
  return `${tablePrefix}_${entityName}_data`;
}

export class SqliteStore implements EntityStore<SqliteEntityMeta> {
  private readonly tablePrefix: string;
  private readonly executor: SqliteExecutor;

  constructor(tablePrefix: string, executor: SqliteExecutor) {
    if (!tablePrefix) throw new Error("tablePrefix is required");
    if (!TABLE_PREFIX.test(tablePrefix)) {
      throw new Error(
        `tablePrefix must match ${TABLE_PREFIX.source}; got '${tablePrefix}'`,
      );
    }
    if (!executor) throw new Error("executor is required");

    this.tablePrefix = tablePrefix;
    this.executor = executor;
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  entitySupport(schema: EntitySchema): SqliteEntityMeta {
    const { columns, unsupported } = planColumns(schema.fields);
    const support: EntitySupport = {
      entity: schema.name,
      supported: columns.map((c) => c.name),
      unsupported,
    };
    return {
      support,
      tableName: entityTableName(this.tablePrefix, schema.name),
      columns,
      declared: new Set(columns.map((c) => c.name)),
      bytesColumns: new Set(
        columns.filter((c) => c.sqlType === "BLOB").map((c) => c.name),
      ),
    };
  }

  // deno-lint-ignore require-await
  async entityStatus(
    meta: SqliteEntityMeta,
  ): Promise<"live" | "unprovisioned"> {
    const res = this.executor.query(
      `SELECT name, type FROM pragma_table_info(?)`,
      [meta.tableName],
    );
    const rows = (res.rows ?? []) as Array<{ name: string; type: string }>;
    if (rows.length === 0) return "unprovisioned";
    const actual = new Map(rows.map((r) => [r.name, r.type.toUpperCase()]));
    for (const c of meta.columns) {
      const got = actual.get(c.name);
      if (got === undefined) return "unprovisioned";
      if (got !== c.sqlType.toUpperCase()) return "unprovisioned";
    }
    // Reject collisions in the other direction: the live table carrying
    // user columns the meta does not declare is a different shape.
    for (const name of actual.keys()) {
      if (name === "uri" || name === "created_at" || name === "updated_at") {
        continue;
      }
      if (!meta.declared.has(name)) return "unprovisioned";
    }
    return "live";
  }

  async provisionEntity(meta: SqliteEntityMeta): Promise<void> {
    const colDdl = meta.columns
      .map((c) => `"${c.name}" ${c.sqlType}`)
      .join(",\n  ");
    const createTable = `CREATE TABLE IF NOT EXISTS ${meta.tableName} (
  uri TEXT PRIMARY KEY${meta.columns.length > 0 ? ",\n  " + colDdl : ""},
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)`;
    const createIndex =
      `CREATE INDEX IF NOT EXISTS idx_${meta.tableName}_uri ON ${meta.tableName} (uri)`;
    this.executor.query(createTable);
    this.executor.query(createIndex);

    // If the table already existed with a different shape, the
    // CREATE IF NOT EXISTS was a no-op — surface the collision.
    const status = await this.entityStatus(meta);
    if (status !== "live") {
      throw new Error(
        `${STORE_NAME}: entity '${meta.support.entity}' is already ` +
          `provisioned with a different shape at table '${meta.tableName}'`,
      );
    }
  }

  // ── Write ────────────────────────────────────────────────────────

  async write(
    meta: SqliteEntityMeta,
    entries: { uri: string; record: EntityRecord }[],
  ): Promise<StoreWriteResult[]> {
    if (entries.length === 0) return [];
    const out: StoreWriteResult[] = new Array(entries.length);
    const accepted: { idx: number; uri: string; record: EntityRecord }[] = [];

    // Validate + collect stream-shaped bytes fields BEFORE the
    // transaction. Per-entry validation errors leak as failures in
    // their slots; everything else gets committed atomically below.
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
        const normalised = await normaliseBytesFields(
          record,
          meta.bytesColumns,
        );
        accepted.push({ idx: i, uri, record: normalised });
      } catch (err) {
        out[i] = {
          success: false,
          ...storageFailure(err, "Invalid record", uri),
        };
      }
    }
    if (accepted.length === 0) return out;

    const cols = meta.columns;
    const colList = cols.map((c) => `"${c.name}"`).join(", ");
    const placeholders = cols.map(() => "?").join(", ");
    const updates = cols
      .map((c) => `"${c.name}" = excluded."${c.name}"`)
      .concat(["updated_at = datetime('now')"])
      .join(", ");

    try {
      this.executor.transaction((tx) => {
        for (const { uri, record } of accepted) {
          const args: unknown[] = [uri];
          for (const c of cols) args.push(adaptForWrite(c, record[c.name]));
          tx.query(
            `INSERT INTO ${meta.tableName} (uri${
              colList ? ", " + colList : ""
            }) VALUES (?${placeholders ? ", " + placeholders : ""})
             ON CONFLICT(uri) DO UPDATE SET ${updates}`,
            args,
          );
        }
      });
      for (const { idx } of accepted) out[idx] = { success: true };
      return out;
    } catch (err) {
      // Atomic batch failure — every accepted entry shares the same failure.
      // A "no such table" from a not-yet-provisioned meta lands here too.
      const failure = storageFailure(err, "Write failed");
      for (const { idx } of accepted) out[idx] = { success: false, ...failure };
      return out;
    }
  }

  // ── Read ─────────────────────────────────────────────────────────

  read<T = EntityRecord | undefined>(
    meta: SqliteEntityMeta,
    urls: string[],
  ): Promise<Output<T>[]> {
    return dispatchRead<T>(urls, STORE_NAME, {
      read: (p) => this._readOne(meta, p.uri),
      ls: (p) => this._ls(meta, p),
      count: (p) => this._count(meta, p),
    });
  }

  async delete(
    meta: SqliteEntityMeta,
    uris: string[],
  ): Promise<DeleteResult[]> {
    if (uris.length === 0) return [];
    try {
      this.executor.transaction((tx) => {
        for (const uri of uris) {
          tx.query(
            `DELETE FROM ${meta.tableName} WHERE uri = ?`,
            [uri],
          );
        }
      });
      return uris.map(() => ({ success: true }));
    } catch (err) {
      const failure = storageFailure(err, "Delete failed");
      return uris.map(() => ({ success: false, ...failure }));
    }
  }

  // deno-lint-ignore require-await
  async status(): Promise<StatusResult> {
    try {
      this.executor.query("SELECT 1");
      return {
        status: "healthy",
        message: "SQLite store is operational",
        fns: ["read", "ls", "count"],
        details: { tablePrefix: this.tablePrefix },
      };
    } catch (error) {
      return {
        status: "unhealthy",
        message: `SQLite health check failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        fns: ["read", "ls", "count"],
      };
    }
  }

  capabilities(): StoreCapabilities {
    return { atomicBatch: true };
  }

  // ── Internals ────────────────────────────────────────────────────

  // deno-lint-ignore require-await
  private async _readOne(
    meta: SqliteEntityMeta,
    uri: string,
  ): Promise<EntityRecord | undefined> {
    if (meta.columns.length === 0) {
      // Empty schema: presence-only — return an empty record on hit.
      const res = this.executor.query(
        `SELECT 1 FROM ${meta.tableName} WHERE uri = ?`,
        [uri],
      );
      return res.rows && res.rows.length > 0 ? {} : undefined;
    }
    const cols = meta.columns.map((c) => `"${c.name}"`).join(", ");
    const res = this.executor.query(
      `SELECT ${cols} FROM ${meta.tableName} WHERE uri = ?`,
      [uri],
    );
    if (!res.rows || res.rows.length === 0) return undefined;
    return adaptRowForRead(meta, res.rows[0] as Record<string, unknown>);
  }

  // deno-lint-ignore require-await
  private async _ls(
    meta: SqliteEntityMeta,
    parsed: ParsedUrl,
  ): Promise<Output[] | string[]> {
    validateReadParams(parsed.params, STORE_NAME);
    const { params } = parsed;
    const format = params.format ?? "full";
    const cols = meta.columns.length > 0
      ? "uri, " + meta.columns.map((c) => `"${c.name}"`).join(", ")
      : "uri";
    const selectClause = format === "uris" ? "uri" : cols;
    const order = params.sortBy === "uri"
      ? ` ORDER BY uri ${params.sortOrder === "desc" ? "DESC" : "ASC"}`
      : "";

    let sql =
      `SELECT ${selectClause} FROM ${meta.tableName} WHERE uri LIKE ? || '%' AND uri NOT LIKE ? || '%/%'${order}`;
    const args: unknown[] = [parsed.uri, parsed.uri];
    if (params.limit !== undefined) {
      const page = params.page ?? 1;
      sql += ` LIMIT ? OFFSET ?`;
      args.push(params.limit, (page - 1) * params.limit);
    }
    const res = this.executor.query(sql, args);
    const rows = (res.rows ?? []) as Array<Record<string, unknown>>;
    if (format === "uris") return rows.map((r) => r.uri as string);
    return rows.map((r): Output => [
      r.uri as string,
      adaptRowForRead(meta, r),
    ]);
  }

  // deno-lint-ignore require-await
  private async _count(
    meta: SqliteEntityMeta,
    parsed: ParsedUrl,
  ): Promise<number> {
    if (parsed.params.pattern !== undefined) {
      throw new Error(`${STORE_NAME}: pattern filter not supported`);
    }
    const res = this.executor.query(
      `SELECT COUNT(*) AS n FROM ${meta.tableName} WHERE uri LIKE ? || '%' AND uri NOT LIKE ? || '%/%'`,
      [parsed.uri, parsed.uri],
    );
    const row = res.rows?.[0] as { n: number } | undefined;
    return row?.n ?? 0;
  }
}

/**
 * Collect any `ReadableStream` values on `BLOB` columns into
 * `Uint8Array` and return a shallow-copied record. Runs before the
 * write transaction so stream failures can't leave a half-applied
 * commit. Non-stream values pass through verbatim.
 */
async function normaliseBytesFields(
  record: EntityRecord,
  bytesColumns: ReadonlySet<string>,
): Promise<EntityRecord> {
  if (bytesColumns.size === 0) return record;
  const out: EntityRecord = { ...record };
  for (const name of bytesColumns) {
    const v = out[name];
    if (v === undefined || v === null) continue;
    if (v instanceof Uint8Array) continue;
    if (v instanceof ReadableStream) {
      out[name] = await toBytes(v);
      continue;
    }
    throw new Error(
      `${STORE_NAME}: field '${name}' must be Uint8Array or ReadableStream, got ${typeof v}`,
    );
  }
  return out;
}

/** Coerce a record field value into something the driver will accept. */
function adaptForWrite(col: ColumnPlan, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (col.sqlType === "JSON") {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  if (col.sqlType === "TIMESTAMP") {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "number") return new Date(value).toISOString();
    return value;
  }
  if (col.sqlType === "BOOLEAN") {
    return value ? 1 : 0;
  }
  return value;
}

/** Reconstruct an EntityRecord from a SQLite row. */
function adaptRowForRead(
  meta: SqliteEntityMeta,
  row: Record<string, unknown>,
): EntityRecord {
  const rec: EntityRecord = {};
  for (const col of meta.columns) {
    const v = row[col.name];
    if (v === null || v === undefined) {
      rec[col.name] = undefined;
      continue;
    }
    if (col.sqlType === "BLOB") rec[col.name] = rowToBytes(v);
    else if (col.sqlType === "JSON") {
      rec[col.name] = typeof v === "string" ? JSON.parse(v) : v;
    } else if (col.sqlType === "TIMESTAMP") {
      rec[col.name] = v instanceof Date ? v : new Date(v as string);
    } else if (col.sqlType === "BOOLEAN") {
      rec[col.name] = v === 1 || v === true || v === "1";
    } else rec[col.name] = v;
  }
  return rec;
}
