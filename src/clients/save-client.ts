/**
 * SaveClient — unified ProtocolInterfaceNode adapter over an EntityStore.
 *
 * Construction shape:
 *
 *     new SaveClient(mapper, entity, store)
 *
 * Reads on the rig: "receive payloads X, map as Y into entity E,
 * store on S". All three are explicit; the client does not invent
 * defaults.
 *
 * - **mapper** — a {@link SaveMapper}: a bidirectional codec between
 *   wire (uri, payload) and store (uri, record). Runs on every URI hop
 *   in both directions. {@link mapToBytes} and {@link passThroughRecord}
 *   cover the common identity-URI cases.
 * - **entity** — the {@link EntitySchema} of the *store record*. This
 *   is what the store's `entitySupport` inspects and what
 *   `mapper.toStore` must produce records matching. Use
 *   {@link BYTES_ENTITY} for opaque-bytes stores.
 * - **store** — any {@link EntityStore}. Every backend in this
 *   package implements it.
 *
 * ## Lifecycle
 *
 * SaveClient is pure: it computes its `EntityMeta` once at
 * construction (via `store.entitySupport(target)`, which is a pure
 * function) and reuses it on every `receive`/`read`/`delete`. There
 * is no lifecycle method on the client — provisioning the underlying
 * store is the **caller's** job, handled out of band (app boot for
 * production, test setup for tests):
 *
 *     await store.provisionEntity(store.entitySupport(target));
 *     const client = new SaveClient(mapper, target, store);
 *
 * If the caller skips provisioning, the backend surfaces its natural
 * failure on first IO (storage error for write/delete, throw or miss
 * for read) — same as calling any other `EntityStore` method against
 * an unprovisioned entity.
 *
 * ## URI translation
 *
 * Every wire URI hitting SaveClient goes through `mapper.toStore` before
 * reaching the store; every URI coming back out goes through
 * `mapper.fromStore`. The store never sees wire URIs — it only ever
 * sees store URIs. Observe emissions are keyed on the wire URI so
 * downstream consumers see the vocabulary the rig routes in.
 *
 * Wire shape: a `receive` message is `Output<TIn | null>` —
 * `[uri, payload]` where `payload === null` is the delete-by-convention.
 *
 * A `SaveClient` is a one-shot, isolated thing: each one routes one
 * entity, and routing a different entity means constructing a
 * different client.
 */

import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { ObserveEmitter } from "@bandeira-tech/b3nd-core";
import type { EntityStore } from "../entity-store.ts";
import type { EntityMeta, EntityRecord, EntitySchema } from "../entity.ts";
import type { StorePayload } from "../types.ts";

/** A value or a Promise for that value. */
type MaybeAsync<T> = T | Promise<T>;

/**
 * Bidirectional codec between the wire vocabulary
 * `(wireUri, wirePayload)` and the store vocabulary
 * `(storeUri, storeRecord)`.
 *
 * - **`toStore(wireUri, payload?)`** runs on every request going into
 *   the store (write, read, delete). When `payload` is present, both
 *   URI and record are transformed; when absent (URI-only ops), only
 *   the URI is meaningful and `record` MAY be omitted from the return.
 * - **`fromStore(storeUri, record?)`** runs on every result coming out
 *   of the store. Return `null` to drop a foreign entry (a store URI
 *   the mapper does not recognize — e.g. a stray file the app did not
 *   write). When `record` is absent (URI-only op / miss), only the
 *   translated URI is meaningful.
 *
 * The mapper is the single "opinion" locus: URI shape choices,
 * on-medium encoding, and any per-schema validation all live here.
 * The store below never sees a wire URI and never coerces its bytes.
 */
export interface SaveMapper<TIn = unknown, TOut = TIn> {
  toStore(wireUri: string, payload?: TIn): MaybeAsync<{
    uri: string;
    record?: EntityRecord;
  }>;
  fromStore(storeUri: string, record?: EntityRecord): MaybeAsync<
    { uri: string; payload?: TOut } | null
  >;
}

