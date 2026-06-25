/**
 * Shared Test Suite for Store Interface
 *
 * Validates every Store implementation against the b3nd-save
 * bytes-only contract:
 * - write(entries: { uri, payload: Uint8Array }[]) → StoreWriteResult[]
 * - read(urls)                                     → Output<T>[]
 * - delete(uris)                                   → DeleteResult[]
 * - status()                                       → StatusResult  (advertises `fns`)
 * - capabilities()                                 → StoreCapabilities (optional)
 *
 * Conventions enforced here:
 * - `payload` is `Uint8Array | ReadableStream<Uint8Array>` end-to-end —
 *   Stores never inspect content. The suite collects either shape into
 *   `Uint8Array` for assertions via `payloadBytes`.
 * - `fn=read` miss → payload is `undefined`.
 * - `fn=ls` is SHALLOW: direct leaves only (entries whose uri is
 *   `prefix + <segment>` with no further `/`). Subtree-only entries
 *   are absent from `ls` and `count`. `format=full` returns
 *   `Output[]`; `format=uris` returns `string[]`.
 * - `fn=count` returns the number of direct leaves under the prefix.
 * - Read params:
 *   - `limit` / `page` / `cursor` paginate (cursor + page is a
 *     programmer error and throws).
 *   - `sortBy=uri` or `sortBy=<field>` with `sortOrder=asc|desc`
 *     sort the result; sortBy by a non-existent field is silently
 *     a no-op rather than an error.
 *   - `pattern=<glob>` filters by URI tail (`*` and `?` wildcards).
 *   - `fields=<csv>` projects record fields after the read.
 *   - `format=uris` returns `string[]`; `format=full` returns
 *     `Output[]`. Any other `format` value throws.
 *
 * Each store test file imports and runs this suite with a factory.
 */

/// <reference lib="deno.ns" />

import { assertEquals, assertRejects } from "jsr:@std/assert";
import type { Output } from "@bandeira-tech/b3nd-core/types";
import type { EntityStore } from "../../src/entity-store.ts";
import {
  BYTES_ENTITY,
  type EntityMeta,
  type EntityRecord,
} from "../../src/entity.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export interface StoreTestConfig {
  /** Factory that returns a fresh Store for each test. */
  create: () => EntityStore | Promise<EntityStore>;

  /** Defaults to true. Disable for write-only sinks (e.g. console). */
  supportsRead?: boolean;

  /** Defaults to `supportsRead`. */
  supportsLs?: boolean;

  /** Defaults to `supportsLs`. */
  supportsCount?: boolean;

  /**
   * Defaults to `false`. Opt-in for stores that advertise `"find"` in
   * `status().fns`. The suite's find section asserts the v2 §3.5
   * contract: deep walks return descendants at any depth, the cursor-
   * as-trailing-slot mechanism works across `find` pagination, and
   * `?fn=find` is rejected on stores that have not opted in (which is
   * enforced at the dispatch layer regardless of this flag).
   */
  supportsFind?: boolean;
}

function payloadOf(out: Output<unknown>): unknown {
  return out[1];
}

function uriOf(out: Output): string {
  return out[0];
}

/**
 * Strip the cursor-as-trailing-slot from an ls/find response array
 * (v2 spec §3.5). dispatch.ts appends `[<cursorUri>, { next }]`
 * whenever `limit` is set; tests that care about the page contents
 * (not the cursor wire shape — that's covered in dispatch.test.ts)
 * call this to drop the slot before asserting.
 *
 * Detection is structural: the last element is an `Output` tuple whose
 * payload is a plain object with a `next` key whose value is either a
 * string or `null`. False positives are vanishingly unlikely for real
 * payloads (they'd need to be plain objects with exactly that shape).
 */
