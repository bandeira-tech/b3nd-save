/**
 * FsStore unit tests.
 *
 * The shared store suite covers `BYTES_ENTITY` end-to-end. The
 * remainder of this file covers entity-level behaviour: `entitySupport`
 * purity, `entityStatus` collision detection, `provisionEntity`
 * idempotence and collision-throwing, custom-entity JSON round-trip
 * (bytes/bigint/timestamp), ls/count parity, multi-entity isolation,
 * strict validation, status, and the natural-failure path when ops run
 * against an unprovisioned entity.
 *
 * Uses a mock FsExecutor backed by an in-memory Map.
 */

/// <reference lib="deno.ns" />

import { assert, assertEquals, assertRejects } from "@std/assert";
import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { FsStore } from "./store.ts";
import type { FsExecutor } from "./mod.ts";
import { toBytes } from "../payload.ts";
import type { StorePayload } from "../types.ts";
import { BYTES_ENTITY, type EntityRecord, TYPE_TAGS } from "../entity.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** In-memory filesystem executor that simulates file operations. */
function createMockFsExecutor(): FsExecutor {
  const files = new Map<string, Uint8Array>();

  return {
    readFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`File not found: ${path}`);
      }
      return new Response(content as BodyInit).body!;
    },

    writeFile: async (path: string, content: StorePayload) => {
      files.set(path, await toBytes(content));
    },

    removeFile: async (path: string) => {
      files.delete(path);
    },

    exists: async (path: string) => {
      // Root dir always exists, or check if any file starts with this path
      if (path === "/tmp/test-store") return true;
      return files.has(path) ||
        [...files.keys()].some((k) => k.startsWith(path));
    },

    listFiles: async (dir: string) => {
      // FsStore expects just filenames (not full paths) from the given directory
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const results: string[] = [];
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          // Return just the filename relative to the directory
          const relative = key.slice(prefix.length);
          // Only return direct children (no nested paths)
          if (!relative.includes("/")) {
            results.push(relative);
          }
        }
      }
      return results;
    },

    walkFiles: async function* (dir: string) {
      // Deep walk: yield every file under `dir` as a path relative to
      // `dir` (any depth). Missing/empty dir → no yields, no throw.
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          yield key.slice(prefix.length);
        }
      }
    },
  };
}

function freshStore() {
  return new FsStore("/tmp/test-store", createMockFsExecutor());
}

runSharedStoreSuite("FsStore", { create: () => freshStore() });

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

