/**
 * Filesystem backend for b3nd.
 *
 * Store implementation backed by the local filesystem. Requires an
 * injected FsExecutor so the package does not depend on a specific
 * filesystem API. Files hold raw payload bytes — the store is opaque.
 *
 * The executor reads via `ReadableStream<Uint8Array>` to avoid forcing
 * callers (or the executor) to materialize large files in memory.
 * Writes accept the `StorePayload` union so existing buffered callers
 * still work without conversion.
 */

import type { StorePayload } from "../types.ts";

export interface FsExecutor {
  readFile: (path: string) => Promise<ReadableStream<Uint8Array>>;
  writeFile: (path: string, content: StorePayload) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  /**
   * List the names of *files* that are direct children of `dir`.
   * Subdirectories and entries deeper than one level MUST NOT be
   * returned — `ls` / `count` are shallow contracts.
   */
  listFiles: (dir: string) => Promise<string[]>;
  cleanup?: () => Promise<void>;
}

export { FsStore } from "./store.ts";
export type { FsStoreOptions } from "./store.ts";
