import { assertEquals } from "@std/assert";
import { parseVer, satisfies } from "./check-dep-drift.ts";

// ── parseVer ──────────────────────────────────────────────────────────────

Deno.test("parseVer: bare version", () => {
  assertEquals(parseVer("1.2.3"), [1, 2, 3]);
});

Deno.test("parseVer: strips caret", () => {
  assertEquals(parseVer("^0.22.0"), [0, 22, 0]);
});

Deno.test("parseVer: strips tilde", () => {
  assertEquals(parseVer("~1.5.0"), [1, 5, 0]);
});

// ── satisfies — 0.x caret ────────────────────────────────────────────────

Deno.test("0.x caret: same minor, same patch → satisfies", () => {
  assertEquals(satisfies("^0.22.0", "0.22.0"), true);
});

Deno.test("0.x caret: same minor, higher patch → satisfies", () => {
  assertEquals(satisfies("^0.22.0", "0.22.3"), true);
});

Deno.test("0.x caret: next minor → does NOT satisfy", () => {
  assertEquals(satisfies("^0.22.0", "0.23.0"), false);
});

Deno.test("0.x caret: two minors ahead → does NOT satisfy", () => {
  assertEquals(satisfies("^0.22.0", "0.24.0"), false);
});

Deno.test("0.x caret: lower minor → does NOT satisfy", () => {
  assertEquals(satisfies("^0.22.0", "0.21.9"), false);
});

Deno.test("0.x caret: lower patch same minor → does NOT satisfy", () => {
  assertEquals(satisfies("^0.22.5", "0.22.3"), false);
});

// ── satisfies — ≥1.x caret ───────────────────────────────────────────────

Deno.test("≥1 caret: same → satisfies", () => {
  assertEquals(satisfies("^1.0.0", "1.0.0"), true);
});

Deno.test("≥1 caret: higher minor → satisfies", () => {
  assertEquals(satisfies("^1.2.0", "1.5.0"), true);
});

Deno.test("≥1 caret: different major → does NOT satisfy", () => {
  assertEquals(satisfies("^1.0.0", "2.0.0"), false);
});

// ── satisfies — tilde ────────────────────────────────────────────────────

Deno.test("tilde: same minor, higher patch → satisfies", () => {
  assertEquals(satisfies("~1.2.3", "1.2.9"), true);
});

Deno.test("tilde: higher minor → does NOT satisfy", () => {
  assertEquals(satisfies("~1.2.3", "1.3.0"), false);
});

// ── satisfies — bare version ─────────────────────────────────────────────

Deno.test("bare: exact match → satisfies", () => {
  assertEquals(satisfies("1.2.3", "1.2.3"), true);
});

Deno.test("bare: higher patch → does NOT satisfy", () => {
  assertEquals(satisfies("1.2.3", "1.2.4"), false);
});

// ── real-world cases (the sweep) ─────────────────────────────────────────

Deno.test("^0.24.0 satisfied by 0.24.0", () => {
  assertEquals(satisfies("^0.24.0", "0.24.0"), true);
});

Deno.test("^0.24.0 NOT satisfied by 0.25.0", () => {
  assertEquals(satisfies("^0.24.0", "0.25.0"), false);
});

Deno.test("^0.20.0 satisfied by 0.20.0", () => {
  assertEquals(satisfies("^0.20.0", "0.20.0"), true);
});

Deno.test("^0.20.0 NOT satisfied by 0.21.0", () => {
  assertEquals(satisfies("^0.20.0", "0.21.0"), false);
});

Deno.test("^0.5.0 satisfied by 0.5.0", () => {
  assertEquals(satisfies("^0.5.0", "0.5.0"), true);
});

Deno.test("^0.5.0 NOT satisfied by 0.6.0", () => {
  assertEquals(satisfies("^0.5.0", "0.6.0"), false);
});
