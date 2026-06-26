/**
 * ElasticsearchStore unit tests.
 *
 * The shared store suite covers `BYTES_ENTITY` end-to-end against an
 * in-memory mock that simulates the subset of the ES surface the
 * store uses (index/get/search/count/delete). The remainder of this
 * file covers entity-level behaviour: `entitySupport` purity,
 * `entityStatus` collision detection, `provisionEntity` idempotence
 * and collision-throwing, custom-entity JSON round-trip
 * (bytes/bigint/timestamp), ls/count parity, multi-entity isolation,
 * strict validation, and the natural-failure path against
 * unprovisioned entities. The mock implements Lucene regex
 * auto-anchoring by anchoring the pattern itself on full match.
 */

/// <reference lib="deno.ns" />

import { assert, assertEquals, assertRejects } from "@std/assert";
import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { ElasticsearchStore } from "./store.ts";
import type {
  ElasticsearchExecutor,
  ElasticsearchSearchResult,
} from "./mod.ts";
import { BYTES_ENTITY, type EntityRecord, TYPE_TAGS } from "../entity.ts";

/**
 * Match a Lucene-style regexp against a doc's `path` source field
 * (which mirrors `_id` — see the matching write-side change in
 * store.ts). Anchored on both ends because Lucene regex queries
 * are implicitly full-match.
 */
function matchQuery(
  query: Record<string, unknown> | undefined,
  source: Record<string, unknown>,
): boolean {
  if (!query) return true;
  // bool.must wraps a list of sub-queries — every clause must match.
  const bool = (query as { bool?: { must?: Array<Record<string, unknown>> } })
    .bool;
  if (bool?.must) {
    return bool.must.every((clause) => matchQuery(clause, source));
  }
  const regexp = (query as { regexp?: Record<string, string> }).regexp;
  if (regexp) {
    const field = Object.keys(regexp)[0];
    if (!field) return true;
    const fieldKey = field.replace(/\.keyword$/, "");
    const value = source[fieldKey] as string | undefined;
    if (value === undefined) return false;
    const re = new RegExp(`^${regexp[field]}$`);
    return re.test(value);
  }
  const range = (query as { range?: Record<string, Record<string, string>> })
    .range;
  if (range) {
    const field = Object.keys(range)[0];
    if (!field) return true;
    const fieldKey = field.replace(/\.keyword$/, "");
    const value = source[fieldKey] as string | undefined;
    if (value === undefined) return false;
    const ops = range[field];
    if ("gt" in ops && !(value.localeCompare(ops.gt) > 0)) return false;
    if ("lt" in ops && !(value.localeCompare(ops.lt) < 0)) return false;
    return true;
  }
  return true;
}

function applySort(
  entries: Array<[string, Record<string, unknown>]>,
  sort: Array<Record<string, "asc" | "desc">> | undefined,
): Array<[string, Record<string, unknown>]> {
  const spec = sort?.[0];
  if (!spec) return entries;
  const field = Object.keys(spec)[0];
  if (!field) return entries;
  const fieldKey = field.replace(/\.keyword$/, "");
  const dir = spec[field] === "desc" ? -1 : 1;
  return [...entries].sort(([, a], [, b]) =>
    String(a[fieldKey] ?? "").localeCompare(String(b[fieldKey] ?? "")) * dir
  );
}

function createMockElasticsearchExecutor(): ElasticsearchExecutor {
  const indices = new Map<string, Map<string, Record<string, unknown>>>();

  const getIndex = (index: string) => {
    if (!indices.has(index)) indices.set(index, new Map());
    return indices.get(index)!;
  };

  return {
    index: (index, id, body) => {
      getIndex(index).set(id, body);
      return Promise.resolve();
    },

    get: (index, id) => Promise.resolve(getIndex(index).get(id) ?? null),

    search: (index, body) => {
      const idx = getIndex(index);
      const query = body.query as Record<string, unknown> | undefined;
      const sort = body.sort as
        | Array<Record<string, "asc" | "desc">>
        | undefined;
      const from = (body.from as number) ?? 0;
      const size = (body.size as number) ?? 10_000;
      const sourceOff = body._source === false;

      let entries = [...idx.entries()].filter(([, source]) =>
        matchQuery(query, source)
      );
      entries = applySort(entries, sort);
      entries = entries.slice(from, from + size);

      const hits = entries.map(([id, source]) =>
        sourceOff ? { _id: id } : { _id: id, _source: source }
      );
      return Promise.resolve({ hits } as ElasticsearchSearchResult);
    },

    count: (index, body) => {
      const idx = getIndex(index);
      const query = body.query as Record<string, unknown> | undefined;
      const n =
        [...idx.values()].filter((source) => matchQuery(query, source)).length;
      return Promise.resolve(n);
    },

    delete: (index, id) => {
      getIndex(index).delete(id);
      return Promise.resolve();
    },

    ping: () => Promise.resolve(true),
  };
}

