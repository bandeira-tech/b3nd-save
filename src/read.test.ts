/// <reference lib="deno.ns" />
import { assertEquals, assertThrows } from "jsr:@std/assert";
import type { Output } from "@bandeira-tech/b3nd-core/types";
import {
  applyReadParams,
  compareSortable,
  leafOf,
  projectRecord,
} from "./read.ts";
import type { EntityRecord } from "./entity.ts";

const rows: Output<string>[] = [
  ["s://a/3", "c"],
  ["s://a/1", "a"],
  ["s://a/2", "b"],
];

Deno.test("default returns rows as full Output[]", () => {
  const out = applyReadParams(rows, {}, "test");
  assertEquals(out, rows);
});

Deno.test("sortBy=uri asc", () => {
  const out = applyReadParams(rows, { sortBy: "uri" }, "test") as Output[];
  assertEquals(out.map(([u]) => u), ["s://a/1", "s://a/2", "s://a/3"]);
});

Deno.test("sortBy=uri desc", () => {
  const out = applyReadParams(
    rows,
    { sortBy: "uri", sortOrder: "desc" },
    "test",
  ) as Output[];
  assertEquals(out.map(([u]) => u), ["s://a/3", "s://a/2", "s://a/1"]);
});

Deno.test("limit + page", () => {
  const out = applyReadParams(
    rows,
    { sortBy: "uri", limit: 1, page: 2 },
    "test",
  ) as Output[];
  assertEquals(out, [["s://a/2", "b"]]);
});

Deno.test("format=uris returns string[]", () => {
  const out = applyReadParams(
    rows,
    { sortBy: "uri", format: "uris" },
    "test",
  );
  assertEquals(out, ["s://a/1", "s://a/2", "s://a/3"]);
});

Deno.test("sortBy=<field> sorts by record field (non-uri)", () => {
  // Records carrying a sortable field; sortBy=age sorts ascending.
  const recRows: Output<EntityRecord>[] = [
    ["s://u/c", { age: 3 }],
    ["s://u/a", { age: 1 }],
    ["s://u/b", { age: 2 }],
  ];
  const out = applyReadParams(
    recRows,
    { sortBy: "age" },
    "test",
  ) as Output<EntityRecord>[];
  assertEquals(out.map(([u]) => u), ["s://u/a", "s://u/b", "s://u/c"]);
});

// ── sortBy=leaf (v1 spec §3.3, foundation PR adds dispatch-level path) ──

Deno.test("sortBy=leaf sorts by basename (everything after last /)", () => {
  const r: Output<string>[] = [
    ["s://x/alice/zzz.md", "z"],
    ["s://x/bob/aaa.md", "a"],
    ["s://x/charlie/mmm.md", "m"],
  ];
  const out = applyReadParams(r, { sortBy: "leaf" }, "test") as Output[];
  assertEquals(out.map(([u]) => u), [
    "s://x/bob/aaa.md", // aaa
    "s://x/charlie/mmm.md", // mmm
    "s://x/alice/zzz.md", // zzz
  ]);
});

Deno.test("sortBy=leaf desc reverses basename order", () => {
  const r: Output<string>[] = [
    ["s://x/a/x.md", "1"],
    ["s://x/b/y.md", "2"],
  ];
  const out = applyReadParams(
    r,
    { sortBy: "leaf", sortOrder: "desc" },
    "test",
  ) as Output[];
  assertEquals(out.map(([u]) => u), ["s://x/b/y.md", "s://x/a/x.md"]);
});

Deno.test("leafOf - basename after last /", () => {
  assertEquals(leafOf("s://x/a/b/c.md"), "c.md");
  assertEquals(leafOf("s://x/foo"), "foo");
  assertEquals(leafOf("no-slash"), "no-slash");
  assertEquals(leafOf("s://x/trailing/"), "");
});

Deno.test("unsupported format throws", () => {
  assertThrows(
    () => applyReadParams(rows, { format: "weird" }, "test"),
    Error,
    "unsupported format",
  );
});

Deno.test("pattern allowed at validation layer (filtering happens elsewhere)", () => {
  // `applyReadParams` no longer throws on `pattern` — pattern is
  // honoured by `dispatchRead` (and by stores that walk their own
  // results, like memory). Callers that route through
  // `applyReadParams` get unfiltered rows here; their dispatch layer
  // applies the filter.
  const out = applyReadParams(rows, { pattern: "al*" }, "test") as Output[];
  assertEquals(out.length, rows.length);
});

