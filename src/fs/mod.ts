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
  /**
   * Walk every *file* descendant of `dir` recursively and yield each
   * file's path **relative to `dir`** (no leading `/`, forward-slash
   * separated). Directories themselves MUST NOT be yielded — only file
   * leaves. Order is unspecified; callers must sort if they need it.
   *
   * Contract for non-existent / empty `dir`: yield nothing (do NOT
   * throw). This matches the existing `listFiles` convention — `fn=ls`
   * on an empty/missing prefix returns `[]`, never an error — and the
   * `fn=find` handler inherits the same shape.
   *
   * `AsyncIterable` lets backends that can stream the walk lazily
   * (Deno's `walk`, S3's paginated `ListObjectsV2`, etc.) do so without
   * materialising the full path list; in-memory executors can yield
   * Map keys directly. Consumers that want a materialised array call
   * `Array.fromAsync(executor.walkFiles(dir))`.
   *
   * Used by the `fn=find` handler in `FsStore` to drive recursive
   * listings (v2 §3.3, §3.5). Stores that only need `fn=ls` / `fn=read`
   * don't invoke this path; an executor that omits it would break
   * `fn=find` but nothing else. (The interface marks it required so the
   * TypeScript compiler catches the omission at the call site instead
   * of at runtime — see the smoke-rig migration note in PR #82's
   * follow-up.)
   */
  walkFiles: (dir: string) => AsyncIterable<string>;
  cleanup?: () => Promise<void>;
}

export { FsStore } from "./store.ts";
