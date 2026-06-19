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
 * Project-wide baseline: `cursor` is unsupported everywhere;
 * `sortBy` only accepts `"uri"`; `format` only accepts `"full"`
 * (default) or `"uris"`; `pattern` is supported as a glob over the
 * URI tail (post-filtered in `dispatchRead` for `fn=ls` and `fn=count`).
 * Per-store relaxations should be added explicitly as features land.
 */
export function validateReadParams(
  params: ReadParams,
  storeName: string,
): void {
  if (params.cursor !== undefined) {
    throw new Error(`${storeName}: cursor not supported`);
  }
  if (params.sortBy !== undefined && params.sortBy !== "uri") {
    throw new Error(`${storeName}: unsupported sortBy: ${params.sortBy}`);
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
  if (params.sortBy === "uri") {
    const dir = params.sortOrder === "desc" ? -1 : 1;
    out = [...out].sort(([a], [b]) => a.localeCompare(b) * dir);
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
  let out = "^";
  for (const ch of pattern) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  out += "$";
  return new RegExp(out);
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
