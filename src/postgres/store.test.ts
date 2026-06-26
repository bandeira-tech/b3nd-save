/**
 * PostgresStore unit tests — runs the shared suite against an
 * in-memory mock executor that simulates Postgres BYTEA behavior.
 */

/// <reference lib="deno.ns" />

import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { PostgresStore } from "./store.ts";
import { BYTES_ENTITY } from "../entity.ts";
import type { SqlExecutor, SqlExecutorResult } from "./mod.ts";

/**
 * Translate a SQL LIKE body (with `%`/`_` wildcards and `\\` as the
 * declared escape char) into an anchored regex, for the mock to apply
 * the same pattern semantics that real Postgres would.
 */
function likeBodyToRegex(body: string): RegExp {
  let out = "^";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && i + 1 < body.length) {
      out += body[++i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
    } else if (ch === "%") out += ".*";
    else if (ch === "_") out += ".";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(out + "$");
}

/**
 * Evaluate a SQL `LIKE` test the way Postgres would, given a value, a
 * pattern body, and the declared escape char (`\\`). Faithful enough
 * that an injection-style prefix (`%` in the prefix) is treated the
 * same way the real engine would treat it — so the mock's behaviour
 * matches Postgres's when the prefix is pre-escaped via `escapeSqlLike`.
 */
function likeMatch(value: string, pattern: string): boolean {
  return likeBodyToRegex(pattern).test(value);
}

/**
 * Parse `WHERE …` text into a tiny AST of conjunctive LIKE / NOT LIKE
 * and `uri >/< $N` clauses. The store's SQL is structured enough that
 * a regex sweep over the conjuncts is honest — and it lets the mock
 * apply real LIKE-with-ESCAPE semantics on whatever args bind in.
 */
type Clause =
  | { kind: "like"; negate: boolean; pieces: string[] }
  | { kind: "cmp"; op: "<" | ">"; argIdx: number };
function parseClauses(sql: string): Clause[] {
  const whereIdx = sql.toUpperCase().indexOf("WHERE ");
  if (whereIdx < 0) return [];
  let tail = sql.slice(whereIdx + "WHERE ".length);
  // Strip everything from ORDER BY / LIMIT onward — those aren't
  // conjuncts.
  const stopRe = /\s+(?:ORDER\s+BY|LIMIT)\s+/i;
  const stop = tail.match(stopRe);
  if (stop && stop.index !== undefined) tail = tail.slice(0, stop.index);

  const clauses: Clause[] = [];
  for (const raw of tail.split(/\s+AND\s+/i)) {
    const text = raw.trim();
    const likeRe = /^uri\s+(NOT\s+)?LIKE\s+(.+?)(?:\s+ESCAPE\s+'\\')?$/i;
    const m = text.match(likeRe);
    if (m) {
      const negate = !!m[1];
      // `m[2]` is the concatenation expression, e.g. `$1 || '%'` or
      // `$1 || $2`. Split on `||` and trim each piece — pieces are
      // either `$N` placeholders or single-quoted literals.
      const pieces = m[2].split("||").map((p) => p.trim());
      clauses.push({ kind: "like", negate, pieces });
      continue;
    }
    const cmpRe = /^uri\s+([<>])\s+\$(\d+)$/i;
    const c = text.match(cmpRe);
    if (c) {
      clauses.push({
        kind: "cmp",
        op: c[1] as "<" | ">",
        argIdx: parseInt(c[2], 10) - 1,
      });
    }
  }
  return clauses;
}

function bindPiece(piece: string, args: unknown[]): string {
  const ph = piece.match(/^\$(\d+)$/);
  if (ph) return String(args[parseInt(ph[1], 10) - 1]);
  const lit = piece.match(/^'(.*)'$/);
  if (lit) return lit[1];
  throw new Error(`mock: cannot bind LIKE piece: ${piece}`);
}

function applyClauses(
  rows: { uri: string }[],
  clauses: Clause[],
  args: unknown[],
): { uri: string }[] {
  let out = rows;
  for (const c of clauses) {
    if (c.kind === "like") {
      const pattern = c.pieces.map((p) => bindPiece(p, args)).join("");
      out = out.filter((r) => {
        const hit = likeMatch(r.uri, pattern);
        return c.negate ? !hit : hit;
      });
    } else {
      const cursor = args[c.argIdx] as string;
      out = out.filter((r) =>
        c.op === "<"
          ? r.uri.localeCompare(cursor) < 0
          : r.uri.localeCompare(cursor) > 0
      );
    }
  }
  return out;
}

