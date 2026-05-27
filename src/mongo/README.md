# `@bandeira-tech/b3nd-save/mongo`

MongoDB implementation of `EntityStore`. One layout for every schema, one
collection per entity, with collision detection handled out of band.

## How it works, in three takes

**1 — One collection per entity.** Each schema lives in its own collection named
`{prefix}_{entity}_data`, with `uri` as the primary key and one document field
per supported declared field, plus `createdAt` / `updatedAt`. A single
`MongoStore` instance hosts many entities side by side. `BYTES_ENTITY` is just
one entity with one `payload` field of BSON Binary — no special case.

**2 — Collision detection via a meta collection.** Mongo is schemaless on the
wire, so the store can't introspect a collection's intended shape the way the
SQL backends introspect column types. Instead, `{prefix}_meta` carries one
document per provisioned entity — `{ _id: entityName, signature }` — where the
signature folds the entity name and every field's canonical type tag into a
deterministic string. `provisionEntity` checks for an existing entry: matching
signature is a no-op, a different signature throws `"different shape"`. Same
strictness as MemoryStore, same outcome as Postgres / SQLite would catch via
column types.

**3 — Schemaless body, store-enforced shape at write time.** The store rejects
records that carry keys not declared on the meta (per-entry failure, same
wording as the SQL backends). It does **not** enforce per-tag value types at
write time: Mongo accepts any value at the BSON level, so type validation is
left to higher layers if they need it. Streams on `bytes` fields are collected
to `Uint8Array` per entry _before_ the write, so a stream failure surfaces as a
per-entry write failure rather than a partial document.

## Example

```ts
import { MongoStore } from "@bandeira-tech/b3nd-save/mongo";
import { TYPE_TAGS } from "@bandeira-tech/b3nd-save/entity";

const users = {
  name: "users",
  fields: [
    { name: "name", type: [TYPE_TAGS.STRING] },
    { name: "age", type: [TYPE_TAGS.NUMBER] },
    { name: "avatar", type: [TYPE_TAGS.BYTES] },
  ],
};

// `executor` is a MongoExecutor — see "Usage" below.
const store = new MongoStore("myapp", executor);

// Out-of-band setup: compile the meta, provision the entity once.
const meta = store.entitySupport(users);
await store.provisionEntity(meta);

// Write, read, delete — all keyed by the same meta.
await store.write(meta, [{
  uri: "data://users/alice",
  record: {
    name: "Alice",
    age: 30,
    avatar: new Uint8Array([1, 2, 3]),
  },
}]);

const [[, alice]] = await store.read(meta, ["data://users/alice"]);
// alice → { name: "Alice", age: 30, avatar: Uint8Array(3) [1, 2, 3] }

// fn=ls and fn=count push down to a regex prefix query.
const [[, count]] = await store.read<number>(meta, ["data://users/?fn=count"]);
```

To use it as a `ProtocolInterfaceNode` on a rig, wrap it in a `SaveClient` from
`@bandeira-tech/b3nd-save/clients` — the store stays the same.

## Usage

### Install the driver

This package does not pull `mongodb` itself — bring your own:

```sh
deno add npm:mongodb
```

### Adapt the driver to `MongoExecutor`

`MongoStore` does not talk to `mongodb` directly. It calls into a
`MongoExecutor` you supply, which is a small surface over the driver:

```ts
import { MongoClient } from "mongodb";
import type {
  MongoCollection,
  MongoExecutor,
} from "@bandeira-tech/b3nd-save/mongo";

const client = new MongoClient(Deno.env.get("MONGODB_URL")!);
const db = client.db();

const executor: MongoExecutor = {
  collection(name): MongoCollection {
    const c = db.collection(name);
    return {
      async insertOne(doc) {
        const r = await c.insertOne(doc);
        return { acknowledged: r.acknowledged };
      },
      async updateOne(filter, update, options) {
        const r = await c.updateOne(filter, update, options);
        return {
          matchedCount: r.matchedCount,
          modifiedCount: r.modifiedCount,
          upsertedId: r.upsertedId,
        };
      },
      async findOne(filter) {
        return (await c.findOne(filter)) ?? null;
      },
      async findMany(filter, options) {
        let cur = c.find(filter);
        if (options?.projection) cur = cur.project(options.projection);
        if (options?.sort) cur = cur.sort(options.sort);
        if (options?.skip !== undefined) cur = cur.skip(options.skip);
        if (options?.limit !== undefined) cur = cur.limit(options.limit);
        return (await cur.toArray()) as Record<string, unknown>[];
      },
      async countDocuments(filter) {
        return await c.countDocuments(filter);
      },
      async deleteOne(filter) {
        const r = await c.deleteOne(filter);
        return { deletedCount: r.deletedCount };
      },
      async createIndex(spec) {
        await c.createIndex(spec);
      },
    };
  },

  async createCollection(name) {
    try {
      await db.createCollection(name);
    } catch (err) {
      // Swallow "namespace exists" so the call is idempotent.
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
    await client.close();
  },
};
```

### Naming rules

Both `collectionPrefix` (constructor arg) and every schema's `name` must match
`/^[a-zA-Z][a-zA-Z0-9_]*$/`. Anything else throws at `new MongoStore(...)` or at
`entitySupport(schema)` respectively.

### Capabilities

`capabilities()` reports `{ atomicBatch: false }`. Writes happen one document at
a time; the package does not wrap them in a transaction. If a write fails
mid-batch, every entry before it has already landed. Plan accordingly if you
need atomicity across documents.
