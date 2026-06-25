/**
 * URL dispatch helper for Store.read implementations.
 *
 * Every store parses the input url, switches on `fn`, and calls back
 * into store-supplied handlers. Centralising the dispatch keeps the
 * `read`/`ls`/`find`/`count`/`x-*` switch identical across stores so
 * they cannot drift apart.
 *
 * Stores call `dispatchRead(urls, handlers)`; the helper handles
 * parsing, the fn switch, and tuple assembly. Each handler receives
 * the parsed url and returns the payload — the helper wraps it into
 * `[inputUrl, payload]`.
 *
 * v2 listing-spec additions (see `.cc-chat/20260625121936-grammar-shape`):
 *
 * - **`find` case** — requires an explicit `handlers.find` registration
 *   (mirrors the `ext?:` opt-in pattern). When `handlers.find` is
 *   absent, dispatch throws via the same "unsupported fn" path as any
 *   unknown verb — no silent fall-back through `ls`. Stores that
 *   support deep walks must wire their own `find` handler (push-down
 *   into the backend, or an in-process recursive walk built on `ls`).
 *   See spec §3.5: a store that does not advertise `"find"` in
 *   `status().fns` MUST throw on `fn=find`.
 *
 * - **cursor-as-trailing-slot** — when `find` or `ls` is called with
 *   `limit=<n>`, dispatch appends ONE extra `Output` to the returned
 *   array: `[<cursor-uri>, { next: "<opaque>" | null }]`. The cursor
 *   URI is the original locator with `cursor=<opaque>` added (or
 *   replaced). `next: null` signals end-of-result; otherwise `next` is
 *   the opaque token to re-issue the request. The caller can do
 *   `read([slot.uri])` literally and walk the next page.
 */

import type { Output } from "@bandeira-tech/b3nd-core/types";
import { compareSortable, projectRecord } from "./read.ts";
import { compileSaveGlob, matchesGlob } from "./glob.ts";
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
   * Optional handler for `fn=find` (recursive walk). Mirrors the
   * `ext?:` pattern: when absent, dispatch throws "unsupported fn
   * 'find'" via the same path as any unknown verb — NO silent fall-back
   * through `ls`. This is the v2 §3.5 contract: stores that do not
   * advertise `"find"` in `status().fns` get a loud failure on
   * `fn=find` calls, never plausible-but-wrong shallow results.
   *
   * Stores that want to support find must supply this handler — either
   * a push-down query (set `pushDownFind: true`) or an in-process
   * recursive walk that produces deep matches.
   */
  find?: (parsed: ParsedUrl) => unknown | Promise<unknown>;
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
  /**
   * Opt-in: this handler honours `cursor` in its own ls/count
   * queries. When true, dispatch passes `cursor` through and skips
   * the post-filter — the backend combines `cursor` with the active
   * sort order (`uri > cursor` for asc, `uri < cursor` for desc) and
   * with `limit` inside its query. `count` with a cursor likewise
   * goes through the backend's own `count` handler.
   *
   * When false (default), dispatch strips `cursor` + pagination from
   * the handler call and post-filters locally.
   */
  pushDownCursor?: boolean;
  /**
   * Opt-in: this handler honours `sortBy=<field>` (any field, not
   * just `"uri"`) in its own ls query. When true, dispatch passes
   * the sortBy through unchanged. When false (default), dispatch
   * post-sorts by record field in JS — the backend ignores
   * non-uri sortBy values (or treats them as uri sort).
   *
   * Every backend always handles `sortBy="uri"` natively; this flag
   * only controls non-uri sortBy.
   */
  pushDownSortBy?: boolean;
  /**
   * Opt-in: when `handlers.find` is registered, this flag says the
   * backend honours `pattern` + pagination inside its own query
   * (typically by removing the shallow `LIKE %/%` predicate or by
   * swapping a `[^/]+` regex body for `.*`). When true, dispatch
   * passes `pattern` through unchanged and skips the post-filter.
   *
   * When false (default) and `handlers.find` is registered, dispatch
   * post-filters the rows the handler returned against the user's
   * pattern — the handler is expected to return all entries under the
   * prefix (deep walk) so the post-filter can run honestly.
   *
   * Has no effect when `handlers.find` is absent — that case throws
   * "unsupported fn 'find'" at the dispatch switch.
   */
  pushDownFind?: boolean;
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

/**
 * Read a named field from a payload, returning `undefined` for any
 * non-record payload (eg `Uint8Array`, `ReadableStream`, miss). Used
 * by the dispatch post-sort path so non-uri sortBy works against the
 * `EntityRecord` shape returned by handlers.
 */
