/**
 * TYPE_TAGS → SQLite column type mapping for native entity tables.
 *
 * SQLite uses type affinity rather than strict types — a single field
 * picks the first recognized canonical tag in declaration order and
 * resolves to an affinity that matches Postgres's storage semantics
 * as closely as the medium allows.
 */

import { type EntityField, TYPE_TAGS } from "../entity.ts";

const SQL_TYPE: Record<string, string> = {
  [TYPE_TAGS.STRING]: "TEXT",
  [TYPE_TAGS.NUMBER]: "REAL",
  [TYPE_TAGS.BIGINT]: "INTEGER",
  [TYPE_TAGS.BOOLEAN]: "INTEGER",
  [TYPE_TAGS.BYTES]: "BLOB",
  [TYPE_TAGS.TIMESTAMP]: "TEXT",
  [TYPE_TAGS.JSON]: "TEXT",
};

const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export interface ColumnPlan {
  /** Field/column name. */
  name: string;
  /** SQLite SQL type (affinity). */
  sqlType: string;
  /** The recognized canonical tag — drives adapt-for-write/read. */
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
