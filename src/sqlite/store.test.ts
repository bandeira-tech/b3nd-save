/**
 * SqliteStore unit tests — runs the shared suite against an in-memory
 * mock that simulates SQLite per-entity tables. The mock handles the
 * subset of SQL the store emits: `pragma_table_info`, `CREATE TABLE
 * IF NOT EXISTS`, `INSERT … ON CONFLICT`, point/`LIKE` reads,
 * `COUNT(*)`, and `DELETE`.
 */

/// <reference lib="deno.ns" />

import { assertEquals } from "jsr:@std/assert";
import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { SqliteStore } from "./store.ts";
import { BYTES_ENTITY } from "../entity.ts";
import type { SqliteExecutor, SqliteExecutorResult } from "./mod.ts";

interface MockTable {
  /** Declared column types, in declared order, including built-ins. */
  columns: { name: string; type: string }[];
  /** Rows keyed by uri. */
  rows: Map<string, Record<string, unknown>>;
}

function parseCreateTable(
  sql: string,
): { table: string; columns: { name: string; type: string }[] } | null {
  const m = sql.match(
    /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\(([\s\S]*)\)/i,
  );
  if (!m) return null;
  const [, table, body] = m;
  // Body is comma-separated column DDLs. Naive parse: split on top-level
  // commas (the store never nests parens in column DDLs).
  const columns = body
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((decl) => {
      // `"name" TYPE …` or `name TYPE …`
      const cm = decl.match(/^"?(\w+)"?\s+(\w+)/);
      if (!cm) throw new Error(`mock: unparseable column decl: ${decl}`);
      return { name: cm[1], type: cm[2].toUpperCase() };
    });
  return { table, columns };
}

function parseInsert(sql: string): {
  table: string;
  columns: string[];
} | null {
  const m = sql.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)/i);
  if (!m) return null;
  const [, table, cols] = m;
  const columns = cols.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
  return { table, columns };
}

function tableFromFromClause(sql: string): string | null {
  const m = sql.match(/FROM\s+(\w+)/i);
  return m ? m[1] : null;
}

