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
import { projectRecord } from "./read.ts";
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
        const raw = await handlers.ls(parsed);
        // Projection here covers the push-down backends (postgres,
        // mongo, sqlite, s3, ES, IndexedDB) whose own `ls` doesn't
        // route through `applyReadParams`. Backends that DO use
        // `applyReadParams` (memory, localstorage, fs, ipfs) already
        // projected — re-projecting is a no-op on the now-narrower
        // records, so the round-trip is idempotent.
        if (
          fields && fields.length > 0 && Array.isArray(raw) &&
          (parsed.params.format ?? "full") === "full"
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
      case "count":
        payload = await handlers.count(parsed);
        break;
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
