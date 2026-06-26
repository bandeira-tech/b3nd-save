/**
 * S3Store Integration Tests
 *
 * Runs the shared store suite against a real MinIO S3 instance.
 * Requires a running MinIO with a pre-created public bucket.
 *
 * In CI, the bucket is created by the workflow via `mc`.
 * Locally: cd /Users/m0/ws/b3nd && make up p=test
 *
 * Env: S3_ENDPOINT (default: http://localhost:59000)
 */

/// <reference lib="deno.ns" />

import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { S3Store } from "./store.ts";
import type { S3Executor } from "./mod.ts";
import type { StorePayload } from "../types.ts";

const S3_ENDPOINT = Deno.env.get("S3_ENDPOINT") ??
  "http://localhost:59000";
const BUCKET = "b3nd-inttest";

function createS3Executor(): S3Executor {
  function url(key: string): string {
    return `${S3_ENDPOINT}/${BUCKET}/${key}`;
  }

  return {
    async putObject(
      key: string,
      body: StorePayload,
      contentType: string,
    ): Promise<void> {
      // Collect streams to bytes before the PUT. A streaming body to a
      // real S3-compatible endpoint needs sigv4 chunked signing (or
      // multipart upload); Deno's bare `fetch` also requires
      // `duplex: "half"` to send a stream body and S3 / MinIO won't
      // happily accept `Transfer-Encoding: chunked` without it. The
      // test executor stays bytes-only for the wire; the Store still
      // accepts the union and the buffering lives in the executor.
      const bytes = body instanceof Uint8Array
        ? body
        : new Uint8Array(await new Response(body).arrayBuffer());
      const res = await fetch(url(key), {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: bytes as BodyInit,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`S3 PUT failed: ${res.status} ${text}`);
      }
      await res.text();
    },

    async getObject(
      key: string,
    ): Promise<ReadableStream<Uint8Array> | null> {
      const res = await fetch(url(key), { method: "GET" });
      if (res.status === 404) {
        await res.text();
        return null;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`S3 GET failed: ${res.status} ${text}`);
      }
      // `res.body` is already a `ReadableStream<Uint8Array>` — return
      // it directly so large objects don't need to fit in memory.
      return res.body;
    },

    async deleteObject(key: string): Promise<void> {
      const res = await fetch(url(key), { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        const text = await res.text();
        throw new Error(`S3 DELETE failed: ${res.status} ${text}`);
      }
      await res.text();
    },

    async listObjects(prefix: string): Promise<string[]> {
      const params = new URLSearchParams({
        "list-type": "2",
        prefix,
      });
      const res = await fetch(
        `${S3_ENDPOINT}/${BUCKET}?${params.toString()}`,
        { method: "GET" },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`S3 LIST failed: ${res.status} ${text}`);
      }
      const xml = await res.text();
      const keys: string[] = [];
      const regex = /<Key>([^<]+)<\/Key>/g;
      let match;
      while ((match = regex.exec(xml)) !== null) {
        keys.push(match[1]);
      }
      return keys;
    },

    async headBucket(): Promise<boolean> {
      try {
        const res = await fetch(`${S3_ENDPOINT}/${BUCKET}`, {
          method: "HEAD",
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}

// Each test gets a unique key prefix so writes don't leak across the
// shared bucket. The bucket itself stays — fresh in CI per workflow
// run, and otherwise tolerant of leftover keys from prior runs.
let testCount = 0;

runSharedStoreSuite("S3Store (integration)", {
  create: () => {
    const executor = createS3Executor();
    const prefix = `inttest-${Date.now()}-${++testCount}/`;
    return new S3Store(BUCKET, executor, prefix);
  },
  supportsFind: true,
});
