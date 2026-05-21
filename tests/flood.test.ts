/**
 * @module
 * Tests for `flood(peers)` — the baseline remote-client PIN factory.
 *
 * Covers the four-method surface (receive, read, observe, status) plus
 * the peer-list validation it inherits from `validatePeers`.
 */

/// <reference lib="deno.ns" />

import { assertEquals, assertRejects } from "@std/assert";
import { MemoryStore } from "../src/memory/store.ts";
import { mapToBytes, SaveClient } from "../src/clients/save-client.ts";
import { BYTES_ENTITY } from "../src/entity.ts";
import type {
  ProtocolInterfaceNode,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { flood } from "@bandeira-tech/b3nd-core/network";
import { peer } from "@bandeira-tech/b3nd-core/network";
import { JsonClient } from "./helpers/json-client.ts";

function mem(): ProtocolInterfaceNode {
  const store = new MemoryStore();
  // MemoryStore.provisionEntity has no `await`s — the bucket is created
  // synchronously before the returned Promise is constructed, so the test
  // can keep using a sync factory.
  void store.provisionEntity(store.entitySupport(BYTES_ENTITY));
  return new JsonClient(
    new SaveClient(mapToBytes, BYTES_ENTITY, store),
  );
}

// ── validation ──────────────────────────────────────────────────────

Deno.test("flood rejects empty peer list", () => {
  let threw = false;
  try {
    flood([]);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected empty peers to throw");
});

Deno.test("flood rejects duplicate peer ids", () => {
  let threw = false;
  try {
    flood([peer(mem(), { id: "X" }), peer(mem(), { id: "X" })]);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected duplicate ids to throw");
});

// ── shape ───────────────────────────────────────────────────────────

Deno.test("flood returns a plain ProtocolInterfaceNode", () => {
  const npi = flood([peer(mem(), { id: "A" })]);
  assertEquals(typeof npi.receive, "function");
  assertEquals(typeof npi.read, "function");
  assertEquals(typeof npi.observe, "function");
  assertEquals(typeof npi.status, "function");
});

// ── receive — fan-out ───────────────────────────────────────────────

Deno.test("flood.receive fans out to every peer", async () => {
  const a = mem();
  const b = mem();
  const npi = flood([peer(a, { id: "A" }), peer(b, { id: "B" })]);

  const results = await npi.receive([["mutable://shared/x", "hello"]]);
  assertEquals(results, [{ accepted: true }]);

  const ra = await a.read(["mutable://shared/x"]);
  const rb = await b.read(["mutable://shared/x"]);
  assertEquals(ra[0]?.[1], "hello");
  assertEquals(rb[0]?.[1], "hello");
});

Deno.test("flood.receive propagates transport errors", async () => {
  const broken: ProtocolInterfaceNode = {
    receive: () => Promise.reject(new Error("peer offline")),
    read: () => Promise.resolve([]),
    observe: async function* () {},
    status: () => Promise.resolve({ status: "unhealthy" } as StatusResult),
  };
  const npi = flood([peer(broken, { id: "X" })]);
  await assertRejects(
    () => npi.receive([["mutable://x", 1]]),
    Error,
    "peer offline",
  );
});

// ── read — first-match ──────────────────────────────────────────────

Deno.test("flood.read tries peers in order and returns the first hit", async () => {
  const a = mem();
  const b = mem();
  await b.receive([["mutable://only/on/b", "B-has-it"]]);
  const npi = flood([peer(a, { id: "A" }), peer(b, { id: "B" })]);

  const results = await npi.read(["mutable://only/on/b"]);
  assertEquals(results[0]?.[1], "B-has-it");
});

Deno.test("flood.read falls through failing peers", async () => {
  const broken: ProtocolInterfaceNode = {
    receive: (m) => Promise.resolve(m.map(() => ({ accepted: true }))),
    read: () => Promise.reject(new Error("broken")),
    observe: async function* () {},
    status: () => Promise.resolve({ status: "unhealthy" } as StatusResult),
  };
  const good = mem();
  await good.receive([["mutable://z", "ok"]]);
  const npi = flood([peer(broken, { id: "X" }), peer(good, { id: "Y" })]);

  const results = await npi.read(["mutable://z"]);
  assertEquals(results[0]?.[1], "ok");
});

Deno.test("flood.read returns not-found when no peer has it", async () => {
  const npi = flood([peer(mem(), { id: "A" }), peer(mem(), { id: "B" })]);
  await npi.read(["mutable://nope"]);
});

// ── observe — merged stream ─────────────────────────────────────────

Deno.test("flood.observe merges writes from every peer", async () => {
  const a = mem();
  const b = mem();
  const npi = flood([peer(a, { id: "A" }), peer(b, { id: "B" })]);

  const ac = new AbortController();
  const seen: string[] = [];
  const done = (async () => {
    for await (
      const [, uris] of npi.observe(["mutable://shared/*"], ac.signal)
    ) {
      seen.push(...uris);
      if (seen.length >= 2) ac.abort();
    }
  })();

  await new Promise((r) => setTimeout(r, 10));
  await a.receive([["mutable://shared/a-write", 1]]);
  await b.receive([["mutable://shared/b-write", 2]]);

  await done;
  seen.sort();
  assertEquals(seen, ["mutable://shared/a-write", "mutable://shared/b-write"]);
});

Deno.test("flood.observe unwinds cleanly on abort", async () => {
  const npi = flood([peer(mem(), { id: "A" })]);

  const ac = new AbortController();
  const done = (async () => {
    const seen: string[] = [];
    for await (const _ of npi.observe(["mutable://x/*"], ac.signal)) {
      seen.push("yielded");
    }
    return seen;
  })();

  await new Promise((r) => setTimeout(r, 5));
  ac.abort();
  const result = await done;
  assertEquals(result, []);
});

// ── status — aggregated ─────────────────────────────────────────────

Deno.test("flood.status reports healthy when all peers are healthy", async () => {
  const npi = flood([peer(mem(), { id: "A" }), peer(mem(), { id: "B" })]);
  const s = await npi.status();
  assertEquals(s.status, "healthy");
  assertEquals(s.details?.peerCount, 2);
  assertEquals(s.details?.healthyPeers, 2);
});

Deno.test("flood.status reports degraded when a peer is unhealthy", async () => {
  const sick: ProtocolInterfaceNode = {
    receive: (m) => Promise.resolve(m.map(() => ({ accepted: true }))),
    read: () => Promise.resolve([]),
    observe: async function* () {},
    status: () => Promise.resolve({ status: "unhealthy" }),
  };
  const npi = flood([peer(mem(), { id: "A" }), peer(sick, { id: "B" })]);
  const s = await npi.status();
  assertEquals(s.status, "degraded");
  assertEquals(s.details?.healthyPeers, 1);
});

Deno.test("flood.status reports unhealthy when every peer is unhealthy", async () => {
  const sick = (): ProtocolInterfaceNode => ({
    receive: (m) => Promise.resolve(m.map(() => ({ accepted: true }))),
    read: () => Promise.resolve([]),
    observe: async function* () {},
    status: () => Promise.resolve({ status: "unhealthy" }),
  });
  const npi = flood([peer(sick(), { id: "A" }), peer(sick(), { id: "B" })]);
  const s = await npi.status();
  assertEquals(s.status, "unhealthy");
});
