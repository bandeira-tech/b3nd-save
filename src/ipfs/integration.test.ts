/**
 * IpfsStore Integration Tests
 *
 * Runs the shared store suite against a real Kubo IPFS node.
 * Requires a running Kubo instance — see CI workflow or:
 *   cd /Users/m0/ws/b3nd && make up p=test
 *
 * Env: IPFS_API_URL (default: http://localhost:55001)
 */

/// <reference lib="deno.ns" />

import { runSharedStoreSuite } from "../../tests/runners/shared-store-suite.ts";
import { IpfsStore } from "./store.ts";
import type { IpfsExecutor } from "./mod.ts";
import type { StorePayload } from "../types.ts";

const IPFS_API_URL = Deno.env.get("IPFS_API_URL") ??
  "http://localhost:55001";

function createIpfsExecutor(): IpfsExecutor {
  const base = IPFS_API_URL.replace(/\/+$/, "");

  return {
    async add(content: StorePayload): Promise<string> {
      // The IPFS `add` HTTP endpoint takes multipart form data. Both
      // bytes and streams collapse into a `Blob` body chunk; the
      // `Blob` constructor accepts either as a BlobPart, so this stays
      // streaming-friendly when the caller provides a stream.
      const form = new FormData();
      const blob = content instanceof ReadableStream
        ? await new Response(content).blob()
        : new Blob([content as BlobPart], {
          type: "application/octet-stream",
        });
      form.append("file", blob);

      const res = await fetch(`${base}/api/v0/add?pin=false&quiet=true`, {
        method: "POST",
        body: form,
      });

      if (!res.ok) {
        throw new Error(`IPFS add failed: ${res.status} ${await res.text()}`);
      }

      const json = await res.json();
      return json.Hash;
    },

    async cat(cid: string): Promise<ReadableStream<Uint8Array>> {
      const res = await fetch(
        `${base}/api/v0/cat?arg=${encodeURIComponent(cid)}`,
        { method: "POST" },
      );

      if (!res.ok) {
        throw new Error(`IPFS cat failed: ${res.status} ${await res.text()}`);
      }

      if (!res.body) {
        throw new Error("IPFS cat returned empty response body");
      }
      return res.body;
    },

    async pin(cid: string): Promise<void> {
      const res = await fetch(
        `${base}/api/v0/pin/add?arg=${encodeURIComponent(cid)}`,
        { method: "POST" },
      );

      if (!res.ok) {
        throw new Error(`IPFS pin failed: ${res.status} ${await res.text()}`);
      }
      await res.text();
    },

    async unpin(cid: string): Promise<void> {
      const res = await fetch(
        `${base}/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`,
        { method: "POST" },
      );

      if (!res.ok) {
        const body = await res.text();
        if (!body.includes("not pinned")) {
          throw new Error(`IPFS unpin failed: ${res.status} ${body}`);
        }
      } else {
        await res.text();
      }
    },

    async listPins(): Promise<string[]> {
      const res = await fetch(`${base}/api/v0/pin/ls?type=recursive`, {
        method: "POST",
      });

      if (!res.ok) {
        throw new Error(
          `IPFS pin ls failed: ${res.status} ${await res.text()}`,
        );
      }

      const json = await res.json();
      return Object.keys(json.Keys || {});
    },

    async isOnline(): Promise<boolean> {
      try {
        const res = await fetch(`${base}/api/v0/id`, { method: "POST" });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}

runSharedStoreSuite("IpfsStore (integration)", {
  create: () => {
    const executor = createIpfsExecutor();
    return new IpfsStore(executor);
  },
  supportsFind: true,
});
