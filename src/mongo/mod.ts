/**
 * MongoDB backend for b3nd.
 *
 * Store implementation backed by MongoDB. Requires an injected
 * `MongoExecutor` so the package does not depend on a specific MongoDB
 * driver. The executor is collection-agnostic: callers reach into a
 * specific collection via `executor.collection(name)`, so a single
 * MongoStore instance can host many entities side-by-side.
 */

export interface MongoFindManyOptions {
  sort?: Record<string, 1 | -1>;
  skip?: number;
  limit?: number;
  /** Mongo projection map (1 = include, 0 = exclude). */
  projection?: Record<string, 0 | 1>;
}

export interface MongoCollection {
  insertOne(doc: Record<string, unknown>): Promise<{ acknowledged?: boolean }>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<
    { matchedCount?: number; modifiedCount?: number; upsertedId?: unknown }
  >;
  findOne(
    filter: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
  findMany(
    filter: Record<string, unknown>,
    options?: MongoFindManyOptions,
  ): Promise<Record<string, unknown>[]>;
  countDocuments(filter: Record<string, unknown>): Promise<number>;
  deleteOne(
    filter: Record<string, unknown>,
  ): Promise<{ deletedCount?: number }>;
  /** Idempotent: re-running with the same spec is a no-op. */
  createIndex(spec: Record<string, 1 | -1>): Promise<void>;
}

export interface MongoExecutor {
  /** Hand out an ops handle for a specific collection. */
  collection(name: string): MongoCollection;
  /**
   * Materialise a collection on the server. Idempotent — re-running
   * for an existing collection is a no-op. Implementations should
   * swallow the driver's "namespace exists" error.
   */
  createCollection(name: string): Promise<void>;
  /** List collection names on the active database. */
  listCollectionNames(): Promise<string[]>;
  ping(): Promise<boolean>;
  cleanup?: () => Promise<void>;
}

export { MongoStore } from "./store.ts";
