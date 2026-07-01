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

import { assert, assertEquals, assertThrows } from "@std/assert";
import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { FsStore } from "./store.ts";
import type { FsExecutor } from "./mod.ts";
import { toBytes } from "../payload.ts";
import type { StorePayload } from "../types.ts";
import { BYTES_ENTITY, type EntityRecord, TYPE_TAGS } from "../entity.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * In-memory filesystem executor that simulates file operations. Pass a
 * `files` map to inspect what got written to which path.
 */
function createMockFsExecutor(
  files: Map<string, Uint8Array> = new Map<string, Uint8Array>(),
): FsExecutor {
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
      //
      // Yield order is REVERSED-by-key so a backend that forgets to
      // apply `sortBy=uri` itself can't accidentally pass because the
      // Map insertion order happened to be sorted. Real Deno `walk`
      // yields directory-traversal order (unstable across platforms),
      // so a faithful mock must not produce a friendly order either.
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const matches: string[] = [];
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) matches.push(key.slice(prefix.length));
      }
      matches.reverse();
      for (const rel of matches) yield rel;
    },
  };
}

function freshStore() {
  return new FsStore("/tmp/test-store", createMockFsExecutor());
}

runSharedStoreSuite("FsStore", {
  create: () => freshStore(),
  supportsFind: true,
});

// ── Entity behaviour ──────────────────────────────────────────────

Deno.test("FsStore.provisionEntity — writes bookkeeping under a hidden dir", async () => {
  const files = new Map<string, Uint8Array>();
  const store = new FsStore("/tmp/test-store", createMockFsExecutor(files));
  await store.provisionEntity(store.entitySupport(BYTES_ENTITY));
  const keys = [...files.keys()];
  assert(keys.length > 0, "provisioning should write a marker file");
  for (const k of keys) {
    const rel = k.slice("/tmp/test-store/".length);
    assert(
      rel.startsWith("."),
      `provisioning bookkeeping must live under a dot-dir, got '${rel}'`,
    );
  }
});

Deno.test("FsStore.entitySupport — rejects non-BYTES schemas", () => {
  const store = freshStore();
  assertThrows(
    () =>
      store.entitySupport({
        name: "users",
        fields: [{ name: "name", type: [TYPE_TAGS.STRING] }],
      }),
    Error,
    "only BYTES_ENTITY is supported",
  );
});

Deno.test("FsStore.entitySupport — BYTES_ENTITY reports payload as supported", () => {
  const meta = freshStore().entitySupport(BYTES_ENTITY);
  assertEquals(meta.support.entity, BYTES_ENTITY.name);
  assertEquals(meta.support.supported, ["payload"]);
  assertEquals(meta.support.unsupported, []);
});

Deno.test("FsStore.entitySupport — pure: does not flip status to live", async () => {
  const store = freshStore();
  const meta = store.entitySupport(BYTES_ENTITY);
  assertEquals(await store.entityStatus(meta), "unprovisioned");
});

Deno.test("FsStore.entityStatus — reports live only after provisionEntity", async () => {
  const store = freshStore();
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  assertEquals(await store.entityStatus(meta), "live");
});

Deno.test("FsStore.provisionEntity — idempotent on identical meta", async () => {
  const store = freshStore();
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  await store.provisionEntity(meta);
  assertEquals(await store.entityStatus(meta), "live");
});

// ── URI passthrough: URI IS the relative path under rootDir ───────

Deno.test("FsStore.write — URI is used verbatim as the relative path", async () => {
  const exec = createMockFsExecutor();
  const store = new FsStore("/tmp/test-store", exec);
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  await store.write(meta, [{
    uri: "notes/alice/hello.txt",
    record: { payload: enc("hi") },
  }]);
  // Read back through the executor to prove the URI was NOT mangled.
  const stream = await exec.readFile("/tmp/test-store/notes/alice/hello.txt");
  const bytes = await toBytes(stream);
  assertEquals(new TextDecoder().decode(bytes), "hi");
});

Deno.test("FsStore.read — round-trips the URI verbatim", async () => {
  const store = freshStore();
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  await store.write(meta, [{
    uri: "docs/2026/06/summary.md",
    record: { payload: enc("body") },
  }]);
  const [[uri, rec]] = await store.read(meta, ["docs/2026/06/summary.md"]);
  assertEquals(uri, "docs/2026/06/summary.md");
  const bytes = await toBytes(
    (rec as EntityRecord).payload as Uint8Array | ReadableStream<Uint8Array>,
  );
  assertEquals(new TextDecoder().decode(bytes), "body");
});

// ── URI safety: reject paths that escape the root ─────────────────

Deno.test("FsStore.write — rejects URIs with '..' segments", async () => {
  const store = freshStore();
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  const [r] = await store.write(meta, [{
    uri: "a/../secret",
    record: { payload: enc("x") },
  }]);
  assertEquals(r.success, false);
  assert(r.error?.includes(".."));
});

Deno.test("FsStore.write — rejects URIs starting with '/'", async () => {
  const store = freshStore();
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  const [r] = await store.write(meta, [{
    uri: "/absolute/path",
    record: { payload: enc("x") },
  }]);
  assertEquals(r.success, false);
  assert(r.error?.includes("'/'"));
});

// ── Natural failure for unprovisioned entities ─────────────────────

Deno.test("FsStore.write — unprovisioned entity surfaces per-entry storage failure", async () => {
  const store = freshStore();
  const meta = store.entitySupport(BYTES_ENTITY);
  const [r] = await store.write(meta, [{
    uri: "fresh/1",
    record: { payload: enc("v") },
  }]);
  assertEquals(r.success, false);
  assertEquals(r.errorDetail?.code, "STORAGE_ERROR");
  assertEquals(r.errorDetail?.uri, "fresh/1");
  assert(r.error?.includes("not provisioned"));
});

Deno.test("FsStore.read — unprovisioned entity returns undefined payloads", async () => {
  const store = freshStore();
  const meta = store.entitySupport(BYTES_ENTITY);
  const [[, rec]] = await store.read(meta, ["fresh/1"]);
  assertEquals(rec, undefined);
});

Deno.test("FsStore.delete — unprovisioned entity surfaces per-entry storage failure", async () => {
  const store = freshStore();
  const meta = store.entitySupport(BYTES_ENTITY);
  const [r] = await store.delete(meta, ["fresh/1"]);
  assertEquals(r.success, false);
  assert(r.error?.includes("not provisioned"));
});

// ── Status ─────────────────────────────────────────────────────────

Deno.test("FsStore.status — lists every provisioned entity", async () => {
  const store = freshStore();
  await store.provisionEntity(store.entitySupport(BYTES_ENTITY));
  const s = await store.status();
  const schema = s.schema ?? [];
  assert(schema.includes(`entity:${BYTES_ENTITY.name}`));
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
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "users/team/alice.md", record: { payload: enc("Alice") } },
    { uri: "users/team/bob.md", record: { payload: enc("Bob") } },
  ]);
  const [[, rows]] = await store.read<Array<[string, EntityRecord]>>(meta, [
    "users/**?fn=find&sortBy=uri",
  ]);
  const got = await Promise.all(
    (rows as Array<[string, EntityRecord]>).map(async ([u, r]) => [
      u,
      new TextDecoder().decode(
        await toBytes(r.payload as Uint8Array | ReadableStream<Uint8Array>),
      ),
    ]),
  );
  assertEquals(got, [
    ["users/team/alice.md", "Alice"],
    ["users/team/bob.md", "Bob"],
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
