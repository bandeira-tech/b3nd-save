/**
 * Save url grammar tests — parse/build round-trip, structural fields,
 * defaults, error handling, and v2 listing-spec additions
 * (URI-embedded glob, ?fn= validation, dual-accept ?pattern=).
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  _resetPatternDeprecationLogForTests,
  buildUrl,
  parseUrl,
  splitLocatorGlob,
  uriOf,
} from "./url.ts";

// ── parseUrl: fn dispatch ──────────────────────────────────────────

Deno.test("parseUrl - bare uri without slash defaults to fn=read", () => {
  const p = parseUrl("mutable://open/users/alice");
  assertEquals(p.uri, "mutable://open/users/alice");
  assertEquals(p.fn, "read");
  assertEquals(p.params, {});
  assertEquals(p.ext, {});
  assertEquals(p.glob, "");
});

Deno.test("parseUrl - trailing slash defaults to fn=ls", () => {
  const p = parseUrl("mutable://open/users/");
  assertEquals(p.uri, "mutable://open/users/");
  assertEquals(p.fn, "ls");
  assertEquals(p.glob, "");
});

Deno.test("parseUrl - explicit fn overrides trailing-slash default", () => {
  const p = parseUrl("mutable://open/users/?fn=count");
  assertEquals(p.uri, "mutable://open/users/");
  assertEquals(p.fn, "count");
});

Deno.test("parseUrl - explicit fn=read on trailing-slash uri", () => {
  const p = parseUrl("mutable://open/users/?fn=read");
  assertEquals(p.fn, "read");
  assertEquals(p.uri, "mutable://open/users/");
});

Deno.test("parseUrl - x-* fn name passes through", () => {
  const p = parseUrl("m://x?fn=x-pg.scan");
  assertEquals(p.fn, "x-pg.scan");
});

// ── parseUrl: structural fields ────────────────────────────────────

Deno.test("parseUrl - exposes protocol/hostname/path/program", () => {
  const p = parseUrl("mutable://users/alice/posts/?fn=count");
  assertEquals(p.protocol, "mutable");
  assertEquals(p.hostname, "users");
  assertEquals(p.path, "/alice/posts/");
  assertEquals(p.program, "mutable://users");
  assertEquals(p.uri, "mutable://users/alice/posts/");
});

Deno.test("parseUrl - hostname-only uri has empty path", () => {
  const p = parseUrl("m://x");
  assertEquals(p.protocol, "m");
  assertEquals(p.hostname, "x");
  assertEquals(p.path, "");
  assertEquals(p.program, "m://x");
});

Deno.test("parseUrl - hostname + slash gives path=/", () => {
  const p = parseUrl("m://x/");
  assertEquals(p.hostname, "x");
  assertEquals(p.path, "/");
});

Deno.test("parseUrl - synthetic uri keeps embedded :// inside path", () => {
  const p = parseUrl("b3nd://count/mutable://users/");
  assertEquals(p.protocol, "b3nd");
  assertEquals(p.hostname, "count");
  assertEquals(p.path, "/mutable://users/");
  assertEquals(p.program, "b3nd://count");
  assertEquals(p.uri, "b3nd://count/mutable://users/");
});

Deno.test("parseUrl - no scheme yields empty protocol and path=uri", () => {
  const p = parseUrl("not-a-uri");
  assertEquals(p.protocol, "");
  assertEquals(p.hostname, "");
  assertEquals(p.path, "not-a-uri");
  assertEquals(p.program, "");
});

// ── parseUrl: params + ext ─────────────────────────────────────────

Deno.test("parseUrl - standard params coerced", () => {
  const p = parseUrl("m://x/?limit=20&page=3&format=uris&sortBy=timestamp");
  assertEquals(p.params.limit, 20);
  assertEquals(p.params.page, 3);
  assertEquals(p.params.format, "uris");
  assertEquals(p.params.sortBy, "timestamp");
});

Deno.test("parseUrl - x-* params land in ext", () => {
  const p = parseUrl(
    "m://x/?fn=ls&x-feed.rank=engagement&x-feed.cursor=abc123",
  );
  assertEquals(p.ext, {
    "x-feed.rank": "engagement",
    "x-feed.cursor": "abc123",
  });
  assertEquals(p.params, {});
});

Deno.test("parseUrl - invalid limit throws", () => {
  assertThrows(() => parseUrl("m://x/?limit=abc"), Error, "Invalid limit");
});

Deno.test("parseUrl - unknown standard param throws", () => {
  assertThrows(
    () => parseUrl("m://x/?wat=1"),
    Error,
    "Unknown read param: wat",
  );
});

// ── buildUrl ────────────────────────────────────────────────────────

Deno.test("buildUrl - bare uri returns uri", () => {
  assertEquals(buildUrl({ uri: "m://x" }), "m://x");
});

Deno.test("buildUrl - fn matching trailing-slash default omits fn=", () => {
  assertEquals(buildUrl({ uri: "m://x/", fn: "ls" }), "m://x/");
  assertEquals(buildUrl({ uri: "m://x", fn: "read" }), "m://x");
});

Deno.test("buildUrl - non-default fn included", () => {
  assertEquals(buildUrl({ uri: "m://x/", fn: "count" }), "m://x/?fn=count");
  assertEquals(buildUrl({ uri: "m://x", fn: "ls" }), "m://x?fn=ls");
});

Deno.test("buildUrl - omits undefined params", () => {
  assertEquals(
    buildUrl({ uri: "m://x/", fn: "ls", params: { limit: 10 } }),
    "m://x/?limit=10",
  );
});

Deno.test("buildUrl - non-x ext key throws", () => {
  assertThrows(
    () => buildUrl({ uri: "m://x", ext: { foo: "1" } }),
    Error,
    "ext keys must start with 'x-'",
  );
});

// ── round-trip ──────────────────────────────────────────────────────

Deno.test("round-trip - bare uri", () => {
  const url = "mutable://open/users/alice";
  assertEquals(buildUrl(parseUrl(url)), url);
});

Deno.test("round-trip - count over prefix", () => {
  const url = "mutable://open/users/?fn=count";
  assertEquals(buildUrl(parseUrl(url)), url);
});

Deno.test("round-trip - listUris with limit", () => {
  const url = "mutable://open/users/?format=uris&limit=12";
  assertEquals(buildUrl(parseUrl(url)), url);
});

Deno.test("round-trip - x-* fn with ext", () => {
  const url = "m://hashtags/coffee/?fn=x-feed.rank&x-feed.cursor=eyJ";
  assertEquals(buildUrl(parseUrl(url)), url);
});

// ── uriOf ───────────────────────────────────────────────────────────

Deno.test("uriOf - strips query", () => {
  assertEquals(
    uriOf("mutable://open/users/?fn=count&limit=5"),
    "mutable://open/users/",
  );
});

Deno.test("uriOf - preserves trailing slash", () => {
  assertEquals(uriOf("m://x/"), "m://x/");
  assertEquals(uriOf("m://x"), "m://x");
});

// ── fields ─────────────────────────────────────────────────────────

Deno.test("parseUrl - fields=a,b,c parses to a trimmed array", () => {
  const p = parseUrl("m://x?fields=name,age, blob ");
  assertEquals(p.params.fields, ["name", "age", "blob"]);
});

Deno.test("parseUrl - empty fields= yields []", () => {
  const p = parseUrl("m://x?fields=");
  assertEquals(p.params.fields, []);
});

Deno.test("buildUrl - serializes fields as comma-joined", () => {
  assertEquals(
    buildUrl({ uri: "m://x", params: { fields: ["name", "age"] } }),
    "m://x?fields=name%2Cage",
  );
});

Deno.test("round-trip - fields projection", () => {
  const p = parseUrl("m://x?fields=name,age");
  assertEquals(parseUrl(buildUrl(p)).params.fields, ["name", "age"]);
});

// ── splitLocatorGlob ────────────────────────────────────────────────

Deno.test("splitLocatorGlob - no wildcards returns whole uri", () => {
  assertEquals(splitLocatorGlob("x://a/b/c"), {
    prefix: "x://a/b/c",
    glob: "",
  });
});

Deno.test("splitLocatorGlob - trailing ** splits at the final /", () => {
  assertEquals(splitLocatorGlob("x://a/b/**"), {
    prefix: "x://a/b/",
    glob: "**",
  });
});

Deno.test("splitLocatorGlob - mid-** splits at the segment boundary", () => {
  assertEquals(splitLocatorGlob("x://a/**/x.md"), {
    prefix: "x://a/",
    glob: "**/x.md",
  });
});

