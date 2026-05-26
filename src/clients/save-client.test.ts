/// <reference lib="deno.ns" />

import { assert, assertEquals, assertInstanceOf } from "@std/assert";
import { mapToBytes, passThroughRecord, SaveClient } from "./save-client.ts";
import { MemoryStore } from "../memory/store.ts";
import { BYTES_ENTITY, type EntitySchema, TYPE_TAGS } from "../entity.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: unknown) =>
  b instanceof Uint8Array ? new TextDecoder().decode(b) : "";

const userSchema: EntitySchema = {
  name: "users",
  fields: [
    { name: "name", type: [TYPE_TAGS.STRING] },
    { name: "age", type: [TYPE_TAGS.NUMBER] },
  ],
};

const postSchema: EntitySchema = {
  name: "posts",
  fields: [{ name: "title", type: [TYPE_TAGS.STRING] }],
};

/** Provision a schema on a store out of band, then return the store. */
async function provisioned(
  store: MemoryStore,
  schema: EntitySchema,
): Promise<MemoryStore> {
  await store.provisionEntity(store.entitySupport(schema));
  return store;
}

async function bytesClient(
  store: MemoryStore = new MemoryStore(),
): Promise<SaveClient<Uint8Array | ReadableStream<Uint8Array>>> {
  await provisioned(store, BYTES_ENTITY);
  return new SaveClient(mapToBytes, BYTES_ENTITY, store);
}

async function usersClient(
  store: MemoryStore = new MemoryStore(),
): Promise<SaveClient<Record<string, unknown>>> {
  await provisioned(store, userSchema);
  return new SaveClient(passThroughRecord, userSchema, store);
}

// ── bytes mode (BYTES_ENTITY) ───────────────────────────────────────

Deno.test("SaveClient - target is set from the constructor arg", () => {
  const client = new SaveClient(mapToBytes, BYTES_ENTITY, new MemoryStore());
  assertEquals(client.target.name, BYTES_ENTITY.name);
});

Deno.test("SaveClient - meta is derived from the store at construction", () => {
  const client = new SaveClient(mapToBytes, BYTES_ENTITY, new MemoryStore());
  assertEquals(client.meta.support.entity, BYTES_ENTITY.name);
  assertEquals(client.meta.support.supported, ["payload"]);
  assertEquals(client.meta.support.unsupported, []);
});

Deno.test("SaveClient - bytes: receive writes bytes at the URI", async () => {
  const client = await bytesClient();
  const [res] = await client.receive([["mutable://app/config", enc("dark")]]);
  assertEquals(res.accepted, true);
  const [[, bytes]] = await client.read(["mutable://app/config"]);
  assertInstanceOf(bytes as Uint8Array, Uint8Array);
  assertEquals(dec(bytes), "dark");
});

Deno.test("SaveClient - bytes: batch receive preserves order", async () => {
  const client = await bytesClient();
  const results = await client.receive([
    ["mutable://app/a", enc("A")],
    ["mutable://app/b", enc("B")],
    ["mutable://app/c", enc("C")],
  ]);
  assertEquals(results.length, 3);
  assert(results.every((r) => r.accepted));
  const read = await client.read([
    "mutable://app/a",
    "mutable://app/b",
    "mutable://app/c",
  ]);
  assertEquals(dec(read[0]?.[1]), "A");
  assertEquals(dec(read[1]?.[1]), "B");
  assertEquals(dec(read[2]?.[1]), "C");
});

Deno.test("SaveClient - bytes: null payload deletes", async () => {
  const client = await bytesClient();
  await client.receive([["mutable://x", enc("a")]]);
  const [d] = await client.receive([["mutable://x", null]]);
  assertEquals(d.accepted, true);
  const [[, after]] = await client.read(["mutable://x"]);
  assertEquals(after, undefined);
});

Deno.test("SaveClient - bytes: observe emits on receive and delete", async () => {
  const client = await bytesClient();
  const ac = new AbortController();
  const events: string[] = [];
  const reader = (async () => {
    for await (const uris of client.observe(["mutable://*"], ac.signal)) {
      for (const u of uris) events.push(u);
    }
  })();
  await client.receive([["mutable://app/x", enc("v")]]);
  await client.receive([["mutable://app/x", null]]);
  await new Promise((r) => setTimeout(r, 5));
  ac.abort();
  await reader.catch(() => {});
  assert(events.length >= 1);
});

Deno.test("SaveClient - status delegates to the store", async () => {
  const status = await (await bytesClient()).status();
  assertEquals(status.status, "healthy");
});

// ── entity mode (custom target) ─────────────────────────────────────

Deno.test("SaveClient - entity: receive writes a record and read returns it", async () => {
  const client = await usersClient();
  const [res] = await client.receive([
    ["data://users/alice", { name: "Alice", age: 30 }],
  ]);
  assertEquals(res.accepted, true);
  const [[uri, rec]] = await client.read(["data://users/alice"]);
  assertEquals(uri, "data://users/alice");
  assertEquals(rec, { name: "Alice", age: 30 });
});

Deno.test("SaveClient - entity: null payload deletes the record", async () => {
  const client = await usersClient();
  await client.receive([["data://users/alice", { name: "Alice", age: 30 }]]);
  const [res] = await client.receive([["data://users/alice", null]]);
  assertEquals(res.accepted, true);
  const [[, rec]] = await client.read(["data://users/alice"]);
  assertEquals(rec, undefined);
});

