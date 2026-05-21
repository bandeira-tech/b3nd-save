/**
 * @module
 * Tests for `tellAndRead(opts)` — INV/READ-style content synchronization.
 *
 * Covers both sides of the bundle (outbound announcer, inbound puller)
 * in isolation, plus a two-node end-to-end demo proving announcements
 * stay small and full payloads flow only on demand.
 *
 * No `noSanitize` anywhere.
 */

/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import { MemoryStore } from "../src/memory/store.ts";
import { mapToBytes, SaveClient } from "../src/clients/save-client.ts";
import { BYTES_ENTITY } from "../src/entity.ts";
import { Rig } from "@bandeira-tech/b3nd-core/rig";
import { connection } from "@bandeira-tech/b3nd-core/rig";
import type {
  Message,
  ProtocolInterfaceNode,
} from "@bandeira-tech/b3nd-core/types";
import { network, peer, tellAndRead } from "@bandeira-tech/b3nd-core/network";
import type { Peer } from "@bandeira-tech/b3nd-core/network";
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

function recordingPeer(id: string): { peer: Peer; received: Message[] } {
  const received: Message[] = [];
  const client: ProtocolInterfaceNode = {
    receive: (msgs) => {
      received.push(...msgs);
      return Promise.resolve(msgs.map(() => ({ accepted: true })));
    },
    read: () => Promise.resolve([]),
    observe: async function* () {},
    status: () => Promise.resolve({ status: "healthy" as const }),
  };
  return { peer: peer(client, { id }), received };
}