Deno.test("splitLocatorGlob - single * splits at the segment boundary", () => {
  assertEquals(splitLocatorGlob("x://a/al*"), {
    prefix: "x://a/",
    glob: "al*",
  });
});

Deno.test("splitLocatorGlob - `?` is treated as path wildcard", () => {
  // `?` in the path (no query string — the caller already stripped it)
  // is a glob wildcard, not a query separator.
  assertEquals(splitLocatorGlob("x://a/al?"), {
    prefix: "x://a/",
    glob: "al?",
  });
});

Deno.test("splitLocatorGlob - wildcard at root", () => {
  assertEquals(splitLocatorGlob("x://a/**"), {
    prefix: "x://a/",
    glob: "**",
  });
});

Deno.test("splitLocatorGlob - schemeless input", () => {
  assertEquals(splitLocatorGlob("**"), { prefix: "", glob: "**" });
  assertEquals(splitLocatorGlob("foo/**"), { prefix: "foo/", glob: "**" });
});

Deno.test("splitLocatorGlob - empty input", () => {
  assertEquals(splitLocatorGlob(""), { prefix: "", glob: "" });
});

// ── v2: ?fn= validation when wildcards are present ─────────────────

Deno.test("parseUrl - URI with ** + ?fn=find populates prefix/glob/pattern", () => {
  const p = parseUrl("mutable://open/users/**?fn=find");
  assertEquals(p.uri, "mutable://open/users/");
  assertEquals(p.glob, "**");
  assertEquals(p.fn, "find");
  assertEquals(p.params.pattern, "**");
});

