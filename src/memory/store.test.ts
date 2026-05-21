/**
 * MemoryStore unit tests.
 *
 * The shared store suite covers the `BYTES_ENTITY` contract (which is
 * just another entity here). The rest of this file covers entity-level
 * behaviour: `ensureEntity` reporting, multi-entity isolation, strict
 * validation, status.
 */

/// <reference lib="deno.ns" />

import { assert, assertEquals } from "@std/assert";
import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { MemoryStore } from "./store.ts";
import { BYTES_ENTITY, type EntityRecord, TYPE_TAGS } from "../entity.ts";

const userSchema = {
  name: "users",
  fields: [
    { name: "name", type: [TYPE_TAGS.STRING] },
    { name: "age", type: [TYPE_TAGS.NUMBER] },
    { name: "blob", type: [TYPE_TAGS.BYTES] },
    { name: "extras", type: [TYPE_TAGS.JSON] },
  ],
};

runSharedStoreSuite("MemoryStore", {
  create: () => new MemoryStore(),
});

Deno.test("MemoryStore - capabilities shape", () => {
  const caps = new MemoryStore().capabilities();
  assertEquals(caps.atomicBatch, false);
});

// ── ensureEntity ──────────────────────────────────────────────────

Deno.test("MemoryStore.ensureEntity - reports canonical tags as supported", async () => {
  const store = new MemoryStore();
  const support = await store.ensureEntity(userSchema);
  assertEquals(support.entity, "users");
  assertEquals(support.unsupported, []);
  assertEquals(support.supported.sort(), ["age", "blob", "extras", "name"]);
});

Deno.test("MemoryStore.ensureEntity - flags unrecognised tags as unsupported", async () => {
  const store = new MemoryStore();
  const support = await store.ensureEntity({
    name: "mixed",
    fields: [
      { name: "ok", type: [TYPE_TAGS.STRING] },
      { name: "money", type: ["some-protocol/money"] },
      { name: "empty", type: [] },
      { name: "refined", type: [TYPE_TAGS.STRING, "some-protocol/email"] },
    ],
  });
  assertEquals(support.supported.sort(), ["ok", "refined"]);
  assertEquals(support.unsupported.map((u) => u.name).sort(), [
    "empty",
    "money",
  ]);
});

// ── Custom-entity round-trip ──────────────────────────────────────

Deno.test("MemoryStore - custom entity: write/read round-trip retains values", async () => {
  const store = new MemoryStore();
  await store.ensureEntity(userSchema);
  const blob = new Uint8Array([1, 2, 3, 4]);
  await store.write(userSchema, [{
    uri: "data://users/alice",
    record: { name: "Alice", age: 30, blob, extras: { tags: ["a"] } },
  }]);
  const [[uri, rec]] = await store.read(userSchema, ["data://users/alice"]);
  assertEquals(uri, "data://users/alice");
  assert(rec);
  assertEquals((rec as EntityRecord).name, "Alice");
  assertEquals((rec as EntityRecord).age, 30);
  assert((rec as EntityRecord).blob === blob);
  assertEquals((rec as EntityRecord).extras, { tags: ["a"] });
});

Deno.test("MemoryStore - custom entity: read miss returns undefined", async () => {
  const store = new MemoryStore();
  await store.ensureEntity(userSchema);
  const [[, rec]] = await store.read(userSchema, ["data://users/none"]);
  assertEquals(rec, undefined);
});

Deno.test("MemoryStore - custom entity: delete removes the record", async () => {
  const store = new MemoryStore();
  await store.ensureEntity(userSchema);
  await store.write(userSchema, [{
    uri: "data://users/alice",
    record: { name: "Alice" },
  }]);
  await store.delete(userSchema, ["data://users/alice"]);
  const [[, rec]] = await store.read(userSchema, ["data://users/alice"]);
  assertEquals(rec, undefined);
});

// ── Multi-entity isolation ────────────────────────────────────────