function stripCursorSlot(rows: unknown[]): unknown[] {
  if (rows.length === 0) return rows;
  const last = rows[rows.length - 1];
  if (
    Array.isArray(last) &&
    last.length === 2 &&
    typeof last[0] === "string" &&
    last[1] !== null &&
    typeof last[1] === "object" &&
    !Array.isArray(last[1]) &&
    !(last[1] instanceof Uint8Array) &&
    "next" in (last[1] as Record<string, unknown>) &&
    (typeof (last[1] as { next: unknown }).next === "string" ||
      (last[1] as { next: unknown }).next === null)
  ) {
    return rows.slice(0, -1);
  }
  return rows;
}

/**
 * Collect a `Uint8Array | ReadableStream<Uint8Array>` payload to
 * bytes. The shared suite asserts byte-level equality regardless of
 * which shape the backend returned (buffered backends yield
 * `Uint8Array`; streamer backends yield `ReadableStream`).
 */
async function payloadBytes(value: unknown): Promise<Uint8Array> {
  // EntityStore returns `BYTES_ENTITY` records as `{ payload: bytes }`.
  // Unwrap once before the type checks below so the assertions in the
  // suite stay byte-shaped.
  if (
    value !== null && typeof value === "object" &&
    "payload" in (value as Record<string, unknown>) &&
    !(value instanceof Uint8Array)
  ) {
    return payloadBytes((value as EntityRecord).payload);
  }
  if (value instanceof Uint8Array) return value;
  if (value instanceof ReadableStream) {
    return new Uint8Array(
      await new Response(value as BodyInit).arrayBuffer(),
    );
  }
  throw new Error(
    `expected Uint8Array | ReadableStream, got ${
      value === null ? "null" : typeof value
    }`,
  );
}

/** Provision `BYTES_ENTITY` and hand back a primed store + meta. */
async function setup(
  create: () => EntityStore | Promise<EntityStore>,
): Promise<{ store: EntityStore; meta: EntityMeta }> {
  const store = await Promise.resolve(create());
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  return { store, meta };
}

/** Wrap byte-shaped entries as `BYTES_ENTITY` records. */
function wrap(
  entries: { uri: string; payload: Uint8Array | ReadableStream<Uint8Array> }[],
): { uri: string; record: EntityRecord }[] {
  return entries.map(({ uri, payload }) => ({ uri, record: { payload } }));
}

async function assertBytesEqual(
  actual: unknown,
  expected: Uint8Array,
  msg?: string,
): Promise<void> {
  const bytes = await payloadBytes(actual);
  assertEquals(Array.from(bytes), Array.from(expected), msg);
}

