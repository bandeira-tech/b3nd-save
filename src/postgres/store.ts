/**
 * PostgresStore — PostgreSQL implementation of `EntityStore`.
 *
 * One layout for every schema: `{prefix}_{entity}_data` with `uri TEXT
 * PRIMARY KEY` and one column per supported field, typed by the
 * canonical `TYPE_TAGS` it carries (see `./columns.ts`). `BYTES_ENTITY`
 * is just an entity with one `payload BYTEA` column — no legacy
 * special case.
 *
 * `ensureEntity` is idempotent and runs the `CREATE TABLE IF NOT
 * EXISTS` once per schema; the per-entity metadata is cached so
 * subsequent writes/reads don't pay the round-trip.
 *
 * `fn=ls` / `fn=count` push down to SQL — the shallow-direct-leaves
 * predicate (`uri LIKE prefix% AND uri NOT LIKE prefix%/%`) is
 * enforced in the WHERE clause against the entity's table.
 *
 * Writes are wrapped in a transaction (`capabilities.atomicBatch =
 * true`). Stream-shaped values on `BYTEA` columns are collected to
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
import type { EntityRecord, EntitySchema, EntitySupport } from "../entity.ts";
import type { StoreCapabilities, StoreWriteResult } from "../types.ts";
import { type ColumnPlan, planColumns } from "./columns.ts";
import type { SqlExecutor } from "./mod.ts";

const STORE_NAME = "PostgresStore";

const TABLE_PREFIX = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** Cached metadata for a provisioned entity. */
interface EntityMeta {
  tableName: string;
  columns: ColumnPlan[];
  declared: ReadonlySet<string>;
  bytesColumns: ReadonlySet<string>;
  support: EntitySupport;
}

/** Coerce a pg `bytea` row value into a `Uint8Array`. */
function rowToBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string" && value.startsWith("\\x")) {
    const hex = value.slice(2);
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
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

export class PostgresStore implements EntityStore {
  private readonly tablePrefix: string;
  private readonly executor: SqlExecutor;
  private readonly entities = new Map<string, EntityMeta>();

