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
import type { ReadParams } from "./url.ts";

/**
 * Validate standard ReadParams and throw on anything we cannot honor.
 *
 * Push-down stores (postgres, mongo, ES, S3) call this first, then
 * translate the surviving params into their backend query language.
 * Stores that post-process in memory call `applyReadParams` instead,
 * which validates and applies in one go.
 *
 * Project-wide baseline: `pattern` and `cursor` are unsupported
 * everywhere; `sortBy` only accepts `"uri"`; `format` only accepts
 * `"full"` (default) or `"uris"`. Per-store relaxations should be
 * added explicitly as features land.
 */
export function validateReadParams(
  params: ReadParams,
  storeName: string,
): void {
  if (params.pattern !== undefined) {
    throw new Error(`${storeName}: pattern filter not supported`);
  }
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
 * when `format` is `"uris"`.
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
  return out;
}
