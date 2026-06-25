/**
 * IndexedDBStore unit tests.
 *
 * The shared store suite covers the `BYTES_ENTITY` contract end-to-end.
 * The rest of this file covers entity-level behaviour: `entitySupport`
 * purity, `entityStatus` collision detection, `provisionEntity`
 * idempotence and collision-throwing, custom-entity native round-trip
 * (`Uint8Array`/`Date`/`BigInt` are preserved by structured clone),
 * `ls`/`count` push-down via cursor, multi-entity isolation, strict
 * validation, and the natural-failure path when ops run against an
 * unprovisioned entity.
 *
 * Runs against fake-indexeddb (IndexedDB is not available in Deno).
 */

/// <reference lib="deno.ns" />

import { assert, assertEquals, assertRejects } from "@std/assert";
import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { IndexedDBStore } from "./store.ts";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { BYTES_ENTITY, type EntityRecord, TYPE_TAGS } from "../entity.ts";

let testCount = 0;

function freshStore() {
  return new IndexedDBStore({
    databaseName: `test-db-${++testCount}`,
    indexedDB,
    IDBKeyRange,
  });
}

runSharedStoreSuite("IndexedDBStore", {
  create: () => freshStore(),
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

Deno.test("IndexedDBStore.entitySupport — reports canonical tags as supported", () => {
  const meta = freshStore().entitySupport(userSchema);
  assertEquals(meta.support.entity, "users");
  assertEquals(meta.support.unsupported, []);
  assertEquals(meta.support.supported.sort(), [
    "age",
    "blob",
    "extras",
    "name",
  ]);
});

Deno.test("IndexedDBStore.entitySupport — flags unrecognised tags as unsupported", () => {
  const meta = freshStore().entitySupport({
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
});

Deno.test("IndexedDBStore.entitySupport — pure: does not flip status to live", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  assertEquals(await store.entityStatus(meta), "unprovisioned");
});

Deno.test("IndexedDBStore.entityStatus — reports live only after provisionEntity", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  assertEquals(await store.entityStatus(meta), "live");
});

Deno.test("IndexedDBStore.entityStatus — same-name different-shape reports unprovisioned", async () => {
  const store = freshStore();
  await store.provisionEntity(store.entitySupport(userSchema));
  const collision = store.entitySupport({
    name: "users",
    fields: [{ name: "name", type: [TYPE_TAGS.STRING] }],
  });
  assertEquals(await store.entityStatus(collision), "unprovisioned");
});

Deno.test("IndexedDBStore.provisionEntity — idempotent on identical meta", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.provisionEntity(meta);
  assertEquals(await store.entityStatus(meta), "live");
});

Deno.test("IndexedDBStore.provisionEntity — throws on same-name different-shape", async () => {
  const store = freshStore();
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
});

Deno.test("IndexedDBStore.provisionEntity — throws on same-field tag swap", async () => {
  const store = freshStore();
  await store.provisionEntity(store.entitySupport(userSchema));
  const swapped = store.entitySupport({
    name: "users",
    fields: [
      { name: "name", type: [TYPE_TAGS.STRING] },
      { name: "age", type: [TYPE_TAGS.BIGINT] },
      { name: "blob", type: [TYPE_TAGS.BYTES] },
      { name: "extras", type: [TYPE_TAGS.JSON] },
    ],
  });
  assertEquals(await store.entityStatus(swapped), "unprovisioned");
  await assertRejects(
    () => store.provisionEntity(swapped),
    Error,
    "different shape",
  );
});

// ── Custom-entity round-trip (structured clone preserves typed values) ──

Deno.test("IndexedDBStore — custom entity: write/read round-trips string/number/bytes/json", async () => {
  const store = freshStore();
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
});

Deno.test("IndexedDBStore — custom entity: bigint preserved by structured clone", async () => {
  const store = freshStore();
  const meta = store.entitySupport({
    name: "ledger",
    fields: [{ name: "amount", type: [TYPE_TAGS.BIGINT] }],
  });
  await store.provisionEntity(meta);
  await store.write(meta, [{
    uri: "data://ledger/1",
    record: { amount: 9007199254740993n },
  }]);
  const [[, rec]] = await store.read(meta, ["data://ledger/1"]);
  assertEquals((rec as EntityRecord).amount, 9007199254740993n);
});

Deno.test("IndexedDBStore — custom entity: Date preserved by structured clone", async () => {
  const store = freshStore();
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
});

Deno.test("IndexedDBStore — custom entity: read miss returns undefined", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  const [[, rec]] = await store.read(meta, ["data://users/none"]);
  assertEquals(rec, undefined);
});

Deno.test("IndexedDBStore — custom entity: delete removes the record", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.write(meta, [{
    uri: "data://users/alice",
    record: { name: "Alice" },
  }]);
  await store.delete(meta, ["data://users/alice"]);
  const [[, rec]] = await store.read(meta, ["data://users/alice"]);
  assertEquals(rec, undefined);
});

// ── Custom-entity ls / count via cursor over the entity prefix ──────

Deno.test("IndexedDBStore — custom entity: ls returns direct leaves under the entity prefix", async () => {
  const store = freshStore();
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
});

