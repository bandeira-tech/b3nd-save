/**
 * PostgresStore Integration Tests
 *
 * Runs the shared store suite against a real PostgreSQL database.
 * Requires a running Postgres instance — see CI workflow or:
 *   cd /Users/m0/ws/b3nd && make up p=test
 *
 * Env: POSTGRES_URL (default: postgresql://postgres:postgres@localhost:55432/b3nd_test)
 */

/// <reference lib="deno.ns" />

import { assert, assertEquals } from "@std/assert";
import { Client } from "pg";
import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { PostgresStore } from "./store.ts";
import { type EntityRecord, type EntitySchema, TYPE_TAGS } from "../entity.ts";
import type { SqlExecutor, SqlExecutorResult } from "./mod.ts";

const TABLE_PREFIX = "inttest";
const POSTGRES_URL = Deno.env.get("POSTGRES_URL") ??
  "postgresql://postgres:postgres@localhost:55432/b3nd_test";

let client: Client;

async function createPostgresExecutor(): Promise<SqlExecutor> {
  client = new Client(POSTGRES_URL);
  await client.connect();

  const executor: SqlExecutor = {
    async query(sql: string, args?: unknown[]): Promise<SqlExecutorResult> {
      // deno-lint-ignore no-explicit-any
      const res = await client.query(sql, args as any[]);
      return { rows: res.rows as unknown[], rowCount: res.rowCount ?? 0 };
    },
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      await client.query("BEGIN");
      try {
        const txExecutor: SqlExecutor = {
          query: async (sql, args) => {
            // deno-lint-ignore no-explicit-any
            const res = await client.query(sql, args as any[]);
            return {
              rows: res.rows as unknown[],
              rowCount: res.rowCount ?? 0,
            };
          },
          transaction: () => {
            throw new Error("Nested transactions not supported");
          },
        };
        const result = await fn(txExecutor);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },
  };

  return executor;
}

runSharedStoreSuite("PostgresStore (integration)", {
  create: async () => {
    const executor = await createPostgresExecutor();
    // Drop the bytes-entity table so each test run starts clean.
    // `ensureEntity` will recreate it via `IF NOT EXISTS`.
    await executor.query(
      `DROP TABLE IF EXISTS ${TABLE_PREFIX}_bytes_data CASCADE`,
    );
    return new PostgresStore(TABLE_PREFIX, executor);
  },
});

// ── Native entity tables ──────────────────────────────────────────

const userSchema: EntitySchema = {
  name: "users",
  fields: [
    { name: "name", type: [TYPE_TAGS.STRING] },
    { name: "age", type: [TYPE_TAGS.NUMBER] },
    { name: "active", type: [TYPE_TAGS.BOOLEAN] },
    { name: "extras", type: [TYPE_TAGS.JSON] },
    { name: "avatar", type: [TYPE_TAGS.BYTES] },
  ],
};

const postSchema: EntitySchema = {
  name: "posts",
  fields: [
    { name: "title", type: [TYPE_TAGS.STRING] },
    { name: "stars", type: [TYPE_TAGS.BIGINT] },
  ],
};

async function freshEntityStore(): Promise<PostgresStore> {
  const executor = await createPostgresExecutor();
  await executor.query(
    `DROP TABLE IF EXISTS ${TABLE_PREFIX}_users_data CASCADE`,
  );
  await executor.query(
    `DROP TABLE IF EXISTS ${TABLE_PREFIX}_posts_data CASCADE`,
  );
  return new PostgresStore(TABLE_PREFIX, executor);
}

