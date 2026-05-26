/**
 * @module
 * Tests for `peer()` and `network(target, peers, policies?, opts?)` —
 * the participant verb.
 *
 * No `noSanitize` anywhere — Deno's op and resource sanitizers are
 * active on every test.
 */

/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import { Rig } from "@bandeira-tech/b3nd-core/rig";
import { connection } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  ProtocolInterfaceNode,
} from "@bandeira-tech/b3nd-core/types";
import { network, peer } from "@bandeira-tech/b3nd-core/network";
import type { Policy } from "@bandeira-tech/b3nd-core/network";
import { memClient as mem } from "./helpers/mem-client.ts";

/**
 * A test target that captures every receive() call. Used when a real Rig
 * would obscure which layer is doing the work.
 */
function capturingTarget() {
  const calls: Output[] = [];
  const target: ProtocolInterfaceNode = {
    receive: (msgs) => {
      calls.push(...msgs);
      return Promise.resolve(msgs.map(() => ({ accepted: true })));
    },
    read: () => Promise.resolve([]),
    observe: async function* () {},
    status: () => Promise.resolve({ status: "healthy" as const }),
  };
  return { target, calls };
}

async function until(
  cond: () => boolean | Promise<boolean>,
  { budgetMs = 500, stepMs = 5 } = {},
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!(await cond())) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${budgetMs}ms`);
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// ── peer() ────────────────────────────────────────────────────────────

Deno.test("peer() assigns a runtime id when none is supplied", async () => {
  const p1 = peer(await mem());
  const p2 = peer(await mem());
  if (!p1.id.startsWith("peer-")) throw new Error("auto id shape unexpected");
  if (p1.id === p2.id) throw new Error("auto ids must be unique");
});

Deno.test("peer() honors explicit id", async () => {
  const p = peer(await mem(), { id: "alice-pubkey" });
  assertEquals(p.id, "alice-pubkey");
});

Deno.test("peer() applies decorators in order", async () => {
  const calls: string[] = [];
  const deco = (name: string) =>
  (
    client: ProtocolInterfaceNode,
  ): ProtocolInterfaceNode => ({
    receive: (msgs) => {
      calls.push(name);
      return client.receive(msgs);
    },
    read: (u) => client.read(u),
    observe: (p, s) => client.observe(p, s),
    status: () => client.status(),
  });

  const p = peer(await mem(), { via: [deco("outer"), deco("inner")] });
  p.client.receive([["mutable://x/1", "v"]]);
  assertEquals(calls, ["inner", "outer"]);
});

// ── network() — validation ────────────────────────────────────────────

Deno.test("network() rejects empty peer list", async () => {
  const { target } = capturingTarget();
  let threw = false;
  try {
    network(target, []);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected empty peers to throw");
});

Deno.test("network() rejects duplicate peer ids", async () => {
  const { target } = capturingTarget();
  let threw = false;
  try {
    network(target, [
      peer(await mem(), { id: "X" }),
      peer(await mem(), { id: "X" }),
    ]);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected duplicate ids to throw");
});

// ── Bridge forwarding ─────────────────────────────────────────────────

Deno.test("network() forwards events from a single peer into target.receive", async () => {
  const a = await mem();
  const { target, calls } = capturingTarget();
  const unbind = network(target, [peer(a, { id: "A" })]);
  try {
    await a.receive([["mutable://x/1", "hello"]]);
    await until(() => calls.length >= 1);
    assertEquals(calls[0][0], "mutable://x/1");
    assertEquals(calls[0][1], "hello");
  } finally {
    await unbind();
  }
});

Deno.test("network() forwards from every peer in parallel", async () => {
  const a = await mem();
  const b = await mem();
  const { target, calls } = capturingTarget();
  const unbind = network(target, [peer(a, { id: "A" }), peer(b, { id: "B" })]);
  try {
    await a.receive([["mutable://x/a", 1]]);
    await b.receive([["mutable://x/b", 2]]);
    await until(() => calls.length >= 2);
    const uris = calls.map((c) => c[0]).sort();
    assertEquals(uris, ["mutable://x/a", "mutable://x/b"]);
  } finally {
    await unbind();
  }
});

// ── policy chain ──────────────────────────────────────────────────────

Deno.test("network() tags events with the source peer", async () => {
  const a = await mem();
  const b = await mem();
  const seen: { peerId: string; uri: string }[] = [];

  const policy: Policy = {
    async *receive(ev, source) {
      if (ev[0]) seen.push({ peerId: source.id, uri: ev[0] });
      yield ev;
    },
  };

  const { target, calls } = capturingTarget();
  const unbind = network(
    target,
    [peer(a, { id: "A" }), peer(b, { id: "B" })],
    [policy],
  );
  try {
    await a.receive([["mutable://x/1", 1]]);
    await b.receive([["mutable://x/2", 2]]);
    await until(() => calls.length >= 2);
    seen.sort((x, y) => x.uri.localeCompare(y.uri));
    assertEquals(seen, [
      { peerId: "A", uri: "mutable://x/1" },
      { peerId: "B", uri: "mutable://x/2" },
    ]);
  } finally {
    await unbind();
  }
});

Deno.test("network() chains multiple policies left-to-right on each event", async () => {
  const a = await mem();
  const uppercase: Policy = {
    async *receive(ev) {
      if (ev[0]) yield [ev[0].toUpperCase(), ev[1]];
    },
  };
  const wrap: Policy = {
    async *receive(ev) {
      if (ev[0]) yield [`w(${ev[0]})`, ev[1]];
    },
  };

  const { target, calls } = capturingTarget();
  const unbind = network(target, [peer(a, { id: "A" })], [uppercase, wrap]);
  try {
    await a.receive([["mutable://hello", 1]]);
    await until(() => calls.length >= 1);
    assertEquals(calls[0][0], "w(MUTABLE://HELLO)");
  } finally {
    await unbind();
  }
});

Deno.test("network() respects a policy that yields nothing (control-plane consumption)", async () => {
  const a = await mem();
  const policy: Policy = {
    async *receive(ev) {
      if (ev[0] && !ev[0].startsWith("data://")) return;
      yield ev;
    },
  };
  const { target, calls } = capturingTarget();
  const unbind = network(target, [peer(a, { id: "A" })], [policy]);
  try {
    await a.receive([["mutable://noise/1", "drop me"]]);
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(calls.length, 0);
  } finally {
    await unbind();
  }
});

Deno.test("network() forwards transformed events to target", async () => {
  const a = await mem();
  const policy: Policy = {
    async *receive(ev) {
      if (ev[0]) {
        yield [`wrapped://${ev[0]}`, { wrapped: ev[1] }];
      }
    },
  };
  const { target, calls } = capturingTarget();
  const unbind = network(target, [peer(a, { id: "A" })], [policy]);
  try {
    await a.receive([["mutable://raw/1", 42]]);
    await until(() => calls.length >= 1);
    assertEquals(calls[0][0], "wrapped://mutable://raw/1");
    assertEquals(calls[0][1], { wrapped: 42 });
  } finally {
    await unbind();
  }
});

