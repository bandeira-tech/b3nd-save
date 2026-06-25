/**
 * @module
 * Save-layer locator grammar — parsing and constructing the urls that
 * stores in this package implement.
 *
 * This is **save's contract with its callers**, not a framework-wide
 * standard. b3nd-core treats locators opaquely; it is each client's
 * choice what grammar it accepts. Stores shipped by `@bandeira-tech/b3nd-save`
 * (memory, postgres, mongo, sqlite, fs, ipfs, s3, elasticsearch,
 * localstorage, indexeddb) honor the grammar defined here.
 *
 * A **url** = a uri (the canonical resource identifier, possibly carrying
 * wildcards in its path) plus a query string of read parameters. The
 * literal portion of the uri (everything before the first wildcard) is
 * the routing identity used for storage keys and observe-match keys.
 * The query string carries request-time-only directives that shape the
 * response without changing identity.
 *
 * Grammar (v2 — see `.cc-chat/20260625121936-grammar-shape/output.md`):
 *
 *     <uri-with-glob>[?fn=<fn>][&<param>=<value>...][&x-<ns>.<key>=<value>...]
 *
 * Glob tokens in `<uri-with-glob>`'s path:
 * - `?`  exactly one non-`/` character
 * - `*`  zero or more non-`/` characters (one segment)
 * - `**` zero or more segments (any chars including `/`); **find-only**
 *
 * Reserved `fn` values:
 * - `read`   — point read (default for bare uris)
 * - `ls`     — list direct children (URI has `?`/`*` but no `**`)
 * - `find`   — recursive walk (URI contains `**`)
 * - `count`  — count of entries
 * - `x-*.*`  — provider-defined extension functions
 *
 * Validation rules (§3.4 — silent-default-trap mitigation):
 * - A URI with wildcards in its path MUST carry an explicit `?fn=`.
 * - `?fn=ls` rejects URIs containing `**`.
 * - `?fn=find` requires `**` (or a legacy `?pattern=` carrying `**`).
 * - `?fn=count` accepts any URI shape.
 * - A bare URI (no wildcards) keeps today's behavior — `?fn=` may be
 *   omitted; defaults to `read` (no trailing slash) or `ls` (trailing
 *   slash, equivalent to `<uri>*?fn=ls`).
 *
 * Dual-accept transition: `?pattern=<glob>` still parses (logged as
 * deprecated once per process). Internally normalized to the same
 * `{prefix, glob}` shape as the URI-embedded form. Removal scheduled
 * one minor version out.
 *
 * Standard params (meaningful only for some fns; stores ignore the rest):
 * `limit`, `page`, `cursor`, `sortBy`, `sortOrder`, `pattern`, `format`,
 * `fields`.
 *
 * Anything matching `x-<ns>.<key>` lands in the `ext` map and is passed
 * opaquely to the executing store. Callers inspect ext entries by
 * their flat string key (e.g. `ext["x-feed.cursor"]`).
 */

// ── Read params + parsed url shape ──────────────────────────────────

/**
 * Standard read parameters. All are optional; stores interpret the
 * subset that makes sense for the requested fn and throw on the rest.
 */
export interface ReadParams {
  limit?: number;
  page?: number;
  cursor?: string;
  sortBy?: string;
  sortOrder?: string;
  pattern?: string;
  format?: string;
  /**
   * Comma-separated list of field names to project from each returned
   * record. Applies to `fn=read` and `fn=ls&format=full`. Fields not
   * declared in the entity meta are silently absent from the
   * projection — the store does not error on unknown projection
   * fields, they simply do not appear. `format=uris` ignores `fields`
   * since it returns no record payloads.
   */
  fields?: string[];
}

/**
 * A parsed url decomposed into routing identity (`uri`), function
 * (`fn`), standard read parameters (`params`), and the `x-*` extension
 * bag (`ext`), plus the structural fields shared with WHATWG URL
 * (`protocol`, `hostname`, `path`, `program`), plus the v2 glob split
 * (`glob`).
 */
