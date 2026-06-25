/**
 * In-process post-processing for `fn=ls`/`fn=find` results.
 *
 * Stores that cannot push `sortBy`/`limit`/`page`/`format` down to
 * their backend collect the raw `Output[]` rows under a prefix and
 * pipe them through `applyReadParams`. Stores that CAN push these
 * down (postgres, mongo, elasticsearch, s3) should skip this helper
 * and handle the params in their query.
 *
 * Throws on unsupported params — programmer errors are not silent
 * "misses." See project decisions in `project_core_upgrade.md`.
 *
 * Glob compilation lives in `./glob.ts` — see `compileSaveGlob`,
 * `globToSqlLike`, and `matchesGlob` for the regex/SQL adapters. This
 * module no longer maintains its own glob grammar; the v2 listing
 * spec (`.cc-chat/20260625121936-grammar-shape/output.md`) collapses
 * read+observe onto one grammar — see §3.3.1 for the foundation-round
 * wrapper resolution.
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
 * - `sortBy` accepts `"uri"` (push-down everywhere), `"leaf"` (basename
 *   `localeCompare`), or any record field name (dispatch-layer post-sort,
 *   or backend push-down where advertised)
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
 *
 * `sortBy` values:
 *   - `"uri"` — `localeCompare` of the full URI
 *   - `"leaf"` — `localeCompare` of the basename
 *     (`uri.slice(uri.lastIndexOf("/") + 1)`)
 *   - any other string — treated as a record-field name; non-record
 *     payloads sort last (`undefined`)
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
    } else if (params.sortBy === "leaf") {
      out = [...out].sort(([a], [b]) =>
        leafOf(a).localeCompare(leafOf(b)) * dir
      );
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
 * Basename of a URI — everything after the last `/`. For URIs without a
 * `/` (rare in save context but possible for opaque protocols) returns
 * the whole string. Used by `sortBy=leaf` and exported for stores that
 * push that sort down to a backend that needs a precomputed leaf
 * column.
 */
export function leafOf(uri: string): string {
  const idx = uri.lastIndexOf("/");
  return idx < 0 ? uri : uri.slice(idx + 1);
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
