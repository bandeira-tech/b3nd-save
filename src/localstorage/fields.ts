/**
 * TYPE_TAGS recognition + JSON record encoding for LocalStorage entities.
 *
 * localStorage values are strings, so non-string-friendly values
 * (`Uint8Array`, `BigInt`, `Date`) need a canonical JSON encoding.
 * The encoding here matches the s3/fs/ipfs JSON layer so a record
 * round-trips cleanly across stores that use the same scheme.
 */

import { decodeBase64, encodeBase64 } from "@bandeira-tech/b3nd-core";
import { type EntityField, type EntityRecord, TYPE_TAGS } from "../entity.ts";

const KNOWN = new Set<string>(Object.values(TYPE_TAGS));
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export interface FieldPlan {
  name: string;
  tag: string;
}

export interface FieldPlanResult {
  fields: FieldPlan[];
  unsupported: { name: string; reason: string }[];
}

export function planFields(fields: EntityField[]): FieldPlanResult {
  const out: FieldPlan[] = [];
  const unsupported: { name: string; reason: string }[] = [];

  for (const f of fields) {
    if (!FIELD_NAME.test(f.name)) {
      unsupported.push({
        name: f.name,
        reason: `field name must match ${FIELD_NAME.source}; got '${f.name}'`,
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
 * canonical tag. Bytes → base64; bigint → string; timestamp → ISO-8601;
 * everything else passes through unchanged.
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
