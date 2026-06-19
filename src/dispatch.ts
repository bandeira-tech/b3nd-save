/**
 * URL dispatch helper for Store.read implementations.
 *
 * Every store parses the input url, switches on `fn`, and calls back
 * into store-supplied handlers. Centralising the dispatch keeps the
 * `read`/`ls`/`count`/`x-*` switch identical across stores so they
 * cannot drift apart.
 *
 * Stores call `dispatchRead(urls, handlers)`; the helper handles
 * parsing, the fn switch, and tuple assembly. Each handler receives
 * the parsed url and returns the payload — the helper wraps it into
 * `[inputUrl, payload]`.
 */

import type { Output } from "@bandeira-tech/b3nd-core/types";
import { matchesUriPattern, projectRecord } from "./read.ts";
import type { ParsedUrl, ReadParams } from "./url.ts";
import { parseUrl } from "./url.ts";

export interface ReadHandlers {
  /** Point read. Return `undefined` for a miss. */
  read: (parsed: ParsedUrl) => unknown | Promise<unknown>;
  /**
   * List entries under a prefix. Return `Output[]` for `format=full`
   * (default) or `string[]` for `format=uris`. Handler is responsible
   * for honoring `params.format` itself — typically by calling
   * `applyReadParams` from `./read.ts`.
   */
  ls: (parsed: ParsedUrl) => unknown | Promise<unknown>;
  /** Count entries under a prefix. Return a number. */
  count: (parsed: ParsedUrl) => number | Promise<number>;
  /**
   * Optional handler for provider-defined `x-*.*` extension fns.
   * If absent, unknown fns throw.
   */
  ext?: (parsed: ParsedUrl) => unknown | Promise<unknown>;
  /**
   * Opt-in: this handler honours `pattern` in its own ls/count
   * queries (push-down). When true, dispatch passes `pattern`
   * through unchanged and skips the post-filter — the backend is
   * trusted to combine `pattern` with `limit`/`page`/`sortBy=uri`
   * correctly inside its query. `count` with a pattern also routes
   * to the backend's own `count` handler (push-down COUNT).
   *
   * When false (default), dispatch strips `pattern` + pagination from
   * the handler call and applies them locally on the returned rows
   * (correct but unable to leverage backend indices).
   */
  pushDownPattern?: boolean;
}

/**
 * Filter a sorted row list to entries strictly past the cursor.
 * `cursor` is a URI from a previous page; with `sortOrder=asc` (default)
 * we drop rows up to and including the cursor, with `desc` we drop rows
 * at or after it. Comparison is the same `localeCompare` used by the
 * default URI sort, so cursor pagination tracks the sort direction.
 */
function filterByCursor<T>(
  rows: Output<T>[],
  cursor: string,
  sortOrder: string | undefined,
): Output<T>[] {
  const desc = sortOrder === "desc";
  return rows.filter(([uri]) =>
    desc ? uri.localeCompare(cursor) < 0 : uri.localeCompare(cursor) > 0
  );
}

/** Same as `filterByCursor` but for `format=uris` payloads. */
function filterUrisByCursor(
  uris: string[],
  cursor: string,
  sortOrder: string | undefined,
): string[] {
  const desc = sortOrder === "desc";
  return uris.filter((uri) =>
    desc ? uri.localeCompare(cursor) < 0 : uri.localeCompare(cursor) > 0
  );
}