/**
 * Built-in mapper for opaque-bytes wires. URI passes through
 * unchanged; the wire byte payload is wrapped as `{ payload: bytes }`
 * on the way in, unwrapped on the way out. Pair with
 * {@link BYTES_ENTITY}.
 */
export const mapToBytes: SaveMapper<StorePayload, StorePayload> = {
  toStore: (uri, bytes) => ({
    uri,
    record: bytes !== undefined ? { payload: bytes } : undefined,
  }),
  fromStore: (uri, record) => ({
    uri,
    payload: record === undefined
      ? undefined
      : (record.payload as StorePayload | undefined),
  }),
};

/**
 * Built-in mapper for wires that already carry the store's record
 * shape. URI and record pass through unchanged in both directions.
 * Use when the protocol upstream produces a valid `EntityRecord`
 * matching the target schema.
 */
export const passThroughRecord: SaveMapper<EntityRecord, EntityRecord> = {
  toStore: (uri, record) => ({ uri, record }),
  fromStore: (uri, record) => ({ uri, payload: record }),
};

/**
 * True when `row` looks like an `Output` tuple `[uri, payload]`.
 * Used in `read` to distinguish tuple results from `format=uris`
 * (`string[]`) or `fn=count` (`number[]`) return shapes.
 */
function isOutputTuple(row: unknown): row is [string, unknown] {
  return (
    Array.isArray(row) &&
    row.length === 2 &&
    typeof (row as unknown[])[0] === "string"
  );
}

/**
 * True when `arr` is a list of `Output` tuples — the shape ls/find
 * return in their outer payload slot (`[[uri, record], ...]`).
 */
function isOutputArray(arr: unknown): arr is Array<[string, unknown]> {
  return Array.isArray(arr) && (arr.length === 0 || isOutputTuple(arr[0]));
}