Deno.test({
  name:
    "PostgresStore (integration) - ensureEntity provisions a per-entity table",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = await freshEntityStore();
    const support = await store.ensureEntity(userSchema);
    assertEquals(support.entity, "users");
    assertEquals(support.unsupported, []);
    assertEquals(
      support.supported.sort(),
      ["active", "age", "avatar", "extras", "name"],
    );
    const cols = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = $1 ORDER BY ordinal_position`,
      [`${TABLE_PREFIX}_users_data`],
    );
    const byName = Object.fromEntries(
      cols.rows.map((r: { column_name: string; data_type: string }) => [
        r.column_name,
        r.data_type,
      ]),
    );
    assertEquals(byName.uri, "text");
    assertEquals(byName.name, "text");
    assertEquals(byName.age, "double precision");
    assertEquals(byName.active, "boolean");
    assertEquals(byName.extras, "jsonb");
    assertEquals(byName.avatar, "bytea");
  },
});

Deno.test({
  name:
    "PostgresStore (integration) - write/read round-trip on a custom entity",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = await freshEntityStore();
    await store.ensureEntity(userSchema);
    const avatar = new Uint8Array([1, 2, 3, 4, 5]);
    const [w] = await store.write(userSchema, [
      {
        uri: "data://users/alice",
        record: {
          name: "Alice",
          age: 30,
          active: true,
          extras: { tags: ["admin"], lastSeen: "2024-01-02" },
          avatar,
        },
      },
    ]);
    assertEquals(w.success, true);

    const [[, rec]] = await store.read(userSchema, ["data://users/alice"]);
    const r = rec as EntityRecord;
    assertEquals(r.name, "Alice");
    assertEquals(r.age, 30);
    assertEquals(r.active, true);
    assertEquals(r.extras, { tags: ["admin"], lastSeen: "2024-01-02" });
    assert(r.avatar instanceof Uint8Array);
    assertEquals(Array.from(r.avatar as Uint8Array), [1, 2, 3, 4, 5]);
  },
});

Deno.test({
  name: "PostgresStore (integration) - strict validation rejects extra fields",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = await freshEntityStore();
    await store.ensureEntity(userSchema);
    const [r] = await store.write(userSchema, [{
      uri: "data://users/x",
      record: { name: "X", age: 0, mystery: "not declared" } as EntityRecord,
    }]);
    assertEquals(r.success, false);
    assert(r.error?.includes("not declared"));
    assertEquals(r.errorDetail?.uri, "data://users/x");
  },
});

Deno.test({
  name: "PostgresStore (integration) - ls/count on a custom entity",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = await freshEntityStore();
    await store.ensureEntity(postSchema);
    await store.write(postSchema, [
      { uri: "data://posts/a", record: { title: "A", stars: 1n } },
      { uri: "data://posts/b", record: { title: "B", stars: 2n } },
      { uri: "data://posts/sub/deep", record: { title: "deep", stars: 9n } },
    ]);
    const [[, count]] = await store.read<number>(postSchema, [
      "data://posts/?fn=count",
    ]);
    assertEquals(count, 2);
    const [[, uris]] = await store.read<string[]>(postSchema, [
      "data://posts/?fn=ls&format=uris&sortBy=uri",
    ]);
    assertEquals(uris, ["data://posts/a", "data://posts/b"]);
    const [[, children]] = await store.read<Array<[string, EntityRecord]>>(
      postSchema,
      ["data://posts/?fn=ls&sortBy=uri"],
    );
    const recs = children;
    assertEquals(recs.map(([u]) => u), [
      "data://posts/a",
      "data://posts/b",
    ]);
    assertEquals(recs[0][1].title, "A");
  },
});

Deno.test({
  name: "PostgresStore (integration) - delete removes from the entity table",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = await freshEntityStore();
    await store.ensureEntity(userSchema);
    await store.write(userSchema, [{
      uri: "data://users/del",
      record: {
        name: "Del",
        age: 1,
        active: true,
        extras: {},
        avatar: new Uint8Array(0),
      },
    }]);
    const [d] = await store.delete(userSchema, ["data://users/del"]);
    assertEquals(d.success, true);
    const [[, rec]] = await store.read(userSchema, ["data://users/del"]);
    assertEquals(rec, undefined);
  },
});

Deno.test({
  name:
    "PostgresStore (integration) - unsupported tags surface in EntitySupport",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = await freshEntityStore();
    const support = await store.ensureEntity({
      name: "weird",
      fields: [
        { name: "ok", type: [TYPE_TAGS.STRING] },
        { name: "money", type: ["some-protocol/money"] },
      ],
    });
    assertEquals(support.supported, ["ok"]);
    assertEquals(support.unsupported.map((u) => u.name), ["money"]);
    // Clean up the throwaway table.
    await client.query(`DROP TABLE IF EXISTS ${TABLE_PREFIX}_weird_data`);
  },
});

// Cleanup after all tests
Deno.test({
  name: "PostgresStore (integration) - cleanup",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    try {
      await client.query(
        `DROP TABLE IF EXISTS ${TABLE_PREFIX}_bytes_data CASCADE`,
      );
      await client.query(
        `DROP TABLE IF EXISTS ${TABLE_PREFIX}_users_data CASCADE`,
      );
      await client.query(
        `DROP TABLE IF EXISTS ${TABLE_PREFIX}_posts_data CASCADE`,
      );
    } finally {
      await client.end();
    }
  },
});
