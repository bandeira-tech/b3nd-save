/**
 * S3Store unit tests.
 *
 * The shared store suite covers `BYTES_ENTITY` end-to-end. The
 * remainder of this file covers entity-level behaviour: `entitySupport`
 * purity, `entityStatus` collision detection, `provisionEntity`
 * idempotence and collision-throwing, custom-entity JSON round-trip
 * (bytes/bigint/timestamp), ls/count parity, multi-entity isolation,
 * strict validation, and the natural-failure path when ops run against
 * an unprovisioned entity.
 *
 * Uses a mock S3Executor backed by an in-memory Map.
 */

/// <reference lib="deno.ns" />

import { assert, assertEquals, assertRejects } from "@std/assert";
import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { S3Store } from "./store.ts";
import type { S3Executor } from "./mod.ts";
import { toBytes } from "../payload.ts";
import type { StorePayload } from "../types.ts";
import { BYTES_ENTITY, type EntityRecord, TYPE_TAGS } from "../entity.ts";

/** In-memory S3 executor that simulates S3 bucket operations. */
function createMockS3Executor(): S3Executor {
  const objects = new Map<string, Uint8Array>();

  return {
    putObject: async (
      key: string,
      body: StorePayload,
      _contentType: string,
    ) => {
      objects.set(key, await toBytes(body));
    },

    getObject: (key: string) => {
      const bytes = objects.get(key);
      if (bytes === undefined) return Promise.resolve(null);
      return Promise.resolve(new Response(bytes as BodyInit).body!);
    },

    deleteObject: async (key: string) => {
      objects.delete(key);
    },

    listObjects: async (prefix: string) => {
      return [...objects.keys()].filter((k) => k.startsWith(prefix));
    },

    headBucket: async () => true,
  };
}

function freshStore() {
  return new S3Store("test-bucket", createMockS3Executor());
}

