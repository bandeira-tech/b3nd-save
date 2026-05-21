/**
 * Byte-only EntityStore shim — shared transition helper.
 *
 * Wraps a backend's byte-shaped private operations (`_writeBytes`,
 * `_readBytes`, `_deleteBytes`) behind the `EntityStore` interface
 * while only `BYTES_ENTITY` is supported. The meta returned by
 * {@link bytesOnlyEntitySupport} carries the source schema so the
 * shim can detect any non-BYTES schema at op time and surface a
 * per-entry failure (or reject on `read`, which has no per-entry
 * error channel).
 *
 * Future per-backend PRs add native layouts for custom schemas; this
 * file goes away (or shrinks) once every backend can route any
 * schema natively.
 */

import type { DeleteResult, Output } from "@bandeira-tech/b3nd-core/types";
import { storageFailure } from "./errors.ts";
import {
  BYTES_ENTITY,
  type EntityMeta,
  type EntityRecord,
  type EntitySchema,
  type EntitySupport,
} from "./entity.ts";
import type { StoreEntry, StorePayload, StoreWriteResult } from "./types.ts";

export function isBytesEntity(schema: EntitySchema): boolean {
  return schema.name === BYTES_ENTITY.name;
}

/** EntityMeta produced by bytes-only backends. */
export interface BytesOnlyEntityMeta extends EntityMeta {
  readonly schema: EntitySchema;
  readonly isBytes: boolean;
}

/** EntitySupport for a backend that currently only honors BYTES_ENTITY. */
function bytesOnlySupport(schema: EntitySchema): EntitySupport {
  if (isBytesEntity(schema)) {
    return { entity: schema.name, supported: ["payload"], unsupported: [] };
  }
  return {
    entity: schema.name,
    supported: [],
    unsupported: schema.fields.map((f) => ({
      name: f.name,
      reason: "backend currently routes BYTES_ENTITY only",
    })),
  };
}

/** Compile a schema into the bytes-only meta. Pure. */
export function bytesOnlyEntitySupport(
  schema: EntitySchema,
): BytesOnlyEntityMeta {
  return {
    support: bytesOnlySupport(schema),
    schema,
    isBytes: isBytesEntity(schema),
  };
}

/**
 * Route a schema-aware write through the backend's byte path when
 * `meta` is for BYTES_ENTITY; otherwise return per-entry failures.
 */
export async function bytesOnlyWrite(
  meta: BytesOnlyEntityMeta,
  storeName: string,
  entries: { uri: string; record: EntityRecord }[],
  writeBytes: (entries: StoreEntry[]) => Promise<StoreWriteResult[]>,
): Promise<StoreWriteResult[]> {
  if (!meta.isBytes) {
    return entries.map((e) => ({
      success: false,
      ...storageFailure(
        new Error(
          `${storeName}: schema '${meta.schema.name}' not supported (BYTES_ENTITY only)`,
        ),
        "Unsupported schema",
        e.uri,
      ),
    }));
  }
  const byteEntries: StoreEntry[] = [];
  const failures: { index: number; result: StoreWriteResult }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const { uri, record } = entries[i];
    const payload = record.payload;
    if (
      !(payload instanceof Uint8Array) && !(payload instanceof ReadableStream)
    ) {
      failures.push({
        index: i,
        result: {
          success: false,
          ...storageFailure(
            new Error(
              `${storeName}: BYTES_ENTITY record.payload must be Uint8Array or ReadableStream`,
            ),
            "Invalid record",
            uri,
          ),
        },
      });
      continue;
    }
    byteEntries.push({ uri, payload: payload as StorePayload });
  }
  if (failures.length === entries.length) return failures.map((f) => f.result);
  const okResults = await writeBytes(byteEntries);
  // Re-interleave failures with the successful write results in input order.
  const out: StoreWriteResult[] = new Array(entries.length);
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < entries.length; i++) {
    if (failures[fail]?.index === i) out[i] = failures[fail++].result;
    else out[i] = okResults[ok++];
  }
  return out;
}

/**
 * Route a schema-aware read through the backend's byte path when
 * `meta` is for BYTES_ENTITY; otherwise reject. Read results are
 * re-wrapped as `{ payload: bytes }` records to match the `EntityStore`
 * read contract.
 */
export async function bytesOnlyRead<T = EntityRecord | undefined>(
  meta: BytesOnlyEntityMeta,
  storeName: string,
  urls: string[],
  readBytes: (urls: string[]) => Promise<Output<unknown>[]>,
): Promise<Output<T>[]> {
  if (!meta.isBytes) {
    throw new Error(
      `${storeName}: schema '${meta.schema.name}' not supported (BYTES_ENTITY only)`,
    );
  }
  const rows = await readBytes(urls);
  return rows.map(([uri, value]) => [uri, wrapAsRecord(value) as T]);
}

/**
 * Route a schema-aware delete through the backend's byte path when
 * `meta` is for BYTES_ENTITY; otherwise return per-entry failures.
 */
export function bytesOnlyDelete(
  meta: BytesOnlyEntityMeta,
  storeName: string,
  uris: string[],
  deleteBytes: (uris: string[]) => Promise<DeleteResult[]>,
): Promise<DeleteResult[]> {
  if (!meta.isBytes) {
    return Promise.resolve(uris.map((uri) => ({
      success: false,
      ...storageFailure(
        new Error(
          `${storeName}: schema '${meta.schema.name}' not supported (BYTES_ENTITY only)`,
        ),
        "Unsupported schema",
        uri,
      ),
    })));
  }
  return deleteBytes(uris);
}

/**
 * Wrap a byte read result back into a record-shaped payload.
 *
 * - Point read miss (`undefined`) → `undefined`.
 * - Point read bytes → `{ payload: bytes }`.
 * - `fn=ls&format=full` children (`Output<bytes>[]`) → each child's
 *    bytes payload wrapped the same way.
 * - `fn=ls&format=uris` (`string[]`) and `fn=count` (`number`) pass
 *    through unchanged.
 */
function wrapAsRecord(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (value instanceof Uint8Array || value instanceof ReadableStream) {
    return { payload: value };
  }
  if (Array.isArray(value)) {
    return value.map((row) => {
      if (Array.isArray(row) && row.length === 2) {
        const [u, v] = row as [string, unknown];
        return [u, wrapAsRecord(v)];
      }
      return row;
    });
  }
  return value;
}