/**
 * In-memory SQL executor that simulates the subset of Postgres
 * behavior `PostgresStore` relies on. BYTEA columns round-trip as
 * Uint8Array. LIKE clauses are evaluated with full ESCAPE semantics
 * (so the injection-safety test exercises the real fix, not a mock
 * that happens to agree).
 */
function createMockSqlExecutor(): SqlExecutor {
  const data = new Map<string, { uri: string; payload: Uint8Array }>();
  const provisioned = new Set<string>();

  const executor: SqlExecutor = {
    query: (
      sql: string,
      args?: unknown[],
    ): Promise<SqlExecutorResult> => {
      const trimmed = sql.trim();
      const upper = trimmed.toUpperCase();

      // DDL — remember which tables exist so entityStatus reports live.
      if (upper.startsWith("CREATE")) {
        const m = trimmed.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
        if (m) provisioned.add(m[1]);
        return Promise.resolve({ rows: [] });
      }

      // entityStatus probe via information_schema.
      if (upper.includes("INFORMATION_SCHEMA.COLUMNS")) {
        const table = args![0] as string;
        if (!provisioned.has(table)) return Promise.resolve({ rows: [] });
        // BYTES_ENTITY's only user column is `payload BYTEA`.
        return Promise.resolve({
          rows: [{ column_name: "payload", data_type: "bytea" }],
        });
      }

      // Health
      if (upper === "SELECT 1") {
        return Promise.resolve({ rows: [{ "?column?": 1 }] });
      }

      // Upsert: INSERT INTO X (uri, payload) VALUES ($1, $2) ON CONFLICT ...
      if (upper.startsWith("INSERT")) {
        const uri = args![0] as string;
        const payload = args![1] as Uint8Array;
        data.set(uri, { uri, payload });
        return Promise.resolve({ rows: [], rowCount: 1 });
      }

      // Point read: SELECT payload FROM X WHERE uri = $1
      if (upper.startsWith("SELECT") && upper.includes("WHERE URI = $1")) {
        const uri = args![0] as string;
        const row = data.get(uri);
        if (!row) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [{ payload: row.payload }] });
      }

      // Count / ls / find all share the LIKE clause parser. Tell them
      // apart by the SELECT shape.
      if (upper.startsWith("SELECT")) {
        const clauses = parseClauses(trimmed);
        if (clauses.length === 0) return Promise.resolve({ rows: [] });

        let rows = applyClauses([...data.values()], clauses, args ?? []);

        // ORDER BY URI [DESC]
        const orderMatch = trimmed.match(/ORDER BY (\w+)(?:\s+(ASC|DESC))?/i);
        if (orderMatch) {
          const desc = (orderMatch[2] ?? "ASC").toUpperCase() === "DESC";
          // Only URI sort is exercised by the suite; non-URI sort would
          // need column-aware data — left unimplemented because the
          // mock doesn't store records.
          rows = [...rows].sort((a, b) =>
            desc ? b.uri.localeCompare(a.uri) : a.uri.localeCompare(b.uri)
          );
        }

        // LIMIT n OFFSET m — args at the tail.
        const limitMatch = trimmed.match(/LIMIT\s+\$(\d+)\s+OFFSET\s+\$(\d+)/i);
        if (limitMatch) {
          const limit = args![parseInt(limitMatch[1], 10) - 1] as number;
          const offset = args![parseInt(limitMatch[2], 10) - 1] as number;
          rows = rows.slice(offset, offset + limit);
        }

        if (upper.startsWith("SELECT COUNT(")) {
          return Promise.resolve({
            rows: [{ n: rows.length }],
          });
        }

        const selectsPayload = /SELECT\s+URI\s*,\s*"?PAYLOAD"?/i.test(trimmed);
        const fullRows = rows as Array<{ uri: string; payload?: Uint8Array }>;
        // Hydrate payloads from the data map (clauses preserve uri).
        return Promise.resolve({
          rows: fullRows.map((r) => {
            const stored = data.get(r.uri);
            return selectsPayload
              ? { uri: r.uri, payload: stored?.payload }
              : { uri: r.uri };
          }),
        });
      }

      // Delete
      if (upper.startsWith("DELETE")) {
        const uri = args![0] as string;
        data.delete(uri);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }

      return Promise.resolve({ rows: [] });
    },

    transaction: async <T>(
      fn: (tx: SqlExecutor) => Promise<T>,
    ): Promise<T> => {
      return await fn(executor);
    },
  };

  return executor;
}

