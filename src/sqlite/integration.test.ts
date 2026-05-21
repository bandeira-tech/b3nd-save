/**
 * SqliteStore Integration Tests
 *
 * Runs the shared store suite against a real SQLite database (in-memory).
 * No external service needed — uses @db/sqlite with :memory:.
 */

/// <reference lib="deno.ns" />

import { assert, assertEquals, assertRejects } from "@std/assert";
import { type BindValue, Database } from "@db/sqlite";
import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { SqliteStore } from "./store.ts";
import { type EntityRecord, type EntitySchema, TYPE_TAGS } from "../entity.ts";
import type { SqliteExecutor, SqliteExecutorResult } from "./mod.ts";

const TABLE_PREFIX = "inttest";

function createSqliteExecutor(): { executor: SqliteExecutor; db: Database } {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL");

  const executor: SqliteExecutor = {
    query(sql: string, args?: unknown[]): SqliteExecutorResult {
      const stmt = db.prepare(sql);
      const isQuery = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(sql);

      if (isQuery) {
        const rows = stmt.all(...((args ?? []) as BindValue[])) as Record<
          string,
          unknown
        >[];
        return { rows, rowCount: rows.length };
      } else {
        stmt.run(...((args ?? []) as BindValue[]));
        return { rows: [], rowCount: db.changes };
      }
    },

    transaction<T>(fn: (tx: SqliteExecutor) => T): T {
      let result: T;
      db.exec("BEGIN");
      try {
        const txExecutor: SqliteExecutor = {
          query(sql: string, args?: unknown[]): SqliteExecutorResult {
            const stmt = db.prepare(sql);
            const isQuery = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(sql);
            if (isQuery) {
              const rows = stmt.all(
                ...((args ?? []) as BindValue[]),
              ) as Record<string, unknown>[];
              return { rows, rowCount: rows.length };
            } else {
              stmt.run(...((args ?? []) as BindValue[]));
              return { rows: [], rowCount: db.changes };
            }
          },
          transaction: () => {
            throw new Error("Nested transactions not supported");
          },
        };
        result = fn(txExecutor);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return result;
    },

    cleanup() {
      db.close();
    },
  };

  return { executor, db };
}

runSharedStoreSuite("SqliteStore (integration)", {
  create: () => {
    const { executor } = createSqliteExecutor();
    return new SqliteStore(TABLE_PREFIX, executor);
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

function freshEntityStore(): { store: SqliteStore; db: Database } {
  const { executor, db } = createSqliteExecutor();
  return { store: new SqliteStore(TABLE_PREFIX, executor), db };
}

Deno.test({
  name:
    "SqliteStore (integration) - provisionEntity provisions a per-entity table",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { store, db } = freshEntityStore();
    const meta = store.entitySupport(userSchema);
    assertEquals(meta.support.entity, "users");
    assertEquals(meta.support.unsupported, []);
    assertEquals(
      meta.support.supported.sort(),
      ["active", "age", "avatar", "extras", "name"],
    );
    await store.provisionEntity(meta);
    const rows = db.prepare(
      `SELECT name, type FROM pragma_table_info(?)`,
    ).all(`${TABLE_PREFIX}_users_data`) as Array<
      { name: string; type: string }
    >;
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.type]));
    assertEquals(byName.uri, "TEXT");
    assertEquals(byName.name, "TEXT");
    assertEquals(byName.age, "REAL");
    assertEquals(byName.active, "BOOLEAN");
    assertEquals(byName.extras, "JSON");
    assertEquals(byName.avatar, "BLOB");
    db.close();
  },
});

Deno.test({
  name:
    "SqliteStore (integration) - entitySupport is pure; entityStatus flips after provision",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { store, db } = freshEntityStore();
    const meta = store.entitySupport(userSchema);
    assertEquals(await store.entityStatus(meta), "unprovisioned");
    await store.provisionEntity(meta);
    assertEquals(await store.entityStatus(meta), "live");
    db.close();
  },
});

Deno.test({
  name:
    "SqliteStore (integration) - provisionEntity throws on same-name different-shape",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { store, db } = freshEntityStore();
    await store.provisionEntity(store.entitySupport(userSchema));
    await assertRejects(
      () =>
        store.provisionEntity(
          store.entitySupport({
            name: "users",
            fields: [{ name: "name", type: [TYPE_TAGS.STRING] }],
          }),
        ),
      Error,
      "different shape",
    );
    db.close();
  },
});

