/**
 * SqliteStore unit tests.
 *
 * Uses a real in-memory `@db/sqlite` Database — the mock-SQL approach
 * was fragile once DDL and `PRAGMA table_info` started carrying load.
 * `@db/sqlite` runs in-process with no external service, so this is
 * still a unit test.
 *
 * The shared store suite covers `BYTES_ENTITY` end-to-end. The rest of
 * this file covers entity-level behaviour: `entitySupport` purity,
 * `entityStatus` collision detection, `provisionEntity` idempotence
 * and collision-throwing, custom-entity SQL round-trip (per-tag
 * adapters for bytes/bigint/timestamp/json/boolean), ls/count
 * push-down, multi-entity isolation, strict validation, status, and
 * the natural-failure path against unprovisioned entities.
 */

/// <reference lib="deno.ns" />

import { assert, assertEquals, assertRejects } from "@std/assert";
import { type BindValue, Database } from "@db/sqlite";
import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { SqliteStore } from "./store.ts";
import type { SqliteExecutor, SqliteExecutorResult } from "./mod.ts";
import { BYTES_ENTITY, type EntityRecord, TYPE_TAGS } from "../entity.ts";

const TABLE_PREFIX = "test";

interface ExecutorWithDb {
  executor: SqliteExecutor;
  db: Database;
}

function createSqliteExecutor(): ExecutorWithDb {
  const db = new Database(":memory:");

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
      }
      stmt.run(...((args ?? []) as BindValue[]));
      return { rows: [], rowCount: db.changes };
    },
    transaction<T>(fn: (tx: SqliteExecutor) => T): T {
      db.exec("BEGIN");
      try {
        const txExecutor: SqliteExecutor = {
          query: executor.query,
          transaction: () => {
            throw new Error("Nested transactions not supported");
          },
        };
        const result = fn(txExecutor);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    cleanup() {
      db.close();
    },
  };

  return { executor, db };
}

function freshStore(): { store: SqliteStore; cleanup: () => void } {
  const { executor, db } = createSqliteExecutor();
  return {
    store: new SqliteStore(TABLE_PREFIX, executor),
    cleanup: () => db.close(),
  };
}

// Shared suite needs auto-provisioning of BYTES_ENTITY since the suite
// itself doesn't call provisionEntity.
runSharedStoreSuite("SqliteStore", {
  create: async () => {
    const { executor } = createSqliteExecutor();
    const store = new SqliteStore(TABLE_PREFIX, executor);
    await store.provisionEntity(store.entitySupport(BYTES_ENTITY));
    return store;
  },
  // SQLite ships fn=find (v2 §3.5) via push-down: same _ls SQL
  // composition with the shallow safety predicate dropped.
  supportsFind: true,
});

// ── Entity behaviour ──────────────────────────────────────────────

const userSchema = {
  name: "users",
  fields: [
    { name: "name", type: [TYPE_TAGS.STRING] },
    { name: "age", type: [TYPE_TAGS.NUMBER] },
    { name: "blob", type: [TYPE_TAGS.BYTES] },
    { name: "extras", type: [TYPE_TAGS.JSON] },
  ],
};

Deno.test("SqliteStore.entitySupport — reports canonical tags as supported", () => {
  const { store, cleanup } = freshStore();
  try {
    const meta = store.entitySupport(userSchema);
    assertEquals(meta.support.entity, "users");
    assertEquals(meta.support.unsupported, []);
    assertEquals(meta.support.supported.sort(), [
      "age",
      "blob",
      "extras",
      "name",
    ]);
  } finally {
    cleanup();
  }
});

Deno.test("SqliteStore.entitySupport — flags unrecognised tags as unsupported", () => {
  const { store, cleanup } = freshStore();
  try {
    const meta = store.entitySupport({
      name: "mixed",
      fields: [
        { name: "ok", type: [TYPE_TAGS.STRING] },
        { name: "money", type: ["some-protocol/money"] },
        { name: "empty", type: [] },
      ],
    });
    assertEquals(meta.support.supported, ["ok"]);
    assertEquals(meta.support.unsupported.map((u) => u.name).sort(), [
      "empty",
      "money",
    ]);
  } finally {
    cleanup();
  }
});

