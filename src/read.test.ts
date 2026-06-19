/// <reference lib="deno.ns" />
import { assertEquals, assertThrows } from "jsr:@std/assert";
import type { Output } from "@bandeira-tech/b3nd-core/types";
import {
  applyReadParams,
  matchesUriPattern,
  patternToRegex,
  patternToRegexBody,
  patternToSqlLike,
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

Deno.test("unsupported sortBy throws", () => {
  assertThrows(
    () => applyReadParams(rows, { sortBy: "data" }, "test"),
    Error,
    "unsupported sortBy",
  );
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

Deno.test("cursor throws", () => {
  assertThrows(
    () => applyReadParams(rows, { cursor: "abc" }, "test"),
    Error,
    "cursor not supported",
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

// ── pattern ────────────────────────────────────────────────────────

Deno.test("patternToRegex - * matches non-/ run, anchored", () => {
  const re = patternToRegex("al*");
  assertEquals(re.test("alice"), true);
  assertEquals(re.test("albert"), true);
  assertEquals(re.test("bob"), false);
  assertEquals(re.test("alice/x"), false); // * does not cross /
});

Deno.test("patternToRegex - ? matches single non-/ char", () => {
  const re = patternToRegex("a?ice");
  assertEquals(re.test("alice"), true);
  assertEquals(re.test("aBice"), true);
  assertEquals(re.test("abbice"), false);
});

Deno.test("patternToRegex - regex metachars in pattern are escaped", () => {
  const re = patternToRegex("foo.bar");
  assertEquals(re.test("foo.bar"), true);
  assertEquals(re.test("fooXbar"), false);
});

Deno.test("matchesUriPattern - matches against URI tail after prefix", () => {
  assertEquals(matchesUriPattern("x://u/alice", "x://u/", "al*"), true);
  assertEquals(matchesUriPattern("x://u/bob", "x://u/", "al*"), false);
});

Deno.test("matchesUriPattern - undefined pattern returns true", () => {
  assertEquals(matchesUriPattern("x://u/anything", "x://u/", undefined), true);
});

// ── patternToRegexBody (Mongo / ES push-down) ──────────────────────

Deno.test("patternToRegexBody - matches patternToRegex without anchors", () => {
  assertEquals(patternToRegexBody("al*"), "al[^/]*");
  assertEquals(patternToRegexBody("a?ice"), "a[^/]ice");
});

Deno.test("patternToRegexBody - composes with custom anchors (round-trips with patternToRegex)", () => {
  const body = patternToRegexBody("al*");
  const re = new RegExp("^" + body + "$");
  assertEquals(re.source, patternToRegex("al*").source);
});

Deno.test("patternToRegexBody - escapes regex metacharacters", () => {
  assertEquals(patternToRegexBody("foo.bar"), "foo\\.bar");
  assertEquals(patternToRegexBody("a+b"), "a\\+b");
});

// ── patternToSqlLike (SQL push-down) ───────────────────────────────

Deno.test("patternToSqlLike - * → %, ? → _", () => {
  assertEquals(patternToSqlLike("al*"), "al%");
  assertEquals(patternToSqlLike("a?ice"), "a_ice");
  assertEquals(patternToSqlLike("*alice*"), "%alice%");
});

Deno.test("patternToSqlLike - escapes literal %, _, and \\ in pattern", () => {
  assertEquals(patternToSqlLike("100%"), "100\\%");
  assertEquals(patternToSqlLike("hello_world"), "hello\\_world");
  assertEquals(patternToSqlLike("a\\b"), "a\\\\b");
});

Deno.test("patternToSqlLike - empty pattern is empty body", () => {
  assertEquals(patternToSqlLike(""), "");
});
