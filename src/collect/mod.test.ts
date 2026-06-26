/// <reference lib="deno.ns" />

import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { mapToBytes, SaveClient } from "../clients/save-client.ts";
import { MemoryStore } from "../memory/store.ts";
import { FsStore } from "../fs/store.ts";
import type { FsExecutor } from "../fs/mod.ts";
import type { StorePayload } from "../types.ts";
import { BYTES_ENTITY } from "../entity.ts";
import { BufferedSaveClient, collectBytes } from "./mod.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) =>
  b ? new TextDecoder().decode(b) : "";

// ── collectBytes ──

Deno.test("collectBytes: Uint8Array passes through", async () => {
  const bytes = enc("hello");
  const [uri, payload] = await collectBytes([
    "immutable://x/1",
    bytes,
  ]);
  assertEquals(uri, "immutable://x/1");
  assertInstanceOf(payload, Uint8Array);
  assertEquals(dec(payload), "hello");
});

Deno.test("collectBytes: null passes through", async () => {
  const [uri, payload] = await collectBytes(["immutable://x/2", null]);
  assertEquals(uri, "immutable://x/2");
  assertEquals(payload, null);
});

Deno.test("collectBytes: ReadableStream collects to Uint8Array", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc("hel"));
      c.enqueue(enc("lo"));
      c.close();
    },
  });
  const [uri, payload] = await collectBytes(["immutable://x/3", stream]);
  assertEquals(uri, "immutable://x/3");
  assertInstanceOf(payload, Uint8Array);
  assertEquals(dec(payload), "hello");
});

Deno.test("collectBytes: non-union payload throws TypeError", async () => {
  await assertRejects(
    () =>
      collectBytes([
        "immutable://x/4",
        { not: "bytes" } as unknown as StorePayload,
      ]),
    TypeError,
    "collectBytes: payload is not bytes-or-stream",
  );
});

// ── BufferedSaveClient ──

Deno.test("BufferedSaveClient.read: MemoryStore (already bytes) round-trips", async () => {
  const store = new MemoryStore();
  await store.provisionEntity(store.entitySupport(BYTES_ENTITY));
  const inner = new SaveClient(mapToBytes, BYTES_ENTITY, store);
  const buffered = new BufferedSaveClient(inner);

  const writeResults = await buffered.receive([
    ["immutable://b/1", enc("hello")],
    ["immutable://b/2", enc("world")],
  ]);
  assertEquals(writeResults.every((r) => r.accepted), true);

  const rows = await buffered.read(["immutable://b/1", "immutable://b/2"]);
  assertEquals(rows.length, 2);
  assertInstanceOf(rows[0][1], Uint8Array);
  assertInstanceOf(rows[1][1], Uint8Array);
  assertEquals(dec(rows[0][1] as Uint8Array), "hello");
  assertEquals(dec(rows[1][1] as Uint8Array), "world");
});

Deno.test("BufferedSaveClient.read: FsStore (streams) materialized to bytes", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "b3nd-save-collect-" });
  try {
    const exec: FsExecutor = {
      async readFile(path: string): Promise<ReadableStream<Uint8Array>> {
        const file = await Deno.open(path, { read: true });
        return file.readable;
      },
      async writeFile(path: string, content: StorePayload) {
        await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
          recursive: true,
        });
        if (content instanceof Uint8Array) {
          await Deno.writeFile(path, content);
          return;
        }
        const file = await Deno.open(path, {
          write: true,
          create: true,
          truncate: true,
        });
        await content.pipeTo(file.writable);
      },
      async removeFile(path: string) {
        await Deno.remove(path);
      },
      async exists(path: string) {
        try {
          await Deno.stat(path);
          return true;
        } catch {
          return false;
        }
      },
      async listFiles(dir: string) {
        const files: string[] = [];
        try {
          for await (const entry of Deno.readDir(dir)) {
            if (entry.isFile) files.push(entry.name);
          }
        } catch {
          return [];
        }
        return files;
      },
      async *walkFiles(dir: string): AsyncIterable<string> {
        try {
          for await (const entry of Deno.readDir(dir)) {
            const full = `${dir}/${entry.name}`;
            if (entry.isFile) {
              yield full;
            } else if (entry.isDirectory) {
              yield* this.walkFiles(full);
            }
          }
        } catch {
          return;
        }
      },
    };

    const store = new FsStore(tmp, exec);
    await store.provisionEntity(store.entitySupport(BYTES_ENTITY));
    const inner = new SaveClient(mapToBytes, BYTES_ENTITY, store);
    const buffered = new BufferedSaveClient(inner);

    await buffered.receive([["immutable://fs/1", enc("streamed-hello")]]);

    // Bare SaveClient: returns a stream on FsStore. Drain it to keep the
    // file handle from leaking under Deno's test sanitizer.
    const bareRows = await inner.read(["immutable://fs/1"]);
    const barePayload = bareRows[0][1];
    assertEquals(barePayload instanceof Uint8Array, false);
    assertEquals(
      typeof (barePayload as ReadableStream<Uint8Array>).getReader,
      "function",
    );
    await new Response(barePayload as ReadableStream<Uint8Array>).bytes();

    // BufferedSaveClient: same store, normalized to Uint8Array.
    const rows = await buffered.read(["immutable://fs/1"]);
    assertEquals(rows.length, 1);
    assertInstanceOf(rows[0][1], Uint8Array);
    assertEquals(dec(rows[0][1] as Uint8Array), "streamed-hello");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("BufferedSaveClient.read: missing URI passes through as null", async () => {
  const store = new MemoryStore();
  await store.provisionEntity(store.entitySupport(BYTES_ENTITY));
  const inner = new SaveClient(mapToBytes, BYTES_ENTITY, store);
  const buffered = new BufferedSaveClient(inner);
  const rows = await buffered.read(["immutable://missing/1"]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0][1], null);
});