Deno.test("IndexedDBStore — custom entity: ls supports limit + page + sortOrder", async () => {
  const store = freshStore();
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
});

Deno.test("IndexedDBStore — custom entity: count returns the number of direct leaves", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "x://u/a", record: { name: "a" } },
    { uri: "x://u/b", record: { name: "b" } },
    { uri: "x://u/nested/c", record: { name: "c" } },
  ]);
  const [[, n]] = await store.read<number>(meta, ["x://u/?fn=count"]);
  assertEquals(n, 2);
});

// ── Multi-entity isolation ─────────────────────────────────────────

Deno.test("IndexedDBStore — hosts multiple entities side-by-side without interference", async () => {
  const store = freshStore();
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
});

Deno.test("IndexedDBStore — BYTES_ENTITY and a custom entity at the same URI do not interfere", async () => {
  const store = freshStore();
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
});

// ── Strict validation: error reporting, no silent drops ────────────

Deno.test("IndexedDBStore — write with extra fields reports a per-entry error", async () => {
  const store = freshStore();
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
});

// ── Natural failure for unprovisioned entities ─────────────────────

Deno.test("IndexedDBStore.write — unprovisioned entity surfaces per-entry storage failure", async () => {
  const store = freshStore();
  const meta = store.entitySupport({
    name: "fresh",
    fields: [{ name: "k", type: [TYPE_TAGS.STRING] }],
  });
  const [r] = await store.write(meta, [{
    uri: "data://fresh/1",
    record: { k: "v" },
  }]);
  assertEquals(r.success, false);
  assertEquals(r.errorDetail?.code, "STORAGE_ERROR");
  assertEquals(r.errorDetail?.uri, "data://fresh/1");
  assert(r.error?.includes("not provisioned"));
});

Deno.test("IndexedDBStore.read — unprovisioned entity returns undefined payloads", async () => {
  const store = freshStore();
  const meta = store.entitySupport({
    name: "fresh",
    fields: [{ name: "k", type: [TYPE_TAGS.STRING] }],
  });
  const [[, rec]] = await store.read(meta, ["data://fresh/1"]);
  assertEquals(rec, undefined);
});

Deno.test("IndexedDBStore.delete — unprovisioned entity surfaces per-entry storage failure", async () => {
  const store = freshStore();
  const meta = store.entitySupport({
    name: "fresh",
    fields: [{ name: "k", type: [TYPE_TAGS.STRING] }],
  });
  const [r] = await store.delete(meta, ["data://fresh/1"]);
  assertEquals(r.success, false);
  assert(r.error?.includes("not provisioned"));
});

// ── Status ─────────────────────────────────────────────────────────

Deno.test("IndexedDBStore.status — lists every provisioned entity", async () => {
  const store = freshStore();
  await store.provisionEntity(store.entitySupport(BYTES_ENTITY));
  await store.provisionEntity(store.entitySupport(userSchema));
  const s = await store.status();
  const schema = s.schema ?? [];
  assert(schema.includes("entity:bytes"));
  assert(schema.includes("entity:users"));
});

// ── fn=find (v2 §3.5) — indexeddb-specific coverage ───────────────

Deno.test("IndexedDBStore.status — advertises fn=find", async () => {
  const store = freshStore();
  const s = await store.status();
  assert((s.fns ?? []).includes("find"));
});

Deno.test("IndexedDBStore — fn=find on a custom entity walks descendants", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "x://team/alice", record: { name: "Alice" } },
    { uri: "x://team/bob", record: { name: "Bob" } },
    { uri: "x://team/sub/charlie", record: { name: "Charlie" } },
  ]);
  const [[, rows]] = await store.read<string[]>(meta, [
    "x://team/**?fn=find&format=uris&sortBy=uri",
  ]);
  assertEquals(rows.sort(), [
    "x://team/alice",
    "x://team/bob",
    "x://team/sub/charlie",
  ]);
});

Deno.test("IndexedDBStore — fn=find on unprovisioned entity returns []", async () => {
  const store = freshStore();
  const meta = store.entitySupport({
    name: "ghost",
    fields: [{ name: "k", type: [TYPE_TAGS.STRING] }],
  });
  // No provisionEntity call — entity does not exist in this store.
  const [[, rows]] = await store.read<string[]>(meta, [
    "x://ghost/**?fn=find&format=uris",
  ]);
  assertEquals(rows, []);
});

Deno.test("IndexedDBStore — ls/find walk symmetry on the same bucket", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "z://r/a", record: { name: "a" } },
    { uri: "z://r/b", record: { name: "b" } },
    { uri: "z://r/nest/c", record: { name: "c" } },
    { uri: "z://r/nest/deep/d", record: { name: "d" } },
  ]);
  const [[, lsRows]] = await store.read<string[]>(meta, [
    "z://r/?fn=ls&format=uris&sortBy=uri",
  ]);
  assertEquals(lsRows.sort(), ["z://r/a", "z://r/b"]);
  const [[, findRows]] = await store.read<string[]>(meta, [
    "z://r/**?fn=find&format=uris&sortBy=uri",
  ]);
  assertEquals(findRows.sort(), [
    "z://r/a",
    "z://r/b",
    "z://r/nest/c",
    "z://r/nest/deep/d",
  ]);
});