Deno.test("parseUrl - URI with * + ?fn=ls populates prefix/glob/pattern", () => {
  const p = parseUrl("mutable://open/users/al*?fn=ls");
  assertEquals(p.uri, "mutable://open/users/");
  assertEquals(p.glob, "al*");
  assertEquals(p.fn, "ls");
  assertEquals(p.params.pattern, "al*");
});

Deno.test("parseUrl - `?` wildcard via dual-accept ?pattern= (URI can't embed literal `?`)", () => {
  // The URL grammar makes the first `?` a query separator, so `?` as
  // a path wildcard can't be embedded in the URI portion. Callers that
  // want `?` use the dual-accept ?pattern= path (legacy) or URL-encode
  // it (%3F). The spec covers the URI-embedded case via the dual-
  // accept path during transition.
  _resetPatternDeprecationLogForTests();
  const p = parseUrl("mutable://open/users/?fn=ls&pattern=al?");
  assertEquals(p.uri, "mutable://open/users/");
  assertEquals(p.glob, "al?");
  assertEquals(p.fn, "ls");
});

Deno.test("parseUrl - mid-** ?fn=find", () => {
  const p = parseUrl("mutable://open/users/**/msg/*.md?fn=find");
  assertEquals(p.uri, "mutable://open/users/");
  assertEquals(p.glob, "**/msg/*.md");
  assertEquals(p.fn, "find");
});

