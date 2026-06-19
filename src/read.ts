/**
 * In-process post-processing for `fn=ls` results.
 *
 * Stores that cannot push `sortBy`/`limit`/`page`/`format` down to
 * their backend collect the raw `Output[]` rows under a prefix and
 * pipe them through `applyReadParams`. Stores that CAN push these
 * down (postgres, mongo, elasticsearch, s3) should skip this helper
 * and handle the params in their query.
 *
 * Throws on unsupported params — programmer errors are not silent
 * "misses." See project decisions in `project_core_upgrade.md`.
 */

import type { Output } from "@bandeira-tech/b3nd-core/types";
import type { EntityRecord } from "./entity.ts";
import type { ReadParams } from "./url.ts";

/**
 * Validate standard ReadParams and throw on anything we cannot honor.
 *
 * Push-down stores (postgres, mongo, ES, S3) call this first, then
 * translate the surviving params into their backend query language.
 * Stores that post-process in memory call `applyReadParams` instead,
 * which validates and applies in one go.
 *
 * Project-wide baseline:
 * - `sortBy` accepts `"uri"` (push-down everywhere) or any record
 *   field name (dispatch-layer post-sort, or backend push-down where
 *   advertised)
 * - `format` only accepts `"full"` (default) or `"uris"`
 * - `pattern` is supported as a glob over the URI tail
 * - `cursor` is supported as a stateless continuation token (the URI
 *   of the last entry from a previous page); combining with `page` is
 *   a programmer error since the two are alternative pagination modes
 *
 * Per-store relaxations should be added explicitly as features land.
 */
export function validateReadParams(
  params: ReadParams,
  storeName: string,
): void {
  if (params.cursor !== undefined && params.page !== undefined) {
    throw new Error(
      `${storeName}: cursor and page cannot be combined — pick one pagination mode`,
    );
  }
  const format = params.format ?? "full";
  if (format !== "full" && format !== "uris") {
    throw new Error(`${storeName}: unsupported format: ${format}`);
  }
}

/**
 * Apply standard ReadParams to a list of rows.
 *
 * @param rows   raw `[uri, payload]` entries collected from the backend
 * @param params parsed read params (from `parseUrl(...).params`)
 * @param storeName label used in thrown error messages
 *
 * Returns `Output[]` when `format` is `"full"` (default) or `string[]`
 * when `format` is `"uris"`. When `params.fields` is set and `format`
 * is `"full"`, each row's payload is projected via `projectRecord` —
 * unknown projection field names are silently absent.
 */
export function applyReadParams<T>(
  rows: Output<T>[],
  params: ReadParams,
  storeName: string,
): Output<T>[] | string[] {
  validateReadParams(params, storeName);
  const format = params.format ?? "full";

  let out = rows;
  if (params.sortBy !== undefined) {
    const dir = params.sortOrder === "desc" ? -1 : 1;
    if (params.sortBy === "uri") {
      out = [...out].sort(([a], [b]) => a.localeCompare(b) * dir);
    } else {
      const field = params.sortBy;
      out = [...out].sort(([, a], [, b]) => {
        const av = recordField(a, field);
        const bv = recordField(b, field);
        return compareSortable(av, bv) * dir;
      });
    }
  }

  if (params.cursor !== undefined) {
    const cursor = params.cursor;
    const desc = params.sortOrder === "desc";
    out = out.filter(([uri]) =>
      desc ? uri.localeCompare(cursor) < 0 : uri.localeCompare(cursor) > 0
    );
  }

  if (params.limit !== undefined) {
    const page = params.page ?? 1;
    const start = (page - 1) * params.limit;
    out = out.slice(start, start + params.limit);
  }

  if (format === "uris") return out.map(([uri]) => uri);
  if (params.fields && params.fields.length > 0) {
    const allow = params.fields;
    return out.map(([uri, payload]): Output<T> => [
      uri,
      projectRecord(payload, allow) as T,
    ]);
  }
  return out;
}

/**
 * Read a named field from a payload, returning `undefined` for any
 * non-record payload (eg `Uint8Array`, `ReadableStream`, miss). Used
 * by the in-memory sort path so non-uri sortBy works against
 * `EntityRecord` rows.
 */
function recordField(value: unknown, field: string): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") return undefined;
  if (value instanceof Uint8Array) return undefined;
  if (value instanceof ReadableStream) return undefined;
  return (value as Record<string, unknown>)[field];
}

