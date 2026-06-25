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
  // `a/**`: trailing `/**` eats the leading literal `/` (zero-segment
  // fix — see PR #86 concern #2 regression tests below). Without the
  // eat-adjacent-`/` rule, the body would be `a/%` which fails to
  // match the bare `a` (zero-segment-after case).
  assertEquals(globToSqlLike("a/**"), "a%");
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

// ── Regression: `**` zero-segment semantics (PR #86 concern #2) ─────
//
// v2 spec §3.3 promises `**` matches "zero or more segments". The
// historical bug: `alice/**/posts/1.md` compiled to LIKE body
// `alice/%/posts/1.md`, leaving the surrounding `/` chars literal — so
// `alice/posts/1.md` (zero segments between) did NOT match. The fix:
// when `**` is bordered by `/`, eat one adjacent `/` so the resulting
// `%` (LIKE) / `.*` (regex) can subsume the boundary slash too.
//
// We verify the property via simulated LIKE matching (translate `%`/`_`
// to regex and test). The eat-trailing-slash encoding is one of several
// valid choices; the property tests pin behaviour, not encoding shape.

function likeMatches(body: string, uri: string): boolean {
  // Translate LIKE → regex for testing. `\\` is the escape so `\\%`,
  // `\\_`, `\\\\` are literal. Other chars escape regex metachars.
  let re = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && i + 1 < body.length) {
      re += body[i + 1].replace(/[.+?^${}()|[\]\\/]/g, "\\$&");
      i++;
    } else if (ch === "%") {
      re += ".*";
    } else if (ch === "_") {
      re += ".";
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$").test(uri);
}

Deno.test("globToSqlLike - `/**/ ` matches zero segments between (regression: PR #86 concern #2)", () => {
  const body = globToSqlLike("alice/**/posts/1.md");
  assertEquals(
    likeMatches(body, "alice/posts/1.md"),
    true,
    `body="${body}" must match zero-segment case "alice/posts/1.md"`,
  );
  assertEquals(likeMatches(body, "alice/X/posts/1.md"), true);
  assertEquals(likeMatches(body, "alice/X/Y/posts/1.md"), true);
  assertEquals(likeMatches(body, "bob/posts/1.md"), false);
  assertEquals(likeMatches(body, "alice/posts/2.md"), false);
});

Deno.test("globToSqlLike - leading `**/` matches zero segments before", () => {
  const body = globToSqlLike("**/posts/1.md");
  assertEquals(likeMatches(body, "posts/1.md"), true);
  assertEquals(likeMatches(body, "X/posts/1.md"), true);
  assertEquals(likeMatches(body, "X/Y/posts/1.md"), true);
  assertEquals(likeMatches(body, "posts/2.md"), false);
});

Deno.test("globToSqlLike - trailing `/**` matches zero segments after", () => {
  const body = globToSqlLike("alice/**");
  assertEquals(likeMatches(body, "alice"), true);
  assertEquals(likeMatches(body, "alice/foo"), true);
  assertEquals(likeMatches(body, "alice/X/foo"), true);
  assertEquals(likeMatches(body, "bob"), false);
});

Deno.test("globToSqlLike - multiple `**` mid-pattern, all zero-segment cases", () => {
  const body = globToSqlLike("a/**/b/**/c");
  assertEquals(likeMatches(body, "a/b/c"), true, `body="${body}"`);
  assertEquals(likeMatches(body, "a/X/b/c"), true);
  assertEquals(likeMatches(body, "a/b/X/c"), true);
  assertEquals(likeMatches(body, "a/X/b/Y/c"), true);
  assertEquals(likeMatches(body, "a/X/Y/b/c"), true);
  assertEquals(likeMatches(body, "a/c"), false); // missing `b`
});