  constructor(tablePrefix: string, executor: SqlExecutor) {
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

  // ── EntityStore surface ──────────────────────────────────────────

  async ensureEntity(schema: EntitySchema): Promise<EntitySupport> {
    const cached = this.entities.get(schema.name);
    if (cached) return cached.support;

    const { columns, unsupported } = planColumns(schema.fields);
    const tableName = entityTableName(this.tablePrefix, schema.name);
    const colDdl = columns
      .map((c) => `"${c.name}" ${c.sqlType}`)
      .join(",\n  ");
    const sql = `CREATE TABLE IF NOT EXISTS ${tableName} (
  uri TEXT PRIMARY KEY${columns.length > 0 ? ",\n  " + colDdl : ""},
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_${tableName}_uri ON ${tableName} (uri);`;
    await this.executor.query(sql);

    const meta: EntityMeta = {
      tableName,
      columns,
      declared: new Set(columns.map((c) => c.name)),
      bytesColumns: new Set(
        columns.filter((c) => c.sqlType === "BYTEA").map((c) => c.name),
      ),
      support: {
        entity: schema.name,
        supported: columns.map((c) => c.name),
        unsupported,
      },
    };
    this.entities.set(schema.name, meta);
    return meta.support;
  }

  async write(
    schema: EntitySchema,
    entries: { uri: string; record: EntityRecord }[],
  ): Promise<StoreWriteResult[]> {
    if (entries.length === 0) return [];
    const meta = await this._meta(schema);
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
              `${STORE_NAME}: record contains keys not declared in schema '${schema.name}': ${
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
    const placeholders = cols.map((_, i) => `$${i + 2}`).join(", ");
    const updates = cols
      .map((c) => `"${c.name}" = EXCLUDED."${c.name}"`)
      .concat(["updated_at = CURRENT_TIMESTAMP"])
      .join(", ");

    try {
      await this.executor.transaction(async (tx) => {
        for (const { uri, record } of accepted) {
          const args: unknown[] = [uri];
          for (const c of cols) args.push(adaptForWrite(c, record[c.name]));
          await tx.query(
            `INSERT INTO ${meta.tableName} (uri${
              colList ? ", " + colList : ""
            }) VALUES ($1${placeholders ? ", " + placeholders : ""})
             ON CONFLICT (uri) DO UPDATE SET ${updates}`,
            args,
          );
        }
      });
      for (const { idx } of accepted) out[idx] = { success: true };
      return out;
    } catch (err) {
      // Atomic batch failure — every accepted entry shares the same failure.
      const failure = storageFailure(err, "Write failed");
      for (const { idx } of accepted) out[idx] = { success: false, ...failure };
      return out;
    }
  }

  read<T = EntityRecord | undefined>(
    schema: EntitySchema,
    urls: string[],
  ): Promise<Output<T>[]> {
    return dispatchRead<T>(urls, STORE_NAME, {
      read: async (p) => {
        const meta = await this._meta(schema);
        return this._readOne(meta, p.uri);
      },
      ls: async (p) => {
        const meta = await this._meta(schema);
        return this._ls(meta, p);
      },
      count: async (p) => {
        const meta = await this._meta(schema);
        return this._count(meta, p);
      },
    });
  }

  async delete(
    schema: EntitySchema,
    uris: string[],
  ): Promise<DeleteResult[]> {
    if (uris.length === 0) return [];
    const meta = await this._meta(schema);
    try {
      await this.executor.transaction(async (tx) => {
        for (const uri of uris) {
          await tx.query(
            `DELETE FROM ${meta.tableName} WHERE uri = $1`,
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

  async status(): Promise<StatusResult> {
    try {
      await this.executor.query("SELECT 1");
      return {
        status: "healthy",
        message: "PostgreSQL store is operational",
        fns: ["read", "ls", "count"],
        details: { tablePrefix: this.tablePrefix },
      };
    } catch (error) {
      return {
        status: "unhealthy",
        message: `PostgreSQL health check failed: ${
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

  private async _meta(schema: EntitySchema): Promise<EntityMeta> {
    const cached = this.entities.get(schema.name);
    if (cached) return cached;
    await this.ensureEntity(schema);
    return this.entities.get(schema.name)!;
  }

  private async _readOne(
    meta: EntityMeta,
    uri: string,
  ): Promise<EntityRecord | undefined> {
    if (meta.columns.length === 0) {
      // Empty schema: presence-only — return an empty record on hit.
      const res = await this.executor.query(
        `SELECT 1 FROM ${meta.tableName} WHERE uri = $1`,
        [uri],
      );
      return res.rows && res.rows.length > 0 ? {} : undefined;
    }
    const cols = meta.columns.map((c) => `"${c.name}"`).join(", ");
    const res = await this.executor.query(
      `SELECT ${cols} FROM ${meta.tableName} WHERE uri = $1`,
      [uri],
    );
    if (!res.rows || res.rows.length === 0) return undefined;
    return adaptRowForRead(meta, res.rows[0] as Record<string, unknown>);
  }

  private async _ls(
    meta: EntityMeta,
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
      `SELECT ${selectClause} FROM ${meta.tableName} WHERE uri LIKE $1 || '%' AND uri NOT LIKE $1 || '%/%'${order}`;
    const args: unknown[] = [parsed.uri];
    if (params.limit !== undefined) {
      const page = params.page ?? 1;
      args.push(params.limit, (page - 1) * params.limit);
      sql += ` LIMIT $${args.length - 1} OFFSET $${args.length}`;
    }
    const res = await this.executor.query(sql, args);
    const rows = (res.rows ?? []) as Array<Record<string, unknown>>;
    if (format === "uris") return rows.map((r) => r.uri as string);
    return rows.map((r): Output => [
      r.uri as string,
      adaptRowForRead(meta, r),
    ]);
  }

  private async _count(meta: EntityMeta, parsed: ParsedUrl): Promise<number> {
    if (parsed.params.pattern !== undefined) {
      throw new Error(`${STORE_NAME}: pattern filter not supported`);
    }
    const res = await this.executor.query(
      `SELECT COUNT(*)::int AS n FROM ${meta.tableName} WHERE uri LIKE $1 || '%' AND uri NOT LIKE $1 || '%/%'`,
      [parsed.uri],
    );
    const row = res.rows?.[0] as { n: number } | undefined;
    return row?.n ?? 0;
  }
}

/**
 * Collect any `ReadableStream` values on `BYTEA` columns into
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
  if (col.sqlType === "JSONB") {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  if (col.sqlType === "TIMESTAMPTZ") {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "number") return new Date(value).toISOString();
    return value;
  }
  return value;
}

/** Reconstruct an EntityRecord from a Postgres row. */
function adaptRowForRead(
  meta: EntityMeta,
  row: Record<string, unknown>,
): EntityRecord {
  const rec: EntityRecord = {};
  for (const col of meta.columns) {
    const v = row[col.name];
    if (v === null || v === undefined) {
      rec[col.name] = undefined;
      continue;
    }
    if (col.sqlType === "BYTEA") rec[col.name] = rowToBytes(v);
    else if (col.sqlType === "JSONB") {
      rec[col.name] = typeof v === "string" ? JSON.parse(v) : v;
    } else if (col.sqlType === "TIMESTAMPTZ") {
      rec[col.name] = v instanceof Date ? v : new Date(v as string);
    } else rec[col.name] = v;
  }
  return rec;
}