Deno.test("MemoryStore - hosts multiple entities side-by-side without interference", async () => {
  const store = new MemoryStore();
  const posts = {
    name: "posts",
    fields: [{ name: "title", type: [TYPE_TAGS.STRING] }],
  };
  await store.ensureEntity(userSchema);
  await store.ensureEntity(posts);

  await store.write(userSchema, [{
    uri: "data://x/alice",
    record: { name: "Alice" },
  }]);
  await store.write(posts, [{
    uri: "data://x/alice",
    record: { title: "Hello" },
  }]);

  const [[, u]] = await store.read(userSchema, ["data://x/alice"]);
  const [[, p]] = await store.read(posts, ["data://x/alice"]);
  assertEquals(u, { name: "Alice" });
  assertEquals(p, { title: "Hello" });
});

Deno.test("MemoryStore - BYTES_ENTITY and a custom entity at the same URI do not interfere", async () => {
  const store = new MemoryStore();
  await store.ensureEntity(userSchema);
  await store.write(BYTES_ENTITY, [{
    uri: "data://users/alice",
    record: { payload: new TextEncoder().encode("bytes-side") },
  }]);
  await store.write(userSchema, [{
    uri: "data://users/alice",
    record: { name: "entity-side" },
  }]);
  const [[, b]] = await store.read(BYTES_ENTITY, ["data://users/alice"]);
  const bytesPayload = (b as EntityRecord).payload as Uint8Array;
  assertEquals(new TextDecoder().decode(bytesPayload), "bytes-side");
  const [[, rec]] = await store.read(userSchema, ["data://users/alice"]);
  assertEquals(rec, { name: "entity-side" });
});

// ── Strict validation: error reporting, no silent drops ───────────

Deno.test("MemoryStore - write with extra fields reports a per-entry error", async () => {
  const store = new MemoryStore();
  await store.ensureEntity(userSchema);
  const [r] = await store.write(userSchema, [{
    uri: "data://users/alice",
    record: { name: "Alice", extra: "not declared" },
  }]);
  assertEquals(r.success, false);
  assertEquals(r.errorDetail?.code, "STORAGE_ERROR");
  assertEquals(r.errorDetail?.uri, "data://users/alice");
  assert(r.error?.includes("not declared"));
});

Deno.test("MemoryStore - non-bytes value on a bytes field fails the entry with a structured error", async () => {
  // Mixed-batch shape: the good entry still succeeds, the bad one
  // carries the structured failure with its uri (atomicBatch: false).
  const store = new MemoryStore();
  await store.ensureEntity(BYTES_ENTITY);
  const results = await store.write(BYTES_ENTITY, [
    { uri: "store://app/good", record: { payload: new Uint8Array([1]) } },
    {
      uri: "store://app/bad",
      record: { payload: "not bytes" as unknown as Uint8Array },
    },
  ]);
  assertEquals(results[0].success, true);
  assertEquals(results[1].success, false);
  assertEquals(results[1].errorDetail?.code, "STORAGE_ERROR");
  assertEquals(results[1].errorDetail?.uri, "store://app/bad");
  assert(results[1].error?.includes("Uint8Array"));
});

Deno.test("MemoryStore.write(schema, …) auto-ensures on first use", async () => {
  // ensureEntity not called explicitly — the write path provisions.
  const store = new MemoryStore();
  const fresh = {
    name: "fresh",
    fields: [{ name: "k", type: [TYPE_TAGS.STRING] }],
  };
  const [r] = await store.write(fresh, [{
    uri: "data://fresh/1",
    record: { k: "v" },
  }]);
  assertEquals(r.success, true);
  const [[, rec]] = await store.read(fresh, ["data://fresh/1"]);
  assertEquals(rec, { k: "v" });
});

// ── Status ────────────────────────────────────────────────────────

Deno.test("MemoryStore.status - lists every ensured entity", async () => {
  const store = new MemoryStore();
  await store.ensureEntity(BYTES_ENTITY);
  await store.write(BYTES_ENTITY, [{
    uri: "mutable://app/x",
    record: { payload: new Uint8Array([1]) },
  }]);
  await store.ensureEntity(userSchema);
  const s = await store.status();
  assert((s.schema ?? []).includes("entity:bytes"));
  assert((s.schema ?? []).includes("entity:users"));
});