function freshStore() {
  return new ElasticsearchStore("test", createMockElasticsearchExecutor());
}

runSharedStoreSuite("ElasticsearchStore", {
  create: () => freshStore(),
  supportsFind: true,
});

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

Deno.test("ElasticsearchStore.entitySupport — reports canonical tags as supported", () => {
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

Deno.test("ElasticsearchStore.entitySupport — flags unrecognised tags as unsupported", () => {
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

Deno.test("ElasticsearchStore.entitySupport — pure: does not flip status to live", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  assertEquals(await store.entityStatus(meta), "unprovisioned");
});

Deno.test("ElasticsearchStore.entityStatus — reports live only after provisionEntity", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  assertEquals(await store.entityStatus(meta), "live");
});

Deno.test("ElasticsearchStore.entityStatus — same-name different-shape reports unprovisioned", async () => {
  const store = freshStore();
  await store.provisionEntity(store.entitySupport(userSchema));
  const collision = store.entitySupport({
    name: "users",
    fields: [{ name: "name", type: [TYPE_TAGS.STRING] }],
  });
  assertEquals(await store.entityStatus(collision), "unprovisioned");
});

Deno.test("ElasticsearchStore.provisionEntity — idempotent on identical meta", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.provisionEntity(meta);
  assertEquals(await store.entityStatus(meta), "live");
});

Deno.test("ElasticsearchStore.provisionEntity — throws on same-name different-shape", async () => {
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

// ── Custom-entity JSON round-trip ──────────────────────────────────

Deno.test("ElasticsearchStore — custom entity: write/read round-trips string/number/bytes/json", async () => {
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

Deno.test("ElasticsearchStore — custom entity: bigint round-trips through JSON", async () => {
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

Deno.test("ElasticsearchStore — custom entity: timestamp round-trips through JSON", async () => {
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

Deno.test("ElasticsearchStore — custom entity: read miss returns undefined", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  const [[, rec]] = await store.read(meta, ["data://users/none"]);
  assertEquals(rec, undefined);
});

Deno.test("ElasticsearchStore — custom entity: delete removes the record", async () => {
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

Deno.test("ElasticsearchStore — custom entity: ls returns direct leaves under the entity prefix", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "data://users/alice", record: { name: "Alice" } },
    { uri: "data://users/bob", record: { name: "Bob" } },
    { uri: "data://users/team/charlie", record: { name: "Charlie" } },
  ]);
  const [[, rows]] = await store.read<Array<[string, EntityRecord]>>(meta, [
    "data://users/",
  ]);
  const uris = rows.map(([u]) => u).sort();
  assertEquals(uris, ["data://users/alice", "data://users/bob"]);
});

Deno.test("ElasticsearchStore — custom entity: ls supports limit + page + sortOrder push-down", async () => {
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

Deno.test("ElasticsearchStore — custom entity: count returns the number of direct leaves", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "x://u/a", record: { name: "a" } },
    { uri: "x://u/b", record: { name: "b" } },
    { uri: "x://u/nested/c", record: { name: "c" } },
  ]);
  const [[, n]] = await store.read<number>(meta, ["x://u/?fn=count"]);
  assertEquals(n, 2);
});

// ── Multi-entity isolation ─────────────────────────────────────────

Deno.test("ElasticsearchStore — hosts multiple entities side-by-side without interference", async () => {
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

Deno.test("ElasticsearchStore — BYTES_ENTITY and a custom entity at the same URI do not interfere", async () => {
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
  const bytesPayload = (b as EntityRecord).payload as Uint8Array;
  assertEquals(new TextDecoder().decode(bytesPayload), "bytes-side");
  const [[, rec]] = await store.read(userMeta, ["data://users/alice"]);
  assertEquals((rec as EntityRecord).name, "entity-side");
});

// ── Strict validation: error reporting, no silent drops ────────────

Deno.test("ElasticsearchStore — write with extra fields reports a per-entry error", async () => {
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

Deno.test("ElasticsearchStore.write — unprovisioned entity surfaces per-entry storage failure", async () => {
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

Deno.test("ElasticsearchStore.read — unprovisioned entity returns undefined payloads", async () => {
  const store = freshStore();
  const meta = store.entitySupport({
    name: "fresh",
    fields: [{ name: "k", type: [TYPE_TAGS.STRING] }],
  });
  const [[, rec]] = await store.read(meta, ["data://fresh/1"]);
  assertEquals(rec, undefined);
});

// ── Status ─────────────────────────────────────────────────────────

Deno.test("ElasticsearchStore.status — lists every provisioned entity", async () => {
  const store = freshStore();
  await store.provisionEntity(store.entitySupport(BYTES_ENTITY));
  await store.provisionEntity(store.entitySupport(userSchema));
  const s = await store.status();
  const schema = s.schema ?? [];
  assert(schema.includes("entity:bytes"));
  assert(schema.includes("entity:users"));
});

// ── fn=find: ES-specific edge cases ───────────────────────────────
// The shared suite covers the v2 §3.5 contract end-to-end (deep walk,
// glob filter, sub-prefix scoping, cursor-as-trailing-slot). These
// tests cover ES-specific surfaces the shared suite doesn't reach:
// status().fns advertisement; the ls-shallow / find-deep regression
// (ls keeps `[^/]+` body, find swaps to `.*`); mid-`**` patterns
// (`alice/**/posts`); pagination via cursor+limit; and the
// pushDownCount path against a deep `**` URL hitting `_count` rather
// than walking via find.

Deno.test("ElasticsearchStore — status().fns advertises 'find'", async () => {
  const s = await freshStore().status();
  assertEquals(s.fns, ["read", "ls", "count", "find"]);
});

Deno.test("ElasticsearchStore — ls stays shallow even when find sees deep entries", async () => {
  const store = freshStore();
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "x://r/leaf", record: { payload: new TextEncoder().encode("L") } },
    {
      uri: "x://r/sub/nested",
      record: { payload: new TextEncoder().encode("N") },
    },
  ]);
  const lsResult = await store.read<string[]>(meta, [
    "x://r/?fn=ls&format=uris&sortBy=uri",
  ]);
  assertEquals(lsResult[0][1], ["x://r/leaf"]);
  const findResult = await store.read<string[]>(meta, [
    "x://r/**?fn=find&format=uris&sortBy=uri",
  ]);
  assertEquals(findResult[0][1], [
    "x://r/leaf",
    "x://r/sub/nested",
  ]);
});

Deno.test("ElasticsearchStore — fn=find walks deeply on a custom entity", async () => {
  const store = freshStore();
  const meta = store.entitySupport(userSchema);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "x://u/a", record: { name: "A", age: 1 } },
    { uri: "x://u/sub/b", record: { name: "B", age: 2 } },
    { uri: "x://u/sub/deep/c", record: { name: "C", age: 3 } },
  ]);
  const [[, rows]] = await store.read<Array<[string, EntityRecord]>>(meta, [
    "x://u/**?fn=find&sortBy=uri",
  ]);
  const list = rows as Array<[string, EntityRecord]>;
  assertEquals(list.map(([u]) => u), [
    "x://u/a",
    "x://u/sub/b",
    "x://u/sub/deep/c",
  ]);
  assertEquals(list[0][1].name, "A");
  assertEquals(list[2][1].age, 3);
});

Deno.test("ElasticsearchStore — fn=find honours mid-`**` patterns (alice/**/posts)", async () => {
  // Mid-`**` is the §3.3.1 save-local-regex path — `compilePattern`
  // would throw. The Lucene regexp body comes from
  // `saveGlobToRegexBody`, which collapses `alice/**/posts/*.md` to
  // `alice/.*posts/[^/]*\.md` (the slash-eat fix). This exercises that
  // the composed regex against ES regexp query still matches the
  // zero-segment case (`alice/posts/...`) AND the multi-segment case.
  const store = freshStore();
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  const payload = new TextEncoder().encode("x");
  await store.write(meta, [
    { uri: "x://r/alice/posts/1.md", record: { payload } },
    { uri: "x://r/alice/x/posts/2.md", record: { payload } },
    { uri: "x://r/alice/x/y/posts/3.md", record: { payload } },
    { uri: "x://r/alice/x/notes/4.md", record: { payload } }, // no match
    { uri: "x://r/bob/posts/5.md", record: { payload } }, // no match (not alice)
  ]);
  const [[, uris]] = await store.read<string[]>(meta, [
    "x://r/alice/**/posts/*.md?fn=find&format=uris&sortBy=uri",
  ]);
  assertEquals(uris, [
    "x://r/alice/posts/1.md",
    "x://r/alice/x/posts/2.md",
    "x://r/alice/x/y/posts/3.md",
  ]);
});

Deno.test("ElasticsearchStore — fn=find paginates via cursor+limit, trailing cursor slot", async () => {
  const store = freshStore();
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  const payload = new TextEncoder().encode("x");
  for (const n of ["a", "b", "c", "d", "e"]) {
    await store.write(meta, [{
      uri: `x://r/sub/${n}.md`,
      record: { payload },
    }]);
  }
  // First page: 2 entries + trailing cursor slot.
  const r1 = await store.read<string[]>(meta, [
    "x://r/**?fn=find&format=uris&sortBy=uri&limit=2",
  ]);
  const page1 = r1[0][1] as unknown as Array<string | [string, unknown]>;
  // Last slot is the cursor slot `[uri, {next}]`; preceding entries are
  // plain string uris (format=uris).
  const cursorSlot1 = page1[page1.length - 1] as [string, { next: string }];
  const rows1 = page1.slice(0, -1) as string[];
  assertEquals(rows1, ["x://r/sub/a.md", "x://r/sub/b.md"]);
  assert(cursorSlot1[1].next === "x://r/sub/b.md");

  // Re-issue with the cursor slot URI as-is — that's the contract.
  const r2 = await store.read<string[]>(meta, [cursorSlot1[0]]);
  const page2 = r2[0][1] as unknown as Array<string | [string, unknown]>;
  const cursorSlot2 = page2[page2.length - 1] as [string, { next: string }];
  const rows2 = page2.slice(0, -1) as string[];
  assertEquals(rows2, ["x://r/sub/c.md", "x://r/sub/d.md"]);
  assert(cursorSlot2[1].next === "x://r/sub/d.md");

  // Final page: one entry + next: null.
  const r3 = await store.read<string[]>(meta, [cursorSlot2[0]]);
  const page3 = r3[0][1] as unknown as Array<string | [string, unknown]>;
  const cursorSlot3 = page3[page3.length - 1] as [
    string,
    { next: string | null },
  ];
  const rows3 = page3.slice(0, -1) as string[];
  assertEquals(rows3, ["x://r/sub/e.md"]);
  assertEquals(cursorSlot3[1].next, null);
});

Deno.test("ElasticsearchStore — fn=count over `**` uses pushDownCount (native _count, no walk)", async () => {
  // Spy on the executor to ensure the count path hits `count()` and
  // NOT `search()` — the pushDownCount: true contract is that deep
  // counts never fall back to walking via handlers.find.
  const indices = new Map<string, Map<string, Record<string, unknown>>>();
  const getIndex = (index: string) => {
    if (!indices.has(index)) indices.set(index, new Map());
    return indices.get(index)!;
  };
  let countCalls = 0;
  let searchCalls = 0;
  const spyExecutor: ElasticsearchExecutor = {
    index: (index, id, body) => {
      getIndex(index).set(id, body);
      return Promise.resolve();
    },
    get: (index, id) => Promise.resolve(getIndex(index).get(id) ?? null),
    search: (index, body) => {
      searchCalls++;
      const idx = getIndex(index);
      const query = body.query as Record<string, unknown> | undefined;
      let entries = [...idx.entries()].filter(([, source]) =>
        matchQuery(query, source)
      );
      entries = applySort(
        entries,
        body.sort as Array<Record<string, "asc" | "desc">> | undefined,
      );
      const from = (body.from as number) ?? 0;
      const size = (body.size as number) ?? 10_000;
      entries = entries.slice(from, from + size);
      const sourceOff = body._source === false;
      const hits = entries.map(([id, source]) =>
        sourceOff ? { _id: id } : { _id: id, _source: source }
      );
      return Promise.resolve({ hits } as ElasticsearchSearchResult);
    },
    count: (index, body) => {
      countCalls++;
      const idx = getIndex(index);
      const query = body.query as Record<string, unknown> | undefined;
      const n =
        [...idx.values()].filter((source) => matchQuery(query, source)).length;
      return Promise.resolve(n);
    },
    delete: (index, id) => {
      getIndex(index).delete(id);
      return Promise.resolve();
    },
    ping: () => Promise.resolve(true),
  };
  const store = new ElasticsearchStore("test", spyExecutor);
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  const payload = new TextEncoder().encode("x");
  await store.write(meta, [
    { uri: "x://r/a", record: { payload } },
    { uri: "x://r/sub/b", record: { payload } },
    { uri: "x://r/sub/deep/c", record: { payload } },
  ]);
  const writeSearches = searchCalls; // baseline
  const [[, n]] = await store.read<number>(meta, ["x://r/**?fn=count"]);
  assertEquals(n, 3);
  assert(countCalls >= 1, "pushDownCount path must call executor.count");
  assertEquals(
    searchCalls,
    writeSearches,
    "deep count must not walk via search/handlers.find",
  );
});
