/**
 * MongoStore unit tests — runs the shared suite against an in-memory
 * mock that fakes a multi-collection Mongo executor. The mock backs
 * each collection with a `Map<uri, Document>` and supports the subset
 * of operations the store actually emits (insert/update/upsert,
 * findOne, find with regex + sort + skip + limit + projection,
 * countDocuments, deleteOne, createIndex no-op).
 */

/// <reference lib="deno.ns" />

import { assertEquals, assertRejects } from "@std/assert";
import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { MongoStore } from "./store.ts";
import { BYTES_ENTITY, type EntitySchema, TYPE_TAGS } from "../entity.ts";
import type {
  MongoCollection,
  MongoExecutor,
  MongoFindManyOptions,
} from "./mod.ts";

interface MockCollection {
  docs: Map<string, Record<string, unknown>>;
  byId: Map<unknown, Record<string, unknown>>;
}

function filterRow(
  doc: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  for (const [k, expected] of Object.entries(filter)) {
    const actual = doc[k];
    if (expected && typeof expected === "object") {
      const ops = expected as Record<string, unknown>;
      if ("$regex" in ops) {
        const regex = new RegExp(ops.$regex as string);
        if (typeof actual !== "string" || !regex.test(actual)) return false;
      }
      if ("$gt" in ops) {
        if (
          typeof actual !== "string" ||
          actual.localeCompare(ops.$gt as string) <= 0
        ) return false;
      }
      if ("$lt" in ops) {
        if (
          typeof actual !== "string" ||
          actual.localeCompare(ops.$lt as string) >= 0
        ) return false;
      }
      // No operator keys matched: treat as full-object equality (unused
      // in our store but consistent with a real Mongo $eq fallback).
      const opKeys = Object.keys(ops);
      const knownOps = opKeys.every((k) =>
        k === "$regex" || k === "$gt" || k === "$lt"
      );
      if (!knownOps && actual !== expected) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function createMockMongoExecutor(): MongoExecutor {
  const collections = new Map<string, MockCollection>();

  const ensure = (name: string): MockCollection => {
    let c = collections.get(name);
    if (!c) {
      c = { docs: new Map(), byId: new Map() };
      collections.set(name, c);
    }
    return c;
  };

  const opsFor = (name: string): MongoCollection => {
    const coll = ensure(name);

    return {
      insertOne: (doc) => {
        const key = (doc._id as unknown) ?? doc.uri;
        coll.byId.set(key, { ...doc });
        if (typeof doc.uri === "string") coll.docs.set(doc.uri, { ...doc });
        return Promise.resolve({ acknowledged: true });
      },

      updateOne: (filter, update, options) => {
        const $set = (update as { $set?: Record<string, unknown> }).$set ?? {};
        const $setOnInsert =
          (update as { $setOnInsert?: Record<string, unknown> })
            .$setOnInsert ?? {};

        // Look up by _id first, then by uri.
        const byId = filter._id !== undefined
          ? coll.byId.get(filter._id)
          : undefined;
        const byUri = typeof filter.uri === "string"
          ? coll.docs.get(filter.uri)
          : undefined;
        const existing = byId ?? byUri;

        if (existing) {
          Object.assign(existing, $set);
          return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
        }
        if (options?.upsert) {
          const seed: Record<string, unknown> = {
            ...filter,
            ...$setOnInsert,
            ...$set,
          };
          const id = (seed._id as unknown) ?? seed.uri;
          coll.byId.set(id, seed);
          if (typeof seed.uri === "string") coll.docs.set(seed.uri, seed);
          return Promise.resolve({
            matchedCount: 0,
            modifiedCount: 0,
            upsertedId: id,
          });
        }
        return Promise.resolve({ matchedCount: 0, modifiedCount: 0 });
      },

      findOne: (filter) => {
        if (filter._id !== undefined) {
          return Promise.resolve(coll.byId.get(filter._id) ?? null);
        }
        if (typeof filter.uri === "string") {
          const direct = coll.docs.get(filter.uri);
          if (direct) return Promise.resolve(direct);
        }
        for (const doc of coll.docs.values()) {
          if (filterRow(doc, filter)) return Promise.resolve(doc);
        }
        return Promise.resolve(null);
      },

      findMany: (filter, options?: MongoFindManyOptions) => {
        let out = [...coll.docs.values()].filter((d) => filterRow(d, filter));
        if (options?.sort?.uri) {
          const dir = options.sort.uri;
          out = [...out].sort((a, b) =>
            (a.uri as string).localeCompare(b.uri as string) * dir
          );
        }
        if (options?.skip) out = out.slice(options.skip);
        if (options?.limit !== undefined) out = out.slice(0, options.limit);
        if (options?.projection) {
          out = out.map((d) => {
            const proj: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(options.projection!)) {
              if (v === 1 && k in d) proj[k] = d[k];
            }
            return proj;
          });
        }
        return Promise.resolve(out);
      },

      countDocuments: (filter) => {
        return Promise.resolve(
          [...coll.docs.values()].filter((d) => filterRow(d, filter)).length,
        );
      },

      deleteOne: (filter) => {
        if (typeof filter.uri === "string") {
          const existed = coll.docs.delete(filter.uri);
          coll.byId.delete(filter.uri);
          return Promise.resolve({ deletedCount: existed ? 1 : 0 });
        }
        return Promise.resolve({ deletedCount: 0 });
      },

      createIndex: () => Promise.resolve(),
    };
  };

  return {
    collection: opsFor,
    createCollection: (name) => {
      ensure(name);
      return Promise.resolve();
    },
    listCollectionNames: () => Promise.resolve([...collections.keys()]),
    ping: () => Promise.resolve(true),
  };
}

runSharedStoreSuite("MongoStore", {
  create: () => new MongoStore("test", createMockMongoExecutor()),
});

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

Deno.test("MongoStore - capabilities shape", () => {
  const caps = new MongoStore("test", createMockMongoExecutor()).capabilities();
  assertEquals(caps.atomicBatch, false);
});

Deno.test("MongoStore.entityStatus - unprovisioned before provisionEntity", async () => {
  const store = new MongoStore("test", createMockMongoExecutor());
  const meta = store.entitySupport(userSchema);
  assertEquals(await store.entityStatus(meta), "unprovisioned");
});

Deno.test("MongoStore.entityStatus - live after provisionEntity", async () => {
  const store = new MongoStore("test", createMockMongoExecutor());
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  assertEquals(await store.entityStatus(meta), "live");
});

Deno.test("MongoStore.provisionEntity - idempotent on identical meta", async () => {
  const store = new MongoStore("test", createMockMongoExecutor());
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.provisionEntity(meta);
  assertEquals(await store.entityStatus(meta), "live");
});

Deno.test("MongoStore.provisionEntity - throws on same-name different-shape", async () => {
  const store = new MongoStore("test", createMockMongoExecutor());
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

Deno.test("MongoStore.provisionEntity - throws on same-field tag swap", async () => {
  // Same fields, `age` flips from NUMBER to BIGINT — Mongo can't tell
  // from the medium, but the signature picks it up just like Memory does.
  const store = new MongoStore("test", createMockMongoExecutor());
  await store.provisionEntity(store.entitySupport(userSchema));
  await assertRejects(
    () =>
      store.provisionEntity(
        store.entitySupport({
          name: "users",
          fields: [
            { name: "name", type: [TYPE_TAGS.STRING] },
            { name: "age", type: [TYPE_TAGS.BIGINT] },
            { name: "active", type: [TYPE_TAGS.BOOLEAN] },
            { name: "extras", type: [TYPE_TAGS.JSON] },
            { name: "avatar", type: [TYPE_TAGS.BYTES] },
          ],
        }),
      ),
    Error,
    "different shape",
  );
});

Deno.test("MongoStore - empty batch returns empty results", async () => {
  const store = new MongoStore("test", createMockMongoExecutor());
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  assertEquals(await store.write(meta, []), []);
  assertEquals(await store.delete(meta, []), []);
});
