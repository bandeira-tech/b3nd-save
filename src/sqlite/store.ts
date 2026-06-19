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
 * check in isolation via `PRAGMA table_info`.
 *
 * Writes/reads/deletes consume the meta directly: no per-call cache
 * gate. Operations against a not-yet-provisioned meta surface
 * SQLite's natural failure per entry.
 *
 * `fn=ls` / `fn=count` push down to SQL — the shallow-direct-leaves
 * predicate (`uri LIKE prefix || '%' AND uri NOT LIKE prefix || '%/%'`)
 * is enforced in the WHERE clause against the entity's table.
 *
 * Writes are wrapped in a transaction (`capabilities.atomicBatch =
 * true`). Stream-shaped values on `BLOB` columns are collected to
 * `Uint8Array` *before* the transaction opens.
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
import { patternToSqlLike, validateReadParams } from "../read.ts";
import type { EntityStore } from "../entity-store.ts";
import {
  type EntityMeta,
  type EntityRecord,
  type EntitySchema,
  type EntitySupport,
  TYPE_TAGS,
} from "../entity.ts";
import { IDENTIFIER_PATTERN, isValidIdentifier } from "../identifiers.ts";
import type { StoreCapabilities, StoreWriteResult } from "../types.ts";
import { type ColumnPlan, planColumns } from "./columns.ts";
import type { SqliteExecutor } from "./mod.ts";

const STORE_NAME = "SqliteStore";

/**
 * SqliteStore-specific entity handle.
 *
 * `tableName` is the prefixed-and-suffixed target table; `columns`
 * are the planned user columns (without the always-present `uri`,
 * `created_at`, `updated_at`); `declared` is the set of user column
 * names for the per-write extras check; `bytesColumns` drives stream
 * normalisation; `jsonColumns`/`tsColumns`/`booleanColumns` drive
 * the per-tag adapt-for-write/read coercions.
 */
export interface SqliteEntityMeta extends EntityMeta {
  readonly tableName: string;
  readonly columns: readonly ColumnPlan[];
  readonly declared: ReadonlySet<string>;
  readonly bytesColumns: ReadonlySet<string>;
}

function rowToBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  throw new Error(`${STORE_NAME}: unexpected payload type ${typeof value}`);
}

function entityTableName(tablePrefix: string, entityName: string): string {
  if (!isValidIdentifier(entityName)) {
    throw new Error(
      `${STORE_NAME}: entity name '${entityName}' must match ${IDENTIFIER_PATTERN.source}`,
    );
  }
  return `${tablePrefix}_${entityName}_data`;
}

export class SqliteStore implements EntityStore<SqliteEntityMeta> {
  private readonly tablePrefix: string;
  private readonly executor: SqliteExecutor;