Deno.test("SqliteStore.entitySupport — pure: does not flip status to live", async () => {
  const { store, cleanup } = freshStore();
  try {
    const meta = store.entitySupport(userSchema);
    assertEquals(await store.entityStatus(meta), "unprovisioned");
  } finally {
    cleanup();
  }
});

Deno.test("SqliteStore.entityStatus — reports live only after provisionEntity", async () => {
  const { store, cleanup } = freshStore();
  try {
    const meta = store.entitySupport(userSchema);
    await store.provisionEntity(meta);
    assertEquals(await store.entityStatus(meta), "live");
  } finally {
    cleanup();
  }
});

Deno.test("SqliteStore.entityStatus — same-name different-shape reports unprovisioned", async () => {
  const { store, cleanup } = freshStore();
  try {
    await store.provisionEntity(store.entitySupport(userSchema));
    const collision = store.entitySupport({
      name: "users",
      fields: [{ name: "name", type: [TYPE_TAGS.STRING] }],
    });
    assertEquals(await store.entityStatus(collision), "unprovisioned");
  } finally {
    cleanup();
  }
});

Deno.test("SqliteStore.provisionEntity — idempotent on identical meta", async () => {
  const { store, cleanup } = freshStore();
  try {
    const meta = store.entitySupport(userSchema);
    await store.provisionEntity(meta);
    await store.provisionEntity(meta);
    assertEquals(await store.entityStatus(meta), "live");
  } finally {
    cleanup();
  }
});

Deno.test("SqliteStore.provisionEntity — throws on same-name different-shape", async () => {
  const { store, cleanup } = freshStore();
  try {
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
  } finally {
    cleanup();
  }
});

// ── Custom-entity SQL round-trip ───────────────────────────────────

Deno.test("SqliteStore — custom entity: write/read round-trips string/number/bytes/json", async () => {
  const { store, cleanup } = freshStore();
  try {
    const meta = store.entitySupport(userSchema);
    await store.provisionEntity(meta);
    const blob = new Uint8Array([1, 2, 3, 4]);
    await store.write(meta, [{
      uri: "data://users/alice",
      record: { name: "Alice", age: 30, blob, extras: { tags: ["a"] } },
    }]);
    const [[uri, rec]] = await store.read(meta, ["data://users/alice"]);
    assertEquals(uri, "data://users/alice");
    assert(rec);
    assertEquals((rec as EntityRecord).name, "Alice");
    assertEquals((rec as EntityRecord).age, 30);
    assertEquals(
      Array.from((rec as EntityRecord).blob as Uint8Array),
      [1, 2, 3, 4],
    );
    assertEquals((rec as EntityRecord).extras, { tags: ["a"] });
  } finally {
    cleanup();
  }
});

Deno.test("SqliteStore — custom entity: bigint round-trips through INTEGER column", async () => {
  const { store, cleanup } = freshStore();
  try {
    const meta = store.entitySupport({
      name: "ledger",
      fields: [{ name: "amount", type: [TYPE_TAGS.BIGINT] }],
    });
    await store.provisionEntity(meta);
    // The injected @db/sqlite driver currently truncates JS `bigint`
    // bind values to int32 (negative result for any value > 2^31-1),
    // so we test with a value comfortably inside that range. Once
    // a higher-fidelity driver is adopted, raising the bound is the
    // only change needed — the store-side round-trip already preserves
    // `bigint` regardless of how the driver returned the row value.
    await store.write(meta, [{
      uri: "data://ledger/1",
      record: { amount: 1_000_000n },
    }]);
    const [[, rec]] = await store.read(meta, ["data://ledger/1"]);
    assertEquals(typeof (rec as EntityRecord).amount, "bigint");
    assertEquals((rec as EntityRecord).amount, 1_000_000n);
  } finally {
    cleanup();
  }
});

Deno.test("SqliteStore — custom entity: timestamp round-trips through TEXT column", async () => {
  const { store, cleanup } = freshStore();
  try {
    const meta = store.entitySupport({
      name: "events",
      fields: [{ name: "at", type: [TYPE_TAGS.TIMESTAMP] }],
    });
    await store.provisionEntity(meta);
    const when = new Date("2026-01-01T00:00:00.000Z");
    await store.write(meta, [{ uri: "data://events/1", record: { at: when } }]);
    const [[, rec]] = await store.read(meta, ["data://events/1"]);
    assert((rec as EntityRecord).at instanceof Date);
    assertEquals(
      ((rec as EntityRecord).at as Date).toISOString(),
      when.toISOString(),
    );
  } finally {
    cleanup();
  }
});

