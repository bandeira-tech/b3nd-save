/**
 * EntityStore — schema-aware storage contract.
 *
 * A single store instance hosts many entities side-by-side. Nothing is
 * pinned at construction; every operation is keyed by an opaque
 * {@link EntityMeta} returned from {@link EntityStore.entitySupport}.
 *
 * ## Three-step lifecycle, controlled by the caller
 *
 * 1. **`entitySupport(schema)`** — pure. Compiles the schema into the
 *    backend's operational handle (column plans, target table names,
 *    bytes-field sets, the per-field {@link EntitySupport} report).
 *    No side effects, no IO. The returned meta is what the rest of
 *    the surface consumes.
 * 2. **`provisionEntity(meta)`** — idempotent. Materialises the
 *    entity on the medium: creates the table, allocates the bucket,
 *    writes the index. Re-running with the same meta is a no-op.
 *    Running with a meta whose shape conflicts with what is already
 *    provisioned at the same name surfaces an error.
 * 3. **`entityStatus(meta)`** — checks whether the entity described
 *    by `meta` is live on the medium right now. Returns `"live"`
 *    only when the medium's current shape matches `meta`; a same-name
 *    entity with a different shape reports `"unprovisioned"`. Use to
 *    decide whether to provision now or skip; do not use as a
 *    precondition before every operation — it adds cost that the
 *    natural backend failure already gives you for free.
 *
 * Provisioning is the caller's job. `write` / `read` / `delete` do
 * not pre-check or auto-provision; if a meta refers to an entity
 * that is not live on the medium, the operation surfaces the
 * backend's natural failure (storage error / undefined table / etc.).
 *
 * ## Strictness
 *
 * Writes/reads/deletes are strict. A record that does not match the
 * meta's declared shape produces a `StoreWriteResult.error` (or
 * `DeleteResult.error` for delete-time failures). The store never
 * silently drops or coerces — coercion is the client's job (see
 * `SaveClient`, which projects raw bytes into a `BYTES_ENTITY`
 * record when its target is `BYTES_ENTITY`).
 *
 * Reads return `Output<EntityRecord | undefined>` for `fn=read`;
 * `fn=ls` and `fn=count` follow the same conventions as `Store`
 * (URI lists and numbers — see `./read.ts`).
 */

import type {
  DeleteResult,
  Output,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import type { EntityMeta, EntityRecord, EntitySchema } from "./entity.ts";
import type { StoreCapabilities, StoreWriteResult } from "./types.ts";

export interface EntityStore<TMeta extends EntityMeta = EntityMeta> {
  /**
   * Compile a schema into the backend's opaque operational handle.
   * Pure: no IO, no cache mutation. The caller owns the returned
   * meta's lifetime and decides whether to memoize, re-derive, or
   * pass it through.
   */
  entitySupport(schema: EntitySchema): TMeta;

  /**
   * Whether the entity described by `meta` is live on the medium.
   * `"live"` only when the medium's current shape matches `meta`;
   * a same-name entity with a different shape reports
   * `"unprovisioned"` so callers do not act on a collision.
   */
  entityStatus(meta: TMeta): Promise<"live" | "unprovisioned">;

  /**
   * Materialise the entity described by `meta` on the medium.
   * Idempotent: repeat calls with the same meta no-op. Calling with
   * a meta whose shape conflicts with an already-provisioned entity
   * at the same name throws.
   */
  provisionEntity(meta: TMeta): Promise<void>;

  /**
   * Write records described by `meta` at the given URIs. Per-entry
   * result is returned in input order. A record that does not match
   * `meta`'s declared shape produces a failure result for that
   * entry — the store does not coerce. Calling with a meta whose
   * entity is not live on the medium surfaces the backend's natural
   * storage failure per entry.
   */
  write(
    meta: TMeta,
    entries: { uri: string; record: EntityRecord }[],
  ): Promise<StoreWriteResult[]>;

  /**
   * Read records described by `meta` at the given URLs. URLs follow
   * the standard `fn=read|ls|count|x-*` grammar — see `./read.ts`.
   * `fn=read` yields `Output<EntityRecord | undefined>` (undefined
   * payload means miss); `fn=ls` and `fn=count` follow the package
   * conventions. Reads against an entity that is not live on the
   * medium surface as misses or the backend's natural read error.
   */
  read<T = EntityRecord | undefined>(
    meta: TMeta,
    urls: string[],
  ): Promise<Output<T>[]>;

  /**
   * Delete records described by `meta` at the given URIs. Per-entry
   * result is returned in input order.
   */
  delete(meta: TMeta, uris: string[]): Promise<DeleteResult[]>;

  /** Health + capabilities, aggregated across all hosted entities. */
  status(): Promise<StatusResult>;

  /**
   * Optional capability reporting. Backends advertise what they can
   * do so clients can make informed decisions (e.g. wrap deletes +
   * writes in a transaction when `atomicBatch` is true).
   */
  capabilities?(): StoreCapabilities;
}
