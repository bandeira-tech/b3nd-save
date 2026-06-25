/// <reference lib="deno.ns" />
/**
 * Tests for `./glob.ts` — the save-side adapters around core's
 * `compilePattern`. See §3.3.1 of the v2 listing spec
 * (`.cc-chat/20260625121936-grammar-shape/output.md`) for the wrapper
 * design.
 *
 * Two paths exercised:
 *   1. Inside-subset (no `?`, no mid-`**`, no `**`-not-trailing) —
 *      `compileSaveGlob` MUST agree with `compilePattern` for every
 *      URI in the battery. The spec calls this "byte-equality"; we
 *      assert it behaviourally over a wide URI battery, plus we
 *      cross-check by inspecting RegExp.source.
 *   2. Outside-subset (`?`, mid-`**`, etc.) — `compileSaveGlob` uses
 *      the save-local grammar from §3.3.
 */

import { assertEquals } from "jsr:@std/assert";
import { compilePattern } from "@bandeira-tech/b3nd-core";
import {
  compileSaveGlob,
  globToSqlLike,
  matchesGlob,
  saveGlobToRegexBody,
} from "./glob.ts";

// ── Inside-subset: byte/behaviour parity with compilePattern ────────

// Patterns inside core's supported subset: no `?`, no mid-`**`, every
// `**` (if present) is the final segment, `*` segments only match
// non-empty. We assert both engines agree on a battery of URIs.
const INSIDE_SUBSET_PATTERNS = [
  "mutable://users/alice", // pure literal
  "mutable://users/*", // single * segment
  "mutable://**", // trailing ** only
  "mutable://users/*/posts", // mid-* segment
  "mutable://users/*/posts/**", // * then trailing **
  "mutable://users/*/posts/*", // two * segments
  "mutable://x.com/foo", // literal with regex metachar
];

const URI_BATTERY = [
  "mutable://users/alice",
  "mutable://users/bob",
  "mutable://users/alice/posts",
  "mutable://users/alice/posts/1",
  "mutable://users/alice/posts/1/comments",
  "mutable://other/path",
  "mutable://users/",
  "mutable://users",
  "mutable://x.com/foo",
  "mutable://xYcom/foo", // confirms `.` is a literal, not metachar
  "mutable://x/y/z",
];

Deno.test("compileSaveGlob - inside-subset patterns behave like compilePattern", () => {
  for (const pattern of INSIDE_SUBSET_PATTERNS) {
    const core = compilePattern(pattern);
    const save = compileSaveGlob(pattern);
    for (const uri of URI_BATTERY) {
      const coreMatch = core(uri);
      const saveMatch = save.test(uri);
      assertEquals(
        saveMatch,
        coreMatch,
        `pattern "${pattern}" / uri "${uri}": core=${coreMatch} save=${saveMatch}`,
      );
    }
  }
});

Deno.test("compileSaveGlob - inside-subset regex.source byte-equality vs compilePattern recipe", () => {
  // compilePattern doesn't expose its compiled RegExp directly (it
  // returns a Matcher closure). The contract §3.3.1 promises is byte-
  // equal regex output for inside-subset patterns. We assert that by
  // replicating the exact toRegex recipe core uses (see
  // b3nd-core/src/match-pattern/match-pattern.ts:140-167) and
  // comparing it byte-for-byte with `compileSaveGlob`'s output.
  const replicateCoreRegex = (pattern: string): RegExp => {
    const ONE = "\x00ONE\x00";
    const REST = "\x00REST\x00";
    const swapped = pattern
      .split("/")
      .map((seg) => seg === "*" ? ONE : seg === "**" ? REST : seg)
      .join("/");
    const escaped = swapped.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const body = escaped.replaceAll(ONE, "[^/]+").replaceAll(REST, ".*");
    return new RegExp(`^${body}$`);
  };

  for (const pattern of INSIDE_SUBSET_PATTERNS) {
    // Pure literal patterns: compilePattern returns a direct equality
    // check, not a regex. Skip the source comparison for those — the
    // behavioural test above already covers them.
    if (
      !pattern.includes("*") && !pattern.includes("?")
    ) continue;
    const expected = replicateCoreRegex(pattern);
    const actual = compileSaveGlob(pattern);
    assertEquals(
      actual.source,
      expected.source,
      `byte-equality fail for "${pattern}"`,
    );
  }
});

// ── Outside-subset: save-local §3.3 grammar ─────────────────────────