function recordField(value: unknown, field: string): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") return undefined;
  if (value instanceof Uint8Array) return undefined;
  if (value instanceof ReadableStream) return undefined;
  return (value as Record<string, unknown>)[field];
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

/**
 * Compose the trailing cursor slot for a paginated `find` / `ls`
 * response. Returns `[cursorUri, { next }]` where `cursorUri` is the
 * original input url with `cursor=<opaque>` added (or replaced; every
 * other param is preserved). `next` is the opaque token (the URI of
 * the last entry returned) when more results are available, `null`
 * when the page was the tail of the result set.
 *
 * The slot is appended UNCONDITIONALLY when `limit` was set in the
 * request — callers shouldn't have to special-case "this might be the
 * last page" or "this is empty"; the `next: null` case carries that
 * signal. Re-issue is `read([slot.uri])` literally.
 *
 * URI composition: we operate on the original input url string (not
 * `parsed.uri`) so the URI-embedded glob portion (`**`, etc.) is
 * preserved. `cursor=` is set/replaced in place via URLSearchParams.
 */
function buildCursorSlot(
  inputUrl: string,
  cursorForUri: string | null,
  next: string | null,
): Output {
  const qIdx = inputUrl.indexOf("?");
  const uriPart = qIdx < 0 ? inputUrl : inputUrl.slice(0, qIdx);
  const queryPart = qIdx < 0 ? "" : inputUrl.slice(qIdx + 1);
  const sp = new URLSearchParams(queryPart);
  // The cursor URI is the re-issuable locator: every other param
  // preserved, `cursor=` set to the last row's URI we returned (so the
  // caller can re-issue and get the next page — or, if we already
  // returned the tail, get an empty page + `next: null`). When the
  // page was empty entirely (no rows at all), there is no last URI to
  // hang a cursor on; we drop it so the URI matches a fresh request.
  if (cursorForUri !== null) {
    sp.set("cursor", cursorForUri);
  } else {
    sp.delete("cursor");
  }
  const qs = sp.toString();
  const cursorUri = qs ? `${uriPart}?${qs}` : uriPart;
  return [cursorUri, { next }];
}

/**
 * Type guard: is the row a plain `Output` tuple (`[uri, payload]`).
 * Used after we strip the cursor slot before applying further
 * transformations to find/ls payloads.
 */
