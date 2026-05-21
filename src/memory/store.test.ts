/**
 * MemoryStore unit tests.
 *
 * The shared store suite covers the `BYTES_ENTITY` contract (which is
 * just another entity here). The rest of this file covers entity-level
 * behaviour: `entitySupport` purity, `entityStatus` collision detection,
 * `provisionEntity` idempotence and collision-throwing, multi-entity
 * isolation, strict validation, status, and the natural-failure path
 * when ops run against an unprovisioned entity.
 */

/// <reference lib="deno.ns" />

import { assert, assertEquals, assertRejects } from "@std/assert";
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

// ── entitySupport / entityStatus / provisionEntity ────────────────

Deno.test("MemoryStore.entitySupport - reports canonical tags as supported", () => {
  const store = new MemoryStore();
  const meta = store.entitySupport(userSchema);
  assertEquals(meta.support.entity, "users");
  assertEquals(meta.support.unsupported, []);
  assertEquals(
    meta.support.supported.sort(),
    ["age", "blob", "extras", "name"],
  );
});

Deno.test("MemoryStore.entitySupport - flags unrecognised tags as unsupported", () => {
  const store = new MemoryStore();
  const meta = store.entitySupport({
    name: "mixed",
    fields: [
      { name: "ok", type: [TYPE_TAGS.STRING] },
      { name: "money", type: ["some-protocol/money"] },
      { name: "empty", type: [] },
      { name: "refined", type: [TYPE_TAGS.STRING, "some-protocol/email"] },
    ],
  });
  assertEquals(meta.support.supported.sort(), ["ok", "refined"]);
  assertEquals(meta.support.unsupported.map((u) => u.name).sort(), [
    "empty",
    "money",
  ]);
});

Deno.test("MemoryStore.entitySupport - pure: does not flip status to live", async () => {
  const store = new MemoryStore();
  const meta = store.entitySupport(userSchema);
  assertEquals(await store.entityStatus(meta), "unprovisioned");
});

Deno.test("MemoryStore.entityStatus - reports live only after provisionEntity", async () => {
  const store = new MemoryStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  assertEquals(await store.entityStatus(meta), "live");
});

Deno.test("MemoryStore.entityStatus - same-name different-shape reports unprovisioned", async () => {
  const store = new MemoryStore();
  const original = store.entitySupport(userSchema);
  await store.provisionEntity(original);
  const collision = store.entitySupport({
    name: "users",
    fields: [{ name: "name", type: [TYPE_TAGS.STRING] }],
  });
  assertEquals(await store.entityStatus(collision), "unprovisioned");
});

Deno.test("MemoryStore.provisionEntity - idempotent on identical meta", async () => {
  const store = new MemoryStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.provisionEntity(meta);
  assertEquals(await store.entityStatus(meta), "live");
});

Deno.test("MemoryStore.provisionEntity - throws on same-name different-shape", async () => {
  const store = new MemoryStore();
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

Deno.test("MemoryStore.provisionEntity - throws on same-field tag swap", async () => {
  // Same entity name, same field names — but `age` flips from NUMBER
  // to BIGINT. SQL backends would catch this via column-type
  // introspection; Memory matches that strictness by including the
  // canonical type tag in its signature.
  const store = new MemoryStore();
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

Deno.test("MemoryStore.entityStatus - extra refinement tags do not collide", async () => {
  // Adding a refinement tag that is not in TYPE_TAGS leaves the
  // canonical tag unchanged, so this is the same shape — no collision.
  const store = new MemoryStore();
  await store.provisionEntity(
    store.entitySupport({
      name: "users",
      fields: [{ name: "email", type: [TYPE_TAGS.STRING] }],
    }),
  );
  const refined = store.entitySupport({
    name: "users",
    fields: [{ name: "email", type: [TYPE_TAGS.STRING, "email"] }],
  });
  assertEquals(await store.entityStatus(refined), "live");
});

// ── Custom-entity round-trip ──────────────────────────────────────

Deno.test("MemoryStore - custom entity: write/read round-trip retains values", async () => {
  const store = new MemoryStore();
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
  assert((rec as EntityRecord).blob === blob);
  assertEquals((rec as EntityRecord).extras, { tags: ["a"] });
});

Deno.test("MemoryStore - custom entity: read miss returns undefined", async () => {
  const store = new MemoryStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  const [[, rec]] = await store.read(meta, ["data://users/none"]);
  assertEquals(rec, undefined);
});

Deno.test("MemoryStore - custom entity: delete removes the record", async () => {
  const store = new MemoryStore();
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

// ── Multi-entity isolation ────────────────────────────────────────

Deno.test("MemoryStore - hosts multiple entities side-by-side without interference", async () => {
  const store = new MemoryStore();
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
  assertEquals(u, { name: "Alice" });
  assertEquals(p, { title: "Hello" });
});

Deno.test("MemoryStore - BYTES_ENTITY and a custom entity at the same URI do not interfere", async () => {
  const store = new MemoryStore();
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
  assertEquals(rec, { name: "entity-side" });
});

// ── Strict validation: error reporting, no silent drops ───────────

Deno.test("MemoryStore - write with extra fields reports a per-entry error", async () => {
  const store = new MemoryStore();
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

Deno.test("MemoryStore - non-bytes value on a bytes field fails the entry with a structured error", async () => {
  // Mixed-batch shape: the good entry still succeeds, the bad one
  // carries the structured failure with its uri (atomicBatch: false).
  const store = new MemoryStore();
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  const results = await store.write(meta, [
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

// ── Natural failure for unprovisioned entities ────────────────────

Deno.test("MemoryStore.write - unprovisioned entity surfaces per-entry storage failure", async () => {
  const store = new MemoryStore();
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

Deno.test("MemoryStore.read - unprovisioned entity returns undefined payloads", async () => {
  const store = new MemoryStore();
  const meta = store.entitySupport({
    name: "fresh",
    fields: [{ name: "k", type: [TYPE_TAGS.STRING] }],
  });
  const [[, rec]] = await store.read(meta, ["data://fresh/1"]);
  assertEquals(rec, undefined);
});

Deno.test("MemoryStore.delete - unprovisioned entity surfaces per-entry storage failure", async () => {
  const store = new MemoryStore();
  const meta = store.entitySupport({
    name: "fresh",
    fields: [{ name: "k", type: [TYPE_TAGS.STRING] }],
  });
  const [r] = await store.delete(meta, ["data://fresh/1"]);
  assertEquals(r.success, false);
  assert(r.error?.includes("not provisioned"));
});

// ── Status ────────────────────────────────────────────────────────

Deno.test("MemoryStore.status - lists every provisioned entity", async () => {
  const store = new MemoryStore();
  const bytesMeta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(bytesMeta);
  await store.write(bytesMeta, [{
    uri: "mutable://app/x",
    record: { payload: new Uint8Array([1]) },
  }]);
  await store.provisionEntity(store.entitySupport(userSchema));
  const s = await store.status();
  assert((s.schema ?? []).includes("entity:bytes"));
  assert((s.schema ?? []).includes("entity:users"));
});