Deno.test("cursor filters rows strictly after the cursor uri", () => {
  // rows: s://a/3, s://a/1, s://a/2 — after sortBy=uri asc → 1,2,3.
  // cursor s://a/1 drops s://a/1 itself, leaves 2 and 3.
  const out = applyReadParams(
    rows,
    { sortBy: "uri", cursor: "s://a/1" },
    "test",
  ) as Output[];
  assertEquals(out.map(([u]) => u), ["s://a/2", "s://a/3"]);
});

Deno.test("cursor + page combo throws (incompatible pagination modes)", () => {
  assertThrows(
    () =>
      applyReadParams(rows, { cursor: "s://a/1", page: 2, limit: 1 }, "test"),
    Error,
    "cursor and page cannot be combined",
  );
});

Deno.test("does not mutate input", () => {
  const input: Output<string>[] = [["s://b", "x"], ["s://a", "y"]];
  applyReadParams(input, { sortBy: "uri" }, "test");
  assertEquals(input, [["s://b", "x"], ["s://a", "y"]]);
});

// ── fields ─────────────────────────────────────────────────────────

Deno.test("projectRecord - keeps only declared fields", () => {
  const r: EntityRecord = { name: "Alice", age: 30, blob: new Uint8Array([1]) };
  assertEquals(projectRecord(r, ["name"]), { name: "Alice" });
});

Deno.test("projectRecord - unknown fields silently absent", () => {
  const r: EntityRecord = { name: "Alice" };
  assertEquals(projectRecord(r, ["name", "missing"]), { name: "Alice" });
});

Deno.test("projectRecord - undefined / null pass through", () => {
  assertEquals(projectRecord(undefined, ["x"]), undefined);
  assertEquals(projectRecord(null, ["x"]), null);
});

Deno.test("projectRecord - Uint8Array passes through (bytes payload)", () => {
  const u = new Uint8Array([1, 2, 3]);
  assertEquals(projectRecord(u, ["x"]), u);
});

Deno.test("applyReadParams - fields projects each row record", () => {
  const recRows: Output<EntityRecord>[] = [
    ["s://a/1", { name: "Alice", age: 30 }],
    ["s://a/2", { name: "Bob", age: 25 }],
  ];
  const out = applyReadParams(
    recRows,
    { fields: ["name"] },
    "test",
  ) as Output<EntityRecord>[];
  assertEquals(out, [
    ["s://a/1", { name: "Alice" }],
    ["s://a/2", { name: "Bob" }],
  ]);
});

Deno.test("applyReadParams - fields ignored when format=uris", () => {
  const recRows: Output<EntityRecord>[] = [
    ["s://a/1", { name: "Alice", age: 30 }],
  ];
  assertEquals(
    applyReadParams(recRows, { fields: ["name"], format: "uris" }, "test"),
    ["s://a/1"],
  );
});

// ── compareSortable ────────────────────────────────────────────────

Deno.test("compareSortable - numbers compare numerically", () => {
  assertEquals(compareSortable(1, 2) < 0, true);
  assertEquals(compareSortable(10, 2) > 0, true); // not string compare ("10" < "2")
  assertEquals(compareSortable(1, 1), 0);
});

Deno.test("compareSortable - bigints compare numerically", () => {
  assertEquals(compareSortable(1n, 2n) < 0, true);
  assertEquals(compareSortable(100n, 20n) > 0, true);
});

Deno.test("compareSortable - dates compare by valueOf", () => {
  assertEquals(
    compareSortable(new Date("2025-01-01"), new Date("2026-01-01")) < 0,
    true,
  );
});

Deno.test("compareSortable - booleans: false < true", () => {
  assertEquals(compareSortable(false, true) < 0, true);
});

Deno.test("compareSortable - strings use localeCompare", () => {
  assertEquals(compareSortable("alice", "bob") < 0, true);
});

Deno.test("compareSortable - undefined/null sort last", () => {
  assertEquals(compareSortable(1, undefined) < 0, true);
  assertEquals(compareSortable(undefined, 1) > 0, true);
  assertEquals(compareSortable(undefined, null), 0);
});
