/**
 * Tests for `walkViaLs` — the caller-invoked ls-walker polyfill.
 *
 * The tests mock the `read` function to simulate a synthetic tree.
 * Every assertion exercises the public contract (URI accumulation,
 * pattern filtering, format selection, directory cap) without touching
 * any real store.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { Output } from "@bandeira-tech/b3nd-core/types";
import { walkViaLs } from "./walk-via-ls.ts";

/**
 * Build a `read`-shaped mock against a flat directory map. Keys are
 * directory URIs (always with trailing `/`); values are the children
 * each `?fn=ls&format=uris` should yield. Any URI not in the map
 * resolves to an empty children list — which the walker treats as
 * "this URI is a leaf, stop recursing."
 *
 * For `format=full` final fetch the mock returns synthetic payloads
 * `{ uri, content: "payload-of-<uri>" }` so tests can verify the
 * batched read happened.
 */
function makeRead(
  tree: Record<string, string[]>,
  log?: string[],
): <T = unknown>(urls: string[]) => Promise<Output<T>[]> {
  return async function read<T = unknown>(
    urls: string[],
  ): Promise<Output<T>[]> {
    log?.push(...urls);
    const out: Output<T>[] = [];
    for (const url of urls) {
      const qIdx = url.indexOf("?");
      const uri = qIdx < 0 ? url : url.slice(0, qIdx);
      const query = qIdx < 0 ? "" : url.slice(qIdx + 1);
      if (query.includes("fn=ls")) {
        // ls probe: emit the children list for that dir (or [])
        const children = tree[uri] ?? [];
        out.push([url, children as unknown as T]);
      } else {
        // Bare read — synth a payload tagged with the URI.
        out.push([
          url,
          { uri, content: `payload-of-${uri}` } as unknown as T,
        ]);
      }
    }
    return out;
  };
}

Deno.test("walkViaLs — shallow case (single level, no recursion)", async () => {
  const tree: Record<string, string[]> = {
    "mem://root/": ["mem://root/a", "mem://root/b", "mem://root/c"],
  };
  const read = makeRead(tree);

  const got = await walkViaLs(read, "mem://root/", { format: "uris" });
  assertEquals(got, ["mem://root/a", "mem://root/b", "mem://root/c"]);
});

Deno.test("walkViaLs — deep recursion (3+ levels)", async () => {
  // mem://root/
  // ├── alice/
  // │   ├── posts/
  // │   │   ├── 1.md
  // │   │   └── 2.md
  // │   └── profile.json
  // └── bob/
  //     └── posts/
  //         └── 1.md
  const tree: Record<string, string[]> = {
    "mem://root/": ["mem://root/alice", "mem://root/bob"],
    "mem://root/alice/": [
      "mem://root/alice/posts",
      "mem://root/alice/profile.json",
    ],
    "mem://root/alice/posts/": [
      "mem://root/alice/posts/1.md",
      "mem://root/alice/posts/2.md",
    ],
    "mem://root/bob/": ["mem://root/bob/posts"],
    "mem://root/bob/posts/": ["mem://root/bob/posts/1.md"],
  };
  const read = makeRead(tree);

  const got = await walkViaLs(read, "mem://root/", {
    format: "uris",
  }) as string[];

  // Depth-first, left-to-right ordering.
  assertEquals(got.sort(), [
    "mem://root/alice/posts/1.md",
    "mem://root/alice/posts/2.md",
    "mem://root/alice/profile.json",
    "mem://root/bob/posts/1.md",
  ]);
});

Deno.test("walkViaLs — empty result (prefix exists but no children)", async () => {
  const read = makeRead({ "mem://root/": [] });
  const got = await walkViaLs(read, "mem://root/", { format: "uris" });
  assertEquals(got, []);
});

Deno.test("walkViaLs — empty result with format=full returns empty array, no extra read", async () => {
  const log: string[] = [];
  const read = makeRead({ "mem://root/": [] }, log);
  const got = await walkViaLs(read, "mem://root/");
  assertEquals(got, []);
  // Only one call: the root ls probe. No batched read followed.
  assertEquals(log.length, 1);
  assertEquals(log[0], "mem://root/?fn=ls&format=uris");
});

