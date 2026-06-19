/**
 * Shared TYPE_TAGS planning + JSON record encoding used by backends
 * that store custom-entity records as JSON-encoded bytes.
 *
 * The fs / s3 / ipfs / localstorage / elasticsearch backends all
 * serialise records the same way:
 *
 * - bytes      → base64 string
 * - bigint     → decimal string
 * - timestamp  → ISO-8601 string
 * - everything else passes through unchanged (`number`, `boolean`,
 *   `string`, `json` objects).
 *
 * Centralising the encoder/decoder here keeps the round-trip
 * guarantee — write on one JSON-encoding backend, read on another,
 * get the same `EntityRecord` shape back. Mongo (BSON-native) and
 * IndexedDB (structured-clone-native) preserve the typed values
 * without JSON encoding, so they don't use this module.
 *
 * `computeSignature` is the canonical collision-detection signature
 * over `{name, [field, tag] ...}` — two metas with identical names
 * + identical per-field canonical tags hash to the same string;
 * any shape difference (including a tag swap on an existing field
 * name) yields a different one. Matches the granularity SQL backends
 * get for free via column-type introspection.
 */

import { decodeBase64, encodeBase64 } from "@bandeira-tech/b3nd-core";
import { type EntityField, type EntityRecord, TYPE_TAGS } from "./entity.ts";
import { IDENTIFIER_PATTERN, isValidIdentifier } from "./identifiers.ts";

const KNOWN = new Set<string>(Object.values(TYPE_TAGS));

export interface FieldPlan {
  name: string;
  tag: string;
}

export interface FieldPlanResult {
  fields: FieldPlan[];
  unsupported: { name: string; reason: string }[];
}

/**
 * Walk a schema's fields, picking the first recognised TYPE_TAGS
 * entry per field as the canonical tag. Fields with no recognised
 * tag (or an invalid field name) are reported under `unsupported`.
 */
export function planFields(fields: EntityField[]): FieldPlanResult {
  const out: FieldPlan[] = [];
  const unsupported: { name: string; reason: string }[] = [];
  for (const f of fields) {
    if (!isValidIdentifier(f.name)) {
      unsupported.push({
        name: f.name,
        reason:
          `field name must match ${IDENTIFIER_PATTERN.source}; got '${f.name}'`,
      });
      continue;
    }
    const tag = f.type.find((t) => KNOWN.has(t));
    if (!tag) {
      unsupported.push({
        name: f.name,
        reason: f.type.length === 0
          ? "field declares no type tags"
          : `no recognised tag in [${f.type.join(", ")}]`,
      });
      continue;
    }
    out.push({ name: f.name, tag });
  }
  return { fields: out, unsupported };
}

/**
 * Encode a record into a JSON-serialisable shape using the per-field
 * canonical tag. Bytes → base64; bigint → string; timestamp →
 * ISO-8601; everything else passes through unchanged.
 */
export function encodeRecord(
  fields: readonly FieldPlan[],
  record: EntityRecord,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = record[f.name];
    if (v === undefined || v === null) {
      out[f.name] = null;
      continue;
    }
    if (f.tag === "bytes") out[f.name] = encodeBase64(v as Uint8Array);
    else if (f.tag === "bigint") {
      out[f.name] = typeof v === "bigint" ? v.toString() : String(v);
    } else if (f.tag === "timestamp") {
      out[f.name] = v instanceof Date
        ? v.toISOString()
        : new Date(v as string | number).toISOString();
    } else out[f.name] = v;
  }
  return out;
}

/** Inverse of `encodeRecord` — restores `Uint8Array`/`BigInt`/`Date`. */
export function decodeRecord(
  fields: readonly FieldPlan[],
  source: Record<string, unknown>,
): EntityRecord {
  const out: EntityRecord = {};
  for (const f of fields) {
    const v = source[f.name];
    if (v === null || v === undefined) {
      out[f.name] = undefined;
      continue;
    }
    if (f.tag === "bytes") out[f.name] = decodeBase64(v as string);
    else if (f.tag === "bigint") out[f.name] = BigInt(v as string);
    else if (f.tag === "timestamp") out[f.name] = new Date(v as string);
    else out[f.name] = v;
  }
  return out;
}

/**
 * Canonical signature over `{name, [field, tag] ...}` used by the
 * provisioning bookkeeping to detect same-name different-shape
 * collisions. Identical to Memory's signature scheme — a field whose
 * canonical tag flips counts as a collision even though the field
 * name is unchanged.
 */
export function computeSignature(
  name: string,
  fields: readonly FieldPlan[],
): string {
  const sorted = [...fields]
    .map((f) => [f.name, f.tag] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({ name, fields: sorted });
}
