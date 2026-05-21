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
 * - **mapper** — a {@link SaveMapper}: freeform projection from the
 *   wire payload `TIn` to an `EntityRecord` matching `entity`. Runs
 *   per write entry; throwing produces a per-entry `ReceiveResult`
 *   failure. {@link mapToBytes} and {@link passThroughRecord} cover
 *   the common cases.
 * - **entity** — the {@link EntitySchema} this client routes. Use
 *   {@link BYTES_ENTITY} for opaque-bytes wires.
 * - **store** — any {@link EntityStore}. Every backend in this
 *   package implements it.
 *
 * ## Lifecycle
 *
 * SaveClient owns the per-target `EntityMeta` for its store. Call
 * `provision()` once to materialise the target on the store and
 * memoize the meta; thereafter `receive`/`read` reuse it. If
 * `provision()` is not called, `receive`/`read` still derive the
 * meta inline (cheap, pure) — if the target is not live on the
 * store, the underlying backend surfaces its natural failure
 * (storage error for write/delete, throw for read).
 *
 * Wire shape: a `receive` message is `Output<TIn | null>` —
 * `[uri, payload]` where `payload === null` is the delete-by-convention.
 * Reads come back as the stored records (or raw bytes when `entity`
 * is `BYTES_ENTITY`); the mapper is receive-only.
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
import {
  BYTES_ENTITY,
  type EntityMeta,
  type EntityRecord,
  type EntitySchema,
  type EntitySupport,
} from "../entity.ts";
import type { StorePayload } from "../types.ts";

/**
 * Freeform projection from wire payload → `EntityRecord` for the
 * target schema. Runs per write entry inside `SaveClient.receive`.
 * Throwing produces a `ReceiveResult` failure for that entry; the
 * rest of the batch is unaffected.
 */
export type SaveMapper<TIn = unknown> = (
  uri: string,
  payload: TIn,
) => EntityRecord | Promise<EntityRecord>;

/**
 * Built-in mapper that wraps a byte payload as a `BYTES_ENTITY`
 * record (`{ payload: bytes }`). Use with `target: BYTES_ENTITY` when
 * the wire is already opaque bytes.
 */
export const mapToBytes: SaveMapper<StorePayload> = (_uri, payload) => ({
  payload,
});

/**
 * Built-in mapper that passes the wire payload through as-is,
 * assuming it already matches the target schema. Use when the
 * protocol upstream has already produced a valid `EntityRecord`.
 */
export const passThroughRecord: SaveMapper<EntityRecord> = (_uri, payload) =>
  payload;

/**
 * Unwrap `BYTES_ENTITY` read results back to bytes-on-the-wire.
 *
 * The store returns:
 * - `fn=read`: a single `EntityRecord` (or `undefined` for a miss).
 * - `fn=ls&format=full`: `Output<EntityRecord | undefined>[]`.
 * - `fn=ls&format=uris`: `string[]`.
 * - `fn=count`: `number`.
 *
 * Record-shaped payloads carry `{ payload: bytes }`; we surface the
 * inner bytes. Other shapes pass through unchanged.
 */
function unwrapBytes(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) {
    return value.map((row) => {
      if (Array.isArray(row) && row.length === 2) {
        const [childUri, childPayload] = row as [string, unknown];
        return [childUri, unwrapBytes(childPayload)];
      }
      return row;
    });
  }
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if ("payload" in rec) return rec.payload;
  }
  return value;
}

export class SaveClient<TIn = unknown> extends ObserveEmitter
  implements ProtocolInterfaceNode {
  readonly mapper: SaveMapper<TIn>;
  readonly target: EntitySchema;
  readonly store: EntityStore;
  private _meta: EntityMeta | null = null;

  constructor(
    mapper: SaveMapper<TIn>,
    target: EntitySchema,
    store: EntityStore,
  ) {
    super();
    this.mapper = mapper;
    this.target = target;
    this.store = store;
  }

  /**
   * Materialise the target on the backing store and memoize the
   * resulting `EntityMeta`. Idempotent. Returns the {@link
   * EntitySupport} report so callers can see which fields the
   * medium accepted.
   */
  async provision(): Promise<EntitySupport> {
    if (!this._meta) this._meta = this.store.entitySupport(this.target);
    await this.store.provisionEntity(this._meta);
    return this._meta.support;
  }

  /** Resolve the meta — memoized from `provision()` or derived inline. */
  private _resolveMeta(): EntityMeta {
    if (this._meta) return this._meta;
    return this.store.entitySupport(this.target);
  }

  async receive(
    msgs: Output<TIn | null>[],
  ): Promise<ReceiveResult[]> {
    const meta = this._resolveMeta();

    const results: ReceiveResult[] = new Array(msgs.length);
    const writes: {
      uri: string;
      record: EntityRecord;
      wire: TIn;
      index: number;
    }[] = [];
    const deletes: { uri: string; index: number }[] = [];

    for (let i = 0; i < msgs.length; i++) {
      const [uri, payload] = msgs[i];
      if (!uri || typeof uri !== "string") {
        results[i] = { accepted: false, error: "URI is required" };
        continue;
      }
      if (payload === null) {
        deletes.push({ uri, index: i });
        continue;
      }
      try {
        const record = await this.mapper(uri, payload as TIn);
        writes.push({ uri, record, wire: payload as TIn, index: i });
      } catch (e) {
        results[i] = {
          accepted: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    if (writes.length > 0) {
      const writeResults = await this.store.write(
        meta,
        writes.map(({ uri, record }) => ({ uri, record })),
      );
      for (let j = 0; j < writeResults.length; j++) {
        const w = writes[j];
        const r = writeResults[j];
        results[w.index] = { accepted: r.success, error: r.error };
        if (r.success) this._emit(w.uri, w.wire);
      }
    }

    if (deletes.length > 0) {
      const delResults = await this.store.delete(
        meta,
        deletes.map((d) => d.uri),
      );
      const deletedUris: string[] = [];
      for (let j = 0; j < delResults.length; j++) {
        const d = deletes[j];
        const r = delResults[j];
        results[d.index] = { accepted: r.success, error: r.error };
        if (r.success) deletedUris.push(d.uri);
      }
      if (deletedUris.length > 0) this._emitDeletes(deletedUris);
    }

    return results;
  }

  async read<T = EntityRecord | StorePayload | undefined>(
    urls: string[],
  ): Promise<Output<T>[]> {
    const meta = this._resolveMeta();
    const isBytes = this.target.name === BYTES_ENTITY.name;

    const rows = await this.store.read<EntityRecord | undefined>(meta, urls);

    if (!isBytes) return rows as unknown as Output<T>[];
    return rows.map(([uri, payload]) => [uri, unwrapBytes(payload) as T]);
  }

  status(): Promise<StatusResult> {
    return this.store.status();
  }
}