runSharedStoreSuite("PostgresStore", {
  create: () => new PostgresStore("test", createMockSqlExecutor()),
  supportsFind: true,
});

import { assertEquals } from "jsr:@std/assert";

Deno.test("PostgresStore - atomicBatch: write rolls back on per-entry failure", async () => {
  // Executor that throws on the second INSERT to simulate a mid-batch
  // failure. The transaction wrapper should roll back and surface
  // failure for every entry in the batch.
  let inserts = 0;
  const executor: SqlExecutor = {
    query: (sql: string) => {
      const upper = sql.trim().toUpperCase();
      if (upper.startsWith("INSERT")) {
        inserts++;
        if (inserts === 2) throw new Error("boom on entry 2");
      }
      return Promise.resolve({ rows: [] });
    },
    transaction: async <T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> => {
      // Real Postgres would roll back; the mock just propagates the
      // throw — which is enough to verify the store's failure path.
      return await fn(executor);
    },
  };
  const store = new PostgresStore("test", executor);
  // entitySupport is pure — skip provisionEntity for this test since
  // the boom executor doesn't simulate information_schema lookups.
  const meta = store.entitySupport(BYTES_ENTITY);
  const results = await store.write(meta, [
    { uri: "store://a", record: { payload: new Uint8Array([1]) } },
    { uri: "store://b", record: { payload: new Uint8Array([2]) } },
    { uri: "store://c", record: { payload: new Uint8Array([3]) } },
  ]);
  assertEquals(results.length, 3);
  // All entries fail with the same error — that's the atomic contract.
  assertEquals(results.every((r) => !r.success), true);
  assertEquals(results.every((r) => r.error === "boom on entry 2"), true);
  // Structured error mirrors the string with a STORAGE_ERROR code.
  assertEquals(
    results.every((r) =>
      r.errorDetail?.code === "STORAGE_ERROR" &&
      r.errorDetail.message === "boom on entry 2"
    ),
    true,
  );
});

Deno.test("PostgresStore - empty batch returns empty results", async () => {
  const store = new PostgresStore("test", createMockSqlExecutor());
  const meta = store.entitySupport(BYTES_ENTITY);
  assertEquals(await store.write(meta, []), []);
  assertEquals(await store.delete(meta, []), []);
});

// ── Postgres-specific find / count / injection regression tests ─────

Deno.test("PostgresStore - fn=ls shallow regression: deep fixture, ls returns only direct children", async () => {
  const store = new PostgresStore("test", createMockSqlExecutor());
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "store://r/a", record: { payload: new Uint8Array([1]) } },
    { uri: "store://r/b", record: { payload: new Uint8Array([2]) } },
    { uri: "store://r/sub/c", record: { payload: new Uint8Array([3]) } },
    {
      uri: "store://r/sub/deep/d",
      record: { payload: new Uint8Array([4]) },
    },
  ]);
  const results = await store.read(meta, [
    "store://r/?fn=ls&format=uris&sortBy=uri",
  ]);
  // payload is the array, last entry is the cursor slot — but no limit
  // was set, so the slot is absent.
  assertEquals(results[0][1] as unknown, ["store://r/a", "store://r/b"]);
});

Deno.test("PostgresStore - fn=find returns deep descendants (pushDownFind drops shallow clause)", async () => {
  const store = new PostgresStore("test", createMockSqlExecutor());
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "store://r/a", record: { payload: new Uint8Array([1]) } },
    { uri: "store://r/sub/b", record: { payload: new Uint8Array([2]) } },
    {
      uri: "store://r/sub/deep/c",
      record: { payload: new Uint8Array([3]) },
    },
  ]);
  const results = await store.read(meta, [
    "store://r/**?fn=find&format=uris&sortBy=uri",
  ]);
  assertEquals(results[0][1] as unknown, [
    "store://r/a",
    "store://r/sub/b",
    "store://r/sub/deep/c",
  ]);
});