export async function dispatchRead<T = unknown>(
  urls: string[],
  storeName: string,
  handlers: ReadHandlers,
): Promise<Output<T>[]> {
  const out: Output<T>[] = [];
  for (const url of urls) {
    const parsed = parseUrl(url);
    // Validate the combos dispatch itself enforces before stripping
    // anything from the handler call, otherwise validateReadParams
    // inside the handler never sees the original shape.
    if (
      parsed.params.cursor !== undefined && parsed.params.page !== undefined
    ) {
      throw new Error(
        `${storeName}: cursor and page cannot be combined — pick one pagination mode`,
      );
    }
    let payload: unknown;
    const fields = parsed.params.fields;
    const pattern = parsed.params.pattern;
    const cursor = parsed.params.cursor;
    const needsPatternPostFilter = pattern !== undefined &&
      !handlers.pushDownPattern;
    const needsCursorPostFilter = cursor !== undefined;

    switch (parsed.fn) {
      case "read":
        payload = await handlers.read(parsed);
        if (fields && fields.length > 0) {
          payload = projectRecord(payload, fields);
        }
        break;
      case "ls": {
        const format = parsed.params.format ?? "full";

        if (needsPatternPostFilter || needsCursorPostFilter) {
          // Dispatch handles pattern/cursor + pagination + projection
          // itself, so it asks the backend for the full sorted result
          // first. Stripping `limit`/`page` is necessary so the
          // backend doesn't truncate the set before the filters run;
          // stripping `pattern`/`cursor` is necessary so backends that
          // don't recognise them don't error out.
          const handlerParams: ReadParams = { ...parsed.params };
          delete handlerParams.limit;
          delete handlerParams.page;
          delete handlerParams.fields;
          delete handlerParams.cursor;
          if (needsPatternPostFilter) delete handlerParams.pattern;
          const raw = await handlers.ls({
            ...parsed,
            params: handlerParams,
          });
          if (!Array.isArray(raw)) {
            payload = raw;
            break;
          }
          let arr: unknown[] = raw as unknown[];

          if (needsPatternPostFilter) {
            arr = format === "uris"
              ? (arr as string[]).filter((uri) =>
                matchesUriPattern(uri, parsed.uri, pattern)
              )
              : (arr as Array<Output>).filter(([uri]) =>
                matchesUriPattern(uri, parsed.uri, pattern)
              );
          }
          if (needsCursorPostFilter) {
            arr = format === "uris"
              ? filterUrisByCursor(
                arr as string[],
                cursor,
                parsed.params.sortOrder,
              )
              : filterByCursor(
                arr as Array<Output>,
                cursor,
                parsed.params.sortOrder,
              );
          }
          if (parsed.params.limit !== undefined) {
            // page is incompatible with cursor (validateReadParams
            // throws on that combo); when only `page` is set the
            // page-based offset still applies.
            const start = needsCursorPostFilter
              ? 0
              : ((parsed.params.page ?? 1) - 1) * parsed.params.limit;
            arr = arr.slice(start, start + parsed.params.limit);
          }
          if (fields && fields.length > 0 && format === "full") {
            arr = (arr as Array<Output>).map(([uri, record]): Output => [
              uri,
              projectRecord(record, fields),
            ]);
          }
          payload = arr;
          break;
        }

        // Fast pass-through: the backend handled (or accepted) every
        // param itself. We only need to optionally project the
        // returned records.
        const raw = await handlers.ls(parsed);
        if (
          fields && fields.length > 0 && Array.isArray(raw) &&
          format === "full"
        ) {
          payload = (raw as Array<Output>).map(([uri, record]): Output => [
            uri,
            projectRecord(record, fields),
          ]);
        } else {
          payload = raw;
        }
        break;
      }
      case "count": {
        if (needsPatternPostFilter || needsCursorPostFilter) {
          // Filtered count: list the matching URIs (cheap
          // `format=uris` path, no payload load) and return the
          // length. Slower than push-down COUNT, but the only way to
          // honour pattern/cursor without per-backend query
          // translation.
          const lsParams: ReadParams = {
            ...parsed.params,
            format: "uris",
          };
          delete lsParams.fields;
          delete lsParams.limit;
          delete lsParams.page;
          delete lsParams.cursor;
          if (needsPatternPostFilter) delete lsParams.pattern;
          const raw = await handlers.ls({ ...parsed, params: lsParams });
          if (!Array.isArray(raw)) {
            payload = 0;
            break;
          }
          let uris = raw as string[];
          if (needsPatternPostFilter) {
            uris = uris.filter((uri) =>
              matchesUriPattern(uri, parsed.uri, pattern)
            );
          }
          if (needsCursorPostFilter) {
            uris = filterUrisByCursor(uris, cursor, parsed.params.sortOrder);
          }
          payload = uris.length;
        } else {
          payload = await handlers.count(parsed);
        }
        break;
      }
      default:
        if (parsed.fn.startsWith("x-") && handlers.ext) {
          payload = await handlers.ext(parsed);
          break;
        }
        throw new Error(`${storeName}: unsupported fn '${parsed.fn}'`);
    }
    out.push([url, payload as T]);
  }
  return out;
}
