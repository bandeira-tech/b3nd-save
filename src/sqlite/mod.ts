/**
 * SQLite backend for b3nd.
 *
 * Store implementation backed by SQLite. Requires an injected SqliteExecutor
 * so the SDK does not depend on a specific SQLite driver.
 */

export interface SqliteExecutorResult {
  rows: Record<string, unknown>[];
  rowCount?: number;
}

export interface SqliteExecutor {
  query: (sql: string, args?: unknown[]) => SqliteExecutorResult;
  transaction: <T>(fn: (tx: SqliteExecutor) => T) => T;
  cleanup?: () => void;
}

export { SqliteStore } from "./store.ts";
