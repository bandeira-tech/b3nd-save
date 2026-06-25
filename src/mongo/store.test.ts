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
import type { Output } from "@bandeira-tech/b3nd-core/types";
import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { MongoStore } from "./store.ts";
import { BYTES_ENTITY, type EntitySchema, TYPE_TAGS } from "../entity.ts";
import type { MongoEntityMeta } from "./store.ts";
import type {
  MongoCollection,
  MongoExecutor,
  MongoFindManyOptions,
} from "./mod.ts";

interface MockCollection {
  docs: Map<string, Record<string, unknown>>;
  byId: Map<unknown, Record<string, unknown>>;
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

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

// ── v2 §3.3: fn=find handler (deep walk via broader regex) ──────────

/**
 * Seed `BYTES_ENTITY` with a small tree under `mem://room/` covering
 * direct leaves, second-level entries, and a few deep siblings under
 * `alice/` so the find tests can exercise prefix, mid-`**`, and
 * shallow-vs-deep semantics on the same fixture.
 *
 * Tree:
 *   mem://room/meta.md           — direct leaf
 *   mem://room/top.md            — direct leaf
 *   mem://room/alice/msg/1.md    — depth-3 under alice/
 *   mem://room/alice/msg/2.md    — depth-3 under alice/
 *   mem://room/alice/profile.md  — depth-2 under alice/
 *   mem://room/bob/msg/9.md      — depth-3 under bob/
 */
async function seedRoomTree(store: MongoStore): Promise<MongoEntityMeta> {
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  const uris = [
    "mem://room/meta.md",
    "mem://room/top.md",
    "mem://room/alice/msg/1.md",
    "mem://room/alice/msg/2.md",
    "mem://room/alice/profile.md",
    "mem://room/bob/msg/9.md",
  ];
  await store.write(
    meta,
    uris.map((uri) => ({ uri, record: { payload: enc(uri) } })),
  );
  return meta;
}

function urisOf(outs: Output[]): string[] {
  return outs.map((o) => o[0]).sort();
}

/**
 * Drop the dispatch-appended cursor slot (`[<cursorUri>, { next }]`)
 * before asserting page contents. Same shape the shared suite uses.
 */
function dropCursorSlot(outs: Output[]): Output[] {
  if (outs.length === 0) return outs;
  const last = outs[outs.length - 1];
  if (
    Array.isArray(last) && last.length === 2 &&
    last[1] !== null && typeof last[1] === "object" &&
    !(last[1] instanceof Uint8Array) &&
    "next" in (last[1] as Record<string, unknown>)
  ) {
    return outs.slice(0, -1);
  }
  return outs;
}

Deno.test("MongoStore.find - ls still shallow (regression: no ** widening)", async () => {
  // The fn=ls path MUST continue to return direct leaves only —
  // adding fn=find must not relax the [^/]+ single-segment regex body
  // _ls uses when no pattern is set. We sanity-check by fetching the
  // direct leaves under mem://room/ and confirming the deep entries
  // (alice/msg/..., alice/profile.md, bob/msg/...) are absent.
  const store = new MongoStore("test", createMockMongoExecutor());
  const meta = await seedRoomTree(store);
  const outs = (await store.read(meta, ["mem://room/?fn=ls"])) as Output[];
  // dispatchRead returns one Output<T> per input URL whose payload is
  // the handler's result. For ls/find that payload is an Output[].
  const inner = outs[0][1] as Output[];
  const got = urisOf(inner);
  assertEquals(got, ["mem://room/meta.md", "mem://room/top.md"]);
});

Deno.test("MongoStore.find - returns deep matches under ** prefix", async () => {
  const store = new MongoStore("test", createMockMongoExecutor());
  const meta = await seedRoomTree(store);
  const outs = (await store.read(meta, ["mem://room/**?fn=find"])) as Output[];
  const inner = outs[0][1] as Output[];
  const got = urisOf(inner);
  assertEquals(got, [
    "mem://room/alice/msg/1.md",
    "mem://room/alice/msg/2.md",
    "mem://room/alice/profile.md",
    "mem://room/bob/msg/9.md",
    "mem://room/meta.md",
    "mem://room/top.md",
  ]);
});

Deno.test("MongoStore.find - restricted under sub-prefix (alice/**)", async () => {
  const store = new MongoStore("test", createMockMongoExecutor());
  const meta = await seedRoomTree(store);
  const outs =
    (await store.read(meta, ["mem://room/alice/**?fn=find"])) as Output[];
  const inner = outs[0][1] as Output[];
  const got = urisOf(inner);
  assertEquals(got, [
    "mem://room/alice/msg/1.md",
    "mem://room/alice/msg/2.md",
    "mem://room/alice/profile.md",
  ]);
});

Deno.test("MongoStore.find - mid-** pattern (**/msg/*)", async () => {
  // Mid-`**` is outside core's compilePattern subset; saveGlobToRegexBody
  // routes through the save-local path that emits `.*` for `**`. The
  // mongo handler splices the body into `^<prefix><body>$`, which the
  // mock evaluates as `new RegExp(...)`. This test guards that the
  // mid-** pattern actually filters (not just "returns everything").
  const store = new MongoStore("test", createMockMongoExecutor());
  const meta = await seedRoomTree(store);
  const outs = (await store.read(meta, [
    "mem://room/**/msg/*?fn=find",
  ])) as Output[];
  const inner = outs[0][1] as Output[];
  const got = urisOf(inner);
  assertEquals(got, [
    "mem://room/alice/msg/1.md",
    "mem://room/alice/msg/2.md",
    "mem://room/bob/msg/9.md",
  ]);
});

Deno.test("MongoStore.find - pagination via limit + cursor (push-down)", async () => {
  const store = new MongoStore("test", createMockMongoExecutor());
  const meta = await seedRoomTree(store);

  // First page: limit=2, sortBy=uri asc (the natural cursor pagination
  // order). The dispatch layer appends the cursor slot; the page itself
  // is the first two URIs in URI-sort order.
  const page1Outs = (await store.read(meta, [
    "mem://room/**?fn=find&sortBy=uri&limit=2",
  ])) as Output[];
  const page1 = dropCursorSlot(page1Outs[0][1] as Output[]);
  assertEquals(urisOf(page1), [
    "mem://room/alice/msg/1.md",
    "mem://room/alice/msg/2.md",
  ]);

  // The trailing slot carries the cursor for the next page. Re-issue
  // the slot URI literally and confirm we get the next two URIs.
  const slot = (page1Outs[0][1] as Output[])[
    (page1Outs[0][1] as Output[]).length - 1
  ];
  const slotUri = slot[0];
  const next = (slot[1] as { next: string | null }).next;
  if (next === null) throw new Error("expected non-null next cursor");

  const page2Outs = (await store.read(meta, [slotUri])) as Output[];
  const page2 = dropCursorSlot(page2Outs[0][1] as Output[]);
  assertEquals(urisOf(page2), [
    "mem://room/alice/profile.md",
    "mem://room/bob/msg/9.md",
  ]);
});

Deno.test("MongoStore.status advertises 'find'", async () => {
  const store = new MongoStore("test", createMockMongoExecutor());
  const status = await store.status();
  if (!status.fns) throw new Error("expected status.fns to be defined");
  assertEquals(status.fns.includes("find"), true);
  assertEquals(status.fns.includes("ls"), true);
  assertEquals(status.fns.includes("count"), true);
  assertEquals(status.fns.includes("read"), true);
});
