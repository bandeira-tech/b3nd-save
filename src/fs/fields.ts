/**
 * TYPE_TAGS recognition + JSON record encoding for FS entities.
 *
 * Files on disk are opaque bytes. Custom-entity records are encoded
 * as JSON (UTF-8 bytes) — the same canonical scheme used by
 * localstorage/s3/ipfs so a record round-trips cleanly across stores.
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

export function computeSignature(
  name: string,
  fields: readonly FieldPlan[],
): string {
  const sorted = [...fields]
    .map((f) => [f.name, f.tag] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({ name, fields: sorted });
}
