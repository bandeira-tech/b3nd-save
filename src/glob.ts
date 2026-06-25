/**
 * @module
 * Save-side glob adapters — bridges the save URL grammar (§3.3 of the
 * v2 listing spec, see `.cc-chat/20260625121936-grammar-shape/output.md`)
 * onto `b3nd-core`'s `compilePattern` for everything compilePattern can
 * express, and onto save-local compilation for the broader cases
 * compilePattern doesn't cover.
 *
 * Why this exists (§3.3.1 amendment, foundation-round honest concern):
 *
 * The v2 spec promises one grammar across read + observe + routing —
 * `?`, `*`, and `**` with `**` allowed anywhere. `b3nd-core`'s
 * `compilePattern` implements a strict subset:
 *   - `?` is not recognized (treated as a literal `?`)
 *   - `*` matches a non-empty segment (`[^/]+`), not zero-or-more
 *   - `**` must be the final segment; mid-`**` throws
 *
 * The honest resolution keeps core unchanged (v2 §7.1 commitment is
 * load-bearing for route/observe semantics) and has save ship two thin
 * adapters that close the delta. For patterns inside compilePattern's
 * subset, we delegate 1:1 — same engine, same code path, byte-equal
 * regex output. For patterns outside the subset, we compile locally
 * with the broader §3.3 semantics.
 *
 * Adapter responsibilities:
 *   - {@link compileSaveGlob} — regex matcher used by in-process post-
 *     filter paths and by mongo/elasticsearch (which embed the regex
 *     body in their backend queries).
 *   - {@link globToSqlLike} — SQL LIKE adapter for sqlite/postgres
 *     push-down. SQL has different metacharacters than regex so this
 *     is a separate helper; same dispatch shape (defer to a
 *     compilePattern-style helper for the inside-subset case; do
 *     save-local string building for the broader grammar).
 *
 * Both adapters are stateless and small. No caching, no metrics, no
 * classes — when a pattern comes in they decide which path applies and
 * emit the artifact.
 */

// ── Subset detection ────────────────────────────────────────────────

/**
 * Test whether a pattern is inside `compilePattern`'s supported subset.
 *
 * Inside the subset:
 *   - no `?` character (compilePattern treats `?` as literal, save's
 *     §3.3 grammar treats it as a wildcard — they disagree on a key
 *     byte, so any `?` forces save-local compile)
 *   - every `*` segment matches a non-empty segment (compilePattern's
 *     `[^/]+`; save's `[^/]*` is broader — but they agree on every
 *     **non-empty** match, so the only delta is on the empty-segment
 *     case, which the spec says save allows. To stay strict, we route
 *     to save-local compile whenever the question matters.)
 *   - `**` appears only as the final segment (compilePattern throws on
 *     mid-`**`)
 *
 * The check is conservative: if any segment looks suspicious, route to
 * save-local compile. False-negatives (sending an inside-subset pattern
 * to the save-local path) are correctness-safe — the §3.3 grammar is a
 * superset and matches the same URIs. False-positives (sending an
 * outside-subset pattern to compilePattern) would throw, which is why
 * we keep this conservative.
 */
function isInsideCoreSubset(pattern: string): boolean {
  if (pattern.includes("?")) return false;
  const segs = pattern.split("/");
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    // `**` must be the last segment for core's compilePattern.
    if (seg === "**" && i !== segs.length - 1) return false;
    // A mid-segment containing `**` (e.g. `a**b`) is rejected by core's
    // classifySegment too — keep on the save-local path.
    if (seg !== "**" && seg.includes("**")) return false;
    // `*` mixed with other chars in a segment (e.g. `a*b`) is rejected
    // by core; save-local handles it.
    if (seg !== "*" && seg !== "**" && seg.includes("*")) return false;
  }
  return true;
}

// ── compileSaveGlob ─────────────────────────────────────────────────

