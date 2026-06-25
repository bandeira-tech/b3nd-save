/// <reference lib="deno.ns" />
/**
 * Dispatch tests — existing read/ls/count + count behavior, plus v2
 * additions: `fn=find` case (handler required, no silent ls fall-back
 * — see spec §3.5), cursor-as-trailing-slot emission.
 */
import { assertEquals, assertRejects } from "jsr:@std/assert";
import type { Output } from "@bandeira-tech/b3nd-core/types";
import { dispatchRead } from "./dispatch.ts";
import type { ParsedUrl } from "./url.ts";

Deno.test("dispatches read, ls, count by url shape", async () => {
  const out = await dispatchRead(
    [
      "s://a/k",
      "s://a/",
      "s://a/?fn=count",
    ],
    "test",
    {
      read: (p) => `read:${p.uri}`,
      ls: (p) => `ls:${p.uri}`,
      count: () => 42,
    },
  );

  assertEquals(out, [
    ["s://a/k", "read:s://a/k"],
    ["s://a/", "ls:s://a/"],
    ["s://a/?fn=count", 42],
  ]);
});

Deno.test("echoes full input url including query", async () => {
  const url = "s://a/?fn=ls&limit=5";
  const out = await dispatchRead([url], "test", {
    read: () => null,
    ls: () => [], // empty array — limit triggers cursor slot
    count: () => 0,
  });
  assertEquals(out[0][0], url);
});

Deno.test("unknown fn throws", async () => {
  await assertRejects(
    () =>
      dispatchRead(["s://a/?fn=bogus"], "test", {
        read: () => null,
        ls: () => null,
        count: () => 0,
      }),
    Error,
    "unsupported fn 'bogus'",
  );
});

Deno.test("x-* extension routed to ext when provided", async () => {
  const out = await dispatchRead(["s://a/?fn=x-feed.tail"], "test", {
    read: () => null,
    ls: () => null,
    count: () => 0,
    ext: (p) => ({ ok: true, fn: p.fn }),
  });
  assertEquals(out[0][1], { ok: true, fn: "x-feed.tail" });
});

Deno.test("x-* without ext handler throws", async () => {
  await assertRejects(
    () =>
      dispatchRead(["s://a/?fn=x-feed.tail"], "test", {
        read: () => null,
        ls: () => null,
        count: () => 0,
      }),
    Error,
    "unsupported fn 'x-feed.tail'",
  );
});

Deno.test("async handlers are awaited", async () => {
  const out = await dispatchRead(["s://a/k"], "test", {
    read: () => Promise.resolve("async-read"),
    ls: () => null,
    count: () => 0,
  });
  assertEquals(out[0][1], "async-read");
});

// ── v2: fn=find case ───────────────────────────────────────────────

Deno.test("fn=find routes to handlers.find when present (push-down path)", async () => {
  const calls: string[] = [];
  const out = await dispatchRead(
    ["s://a/**?fn=find"],
    "test",
    {
      read: () => null,
      ls: () => {
        calls.push("ls");
        return [];
      },
      find: (p) => {
        calls.push(`find:${p.uri}:${p.glob}`);
        return [["s://a/x", { v: 1 }], ["s://a/y/z", { v: 2 }]];
      },
      count: () => 0,
      pushDownFind: true,
      pushDownPattern: true,
    },
  );
  assertEquals(calls, ["find:s://a/:**"]);
  assertEquals(out[0][1], [["s://a/x", { v: 1 }], ["s://a/y/z", { v: 2 }]]);
});

Deno.test("fn=find handler can internally reuse ls for deep walks", async () => {
  // A store with "shared ls/find semantics" — its ls handler returns
  // deep rows already, so its find handler is a one-line wrapper that
  // delegates to ls. Dispatch still post-filters via the glob (pattern
  // push-down is off). This documents the supported "thin find" path
  // for stores whose backend ls is already deep.
  const parsedLs = (p: ParsedUrl) => p; // capture for the wrapper
  let lsCalls = 0;
  const handlers = {
    read: () => null,
    ls: (_p: ParsedUrl) => {
      lsCalls++;
      return [
        ["s://a/x", { v: 1 }],
        ["s://a/y/z", { v: 2 }],
        ["s://a/y/z/w", { v: 3 }],
      ];
    },
    find: (p: ParsedUrl) => handlers.ls(parsedLs(p)),
    count: () => 0,
  };
  const out = await dispatchRead(
    ["s://a/**?fn=find"],
    "test",
    handlers,
  );
  assertEquals(lsCalls, 1);
  assertEquals(
    (out[0][1] as Array<Output>).map(([u]) => u),
    ["s://a/x", "s://a/y/z", "s://a/y/z/w"],
  );
});

// ── v2: cursor-as-trailing-slot ─────────────────────────────────────

Deno.test("cursor slot appended when limit is set on fn=ls", async () => {
  const url = "s://a/*?fn=ls&limit=2";
  const out = await dispatchRead([url], "test", {
    read: () => null,
    ls: () => [
      ["s://a/1", "a"],
      ["s://a/2", "b"],
      ["s://a/3", "c"],
    ],
    count: () => 0,
  });
  const payload = out[0][1] as Array<Output>;
  // 2 rows + 1 cursor slot
  assertEquals(payload.length, 3);
  assertEquals(payload[0], ["s://a/1", "a"]);
  assertEquals(payload[1], ["s://a/2", "b"]);
  const slot = payload[2];
  assertEquals(typeof slot[0], "string");
  // Slot URI is the locator + cursor=<last-row-uri> with other params
  // preserved.
  assertEquals(slot[0].includes("cursor=s%3A%2F%2Fa%2F2"), true);
  assertEquals(slot[0].includes("limit=2"), true);
  assertEquals(slot[0].includes("fn=ls"), true);
  // Payload is { next: "<opaque>" } when the page was truncated.
  assertEquals(slot[1], { next: "s://a/2" });
});