Deno.test("walkViaLs — pattern filter applied to accumulated results", async () => {
  const tree: Record<string, string[]> = {
    "mem://root/": ["mem://root/alice", "mem://root/bob"],
    "mem://root/alice/": [
      "mem://root/alice/msg-1.md",
      "mem://root/alice/note.json",
    ],
    "mem://root/bob/": [
      "mem://root/bob/msg-1.md",
      "mem://root/bob/avatar.png",
    ],
  };
  const read = makeRead(tree);

  // Only *.md leaves (any depth).
  const got = await walkViaLs(read, "mem://root/", {
    format: "uris",
    pattern: "**/*.md",
  }) as string[];

  assertEquals(got.sort(), [
    "mem://root/alice/msg-1.md",
    "mem://root/bob/msg-1.md",
  ]);
});

Deno.test("walkViaLs — pattern restricts to one sub-prefix", async () => {
  const tree: Record<string, string[]> = {
    "mem://root/": ["mem://root/alice", "mem://root/bob"],
    "mem://root/alice/": ["mem://root/alice/x.md", "mem://root/alice/y.md"],
    "mem://root/bob/": ["mem://root/bob/z.md"],
  };
  const read = makeRead(tree);

  const got = await walkViaLs(read, "mem://root/", {
    format: "uris",
    pattern: "alice/**",
  }) as string[];
  assertEquals(got.sort(), [
    "mem://root/alice/x.md",
    "mem://root/alice/y.md",
  ]);
});

Deno.test("walkViaLs — no pattern returns every descendant", async () => {
  const tree: Record<string, string[]> = {
    "mem://root/": ["mem://root/a", "mem://root/nested"],
    "mem://root/nested/": ["mem://root/nested/b"],
  };
  const read = makeRead(tree);

  const got = await walkViaLs(read, "mem://root/", {
    format: "uris",
  }) as string[];
  assertEquals(got.sort(), ["mem://root/a", "mem://root/nested/b"]);
});

Deno.test("walkViaLs — format=full batches a single read of accumulated leaves", async () => {
  const tree: Record<string, string[]> = {
    "mem://root/": ["mem://root/a", "mem://root/b"],
  };
  const log: string[] = [];
  const read = makeRead(tree, log);

  const got = await walkViaLs(read, "mem://root/") as Output[];
  // Two payload reads happen in the batched final call.
  assertEquals(got.length, 2);
  assertEquals(got[0][0], "mem://root/a");
  assertEquals(
    (got[0][1] as { content: string }).content,
    "payload-of-mem://root/a",
  );
  assertEquals(got[1][0], "mem://root/b");

  // Calls in log: root ls + leaf-probe ls (× 2) + final batched read.
  // We don't assert exact ordering — just that the final batched
  // read of two URIs happened.
  const batchedRead = log.filter((u) =>
    !u.includes("?fn=ls") && !u.includes("?fn=read")
  );
  assertEquals(batchedRead.length, 2);
  assertEquals(batchedRead.sort(), ["mem://root/a", "mem://root/b"]);
});

Deno.test("walkViaLs — accepts prefix without trailing slash", async () => {
  const tree: Record<string, string[]> = {
    "mem://root/": ["mem://root/x"],
  };
  const read = makeRead(tree);

  const got = await walkViaLs(read, "mem://root", { format: "uris" });
  assertEquals(got, ["mem://root/x"]);
});

Deno.test("walkViaLs — maxDirs cap throws on runaway walks", async () => {
  // A tree that would balloon past the cap.
  const tree: Record<string, string[]> = {
    "mem://root/": ["mem://root/d1", "mem://root/d2", "mem://root/d3"],
    "mem://root/d1/": ["mem://root/d1/d", "mem://root/d1/e"],
    "mem://root/d2/": ["mem://root/d2/d", "mem://root/d2/e"],
    "mem://root/d3/": ["mem://root/d3/d", "mem://root/d3/e"],
  };
  const read = makeRead(tree);

  await assertRejects(
    () => walkViaLs(read, "mem://root/", { maxDirs: 2 }),
    Error,
    "maxDirs exceeded",
  );
});

Deno.test("walkViaLs — exact-segment pattern with `*` (no `**`)", async () => {
  const tree: Record<string, string[]> = {
    "mem://root/": ["mem://root/alice", "mem://root/bob"],
    "mem://root/alice/": ["mem://root/alice/msg-1.md"],
    "mem://root/bob/": ["mem://root/bob/msg-2.md"],
  };
  const read = makeRead(tree);

  // Single-segment wildcard: only direct children of <prefix>/<one>/.
  const got = await walkViaLs(read, "mem://root/", {
    format: "uris",
    pattern: "*/msg-1.md",
  }) as string[];
  assertEquals(got, ["mem://root/alice/msg-1.md"]);
});