Deno.test("network() exposes source.client.read for side-pulls", async () => {
  const a = await mem();
  await a.receive([["data://full/payload", { big: "content" }]]);

  const policy: Policy = {
    async *receive(ev, source) {
      if (ev[0]?.startsWith("inv://")) {
        const want = (ev?.[1] as { have: string }).have;
        const results = await source.client.read<unknown>([want]);
        for (const out of results) yield out;
        return;
      }
      yield ev;
    },
  };

  const { target, calls } = capturingTarget();
  const unbind = network(target, [peer(a, { id: "A" })], [policy]);
  try {
    await a.receive([["inv://1", { have: "data://full/payload" }]]);
    await until(() => calls.some((c) => c[0] === "data://full/payload"));
    const hit = calls.find((c) => c[0] === "data://full/payload");
    assertEquals(hit?.[1], { big: "content" });
  } finally {
    await unbind();
  }
});

// ── Policies carry their own dependencies ─────────────────────────────

Deno.test("policies carry their own data dependencies via closure", async () => {
  const a = await mem();
  const localStore = await mem();
  await localStore.receive([["mutable://known", "yes"]]);

  const policyWithStore = (store: typeof localStore): Policy => ({
    async *receive(ev) {
      const existing = await store.read<string>(["mutable://known"]);
      if (existing[0] && ev[0]) {
        yield [`wrapped://${ev[0]}`, existing[0][1]];
      }
    },
  });

  const { target, calls } = capturingTarget();
  const unbind = network(
    target,
    [peer(a, { id: "A" })],
    [policyWithStore(localStore)],
  );
  try {
    await a.receive([["trigger://1", 0]]);
    await until(() => calls.length >= 1);
    assertEquals(calls[0][0], "wrapped://trigger://1");
    assertEquals(calls[0][1], "yes");
  } finally {
    await unbind();
  }
});

// ── opts ──────────────────────────────────────────────────────────────

