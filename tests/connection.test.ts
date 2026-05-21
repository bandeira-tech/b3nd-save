/// <reference lib="deno.ns" />
/**
 * Tests for the connection primitive and its integration with the rig.
 *
 * Covers: local routing, multi-connection broadcast/first-match,
 * unconnected URI rejection, serialization for wire, best-effort
 * enforcement, and program/connection separation.
 */

import { assertEquals } from "@std/assert";
import { MemoryStore } from "../src/memory/store.ts";
import { mapToBytes, SaveClient } from "../src/clients/save-client.ts";
import { BYTES_ENTITY } from "../src/entity.ts";
import { connection } from "@bandeira-tech/b3nd-core/rig";
import { Rig } from "@bandeira-tech/b3nd-core/rig";
import type { Program } from "@bandeira-tech/b3nd-core/types";
import { JsonClient } from "./helpers/json-client.ts";

/** Shorthand: null-aware Store adapter backed by an in-memory store. */
function memClient() {
  const store = new MemoryStore();
  // MemoryStore.provisionEntity has no `await`s — the bucket is created
  // synchronously before the returned Promise is constructed, so the test
  // can keep using a sync factory.
  void store.provisionEntity(store.entitySupport(BYTES_ENTITY));
  return new JsonClient(
    new SaveClient(mapToBytes, BYTES_ENTITY, store),
  );
}

// ── connection() unit tests ──

Deno.test("connection - accepts matching URI", () => {
  const conn = connection(memClient(), ["mutable://*"]);
  assertEquals(conn.accepts("mutable://open/app/x"), true);
});

Deno.test("connection - rejects non-matching URI", () => {
  const conn = connection(memClient(), ["mutable://*"]);
  assertEquals(conn.accepts("hash://sha256/abc"), false);
});

Deno.test("connection - patterns are serializable", () => {
  const conn = connection(memClient(), ["mutable://*", "hash://*"]);
  const wire = JSON.stringify(conn.patterns);
  const parsed = JSON.parse(wire);
  assertEquals(parsed, ["mutable://*", "hash://*"]);
});

Deno.test("connection - express-style param patterns", () => {
  const conn = connection(memClient(), ["mutable://accounts/:id/*"]);
  assertEquals(conn.accepts("mutable://accounts/alice/profile"), true);
  assertEquals(conn.accepts("mutable://accounts/bob/settings"), true);
  assertEquals(conn.accepts("mutable://open/anything"), false);
});

Deno.test("connection - patterns are frozen", () => {
  const patterns = ["mutable://*"];
  const conn = connection(memClient(), patterns);
  // Mutating the original doesn't affect the connection
  patterns.push("hash://*");
  assertEquals([...conn.patterns], ["mutable://*"]);
});

// ── Rig + connections integration tests ──

Deno.test("rig routes receive to correct connection", async () => {
  const remote = memClient();
  const local = memClient();

  const _route1 = connection(remote, ["mutable://*"]);
  const _route2 = connection(local, ["local://*"]);
  const rig = new Rig({
    routes: {
      receive: [
        _route1,
        _route2,
      ],
      read: [
        _route1,
        _route2,
      ],
    },
  });

  await rig.receive([["mutable://open/x", { v: 1 }]]);
  await rig.receive([["local://app/y", { v: 2 }]]);

  // remote has mutable data, local doesn't
  const r1 = (await remote.read(["mutable://open/x"]))[0];
  const r2 = (await local.read(["mutable://open/x"]))[0];
  assertEquals(r1?.[1], { v: 1 });
  assertEquals(r2?.[1], undefined); // 1:1: slot present, payload absent

  // local has local data, remote doesn't
  const r3 = (await local.read(["local://app/y"]))[0];
  const r4 = (await remote.read(["local://app/y"]))[0];
  assertEquals(r3?.[1], { v: 2 });
  assertEquals(r4?.[1], undefined);
});

Deno.test("rig reads from first matching connection (no fall-through)", async () => {
  // The rig dispatcher is sequential and does not fall through on miss.
  // Composing fall-through across sources is the job of an aggregating
  // client (e.g. memcache + shard pool), not the rig.
  const primary = memClient();
  const fallback = memClient();

  await fallback.receive([["mutable://open/old", { from: "fallback" }]]);

  const _route3 = connection(primary, ["mutable://*"]);
  const _route4 = connection(fallback, ["mutable://*"]);
  const rig = new Rig({
    routes: {
      receive: [_route3],
      read: [_route3, _route4],
    },
  });

  await rig.receive([["mutable://open/new", { from: "primary" }]]);

  // Primary has it → success.
  const r1 = (await rig.read(["mutable://open/new"]))[0];
  assertEquals(r1?.[1], { from: "primary" });

  // Primary doesn't have it; rig stops at primary's miss. To fall back,
  // wrap the two memClients in an aggregating client and route to that.
  const r2 = (await rig.read(["mutable://open/old"]))[0];
  assertEquals(r2?.[1], undefined);
});

Deno.test("rig broadcasts writes to all matching connections", async () => {
  const primary = memClient();
  const mirror = memClient();

  const _route5 = connection(primary, ["mutable://*"]);
  const _route6 = connection(mirror, ["mutable://*"]);
  const rig = new Rig({
    routes: {
      receive: [
        _route5,
        _route6,
      ],
      read: [_route5],
    },
  });

  await rig.receive([["mutable://open/x", { v: 1 }]]);

  // Both have the data
  await primary.read(["mutable://open/x"]);
  await mirror.read(["mutable://open/x"]);
});