  constructor(tablePrefix: string, executor: SqliteExecutor) {
    if (!tablePrefix) throw new Error("tablePrefix is required");
    if (!isValidIdentifier(tablePrefix)) {
      throw new Error(
        `tablePrefix must match ${IDENTIFIER_PATTERN.source}; got '${tablePrefix}'`,
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
    const info = this.executor.query(
      `PRAGMA table_info("${meta.tableName}")`,
    );
    const rows = (info.rows ?? []) as Array<{ name: string; type: string }>;
    if (rows.length === 0) return "unprovisioned";
    const actual = new Map(
      rows.map((r) => [r.name, (r.type ?? "").toUpperCase()]),
    );
    for (const c of meta.columns) {
      const got = actual.get(c.name);
      if (got === undefined) return "unprovisioned";
      if (got !== c.sqlType) return "unprovisioned";
    }
    // Reject collisions in the other direction: extra user columns
    // present in the live table that the meta doesn't declare are a
    // different shape.
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
    const sql = `CREATE TABLE IF NOT EXISTS "${meta.tableName}" (
  uri TEXT PRIMARY KEY${meta.columns.length > 0 ? ",\n  " + colDdl : ""},
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS "idx_${meta.tableName}_uri" ON "${meta.tableName}" (uri);`;
    // SQLite drivers vary on whether `query` accepts multi-statement
    // SQL; split and run each.
    for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
      this.executor.query(stmt);
    }
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
            `INSERT INTO "${meta.tableName}" (uri${
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
      read: (p) => Promise.resolve(this._readOne(meta, p.uri) as T | undefined),
      ls: (p) => Promise.resolve(this._ls(meta, p) as Output<T>[] | string[]),
      count: (p) => Promise.resolve(this._count(meta, p)),
      pushDownPattern: true,
      pushDownCursor: true,
      pushDownSortBy: true,
    });
  }

  delete(meta: SqliteEntityMeta, uris: string[]): Promise<DeleteResult[]> {
    if (uris.length === 0) return Promise.resolve([]);
    try {
      this.executor.transaction((tx) => {
        for (const uri of uris) {
          tx.query(
            `DELETE FROM "${meta.tableName}" WHERE uri = ?`,
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

  // ── Status / capabilities ────────────────────────────────────────

  status(): Promise<StatusResult> {
    try {
      this.executor.query("SELECT 1");
      return Promise.resolve({
        status: "healthy",
        message: "SQLite store is operational",
        schema: this._listProvisionedEntities().map((n) => `entity:${n}`),
        fns: ["read", "ls", "count"],
        details: { tablePrefix: this.tablePrefix },
      });
    } catch (error) {
      return Promise.resolve({
        status: "unhealthy",
        message: error instanceof Error ? error.message : String(error),
        schema: [],
        fns: ["read", "ls", "count"],
      });
    }
  }

  capabilities(): StoreCapabilities {
    return { atomicBatch: true };
  }

  // ── Internals ────────────────────────────────────────────────────

  private _readOne(
    meta: SqliteEntityMeta,
    uri: string,
  ): EntityRecord | undefined {
    try {
      if (meta.columns.length === 0) {
        // Empty schema: presence-only — return an empty record on hit.
        const res = this.executor.query(
          `SELECT 1 FROM "${meta.tableName}" WHERE uri = ?`,
          [uri],
        );
        return res.rows && res.rows.length > 0 ? {} : undefined;
      }
      const cols = meta.columns.map((c) => `"${c.name}"`).join(", ");
      const res = this.executor.query(
        `SELECT ${cols} FROM "${meta.tableName}" WHERE uri = ?`,
        [uri],
      );
      if (!res.rows || res.rows.length === 0) return undefined;
      return adaptRowForRead(meta, res.rows[0]);
    } catch {
      // `no such table` and other natural read failures surface as
      // misses — matches the convention that unprovisioned entities
      // read empty rather than throwing.
      return undefined;
    }
  }

  private _ls(
    meta: SqliteEntityMeta,
    parsed: ParsedUrl,
  ): Output<EntityRecord>[] | string[] {
    validateReadParams(parsed.params, STORE_NAME);
    const { params } = parsed;
    const format = params.format ?? "full";
    const cols = meta.columns.length > 0
      ? "uri, " + meta.columns.map((c) => `"${c.name}"`).join(", ")
      : "uri";
    const selectClause = format === "uris" ? "uri" : cols;
    // sortBy: "uri" sorts on the implicit URI column; any other value
    // must be a declared user field (validated against meta.declared
    // to keep the column name out of arbitrary user input).
    const sortByCol = params.sortBy === "uri"
      ? "uri"
      : (params.sortBy !== undefined && meta.declared.has(params.sortBy)
        ? `"${params.sortBy}"`
        : "");
    const order = sortByCol
      ? ` ORDER BY ${sortByCol} ${params.sortOrder === "desc" ? "DESC" : "ASC"}`
      : "";
    // Base shallow-direct-leaves predicate. When `pattern` is set we
    // tighten it with an additional `LIKE prefix || patternBody ESCAPE`
    // clause that translates the URL-grammar glob (`*` → `%`,
    // `?` → `_`) into SQL LIKE syntax. When `cursor` is set we add
    // `uri > cursor` (or `<` for desc) so dispatch can skip its
    // post-filter.
    let sql =
      `SELECT ${selectClause} FROM "${meta.tableName}" WHERE uri LIKE ? || '%' AND uri NOT LIKE ? || '%/%'`;
    const args: unknown[] = [parsed.uri, parsed.uri];
    if (params.pattern !== undefined) {
      args.push(parsed.uri, patternToSqlLike(params.pattern));
      sql += ` AND uri LIKE ? || ? ESCAPE '\\'`;
    }
    if (params.cursor !== undefined) {
      args.push(params.cursor);
      const op = params.sortOrder === "desc" ? "<" : ">";
      sql += ` AND uri ${op} ?`;
    }
    sql += order;
    if (params.limit !== undefined) {
      const page = params.page ?? 1;
      sql += ` LIMIT ? OFFSET ?`;
      args.push(params.limit, (page - 1) * params.limit);
    }
    try {
      const res = this.executor.query(sql, args);
      const rows = (res.rows ?? []) as Array<Record<string, unknown>>;
      if (format === "uris") return rows.map((r) => r.uri as string);
      return rows.map((r): Output<EntityRecord> => [
        r.uri as string,
        adaptRowForRead(meta, r),
      ]);
    } catch {
      return format === "uris" ? [] : [];
    }
  }

  private _count(meta: SqliteEntityMeta, parsed: ParsedUrl): number {
    let sql =
      `SELECT COUNT(*) AS n FROM "${meta.tableName}" WHERE uri LIKE ? || '%' AND uri NOT LIKE ? || '%/%'`;
    const args: unknown[] = [parsed.uri, parsed.uri];
    if (parsed.params.pattern !== undefined) {
      args.push(parsed.uri, patternToSqlLike(parsed.params.pattern));
      sql += ` AND uri LIKE ? || ? ESCAPE '\\'`;
    }
    if (parsed.params.cursor !== undefined) {
      args.push(parsed.params.cursor);
      const op = parsed.params.sortOrder === "desc" ? "<" : ">";
      sql += ` AND uri ${op} ?`;
    }
    try {
      const res = this.executor.query(sql, args);
      const row = res.rows?.[0] as { n: number } | undefined;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Enumerate every `{tablePrefix}_*_data` table currently in the
   * database. Used by `status()` to advertise the entities a peer can
   * talk to without per-entity bookkeeping.
   */
  private _listProvisionedEntities(): string[] {
    const res = this.executor.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ? || '\\_%\\_data' ESCAPE '\\'`,
      [this.tablePrefix],
    );
    const out: string[] = [];
    for (const row of res.rows ?? []) {
      const name = (row as { name: string }).name;
      const suffix = "_data";
      const prefixWithU = `${this.tablePrefix}_`;
      if (!name.startsWith(prefixWithU) || !name.endsWith(suffix)) continue;
      out.push(name.slice(prefixWithU.length, name.length - suffix.length));
    }
    return out;
  }
}