Deno.test("parseUrl - URI under a sub-prefix with ** ?fn=find", () => {
  const p = parseUrl("mutable://open/users/alice/**?fn=find");
  assertEquals(p.uri, "mutable://open/users/alice/");
  assertEquals(p.glob, "**");
  assertEquals(p.fn, "find");
});

Deno.test("parseUrl - count accepts any URI shape (shallow)", () => {
  const p = parseUrl("mutable://open/users/?fn=count");
  assertEquals(p.fn, "count");
  assertEquals(p.glob, "");
});

Deno.test("parseUrl - count accepts ** for descendant count", () => {
  const p = parseUrl("mutable://open/users/**?fn=count");
  assertEquals(p.fn, "count");
  assertEquals(p.glob, "**");
  assertEquals(p.uri, "mutable://open/users/");
});

// ── v2: validation throws ──────────────────────────────────────────

Deno.test("parseUrl - wildcards without ?fn= throws (silent-default-trap mitigation)", () => {
  assertThrows(
    () => parseUrl("mutable://open/users/**"),
    Error,
    "?fn= is absent",
  );
  assertThrows(
    () => parseUrl("mutable://open/users/al*"),
    Error,
    "?fn= is absent",
  );
});

Deno.test("parseUrl - ?fn=ls rejects URLs containing **", () => {
  assertThrows(
    () => parseUrl("mutable://open/users/**?fn=ls"),
    Error,
    '?fn=ls rejects URLs containing "**"',
  );
});

Deno.test("parseUrl - ?fn=find requires ** somewhere", () => {
  assertThrows(
    () => parseUrl("mutable://open/users/al*?fn=find"),
    Error,
    '?fn=find requires "**"',
  );
});

Deno.test("parseUrl - ?fn=read with wildcards throws", () => {
  assertThrows(
    () => parseUrl("mutable://open/users/al*?fn=read"),
    Error,
    "?fn=read rejects URLs containing wildcards",
  );
});

// ── v2: dual-accept ?pattern= (deprecated transition path) ─────────

Deno.test("parseUrl - dual-accept ?pattern= populates glob + pattern", () => {
  _resetPatternDeprecationLogForTests();
  const p = parseUrl("mutable://open/users/?fn=find&pattern=**");
  // The URI has no wildcards in the path — it's the literal prefix.
  assertEquals(p.uri, "mutable://open/users/");
  assertEquals(p.glob, "**");
  assertEquals(p.params.pattern, "**");
  assertEquals(p.fn, "find");
});

Deno.test("parseUrl - dual-accept ?pattern=alice/** under a prefix", () => {
  _resetPatternDeprecationLogForTests();
  const p = parseUrl(
    "mutable://open/users/?fn=find&pattern=alice/**",
  );
  assertEquals(p.uri, "mutable://open/users/");
  assertEquals(p.glob, "alice/**");
  assertEquals(p.params.pattern, "alice/**");
  assertEquals(p.fn, "find");
});

Deno.test("parseUrl - mixing URI-embedded glob + ?pattern= throws", () => {
  _resetPatternDeprecationLogForTests();
  assertThrows(
    () => parseUrl("mutable://open/users/**?fn=find&pattern=alice/**"),
    Error,
    "cannot combine URI-embedded glob",
  );
});

Deno.test("parseUrl - deprecation log fires once per process", () => {
  // Reset the gate so we observe a fresh transition. Capture console.warn.
  _resetPatternDeprecationLogForTests();
  const originalWarn = console.warn;
  const warned: string[] = [];
  console.warn = (msg: string) => warned.push(msg);
  try {
    parseUrl("m://x/?fn=find&pattern=**");
    parseUrl("m://x/?fn=find&pattern=alice/**");
    parseUrl("m://x/?fn=ls&pattern=al*");
  } finally {
    console.warn = originalWarn;
  }
  assertEquals(warned.length, 1, `expected 1 warning, got ${warned.length}`);
  assertEquals(warned[0].includes("?pattern="), true);
  assertEquals(warned[0].includes("deprecated"), true);
});