function lastUriOfRows(rows: unknown[]): string | null {
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];
  if (typeof last === "string") return last;
  if (Array.isArray(last) && typeof last[0] === "string") return last[0];
  return null;
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
    const sortBy = parsed.params.sortBy;
    const needsPatternPostFilter = pattern !== undefined &&
      !handlers.pushDownPattern;
    const needsCursorPostFilter = cursor !== undefined &&
      !handlers.pushDownCursor;
    // Non-uri sortBy needs dispatch post-sort unless the backend
    // explicitly handles arbitrary sortBy itself. `leaf` is a
    // dispatch-level sort (basename localeCompare); it always
    // post-sorts.
    const needsSortByPostSort = sortBy !== undefined && sortBy !== "uri" &&
      !handlers.pushDownSortBy;

    switch (parsed.fn) {
      case "read":
        payload = await handlers.read(parsed);
        if (fields && fields.length > 0) {
          payload = projectRecord(payload, fields);
        }
        break;
      case "ls":
      case "find": {
        const isFind = parsed.fn === "find";
        // v2 §3.5: a store that does not advertise `"find"` in
        // status().fns MUST throw on fn=find. We enforce that at the
        // dispatch level by requiring an explicit `handlers.find`
        // registration — no silent fall-back through `ls`. Error shape
        // matches the unknown-fn throw below so existing callers can
        // detect it the same way.
        if (isFind && !handlers.find) {
          throw new Error(`${storeName}: unsupported fn 'find'`);
        }
        const format = parsed.params.format ?? "full";
        // For find, `handlers.find` is guaranteed present by the guard
        // above. For ls, the handler is `handlers.ls`.
        const lsLikeHandler = isFind ? handlers.find! : handlers.ls;

        if (
          needsPatternPostFilter || needsCursorPostFilter ||
          needsSortByPostSort
        ) {
          // Dispatch handles pattern/cursor/sortBy + pagination +
          // projection itself, so it asks the backend for the full
          // result first. Stripping `limit`/`page` is necessary so the
          // backend doesn't truncate the set before the filters run;
          // stripping `pattern`/`cursor`/non-uri `sortBy` is necessary
          // so backends that don't recognise them don't error out.
          // For non-uri sortBy we also have to force `format=full`
          // since records (not just URIs) are needed to read the
          // sort field.
          const handlerParams: ReadParams = { ...parsed.params };
          delete handlerParams.limit;
          delete handlerParams.page;
          delete handlerParams.fields;
          delete handlerParams.cursor;
          if (needsPatternPostFilter) delete handlerParams.pattern;
          const handlerFormat = needsSortByPostSort && format === "uris"
            ? "full"
            : format;
          handlerParams.format = handlerFormat;
          if (needsSortByPostSort) handlerParams.sortBy = "uri";
          const raw = await lsLikeHandler({
            ...parsed,
            params: handlerParams,
          });
          if (!Array.isArray(raw)) {
            payload = raw;
            break;
          }
          let arr: unknown[] = raw as unknown[];

          if (needsPatternPostFilter) {
            // Hoist the compiled glob — the row loop is the only hot
            // spot we know about and the compile cost is non-trivial.
            const re = compileSaveGlob(pattern);
            arr = handlerFormat === "uris"
              ? (arr as string[]).filter((uri) =>
                uri.startsWith(parsed.uri) &&
                re.test(uri.slice(parsed.uri.length))
              )
              : (arr as Array<Output>).filter(([uri]) =>
                uri.startsWith(parsed.uri) &&
                re.test(uri.slice(parsed.uri.length))
              );
          }
          if (needsCursorPostFilter) {
            arr = handlerFormat === "uris"
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
          if (needsSortByPostSort) {
            // We forced format=full above, so arr is Array<Output>.
            const dir = parsed.params.sortOrder === "desc" ? -1 : 1;
            if (sortBy === "leaf") {
              arr = [...(arr as Array<Output>)].sort(([a], [b]) =>
                leafOf(a).localeCompare(leafOf(b)) * dir
              );
            } else {
              arr = [...(arr as Array<Output>)].sort(([, a], [, b]) => {
                const av = recordField(a, sortBy);
                const bv = recordField(b, sortBy);
                return compareSortable(av, bv) * dir;
              });
            }
          }
          let truncated = false;
          if (parsed.params.limit !== undefined) {
            // page is incompatible with cursor (validateReadParams
            // throws on that combo); when only `page` is set the
            // page-based offset still applies.
            const start = needsCursorPostFilter
              ? 0
              : ((parsed.params.page ?? 1) - 1) * parsed.params.limit;
            const end = start + parsed.params.limit;
            truncated = arr.length > end;
            arr = arr.slice(start, end);
          }
          // If we forced format=full to access the sort field but the
          // caller asked for uris, project down to uris at the end.
          if (handlerFormat === "full" && format === "uris") {
            arr = (arr as Array<Output>).map(([uri]) => uri);
          } else if (fields && fields.length > 0 && format === "full") {
            arr = (arr as Array<Output>).map(([uri, record]): Output => [
              uri,
              projectRecord(record, fields),
            ]);
          }
          // Append cursor-as-trailing-slot whenever `limit` was set.
          // `cursorForUri`: the URI of the last row returned (or null if
          // the page was empty) — used to compose a re-issuable locator.
          // `next`: the opaque cursor for the next page, or `null` when
          // the page was the tail of the result set.
          if (parsed.params.limit !== undefined) {
            const lastUri = lastUriOfRows(arr);
            const next = truncated ? lastUri : null;
            arr = [...arr, buildCursorSlot(url, lastUri, next)];
          }
          payload = arr;
          break;
        }

        // Fast pass-through: the backend handled (or accepted) every
        // param itself. We only need to optionally project the
        // returned records and append the cursor slot.
        const raw = await lsLikeHandler(parsed);
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
        if (parsed.params.limit !== undefined && Array.isArray(payload)) {
          // We don't know if the backend truncated — the only safe
          // signal we have is "did we return `limit` items"; if we
          // did, callers should re-issue. False positives (cursor
          // points past the end) are correctness-safe: the next call
          // returns an empty page + a `next: null` slot.
          const arr = payload as unknown[];
          const isFull = arr.length >= parsed.params.limit;
          const lastUri = lastUriOfRows(arr);
          const next = isFull ? lastUri : null;
          payload = [...arr, buildCursorSlot(url, lastUri, next)];
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
            uris = uris.filter((uri) => matchesGlob(uri, parsed.uri, pattern));
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

// Local copy of leafOf to avoid an extra import — same recipe as
// read.ts's exported helper. Keeping it local keeps the dispatch
// module's import surface tight (we already pull compareSortable,
// projectRecord, and the glob helpers).
function leafOf(uri: string): string {
  const idx = uri.lastIndexOf("/");
  return idx < 0 ? uri : uri.slice(idx + 1);
}
