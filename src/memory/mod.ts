/**
 * In-memory `EntityStore` backend.
 *
 * `MemoryStore` is the reference implementation — one flat
 * `Map<uri, EntityRecord>` per ensured entity. Useful as a
 * deterministic stand-in for tests and prototypes.
 *
 * Follows the shallow direct-leaves `fn=ls` / `fn=count` contract
 * enforced across every backend in this package.
 */

export { MemoryStore } from "./store.ts";