// ── Adapters ────────────────────────────────────────────────────────

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

/** Coerce a record field value into something the SQLite driver will accept. */
function adaptForWrite(col: ColumnPlan, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (col.tag === TYPE_TAGS.JSON) {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  if (col.tag === TYPE_TAGS.TIMESTAMP) {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "number") return new Date(value).toISOString();
    return String(value);
  }
  if (col.tag === TYPE_TAGS.BOOLEAN) {
    return value ? 1 : 0;
  }
  if (col.tag === TYPE_TAGS.BIGINT) {
    // The injected sqlite executor may pass `bigint` through (e.g.
    // `@db/sqlite`) or require `number` (e.g. the structurally-typed
    // mock). Hand the value over unchanged for compatible drivers;
    // numbers within safe range pass too.
    return value;
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
    if (col.tag === TYPE_TAGS.BYTES) {
      rec[col.name] = rowToBytes(v);
    } else if (col.tag === TYPE_TAGS.JSON) {
      rec[col.name] = typeof v === "string" ? JSON.parse(v) : v;
    } else if (col.tag === TYPE_TAGS.TIMESTAMP) {
      rec[col.name] = v instanceof Date ? v : new Date(v as string);
    } else if (col.tag === TYPE_TAGS.BOOLEAN) {
      rec[col.name] = Boolean(v);
    } else if (col.tag === TYPE_TAGS.BIGINT) {
      // SQLite returns INTEGER as either JS `number` or `bigint`
      // depending on the driver. Normalise to `bigint` so callers
      // get a consistent shape regardless of the underlying driver.
      rec[col.name] = typeof v === "bigint" ? v : BigInt(v as number | string);
    } else rec[col.name] = v;
  }
  return rec;
}