runSharedStoreSuite("S3Store", {
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

Deno.test("S3Store.entitySupport — reports canonical tags as supported", () => {
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

Deno.test("S3Store.entitySupport — flags unrecognised tags as unsupported", () => {
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

Deno.test("S3Store.entitySupport — pure: does not flip status to live", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  assertEquals(await store.entityStatus(meta), "unprovisioned");
});

Deno.test("S3Store.entityStatus — reports live only after provisionEntity", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  assertEquals(await store.entityStatus(meta), "live");
});

Deno.test("S3Store.entityStatus — same-name different-shape reports unprovisioned", async () => {
  const store = freshStore();
  await store.provisionEntity(store.entitySupport(userSchema));
  const collision = store.entitySupport({
    name: "users",
    fields: [{ name: "name", type: [TYPE_TAGS.STRING] }],
  });
  assertEquals(await store.entityStatus(collision), "unprovisioned");
});

Deno.test("S3Store.provisionEntity — idempotent on identical meta", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.provisionEntity(meta);
  assertEquals(await store.entityStatus(meta), "live");
});

Deno.test("S3Store.provisionEntity — throws on same-name different-shape", async () => {
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

Deno.test("S3Store.provisionEntity — throws on same-field tag swap", async () => {
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

// ── Custom-entity JSON round-trip ──────────────────────────────────

Deno.test("S3Store — custom entity: write/read round-trips string/number/bytes/json", async () => {
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

Deno.test("S3Store — custom entity: bigint round-trips through JSON", async () => {
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

Deno.test("S3Store — custom entity: timestamp round-trips through JSON", async () => {
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

Deno.test("S3Store — custom entity: read miss returns undefined", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  const [[, rec]] = await store.read(meta, ["data://users/none"]);
  assertEquals(rec, undefined);
});

Deno.test("S3Store — custom entity: delete removes the record", async () => {
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

Deno.test("S3Store — custom entity: ls returns direct leaves under the entity prefix", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "data://users/alice", record: { name: "Alice" } },
    { uri: "data://users/bob", record: { name: "Bob" } },
  ]);
  const [[, rows]] = await store.read<Array<[string, EntityRecord]>>(meta, [
    "data://users/",
  ]);
  const uris = rows.map(([u]) => u).sort();
  assertEquals(uris, ["data://users/alice", "data://users/bob"]);
});

Deno.test("S3Store — custom entity: ls supports limit + page + sortOrder", async () => {
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

Deno.test("S3Store — custom entity: count returns the number of direct leaves", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "x://u/a", record: { name: "a" } },
    { uri: "x://u/b", record: { name: "b" } },
  ]);
  const [[, n]] = await store.read<number>(meta, ["x://u/?fn=count"]);
  assertEquals(n, 2);
});

// ── Multi-entity isolation ─────────────────────────────────────────

Deno.test("S3Store — hosts multiple entities side-by-side without interference", async () => {
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

Deno.test("S3Store — BYTES_ENTITY and a custom entity at the same URI do not interfere", async () => {
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
  const bytesPayload = await toBytes(
    (b as EntityRecord).payload as Uint8Array | ReadableStream<Uint8Array>,
  );
  assertEquals(new TextDecoder().decode(bytesPayload), "bytes-side");
  const [[, rec]] = await store.read(userMeta, ["data://users/alice"]);
  assertEquals((rec as EntityRecord).name, "entity-side");
});

// ── Strict validation: error reporting, no silent drops ────────────

Deno.test("S3Store — write with extra fields reports a per-entry error", async () => {
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

Deno.test("S3Store.write — unprovisioned entity surfaces per-entry storage failure", async () => {
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

Deno.test("S3Store.read — unprovisioned entity returns undefined payloads", async () => {
  const store = freshStore();
  const meta = store.entitySupport({
    name: "fresh",
    fields: [{ name: "k", type: [TYPE_TAGS.STRING] }],
  });
  const [[, rec]] = await store.read(meta, ["data://fresh/1"]);
  assertEquals(rec, undefined);
});

Deno.test("S3Store.delete — unprovisioned entity surfaces per-entry storage failure", async () => {
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

Deno.test("S3Store.status — lists every provisioned entity", async () => {
  const store = freshStore();
  await store.provisionEntity(store.entitySupport(BYTES_ENTITY));
  await store.provisionEntity(store.entitySupport(userSchema));
  const s = await store.status();
  const schema = s.schema ?? [];
  assert(schema.includes("entity:bytes"));
  assert(schema.includes("entity:users"));
});

Deno.test("S3Store.status — advertises 'find' in fns (v2 §3.5)", async () => {
  const s = await freshStore().status();
  assert(s.fns?.includes("find"));
});

// ── fn=find specifics ─────────────────────────────────────────────
//
// The shared find-conformance suite covers the v2 §3.5 behaviour
// generically. These S3-specific tests pin the design choice that
// makes the implementation natural here: `listObjects(prefix)` is
// already a deep walk (S3's flat keyspace), so the only delta from
// `_listChildUris` is dropping the `tail.includes("/")` filter. We
// assert that the deep walk actually crosses sub-prefix boundaries
// AND that ls remains shallow on the same data — the two paths
// stay distinct.

Deno.test("S3Store — fn=find deep-walks the flat keyspace (custom entity)", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "data://u/alice", record: { name: "Alice" } },
    { uri: "data://u/team/bob", record: { name: "Bob" } },
    { uri: "data://u/team/sub/carol", record: { name: "Carol" } },
  ]);
  const [[, raw]] = await store.read<string[]>(meta, [
    "data://u/**?fn=find&format=uris&sortBy=uri",
  ]);
  assertEquals(raw, [
    "data://u/alice",
    "data://u/team/bob",
    "data://u/team/sub/carol",
  ]);
});

Deno.test("S3Store — fn=ls remains shallow even when deep keys exist", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "data://u/alice", record: { name: "Alice" } },
    { uri: "data://u/team/bob", record: { name: "Bob" } },
    { uri: "data://u/team/sub/carol", record: { name: "Carol" } },
  ]);
  const [[, raw]] = await store.read<string[]>(meta, [
    "data://u/?fn=ls&format=uris&sortBy=uri",
  ]);
  // `_listChildUris` drops keys whose tail contains `/` — only the
  // direct leaf survives. Find (above) keeps them; ls drops them.
  assertEquals(raw, ["data://u/alice"]);
});
