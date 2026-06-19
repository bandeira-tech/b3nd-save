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
import type { ParsedUrl } from "./url.ts";
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
}

export async function dispatchRead<T = unknown>(
  urls: string[],
  storeName: string,
  handlers: ReadHandlers,
): Promise<Output<T>[]> {
  const out: Output<T>[] = [];
  for (const url of urls) {
    const parsed = parseUrl(url);
    let payload: unknown;
    const fields = parsed.params.fields;
    switch (parsed.fn) {
      case "read":
        payload = await handlers.read(parsed);
        if (fields && fields.length > 0) {
          payload = projectRecord(payload, fields);
        }
        break;
      case "ls": {
        const pattern = parsed.params.pattern;
        const format = parsed.params.format ?? "full";

        if (pattern !== undefined) {
          // Pattern filter applies before limit/page so callers get
          // up to N matching rows (not "up to N rows, some of which
          // match"). Strip pattern + pagination + projection from the
          // handler call so the backend gives us the full sorted
          // result without trying to push down a filter it doesn't
          // know how to translate; then filter → page → project in
          // one pass here.
          const handlerParams = { ...parsed.params };
          delete handlerParams.limit;
          delete handlerParams.page;
          delete handlerParams.fields;
          delete handlerParams.pattern;
          const raw = await handlers.ls({ ...parsed, params: handlerParams });
          if (!Array.isArray(raw)) {
            payload = raw;
            break;
          }
          let arr = format === "uris"
            ? (raw as string[]).filter((uri) =>
              matchesUriPattern(uri, parsed.uri, pattern)
            )
            : (raw as Array<Output>).filter(([uri]) =>
              matchesUriPattern(uri, parsed.uri, pattern)
            );
          if (parsed.params.limit !== undefined) {
            const page = parsed.params.page ?? 1;
            const start = (page - 1) * parsed.params.limit;
            arr = (arr as unknown[]).slice(
              start,
              start + parsed.params.limit,
            ) as typeof arr;
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

        const raw = await handlers.ls(parsed);
        // Projection here covers the push-down backends (postgres,
        // mongo, sqlite, s3, ES, IndexedDB) whose own `ls` doesn't
        // route through `applyReadParams`. Backends that DO use
        // `applyReadParams` (localstorage) already projected —
        // re-projecting is idempotent on the now-narrower records.
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
        const pattern = parsed.params.pattern;
        if (pattern !== undefined) {
          // Pattern-filtered count: list the matching URIs (cheap
          // `format=uris` path, no payload load) and return the
          // length. Slower than push-down COUNT, but the only way to
          // honour pattern without per-backend query translation.
          const lsParams: typeof parsed.params = {
            ...parsed.params,
            format: "uris",
          };
          delete lsParams.fields;
          delete lsParams.limit;
          delete lsParams.page;
          delete lsParams.pattern;
          const raw = await handlers.ls({ ...parsed, params: lsParams });
          if (!Array.isArray(raw)) {
            payload = 0;
          } else {
            payload = (raw as string[]).filter((uri) =>
              matchesUriPattern(uri, parsed.uri, pattern)
            ).length;
          }
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
