/**
 * FsStore Integration Tests
 *
 * Runs the shared store suite against the real filesystem.
 * No external service needed — uses Deno.makeTempDir().
 */

/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs/ensure-dir";
import { walk } from "@std/fs/walk";
import { dirname, relative } from "@std/path";
import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { FsStore } from "./store.ts";
import type { FsExecutor } from "./mod.ts";
import type { StorePayload } from "../types.ts";
import { BYTES_ENTITY } from "../entity.ts";

function createFsExecutor(_rootDir: string): FsExecutor {
  return {
    async readFile(path: string): Promise<ReadableStream<Uint8Array>> {
      const file = await Deno.open(path, { read: true });
      return file.readable;
    },

    async writeFile(path: string, content: StorePayload): Promise<void> {
      await ensureDir(dirname(path));
      if (content instanceof Uint8Array) {
        await Deno.writeFile(path, content);
        return;
      }
      // ReadableStream: open the file and pipe directly so large
      // payloads never need to fit in memory.
      const file = await Deno.open(path, {
        write: true,
        create: true,
        truncate: true,
      });
      await content.pipeTo(file.writable);
    },

    async removeFile(path: string): Promise<void> {
      await Deno.remove(path);
    },

    async exists(path: string): Promise<boolean> {
      try {
        await Deno.stat(path);
        return true;
      } catch {
        return false;
      }
    },

    async listFiles(dir: string): Promise<string[]> {
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
      // @std/fs/walk yields entries lazily; we only emit files and
      // convert the absolute path back to a path relative to `dir` so
      // the FsStore can compose it with the URI prefix. Missing dir →
      // walk throws on the first iteration; swallow to yield nothing,
      // matching the contract.
      try {
        for await (
          const entry of walk(dir, {
            includeDirs: false,
            includeFiles: true,
            includeSymlinks: false,
            followSymlinks: false,
          })
        ) {
          // `relative` returns OS-native separators on Windows; the
          // FsStore composes paths with `/` so we normalise here.
          const rel = relative(dir, entry.path).replaceAll("\\", "/");
          yield rel;
        }
      } catch {
        // No directory, no permissions, etc. — yield nothing.
      }
    },
  };
}

// Each test gets a fresh temp directory
let lastTempDir: string | undefined;

runSharedStoreSuite("FsStore (integration)", {
  create: async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "b3nd_fs_test_" });
    lastTempDir = tempDir;
    const executor = createFsExecutor(tempDir);
    return new FsStore(tempDir, executor);
  },
  supportsFind: true,
  // FsStore treats URIs as literal relative paths under `rootDir`. A
  // URI and its sub-URI cannot both hold data on POSIX (`foo` cannot be
  // both a file and a directory). Suite-level tests that create that
  // collision are skipped.
  keyspaceIsFilesystemLike: true,
});

// ── fn=find (integration) ────────────────────────────────────────────

const enc = (s: string) => new TextEncoder().encode(s);

Deno.test("FsStore (integration) — fn=find walks a real deep tree", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "b3nd_fs_find_" });
  try {
    const store = new FsStore(tempDir, createFsExecutor(tempDir));
    const meta = store.entitySupport(BYTES_ENTITY);
    await store.provisionEntity(meta);
    const uris = [
      "room/top.md",
      "room/a/1.md",
      "room/a/b/2.md",
      "room/a/b/c/3.md",
      "room/b/4.md",
    ];
    for (const uri of uris) {
      await store.write(meta, [{ uri, record: { payload: enc("x") } }]);
    }
    const [[, rows]] = await store.read<string[]>(meta, [
      "room/**?fn=find&format=uris&sortBy=uri",
    ]);
    assertEquals((rows as string[]).slice().sort(), uris.slice().sort());
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("FsStore (integration) — fn=find does NOT follow symlinks", async () => {
  // Out-of-scope target tree gets symlinked under the store; walk must
  // not chase it (could escape the store root, or — worse — infinite-
  // loop on a self-link). The std/fs/walk default is `followSymlinks:
  // false`; we set it explicitly. This test pins that behaviour so a
  // future executor swap can't regress it silently.
  const tempDir = await Deno.makeTempDir({ prefix: "b3nd_fs_sym_" });
  const outside = await Deno.makeTempDir({ prefix: "b3nd_fs_sym_out_" });
  try {
    await Deno.writeFile(`${outside}/secret`, enc("nope"));
    // Drop a symlink under the store root pointing at `outside`.
    await ensureDir(`${tempDir}/room`);
    await Deno.symlink(outside, `${tempDir}/room/link`);
    // Put a legitimate file alongside so the walk has at least one
    // hit and the test asserts the symlink target's contents are
    // ABSENT, not that the walk produced nothing.
    await Deno.writeFile(`${tempDir}/room/real.md`, enc("yep"));
    const store = new FsStore(tempDir, createFsExecutor(tempDir));
    const meta = store.entitySupport(BYTES_ENTITY);
    await store.provisionEntity(meta);
    const [[, rows]] = await store.read<string[]>(meta, [
      "room/**?fn=find&format=uris&sortBy=uri",
    ]);
    assertEquals(rows, ["room/real.md"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    await Deno.remove(outside, { recursive: true }).catch(() => {});
  }
});

// Cleanup after all tests
Deno.test({
  name: "FsStore (integration) - cleanup",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (lastTempDir) {
      await Deno.remove(lastTempDir, { recursive: true }).catch(() => {});
    }
  },
});