/**
 * Compile a save glob pattern into an anchored RegExp that matches a
 * URI tail (the portion after the literal routing prefix). Anchored on
 * both ends so the pattern must cover the full tail.
 *
 * For patterns inside `compilePattern`'s supported subset, this builds
 * the same regex `compilePattern`'s `toRegex` builds — byte-equal — so
 * routing-layer matches and save-layer matches agree. For patterns
 * outside the subset (containing `?`, mid-`**`, or expecting empty-
 * segment match), this builds a save-local regex with the v2 §3.3
 * semantics:
 *   - `?`  → `[^/]`
 *   - `*`  → `[^/]*` (zero or more, contrast with core's `[^/]+`)
 *   - `**` → `.*` (any chars including `/`; valid anywhere)
 *
 * Returns a fresh RegExp on every call — callers that hot-loop should
 * cache it themselves (per-call overhead is one parse + one analyze).
 *
 * Note: this helper is for matching URI tails (with the literal prefix
 * already stripped). Callers that want to match a full URI should
 * either prepend an escaped prefix to the pattern or call
 * `compilePattern` directly with the literal+glob combined.
 */
export function compileSaveGlob(pattern: string): RegExp {
  if (isInsideCoreSubset(pattern)) {
    // For the inside-subset case we want a RegExp (not a closure) so
    // existing call sites (e.g. memory's `re.test(uri.slice(...))`,
    // mongo's regex body composition) keep working. Build the exact
    // regex compilePattern would build internally by tokenising on `/`
    // and swapping `*`/`**` segments. This is the same recipe core
    // uses in `toRegex` (b3nd-core/src/match-pattern/match-pattern.ts).
    //
    // We do NOT call `compilePattern(pattern)` to get a closure —
    // callers need the RegExp for either anchoring control (the
    // anchors core adds wrap the full URI; we want to match a tail)
    // or for regex-body extraction. Sourcing the regex shape from
    // core's `compilePattern` is the spec's design goal; the tests
    // assert byte-equality between this path and `compilePattern`'s
    // output for inside-subset patterns.
    return buildCoreSubsetRegex(pattern);
  }
  return buildSaveLocalRegex(pattern);
}

/**
 * Build the exact regex `compilePattern` builds for inside-subset
 * patterns. The recipe (from b3nd-core's `toRegex`):
 *   - tokenize on `/`
 *   - replace `*` segments with `[^/]+` placeholders
 *   - replace `**` (trailing only) with `.*` placeholder
 *   - escape regex metacharacters in the rest
 *   - re-insert placeholders, anchored
 *
 * The byte-equality test in `glob.test.ts` exercises this for a
 * battery of inside-subset patterns.
 */
function buildCoreSubsetRegex(pattern: string): RegExp {
  const ONE = "\x00ONE\x00";
  const REST = "\x00REST\x00";

  const swapped = pattern
    .split("/")
    .map((seg) => seg === "*" ? ONE : seg === "**" ? REST : seg)
    .join("/");

  const escaped = swapped.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

  const body = escaped
    .replaceAll(ONE, "[^/]+")
    .replaceAll(REST, ".*");

  return new RegExp(`^${body}$`);
}

