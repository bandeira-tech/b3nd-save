/**
 * SqliteStore unit tests — runs the shared suite against an in-memory
 * mock that simulates SQLite BLOB column behavior.
 */

/// <reference lib="deno.ns" />

import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { SqliteStore } from "./store.ts";
import { BYTES_ENTITY } from "../entity.ts";
import type { SqliteExecutor, SqliteExecutorResult } from "./mod.ts";

function createMockSqliteExecutor(): SqliteExecutor {
  const data = new Map<string, { uri: string; payload: Uint8Array }>();

  const executor: SqliteExecutor = {
    query: (sql: string, args?: unknown[]): SqliteExecutorResult => {
      const trimmed = sql.trim();
      const upper = trimmed.toUpperCase();

      if (upper.startsWith("CREATE")) return { rows: [] };
      if (upper === "SELECT 1") return { rows: [{ "1": 1 }] };

      if (upper.startsWith("INSERT")) {
        const uri = args![0] as string;
        const payload = args![1] as Uint8Array;
        data.set(uri, { uri, payload });
        return { rows: [], rowCount: 1 };
      }

      // Count: SELECT COUNT(*) AS n FROM X WHERE uri LIKE ? || '%' AND uri NOT LIKE ? || '%/%'
      if (upper.startsWith("SELECT COUNT(")) {
        const prefix = args![0] as string;
        const n = [...data.values()].filter((r) =>
          r.uri.startsWith(prefix) && !r.uri.slice(prefix.length).includes("/")
        ).length;
        return { rows: [{ n }] };
      }

      // ls: SELECT [uri | uri, payload] FROM X WHERE uri LIKE ? || '%' AND uri NOT LIKE ? || '%/%' [ORDER BY] [LIMIT/OFFSET]
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

        if (upper.includes("LIMIT")) {
          // args: [prefix, prefix, limit, offset]
          const limit = args![2] as number;
          const offset = (args![3] as number) ?? 0;
          rows = rows.slice(offset, offset + limit);
        }

        const selectsPayload = /SELECT\s+URI\s*,\s*PAYLOAD/.test(upper);
        return {
          rows: rows.map((r) =>
            selectsPayload ? { uri: r.uri, payload: r.payload } : { uri: r.uri }
          ),
        };
      }

      if (upper.startsWith("SELECT") && upper.includes("WHERE URI = ?")) {
        const uri = args![0] as string;
        const row = data.get(uri);
        if (!row) return { rows: [] };
        return { rows: [{ payload: row.payload }] };
      }

      if (upper.startsWith("DELETE")) {
        const uri = args![0] as string;
        data.delete(uri);
        return { rows: [], rowCount: 1 };
      }

      return { rows: [] };
    },

    transaction: <T>(fn: (tx: SqliteExecutor) => T): T => fn(executor),
  };

  return executor;
}

runSharedStoreSuite("SqliteStore", {
  create: () => new SqliteStore("test", createMockSqliteExecutor()),
});

import { assertEquals } from "jsr:@std/assert";

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

Deno.test(
  "SqliteStore - status reports `entity:<name>` per provisioned schema",
  async () => {
    const store = new SqliteStore("test", createMockSqliteExecutor());

    // Pre-provision: nothing has been provisioned yet.
    const before = await store.status();
    assertEquals(before.schema, []);

    // After provisioning BYTES_ENTITY the name should appear.
    await store.provisionEntity(store.entitySupport(BYTES_ENTITY));
    const after = await store.status();
    assertEquals(after.schema, [`entity:${BYTES_ENTITY.name}`]);

    // Idempotent — provisioning twice doesn't duplicate.
    await store.provisionEntity(store.entitySupport(BYTES_ENTITY));
    const again = await store.status();
    assertEquals(again.schema, [`entity:${BYTES_ENTITY.name}`]);
  },
);

Deno.test(
  "SqliteStore - status omits unsupported schemas (BYTES_ENTITY only)",
  async () => {
    const store = new SqliteStore("test", createMockSqliteExecutor());
    // A non-bytes schema is silently un-provisioned at the storage
    // layer (the shim returns per-entry failures on write). It must
    // NOT appear in status.schema — otherwise callers would think
    // they could read/write through it.
    const fake = { name: "fake", fields: [{ name: "x", type: ["string"] }] };
    await store.provisionEntity(store.entitySupport(fake));
    const status = await store.status();
    assertEquals(status.schema, []);
  },
);