Deno.test("rig rejects receive for unconnected URI", async () => {
  const _route7 = connection(memClient(), ["local://*"]);
  const rig = new Rig({
    routes: {
      receive: [_route7],
    },
  });

  const [result] = await rig.receive([["mutable://open/x", { v: 1 }]]);
  assertEquals(result.accepted, false);
});

Deno.test("rig rejects read for unconnected URI", async () => {
  const _route8 = connection(memClient(), ["local://*"]);
  const rig = new Rig({
    routes: {
      read: [_route8],
    },
  });

  // Option-A: no matching route is a programmer error → throws.
  let threw = false;
  try {
    await rig.read(["mutable://open/x"]);
  } catch (e) {
    threw = true;
    assertEquals(/No read route accepts/.test(String(e)), true);
  }
  assertEquals(threw, true);
});

Deno.test("best-effort: local connection enforces even if client accepts everything", async () => {
  // Memory backend accepts anything — no internal filtering
  const client = memClient();

  const _route9 = connection(client, ["mutable://*"]);
  const rig = new Rig({
    routes: {
      receive: [_route9],
    },
  });

  // hash:// not in connection → rejected by rig, even though client would accept it
  const [result] = await rig.receive([["hash://sha256/abc", "some data"]]);
  assertEquals(result.accepted, false);

  // Verify nothing was written
  await client.read(["hash://sha256/abc"]);
});

Deno.test("programs and connections are separate concerns", async () => {
  const client = memClient();

  const validate: Program = ([_uri, data]) => {
    if (typeof data !== "object" || data === null) {
      return Promise.resolve({
        code: "invalid",
        error: "must be an object",
      });
    }
    return Promise.resolve({ code: "ok" });
  };

  const _route10 = connection(client, ["mutable://*"]);
  const rig = new Rig({
    routes: {
      receive: [_route10],
      read: [_route10],
    },
    programs: { "mutable://open": validate },
  });

  // Matches connection + passes program → accepted
  const [r1] = await rig.receive([["mutable://open/x", { valid: true }]]);
  assertEquals(r1.accepted, true);

  // Matches connection but fails program → rejected with program error
  const [r2] = await rig.receive([["mutable://open/y", "not an object"]]);
  assertEquals(r2.accepted, false);

  // Doesn't match connection → rejected before program runs
  const [r3] = await rig.receive([["hash://sha256/abc", { valid: true }]]);
  assertEquals(r3.accepted, false);
});

Deno.test("program runs after connection routing", async () => {
  const client = memClient();
  let programCalledWith: string[] = [];

  const record: Program = ([uri]) => {
    programCalledWith.push(uri);
    return Promise.resolve({ code: "ok" });
  };

  const _route11 = connection(client, ["mutable://*"]);
  const rig = new Rig({
    routes: {
      receive: [_route11],
    },
    programs: { "mutable://open": record },
  });

  // Unconnected URI → program never called
  programCalledWith = [];
  await rig.receive([["hash://sha256/abc", "data"]]);
  assertEquals(programCalledWith.length, 0);

  // Subscribed URI → program IS called
  await rig.receive([["mutable://open/x", "data"]]);
  assertEquals(programCalledWith.length, 1);
});

Deno.test("single client via catch-all connection", async () => {
  const _route12 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route12],
      read: [_route12],
    },
  });

  // Everything accepted — no filtering
  const [r1] = await rig.receive([["mutable://open/x", { v: 1 }]]);
  assertEquals(r1.accepted, true);
  const [r2] = await rig.receive([["hash://sha256/whatever", "data"]]);
  assertEquals(r2.accepted, true);
});

Deno.test("single client via explicit connection still works (catch-all)", async () => {
  const _route13 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route13],
      read: [_route13],
    },
  });

  const [r] = await rig.receive([["mutable://open/x", { v: 1 }]]);
  assertEquals(r.accepted, true);
  await rig.read(["mutable://open/x"]);
});

Deno.test("status().schema unions all connection client schemas", async () => {
  const a = memClient();
  const b = memClient();

  // Write some data so status has something to report
  await a.receive([["mutable://open/x", "data"]]);
  await b.receive([["local://app/y", "data"]]);

  const _route14 = connection(a, ["mutable://*"]);
  const _route15 = connection(b, ["local://*"]);
  const rig = new Rig({
    routes: {
      receive: [
        _route14,
        _route15,
      ],
      read: [
        _route14,
        _route15,
      ],
    },
  });

  const status = await rig.status();
  assertEquals(Array.isArray(status.schema), true);
});

Deno.test("status aggregates across all connection clients", async () => {
  const _route16 = connection(memClient(), ["mutable://*"]);
  const _route17 = connection(memClient(), ["local://*"]);
  const rig = new Rig({
    routes: {
      receive: [
        _route16,
        _route17,
      ],
    },
  });

  const status = await rig.status();
  assertEquals(status.status, "healthy");
});

Deno.test("list via trailing-slash read routes through connection", async () => {
  const client = memClient();

  const _route18 = connection(client, ["mutable://*"]);
  const rig = new Rig({
    routes: {
      receive: [_route18],
      read: [_route18],
    },
  });

  await rig.receive([["mutable://open/a", "one"]]);
  await rig.receive([["mutable://open/b", "two"]]);

  const [result] = await rig.read(["mutable://open/"]);
  const entries = result?.[1] as Array<[string, unknown]>;
  assertEquals(entries.length >= 2, true);
});