// Build the save-local regex for patterns outside core's subset. The
// §3.3 grammar:
//   - `?`  -> `[^/]`     (exactly one non-`/`)
//   - `*`  -> `[^/]*`    (zero or more non-`/`)
//   - `*``*` -> `.*`     (zero or more SEGMENTS including the `/`)
//
// Multi-char metas (`*``*`) are recognised before single-char (`*`) by
// a tokenising scan so we never emit `[^/]*[^/]*` for `*``*`.
//
// Zero-segment fix (PR #86 concern #2): the spec promises `*``*`
// matches "zero or more segments". A naive `*``*` -> `.*` mapping
// leaves the surrounding literal `/` chars in place, so
// `alice/`+`*``*`+`/posts/1.md` compiles to `alice\/.*\/posts\/1\.md`
// which CANNOT match `alice/posts/1.md` (the literal `/` after `.*`
// blocks the zero-segment case). The fix: when `*``*` is bordered by
// `/`, eat one adjacent `/` so the resulting `.*` subsumes the
// boundary slash too. Cases (slash-eat rule = prefer trailing `/`,
// fall back to leading `/` if at end of pattern):
//   - `*``*` alone                -> `.*`
//   - `*``*` at start, then `/`   -> `.*`  (eat trailing `/`)
//   - `/` then `*``*` at end      -> `.*`  (eat leading `/`)
//   - `/` then `*``*` then `/`    -> `\/.*` (eat trailing `/`, keep
//                                    leading `/`; `.*` can match ""
//                                    so the zero-segment case
//                                    `alice/posts` works because the
//                                    literal `alice/` consumes the
//                                    slash and `.*` matches "")
function buildSaveLocalRegex(pattern: string): RegExp {
  return new RegExp(`^${buildSaveLocalRegexBody(pattern)}$`);
}

// ── saveGlobToRegexBody (mongo / elasticsearch push-down) ──────────

/**
 * Compile a save glob pattern into a regex **body** — no anchors. Pair
 * with custom anchoring at the call site:
 *   - mongo: `{ $regex: "^" + escape(prefix) + body + "$" }`
 *   - elasticsearch: the `regexp` query is auto-anchored
 *
 * Tokens map the same way as `compileSaveGlob`:
 *   - `?`  → `[^/]`
 *   - `*`  → `[^/]*`
 *   - `**` → `.*`
 *
 * For the inside-subset case, the body matches what `compilePattern`'s
 * `toRegex` emits (modulo the leading `^` / trailing `$` anchors core
 * adds). The `glob.test.ts` byte-equality test exercises that
 * correspondence by stripping the anchors from `compileSaveGlob` and
 * comparing against `saveGlobToRegexBody`.
 */
export function saveGlobToRegexBody(pattern: string): string {
  if (isInsideCoreSubset(pattern)) {
    return buildCoreSubsetRegexBody(pattern);
  }
  return buildSaveLocalRegexBody(pattern);
}

function buildCoreSubsetRegexBody(pattern: string): string {
  const ONE = "\x00ONE\x00";
  const REST = "\x00REST\x00";

  const swapped = pattern
    .split("/")
    .map((seg) => seg === "*" ? ONE : seg === "**" ? REST : seg)
    .join("/");

  const escaped = swapped.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

  return escaped
    .replaceAll(ONE, "[^/]+")
    .replaceAll(REST, ".*");
}

function buildSaveLocalRegexBody(pattern: string): string {
  let body = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      // `**` zero-segment fix (PR #86 concern #2): when bordered by
      // `/`, eat the *trailing* `/` so the emitted `.*` can subsume
      // the boundary slash too. Mid-pattern case:
      //   pattern  `alice/**/posts`
      //   naive    `alice\/.*\/posts` — fails to match `alice/posts`
      //   fixed    `alice\/.*posts`   — matches `alice/posts` (.* = "")
      //                                and `alice/X/posts` (.* = "X/")
      //
      // Leading `**/` case: `**/posts` → `.*posts` matches `posts`.
      // Trailing `/**` without a following slash also needs handling,
      // but in that case there's no trailing `/` to eat — we instead
      // eat the *leading* `/` already emitted into `body`. This case
      // typically routes to the inside-subset path; we handle it here
      // for save-local patterns that escape via mid-`**` AND end with
      // `/**` (e.g. `a/**/b/**`).
      body += ".*";
      i++; // consume second `*`
      if (pattern[i + 1] === "/") {
        i++; // eat trailing `/`
      } else if (i === pattern.length - 1 && body.endsWith("\\/.*")) {
        // `/**` at the very end of pattern. Strip the literal `\/`
        // immediately before the `.*` we just appended.
        body = body.slice(0, -4) + ".*";
      }
    } else if (ch === "*") {
      body += "[^/]*";
    } else if (ch === "?") {
      body += "[^/]";
    } else {
      body += ch.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
    }
  }
  return body;
}