Deno.test("FsStore.entitySupport — reports canonical tags as supported", () => {
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

Deno.test("FsStore.entitySupport — flags unrecognised tags as unsupported", () => {
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

Deno.test("FsStore.entitySupport — pure: does not flip status to live", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  assertEquals(await store.entityStatus(meta), "unprovisioned");
});

Deno.test("FsStore.entityStatus — reports live only after provisionEntity", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  assertEquals(await store.entityStatus(meta), "live");
});

Deno.test("FsStore.entityStatus — same-name different-shape reports unprovisioned", async () => {
  const store = freshStore();
  await store.provisionEntity(store.entitySupport(userSchema));
  const collision = store.entitySupport({
    name: "users",
    fields: [{ name: "name", type: [TYPE_TAGS.STRING] }],
  });
  assertEquals(await store.entityStatus(collision), "unprovisioned");
});

Deno.test("FsStore.provisionEntity — idempotent on identical meta", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.provisionEntity(meta);
  assertEquals(await store.entityStatus(meta), "live");
});

Deno.test("FsStore.provisionEntity — throws on same-name different-shape", async () => {
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

Deno.test("FsStore.provisionEntity — throws on same-field tag swap", async () => {
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

// ── Custom-entity JSON round-trip (typed values across the boundary) ──

Deno.test("FsStore — custom entity: write/read round-trips string/number/bytes/json", async () => {
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

Deno.test("FsStore — custom entity: bigint round-trips through JSON", async () => {
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

Deno.test("FsStore — custom entity: timestamp round-trips through JSON", async () => {
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

Deno.test("FsStore — custom entity: read miss returns undefined", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  const [[, rec]] = await store.read(meta, ["data://users/none"]);
  assertEquals(rec, undefined);
});

Deno.test("FsStore — custom entity: delete removes the record", async () => {
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

Deno.test("FsStore — custom entity: ls returns direct leaves under the entity prefix", async () => {
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

Deno.test("FsStore — custom entity: ls supports limit + page + sortOrder", async () => {
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

Deno.test("FsStore — custom entity: count returns the number of direct leaves", async () => {
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

Deno.test("FsStore — hosts multiple entities side-by-side without interference", async () => {
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

Deno.test("FsStore — BYTES_ENTITY and a custom entity at the same URI do not interfere", async () => {
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

Deno.test("FsStore — write with extra fields reports a per-entry error", async () => {
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

Deno.test("FsStore.write — unprovisioned entity surfaces per-entry storage failure", async () => {
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

Deno.test("FsStore.read — unprovisioned entity returns undefined payloads", async () => {
  const store = freshStore();
  const meta = store.entitySupport({
    name: "fresh",
    fields: [{ name: "k", type: [TYPE_TAGS.STRING] }],
  });
  const [[, rec]] = await store.read(meta, ["data://fresh/1"]);
  assertEquals(rec, undefined);
});

Deno.test("FsStore.delete — unprovisioned entity surfaces per-entry storage failure", async () => {
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

Deno.test("FsStore.status — lists every provisioned entity", async () => {
  const store = freshStore();
  await store.provisionEntity(store.entitySupport(BYTES_ENTITY));
  await store.provisionEntity(store.entitySupport(userSchema));
  const s = await store.status();
  const schema = s.schema ?? [];
  assert(schema.includes("entity:bytes"));
  assert(schema.includes("entity:users"));
});

Deno.test("FsStore.status — advertises 'find' in fns (v2 §3.5)", async () => {
  const s = await freshStore().status();
  // The full set: read / ls / find / count
  assertEquals(s.fns?.sort(), ["count", "find", "ls", "read"]);
});

// ── fn=find (v2 §3.3, §3.5) ──────────────────────────────────────────

Deno.test("FsStore — fn=find walks the full subtree", async () => {
  const store = freshStore();
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  // Deep tree: root + alice/msg/* + bob/msg/*
  const uris = [
    "x://room/meta.md",
    "x://room/alice/msg/1.md",
    "x://room/alice/msg/2.md",
    "x://room/bob/msg/1.md",
    "x://room/bob/mention/alice.md",
  ];
  for (const uri of uris) {
    await store.write(meta, [{ uri, record: { payload: enc("x") } }]);
  }
  const [[, rows]] = await store.read<string[]>(meta, [
    "x://room/**?fn=find&format=uris&sortBy=uri",
  ]);
  // No limit → no cursor slot to strip.
  assertEquals((rows as string[]).slice().sort(), uris.slice().sort());
});

Deno.test("FsStore — fn=find applies the glob post-filter (recursive *)", async () => {
  const store = freshStore();
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  for (
    const uri of [
      "x://room/alice/msg/1.md",
      "x://room/alice/msg/2.md",
      "x://room/bob/msg/1.md",
      "x://room/bob/mention/alice.md",
    ]
  ) {
    await store.write(meta, [{ uri, record: { payload: enc("y") } }]);
  }
  const [[, rows]] = await store.read<string[]>(meta, [
    "x://room/**/msg/*.md?fn=find&format=uris&sortBy=uri",
  ]);
  assertEquals((rows as string[]).sort(), [
    "x://room/alice/msg/1.md",
    "x://room/alice/msg/2.md",
    "x://room/bob/msg/1.md",
  ]);
});

Deno.test("FsStore — fn=find returns [] for empty/missing prefix (no throw)", async () => {
  const store = freshStore();
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  const [[, rows]] = await store.read<string[]>(meta, [
    "x://nothing/**?fn=find&format=uris",
  ]);
  assertEquals(rows, []);
});

Deno.test("FsStore — fn=find honours limit + cursor (paginated walk)", async () => {
  const store = freshStore();
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  for (const n of ["a", "b", "c", "d", "e"]) {
    await store.write(meta, [{
      uri: `x://p/sub/${n}.md`,
      record: { payload: enc(n) },
    }]);
  }
  const [[, page1]] = await store.read<unknown[]>(meta, [
    "x://p/**?fn=find&format=uris&sortBy=uri&limit=2",
  ]);
  const p1 = page1 as unknown[];
  // last element is the cursor slot
  const slot1 = p1[p1.length - 1] as [string, { next: string | null }];
  assertEquals(p1.slice(0, -1), ["x://p/sub/a.md", "x://p/sub/b.md"]);
  assert(slot1[1].next !== null, "cursor should advance");
  // Re-issue with the slot URI literally.
  const [[, page2]] = await store.read<unknown[]>(meta, [slot1[0]]);
  const p2 = page2 as unknown[];
  assertEquals(p2.slice(0, -1), ["x://p/sub/c.md", "x://p/sub/d.md"]);
});

Deno.test("FsStore — fn=find returns full records when format=full", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.write(meta, [
    {
      uri: "data://users/team/alice",
      record: { name: "Alice", age: 30 },
    },
    {
      uri: "data://users/team/bob",
      record: { name: "Bob", age: 31 },
    },
  ]);
  const [[, rows]] = await store.read<Array<[string, EntityRecord]>>(meta, [
    "data://users/**?fn=find&sortBy=uri",
  ]);
  const got = (rows as Array<[string, EntityRecord]>).map(([u, r]) => [
    u,
    r.name,
  ]);
  assertEquals(got, [
    ["data://users/team/alice", "Alice"],
    ["data://users/team/bob", "Bob"],
  ]);
});

Deno.test("FsStore — fn=ls is still shallow after fn=find lands", async () => {
  const store = freshStore();
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "x://room/top.md", record: { payload: enc("t") } },
    { uri: "x://room/deep/inner.md", record: { payload: enc("i") } },
  ]);
  // fn=ls (no glob, default) — must only see direct leaves.
  const [[, rows]] = await store.read<string[]>(meta, [
    "x://room/?fn=ls&format=uris",
  ]);
  assertEquals(rows, ["x://room/top.md"]);
});

// ── walkFiles contract ───────────────────────────────────────────────

Deno.test("FsExecutor.walkFiles — yields nothing for missing dir", async () => {
  const exec = createMockFsExecutor();
  const out: string[] = [];
  for await (const p of exec.walkFiles("/does/not/exist")) out.push(p);
  assertEquals(out, []);
});

Deno.test("FsExecutor.walkFiles — yields nothing for empty dir", async () => {
  const exec = createMockFsExecutor();
  // No files written; any dir is effectively empty.
  const out: string[] = [];
  for await (const p of exec.walkFiles("/tmp/test-store")) out.push(p);
  assertEquals(out, []);
});

Deno.test("FsExecutor.walkFiles — yields deep paths relative to dir", async () => {
  const exec = createMockFsExecutor();
  // Seed via writeFile so walk has something to find. Paths are
  // absolute (the contract is "relative to the dir arg").
  await exec.writeFile("/tmp/test-store/a/b/c.bin", enc("x"));
  await exec.writeFile("/tmp/test-store/a/d.bin", enc("y"));
  await exec.writeFile("/tmp/test-store/top.bin", enc("z"));
  const out: string[] = [];
  for await (const p of exec.walkFiles("/tmp/test-store")) out.push(p);
  assertEquals(out.sort(), ["a/b/c.bin", "a/d.bin", "top.bin"]);
});
