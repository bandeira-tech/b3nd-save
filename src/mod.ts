/**
 * @module
 * b3nd-save — the data-saving layer for b3nd.
 *
 * This root barrel re-exports every public subpath as a namespace.
 * Use it for convenience or discoverability; for the smallest
 * footprint, import the subpaths directly (e.g.
 * `@bandeira-tech/b3nd-save/postgres`).
 *
 * Namespaces:
 *   clients       — EntityStore → ProtocolInterfaceNode adapters
 *   memory        — In-memory reference backend
 *   postgres, mongo, sqlite, fs, ipfs, s3, elasticsearch,
 *   localstorage, indexeddb — EntityStore backend implementations
 *
 * The entity surface (`EntityStore`, `EntitySchema`, `BYTES_ENTITY`,
 * `TYPE_TAGS`, …) is re-exported from the root for convenience.
 */

export type { StoreCapabilities, StoreWriteResult } from "./types.ts";

export type { ParsedUrl, ReadParams } from "./url.ts";
export { buildUrl, parseUrl, uriOf } from "./url.ts";

export type {
  EntityField,
  EntityMeta,
  EntityRecord,
  EntitySchema,
  EntitySupport,
} from "./entity.ts";
export { BYTES_ENTITY, TYPE_TAGS } from "./entity.ts";
export type { EntityStore } from "./entity-store.ts";

export * as clients from "./clients/mod.ts";
export * as memory from "./memory/mod.ts";
export * as postgres from "./postgres/mod.ts";
export * as mongo from "./mongo/mod.ts";
export * as sqlite from "./sqlite/mod.ts";
export * as fs from "./fs/mod.ts";
export * as ipfs from "./ipfs/mod.ts";
export * as s3 from "./s3/mod.ts";
export * as elasticsearch from "./elasticsearch/mod.ts";
export * as localstorage from "./localstorage/mod.ts";
export * as indexeddb from "./indexeddb/mod.ts";