export interface ParsedUrl {
  /** Scheme without trailing `://` (e.g. `"mutable"`, `"b3nd"`). */
  protocol: string;
  /** Authority segment after `protocol://` (may be empty). */
  hostname: string;
  /** Everything after `protocol://<hostname>`. Empty or starts with `/`. */
  path: string;
  /** `protocol://hostname` — the routing root above the path. */
  program: string;
  /**
   * Routing identity. When the source url contains no wildcards in its
   * path, this is the full URI as written. When the source contains
   * wildcards, this is the **literal prefix** — everything before the
   * first wildcard segment, including the trailing `/`. Backends key
   * storage / observe matching off this value.
   */
  uri: string;
  /**
   * Glob tail extracted from the source URI's path (v2 §3.3). Empty
   * string when the source carried no wildcards in its path. When the
   * caller used the dual-accept `?pattern=` form, this carries that
   * value verbatim (back-compat normalization).
   */
  glob: string;
  /** Reserved fn (`read`/`ls`/`find`/`count`) or `x-<ns>.<name>` extension. */
  fn: string;
  /**
   * Standard read params. `params.pattern` is populated from either
   * the URI-embedded glob (preferred) or the legacy `?pattern=` query
   * param (deprecated) — both end up here so call sites that read
   * `params.pattern` keep working through the transition.
   */
  params: ReadParams;
  /** Bag of `x-*` extension query params (every key starts with `x-`). */
  ext: Record<string, string>;
}

/**
 * Split a uri's path into its literal prefix and its glob tail.
 *
 * Walks the path looking for the first segment that contains a glob
 * metacharacter (`*` or `?`). Returns the literal prefix (everything
 * up to and including the `/` before that segment) and the glob tail
 * (the wildcard segment and everything after it). When no wildcards
 * are present, returns the whole URI as `prefix` and `""` as `glob`.
 *
 * The walk is path-aware so `?` is treated as a wildcard inside path
 * segments only (the function never sees a query string — callers
 * strip `?<query>` first).
 *
 * Examples:
 *   "x://a/b/c"        → { prefix: "x://a/b/c",  glob: "" }
 *   "x://a/b/**"       → { prefix: "x://a/b/",   glob: "**" }
 *   "x://a/**\/x.md"   → { prefix: "x://a/",     glob: "**\/x.md" }
 *   "x://a/al*"        → { prefix: "x://a/",     glob: "al*" }
 *   "x://a/al?"        → { prefix: "x://a/",     glob: "al?" }
 *   "**"               → { prefix: "",           glob: "**" }
 *
 * Note: the input must already have `?<query>` stripped — the function
 * has no way to distinguish a literal `?` in the path from a query
 * separator. `parseUrl` handles the split before calling.
 */
export function splitLocatorGlob(
  uri: string,
): { prefix: string; glob: string } {
  // Find the scheme boundary; wildcards before the path are nonsense
  // but we don't reject them here — splitLocatorGlob is a pure
  // structural split. The caller (parseUrl) sees the result and the
  // grammar validator decides what's legal.
  const schemeIdx = uri.indexOf("://");
  let pathStart: number;
  if (schemeIdx < 0) {
    pathStart = 0;
  } else {
    const rest = uri.slice(schemeIdx + 3);
    const slash = rest.indexOf("/");
    pathStart = slash < 0 ? uri.length : schemeIdx + 3 + slash;
  }

  // Walk segment by segment from pathStart. A segment containing `*`
  // or `?` is the first wildcard segment; the split point is the `/`
  // that begins that segment.
  let segStart = pathStart;
  const len = uri.length;
  for (let i = pathStart; i <= len; i++) {
    if (i === len || uri.charCodeAt(i) === 47 /* / */) {
      const seg = uri.slice(segStart, i);
      if (seg.includes("*") || seg.includes("?")) {
        // Prefix is everything up to (and including) the `/` before
        // this segment. segStart points at the first char of the
        // segment, so prefix = uri.slice(0, segStart). When the
        // wildcard segment is at the root (no preceding `/`),
        // segStart === pathStart and prefix is just the program.
        return {
          prefix: uri.slice(0, segStart),
          glob: uri.slice(segStart),
        };
      }
      segStart = i + 1;
    }
  }

  return { prefix: uri, glob: "" };
}

// ── Deprecation log gate ────────────────────────────────────────────

let _patternDeprecationLogged = false;
function logPatternDeprecationOnce(): void {
  if (_patternDeprecationLogged) return;
  _patternDeprecationLogged = true;
  console.warn(
    "b3nd-save: `?pattern=` query param is deprecated; use URI-embedded glob " +
      '(e.g. "<root>/**?fn=find"). Support will be removed one minor version out.',
  );
}