Deno.test("SqliteStore — custom entity: boolean round-trips through INTEGER column", async () => {
  const { store, cleanup } = freshStore();
  try {
    const meta = store.entitySupport({
      name: "flags",
      fields: [{ name: "on", type: [TYPE_TAGS.BOOLEAN] }],
    });
    await store.provisionEntity(meta);
    await store.write(meta, [
      { uri: "data://f/yes", record: { on: true } },
      { uri: "data://f/no", record: { on: false } },
    ]);
    const [[, yes]] = await store.read(meta, ["data://f/yes"]);
    const [[, no]] = await store.read(meta, ["data://f/no"]);
    assertEquals((yes as EntityRecord).on, true);
    assertEquals((no as EntityRecord).on, false);
  } finally {
    cleanup();
  }
});

Deno.test("SqliteStore — custom entity: read miss returns undefined", async () => {
  const { store, cleanup } = freshStore();
  try {
    const meta = store.entitySupport(userSchema);
    await store.provisionEntity(meta);
    const [[, rec]] = await store.read(meta, ["data://users/none"]);
    assertEquals(rec, undefined);
  } finally {
    cleanup();
  }
});

Deno.test("SqliteStore — custom entity: delete removes the record", async () => {
  const { store, cleanup } = freshStore();
  try {
    const meta = store.entitySupport(userSchema);
    await store.provisionEntity(meta);
    await store.write(meta, [{
      uri: "data://users/alice",
      record: { name: "Alice" },
    }]);
    await store.delete(meta, ["data://users/alice"]);
    const [[, rec]] = await store.read(meta, ["data://users/alice"]);
    assertEquals(rec, undefined);
  } finally {
    cleanup();
  }
});

// ── Custom-entity ls / count parity (push-down) ────────────────────

Deno.test("SqliteStore — custom entity: ls returns direct leaves under the entity prefix", async () => {
  const { store, cleanup } = freshStore();
  try {
    const meta = store.entitySupport(userSchema);
    await store.provisionEntity(meta);
    await store.write(meta, [
      { uri: "data://users/alice", record: { name: "Alice" } },
      { uri: "data://users/bob", record: { name: "Bob" } },
      { uri: "data://users/team/charlie", record: { name: "Charlie" } },
    ]);
    const [[, rows]] = await store.read<Array<[string, EntityRecord]>>(meta, [
      "data://users/",
    ]);
    const uris = rows.map(([u]) => u).sort();
    assertEquals(uris, ["data://users/alice", "data://users/bob"]);
  } finally {
    cleanup();
  }
});

Deno.test("SqliteStore — custom entity: ls supports limit + page + sortOrder push-down", async () => {
  const { store, cleanup } = freshStore();
  try {
    const meta = store.entitySupport(userSchema);
    await store.provisionEntity(meta);
    for (const n of ["a", "b", "c", "d"]) {
      await store.write(meta, [{ uri: `x://u/${n}`, record: { name: n } }]);
    }
    const [[, rows]] = await store.read<Array<[string, EntityRecord]>>(meta, [
      "x://u/?fn=ls&limit=2&page=2&sortBy=uri&sortOrder=desc",
    ]);
    const uris = rows.slice(0, -1).map(([u]: [string, unknown]) => u); // drop cursor slot
    assertEquals(uris, ["x://u/b", "x://u/a"]);
  } finally {
    cleanup();
  }
});

Deno.test("SqliteStore — custom entity: count returns the number of direct leaves", async () => {
  const { store, cleanup } = freshStore();
  try {
    const meta = store.entitySupport(userSchema);
    await store.provisionEntity(meta);
    await store.write(meta, [
      { uri: "x://u/a", record: { name: "a" } },
      { uri: "x://u/b", record: { name: "b" } },
      { uri: "x://u/nested/c", record: { name: "c" } },
    ]);
    const [[, n]] = await store.read<number>(meta, ["x://u/?fn=count"]);
    assertEquals(n, 2);
  } finally {
    cleanup();
  }
});

