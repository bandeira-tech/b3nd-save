/**
 * TYPE_TAGS recognition for IndexedDB entity records.
 *
 * IndexedDB's structured clone preserves `Uint8Array`, `Date`, `BigInt`,
 * and plain JSON natively — records are stored verbatim. This module
 * exists to (a) report which fields the backend recognises in
 * `EntitySupport`, (b) drive the strict-validation check (extras
 * rejected) on write, (c) compute the canonical signature for
 * collision detection in `entityStatus`/`provisionEntity`.
 */

import { type EntityField, TYPE_TAGS } from "../entity.ts";
import { IDENTIFIER_PATTERN, isValidIdentifier } from "../identifiers.ts";

const KNOWN = new Set<string>(Object.values(TYPE_TAGS));

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
 * Canonical signature over `{name, [field, tag] ...}` used by the
 * provisioning bookkeeping to detect same-name different-shape
 * collisions. A field whose canonical tag flips counts as a collision
 * even though the field name is unchanged — matches the granularity
 * SQL backends get for free via column-type introspection.
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