Deno.test({
  name: "SqliteStore (integration) - write/read round-trip on a custom entity",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { store, db } = freshEntityStore();
    const meta = store.entitySupport(userSchema);
    await store.provisionEntity(meta);
    const avatar = new Uint8Array([1, 2, 3, 4, 5]);
    const [w] = await store.write(meta, [
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

    const [[, rec]] = await store.read(meta, ["data://users/alice"]);
    const r = rec as EntityRecord;
    assertEquals(r.name, "Alice");
    assertEquals(r.age, 30);
    assertEquals(r.active, true);
    assertEquals(r.extras, { tags: ["admin"], lastSeen: "2024-01-02" });
    assert(r.avatar instanceof Uint8Array);
    assertEquals(Array.from(r.avatar as Uint8Array), [1, 2, 3, 4, 5]);
    db.close();
  },
});

Deno.test({
  name: "SqliteStore (integration) - strict validation rejects extra fields",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { store, db } = freshEntityStore();
    const meta = store.entitySupport(userSchema);
    await store.provisionEntity(meta);
    const [r] = await store.write(meta, [{
      uri: "data://users/x",
      record: { name: "X", age: 0, mystery: "not declared" } as EntityRecord,
    }]);
    assertEquals(r.success, false);
    assert(r.error?.includes("not declared"));
    assertEquals(r.errorDetail?.uri, "data://users/x");
    db.close();
  },
});

Deno.test({
  name: "SqliteStore (integration) - ls/count on a custom entity",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { store, db } = freshEntityStore();
    const meta = store.entitySupport(postSchema);
    await store.provisionEntity(meta);
    await store.write(meta, [
      { uri: "data://posts/a", record: { title: "A", stars: 1n } },
      { uri: "data://posts/b", record: { title: "B", stars: 2n } },
      { uri: "data://posts/sub/deep", record: { title: "deep", stars: 9n } },
    ]);
    const [[, count]] = await store.read<number>(meta, [
      "data://posts/?fn=count",
    ]);
    assertEquals(count, 2);
    const [[, uris]] = await store.read<string[]>(meta, [
      "data://posts/?fn=ls&format=uris&sortBy=uri",
    ]);
    assertEquals(uris, ["data://posts/a", "data://posts/b"]);
    const [[, children]] = await store.read<Array<[string, EntityRecord]>>(
      meta,
      ["data://posts/?fn=ls&sortBy=uri"],
    );
    assertEquals(children.map(([u]) => u), [
      "data://posts/a",
      "data://posts/b",
    ]);
    assertEquals(children[0][1].title, "A");
    db.close();
  },
});

Deno.test({
  name: "SqliteStore (integration) - delete removes from the entity table",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { store, db } = freshEntityStore();
    const meta = store.entitySupport(userSchema);
    await store.provisionEntity(meta);
    await store.write(meta, [{
      uri: "data://users/del",
      record: {
        name: "Del",
        age: 1,
        active: true,
        extras: {},
        avatar: new Uint8Array(0),
      },
    }]);
    const [d] = await store.delete(meta, ["data://users/del"]);
    assertEquals(d.success, true);
    const [[, rec]] = await store.read(meta, ["data://users/del"]);
    assertEquals(rec, undefined);
    db.close();
  },
});

Deno.test({
  name: "SqliteStore (integration) - unsupported tags surface in EntitySupport",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { store, db } = freshEntityStore();
    const meta = store.entitySupport({
      name: "weird",
      fields: [
        { name: "ok", type: [TYPE_TAGS.STRING] },
        { name: "money", type: ["some-protocol/money"] },
      ],
    });
    assertEquals(meta.support.supported, ["ok"]);
    assertEquals(meta.support.unsupported.map((u) => u.name), ["money"]);
    await store.provisionEntity(meta);
    db.close();
  },
});

Deno.test({
  name:
    "SqliteStore (integration) - write against unprovisioned entity surfaces no-such-table",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { store, db } = freshEntityStore();
    const meta = store.entitySupport(userSchema);
    // No provisionEntity call — table does not exist.
    const [r] = await store.write(meta, [{
      uri: "data://users/x",
      record: {
        name: "X",
        age: 0,
        active: false,
        extras: {},
        avatar: new Uint8Array(0),
      },
    }]);
    assertEquals(r.success, false);
    assertEquals(r.errorDetail?.code, "STORAGE_ERROR");
    db.close();
  },
});