// ── Multi-entity isolation ─────────────────────────────────────────

Deno.test("SqliteStore — hosts multiple entities side-by-side without interference", async () => {
  const { store, cleanup } = freshStore();
  try {
    const userMeta = store.entitySupport(userSchema);
    const postsMeta = store.entitySupport({
      name: "posts",
      fields: [{ name: "title", type: [TYPE_TAGS.STRING] }],
    });
    await store.provisionEntity(userMeta);
    await store.provisionEntity(postsMeta);
    await store.write(userMeta, [{
      uri: "data://x/alice",
      record: { name: "Alice" },
    }]);
    await store.write(postsMeta, [{
      uri: "data://x/alice",
      record: { title: "Hello" },
    }]);
    const [[, u]] = await store.read(userMeta, ["data://x/alice"]);
    const [[, p]] = await store.read(postsMeta, ["data://x/alice"]);
    assertEquals((u as EntityRecord).name, "Alice");
    assertEquals((p as EntityRecord).title, "Hello");
  } finally {
    cleanup();
  }
});

Deno.test("SqliteStore — BYTES_ENTITY and a custom entity at the same URI do not interfere", async () => {
  const { store, cleanup } = freshStore();
  try {
    const userMeta = store.entitySupport(userSchema);
    const bytesMeta = store.entitySupport(BYTES_ENTITY);
    await store.provisionEntity(userMeta);
    await store.provisionEntity(bytesMeta);
    await store.write(bytesMeta, [{
      uri: "data://users/alice",
      record: { payload: new TextEncoder().encode("bytes-side") },
    }]);
    await store.write(userMeta, [{
      uri: "data://users/alice",
      record: { name: "entity-side" },
    }]);
    const [[, b]] = await store.read(bytesMeta, ["data://users/alice"]);
    const bytesPayload = (b as EntityRecord).payload as Uint8Array;
    assertEquals(new TextDecoder().decode(bytesPayload), "bytes-side");
    const [[, rec]] = await store.read(userMeta, ["data://users/alice"]);
    assertEquals((rec as EntityRecord).name, "entity-side");
  } finally {
    cleanup();
  }
});

// ── Strict validation: error reporting, no silent drops ────────────

Deno.test("SqliteStore — write with extra fields reports a per-entry error", async () => {
  const { store, cleanup } = freshStore();
  try {
    const meta = store.entitySupport(userSchema);
    await store.provisionEntity(meta);
    const [r] = await store.write(meta, [{
      uri: "data://users/alice",
      record: { name: "Alice", extra: "not declared" },
    }]);
    assertEquals(r.success, false);
    assertEquals(r.errorDetail?.code, "STORAGE_ERROR");
    assertEquals(r.errorDetail?.uri, "data://users/alice");
    assert(r.error?.includes("not declared"));
  } finally {
    cleanup();
  }
});

// ── Natural failure for unprovisioned entities ─────────────────────

Deno.test("SqliteStore.write — unprovisioned entity surfaces per-entry storage failure", async () => {
  const { store, cleanup } = freshStore();
  try {
    const meta = store.entitySupport({
      name: "fresh",
      fields: [{ name: "k", type: [TYPE_TAGS.STRING] }],
    });
    const [r] = await store.write(meta, [{
      uri: "data://fresh/1",
      record: { k: "v" },
    }]);
    // Atomic batch: the whole transaction fails with a single shared
    // failure (no per-uri attribution). The error string mentions the
    // missing table so callers can diagnose the cause.
    assertEquals(r.success, false);
    assertEquals(r.errorDetail?.code, "STORAGE_ERROR");
    assert(r.error?.includes("no such table") || r.error?.includes("fresh"));
  } finally {
    cleanup();
  }
});

Deno.test("SqliteStore.read — unprovisioned entity returns undefined payloads", async () => {
  const { store, cleanup } = freshStore();
  try {
    const meta = store.entitySupport({
      name: "fresh",
      fields: [{ name: "k", type: [TYPE_TAGS.STRING] }],
    });
    const [[, rec]] = await store.read(meta, ["data://fresh/1"]);
    assertEquals(rec, undefined);
  } finally {
    cleanup();
  }
});

