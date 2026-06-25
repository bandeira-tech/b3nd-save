/**
 * LocalStorageStore unit tests.
 *
 * The shared store suite covers `BYTES_ENTITY` end-to-end. The
 * remainder of this file covers entity-level behaviour: `entitySupport`
 * purity, `entityStatus` collision detection, `provisionEntity`
 * idempotence and collision-throwing, custom-entity JSON round-trip
 * (bytes/bigint/timestamp), multi-entity isolation, strict validation,
 * and the natural-failure path when ops run against an unprovisioned
 * entity.
 *
 * Uses a simple in-memory Storage mock since localStorage is not
 * available in Deno.
 */

/// <reference lib="deno.ns" />

import { assert, assertEquals, assertRejects } from "@std/assert";
import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { LocalStorageStore } from "./store.ts";
import { BYTES_ENTITY, type EntityRecord, TYPE_TAGS } from "../entity.ts";

/**
 * Minimal in-memory Storage mock for testing.
 */
function createMockStorage(): Storage {
  const data = new Map<string, string>();

  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    key(index: number) {
      return [...data.keys()][index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  } as Storage;
}

runSharedStoreSuite("LocalStorageStore", {
  create: () =>
    new LocalStorageStore({
      keyPrefix: "test:",
      storage: createMockStorage(),
    }),
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

function freshStore() {
  return new LocalStorageStore({
    keyPrefix: "test:",
    storage: createMockStorage(),
  });
}

Deno.test("LocalStorageStore.entitySupport — reports canonical tags as supported", () => {
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

Deno.test("LocalStorageStore.entitySupport — flags unrecognised tags as unsupported", () => {
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

Deno.test("LocalStorageStore.entitySupport — pure: does not flip status to live", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  assertEquals(await store.entityStatus(meta), "unprovisioned");
});

Deno.test("LocalStorageStore.entityStatus — reports live only after provisionEntity", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  assertEquals(await store.entityStatus(meta), "live");
});

Deno.test("LocalStorageStore.entityStatus — same-name different-shape reports unprovisioned", async () => {
  const store = freshStore();
  await store.provisionEntity(store.entitySupport(userSchema));
  const collision = store.entitySupport({
    name: "users",
    fields: [{ name: "name", type: [TYPE_TAGS.STRING] }],
  });
  assertEquals(await store.entityStatus(collision), "unprovisioned");
});

Deno.test("LocalStorageStore.provisionEntity — idempotent on identical meta", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.provisionEntity(meta);
  assertEquals(await store.entityStatus(meta), "live");
});

Deno.test("LocalStorageStore.provisionEntity — throws on same-name different-shape", async () => {
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

Deno.test("LocalStorageStore.provisionEntity — throws on same-field tag swap", async () => {
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

// ── Custom-entity round-trip (typed values across the JSON boundary) ──

Deno.test("LocalStorageStore — custom entity: write/read round-trips string/number/bytes/json", async () => {
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

Deno.test("LocalStorageStore — custom entity: bigint round-trips through JSON", async () => {
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

Deno.test("LocalStorageStore — custom entity: timestamp round-trips through JSON", async () => {
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

Deno.test("LocalStorageStore — custom entity: read miss returns undefined", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  const [[, rec]] = await store.read(meta, ["data://users/none"]);
  assertEquals(rec, undefined);
});

Deno.test("LocalStorageStore — custom entity: delete removes the record", async () => {
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

// ── Custom-entity ls / count parity ────────────────────────────────

Deno.test("LocalStorageStore — custom entity: ls returns direct leaves under the entity prefix", async () => {
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

Deno.test("LocalStorageStore — custom entity: ls supports limit + page + sortOrder", async () => {
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

Deno.test("LocalStorageStore — custom entity: count returns the number of direct leaves", async () => {
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

Deno.test("LocalStorageStore — hosts multiple entities side-by-side without interference", async () => {
  const store = freshStore();
  const posts = {
    name: "posts",
    fields: [{ name: "title", type: [TYPE_TAGS.STRING] }],
  };
  const userMeta = store.entitySupport(userSchema);
  const postsMeta = store.entitySupport(posts);
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

Deno.test("LocalStorageStore — BYTES_ENTITY and a custom entity at the same URI do not interfere", async () => {
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

Deno.test("LocalStorageStore — write with extra fields reports a per-entry error", async () => {
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

Deno.test("LocalStorageStore.write — unprovisioned entity surfaces per-entry storage failure", async () => {
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

Deno.test("LocalStorageStore.read — unprovisioned entity returns undefined payloads", async () => {
  const store = freshStore();
  const meta = store.entitySupport({
    name: "fresh",
    fields: [{ name: "k", type: [TYPE_TAGS.STRING] }],
  });
  const [[, rec]] = await store.read(meta, ["data://fresh/1"]);
  assertEquals(rec, undefined);
});

Deno.test("LocalStorageStore.delete — unprovisioned entity surfaces per-entry storage failure", async () => {
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

Deno.test("LocalStorageStore.status — lists every provisioned entity", async () => {
  const store = freshStore();
  await store.provisionEntity(store.entitySupport(BYTES_ENTITY));
  await store.provisionEntity(store.entitySupport(userSchema));
  const s = await store.status();
  assert((s.schema ?? []).includes("entity:bytes"));
  assert((s.schema ?? []).includes("entity:users"));
});

// ── Field projection (fields=...) via dispatch layer ──────────────

Deno.test("LocalStorageStore — fn=read with fields= projects record (via dispatch)", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.write(meta, [{
    uri: "data://users/alice",
    record: { name: "Alice", age: 30, blob: new Uint8Array([1]), extras: {} },
  }]);
  const [[, rec]] = await store.read(meta, [
    "data://users/alice?fields=name,age",
  ]);
  assertEquals(rec, { name: "Alice", age: 30 });
});

Deno.test("LocalStorageStore — fn=ls with fields= projects each row (via dispatch)", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "x://u/a", record: { name: "A", age: 1 } },
    { uri: "x://u/b", record: { name: "B", age: 2 } },
  ]);
  const [[, rows]] = await store.read<Array<[string, EntityRecord]>>(meta, [
    "x://u/?fields=name",
  ]);
  const projected = rows
    .map(([u, r]) => [u, r] as [string, EntityRecord])
    .sort(([a], [b]) => a.localeCompare(b));
  assertEquals(projected, [
    ["x://u/a", { name: "A" }],
    ["x://u/b", { name: "B" }],
  ]);
});

// ── fn=find: localstorage-specific edge cases ──────────────────────
// The shared suite covers the v2 §3.5 contract end-to-end (deep walk,
// glob filter, sub-prefix scoping, cursor-as-trailing-slot, empty
// result). These tests cover localstorage-specific surfaces the shared
// suite doesn't reach: status().fns advertisement, find on a custom
// entity (not just BYTES_ENTITY), find on an unprovisioned entity, and
// the shallow-ls / deep-find walk symmetry.

Deno.test("LocalStorageStore - status().fns advertises 'find'", async () => {
  const store = freshStore();
  const status = await store.status();
  assertEquals(status.fns, ["read", "ls", "count", "find"]);
});

Deno.test("LocalStorageStore - fn=find on a custom entity walks the bucket deeply", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "x://u/a", record: { name: "A", age: 1 } },
    { uri: "x://u/sub/b", record: { name: "B", age: 2 } },
    { uri: "x://u/sub/deep/c", record: { name: "C", age: 3 } },
  ]);
  const [[, rows]] = await store.read<Array<[string, EntityRecord]>>(meta, [
    "x://u/**?fn=find&sortBy=uri",
  ]);
  const list = rows as Array<[string, EntityRecord]>;
  assertEquals(list.map(([u]) => u), [
    "x://u/a",
    "x://u/sub/b",
    "x://u/sub/deep/c",
  ]);
  assertEquals(list[0][1].name, "A");
  assertEquals(list[2][1].age, 3);
});

Deno.test("LocalStorageStore - fn=find on unprovisioned entity returns empty list", async () => {
  // No provisionEntity call — the meta key is missing. Reads through
  // dispatch route to the find handler, which walks the (empty) prefix
  // and returns []. Must not throw — the shared suite's "empty find"
  // test covers BYTES_ENTITY on a fresh store; this asserts the same
  // behaviour on a non-bytes entity whose keyRoot differs.
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  const [[, rows]] = await store.read<Array<[string, EntityRecord]>>(meta, [
    "data://users/**?fn=find&format=uris",
  ]);
  assertEquals(rows as unknown as string[], []);
});

Deno.test("LocalStorageStore - ls stays shallow even when find sees deep entries", async () => {
  // The shallow-ls / deep-find symmetry: _directLeaves keeps the
  // rest.includes('/') cutoff so ls of a prefix containing nested
  // entries returns only the direct leaves, while _walkDeep returns
  // every descendant. Same keyRoot, two walks.
  const store = freshStore();
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "x://r/leaf", record: { payload: new TextEncoder().encode("L") } },
    {
      uri: "x://r/sub/nested",
      record: { payload: new TextEncoder().encode("N") },
    },
  ]);
  const lsResult = await store.read<string[]>(meta, [
    "x://r/?fn=ls&format=uris&sortBy=uri",
  ]);
  assertEquals(lsResult[0][1], ["x://r/leaf"]);
  const findResult = await store.read<string[]>(meta, [
    "x://r/**?fn=find&format=uris&sortBy=uri",
  ]);
  assertEquals(findResult[0][1], [
    "x://r/leaf",
    "x://r/sub/nested",
  ]);
});