export class SaveClient<TIn = unknown, TOut = TIn> extends ObserveEmitter
  implements ProtocolInterfaceNode {
  readonly mapper: SaveMapper<TIn, TOut>;
  readonly target: EntitySchema;
  readonly store: EntityStore;
  /**
   * The store-compiled meta for `target`. Derived once at construction
   * via `store.entitySupport(target)` (pure). Exposed so callers can
   * inspect `meta.support` to see which fields the medium accepted.
   */
  readonly meta: EntityMeta;

  constructor(
    mapper: SaveMapper<TIn, TOut>,
    target: EntitySchema,
    store: EntityStore,
  ) {
    super();
    this.mapper = mapper;
    this.target = target;
    this.store = store;
    this.meta = store.entitySupport(target);
  }

  async receive(msgs: Output<TIn | null>[]): Promise<ReceiveResult[]> {
    const results: ReceiveResult[] = new Array(msgs.length);
    const writes: {
      wireUri: string;
      storeUri: string;
      record: EntityRecord;
      wire: TIn;
      index: number;
    }[] = [];
    const deletes: {
      wireUri: string;
      storeUri: string;
      index: number;
    }[] = [];

    for (let i = 0; i < msgs.length; i++) {
      const [wireUri, wirePayload] = msgs[i];
      if (!wireUri || typeof wireUri !== "string") {
        results[i] = { accepted: false, error: "URI is required" };
        continue;
      }
      try {
        if (wirePayload === null) {
          // Delete — URI-only translation.
          const { uri: storeUri } = await this.mapper.toStore(wireUri);
          deletes.push({ wireUri, storeUri, index: i });
        } else {
          const { uri: storeUri, record } = await this.mapper.toStore(
            wireUri,
            wirePayload as TIn,
          );
          if (record === undefined) {
            throw new Error(
              "mapper.toStore returned no record for a non-null payload",
            );
          }
          writes.push({
            wireUri,
            storeUri,
            record,
            wire: wirePayload as TIn,
            index: i,
          });
        }
      } catch (e) {
        results[i] = {
          accepted: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    if (writes.length > 0) {
      const writeResults = await this.store.write(
        this.meta,
        writes.map(({ storeUri, record }) => ({ uri: storeUri, record })),
      );
      for (let j = 0; j < writeResults.length; j++) {
        const w = writes[j];
        const r = writeResults[j];
        results[w.index] = { accepted: r.success, error: r.error };
        if (r.success) this._emit(w.wireUri, w.wire);
      }
    }

    if (deletes.length > 0) {
      const delResults = await this.store.delete(
        this.meta,
        deletes.map((d) => d.storeUri),
      );
      const deletedUris: string[] = [];
      for (let j = 0; j < delResults.length; j++) {
        const d = deletes[j];
        const r = delResults[j];
        results[d.index] = { accepted: r.success, error: r.error };
        if (r.success) deletedUris.push(d.wireUri);
      }
      if (deletedUris.length > 0) this._emitDeletes(deletedUris);
    }

    return results;
  }

  async read<T = TOut | undefined>(urls: string[]): Promise<Output<T>[]> {
    // Translate each wire URI to a store URI up front.
    const storeUris = await Promise.all(
      urls.map(async (u) => (await this.mapper.toStore(u)).uri),
    );

    const rows = await this.store.read<EntityRecord | undefined>(
      this.meta,
      storeUris,
    );

    const out: Output<T>[] = [];
    for (const row of rows) {
      // Output-tuple shape: `[storeUri, payload]`. `payload` is either
      // a leaf (an `EntityRecord` for fn=read; a `string[]` for
      // fn=ls&format=uris; a number for fn=count) or an inner
      // Output-array (fn=ls&format=full / fn=find&format=full).
      if (isOutputTuple(row)) {
        const [storeUri, storePayload] = row;
        // Nested Output-array (ls/find with format=full) — recurse
        // into each inner tuple so wire URIs and payloads come back
        // out of the mapper on both levels.
        if (isOutputArray(storePayload)) {
          const inner: Output<unknown>[] = [];
          for (const [innerStoreUri, innerRecord] of storePayload) {
            const innerBack = await this.mapper.fromStore(
              innerStoreUri,
              innerRecord as EntityRecord | undefined,
            );
            if (innerBack === null) continue;
            inner.push([innerBack.uri, innerBack.payload]);
          }
          // The outer URI is typically a prefix (`store://…/`) and the
          // mapper's URI mapping applies to it too. Callers only care
          // about the inner rows on this path but we still translate
          // for symmetry with the leaf branch.
          const outerBack = await this.mapper.fromStore(storeUri);
          if (outerBack === null) continue;
          out.push([outerBack.uri, inner as T]);
          continue;
        }
        // format=uris leaves the outer payload as `string[]` — inner
        // strings are store URIs we need to translate back.
        if (
          Array.isArray(storePayload) &&
          storePayload.every((x) => typeof x === "string")
        ) {
          const inner: string[] = [];
          for (const innerStoreUri of storePayload as string[]) {
            const innerBack = await this.mapper.fromStore(innerStoreUri);
            if (innerBack === null) continue;
            inner.push(innerBack.uri);
          }
          const outerBack = await this.mapper.fromStore(storeUri);
          if (outerBack === null) continue;
          out.push([outerBack.uri, inner as T]);
          continue;
        }
        // Leaf case: single-URI read.
        const back = await this.mapper.fromStore(
          storeUri,
          storePayload as EntityRecord | undefined,
        );
        if (back === null) continue;
        out.push([back.uri, back.payload as T]);
        continue;
      }
      // Bare-string result (rare — some ls implementations return
      // `string[]` at the top level instead of `[[prefix, uris]]`).
      if (typeof row === "string") {
        const back = await this.mapper.fromStore(row);
        if (back === null) continue;
        out.push([back.uri, undefined as T]);
        continue;
      }
      // Anything else (aggregate numbers, etc.) passes through.
      out.push(row as unknown as Output<T>);
    }
    return out;
  }

  status(): Promise<StatusResult> {
    return this.store.status();
  }
}