Deno.test("compileSaveGlob - `?` matches exactly one non-/ char", () => {
  const re = compileSaveGlob("a?ice");
  assertEquals(re.test("alice"), true);
  assertEquals(re.test("aXice"), true);
  assertEquals(re.test("aice"), false); // ? requires one char
  assertEquals(re.test("abbice"), false);
});

Deno.test("compileSaveGlob - `**` works in mid-pattern (save-local extension)", () => {
  // `**/foo/**` — find anywhere with `foo` as a directory.
  const re = compileSaveGlob("**/foo/**");
  assertEquals(re.test("/foo/bar"), true);
  assertEquals(re.test("a/foo/b"), true);
  assertEquals(re.test("a/b/foo/c/d"), true);
  assertEquals(re.test("a/bar/c"), false);
});

Deno.test("compileSaveGlob - `*` allows zero-length match (save-local)", () => {
  // Save spec §3.3: `*` matches zero or more non-/ chars. Core's
  // grammar matches one-or-more. A pattern of just `*` is routed to
  // the inside-subset path (compilePattern's `[^/]+`), so this test
  // covers patterns that escape into the save-local path via `?` or
  // mid-`**`.
  const re = compileSaveGlob("a*?");
  // `*` allows zero, then `?` requires one char.
  assertEquals(re.test("ab"), true);
  assertEquals(re.test("axyz"), true);
  assertEquals(re.test("a"), false); // ? still needs one
});

Deno.test("compileSaveGlob - regex metachars in literal segments are escaped", () => {
  // `.` should match literal `.`, not any char.
  const re = compileSaveGlob("foo.bar/**");
  assertEquals(re.test("foo.bar/x"), true);
  assertEquals(re.test("fooXbar/x"), false);
});

// ── matchesGlob convenience wrapper ─────────────────────────────────

Deno.test("matchesGlob - undefined pattern matches anything under prefix", () => {
  assertEquals(matchesGlob("x://a/foo", "x://a/", undefined), true);
});

Deno.test("matchesGlob - false when uri doesn't start with prefix", () => {
  assertEquals(matchesGlob("x://b/foo", "x://a/", "**"), false);
});

Deno.test("matchesGlob - true when tail matches glob", () => {
  assertEquals(matchesGlob("x://a/alice", "x://a/", "al*"), true);
  assertEquals(matchesGlob("x://a/bob", "x://a/", "al*"), false);
});

// ── saveGlobToRegexBody (mongo/elasticsearch push-down) ─────────────

Deno.test("saveGlobToRegexBody - inside-subset `*` → `[^/]+`", () => {
  // Matches what compilePattern's toRegex emits (modulo anchors).
  assertEquals(saveGlobToRegexBody("*"), "[^/]+");
});

Deno.test("saveGlobToRegexBody - outside-subset `?` → `[^/]`", () => {
  assertEquals(saveGlobToRegexBody("a?b"), "a[^/]b");
});

Deno.test("saveGlobToRegexBody - escapes regex metachars in literals", () => {
  assertEquals(saveGlobToRegexBody("foo.bar"), "foo\\.bar");
  assertEquals(saveGlobToRegexBody("a+b"), "a\\+b");
});

Deno.test("saveGlobToRegexBody - composes back into an anchored regex matching compileSaveGlob", () => {
  // For inside-subset patterns the body should round-trip with
  // compileSaveGlob's anchored output.
  for (const pattern of ["foo", "a/*", "a/**"]) {
    const body = saveGlobToRegexBody(pattern);
    const re = new RegExp("^" + body + "$");
    assertEquals(re.source, compileSaveGlob(pattern).source);
  }
});

// ── globToSqlLike ───────────────────────────────────────────────────

Deno.test("globToSqlLike - `*` and `**` collapse to `%`", () => {
  assertEquals(globToSqlLike("al*"), "al%");
  assertEquals(globToSqlLike("**"), "%");
  assertEquals(globToSqlLike("a/**"), "a/%");
});

Deno.test("globToSqlLike - `?` becomes `_`", () => {
  assertEquals(globToSqlLike("a?ice"), "a_ice");
});

Deno.test("globToSqlLike - escapes literal %, _, and \\ in pattern", () => {
  assertEquals(globToSqlLike("100%"), "100\\%");
  assertEquals(globToSqlLike("hello_world"), "hello\\_world");
  assertEquals(globToSqlLike("a\\b"), "a\\\\b");
});

Deno.test("globToSqlLike - empty pattern is empty body", () => {
  assertEquals(globToSqlLike(""), "");
});

Deno.test("globToSqlLike - mixed pattern", () => {
  assertEquals(globToSqlLike("**/msg/*.md"), "%/msg/%.md");
});