// ── Status ─────────────────────────────────────────────────────────

Deno.test("SqliteStore.status — lists every provisioned entity", async () => {
  const { store, cleanup } = freshStore();
  try {
    await store.provisionEntity(store.entitySupport(BYTES_ENTITY));
    await store.provisionEntity(store.entitySupport(userSchema));
    const s = await store.status();
    const schema = s.schema ?? [];
    assert(schema.includes("entity:bytes"));
    assert(schema.includes("entity:users"));
  } finally {
    cleanup();
  }
});

Deno.test("SqliteStore - empty batch returns empty results", async () => {
  const { store, cleanup } = freshStore();
  try {
    const meta = store.entitySupport(BYTES_ENTITY);
    await store.provisionEntity(meta);
    assertEquals(await store.write(meta, []), []);
    assertEquals(await store.delete(meta, []), []);
  } finally {
    cleanup();
  }
});

Deno.test("SqliteStore - atomicBatch: write rolls back on per-entry failure", async () => {
  // Use a throwing executor on the second INSERT to simulate a
  // mid-batch failure; the transaction wrapper should surface failure
  // for every entry in the batch.
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
  // Synthesize a meta that matches what entitySupport(BYTES_ENTITY)
  // would return — but skip provisioning so the throwing executor's
  // CREATE-time PRAGMAs don't matter for this targeted test.
  const meta = {
    support: { entity: "bytes", supported: ["payload"], unsupported: [] },
    tableName: "test_bytes_data",
    columns: [{ name: "payload", sqlType: "BLOB", tag: "bytes" }],
    declared: new Set(["payload"]),
    bytesColumns: new Set(["payload"]),
  };
  const results = await store.write(meta, [
    { uri: "store://a", record: { payload: new Uint8Array([1]) } },
    { uri: "store://b", record: { payload: new Uint8Array([2]) } },
    { uri: "store://c", record: { payload: new Uint8Array([3]) } },
  ]);
  assertEquals(results.length, 3);
  assertEquals(results.every((r) => !r.success), true);
  assertEquals(results.every((r) => r.error === "boom on entry 2"), true);
});

// ── fn=find push-down — sqlite-specific ───────────────────────────

Deno.test(
  "SqliteStore — fn=ls KEEPS the NOT LIKE %/% shallow safety predicate (regression)",
  async () => {
    // The v2 fn=find work relaxes the shallow safety clause ONLY for
    // fn=find. fn=ls must continue to return depth-1 leaves under the
    // prefix. Build a deeply-nested fixture and assert ls is still
    // shallow even when descendants exist.
    const { store, cleanup } = freshStore();
    try {
      const meta = store.entitySupport(BYTES_ENTITY);
      await store.provisionEntity(meta);
      const enc = (s: string) => new TextEncoder().encode(s);
      await store.write(meta, [
        { uri: "store://safe/alice", record: { payload: enc("a") } },
        { uri: "store://safe/alice/x", record: { payload: enc("ax") } },
        { uri: "store://safe/alice/x/y", record: { payload: enc("axy") } },
        { uri: "store://safe/bob", record: { payload: enc("b") } },
      ]);
      const [[, uris]] = await store.read<string[]>(meta, [
        "store://safe/?fn=ls&format=uris&sortBy=uri",
      ]);
      assertEquals(uris.sort(), ["store://safe/alice", "store://safe/bob"]);
    } finally {
      cleanup();
    }
  },
);

Deno.test(
  "SqliteStore — fn=find returns deep entries past the shallow safety predicate",
  async () => {
    const { store, cleanup } = freshStore();
    try {
      const meta = store.entitySupport(BYTES_ENTITY);
      await store.provisionEntity(meta);
      const enc = (s: string) => new TextEncoder().encode(s);
      await store.write(meta, [
        { uri: "store://deep/alice", record: { payload: enc("a") } },
        { uri: "store://deep/alice/x", record: { payload: enc("ax") } },
        { uri: "store://deep/alice/x/y", record: { payload: enc("axy") } },
        { uri: "store://deep/bob", record: { payload: enc("b") } },
      ]);
      const [[, uris]] = await store.read<string[]>(meta, [
        "store://deep/**?fn=find&format=uris&sortBy=uri",
      ]);
      assertEquals(uris.sort(), [
        "store://deep/alice",
        "store://deep/alice/x",
        "store://deep/alice/x/y",
        "store://deep/bob",
      ]);
    } finally {
      cleanup();
    }
  },
);