Deno.test("SaveClient.meta - reports support for the target", () => {
  const client = new SaveClient(
    passThroughRecord,
    {
      name: "mixed",
      fields: [
        { name: "ok", type: [TYPE_TAGS.STRING] },
        { name: "weird", type: ["not-a-known-tag"] },
      ],
    },
    new MemoryStore(),
  );
  assertEquals(client.meta.support.entity, "mixed");
  assertEquals(client.meta.support.supported, ["ok"]);
  assertEquals(client.meta.support.unsupported.length, 1);
});

Deno.test("SaveClient - receive without out-of-band provisioning surfaces store failure", async () => {
  // Caller forgot to provision the store — MemoryStore's bucket does
  // not exist, write surfaces a per-entry "not provisioned" storage
  // failure. SaveClient never auto-provisions: that's the caller's job.
  const client = new SaveClient(
    passThroughRecord,
    userSchema,
    new MemoryStore(),
  );
  const [res] = await client.receive([
    ["data://users/alice", { name: "Alice", age: 30 }],
  ]);
  assertEquals(res.accepted, false);
  assert(res.error?.includes("not provisioned"));
});

Deno.test("SaveClient - one store, multiple entities via separate clients", async () => {
  const store = new MemoryStore();
  await store.provisionEntity(store.entitySupport(userSchema));
  await store.provisionEntity(store.entitySupport(postSchema));
  const users = new SaveClient(passThroughRecord, userSchema, store);
  const posts = new SaveClient(passThroughRecord, postSchema, store);
  await users.receive([["data://u/alice", { name: "Alice", age: 30 }]]);
  await posts.receive([["data://p/hi", { title: "Hello" }]]);
  // Re-derive the typed meta for store-level reads — `client.meta` is
  // EntityMeta (the base type) so it doesn't carry the store-specific
  // shape needed by MemoryStore.read.
  const [[, u]] = await store.read(
    store.entitySupport(userSchema),
    ["data://u/alice"],
  );
  const [[, p]] = await store.read(
    store.entitySupport(postSchema),
    ["data://p/hi"],
  );
  assertEquals(u, { name: "Alice", age: 30 });
  assertEquals(p, { title: "Hello" });
});

Deno.test("SaveClient - entity: mismatched record surfaces the store error", async () => {
  const client = await usersClient();
  const [res] = await client.receive([
    ["data://users/alice", { name: "Alice", extra: "bad" }],
  ]);
  assertEquals(res.accepted, false);
  assert(res.error?.includes("not declared"));
});

Deno.test("SaveClient - entity: observe emits on write and delete", async () => {
  const client = await usersClient();
  const ac = new AbortController();
  const events: string[] = [];
  const reader = (async () => {
    for await (
      const uris of client.observe(["data://users/*"], ac.signal)
    ) {
      for (const u of uris) events.push(u);
    }
  })();
  await client.receive([["data://users/alice", { name: "Alice" }]]);
  await client.receive([["data://users/alice", null]]);
  await new Promise((r) => setTimeout(r, 5));
  ac.abort();
  await reader.catch(() => {});
  assert(events.length >= 1);
});

// ── mapper ──────────────────────────────────────────────────────────

Deno.test("SaveClient.mapper - projects custom wire shape into the schema", async () => {
  const store = await provisioned(new MemoryStore(), userSchema);
  // Wire: a JSON-like user blob. The mapper picks out the fields the
  // schema declares and drops the rest.
  type Wire = { id: string; name: string; age: number; extra: string };
  const client = new SaveClient<Wire>(
    (_uri, w) => ({ name: w.name, age: w.age }),
    userSchema,
    store,
  );

  const [res] = await client.receive([
    [
      "data://users/alice",
      { id: "alice", name: "Alice", age: 30, extra: "ignored" },
    ],
  ]);
  assertEquals(res.accepted, true);

  const [[, rec]] = await store.read(
    store.entitySupport(userSchema),
    ["data://users/alice"],
  );
  assertEquals(rec, { name: "Alice", age: 30 });
});

Deno.test("SaveClient.mapper - thrown error becomes a per-entry failure", async () => {
  const store = await provisioned(new MemoryStore(), userSchema);
  const client = new SaveClient<string>(
    (_uri, json) => {
      const parsed = JSON.parse(json) as { name?: string; age?: number };
      if (!parsed.name) throw new Error("name is required");
      return { name: parsed.name, age: parsed.age ?? 0 };
    },
    userSchema,
    store,
  );

  const results = await client.receive([
    ["data://users/a", JSON.stringify({ name: "Alice", age: 30 })],
    ["data://users/b", JSON.stringify({ age: 25 })], // missing name
  ]);
  assertEquals(results[0].accepted, true);
  assertEquals(results[1].accepted, false);
  assert(results[1].error?.includes("name is required"));
});

Deno.test("SaveClient.mapper - encodes structured wire payloads into BYTES_ENTITY", async () => {
  const store = await provisioned(new MemoryStore(), BYTES_ENTITY);
  const client = new SaveClient<{ msg: string }>(
    (_uri, obj) => ({ payload: new TextEncoder().encode(JSON.stringify(obj)) }),
    BYTES_ENTITY,
    store,
  );

  await client.receive([["mutable://greet", { msg: "hello" }]]);
  const [[, bytes]] = await client.read(["mutable://greet"]);
  assertEquals(dec(bytes), JSON.stringify({ msg: "hello" }));
});
