/**
 * ElasticsearchStore Integration Tests
 *
 * Runs the shared store suite against a real Elasticsearch cluster.
 * In CI the cluster is spun up as a service container. Locally:
 *   docker run -d --name es \
 *     -p 59200:9200 \
 *     -e discovery.type=single-node \
 *     -e xpack.security.enabled=false \
 *     -e ES_JAVA_OPTS="-Xms512m -Xmx512m" \
 *     elasticsearch:8.15.0
 *
 * Env: ES_ENDPOINT (default: http://localhost:59200)
 *
 * Test isolation: each test gets a unique `indexPrefix` so its indexes
 * don't collide with prior tests'. A final cleanup test deletes every
 * `inttest-*` index it can find so the cluster doesn't accumulate.
 */

/// <reference lib="deno.ns" />

import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { ElasticsearchStore } from "./store.ts";
import type {
  ElasticsearchExecutor,
  ElasticsearchSearchResult,
} from "./mod.ts";

const ES_ENDPOINT = Deno.env.get("ES_ENDPOINT") ??
  "http://localhost:59200";
const PREFIX_BASE = "inttest";

function createElasticsearchExecutor(): ElasticsearchExecutor {
  const base = ES_ENDPOINT.replace(/\/+$/, "");

  async function jsonRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return await fetch(`${base}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  return {
    async index(index, id, body) {
      // PUT /{index}/_doc/{id}?refresh=wait_for ensures the document
      // is visible to the next search — without refresh, the shared
      // suite's "write then ls" pattern races against the indexer.
      const res = await jsonRequest(
        "PUT",
        `/${encodeURIComponent(index)}/_doc/${
          encodeURIComponent(id)
        }?refresh=wait_for`,
        body,
      );
      if (!res.ok) {
        throw new Error(
          `ES index failed: ${res.status} ${await res.text()}`,
        );
      }
      await res.text();
    },

    async get(index, id) {
      const res = await jsonRequest(
        "GET",
        `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(id)}`,
      );
      if (res.status === 404) {
        await res.text();
        return null;
      }
      if (!res.ok) {
        throw new Error(
          `ES get failed: ${res.status} ${await res.text()}`,
        );
      }
      const json = await res.json() as {
        found: boolean;
        _source?: Record<string, unknown>;
      };
      return json.found ? (json._source ?? null) : null;
    },

    async search(index, body) {
      const res = await jsonRequest(
        "POST",
        `/${encodeURIComponent(index)}/_search`,
        body,
      );
      if (res.status === 404) {
        // Index doesn't exist yet — no hits.
        await res.text();
        return { hits: [] } as ElasticsearchSearchResult;
      }
      if (!res.ok) {
        throw new Error(
          `ES search failed: ${res.status} ${await res.text()}`,
        );
      }
      const json = await res.json() as {
        hits: {
          hits: Array<
            { _id: string; _source?: Record<string, unknown> }
          >;
        };
      };
      return { hits: json.hits.hits };
    },

    async count(index, body) {
      const res = await jsonRequest(
        "POST",
        `/${encodeURIComponent(index)}/_count`,
        body,
      );
      if (res.status === 404) {
        await res.text();
        return 0;
      }
      if (!res.ok) {
        throw new Error(
          `ES count failed: ${res.status} ${await res.text()}`,
        );
      }
      const json = await res.json() as { count: number };
      return json.count;
    },

    async delete(index, id) {
      const res = await jsonRequest(
        "DELETE",
        `/${encodeURIComponent(index)}/_doc/${
          encodeURIComponent(id)
        }?refresh=wait_for`,
      );
      // 404 is fine — deleting a missing doc/index is a no-op.
      if (!res.ok && res.status !== 404) {
        throw new Error(
          `ES delete failed: ${res.status} ${await res.text()}`,
        );
      }
      await res.text();
    },

    async ping() {
      try {
        const res = await fetch(`${base}/`, { method: "GET" });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}

let testCount = 0;
const runId = Date.now();

runSharedStoreSuite("ElasticsearchStore (integration)", {
  create: () =>
    new ElasticsearchStore(
      `${PREFIX_BASE}_${runId}_${++testCount}`,
      createElasticsearchExecutor(),
    ),
  supportsFind: true,
});

// Cleanup: drop every index this test run created. Uses a wildcard
// DELETE against the run-scoped prefix so we don't touch other runs.
Deno.test({
  name: "ElasticsearchStore (integration) - cleanup",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const base = ES_ENDPOINT.replace(/\/+$/, "");
    await fetch(
      `${base}/${PREFIX_BASE}_${runId}_*?ignore_unavailable=true`,
      { method: "DELETE" },
    ).catch(() => {});
  },
});