Deno.test("cursor slot has next: null when result is not truncated", async () => {
  const url = "s://a/*?fn=ls&limit=10";
  const out = await dispatchRead([url], "test", {
    read: () => null,
    ls: () => [
      ["s://a/1", "a"],
      ["s://a/2", "b"],
    ],
    count: () => 0,
  });
  const payload = out[0][1] as Array<Output>;
  assertEquals(payload.length, 3); // 2 rows + 1 slot
  const slot = payload[2];
  assertEquals(slot[1], { next: null });
  // Even the end-slot URI is re-issuable — it carries cursor=<lastUri>
  // so the re-issue returns an empty page + a fresh next: null slot.
  assertEquals(slot[0].includes("cursor=s%3A%2F%2Fa%2F2"), true);
});

Deno.test("cursor slot is NOT appended when limit is absent", async () => {
  const url = "s://a/*?fn=ls";
  const out = await dispatchRead([url], "test", {
    read: () => null,
    ls: () => [["s://a/1", "a"], ["s://a/2", "b"]],
    count: () => 0,
  });
  const payload = out[0][1] as Array<Output>;
  assertEquals(payload.length, 2);
});

Deno.test("cursor slot appended on fn=find too", async () => {
  const url = "s://a/**?fn=find&limit=2";
  const deepRows: Output[] = [
    ["s://a/1", "a"],
    ["s://a/2", "b"],
    ["s://a/deep/3", "c"],
  ];
  const out = await dispatchRead([url], "test", {
    read: () => null,
    ls: () => deepRows,
    find: () => deepRows,
    count: () => 0,
  });
  const payload = out[0][1] as Array<Output>;
  assertEquals(payload.length, 3); // 2 + slot
  const slot = payload[2];
  assertEquals(slot[1], { next: "s://a/2" });
  // The locator's `**?fn=find&limit=2` shape is preserved in the slot URI.
  assertEquals(slot[0].startsWith("s://a/**?"), true);
  assertEquals(slot[0].includes("fn=find"), true);
});

Deno.test("cursor slot URI composes with other params (sortBy, format)", async () => {
  const url = "s://a/*?fn=ls&limit=1&sortBy=uri&format=uris";
  const out = await dispatchRead([url], "test", {
    read: () => null,
    ls: () => ["s://a/1", "s://a/2"],
    count: () => 0,
    pushDownSortBy: true, // sortBy=uri is always push-down; this just
    // signals "the handler did the sort itself"
  });
  const payload = out[0][1] as unknown[];
  // 1 row + cursor slot (mixed payload: string + Output)
  assertEquals(payload.length, 2);
  assertEquals(payload[0], "s://a/1");
  const slot = payload[1] as Output;
  assertEquals(slot[1], { next: "s://a/1" });
  assertEquals(slot[0].includes("sortBy=uri"), true);
  assertEquals(slot[0].includes("format=uris"), true);
  assertEquals(slot[0].includes("limit=1"), true);
});

Deno.test("cursor slot re-issue: caller can use the slot URI to fetch the next page", async () => {
  // Page 1: ask for limit=2, get rows [1,2] + slot {next: "s://a/2"}.
  // Page 2: re-issue the slot URI; dispatch sees cursor=s://a/2 and
  // post-filters, returning [3] + slot {next: null}.
  const allRows: Output[] = [
    ["s://a/1", "a"],
    ["s://a/2", "b"],
    ["s://a/3", "c"],
  ];
  const handlers = {
    read: () => null,
    ls: () => allRows,
    count: () => 0,
  };
  const page1 = await dispatchRead(
    ["s://a/*?fn=ls&limit=2"],
    "test",
    handlers,
  );
  const slot1 = (page1[0][1] as Array<Output>)[2];
  const page2 = await dispatchRead([slot1[0]], "test", handlers);
  const payload2 = page2[0][1] as Array<Output>;
  // dispatch's cursor post-filter strips everything <= s://a/2, leaving 3.
  assertEquals(payload2.length, 2); // 1 row + slot
  assertEquals(payload2[0], ["s://a/3", "c"]);
  assertEquals(payload2[1][1], { next: null });
});

// ── v2 §3.5: fn=find throws when handlers.find is absent ───────────

Deno.test("fn=find throws 'unsupported fn' when handlers.find is absent (no silent ls fall-back)", async () => {
  // v2 spec §3.5: a store that does not advertise "find" in
  // status().fns MUST throw on fn=find — no silent fall-back. Dispatch
  // enforces that contract at the switch level: omitting
  // `handlers.find` triggers the same "unsupported fn" throw used for
  // any unknown verb, so callers get a loud failure they can handle
  // (or that surfaces in tests). The throw is independent of whether
  // ls would have returned anything sensible.
  await assertRejects(
    () =>
      dispatchRead(
        ["s://a/**?fn=find"],
        "test",
        {
          read: () => null,
          ls: () => [["s://a/1", "a"]],
          count: () => 0,
        },
      ),
    Error,
    "unsupported fn 'find'",
  );
});