Deno.test("PostgresStore - pushDownCount: deep ?fn=count returns full descendant count in one query", async () => {
  // Wrap the mock executor to count how many SELECT COUNT(*) calls
  // happen — pushDownCount should mean exactly one for a deep count
  // (no walk-then-length fallback through find).
  const inner = createMockSqlExecutor();
  let countQueries = 0;
  let findLikeQueries = 0;
  const executor: SqlExecutor = {
    query: (sql: string, args?: unknown[]) => {
      if (sql.trim().toUpperCase().startsWith("SELECT COUNT(")) countQueries++;
      else if (
        sql.trim().toUpperCase().startsWith("SELECT URI") &&
        sql.includes("LIKE")
      ) findLikeQueries++;
      return inner.query(sql, args);
    },
    transaction: (fn) => inner.transaction(fn),
  };
  const store = new PostgresStore("test", executor);
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "store://r/a", record: { payload: new Uint8Array([1]) } },
    { uri: "store://r/sub/b", record: { payload: new Uint8Array([2]) } },
    {
      uri: "store://r/sub/deep/c",
      record: { payload: new Uint8Array([3]) },
    },
  ]);
  // reset after writes
  countQueries = 0;
  findLikeQueries = 0;
  const results = await store.read(meta, ["store://r/**?fn=count"]);
  assertEquals(results[0][1] as unknown, 3);
  // Exactly one COUNT(*) — no walk-via-find.
  assertEquals(countQueries, 1);
  assertEquals(findLikeQueries, 0);
});

Deno.test("PostgresStore - LIKE-injection safety: prefix containing % does not match siblings", async () => {
  // Pre-fix, a URI prefix containing `%` would broaden the LIKE pattern
  // and silently pull in siblings (e.g. `store://r/100%/` matching
  // `store://r/100x/...`). Post-fix, `escapeSqlLike` on every prefix
  // bind plus `ESCAPE '\\'` on every LIKE clause keeps `%` literal.
  const store = new PostgresStore("test", createMockSqlExecutor());
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  await store.write(meta, [
    // The "real" room with a literal `%` in the URI:
    { uri: "store://r/100%/a", record: { payload: new Uint8Array([1]) } },
    { uri: "store://r/100%/b", record: { payload: new Uint8Array([2]) } },
    // Sibling rooms that the wildcard would have matched pre-fix:
    { uri: "store://r/100x/sneak", record: { payload: new Uint8Array([3]) } },
    { uri: "store://r/100y/sneak", record: { payload: new Uint8Array([4]) } },
  ]);

  // ls under the `%`-containing prefix should return only that room's
  // direct children — never the `100x` / `100y` siblings.
  const ls = await store.read(meta, [
    "store://r/100%/?fn=ls&format=uris&sortBy=uri",
  ]);
  assertEquals(ls[0][1] as unknown, [
    "store://r/100%/a",
    "store://r/100%/b",
  ]);

  // count under the same prefix is likewise scoped.
  const count = await store.read(meta, ["store://r/100%/?fn=count"]);
  assertEquals(count[0][1] as unknown, 2);

  // find (deep walk) is scoped too — the deep variant drops the
  // shallow `NOT LIKE %/%` clause but the prefix LIKE still uses
  // ESCAPE so siblings stay out.
  const find = await store.read(meta, [
    "store://r/100%/**?fn=find&format=uris&sortBy=uri",
  ]);
  assertEquals(find[0][1] as unknown, [
    "store://r/100%/a",
    "store://r/100%/b",
  ]);
});

Deno.test("PostgresStore - LIKE-injection safety: prefix containing _ does not match single-char siblings", async () => {
  // Symmetric to the `%` case but with `_` (SQL LIKE's single-char
  // wildcard). Pre-fix, `store://r/100_/...` would match
  // `store://r/100x/...` because the `_` is interpreted as wildcard.
  const store = new PostgresStore("test", createMockSqlExecutor());
  const meta = store.entitySupport(BYTES_ENTITY);
  await store.provisionEntity(meta);
  await store.write(meta, [
    { uri: "store://r/100_/a", record: { payload: new Uint8Array([1]) } },
    { uri: "store://r/100x/sneak", record: { payload: new Uint8Array([2]) } },
  ]);
  const ls = await store.read(meta, [
    "store://r/100_/?fn=ls&format=uris&sortBy=uri",
  ]);
  assertEquals(ls[0][1] as unknown, ["store://r/100_/a"]);
});