/**
 * Stable, type-aware comparator: nulls/undefineds sort last; numbers
 * and bigints compare numerically; dates compare by `valueOf()`; the
 * rest falls back to string-coerced `localeCompare` so the comparator
 * never throws on heterogeneous field values.
 */
export function compareSortable(a: unknown, b: unknown): number {
  const aMissing = a === undefined || a === null;
  const bMissing = b === undefined || b === null;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "bigint" && typeof b === "bigint") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (a instanceof Date && b instanceof Date) {
    return a.valueOf() - b.valueOf();
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return (a ? 1 : 0) - (b ? 1 : 0);
  }
  return String(a).localeCompare(String(b));
}

/**
 * Translate a glob pattern into an anchored RegExp matching the URI
 * tail after a prefix. Supported wildcards: `*` matches any run of
 * non-`/` characters; `?` matches a single non-`/` character. All
 * other regex metacharacters are escaped. The result is anchored on
 * both ends so the pattern must match the full tail (no implicit
 * substring search).
 *
 * Example: pattern `"al*"` over tail `"alice"` matches; `"a?ice"`
 * matches; `"bob"` does not. To match a substring, use `*alice*`.
 */
export function patternToRegex(pattern: string): RegExp {
  return new RegExp("^" + patternToRegexBody(pattern) + "$");
}

/**
 * Translate a glob pattern into a RegExp body (no anchors). Use this
 * when composing the pattern into a larger query — Mongo's `$regex`
 * filter combines `^<prefix>` + body + `$`, Elasticsearch's Lucene
 * `regexp` query is auto-anchored on full match, etc.
 *
 * Wildcards: `*` → `[^/]*`, `?` → `[^/]`. All other regex
 * metacharacters are escaped, so the body matches the pattern as a
 * literal segment (no `/` permitted by the wildcards).
 */
export function patternToRegexBody(pattern: string): string {
  let out = "";
  for (const ch of pattern) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/**
 * Test whether a URI's tail under `prefixUri` matches the glob
 * pattern. Returns true when no pattern is set so callers can use
 * it as a single filter step.
 */
export function matchesUriPattern(
  uri: string,
  prefixUri: string,
  pattern: string | undefined,
): boolean {
  if (pattern === undefined) return true;
  return patternToRegex(pattern).test(uri.slice(prefixUri.length));
}

/**
 * Translate the URL-grammar glob pattern into a SQL `LIKE` body for
 * use with `ESCAPE '\\'`. `*` becomes `%`, `?` becomes `_`; any literal
 * `%`, `_`, or `\` in the source pattern is escaped so it matches as a
 * literal character.
 *
 * Callers compose this into the `LIKE` clause like:
 * `uri LIKE ? || ? ESCAPE '\\'` with args `[prefix, patternBody]`. The
 * package convention is to also require `uri NOT LIKE ? || '%/%'`
 * (with `[prefix]`) so the result stays inside the shallow-direct-
 * leaves contract — a pattern that would cross a `/` (via the `?` or
 * `*` wildcards, both of which are `/`-stopping in our grammar) still
 * cannot leak deeper rows than the same query without `pattern`.
 *
 * Returns just the pattern body — `prefix || body` is the caller's
 * job since the prefix is already a bind arg in the existing
 * `LIKE ? || '%'` clause.
 */
export function patternToSqlLike(pattern: string): string {
  let out = "";
  for (const ch of pattern) {
    if (ch === "*") out += "%";
    else if (ch === "?") out += "_";
    else if (ch === "\\" || ch === "%" || ch === "_") out += "\\" + ch;
    else out += ch;
  }
  return out;
}

/**
 * Project an `EntityRecord` down to the named fields. Unknown field
 * names are silently absent — projection is a presentation directive,
 * not a validation. Non-record values (eg `undefined` from a read
 * miss, or a raw `Uint8Array` from a BYTES_ENTITY) pass through
 * unchanged so callers can still detect misses and the BYTES path
 * keeps its current shape.
 */
export function projectRecord<T>(value: T, fields: readonly string[]): T {
  if (value === undefined || value === null) return value;
  if (typeof value !== "object") return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ReadableStream) return value;
  if (Array.isArray(value)) return value;
  const out: EntityRecord = {};
  const src = value as unknown as EntityRecord;
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(src, f)) out[f] = src[f];
  }
  return out as unknown as T;
}