/** Test-only hook to reset the deprecation gate between tests. */
export function _resetPatternDeprecationLogForTests(): void {
  _patternDeprecationLogged = false;
}

// ── Parser ───────────────────────────────────────────────────────────

/**
 * Parse a url into its structural fields, function, params, and extensions.
 *
 * Splitting rule: first `://` separates protocol from the rest; the first
 * `/` in the rest separates hostname from path. Embedded `://` in the path
 * (e.g. `b3nd://count/mutable://users/`) stays inside `path` — no
 * special-casing.
 *
 * Glob extraction: the path is scanned for the first wildcard segment
 * (`splitLocatorGlob`). When wildcards are present, `parsed.uri` is the
 * literal prefix; `parsed.glob` is the wildcard tail; `parsed.params.pattern`
 * is set to the glob so downstream code can read either field. When the
 * caller used the legacy `?pattern=` form instead, the same fields are
 * populated and a deprecation is logged once per process.
 *
 * Verb defaults & validation (v2 §3.4):
 * - bare URI (no wildcards), no `?fn=` → defaults to `read` for non-
 *   trailing-slash, `ls` for trailing-slash (legacy convenience)
 * - any URI with wildcards in the path → `?fn=` is REQUIRED
 * - `**` in the URI is valid only under `?fn=find` (or `?fn=count`)
 * - `*`/`?` (no `**`) is valid under `?fn=ls` or `?fn=find` or `?fn=count`
 * - `?fn=count` accepts any URI shape
 *
 * Numeric params (`limit`, `page`) are coerced; throws on NaN. Unknown
 * standard params throw.
 */
export function parseUrl(url: string): ParsedUrl {
  const qIdx = url.indexOf("?");
  const uriRaw = qIdx < 0 ? url : url.slice(0, qIdx);
  const query = qIdx < 0 ? "" : url.slice(qIdx + 1);

  const schemeIdx = uriRaw.indexOf("://");
  let protocol = "";
  let hostname = "";
  let path = "";
  if (schemeIdx >= 0) {
    protocol = uriRaw.slice(0, schemeIdx);
    const rest = uriRaw.slice(schemeIdx + 3);
    const slash = rest.indexOf("/");
    if (slash < 0) {
      hostname = rest;
      path = "";
    } else {
      hostname = rest.slice(0, slash);
      path = rest.slice(slash);
    }
  } else {
    path = uriRaw;
  }
  const program = protocol ? `${protocol}://${hostname}` : "";

  // Split off any glob tail embedded in the path.
  const { prefix: uriPrefix, glob: uriGlob } = splitLocatorGlob(uriRaw);

  const sp = new URLSearchParams(query);
  const explicitFn = sp.get("fn") ?? undefined;

  const params: ReadParams = {};
  const ext: Record<string, string> = {};

  for (const [key, value] of sp.entries()) {
    if (key === "fn") continue;
    if (key.startsWith("x-")) {
      ext[key] = value;
      continue;
    }
    switch (key) {
      case "limit":
      case "page": {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          throw new Error(`Invalid ${key}: ${value}`);
        }
        params[key] = n;
        break;
      }
      case "cursor":
      case "sortBy":
      case "sortOrder":
      case "format":
        params[key] = value;
        break;
      case "pattern":
        params.pattern = value;
        break;
      case "fields":
        params.fields = value.split(",").map((f) => f.trim()).filter(Boolean);
        break;
      default:
        throw new Error(`Unknown read param: ${key}`);
    }
  }

  // Reconcile URI-embedded glob with legacy `?pattern=`.
  // Both populated → conflict → throw (caller has two intents in one URL).
  // Only `?pattern=` populated → dual-accept transition; log deprecation;
  //   leave `parsed.uri` as the literal uriRaw (it has no wildcards) and
  //   `parsed.glob` carries the pattern value (the routing identity is
  //   still the literal uri).
  // Only URI glob populated → preferred path; mirror into params.pattern
  //   so legacy push-down sites that read `params.pattern` keep working.
  let effectiveGlob = uriGlob;
  let effectiveUri = uriPrefix;
  if (uriGlob && params.pattern !== undefined) {
    throw new Error(
      `b3nd-save: cannot combine URI-embedded glob ("${uriGlob}") with ` +
        `?pattern= query param ("${params.pattern}") — pick one`,
    );
  }
  if (!uriGlob && params.pattern !== undefined) {
    logPatternDeprecationOnce();
    effectiveGlob = params.pattern;
    effectiveUri = uriRaw;
  }
  if (uriGlob && params.pattern === undefined) {
    params.pattern = uriGlob;
  }

  // Verb resolution. The default lookup uses the literal-uri shape
  // (trailing slash → ls else read) but is only honoured when there
  // are no wildcards anywhere.
  const hasWildcards = effectiveGlob.length > 0;
  let fn: string;
  if (explicitFn !== undefined) {
    fn = explicitFn;
  } else if (hasWildcards) {
    throw new Error(
      `b3nd-save: URL contains wildcards but ?fn= is absent — declare ` +
        `the verb explicitly (e.g. ?fn=find for "**", ?fn=ls for "*"/"?")`,
    );
  } else {
    fn = uriRaw.endsWith("/") ? "ls" : "read";
  }

  // Verb/shape validation when wildcards are present (§3.4).
  if (hasWildcards) {
    const hasDoubleStar = effectiveGlob.includes("**");
    if (fn === "ls" && hasDoubleStar) {
      throw new Error(
        `b3nd-save: ?fn=ls rejects URLs containing "**" — use ?fn=find for ` +
          `recursive walks`,
      );
    }
    if (fn === "find" && !hasDoubleStar) {
      throw new Error(
        `b3nd-save: ?fn=find requires "**" in the URL (or in legacy ` +
          `?pattern=); got "${effectiveGlob}"`,
      );
    }
    // ?fn=count accepts both shapes per §3.2; x-* extensions are
    // provider-defined and pass through; ?fn=read with wildcards is
    // nonsense and we reject it explicitly so callers don't get a
    // confusing point-read attempt on a literal "**" key.
    if (fn === "read") {
      throw new Error(
        `b3nd-save: ?fn=read rejects URLs containing wildcards — use ?fn=ls ` +
          `or ?fn=find`,
      );
    }
  }

  return {
    protocol,
    hostname,
    path,
    program,
    uri: effectiveUri,
    glob: effectiveGlob,
    fn,
    params,
    ext,
  };
}