Deno.test("network() honors a narrowed observe pattern", async () => {
  const a = await mem();
  const { target, calls } = capturingTarget();
  const unbind = network(
    target,
    [peer(a, { id: "A" })],
    [],
    { pattern: "mutable://keep/:id" },
  );
  try {
    await a.receive([["mutable://keep/1", "match"]]);
    await a.receive([["mutable://drop/1", "skip"]]);
    await until(() => calls.length >= 1);
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(calls.length, 1);
    assertEquals(calls[0][0], "mutable://keep/1");
  } finally {
    await unbind();
  }
});

// ── error isolation ──────────────────────────────────────────────────

Deno.test("network() catches target.receive errors without stalling", async () => {
  const a = await mem();
  let count = 0;
  const errors: Error[] = [];
  const target: ProtocolInterfaceNode = {
    receive: () => {
      count++;
      if (count === 1) throw new Error("flaky");
      return Promise.resolve([{ accepted: true }]);
    },
    read: () => Promise.resolve([]),
    observe: async function* () {},
    status: () => Promise.resolve({ status: "healthy" as const }),
  };

  const unbind = network(
    target,
    [peer(a, { id: "A" })],
    [],
    { onError: (err) => errors.push(err) },
  );
  try {
    await a.receive([["mutable://x/1", 1]]);
    await a.receive([["mutable://x/2", 2]]);
    await until(() => count >= 2);
    assertEquals(errors.length, 1);
    assertEquals(errors[0].message, "flaky");
  } finally {
    await unbind();
  }
});

Deno.test("network() surfaces peer observe errors via onError", async () => {
  const errors: Error[] = [];
  const badPeer: ProtocolInterfaceNode = {
    receive: (m) => Promise.resolve(m.map(() => ({ accepted: true }))),
    read: () => Promise.resolve([]),
    // deno-lint-ignore require-yield
    observe: async function* () {
      throw new Error("observe broken");
    },
    status: () => Promise.resolve({ status: "unhealthy" as const }),
  };

  const { target } = capturingTarget();
  const unbind = network(
    target,
    [peer(badPeer, { id: "X" })],
    [],
    {
      onError: (err, ctx) =>
        errors.push(new Error(`${ctx.peerId}: ${err.message}`)),
    },
  );
  try {
    await until(() => errors.length >= 1);
    assertEquals(errors[0].message, "X: observe broken");
  } finally {
    await unbind();
  }
});

// ── teardown ──────────────────────────────────────────────────────────

Deno.test("unbind() stops forwarding and awaits peer loops", async () => {
  const a = await mem();
  const { target, calls } = capturingTarget();
  const unbind = network(target, [peer(a, { id: "A" })]);
  await a.receive([["mutable://pre/1", 1]]);
  await until(() => calls.length >= 1);

  await unbind();

  await a.receive([["mutable://post/1", 2]]);
  await new Promise((r) => setTimeout(r, 30));
  assertEquals(calls.length, 1);
});

Deno.test("unbind() is idempotent", async () => {
  const { target } = capturingTarget();
  const unbind = network(target, [peer(await mem(), { id: "A" })]);
  await unbind();
  await unbind(); // must not throw
});

// ── real Rig integration ──────────────────────────────────────────────

Deno.test("network() against a real Rig fires reactions on peer-originated writes", async () => {
  const a = await mem();
  const local = await mem();
  const reactionCalls: { uri: string; id: string }[] = [];

  const _route123 = connection(local, ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route123],
      read: [_route123],
    },
    reactions: {
      // deno-lint-ignore require-await
      "mutable://chat/:id": async (out, _read, params) => {
        reactionCalls.push({ uri: out[0], id: params.id });
        return [];
      },
    },
  });

  const unbind = network(rig, [peer(a, { id: "A" })]);
  try {
    await a.receive([["mutable://chat/42", "hello"]]);
    await until(() => reactionCalls.length >= 1);
    assertEquals(reactionCalls[0], { uri: "mutable://chat/42", id: "42" });
  } finally {
    await unbind();
  }
});

Deno.test("network() persists bridged writes through the rig pipeline", async () => {
  const a = await mem();
  const local = await mem();
  const _route124 = connection(local, ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route124],
      read: [_route124],
    },
  });

  const unbind = network(rig, [peer(a, { id: "A" })]);
  try {
    await a.receive([["mutable://k/1", { v: 1 }]]);
    await until(async () => {
      const r = await rig.read(["mutable://k/1"]);
      return r.length > 0;
    });
    const r = await rig.read(["mutable://k/1"]);
    assertEquals(r[0]?.[1], { v: 1 });
  } finally {
    await unbind();
  }
});