export function runSharedStoreSuite(
  suiteName: string,
  config: StoreTestConfig,
) {
  const noSanitize = { sanitizeOps: false, sanitizeResources: false };
  const supportsRead = config.supportsRead !== false;
  const supportsLs = config.supportsLs ?? supportsRead;
  const supportsCount = config.supportsCount ?? supportsLs;
  const supportsFind = config.supportsFind === true;

  const t = (name: string, fn: () => void | Promise<void>) =>
    Deno.test({ name: `${suiteName} — ${name}`, ...noSanitize, fn });

  // ── Write ─────────────────────────────────────────────────────────

  t("write single entry", async () => {
    const { store, meta } = await setup(config.create);
    const results = await store.write(
      meta,
      wrap([
        { uri: "store://app/config", payload: enc("dark") },
      ]),
    );
    assertEquals(results.length, 1);
    assertEquals(results[0].success, true);
  });

  t("write batch of entries", async () => {
    const { store, meta } = await setup(config.create);
    const results = await store.write(
      meta,
      wrap([
        { uri: "store://app/a", payload: enc("A") },
        { uri: "store://app/b", payload: enc("B") },
        { uri: "store://app/c", payload: enc("C") },
      ]),
    );
    assertEquals(results.length, 3);
    assertEquals(results.every((r) => r.success), true);
  });

  if (!supportsRead) {
    // Write-only stores stop here for round-trip coverage; the rest of
    // the suite assumes read-back.
    t("status returns healthy", async () => {
      const { store, meta: _ } = await setup(config.create);
      const status = await store.status();
      assertEquals(status.status, "healthy");
    });
    return;
  }

  // ── Read: point reads ─────────────────────────────────────────────

  t("write and read back returns tuple [uri, bytes]", async () => {
    const { store, meta } = await setup(config.create);
    await store.write(
      meta,
      wrap([
        { uri: "store://app/config", payload: enc("dark") },
      ]),
    );
    const results = await store.read(
      meta,
      ["store://app/config"],
    );
    assertEquals(results.length, 1);
    assertEquals(uriOf(results[0]), "store://app/config");
    await assertBytesEqual(payloadOf(results[0]), enc("dark"));
  });

  t("batch read returns one Output per input url, in order", async () => {
    const { store, meta } = await setup(config.create);
    await store.write(
      meta,
      wrap([
        { uri: "store://app/a", payload: enc("A") },
        { uri: "store://app/b", payload: enc("B") },
        { uri: "store://app/c", payload: enc("C") },
      ]),
    );
    const urls = ["store://app/a", "store://app/b", "store://app/c"];
    const results = await store.read(
      meta,
      urls,
    );
    assertEquals(results.length, 3);
    assertEquals(results.map(uriOf), urls);
    await assertBytesEqual(payloadOf(results[0]), enc("A"));
    await assertBytesEqual(payloadOf(results[1]), enc("B"));
    await assertBytesEqual(payloadOf(results[2]), enc("C"));
  });

  t("write overwrites existing value", async () => {
    const { store, meta } = await setup(config.create);
    await store.write(
      meta,
      wrap([{ uri: "store://app/x", payload: enc("old") }]),
    );
    await store.write(
      meta,
      wrap([{ uri: "store://app/x", payload: enc("new") }]),
    );
    const results = await store.read(
      meta,
      ["store://app/x"],
    );
    await assertBytesEqual(payloadOf(results[0]), enc("new"));
  });

  // ── Binary payload shapes ─────────────────────────────────────────

  t("read/write empty payload", async () => {
    const { store, meta } = await setup(config.create);
    await store.write(
      meta,
      wrap([
        { uri: "store://bytes/empty", payload: new Uint8Array(0) },
      ]),
    );
    const results = await store.read(
      meta,
      ["store://bytes/empty"],
    );
    await assertBytesEqual(payloadOf(results[0]), new Uint8Array(0));
  });

  t("read/write payload covering all byte values", async () => {
    const { store, meta } = await setup(config.create);
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    await store.write(
      meta,
      wrap([{ uri: "store://bytes/all", payload: all }]),
    );
    const results = await store.read(
      meta,
      ["store://bytes/all"],
    );
    await assertBytesEqual(payloadOf(results[0]), all);
  });

  t("read/write large payload (32 KB random bytes)", async () => {
    const { store, meta } = await setup(config.create);
    const big = crypto.getRandomValues(new Uint8Array(32 * 1024));
    await store.write(
      meta,
      wrap([{ uri: "store://bytes/big", payload: big }]),
    );
    const results = await store.read(
      meta,
      ["store://bytes/big"],
    );
    await assertBytesEqual(payloadOf(results[0]), big);
  });

  t("write accepts a ReadableStream payload", async () => {
    const { store, meta } = await setup(config.create);
    const expected = enc("streamed content");
    const stream = new Response(expected as BodyInit).body!;
    await store.write(
      meta,
      wrap([{ uri: "store://stream/x", payload: stream }]),
    );
    const results = await store.read(
      meta,
      ["store://stream/x"],
    );
    await assertBytesEqual(payloadOf(results[0]), expected);
  });

  // ── Miss convention: payload === undefined ────────────────────────

  t("read miss returns payload undefined", async () => {
    const { store, meta } = await setup(config.create);
    const results = await store.read(
      meta,
      ["store://app/missing"],
    );
    assertEquals(results.length, 1);
    assertEquals(uriOf(results[0]), "store://app/missing");
    assertEquals(payloadOf(results[0]), undefined);
  });

  t("read with partial misses keeps positional order", async () => {
    const { store, meta } = await setup(config.create);
    await store.write(
      meta,
      wrap([
        { uri: "store://app/exists", payload: enc("yes") },
      ]),
    );
    const urls = ["store://app/exists", "store://app/missing"];
    const results = await store.read(
      meta,
      urls,
    );
    assertEquals(results.length, 2);
    assertEquals(uriOf(results[0]), "store://app/exists");
    await assertBytesEqual(payloadOf(results[0]), enc("yes"));
    assertEquals(uriOf(results[1]), "store://app/missing");
    assertEquals(payloadOf(results[1]), undefined);
  });

  // ── Read echoes input url including query string ─────────────────

  t("read echoes input url verbatim (with query string)", async () => {
    const { store, meta } = await setup(config.create);
    await store.write(
      meta,
      wrap([{ uri: "store://app/x", payload: enc("v") }]),
    );
    const url = "store://app/x?fn=read";
    const results = await store.read(
      meta,
      [url],
    );
    assertEquals(uriOf(results[0]), url);
    await assertBytesEqual(payloadOf(results[0]), enc("v"));
  });

  // ── ls (trailing slash / fn=ls) ───────────────────────────────────

  if (supportsLs) {
    t("trailing-slash defaults to fn=ls (returns Output[])", async () => {
      const { store, meta } = await setup(config.create);
      await store.write(
        meta,
        wrap([
          { uri: "store://users/alice", payload: enc("Alice") },
          { uri: "store://users/bob", payload: enc("Bob") },
        ]),
      );
      const results = await store.read(
        meta,
        ["store://users/"],
      );
      assertEquals(results.length, 1);
      // The single Output payload is itself an Output[] of children.
      const children = payloadOf(results[0]) as Output[];
      const uris = children.map(uriOf).sort();
      assertEquals(uris, ["store://users/alice", "store://users/bob"]);
    });

    t("ls is shallow — nested entries are absent", async () => {
      const { store, meta } = await setup(config.create);
      await store.write(
        meta,
        wrap([
          { uri: "store://users/alice", payload: enc("alice-leaf") },
          { uri: "store://users/bob/posts/1", payload: enc("deep") },
        ]),
      );
      const results = await store.read(
        meta,
        ["store://users/"],
      );
      const children = payloadOf(results[0]) as Output[];
      const uris = children.map(uriOf);
      assertEquals(uris, ["store://users/alice"]);
    });

    t("ls with format=uris returns string[]", async () => {
      const { store, meta } = await setup(config.create);
      await store.write(
        meta,
        wrap([
          { uri: "store://t/a", payload: enc("1") },
          { uri: "store://t/b", payload: enc("2") },
        ]),
      );
      const results = await store.read(
        meta,
        [
          "store://t/?fn=ls&format=uris&sortBy=uri",
        ],
      );
      const uris = payloadOf(results[0]) as string[];
      assertEquals(uris, ["store://t/a", "store://t/b"]);
    });

    t("ls supports sortBy=uri (asc/desc)", async () => {
      const { store, meta } = await setup(config.create);
      await store.write(
        meta,
        wrap([
          { uri: "store://s/c", payload: enc("3") },
          { uri: "store://s/a", payload: enc("1") },
          { uri: "store://s/b", payload: enc("2") },
        ]),
      );
      const asc = await store.read(
        meta,
        [
          "store://s/?fn=ls&sortBy=uri&format=uris",
        ],
      );
      assertEquals(payloadOf(asc[0]) as string[], [
        "store://s/a",
        "store://s/b",
        "store://s/c",
      ]);
      const desc = await store.read(
        meta,
        [
          "store://s/?fn=ls&sortBy=uri&sortOrder=desc&format=uris",
        ],
      );
      assertEquals(payloadOf(desc[0]) as string[], [
        "store://s/c",
        "store://s/b",
        "store://s/a",
      ]);
    });

    t("ls supports limit + page", async () => {
      const { store, meta } = await setup(config.create);
      await store.write(
        meta,
        wrap([
          { uri: "store://p/a", payload: enc("1") },
          { uri: "store://p/b", payload: enc("2") },
          { uri: "store://p/c", payload: enc("3") },
          { uri: "store://p/d", payload: enc("4") },
        ]),
      );
      const p1 = await store.read(
        meta,
        [
          "store://p/?fn=ls&sortBy=uri&limit=2&page=1&format=uris",
        ],
      );
      // dispatch appends a cursor-as-trailing-slot when limit is set
      // (v2 spec §3.5) — strip it before comparing the page contents.
      assertEquals(stripCursorSlot(payloadOf(p1[0]) as unknown[]), [
        "store://p/a",
        "store://p/b",
      ]);
      const p2 = await store.read(
        meta,
        [
          "store://p/?fn=ls&sortBy=uri&limit=2&page=2&format=uris",
        ],
      );
      assertEquals(stripCursorSlot(payloadOf(p2[0]) as unknown[]), [
        "store://p/c",
        "store://p/d",
      ]);
    });

    t("ls of empty prefix returns empty list", async () => {
      const { store, meta } = await setup(config.create);
      const results = await store.read(
        meta,
        ["store://nothing/"],
      );
      const children = payloadOf(results[0]) as Output[];
      assertEquals(children, []);
    });

    t("ls accepts sortBy=<field> without throwing", async () => {
      // sortBy by record field is supported from 0.12.0 — dispatch
      // post-sorts when the backend doesn't push down. Sorting
      // BYTES_ENTITY payloads stringifies them, but the contract is
      // "does not throw, returns deterministic order".
      const { store, meta } = await setup(config.create);
      await store.write(
        meta,
        wrap([
          { uri: "store://t/a", payload: enc("3") },
          { uri: "store://t/b", payload: enc("1") },
        ]),
      );
      const result = await store.read(meta, [
        "store://t/?fn=ls&format=uris&sortBy=payload",
      ]);
      assertEquals((payloadOf(result[0]) as string[]).length, 2);
    });

    t("ls throws on unsupported format", async () => {
      const { store, meta } = await setup(config.create);
      await assertRejects(
        () =>
          store.read(
            meta,
            ["store://t/?fn=ls&format=weird"],
          ),
        Error,
      );
    });

    t(
      "ls honours pattern= as a URI-tail glob filter",
      async () => {
        const { store, meta } = await setup(config.create);
        await store.write(
          meta,
          wrap([
            { uri: "store://p/alice", payload: enc("1") },
            { uri: "store://p/albert", payload: enc("2") },
            { uri: "store://p/bob", payload: enc("3") },
          ]),
        );
        const results = await store.read(
          meta,
          ["store://p/?fn=ls&format=uris&pattern=al*"],
        );
        const uris = (payloadOf(results[0]) as string[]).sort();
        assertEquals(uris, ["store://p/albert", "store://p/alice"]);
      },
    );

    t(
      "ls honours cursor= for stateless pagination",
      async () => {
        const { store, meta } = await setup(config.create);
        await store.write(
          meta,
          wrap([
            { uri: "store://cur/a", payload: enc("1") },
            { uri: "store://cur/b", payload: enc("2") },
            { uri: "store://cur/c", payload: enc("3") },
            { uri: "store://cur/d", payload: enc("4") },
          ]),
        );
        // First page: limit 2, sorted asc.
        const page1 = await store.read(meta, [
          "store://cur/?fn=ls&format=uris&sortBy=uri&limit=2",
        ]);
        const uris1 = stripCursorSlot(
          payloadOf(page1[0]) as unknown[],
        ) as string[];
        assertEquals(uris1, ["store://cur/a", "store://cur/b"]);
        // Second page: pass the last uri as cursor.
        const cursor = uris1[uris1.length - 1];
        const page2 = await store.read(meta, [
          `store://cur/?fn=ls&format=uris&sortBy=uri&limit=2&cursor=${
            encodeURIComponent(cursor)
          }`,
        ]);
        assertEquals(stripCursorSlot(payloadOf(page2[0]) as unknown[]), [
          "store://cur/c",
          "store://cur/d",
        ]);
      },
    );

    t(
      "ls rejects cursor= combined with page= (incompatible pagination modes)",
      async () => {
        const { store, meta } = await setup(config.create);
        await assertRejects(
          () =>
            store.read(
              meta,
              ["store://cx/?fn=ls&cursor=x&page=2&limit=1"],
            ),
          Error,
          "cursor and page",
        );
      },
    );

    t(
      "ls composes pattern + cursor + limit correctly",
      async () => {
        // Five entries under the prefix; pattern narrows to those
        // starting with "al"; cursor=alice should leave just albert
        // and (if it existed) anything > alice matching the pattern.
        // We pin the dataset so order is deterministic.
        const { store, meta } = await setup(config.create);
        await store.write(
          meta,
          wrap([
            { uri: "store://combo/alice", payload: enc("1") },
            { uri: "store://combo/albert", payload: enc("2") },
            { uri: "store://combo/alvin", payload: enc("3") },
            { uri: "store://combo/bob", payload: enc("4") },
            { uri: "store://combo/charlie", payload: enc("5") },
          ]),
        );
        // Sort by uri asc, filter pattern=al*, then cursor past alice
        // leaves just alvin (albert < alice < alvin lexically).
        const results = await store.read(meta, [
          `store://combo/?fn=ls&format=uris&sortBy=uri&pattern=al*&limit=2&cursor=${
            encodeURIComponent("store://combo/alice")
          }`,
        ]);
        assertEquals(stripCursorSlot(payloadOf(results[0]) as unknown[]), [
          "store://combo/alvin",
        ]);
      },
    );
  }

  // ── count ────────────────────────────────────────────────────────

  if (supportsCount) {
    t("fn=count returns number of direct leaves", async () => {
      const { store, meta } = await setup(config.create);
      await store.write(
        meta,
        wrap([
          { uri: "store://c/a", payload: enc("1") },
          { uri: "store://c/b", payload: enc("2") },
          { uri: "store://c/deep/x", payload: enc("9") },
        ]),
      );
      const results = await store.read(
        meta,
        ["store://c/?fn=count"],
      );
      assertEquals(payloadOf(results[0]), 2);
    });

    t("fn=count returns 0 for empty prefix", async () => {
      const { store, meta } = await setup(config.create);
      const results = await store.read(
        meta,
        [
          "store://empty/?fn=count",
        ],
      );
      assertEquals(payloadOf(results[0]), 0);
    });

    t("fn=count honours pattern= as a URI-tail glob filter", async () => {
      const { store, meta } = await setup(config.create);
      await store.write(
        meta,
        wrap([
          { uri: "store://pc/alice", payload: enc("1") },
          { uri: "store://pc/albert", payload: enc("2") },
          { uri: "store://pc/bob", payload: enc("3") },
        ]),
      );
      const results = await store.read(
        meta,
        ["store://pc/?fn=count&pattern=al*"],
      );
      assertEquals(payloadOf(results[0]), 2);
    });
  }

  // ── find (v2 §3.5 — recursive walk) ──────────────────────────────

  if (supportsFind) {
    t(
      "fn=find returns descendants at any depth (no shallow cutoff)",
      async () => {
        const { store, meta } = await setup(config.create);
        await store.write(
          meta,
          wrap([
            { uri: "store://f/a", payload: enc("A") },
            { uri: "store://f/sub/b", payload: enc("B") },
            { uri: "store://f/sub/deep/c", payload: enc("C") },
            { uri: "store://other/x", payload: enc("X") },
          ]),
        );
        const results = await store.read(
          meta,
          ["store://f/**?fn=find&format=uris&sortBy=uri"],
        );
        assertEquals(payloadOf(results[0]) as string[], [
          "store://f/a",
          "store://f/sub/b",
          "store://f/sub/deep/c",
        ]);
      },
    );

    t("fn=find filters by embedded glob pattern", async () => {
      const { store, meta } = await setup(config.create);
      await store.write(
        meta,
        wrap([
          { uri: "store://fg/alice/msg/1.md", payload: enc("1") },
          { uri: "store://fg/alice/msg/2.md", payload: enc("2") },
          { uri: "store://fg/bob/msg/3.md", payload: enc("3") },
          { uri: "store://fg/alice/profile.json", payload: enc("p") },
        ]),
      );
      const results = await store.read(
        meta,
        ["store://fg/**/msg/*.md?fn=find&format=uris&sortBy=uri"],
      );
      assertEquals(payloadOf(results[0]) as string[], [
        "store://fg/alice/msg/1.md",
        "store://fg/alice/msg/2.md",
        "store://fg/bob/msg/3.md",
      ]);
    });

    t("fn=find under a sub-prefix scopes to that branch", async () => {
      const { store, meta } = await setup(config.create);
      await store.write(
        meta,
        wrap([
          { uri: "store://sp/alice/a", payload: enc("1") },
          { uri: "store://sp/alice/sub/b", payload: enc("2") },
          { uri: "store://sp/bob/c", payload: enc("3") },
        ]),
      );
      const results = await store.read(
        meta,
        ["store://sp/alice/**?fn=find&format=uris&sortBy=uri"],
      );
      assertEquals(payloadOf(results[0]) as string[], [
        "store://sp/alice/a",
        "store://sp/alice/sub/b",
      ]);
    });

    t("fn=find returns full Output[] for format=full (default)", async () => {
      const { store, meta } = await setup(config.create);
      await store.write(
        meta,
        wrap([
          { uri: "store://ff/a", payload: enc("A") },
          { uri: "store://ff/sub/b", payload: enc("B") },
        ]),
      );
      const results = await store.read(
        meta,
        ["store://ff/**?fn=find&sortBy=uri"],
      );
      const children = payloadOf(results[0]) as Output[];
      assertEquals(children.map(uriOf), [
        "store://ff/a",
        "store://ff/sub/b",
      ]);
      await assertBytesEqual(children[0][1], enc("A"));
      await assertBytesEqual(children[1][1], enc("B"));
    });

    t("fn=find with limit appends cursor-as-trailing-slot", async () => {
      const { store, meta } = await setup(config.create);
      await store.write(
        meta,
        wrap([
          { uri: "store://fc/a", payload: enc("1") },
          { uri: "store://fc/b", payload: enc("2") },
          { uri: "store://fc/sub/c", payload: enc("3") },
          { uri: "store://fc/sub/d", payload: enc("4") },
        ]),
      );
      const page1 = await store.read(meta, [
        "store://fc/**?fn=find&format=uris&sortBy=uri&limit=2",
      ]);
      const raw1 = payloadOf(page1[0]) as unknown[];
      const uris1 = stripCursorSlot(raw1) as string[];
      assertEquals(uris1, ["store://fc/a", "store://fc/b"]);
      // The trailing slot's URI is re-issuable as the next page request.
      const slot = raw1[raw1.length - 1] as Output;
      const nextUrl = slot[0];
      const page2 = await store.read(meta, [nextUrl]);
      assertEquals(stripCursorSlot(payloadOf(page2[0]) as unknown[]), [
        "store://fc/sub/c",
        "store://fc/sub/d",
      ]);
    });

    t(
      "fn=find honours explicit cursor= query over the deep result set",
      async () => {
        const { store, meta } = await setup(config.create);
        await store.write(
          meta,
          wrap([
            { uri: "store://pg/alice", payload: enc("1") },
            { uri: "store://pg/alice/x", payload: enc("2") },
            { uri: "store://pg/alice/y", payload: enc("3") },
            { uri: "store://pg/bob", payload: enc("4") },
            { uri: "store://pg/bob/z", payload: enc("5") },
          ]),
        );
        const page1 = await store.read(meta, [
          "store://pg/**?fn=find&format=uris&sortBy=uri&limit=2",
        ]);
        const uris1 = stripCursorSlot(
          payloadOf(page1[0]) as unknown[],
        ) as string[];
        assertEquals(uris1, ["store://pg/alice", "store://pg/alice/x"]);
        const cursor = uris1[uris1.length - 1];
        const page2 = await store.read(meta, [
          `store://pg/**?fn=find&format=uris&sortBy=uri&limit=2&cursor=${
            encodeURIComponent(cursor)
          }`,
        ]);
        assertEquals(stripCursorSlot(payloadOf(page2[0]) as unknown[]), [
          "store://pg/alice/y",
          "store://pg/bob",
        ]);
      },
    );

    t("fn=find returns empty array when no descendants match", async () => {
      const { store, meta } = await setup(config.create);
      const results = await store.read(
        meta,
        ["store://fe/**?fn=find&format=uris"],
      );
      const uris = stripCursorSlot(payloadOf(results[0]) as unknown[]);
      assertEquals(uris, []);
    });
  } else {
    t("fn=find throws when store does not advertise it (v2 §3.5)", async () => {
      const { store, meta } = await setup(config.create);
      await assertRejects(
        () =>
          store.read(
            meta,
            ["store://nf/**?fn=find"],
          ),
        Error,
        "unsupported fn 'find'",
      );
    });
  }

  // ── Unknown fn ───────────────────────────────────────────────────

  t("unknown fn throws", async () => {
    const { store, meta } = await setup(config.create);
    await assertRejects(
      () =>
        store.read(
          meta,
          ["store://t/?fn=bogus"],
        ),
      Error,
    );
  });

  // ── Delete ───────────────────────────────────────────────────────

  t("delete returns success", async () => {
    const { store, meta } = await setup(config.create);
    await store.write(
      meta,
      wrap([{ uri: "store://app/x", payload: enc("hello") }]),
    );
    const results = await store.delete(
      meta,
      ["store://app/x"],
    );
    assertEquals(results.length, 1);
    assertEquals(results[0].success, true);
  });

  t("delete removes entry (read miss after delete)", async () => {
    const { store, meta } = await setup(config.create);
    await store.write(
      meta,
      wrap([{ uri: "store://app/x", payload: enc("hello") }]),
    );
    await store.delete(
      meta,
      ["store://app/x"],
    );
    const results = await store.read(
      meta,
      ["store://app/x"],
    );
    assertEquals(payloadOf(results[0]), undefined);
  });

  t("delete nonexistent succeeds silently", async () => {
    const { store, meta } = await setup(config.create);
    const results = await store.delete(
      meta,
      ["store://app/missing"],
    );
    assertEquals(results.length, 1);
    assertEquals(results[0].success, true);
  });

  t("batch delete", async () => {
    const { store, meta } = await setup(config.create);
    await store.write(
      meta,
      wrap([
        { uri: "store://app/a", payload: enc("A") },
        { uri: "store://app/b", payload: enc("B") },
        { uri: "store://app/c", payload: enc("C") },
      ]),
    );
    await store.delete(
      meta,
      ["store://app/a", "store://app/c"],
    );
    const results = await store.read(
      meta,
      [
        "store://app/a",
        "store://app/b",
        "store://app/c",
      ],
    );
    assertEquals(payloadOf(results[0]), undefined);
    await assertBytesEqual(payloadOf(results[1]), enc("B"));
    assertEquals(payloadOf(results[2]), undefined);
  });

  // ── Status / Capabilities ────────────────────────────────────────

  t("status returns healthy and advertises fns", async () => {
    const { store, meta: _ } = await setup(config.create);
    const status = await store.status();
    assertEquals(status.status, "healthy");
    if (status.fns) {
      // Every supported fn should be listed; we don't insist on exact
      // set so stores can advertise x-* extensions too.
      assertEquals(status.fns.includes("read"), true);
      if (supportsLs) assertEquals(status.fns.includes("ls"), true);
      if (supportsFind) assertEquals(status.fns.includes("find"), true);
      if (supportsCount) assertEquals(status.fns.includes("count"), true);
      if (supportsFind) assertEquals(status.fns.includes("find"), true);
    }
  });

  t("capabilities returns valid shape (if implemented)", async () => {
    const { store, meta: _ } = await setup(config.create);
    if (store.capabilities) {
      const caps = store.capabilities();
      if (caps.atomicBatch !== undefined) {
        assertEquals(typeof caps.atomicBatch, "boolean");
      }
    }
  });
}