async function until(
  cond: () => boolean | Promise<boolean>,
  budgetMs = 500,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── Outbound: announce transforms ─────────────────────────────────────

Deno.test("tellAndRead.outbound() with no announce behaves like flood", async () => {
  const a = recordingPeer("A");
  const b = recordingPeer("B");
  const sync = tellAndRead({});
  const npi = sync.outbound([a.peer, b.peer]);

  await npi.receive([["mutable://x/1", "hello"]]);
  assertEquals(a.received.length, 1);
  assertEquals(b.received.length, 1);
  assertEquals(a.received[0][0], "mutable://x/1");
});

Deno.test("tellAndRead.outbound() rewrites per-message announcements", async () => {
  const a = recordingPeer("A");
  const sync = tellAndRead({
    announce: (msgs) =>
      msgs.map(([uri]) => [`inv://${uri}`, { have: uri }] as Message),
  });
  const npi = sync.outbound([a.peer]);

  await npi.receive([
    ["hash://sha256/abc", { big: "payload" }],
  ]);
  assertEquals(a.received.length, 1);
  assertEquals(a.received[0][0], "inv://hash://sha256/abc");
  assertEquals(a.received[0][1], { have: "hash://sha256/abc" });
});

Deno.test("tellAndRead.outbound() supports compound announcements", async () => {
  const a = recordingPeer("A");
  const sync = tellAndRead({
    announce: (msgs) => [
      [`inv://batch`, { have: msgs.map((m) => m[0]) }] as Message,
    ],
  });
  const npi = sync.outbound([a.peer]);

  await npi.receive([
    ["hash://a", 1],
    ["hash://b", 2],
    ["hash://c", 3],
  ]);
  // Three outbound messages compressed into one announcement.
  assertEquals(a.received.length, 1);
  assertEquals(a.received[0][0], "inv://batch");
  assertEquals((a.received[0][1] as { have: string[] }).have, [
    "hash://a",
    "hash://b",
    "hash://c",
  ]);
});

Deno.test("tellAndRead.outbound() supports per-peer asymmetry (full to trusted, INV to others)", async () => {
  const trusted = recordingPeer("trusted-A");
  const untrusted = recordingPeer("B");
  const sync = tellAndRead({
    announce: (msgs, p) =>
      p.id.startsWith("trusted-")
        ? msgs
        : msgs.map(([uri]) => [`inv://${uri}`, { have: uri }] as Message),
  });
  const npi = sync.outbound([trusted.peer, untrusted.peer]);

  await npi.receive([["hash://x", { big: "payload" }]]);

  assertEquals(trusted.received[0][0], "hash://x");
  assertEquals(trusted.received[0][1], { big: "payload" });
  assertEquals(untrusted.received[0][0], "inv://hash://x");
});

Deno.test("tellAndRead.outbound() skips a peer when transform returns []", async () => {
  const a = recordingPeer("A");
  const b = recordingPeer("B");
  const sync = tellAndRead({
    announce: (msgs, p) => (p.id === "B" ? [] : msgs),
  });
  const npi = sync.outbound([a.peer, b.peer]);

  await npi.receive([["mutable://x/1", 1]]);
  assertEquals(a.received.length, 1);
  assertEquals(b.received.length, 0);
});

// ── Inbound: onAnnounce pulls via source.client.read ──────────────────

Deno.test("tellAndRead.inbound: null onAnnounce passes through", async () => {
  const sync = tellAndRead({}); // no onAnnounce
  const source = peer(mem(), { id: "A" });
  const ctx = { originId: "me", source };

  const events: (string | undefined)[] = [];
  for await (
    const out of sync.inbound.receive!(
      ["mutable://x/1", "bare"],
      source,
      ctx,
    )
  ) events.push(out[0]);
  assertEquals(events, ["mutable://x/1"]);
});

Deno.test("tellAndRead.inbound: onAnnounce pulls the URI and yields fetched content", async () => {
  const storeA = mem();
  await storeA.receive([["hash://x", { big: "fetched" }]]);

  const sync = tellAndRead({
    onAnnounce: (ev) => {
      if (ev[0]?.startsWith("inv://")) {
        return [(ev?.[1] as { have: string }).have];
      }
      return null;
    },
  });

  const source = peer(storeA, { id: "A" });
  const ctx = { originId: "me", source };

  const out: { uri?: string; data: unknown }[] = [];
  for await (
    const r of sync.inbound.receive!(
      ["inv://anything", { have: "hash://x" }],
      source,
      ctx,
    )
  ) out.push({ uri: r[0], data: r?.[1] });

  // The announcement does not pass through; the pulled payload does.
  assertEquals(out.length, 1);
  assertEquals(out[0].uri, "hash://x");
  assertEquals(out[0].data, { big: "fetched" });
});

Deno.test("tellAndRead.inbound: empty URI list consumes the announcement silently", async () => {
  const sync = tellAndRead({
    // "I already have it" — consume without pulling.
    onAnnounce: () => [],
  });

  const source = peer(mem(), { id: "A" });
  const ctx = { originId: "me", source };

  const out: unknown[] = [];
  for await (
    const r of sync.inbound.receive!(
      ["inv://anything", { have: "hash://x" }],
      source,
      ctx,
    )
  ) out.push(r);
  assertEquals(out, []);
});

Deno.test("tellAndRead.inbound: multi-URI announcement fans out pulls", async () => {
  const storeA = mem();
  await storeA.receive([
    ["hash://a", "A-data"],
    ["hash://b", "B-data"],
  ]);

  const sync = tellAndRead({
    onAnnounce: (ev) => {
      if (ev[0]?.startsWith("inv://")) {
        return (ev?.[1] as { have: string[] }).have;
      }
      return null;
    },
  });

  const source = peer(storeA, { id: "A" });
  const ctx = { originId: "me", source };

  const out: { uri?: string; data: unknown }[] = [];
  for await (
    const r of sync.inbound.receive!(
      ["inv://batch", { have: ["hash://a", "hash://b"] }],
      source,
      ctx,
    )
  ) out.push({ uri: r[0], data: r?.[1] });

  out.sort((x, y) => (x.uri ?? "").localeCompare(y.uri ?? ""));
  assertEquals(out, [
    { uri: "hash://a", data: "A-data" },
    { uri: "hash://b", data: "B-data" },
  ]);
});

Deno.test("tellAndRead.inbound: read miss on announcement yields nothing", async () => {
  const sync = tellAndRead({
    onAnnounce: () => ["hash://does-not-exist"],
  });

  const source = peer(mem(), { id: "A" }); // empty store
  const ctx = { originId: "me", source };

  const out: unknown[] = [];
  for await (
    const r of sync.inbound.receive!(
      ["inv://x", { have: "hash://x" }],
      source,
      ctx,
    )
  ) out.push(r);

  // The announcement does not pass through; the read returned no hits;
  // the rig gets nothing — as intended for an announcement we can't satisfy.
  assertEquals(out, []);
});

// ── End-to-end: A announces, B pulls via network() + connection() ────

Deno.test("tellAndRead round-trip: A announces hash content, B pulls on demand", async () => {
  // Two local nodes. A has a SaveClient store that holds the full
  // content. B runs a rig with tellAndRead wired up: its outbound
  // connection only announces, and its inbound network() pulls via
  // A's read() when it sees an announcement.
  const storeA = mem();

  // Seed A with the full content — the data plane lives on A's store.
  await storeA.receive([["hash://big", { bytes: "the full payload" }]]);

  const sync = tellAndRead({
    // Outbound: every hash:// payload becomes an announcement.
    announce: (msgs) =>
      msgs.map(([uri]) => [`inv://${uri}`, { have: uri }] as Message),
    // Inbound: announcements trigger a read of the announced URI.
    onAnnounce: (ev) => {
      if (ev[0]?.startsWith("inv://")) {
        return [(ev?.[1] as { have: string }).have];
      }
      return null;
    },
  });

  // B's rig observes A. When A publishes an announcement, B sees the
  // inv://... URI and pulls the hash:// content from A via read().
  const bLocal = mem();
  const _route125 = connection(bLocal, ["*"]);
  const rigB = new Rig({
    routes: {
      receive: [_route125],
      read: [_route125],
    },
  });
  const unbind = network(rigB, [peer(storeA, { id: "A" })], [sync.inbound]);

  try {
    // A announces the content it holds. (In a real setup this would be
    // A's rig using `connection(sync.outbound(peersOfA), patterns)`;
    // here we publish the announcement directly for test focus.)
    await storeA.receive([["inv://hash://big", { have: "hash://big" }]]);

    // Poll until B's local store has the pulled content.
    await until(async () => {
      const [r] = await bLocal.read(["hash://big"]);
      return r?.[1] !== undefined;
    });
    const [r] = await bLocal.read(["hash://big"]);
    assertEquals(r?.[1], { bytes: "the full payload" });

    // And the announcement URI never reached B's local store — it was
    // consumed by the policy.
    const [invLanded] = await bLocal.read(["inv://hash://big"]);
    assertEquals(invLanded?.[1], undefined);
  } finally {
    await unbind();
  }
});