/**
 * Serialize a parsed url back to its string form. Authoritative input is
 * `uri`; structural fields (`protocol`/`hostname`/`path`/`program`) are
 * ignored on serialization since `uri` already contains them.
 *
 * Omits `fn=` when it matches the trailing-slash default. Throws if any
 * `ext` key does not start with `x-`.
 *
 * Note: `buildUrl` writes the URI verbatim — it does not splice a glob
 * back into the path. Callers that have a `ParsedUrl` produced by
 * `parseUrl` from a URI-embedded-glob source should reconstruct the
 * full url manually if they need to round-trip the original string; the
 * cheap path is `<originalUrl>` which they already have.
 */
export function buildUrl(parsed: {
  uri: string;
  fn?: string;
  params?: ReadParams;
  ext?: Record<string, string>;
}): string {
  const { uri, fn, params, ext } = parsed;
  const sp = new URLSearchParams();

  const defaultFn = uri.endsWith("/") ? "ls" : "read";
  if (fn && fn !== defaultFn) sp.set("fn", fn);

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      sp.set(k, String(v));
    }
  }
  if (ext) {
    for (const [k, v] of Object.entries(ext)) {
      if (!k.startsWith("x-")) {
        throw new Error(`ext keys must start with 'x-': ${k}`);
      }
      sp.set(k, v);
    }
  }

  const qs = sp.toString();
  return qs ? `${uri}?${qs}` : uri;
}

/**
 * Canonical-uri portion of a save url. The query string is
 * request-time-only and never participates in routing or storage
 * keying. Cheap helper for stores and callers that need the bare uri
 * without paying for full parse.
 *
 * Note: this returns the URI as written, **including** any embedded
 * glob (`<uri-with-glob>`). For just the literal routing prefix, parse
 * the url and read `parsed.uri`.
 */
export function uriOf(url: string): string {
  const qIdx = url.indexOf("?");
  return qIdx < 0 ? url : url.slice(0, qIdx);
}
