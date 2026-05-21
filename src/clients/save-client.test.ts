/// <reference lib="deno.ns" />

import { assert, assertEquals, assertInstanceOf } from "@std/assert";
import { mapToBytes, passThroughRecord, SaveClient } from "./save-client.ts";
import { MemoryStore } from "../memory/store.ts";
import { BYTES_ENTITY, TYPE_TAGS } from "../entity.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: unknown) =>
  b instanceof Uint8Array ? new TextDecoder().decode(b) : "";

const userSchema = {
  name: "users",
  fields: [
    { name: "name", type: [TYPE_TAGS.STRING] },
    { name: "age", type: [TYPE_TAGS.NUMBER] },
  ],
};

const postSchema = {
  name: "posts",
  fields: [{ name: "title", type: [TYPE_TAGS.STRING] }],
};

async function bytesClient(
  store: MemoryStore = new MemoryStore(),
): Promise<SaveClient<Uint8Array | ReadableStream<Uint8Array>>> {
  const c = new SaveClient(mapToBytes, BYTES_ENTITY, store);
  await c.provision();
  return c;
}

async function usersClient(
  store: MemoryStore = new MemoryStore(),
): Promise<SaveClient<Record<string, unknown>>> {
  const c = new SaveClient(passThroughRecord, userSchema, store);
  await c.provision();
  return c;
}

// ── bytes mode (BYTES_ENTITY) ───────────────────────────────────────

Deno.test("SaveClient - target is set from the constructor arg", () => {
  const client = new SaveClient(mapToBytes, BYTES_ENTITY, new MemoryStore());
  assertEquals(client.target.name, BYTES_ENTITY.name);
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
    for await (const [, uris] of client.observe(["mutable://*"], ac.signal)) {
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

Deno.test("SaveClient.provision - reports support for the target", async () => {
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
  const support = await client.provision();
  assertEquals(support.entity, "mixed");
  assertEquals(support.supported, ["ok"]);
  assertEquals(support.unsupported.length, 1);
});

Deno.test("SaveClient.provision - idempotent across multiple calls", async () => {
  const client = new SaveClient(
    passThroughRecord,
    userSchema,
    new MemoryStore(),
  );
  const s1 = await client.provision();
  const s2 = await client.provision();
  assertEquals(s1, s2);
});

Deno.test("SaveClient - receive without provision surfaces store failure", async () => {
  // No provision() — MemoryStore's bucket does not exist, write
  // surfaces a per-entry "not provisioned" storage failure.
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
  const users = new SaveClient(passThroughRecord, userSchema, store);
  const posts = new SaveClient(passThroughRecord, postSchema, store);
  await users.provision();
  await posts.provision();
  await users.receive([["data://u/alice", { name: "Alice", age: 30 }]]);
  await posts.receive([["data://p/hi", { title: "Hello" }]]);
  const userMeta = store.entitySupport(userSchema);
  const postMeta = store.entitySupport(postSchema);
  const [[, u]] = await store.read(userMeta, ["data://u/alice"]);
  const [[, p]] = await store.read(postMeta, ["data://p/hi"]);
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
      const [, uris] of client.observe(["data://users/*"], ac.signal)
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
  const store = new MemoryStore();
  // Wire: a JSON-like user blob. The mapper picks out the fields the
  // schema declares and drops the rest.
  type Wire = { id: string; name: string; age: number; extra: string };
  const client = new SaveClient<Wire>(
    (_uri, w) => ({ name: w.name, age: w.age }),
    userSchema,
    store,
  );
  await client.provision();

  const [res] = await client.receive([
    [
      "data://users/alice",
      { id: "alice", name: "Alice", age: 30, extra: "ignored" },
    ],
  ]);
  assertEquals(res.accepted, true);

  const meta = store.entitySupport(userSchema);
  const [[, rec]] = await store.read(meta, ["data://users/alice"]);
  assertEquals(rec, { name: "Alice", age: 30 });
});

Deno.test("SaveClient.mapper - thrown error becomes a per-entry failure", async () => {
  const client = new SaveClient<string>(
    (_uri, json) => {
      const parsed = JSON.parse(json) as { name?: string; age?: number };
      if (!parsed.name) throw new Error("name is required");
      return { name: parsed.name, age: parsed.age ?? 0 };
    },
    userSchema,
    new MemoryStore(),
  );
  await client.provision();

  const results = await client.receive([
    ["data://users/a", JSON.stringify({ name: "Alice", age: 30 })],
    ["data://users/b", JSON.stringify({ age: 25 })], // missing name
  ]);
  assertEquals(results[0].accepted, true);
  assertEquals(results[1].accepted, false);
  assert(results[1].error?.includes("name is required"));
});

Deno.test("SaveClient.mapper - encodes structured wire payloads into BYTES_ENTITY", async () => {
  const client = new SaveClient<{ msg: string }>(
    (_uri, obj) => ({ payload: new TextEncoder().encode(JSON.stringify(obj)) }),
    BYTES_ENTITY,
    new MemoryStore(),
  );
  await client.provision();

  await client.receive([["mutable://greet", { msg: "hello" }]]);
  const [[, bytes]] = await client.read(["mutable://greet"]);
  assertEquals(dec(bytes), JSON.stringify({ msg: "hello" }));
});
