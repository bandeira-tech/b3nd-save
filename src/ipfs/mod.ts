/**
 * IPFS backend for b3nd.
 *
 * Store implementation backed by IPFS. Requires an injected
 * IpfsExecutor so the package does not depend on a specific IPFS
 * library. Blocks hold raw payload bytes — the store is opaque.
 *
 * `add` accepts the `StorePayload` union to support both buffered
 * and streaming callers; `cat` returns a `ReadableStream<Uint8Array>`
 * to avoid materializing the block in memory unless the caller wants
 * it.
 *
 * ## Durability warning — session-scoped index
 *
 * IPFS blocks are pinned and durable, but the URI → CID index and
 * provisioning bookkeeping live only in process memory (a `Map`
 * inside the `IpfsStore` instance). After a process restart:
 *
 * - Previously-written blocks are unreachable: the store cannot map
 *   any URI back to its CID.
 * - `entityStatus(meta)` returns `"unprovisioned"` for every entity
 *   until `provisionEntity` is called again.
 * - `read` returns misses for all URIs that were valid before the
 *   restart.
 *
 * `IpfsStore` is effectively session-scoped as an `EntityStore`.
 * Persisting the index (e.g. writing a bucket-root IPFS block on
 * each write and handing the root CID to the caller for rehydration)
 * is deferred — callers that need durable addressing across restarts
 * should track CIDs externally or use a different backend.
 */

import type { StorePayload } from "../types.ts";

export interface IpfsExecutor {
  add: (content: StorePayload) => Promise<string>;
  cat: (cid: string) => Promise<ReadableStream<Uint8Array>>;
  pin: (cid: string) => Promise<void>;
  unpin: (cid: string) => Promise<void>;
  listPins: () => Promise<string[]>;
  isOnline: () => Promise<boolean>;
  cleanup?: () => Promise<void>;
}

export { IpfsStore } from "./store.ts";
