/**
 * Identifier-validation rule shared across backends.
 *
 * Entity names, table/collection prefixes, index prefixes, and field
 * names all follow the same constraint: start with an ASCII letter,
 * continue with letters / digits / underscores. The rule is the
 * intersection of what every supported backend accepts as a safe
 * identifier — SQL column names without quoting, Mongo collection
 * names, ES index names, IndexedDB key components, etc.
 *
 * Callers compose their own error messages with `IDENTIFIER_PATTERN`
 * (or `IDENTIFIER_PATTERN.source`) so the message can name the
 * specific kind of identifier being validated.
 */

export const IDENTIFIER_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** True if `name` is a safe identifier per the shared rule. */
export function isValidIdentifier(name: string): boolean {
  return IDENTIFIER_PATTERN.test(name);
}