Deno.test(
  "SqliteStore — fn=find with mid-** glob (alice/**/posts/*)",
  async () => {
    // Note: per the shared find-conformance suite, the SQL-LIKE
    // adapter's mid-`**` only matches one-or-more segments between
    // (zero-segment case requires a foundation-level adapter refinement).
    const { store, cleanup } = freshStore();
    try {
      const meta = store.entitySupport(BYTES_ENTITY);
      await store.provisionEntity(meta);
      const enc = (s: string) => new TextEncoder().encode(s);
      await store.write(meta, [
        { uri: "store://g/alice/feed/posts/1", record: { payload: enc("1") } },
        { uri: "store://g/alice/y/z/posts/2", record: { payload: enc("2") } },
        { uri: "store://g/alice/other", record: { payload: enc("o") } },
        { uri: "store://g/bob/posts/9", record: { payload: enc("9") } },
      ]);
      const [[, uris]] = await store.read<string[]>(meta, [
        "store://g/alice/**/posts/*?fn=find&format=uris&sortBy=uri",
      ]);
      assertEquals(uris.sort(), [
        "store://g/alice/feed/posts/1",
        "store://g/alice/y/z/posts/2",
      ]);
    } finally {
      cleanup();
    }
  },
);

Deno.test(
  "SqliteStore — fn=find injection-safety: literal % and _ in segment names stay inert",
  async () => {
    // Prefix carrying literal SQL-LIKE metacharacters (`%`, `_`) is
    // bound as a parameter — never spliced into the LIKE body — so
    // SQLite treats the bytes as literal LIKE data. The `globToSqlLike`
    // adapter escapes literal `%`/`_` in the pattern body via `\\`
    // with `ESCAPE '\'` on the surrounding clause.
    //
    // Fixture: URIs whose room segment contains `%` or `_`. Find under
    // the literal prefix must return ONLY entries that live under that
    // exact prefix — NOT every URI in the table that happens to share
    // the SQL-LIKE wildcard expansion.
    const { store, cleanup } = freshStore();
    try {
      const meta = store.entitySupport(BYTES_ENTITY);
      await store.provisionEntity(meta);
      const enc = (s: string) => new TextEncoder().encode(s);
      await store.write(meta, [
        // The intended subtree (room contains literal %).
        { uri: "store://r/100%/a", record: { payload: enc("a") } },
        { uri: "store://r/100%/b/c", record: { payload: enc("bc") } },
        // Decoy: would match SQL-LIKE `100%` if `%` were treated as
        // a wildcard inside the prefix bind, but should NOT be
        // returned for the literal prefix.
        { uri: "store://r/100x/decoy", record: { payload: enc("d") } },
        // Sibling room with literal underscore.
        { uri: "store://r/a_b/x", record: { payload: enc("x") } },
        { uri: "store://r/aXb/decoy", record: { payload: enc("d2") } },
      ]);
      const [[, pctUris]] = await store.read<string[]>(meta, [
        "store://r/100%/**?fn=find&format=uris&sortBy=uri",
      ]);
      assertEquals(pctUris.sort(), [
        "store://r/100%/a",
        "store://r/100%/b/c",
      ]);
      const [[, undUris]] = await store.read<string[]>(meta, [
        "store://r/a_b/**?fn=find&format=uris&sortBy=uri",
      ]);
      assertEquals(undUris.sort(), ["store://r/a_b/x"]);
    } finally {
      cleanup();
    }
  },
);

Deno.test(
  "SqliteStore.status — advertises 'find' in fns",
  async () => {
    const { store, cleanup } = freshStore();
    try {
      const status = await store.status();
      assertEquals(status.status, "healthy");
      assertEquals(status.fns?.includes("find"), true);
      assertEquals(status.fns, ["read", "ls", "find", "count"]);
    } finally {
      cleanup();
    }
  },
);
