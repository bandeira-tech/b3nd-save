/**
 * PostgreSQL backend for b3nd.
 *
 * `EntityStore` implementation backed by PostgreSQL. Requires an
 * injected `SqlExecutor` so the SDK does not depend on a specific
 * Postgres driver. Tables are provisioned lazily via `ensureEntity` —
 * no separate schema-bootstrap step.
 */

export interface SqlExecutorResult {
  rows: unknown[];
  rowCount?: number;
}

export interface SqlExecutor {
  query: (sql: string, args?: unknown[]) => Promise<SqlExecutorResult>;
  transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;
  cleanup?: () => Promise<void>;
}

export { PostgresStore } from "./store.ts";
