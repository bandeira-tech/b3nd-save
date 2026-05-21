/**
 * PostgresStore unit tests — runs the shared suite against an
 * in-memory mock executor that simulates Postgres BYTEA behavior.
 */

/// <reference lib="deno.ns" />

import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { PostgresStore } from "./store.ts";
import { BYTES_ENTITY } from "../entity.ts";
import type { SqlExecutor, SqlExecutorResult } from "./mod.ts";

/**
 * In-memory SQL executor that simulates the subset of Postgres
 * behavior `PostgresStore` relies on. BYTEA columns round-trip as
 * Uint8Array.
 */
function createMockSqlExecutor(): SqlExecutor {
  const data = new Map<string, { uri: string; payload: Uint8Array }>();
  const provisioned = new Set<string>();

  const executor: SqlExecutor = {
    query: (
      sql: string,
      args?: unknown[],
    ): Promise<SqlExecutorResult> => {
      const trimmed = sql.trim();
      const upper = trimmed.toUpperCase();

      // DDL — remember which tables exist so entityStatus reports live.
      if (upper.startsWith("CREATE")) {
        const m = trimmed.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
        if (m) provisioned.add(m[1]);
        return Promise.resolve({ rows: [] });
      }

      // entityStatus probe via information_schema.
      if (upper.includes("INFORMATION_SCHEMA.COLUMNS")) {
        const table = args![0] as string;
        if (!provisioned.has(table)) return Promise.resolve({ rows: [] });
        // BYTES_ENTITY's only user column is `payload BYTEA`.
        return Promise.resolve({
          rows: [{ column_name: "payload", data_type: "bytea" }],
        });
      }

      // Health
      if (upper === "SELECT 1") {
        return Promise.resolve({ rows: [{ "?column?": 1 }] });
      }

      // Upsert: INSERT INTO X (uri, payload) VALUES ($1, $2) ON CONFLICT ...
      if (upper.startsWith("INSERT")) {
        const uri = args![0] as string;
        const payload = args![1] as Uint8Array;
        data.set(uri, { uri, payload });
        return Promise.resolve({ rows: [], rowCount: 1 });
      }

      // Count: SELECT COUNT(*)::int AS n FROM X WHERE uri LIKE $1 || '%' AND uri NOT LIKE $1 || '%/%'
      if (upper.startsWith("SELECT COUNT(")) {
        const prefix = args![0] as string;
        const n = [...data.values()].filter((r) =>
          r.uri.startsWith(prefix) && !r.uri.slice(prefix.length).includes("/")
        ).length;
        return Promise.resolve({ rows: [{ n }] });
      }

      // ls: SELECT [uri | uri, payload] FROM X WHERE uri LIKE $1 || '%' AND uri NOT LIKE $1 || '%/%' [ORDER BY uri [DESC]] [LIMIT $n OFFSET $m]
      if (upper.includes("LIKE") && upper.includes("NOT LIKE")) {
        const prefix = args![0] as string;
        let rows = [...data.values()].filter((r) =>
          r.uri.startsWith(prefix) && !r.uri.slice(prefix.length).includes("/")
        );

        if (upper.includes("ORDER BY URI")) {
          const desc = upper.includes(" DESC");
          rows = rows.sort((a, b) =>
            desc ? b.uri.localeCompare(a.uri) : a.uri.localeCompare(b.uri)
          );
        }

        // LIMIT $n OFFSET $m — args[1] and args[2] when present
        if (upper.includes("LIMIT")) {
          const limit = args![1] as number;
          const offset = (args![2] as number) ?? 0;
          rows = rows.slice(offset, offset + limit);
        }

        const selectsPayload = /SELECT\s+URI\s*,\s*PAYLOAD/.test(upper);
        return Promise.resolve({
          rows: rows.map((r) =>
            selectsPayload ? { uri: r.uri, payload: r.payload } : { uri: r.uri }
          ),
        });
      }

      // Point read: SELECT payload FROM X WHERE uri = $1
      if (upper.startsWith("SELECT") && upper.includes("WHERE URI = $1")) {
        const uri = args![0] as string;
        const row = data.get(uri);
        if (!row) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [{ payload: row.payload }] });
      }

      // Delete
      if (upper.startsWith("DELETE")) {
        const uri = args![0] as string;
        data.delete(uri);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }

      return Promise.resolve({ rows: [] });
    },

    transaction: async <T>(
      fn: (tx: SqlExecutor) => Promise<T>,
    ): Promise<T> => {
      return await fn(executor);
    },
  };

  return executor;
}

runSharedStoreSuite("PostgresStore", {
  create: () => new PostgresStore("test", createMockSqlExecutor()),
});

import { assertEquals } from "jsr:@std/assert";

Deno.test("PostgresStore - atomicBatch: write rolls back on per-entry failure", async () => {
  // Executor that throws on the second INSERT to simulate a mid-batch
  // failure. The transaction wrapper should roll back and surface
  // failure for every entry in the batch.
  let inserts = 0;
  const executor: SqlExecutor = {
    query: (sql: string) => {
      const upper = sql.trim().toUpperCase();
      if (upper.startsWith("INSERT")) {
        inserts++;
        if (inserts === 2) throw new Error("boom on entry 2");
      }
      return Promise.resolve({ rows: [] });
    },
    transaction: async <T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> => {
      // Real Postgres would roll back; the mock just propagates the
      // throw — which is enough to verify the store's failure path.
      return await fn(executor);
    },
  };
  const store = new PostgresStore("test", executor);
  // entitySupport is pure — skip provisionEntity for this test since
  // the boom executor doesn't simulate information_schema lookups.
  const meta = store.entitySupport(BYTES_ENTITY);
  const results = await store.write(meta, [
    { uri: "store://a", record: { payload: new Uint8Array([1]) } },
    { uri: "store://b", record: { payload: new Uint8Array([2]) } },
    { uri: "store://c", record: { payload: new Uint8Array([3]) } },
  ]);
  assertEquals(results.length, 3);
  // All entries fail with the same error — that's the atomic contract.
  assertEquals(results.every((r) => !r.success), true);
  assertEquals(results.every((r) => r.error === "boom on entry 2"), true);
  // Structured error mirrors the string with a STORAGE_ERROR code.
  assertEquals(
    results.every((r) =>
      r.errorDetail?.code === "STORAGE_ERROR" &&
      r.errorDetail.message === "boom on entry 2"
    ),
    true,
  );
});

Deno.test("PostgresStore - empty batch returns empty results", async () => {
  const store = new PostgresStore("test", createMockSqlExecutor());
  const meta = store.entitySupport(BYTES_ENTITY);
  assertEquals(await store.write(meta, []), []);
  assertEquals(await store.delete(meta, []), []);
});
