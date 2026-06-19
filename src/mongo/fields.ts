/**
 * Schema field planning for MongoStore native entities.
 *
 * MongoDB collections are schemaless on the wire — Mongo will happily
 * store a document with any keys and any value types. So unlike
 * postgres/sqlite (which lean on column types for both shape pinning
 * and write-time validation), Mongo native entities lean on:
 *
 *  1. A per-field **canonical type tag** (first recognised `TYPE_TAGS`
 *     entry, declaration-order), folded into a deterministic signature
 *     so collision detection survives the schemaless medium.
 *  2. A per-entity **collection** with a stable name (`{prefix}_{entity}_data`).
 *  3. A separate **meta collection** (`{prefix}_meta`) where each
 *     provisioned entity gets one document `{ _id, signature }` — the
 *     store reads this on `entityStatus` and writes it on `provisionEntity`.
 *
 * Adapter notes (declared tag → BSON-ish behaviour):
 *
 *  - `string` / `timestamp` (stored as ISO-8601 TEXT) / `json` (stored
 *    inline as a sub-document or array) / `bigint` (stored as BSON
 *    Long if outside double precision; otherwise number) / `number` /
 *    `boolean` / `bytes` (stored as `Uint8Array` → BSON Binary).
 */

import { type EntityField, TYPE_TAGS } from "../entity.ts";
import { IDENTIFIER_PATTERN, isValidIdentifier } from "../identifiers.ts";

const KNOWN_TAGS: ReadonlySet<string> = new Set(Object.values(TYPE_TAGS));

export interface FieldPlan {
  /** Field name (also the document key). */
  name: string;
  /** Canonical tag (one of `TYPE_TAGS`). */
  tag: string;
}

export interface FieldPlanResult {
  fields: FieldPlan[];
  unsupported: { name: string; reason: string }[];
}

/**
 * Resolve a schema's fields into MongoStore field plans.
 *
 * Skips fields whose tags are all outside `TYPE_TAGS`; reports them
 * via `unsupported`. Rejects invalid field names up front so the
 * downstream signature is deterministic and the keys are safe.
 */
export function planFields(fields: EntityField[]): FieldPlanResult {
  const out: FieldPlan[] = [];
  const unsupported: { name: string; reason: string }[] = [];

  for (const field of fields) {
    if (!isValidIdentifier(field.name)) {
      unsupported.push({
        name: field.name,
        reason:
          `field name must match ${IDENTIFIER_PATTERN.source}; got '${field.name}'`,
      });
      continue;
    }
    const tag = field.type.find((t) => KNOWN_TAGS.has(t));
    if (tag === undefined) {
      unsupported.push({
        name: field.name,
        reason: field.type.length === 0
          ? "field declares no type tags"
          : `no recognised tag in [${field.type.join(", ")}]`,
      });
      continue;
    }
    out.push({ name: field.name, tag });
  }
  return { fields: out, unsupported };
}

/**
 * Deterministic signature for collision detection. Same name + same
 * set of supported fields + same canonical tag per field → same string.
 * Mirrors the strictness MemoryStore committed to and SQL backends get
 * for free from column-type introspection.
 */
export function computeSignature(
  entityName: string,
  fields: readonly FieldPlan[],
): string {
  const sorted = [...fields].sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify({
    name: entityName,
    fields: sorted.map((f) => [f.name, f.tag]),
  });
}
