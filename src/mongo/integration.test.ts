/**
 * MongoStore Integration Tests
 *
 * Runs the shared store suite against a real MongoDB instance.
 * Requires a running MongoDB — see CI workflow or:
 *   cd /Users/m0/ws/b3nd && make up p=test
 *
 * Env: MONGODB_URL (default: mongodb://localhost:57017/b3nd_test)
 */

/// <reference lib="deno.ns" />

import { assert, assertEquals, assertRejects } from "@std/assert";
import { MongoClient as NativeMongoClient } from "mongodb";
import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { MongoStore } from "./store.ts";
import { type EntityRecord, type EntitySchema, TYPE_TAGS } from "../entity.ts";
import type {
  MongoCollection,
  MongoExecutor,
  MongoFindManyOptions,
} from "./mod.ts";

const COLLECTION_PREFIX = "inttest";
const MONGODB_URL = Deno.env.get("MONGODB_URL") ??
  "mongodb://localhost:57017/b3nd_test";

let nativeClient: NativeMongoClient;

function createMongoExecutor(): MongoExecutor {
  nativeClient = new NativeMongoClient(MONGODB_URL);
  const db = nativeClient.db();

  const collectionOps = (name: string): MongoCollection => {
    const c = db.collection(name);
    return {
      async insertOne(doc) {
        const res = await c.insertOne(doc);
        return { acknowledged: res.acknowledged };
      },
      async updateOne(filter, update, options) {
        const res = await c.updateOne(filter, update, options);
        return {
          matchedCount: res.matchedCount,
          modifiedCount: res.modifiedCount,
          upsertedId: res.upsertedId,
        };
      },
      async findOne(filter) {
        const doc = await c.findOne(filter);
        return (doc ?? null) as Record<string, unknown> | null;
      },
      async findMany(filter, options?: MongoFindManyOptions) {
        let cursor = c.find(filter);
        if (options?.projection) cursor = cursor.project(options.projection);
        if (options?.sort) cursor = cursor.sort(options.sort);
        if (options?.skip !== undefined) cursor = cursor.skip(options.skip);
        if (options?.limit !== undefined) cursor = cursor.limit(options.limit);
        const docs = await cursor.toArray();
        return docs as Record<string, unknown>[];
      },
      async countDocuments(filter) {
        return await c.countDocuments(filter);
      },
      async deleteOne(filter) {
        const res = await c.deleteOne(filter);
        return { deletedCount: res.deletedCount };
      },
      async createIndex(spec) {
        await c.createIndex(spec);
      },
    };
  };

  return {
    collection: collectionOps,
    async createCollection(name) {
      try {
        await db.createCollection(name);
      } catch (err) {
        // The driver throws on namespace-exists; treat as no-op.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/exists|NamespaceExists/i.test(msg)) throw err;
      }
    },
    async listCollectionNames() {
      const infos = await db.listCollections({}, { nameOnly: true }).toArray();
      return infos.map((i) => i.name);
    },
    async ping() {
      await db.command({ ping: 1 });
      return true;
    },
    async cleanup() {
      await nativeClient.close();
    },
  };
}

/**
 * Drop every collection produced by the suite — the meta collection,
 * the bytes-entity collection, and every native-entity collection a
 * given run touches. `IF EXISTS` semantics via `.drop().catch()` so
 * we can call this idempotently at suite setup.
 */
async function wipeAll(): Promise<void> {
  const db = nativeClient.db();
  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((i) => i.name)
    .filter((n) => n.startsWith(`${COLLECTION_PREFIX}_`));
  for (const name of names) {
    await db.collection(name).drop().catch(() => {});
  }
}

runSharedStoreSuite("MongoStore (integration)", {
  create: async () => {
    const executor = createMongoExecutor();
    await wipeAll();
    return new MongoStore(COLLECTION_PREFIX, executor);
  },
  // v2 §3.5: MongoStore ships fn=find via Lucene/regex push-down (PR #83).
  supportsFind: true,
});

// ── Native entity collections ─────────────────────────────────────

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

async function freshEntityStore(): Promise<MongoStore> {
  const executor = createMongoExecutor();
  await wipeAll();
  return new MongoStore(COLLECTION_PREFIX, executor);
}

Deno.test({
  name:
    "MongoStore (integration) - provisionEntity provisions a per-entity collection",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = await freshEntityStore();
    const meta = store.entitySupport(userSchema);
    assertEquals(meta.support.entity, "users");
    assertEquals(meta.support.unsupported, []);
    assertEquals(
      meta.support.supported.sort(),
      ["active", "age", "avatar", "extras", "name"],
    );
    await store.provisionEntity(meta);

    const db = nativeClient.db();
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((i) => i.name);
    assert(names.includes(`${COLLECTION_PREFIX}_users_data`));
    assert(names.includes(`${COLLECTION_PREFIX}_meta`));
  },
});

Deno.test({
  name:
    "MongoStore (integration) - entitySupport is pure; entityStatus flips after provision",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = await freshEntityStore();
    const meta = store.entitySupport(userSchema);
    assertEquals(await store.entityStatus(meta), "unprovisioned");
    await store.provisionEntity(meta);
    assertEquals(await store.entityStatus(meta), "live");
  },
});

Deno.test({
  name:
    "MongoStore (integration) - provisionEntity throws on same-name different-shape",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = await freshEntityStore();
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
  },
});

Deno.test({
  name: "MongoStore (integration) - write/read round-trip on a custom entity",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = await freshEntityStore();
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
  },
});

Deno.test({
  name: "MongoStore (integration) - strict validation rejects extra fields",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = await freshEntityStore();
    const meta = store.entitySupport(userSchema);
    await store.provisionEntity(meta);
    const [r] = await store.write(meta, [{
      uri: "data://users/x",
      record: { name: "X", age: 0, mystery: "not declared" } as EntityRecord,
    }]);
    assertEquals(r.success, false);
    assert(r.error?.includes("not declared"));
    assertEquals(r.errorDetail?.uri, "data://users/x");
  },
});

Deno.test({
  name: "MongoStore (integration) - ls/count on a custom entity",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = await freshEntityStore();
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
  },
});

Deno.test({
  name: "MongoStore (integration) - delete removes from the entity collection",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = await freshEntityStore();
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
  },
});

Deno.test({
  name: "MongoStore (integration) - unsupported tags surface in EntitySupport",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = await freshEntityStore();
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
  },
});

// Cleanup after all tests
Deno.test({
  name: "MongoStore (integration) - cleanup",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    try {
      await wipeAll();
    } finally {
      await nativeClient.close();
    }
  },
});