function createMockSqliteExecutor(): SqliteExecutor {
  const tables = new Map<string, MockTable>();

  const exec = (sql: string, args: unknown[] = []): SqliteExecutorResult => {
    const trimmed = sql.trim();
    const upper = trimmed.toUpperCase();

    if (upper === "SELECT 1") return { rows: [{ "1": 1 }] };

    // pragma_table_info: introspection probe driven by entityStatus.
    if (/PRAGMA_TABLE_INFO/i.test(trimmed)) {
      const name = args[0] as string;
      const t = tables.get(name);
      if (!t) return { rows: [] };
      return { rows: t.columns.map((c) => ({ ...c })) };
    }

    if (/^CREATE\s+TABLE/i.test(trimmed)) {
      const parsed = parseCreateTable(trimmed);
      if (parsed && !tables.has(parsed.table)) {
        tables.set(parsed.table, {
          columns: parsed.columns,
          rows: new Map(),
        });
      }
      return { rows: [] };
    }
    if (/^CREATE\s+INDEX/i.test(trimmed)) return { rows: [] };

    if (/^INSERT/i.test(trimmed)) {
      const parsed = parseInsert(trimmed);
      if (!parsed) throw new Error(`mock: bad INSERT: ${trimmed}`);
      const table = tables.get(parsed.table);
      if (!table) throw new Error(`no such table: ${parsed.table}`);
      const row: Record<string, unknown> = {};
      parsed.columns.forEach((c, i) => (row[c] = args[i]));
      const uri = row.uri as string;
      table.rows.set(uri, row);
      return { rows: [], rowCount: 1 };
    }

    if (/^DELETE/i.test(trimmed)) {
      const t = tableFromFromClause(trimmed) ??
        trimmed.match(/DELETE\s+FROM\s+(\w+)/i)?.[1] ?? null;
      if (!t) throw new Error(`mock: bad DELETE: ${trimmed}`);
      const table = tables.get(t);
      if (!table) throw new Error(`no such table: ${t}`);
      table.rows.delete(args[0] as string);
      return { rows: [], rowCount: 1 };
    }

    if (/^SELECT/i.test(trimmed)) {
      const t = tableFromFromClause(trimmed);
      if (!t) throw new Error(`mock: bad SELECT: ${trimmed}`);
      const table = tables.get(t);
      if (!table) throw new Error(`no such table: ${t}`);

      // COUNT
      if (/SELECT\s+COUNT/i.test(trimmed)) {
        const prefix = args[0] as string;
        const n = [...table.rows.values()].filter((r) => {
          const u = r.uri as string;
          return u.startsWith(prefix) && !u.slice(prefix.length).includes("/");
        }).length;
        return { rows: [{ n }] };
      }

      // ls (LIKE + NOT LIKE), with optional ORDER BY uri / LIMIT / OFFSET.
      if (/LIKE\s*\?\s*\|\|\s*'%'/i.test(trimmed)) {
        const prefix = args[0] as string;
        let rows = [...table.rows.values()].filter((r) => {
          const u = r.uri as string;
          return u.startsWith(prefix) && !u.slice(prefix.length).includes("/");
        });
        if (/ORDER\s+BY\s+URI/i.test(trimmed)) {
          const desc = /ORDER\s+BY\s+URI\s+DESC/i.test(trimmed);
          rows = rows.sort((a, b) => {
            const cmp = (a.uri as string).localeCompare(b.uri as string);
            return desc ? -cmp : cmp;
          });
        }
        if (/LIMIT\s+\?/i.test(trimmed)) {
          const limit = args[2] as number;
          const offset = (args[3] as number) ?? 0;
          rows = rows.slice(offset, offset + limit);
        }
        const selectsOnlyUri = /^SELECT\s+URI\s+FROM/i.test(trimmed);
        if (selectsOnlyUri) {
          return { rows: rows.map((r) => ({ uri: r.uri })) };
        }
        return { rows: rows.map((r) => ({ ...r })) };
      }

      // Point read: SELECT … FROM t WHERE uri = ?
      if (/WHERE\s+URI\s*=\s*\?/i.test(trimmed)) {
        const uri = args[0] as string;
        const row = table.rows.get(uri);
        if (!row) return { rows: [] };
        return { rows: [{ ...row }] };
      }

      throw new Error(`mock: unsupported SELECT: ${trimmed}`);
    }

    return { rows: [] };
  };

  const executor: SqliteExecutor = {
    query: (sql, args) => exec(sql, args),
    transaction: <T>(fn: (tx: SqliteExecutor) => T): T => fn(executor),
  };

  return executor;
}

runSharedStoreSuite("SqliteStore", {
  create: () => new SqliteStore("test", createMockSqliteExecutor()),
});

Deno.test("SqliteStore - atomicBatch: write rolls back on per-entry failure", async () => {
  // Executor that throws on the second INSERT to simulate a mid-batch
  // failure. The transaction wrapper should surface failure for every
  // entry in the batch.
  let inserts = 0;
  const executor: SqliteExecutor = {
    query: (sql: string): SqliteExecutorResult => {
      const upper = sql.trim().toUpperCase();
      if (upper.startsWith("INSERT")) {
        inserts++;
        if (inserts === 2) throw new Error("boom on entry 2");
      }
      return { rows: [] };
    },
    transaction: <T>(fn: (tx: SqliteExecutor) => T): T => fn(executor),
  };
  const store = new SqliteStore("test", executor);
  const meta = store.entitySupport(BYTES_ENTITY);
  const results = await store.write(meta, [
    { uri: "store://a", record: { payload: new Uint8Array([1]) } },
    { uri: "store://b", record: { payload: new Uint8Array([2]) } },
    { uri: "store://c", record: { payload: new Uint8Array([3]) } },
  ]);
  assertEquals(results.length, 3);
  assertEquals(results.every((r) => !r.success), true);
  assertEquals(results.every((r) => r.error === "boom on entry 2"), true);
});

Deno.test("SqliteStore - empty batch returns empty results", async () => {
  const store = new SqliteStore("test", createMockSqliteExecutor());
  const meta = store.entitySupport(BYTES_ENTITY);
  assertEquals(await store.write(meta, []), []);
  assertEquals(await store.delete(meta, []), []);
});
