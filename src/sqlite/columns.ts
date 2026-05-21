/**
 * TYPE_TAGS → SQLite column type mapping for native entity tables.
 *
 * Each canonical tag in `TYPE_TAGS` resolves to one declared column
 * type. SQLite is flexible about declared types — what matters here is
 * that `entityStatus` can compare what we declared against what
 * `pragma_table_info` returns, so two schemas that would store the
 * same value differently (e.g. `BIGINT` vs `BOOLEAN`, both integer
 * storage) report different shapes.
 *
 * A field carrying multiple tags (e.g. `["string", "email"]`) picks
 * the first recognised canonical tag in declaration order; extra
 * refinement tags pass through without affecting storage.
 */

import { type EntityField, TYPE_TAGS } from "../entity.ts";

const SQL_TYPE: Record<string, string> = {
  [TYPE_TAGS.STRING]: "TEXT",
  [TYPE_TAGS.NUMBER]: "REAL",
  [TYPE_TAGS.BIGINT]: "INTEGER",
  [TYPE_TAGS.BOOLEAN]: "BOOLEAN",
  [TYPE_TAGS.BYTES]: "BLOB",
  [TYPE_TAGS.TIMESTAMP]: "TIMESTAMP",
  [TYPE_TAGS.JSON]: "JSON",
};

const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export interface ColumnPlan {
  /** Field/column name. */
  name: string;
  /** Declared SQLite column type. */
  sqlType: string;
  /** The recognised tag that decided `sqlType` (for diagnostics). */
  tag: string;
}

export interface ColumnPlanResult {
  columns: ColumnPlan[];
  unsupported: { name: string; reason: string }[];
}

/**
 * Resolve a schema's fields into SQLite column plans.
 *
 * Skips fields whose tags are all outside `TYPE_TAGS`; reports them
 * via `unsupported`. Rejects invalid field names up front so we never
 * emit unsafe SQL identifiers.
 */
export function planColumns(fields: EntityField[]): ColumnPlanResult {
  const columns: ColumnPlan[] = [];
  const unsupported: { name: string; reason: string }[] = [];

  for (const field of fields) {
    if (!FIELD_NAME.test(field.name)) {
      unsupported.push({
        name: field.name,
        reason:
          `field name must match ${FIELD_NAME.source}; got '${field.name}'`,
      });
      continue;
    }
    const tag = field.type.find((t) => SQL_TYPE[t] !== undefined);
    if (!tag) {
      unsupported.push({
        name: field.name,
        reason: field.type.length === 0
          ? "field declares no type tags"
          : `no recognised tag in [${field.type.join(", ")}]`,
      });
      continue;
    }
    columns.push({ name: field.name, sqlType: SQL_TYPE[tag], tag });
  }
  return { columns, unsupported };
}