Deno.test("globToSqlLike - mixed pattern", () => {
  // `**/msg/*.md`. Under the eat-trailing-/ rule, `**/` → `%`, so the
  // body is `%msg/%.md` — which matches `msg/x.md` (zero segments
  // before) and `a/b/msg/x.md` (multi segments before) alike.
  const body = globToSqlLike("**/msg/*.md");
  assertEquals(likeMatches(body, "msg/x.md"), true);
  assertEquals(likeMatches(body, "a/msg/x.md"), true);
  assertEquals(likeMatches(body, "a/b/msg/x.md"), true);
  assertEquals(likeMatches(body, "msg/x.txt"), false);
});

// ── Regression: `**` zero-segment in regex paths ────────────────────
//
// The regex path (`compileSaveGlob` + `saveGlobToRegexBody`) maps `**`
// to `.*`. Because `.` matches `/`, the surrounding literal `/` chars
// in `alice/**/posts/1.md` CAN each be consumed by the adjacent literal
// — but only when at least one extra char exists. For the bare
// zero-segment case `alice/posts/1.md` the body `alice/.*\/posts/...`
// requires a literal `/` after the `.*`, which `.*` could match (it
// matches zero chars, then the literal `/` matches). Wait — actually
// `alice/.*\/posts/1\.md` against `alice/posts/1.md`: `alice/`
// consumes `alice/`, `.*` matches "" (empty), `\/` requires `/` but
// the next char is `p`. FAILS. So the regex path has the SAME bug.

Deno.test("compileSaveGlob - `**` mid-pattern matches zero segments between (regression)", () => {
  const re = compileSaveGlob("alice/**/posts/1.md");
  assertEquals(
    re.test("alice/posts/1.md"),
    true,
    `re=${re.source} must match zero-segment "alice/posts/1.md"`,
  );
  assertEquals(re.test("alice/X/posts/1.md"), true);
  assertEquals(re.test("alice/X/Y/posts/1.md"), true);
  assertEquals(re.test("bob/posts/1.md"), false);
});

Deno.test("compileSaveGlob - leading `**/` matches zero segments before (regression)", () => {
  const re = compileSaveGlob("**/posts/1.md");
  assertEquals(re.test("posts/1.md"), true, `re=${re.source}`);
  assertEquals(re.test("X/posts/1.md"), true);
  assertEquals(re.test("X/Y/posts/1.md"), true);
});

Deno.test("compileSaveGlob - trailing `/**` documents inside-subset behaviour (byte-equal to compilePattern)", () => {
  // Edge case: `alice/**` routes to the inside-subset path
  // (`isInsideCoreSubset` accepts trailing `**`). The §3.3.1 contract
  // says inside-subset patterns are byte-equal to compilePattern's
  // output, even when that means inheriting core's strictness on
  // zero-segment-after. Core's `compilePattern("alice/**")` emits
  // `^alice\/.*$` which does NOT match the bare `alice`. We preserve
  // that — fixing it would break the byte-equality contract that
  // routing-layer and save-layer matches agree.
  //
  // Callers that want zero-segment-after must use a save-local-route
  // pattern (e.g. `alice/**/x` for some downstream `x`, or simply
  // accept core's strict trailing semantics).
  const re = compileSaveGlob("alice/**");
  assertEquals(re.test("alice"), false, `re=${re.source}`);
  assertEquals(re.test("alice/foo"), true);
  assertEquals(re.test("alice/X/foo"), true);
});

Deno.test("compileSaveGlob - multiple mid-`**` zero-segment cases (regression)", () => {
  const re = compileSaveGlob("a/**/b/**/c");
  assertEquals(re.test("a/b/c"), true, `re=${re.source}`);
  assertEquals(re.test("a/X/b/c"), true);
  assertEquals(re.test("a/b/X/c"), true);
  assertEquals(re.test("a/X/b/Y/c"), true);
});

Deno.test("saveGlobToRegexBody - `**` zero-segment regression", () => {
  const body = saveGlobToRegexBody("alice/**/posts/1.md");
  const re = new RegExp("^" + body + "$");
  assertEquals(
    re.test("alice/posts/1.md"),
    true,
    `body="${body}" must match zero-segment "alice/posts/1.md"`,
  );
  assertEquals(re.test("alice/X/posts/1.md"), true);
});