// ── globToSqlLike ───────────────────────────────────────────────────

/**
 * Translate a save glob pattern into a SQL `LIKE` body. Pair with
 * `ESCAPE '\\'` in the surrounding query. Metacharacters:
 *   - `*`  → `%`   (zero or more chars)
 *   - `**` → `%`   (no SQL-LIKE distinction — both collapse to `%`;
 *                  the depth constraint, if any, is layered separately
 *                  by the caller via `NOT LIKE %/%`)
 *   - `?`  → `_`   (exactly one char)
 *   - literal `%`, `_`, `\\` are escaped to `\\%`, `\\_`, `\\\\`
 *
 * Returns just the pattern body. Composition with the literal prefix
 * (`uri LIKE ? || ? ESCAPE '\\'` with args `[prefixLike, patternBody]`)
 * is the caller's job — the caller already has the prefix as a bind
 * arg.
 *
 * Note that `**` and `*` both map to `%` because SQL LIKE has no
 * single-segment vs multi-segment notion. Callers that need to enforce
 * shallow-only semantics (the historical `NOT LIKE prefix || '%/%'`
 * sqlite/postgres trick) layer that constraint on top of the LIKE body
 * themselves. Find-style (recursive) handlers drop the trick when the
 * caller's fn is `find`.
 */
export function globToSqlLike(pattern: string): string {
  // SQL LIKE doesn't have the regex-grammar subtleties compilePattern
  // wraps, so the inside-subset / outside-subset split has no effect
  // on output. We keep the split anyway for symmetry with
  // compileSaveGlob — the call site reads cleanly and future SQL
  // dialects that grow segment-aware operators could specialise.
  if (isInsideCoreSubset(pattern)) {
    return buildSqlLikeBody(pattern);
  }
  return buildSqlLikeBody(pattern);
}

function buildSqlLikeBody(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      // `**` zero-segment fix (PR #86 concern #2): when bordered by
      // `/`, eat the *trailing* `/` so the emitted `%` subsumes the
      // boundary slash too. Mid-pattern:
      //   pattern  `alice/**/posts/1.md`
      //   naive    `alice/%/posts/1.md` — fails on `alice/posts/1.md`
      //   fixed    `alice/%posts/1.md`  — matches `alice/posts/1.md`
      //                                 and `alice/X/posts/1.md`
      //
      // Leading `**/` case: `**/posts` → `%posts` matches `posts`.
      // Trailing `/**` without a following slash: eat the leading `/`
      // we already emitted into `out`.
      out += "%";
      i++; // consume second `*`
      if (pattern[i + 1] === "/") {
        i++; // eat trailing `/`
      } else if (i === pattern.length - 1 && out.endsWith("/%")) {
        // `/**` at the very end of pattern. Strip the literal `/`
        // immediately before the `%` we just appended.
        out = out.slice(0, -2) + "%";
      }
    } else if (ch === "*") {
      out += "%";
    } else if (ch === "?") {
      out += "_";
    } else if (ch === "\\" || ch === "%" || ch === "_") {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

// ── Convenience: match a URI tail under a literal prefix ────────────

/**
 * True when `uri` starts with `prefix` and the tail matches `pattern`.
 * `pattern === undefined` returns true (no filter). Replacement for the
 * deleted `matchesUriPattern` helper from `read.ts`.
 *
 * The pattern is compiled fresh on every call. Callers that hot-loop
 * over a large row set should hoist `compileSaveGlob(pattern)` out and
 * test the RegExp directly.
 */
export function matchesGlob(
  uri: string,
  prefix: string,
  pattern: string | undefined,
): boolean {
  if (pattern === undefined) return true;
  if (!uri.startsWith(prefix)) return false;
  return compileSaveGlob(pattern).test(uri.slice(prefix.length));
}
