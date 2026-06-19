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
 * A **url** = a uri (the canonical resource identifier) plus a query
 * string of read parameters. The uri is the routing identity used for
 * storage keys and observe-match keys. The query string carries
 * request-time-only directives that shape the response without
 * changing identity.
 *
 * Grammar:
 *
 *     <uri>[?fn=<fn>][&<param>=<value>...][&x-<ns>.<key>=<value>...]
 *
 * Reserved `fn` values:
 * - `read`   — point read (default for non-trailing-slash uris)
 * - `ls`     — list under a prefix (default when uri ends with `/`)
 * - `count`  — count of entries under a prefix
 * - `x-*.*`  — provider-defined extension functions
 *
 * Standard params (meaningful only for some fns; stores ignore the rest):
 * `limit`, `page`, `cursor`, `sortBy`, `sortOrder`, `pattern`, `format`.
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
 * (`protocol`, `hostname`, `path`, `program`).
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
  /** Full routing identity: `program` + `path`. Query is stripped. */
  uri: string;
  /** Reserved fn (`read`/`ls`/`count`) or `x-<ns>.<name>` extension. */
  fn: string;
  /** Standard read params (numeric ones coerced). */
  params: ReadParams;
  /** Bag of `x-*` extension query params (every key starts with `x-`). */
  ext: Record<string, string>;
}

/**
 * Parse a url into its structural fields, function, params, and extensions.
 *
 * Splitting rule: first `://` separates protocol from the rest; the first
 * `/` in the rest separates hostname from path. Embedded `://` in the path
 * (e.g. `b3nd://count/mutable://users/`) stays inside `path` — no
 * special-casing.
 *
 * Defaults:
 * - `fn=read` for uris without a trailing slash
 * - `fn=ls` for uris with a trailing slash
 *
 * Numeric params (`limit`, `page`) are coerced; throws on NaN.
 */
export function parseUrl(url: string): ParsedUrl {
  const qIdx = url.indexOf("?");
  const uri = qIdx < 0 ? url : url.slice(0, qIdx);
  const query = qIdx < 0 ? "" : url.slice(qIdx + 1);

  const schemeIdx = uri.indexOf("://");
  let protocol = "";
  let hostname = "";
  let path = "";
  if (schemeIdx >= 0) {
    protocol = uri.slice(0, schemeIdx);
    const rest = uri.slice(schemeIdx + 3);
    const slash = rest.indexOf("/");
    if (slash < 0) {
      hostname = rest;
      path = "";
    } else {
      hostname = rest.slice(0, slash);
      path = rest.slice(slash);
    }
  } else {
    path = uri;
  }
  const program = protocol ? `${protocol}://${hostname}` : "";

  const sp = new URLSearchParams(query);
  const explicitFn = sp.get("fn") ?? undefined;
  const defaultFn = uri.endsWith("/") ? "ls" : "read";
  const fn = explicitFn ?? defaultFn;

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
      case "pattern":
      case "format":
        params[key] = value;
        break;
      case "fields":
        params.fields = value.split(",").map((f) => f.trim()).filter(Boolean);
        break;
      default:
        throw new Error(`Unknown read param: ${key}`);
    }
  }

  return { protocol, hostname, path, program, uri, fn, params, ext };
}

/**
 * Serialize a parsed url back to its string form. Authoritative input is
 * `uri`; structural fields (`protocol`/`hostname`/`path`/`program`) are
 * ignored on serialization since `uri` already contains them.
 *
 * Omits `fn=` when it matches the trailing-slash default. Throws if any
 * `ext` key does not start with `x-`.
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
 */
export function uriOf(url: string): string {
  const qIdx = url.indexOf("?");
  return qIdx < 0 ? url : url.slice(0, qIdx);
}
