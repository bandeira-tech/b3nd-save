import { assertEquals, assertRejects } from "@std/assert";
import { Identity } from "@bandeira-tech/b3nd-core/identity";
import { Rig } from "@bandeira-tech/b3nd-core/rig";
import type { Program } from "@bandeira-tech/b3nd-core/types";
import { MemoryStore } from "../src/memory/store.ts";
import { mapToBytes, SaveClient } from "../src/clients/save-client.ts";
import { BYTES_ENTITY } from "../src/entity.ts";
import { connection } from "@bandeira-tech/b3nd-core/rig";
import { JsonClient } from "./helpers/json-client.ts";

async function readData<T>(rig: Rig, url: string): Promise<T | null> {
  const r = (await rig.read<T>([url]))[0];
  return r ? r[1] : null;
}

/**
 * Shorthand: null-aware Store adapter backed by an in-memory store,
 * wrapped in JsonClient so tests can pass arbitrary JSON payloads
 * through the bytes-only Save layer underneath.
 */
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

/**
 * Create a permissive test program set that classifies every message
 * under common URI prefixes as `{ code: "ok" }` — no rejections. Handy
 * for rig tests that want the pipeline running without caring about
 * message-level validation.
 */
function createTestPrograms(): Record<string, Program> {
  // deno-lint-ignore require-await
  const acceptAll: Program = async () => ({ code: "ok" });
  return {
    "mutable://accounts": acceptAll,
    "mutable://open": acceptAll,
    "mutable://data": acceptAll,
    "immutable://accounts": acceptAll,
    "immutable://open": acceptAll,
    "immutable://data": acceptAll,
  };
}

import type { EncryptedPayload } from "@bandeira-tech/b3nd-core/encrypt";

// The "Rig observe — HttpClient SSE end-to-end" integration that used
// to live at the bottom of this file moved to @bandeira-tech/b3nd-move
// when HttpClient + httpApi moved there. It is now a rig+HTTP test, not
// a rig+Store test, and belongs alongside its transport.

/**
 * Helper: read encrypted data and decrypt it.
 * Replaces the old AuthenticatedRig.readEncrypted() pattern in tests.
 */
async function readEncrypted<T = unknown>(
  identity: Identity,
  rig: Rig,
  uri: string,
): Promise<T | null> {
  if (!identity.canEncrypt) {
    throw new Error(
      "readEncrypted: identity has no encryption/decryption keys.",
    );
  }
  const [result] = await rig.read([uri]);
  const payload = result?.[1];
  if (payload === undefined) return null;

  if (
    !payload || typeof payload !== "object" ||
    !("data" in (payload as Record<string, unknown>)) ||
    !("nonce" in (payload as Record<string, unknown>))
  ) {
    throw new Error(
      `readEncrypted: data at ${uri} is not an EncryptedPayload`,
    );
  }

  const decrypted = await identity.decrypt(payload as EncryptedPayload);
  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}

// ── Identity tests ──

Deno.test("Identity.generate - creates a fresh identity", async () => {
  const id = await Identity.generate();
  assertEquals(typeof id.pubkey, "string");
  assertEquals(id.pubkey.length, 64); // 32 bytes hex
  assertEquals(id.canSign, true);
  assertEquals(typeof id.encryptionPubkey, "string");
  assertEquals(id.encryptionPubkey.length, 64);
});

Deno.test("Identity.fromSeed - deterministic from same seed", async () => {
  const a = await Identity.fromSeed("test-seed-123");
  const b = await Identity.fromSeed("test-seed-123");
  assertEquals(a.pubkey, b.pubkey);
  assertEquals(a.encryptionPubkey, b.encryptionPubkey);
});

Deno.test("Identity.fromSeed - different seeds produce different keys", async () => {
  const a = await Identity.fromSeed("seed-a");
  const b = await Identity.fromSeed("seed-b");
  assertEquals(a.pubkey !== b.pubkey, true);
});

Deno.test("Identity.publicOnly - creates a read-only identity", () => {
  const id = Identity.publicOnly({ signing: "ab".repeat(32) });
  assertEquals(id.pubkey, "ab".repeat(32));
  assertEquals(id.canSign, false);
});

Deno.test("Identity.publicOnly - sign throws", async () => {
  const id = Identity.publicOnly({ signing: "ab".repeat(32) });
  await assertRejects(
    () => id.sign({ test: true }),
    Error,
    "public-only",
  );
});

Deno.test("Identity.sign - produces valid auth entry", async () => {
  const id = await Identity.generate();
  const payload = { hello: "world" };
  const auth = await id.sign(payload);
  assertEquals(auth.pubkey, id.pubkey);
  assertEquals(typeof auth.signature, "string");
  assertEquals(auth.signature.length > 0, true);
});

Deno.test("Identity.signMessage - wraps payload in AuthenticatedMessage", async () => {
  const id = await Identity.generate();
  const msg = await id.signMessage({ action: "test" });
  assertEquals(msg.auth.length, 1);
  assertEquals(msg.auth[0].pubkey, id.pubkey);
  assertEquals(msg.payload, { action: "test" });
});

Deno.test("Identity.verify - round-trips with sign", async () => {
  const id = await Identity.generate();
  const payload = { test: 42 };
  const auth = await id.sign(payload);
  const valid = await id.verify(payload, auth.signature);
  assertEquals(valid, true);

  // Tampered payload should fail
  const invalid = await id.verify({ test: 43 }, auth.signature);
  assertEquals(invalid, false);
});

Deno.test("Identity.encrypt/decrypt - round-trips", async () => {
  const sender = await Identity.generate();
  const receiver = await Identity.generate();

  const plaintext = new TextEncoder().encode("secret message");
  const encrypted = await sender.encrypt(plaintext, receiver.encryptionPubkey);
  const decrypted = await receiver.decrypt(encrypted);

  assertEquals(new TextDecoder().decode(decrypted), "secret message");
});

Deno.test("Identity.signer - returns CryptoKey + pubkey", async () => {
  const id = await Identity.generate();
  const signer = id.signer;
  assertEquals(signer.publicKeyHex, id.pubkey);
  assertEquals(signer.privateKey instanceof CryptoKey, true);
});

// ── Identity export/import tests ──

Deno.test("Identity.export - full identity round-trips", async () => {
  const original = await Identity.generate();
  const exported = await original.export();

  // Exported data has all four fields
  assertEquals(typeof exported.signingPublicKeyHex, "string");
  assertEquals(typeof exported.signingPrivateKeyHex, "string");
  assertEquals(typeof exported.encryptionPublicKeyHex, "string");
  assertEquals(typeof exported.encryptionPrivateKeyHex, "string");

  // Reconstruct
  const restored = await Identity.fromExport(exported);
  assertEquals(restored.pubkey, original.pubkey);
  assertEquals(restored.encryptionPubkey, original.encryptionPubkey);
  assertEquals(restored.canSign, true);
});

Deno.test("Identity.export - restored identity can sign and verify", async () => {
  const original = await Identity.generate();
  const exported = await original.export();
  const restored = await Identity.fromExport(exported);

  // Sign with restored, verify with original public key
  const payload = { test: "round-trip" };
  const auth = await restored.sign(payload);
  assertEquals(auth.pubkey, original.pubkey);

  const valid = await original.verify(payload, auth.signature);
  assertEquals(valid, true);
});

Deno.test("Identity.export - restored identity can encrypt/decrypt", async () => {
  const sender = await Identity.generate();
  const receiver = await Identity.generate();

  // Export and restore the receiver
  const exported = await receiver.export();
  const restoredReceiver = await Identity.fromExport(exported);

  // Encrypt to receiver, decrypt with restored receiver
  const plaintext = new TextEncoder().encode("exported secret");
  const encrypted = await sender.encrypt(plaintext, receiver.encryptionPubkey);
  const decrypted = await restoredReceiver.decrypt(encrypted);

  assertEquals(new TextDecoder().decode(decrypted), "exported secret");
});

Deno.test("Identity.export - public-only identity exports without private keys", async () => {
  const id = Identity.publicOnly({
    signing: "ab".repeat(32),
    encryption: "cd".repeat(32),
  });
  const exported = await id.export();

  assertEquals(exported.signingPublicKeyHex, "ab".repeat(32));
  assertEquals(exported.encryptionPublicKeyHex, "cd".repeat(32));
  assertEquals(exported.signingPrivateKeyHex, undefined);
  assertEquals(exported.encryptionPrivateKeyHex, undefined);
});

Deno.test("Identity.export - public-only round-trip stays public-only", async () => {
  const id = Identity.publicOnly({
    signing: "ab".repeat(32),
    encryption: "cd".repeat(32),
  });
  const exported = await id.export();
  const restored = await Identity.fromExport(exported);

  assertEquals(restored.pubkey, "ab".repeat(32));
  assertEquals(restored.canSign, false);
});

Deno.test("Identity.export - JSON serialization round-trip", async () => {
  const original = await Identity.generate();
  const exported = await original.export();

  // Simulate localStorage / file persistence
  const json = JSON.stringify(exported);
  const parsed = JSON.parse(json);

  const restored = await Identity.fromExport(parsed);
  assertEquals(restored.pubkey, original.pubkey);
  assertEquals(restored.encryptionPubkey, original.encryptionPubkey);
  assertEquals(restored.canSign, true);

  // Verify signing still works after JSON round-trip
  const auth = await restored.sign({ from: "json" });
  const valid = await original.verify({ from: "json" }, auth.signature);
  assertEquals(valid, true);
});

Deno.test("Identity.export - fromSeed identity round-trips deterministically", async () => {
  const fromSeed = await Identity.fromSeed("export-test-seed");
  const exported = await fromSeed.export();
  const restored = await Identity.fromExport(exported);

  // Same keys
  assertEquals(restored.pubkey, fromSeed.pubkey);
  assertEquals(restored.encryptionPubkey, fromSeed.encryptionPubkey);

  // Both can produce the same signatures
  const payload = { deterministic: true };
  const authOriginal = await fromSeed.sign(payload);
  const authRestored = await restored.sign(payload);
  assertEquals(authOriginal.signature, authRestored.signature);
});

// ── Identity.fromPem tests ──

Deno.test("Identity.fromPem - creates identity from PEM and pubkey", async () => {
  // Generate a fresh identity, export its signing key to PEM
  const original = await Identity.generate();
  const exported = await original.export();

  // Export the signing private key as PEM via the encrypt module
  const { exportPrivateKeyPem } = await import(
    "@bandeira-tech/b3nd-core/encrypt"
  );
  const { decodeHex } = await import("@bandeira-tech/b3nd-core/encoding");

  // Reconstruct the CryptoKey from exported hex, then export to PEM
  const signingKey = await crypto.subtle.importKey(
    "pkcs8",
    decodeHex(exported.signingPrivateKeyHex!).buffer,
    { name: "Ed25519", namedCurve: "Ed25519" },
    true,
    ["sign"],
  );
  const pem = await exportPrivateKeyPem(signingKey, "PRIVATE KEY");

  // Create identity from PEM (signing only, no encryption keys)
  const fromPem = await Identity.fromPem(pem, original.pubkey);
  assertEquals(fromPem.pubkey, original.pubkey);
  assertEquals(fromPem.canSign, true);
});

Deno.test("Identity.fromPem - sign/verify round-trips with original", async () => {
  const original = await Identity.generate();
  const exported = await original.export();

  const { exportPrivateKeyPem } = await import(
    "@bandeira-tech/b3nd-core/encrypt"
  );
  const { decodeHex } = await import("@bandeira-tech/b3nd-core/encoding");

  const signingKey = await crypto.subtle.importKey(
    "pkcs8",
    decodeHex(exported.signingPrivateKeyHex!).buffer,
    { name: "Ed25519", namedCurve: "Ed25519" },
    true,
    ["sign"],
  );
  const pem = await exportPrivateKeyPem(signingKey, "PRIVATE KEY");

  const fromPem = await Identity.fromPem(pem, original.pubkey);

  // Sign with PEM-restored identity, verify with original
  const payload = { action: "pem-test" };
  const auth = await fromPem.sign(payload);
  const valid = await original.verify(payload, auth.signature);
  assertEquals(valid, true);
});

Deno.test("Identity.fromPem - with encryption keys enables decrypt", async () => {
  const original = await Identity.generate();
  const exported = await original.export();

  const { exportPrivateKeyPem } = await import(
    "@bandeira-tech/b3nd-core/encrypt"
  );
  const { decodeHex } = await import("@bandeira-tech/b3nd-core/encoding");

  const signingKey = await crypto.subtle.importKey(
    "pkcs8",
    decodeHex(exported.signingPrivateKeyHex!).buffer,
    { name: "Ed25519", namedCurve: "Ed25519" },
    true,
    ["sign"],
  );
  const pem = await exportPrivateKeyPem(signingKey, "PRIVATE KEY");

  // Create with full keys (signing PEM + encryption hex)
  const fromPem = await Identity.fromPem(
    pem,
    original.pubkey,
    exported.encryptionPrivateKeyHex,
    exported.encryptionPublicKeyHex,
  );

  assertEquals(fromPem.encryptionPubkey, original.encryptionPubkey);

  // Encrypt for the PEM identity, decrypt with it
  const sender = await Identity.generate();
  const plaintext = new TextEncoder().encode("pem-encrypted");
  const encrypted = await sender.encrypt(plaintext, fromPem.encryptionPubkey);
  const decrypted = await fromPem.decrypt(encrypted);
  assertEquals(new TextDecoder().decode(decrypted), "pem-encrypted");
});

Deno.test("Identity.fromPem - derives encryption pubkey from private when not provided", async () => {
  const original = await Identity.generate();
  const exported = await original.export();

  const { exportPrivateKeyPem } = await import(
    "@bandeira-tech/b3nd-core/encrypt"
  );
  const { decodeHex } = await import("@bandeira-tech/b3nd-core/encoding");

  const signingKey = await crypto.subtle.importKey(
    "pkcs8",
    decodeHex(exported.signingPrivateKeyHex!).buffer,
    { name: "Ed25519", namedCurve: "Ed25519" },
    true,
    ["sign"],
  );
  const pem = await exportPrivateKeyPem(signingKey, "PRIVATE KEY");

  // Provide encryption private key but NOT public — should derive it
  const fromPem = await Identity.fromPem(
    pem,
    original.pubkey,
    exported.encryptionPrivateKeyHex,
    // No encryptionPublicKeyHex — should be derived
  );

  assertEquals(fromPem.encryptionPubkey, original.encryptionPubkey);
});

// ── Identity.canEncrypt tests ──

Deno.test("Identity.canEncrypt - true for generated identity", async () => {
  const id = await Identity.generate();
  assertEquals(id.canEncrypt, true);
});

Deno.test("Identity.canEncrypt - true for seeded identity", async () => {
  const id = await Identity.fromSeed("encrypt-test");
  assertEquals(id.canEncrypt, true);
});

Deno.test("Identity.canEncrypt - false for public-only identity", () => {
  const id = Identity.publicOnly({ signing: "ab".repeat(32) });
  assertEquals(id.canEncrypt, false);
});

Deno.test("Identity.canEncrypt - false for PEM without encryption keys", async () => {
  const original = await Identity.generate();
  const exported = await original.export();

  const { exportPrivateKeyPem } = await import(
    "@bandeira-tech/b3nd-core/encrypt"
  );
  const { decodeHex } = await import("@bandeira-tech/b3nd-core/encoding");

  const signingKey = await crypto.subtle.importKey(
    "pkcs8",
    decodeHex(exported.signingPrivateKeyHex!).buffer,
    { name: "Ed25519", namedCurve: "Ed25519" },
    true,
    ["sign"],
  );
  const pem = await exportPrivateKeyPem(signingKey, "PRIVATE KEY");

  // No encryption keys provided
  const fromPem = await Identity.fromPem(pem, original.pubkey);
  assertEquals(fromPem.canEncrypt, false);
  assertEquals(fromPem.canSign, true);
});

Deno.test("Identity.decrypt - throws for public-only identity", async () => {
  const id = Identity.publicOnly({ signing: "ab".repeat(32) });
  await assertRejects(
    () => id.decrypt({ data: "", ephemeralPublicKey: "", nonce: "" }),
    Error,
    "no encryption private key",
  );
});

// ── Rig tests ──

Deno.test("Rig -with memory backend", async () => {
  const _route31 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route31],
      read: [_route31],
    },
  });
  const health = await rig.status();
  assertEquals(health.status, "healthy");
});

Deno.test("Rig -with pre-built client", async () => {
  const client = memClient();
  const _route32 = connection(client, ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route32],
      read: [_route32],
    },
  });
  const health = await rig.status();
  assertEquals(health.status, "healthy");
});

Deno.test("Identity + Rig - identity can sign for a rig", async () => {
  const id = await Identity.generate();
  assertEquals(id.canSign, true);
  assertEquals(typeof id.pubkey, "string");
});

// Rig.init no longer exists — "rejects no client" test removed
// (constructor requires connections: Connection[] via TypeScript types)

Deno.test("Rig.receive - receives a message", async () => {
  const _route33 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route33],
      read: [_route33],
    },
  });
  const [result] = await rig.receive([["mutable://open/test", {
    hello: "world",
  }]]);
  assertEquals(result.accepted, true);

  const reads = await rig.read(["mutable://open/test"]);
  const read = reads[0];
  assertEquals(read?.[1], { hello: "world" });
});

Deno.test("Rig.read - trailing-slash lists items", async () => {
  const _route36 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route36],
      read: [_route36],
    },
  });
  await rig.receive([["mutable://open/a", 1]]);
  await rig.receive([["mutable://open/b", 2]]);

  const [result] = await rig.read(["mutable://open/"]);
  const entries = result?.[1] as Array<[string, unknown]>;
  assertEquals(entries.length, 2);
});

// rig.delete() no longer exists — removed from ProtocolInterfaceNode

Deno.test("Rig.read - reads multiple URIs", async () => {
  const _route37 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route37],
      read: [_route37],
    },
  });
  await rig.receive([["mutable://open/m1", "a"]]);
  await rig.receive([["mutable://open/m2", "b"]]);

  const results = await rig.read(["mutable://open/m1", "mutable://open/m2"]);
  assertEquals(results.length, 2);
  assertEquals(results.length, 2);
});

Deno.test("Rig.client - exposes underlying client", () => {
  const _route38 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route38],
      read: [_route38],
    },
  });
  assertEquals(typeof rig.client.receive, "function");
  assertEquals(typeof rig.client.read, "function");
});

Deno.test("Rig -multi-client dispatch composes correctly", async () => {
  // Two memory backends — writes should go to both, reads from first match
  const clientA = memClient();
  const clientB = memClient();
  const _route39 = connection(clientA, [
    "mutable://*",
    "immutable://*",
    "hash://*",
    "local://*",
  ]);
  const _route40 = connection(clientB, [
    "mutable://*",
    "immutable://*",
    "hash://*",
    "local://*",
  ]);
  const rig = new Rig({
    routes: {
      receive: [
        _route39,
        _route40,
      ],
      read: [
        _route39,
        _route40,
      ],
    },
  });
  await rig.receive([["mutable://open/multi", "shared"]]);

  const reads = await rig.read(["mutable://open/multi"]);
  const read = reads[0];
  assertEquals(read?.[1], "shared");
});

Deno.test("Rig.status - returns schema keys", async () => {
  const _route41 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route41],
      read: [_route41],
    },
  });
  const status = await rig.status();
  assertEquals(status.status, "healthy");
});

// ── Rig constructor tests ──

Deno.test("Rig -quick connect to memory backend", async () => {
  const _route42 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route42],
      read: [_route42],
    },
  });
  const health = await rig.status();
  assertEquals(health.status, "healthy");
});

Deno.test("Rig -receive and read round-trip", async () => {
  const _route44 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route44],
      read: [_route44],
    },
  });
  await rig.receive([["mutable://open/hello", "world"]]);
  const reads = await rig.read(["mutable://open/hello"]);
  const read = reads[0];
  assertEquals(read?.[1], "world");
});

// ── Identity.canSign / canEncrypt tests ──

Deno.test("Identity.canSign - true for full identity", async () => {
  const id = await Identity.generate();
  assertEquals(id.canSign, true);
});

Deno.test("Identity.canSign - false for public-only identity", () => {
  const publicId = Identity.publicOnly({ signing: "ab".repeat(32) });
  assertEquals(publicId.canSign, false);
});

Deno.test("Identity.canEncrypt - true for full identity", async () => {
  const id = await Identity.generate();
  assertEquals(id.canEncrypt, true);
});

Deno.test("Identity.canEncrypt - false for public-only identity", () => {
  const publicId = Identity.publicOnly({ signing: "ab".repeat(32) });
  assertEquals(publicId.canEncrypt, false);
});

// ── Rig.read multi-URI edge cases ──

Deno.test("Rig.read - handles mix of existing and missing URIs", async () => {
  const _route47 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route47],
      read: [_route47],
    },
  });
  await rig.receive([["mutable://open/yes", "found"]]);

  const results = await rig.read([
    "mutable://open/yes",
    "mutable://open/nope",
  ]);
  // 1:1: hit has payload, miss has undefined payload.
  assertEquals(results.length, 2);
  assertEquals(results[0]?.[0], "mutable://open/yes");
  assertEquals(results[0]?.[1], "found");
  assertEquals(results[1]?.[1], undefined);
});

Deno.test("Rig.read - handles empty URI array", async () => {
  const _route48 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route48],
      read: [_route48],
    },
  });
  const results = await rig.read([]);
  assertEquals(results.length, 0);
});

// readData / readOrThrow / exists / count / watch / watchAll were
// removed from Rig — compose them on top of `rig.read([...])` and
// `rig.observe([...])` at call sites instead.

// rig.delete() no longer exists — Rig.readOrThrow after delete test removed

Deno.test("Rig.read - multi-URI returns data for each", async () => {
  const _route56 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route56],
      read: [_route56],
    },
  });

  await rig.receive([["mutable://open/rdm/a", { name: "Alice" }]]);
  await rig.receive([["mutable://open/rdm/b", { name: "Bob" }]]);

  const results = await rig.read<{ name: string }>([
    "mutable://open/rdm/a",
    "mutable://open/rdm/b",
  ]);

  assertEquals(results.length, 2);
  assertEquals(results[0]?.[1], { name: "Alice" });
  assertEquals(results[1]?.[1], { name: "Bob" });
});

Deno.test("Rig.read - multi-URI marks misses with undefined payload", async () => {
  const _route57 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route57],
      read: [_route57],
    },
  });

  await rig.receive([["mutable://open/rdm2/exists", { ok: true }]]);

  const results = await rig.read([
    "mutable://open/rdm2/exists",
    "mutable://open/rdm2/missing",
  ]);

  // 1:1 with input: hit + miss = 2 slots, miss has undefined payload.
  assertEquals(results.length, 2);
  assertEquals(results[0]?.[0], "mutable://open/rdm2/exists");
  assertEquals(results[0]?.[1], { ok: true });
  assertEquals(results[1]?.[1], undefined);
});

Deno.test("Rig.read - empty array returns empty results", async () => {
  const _route58 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route58],
      read: [_route58],
    },
  });
  const results = await rig.read([]);
  assertEquals(results.length, 0);
});

Deno.test("Rig.read - multi-URI all missing has undefined payloads", async () => {
  const _route59 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route59],
      read: [_route59],
    },
  });
  const results = await rig.read([
    "mutable://open/gone/a",
    "mutable://open/gone/b",
  ]);
  assertEquals(results.length, 2);
  assertEquals(results[0]?.[1], undefined);
  assertEquals(results[1]?.[1], undefined);
});

// ── Rig.deleteMany tests ──

// rig.deleteMany() no longer exists — tests removed

// ── Rig.read trailing-slash (list) tests ──

Deno.test("Rig.read - trailing-slash returns URI strings", async () => {
  const _route61 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route61],
      read: [_route61],
    },
  });
  await rig.receive([["mutable://open/ld/a", 1]]);
  await rig.receive([["mutable://open/ld/b", 2]]);
  await rig.receive([["mutable://open/ld/c", 3]]);

  const [result] = await rig.read(["mutable://open/ld/"]);
  const entries = result?.[1] as Array<[string, unknown]>;
  const uris = entries.map((r) => r[0]);
  assertEquals(uris.length, 3);
  assertEquals(uris.includes("mutable://open/ld/a"), true);
  assertEquals(uris.includes("mutable://open/ld/b"), true);
  assertEquals(uris.includes("mutable://open/ld/c"), true);
});

Deno.test("Rig.read - trailing-slash returns empty for empty prefix", async () => {
  const _route62 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route62],
      read: [_route62],
    },
  });
  const [result] = await rig.read(["mutable://open/nothing-here/"]);
  const entries = result?.[1] as Array<[string, unknown]>;
  assertEquals(entries.length, 0);
});

// ── Rig.read trailing-slash (readAll equivalent) tests ──

Deno.test("Rig.read - trailing-slash reads all data under a prefix", async () => {
  const _route63 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route63],
      read: [_route63],
    },
  });
  await rig.receive([["mutable://open/ra/alice", { name: "Alice" }]]);
  await rig.receive([["mutable://open/ra/bob", { name: "Bob" }]]);

  const [result] = await rig.read<Array<[string, { name: string }]>>([
    "mutable://open/ra/",
  ]);
  const data = new Map(result?.[1] ?? []);
  assertEquals(data.size, 2);
  assertEquals(data.get("mutable://open/ra/alice"), { name: "Alice" });
  assertEquals(data.get("mutable://open/ra/bob"), { name: "Bob" });
});

Deno.test("Rig.read - trailing-slash returns empty Output[] for empty prefix", async () => {
  const _route64 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route64],
      read: [_route64],
    },
  });
  const [result] = await rig.read(["mutable://open/empty-prefix/"]);
  const entries = result?.[1] as Array<[string, unknown]>;
  assertEquals(entries.length, 0);
});

// rig.readAll with delete, readAll with pagination, deleteAll — all removed (delete no longer exists)

Deno.test("readEncrypted - returns null for missing URI", async () => {
  const id = await Identity.generate();
  const _route65 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route65],
      read: [_route65],
    },
  });

  const result = await readEncrypted(id, rig, "mutable://open/enc/missing");
  assertEquals(result, null);
});

Deno.test("readEncrypted - throws for non-encrypted data", async () => {
  const id = await Identity.generate();
  const _route66 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route66],
      read: [_route66],
    },
  });

  // Write plain (unencrypted) data
  await rig.receive([["mutable://open/enc/plain", { not: "encrypted" }]]);

  // readEncrypted should throw since data isn't an EncryptedPayload
  await assertRejects(
    () => readEncrypted(id, rig, "mutable://open/enc/plain"),
    Error,
    "not an EncryptedPayload",
  );
});

Deno.test("readEncrypted many - returns null for missing URIs", async () => {
  const id = await Identity.generate();
  const _route67 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route67],
      read: [_route67],
    },
  });

  // Encrypt and receive one entry directly
  const plaintext = new TextEncoder().encode(JSON.stringify("hello"));
  const encrypted = await id.encrypt(plaintext, id.encryptionPubkey);
  await rig.receive([["mutable://open/enc-batch/exists", encrypted]]);

  const results = await Promise.all([
    readEncrypted<string>(id, rig, "mutable://open/enc-batch/exists"),
    readEncrypted<string>(id, rig, "mutable://open/enc-batch/missing"),
  ]);
  assertEquals(results.length, 2);
  assertEquals(results[0], "hello");
  assertEquals(results[1], null);
});

// ── Rig.info() tests ──

Deno.test("Rig.info - returns behavior info", () => {
  const _route68 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route68],
      read: [_route68],
    },
    hooks: {
      beforeReceive: () => {},
      afterRead: () => {},
    },
    on: {
      "receive:success": [() => {}],
    },
    reactions: {
      // deno-lint-ignore require-await
      "mutable://open/:key": async () => [],
    },
  });

  const info = rig.info();
  assertEquals(info.behavior.hooks.includes("beforeReceive"), true);
  assertEquals(info.behavior.hooks.includes("afterRead"), true);
  assertEquals(info.behavior.events["receive:success"], 1);
  assertEquals(info.behavior.reactors, 1);
});

Deno.test("Rig.info - empty rig has empty behavior", () => {
  const _route69 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route69],
      read: [_route69],
    },
  });

  const info = rig.info();
  assertEquals(info.behavior.hooks.length, 0);
  assertEquals(info.behavior.reactors, 0);
});

// rig.deleteMany() no longer exists — deleteMany missing URIs test removed

Deno.test("Rig.read - trailing-slash empty prefix returns empty ls", async () => {
  const _route70 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route70],
      read: [_route70],
    },
  });
  const [result] = await rig.read(["mutable://open/empty-prefix/"]);
  const entries = result?.[1] as Array<[string, unknown]>;
  assertEquals(entries.length, 0);
});

Deno.test("Rig.read - trailing-slash returns all items under prefix", async () => {
  const _route71 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route71],
      read: [_route71],
    },
  });
  await rig.receive([["mutable://open/coll/a", { v: 1 }]]);
  await rig.receive([["mutable://open/coll/b", { v: 2 }]]);
  await rig.receive([["mutable://open/coll/c", { v: 3 }]]);

  const [result] = await rig.read<Array<[string, { v: number }]>>([
    "mutable://open/coll/",
  ]);
  const entries = result?.[1] ?? [];
  assertEquals(entries.length, 3);
  const data = new Map(
    entries.filter((r) => r?.[1] !== undefined && r[0]).map((
      r,
    ) => [r[0]!, r![1]]),
  );
  assertEquals(data.get("mutable://open/coll/a")?.v, 1);
  assertEquals(data.get("mutable://open/coll/b")?.v, 2);
  assertEquals(data.get("mutable://open/coll/c")?.v, 3);
});

Deno.test("Rig.status - returns healthy for memory backend", async () => {
  const _route72 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route72],
      read: [_route72],
    },
  });
  const health = await rig.status();
  assertEquals(health.status, "healthy");
});

Deno.test("Rig.status - returns schema keys for memory backend", async () => {
  const _route73 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route73],
      read: [_route73],
    },
  });
  const status = await rig.status();
  assertEquals(status.status, "healthy");
});

// ── Program-validated Rig tests ──
// Programs classify messages by URI prefix and can reject via `error`.

// Accept-all program under a prefix that intentionally mismatches the
// "bad" test URIs. Messages under the listed prefixes flow through.
// Messages outside any registered prefix also flow through (unmatched
// URIs are not validated by programs — that's the new default, unlike
// the old schema which rejected unknown prefixes).
//
// Tests that want rejection semantics register an explicit rejecter.
const rejectUnknown: Program = (msg) =>
  Promise.resolve({
    code: "rejected",
    error: `rejected by program: ${msg[0]}`,
  });

Deno.test("Rig - program accepts valid receive", async () => {
  const _route77 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route77],
      read: [_route77],
    },
    programs: createTestPrograms(),
  });

  const [accepted] = await rig.receive([
    ["mutable://open/valid", { ok: true }],
  ]);
  assertEquals(accepted.accepted, true);

  const data = await readData(rig, "mutable://open/valid");
  assertEquals(data, { ok: true });
});

Deno.test("Rig - program can reject by returning error", async () => {
  const _route78 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route78],
      read: [_route78],
    },
    programs: {
      ...createTestPrograms(),
      "mutable://unknown-domain": rejectUnknown,
    },
  });

  const [result] = await rig.receive([
    ["mutable://unknown-domain/x", { bad: true }],
  ]);
  assertEquals(result.accepted, false);
});

Deno.test("Rig - multi-connection dispatch with programs accepts valid", async () => {
  const _route79 = connection(memClient(), [
    "mutable://*",
    "immutable://*",
    "hash://*",
    "local://*",
  ]);
  const rig = new Rig({
    routes: {
      receive: [
        _route79,
        _route79,
      ],
      read: [
        _route79,
        _route79,
      ],
    },
    programs: createTestPrograms(),
  });

  const [accepted] = await rig.receive([
    ["mutable://open/multi-prog", 42],
  ]);
  assertEquals(accepted.accepted, true);

  const data = await readData(rig, "mutable://open/multi-prog");
  assertEquals(data, 42);
});

Deno.test("Rig - multi-connection dispatch with programs rejects via rejecter", async () => {
  const _route80 = connection(memClient(), [
    "mutable://*",
    "immutable://*",
    "hash://*",
    "local://*",
  ]);
  const rig = new Rig({
    routes: {
      receive: [
        _route80,
        _route80,
      ],
      read: [
        _route80,
        _route80,
      ],
    },
    programs: {
      ...createTestPrograms(),
      "mutable://unknown": rejectUnknown,
    },
  });

  const [result] = await rig.receive([["mutable://unknown/x", "nope"]]);
  assertEquals(result.accepted, false);
});

// ── Identity edge cases ──

Deno.test("Identity.fromSeed - empty string is valid seed", async () => {
  const id = await Identity.fromSeed("");
  assertEquals(typeof id.pubkey, "string");
  assertEquals(id.pubkey.length, 64);
});

Deno.test("Identity.verify - rejects wrong pubkey signature", async () => {
  const alice = await Identity.generate();
  const bob = await Identity.generate();
  const payload = { test: "data" };
  const auth = await alice.sign(payload);

  // Bob verifying Alice's signature with Bob's key should fail
  const valid = await bob.verify(payload, auth.signature);
  assertEquals(valid, false);
});

// ── Rig.observe() tests (client-backed streaming) ──

Deno.test({
  name: "Rig.observe - yields matching writes from memory backend",
  async fn() {
    const mem = memClient();
    const _route95 = connection(mem, ["*"]);
    const rig = new Rig({
      routes: {
        receive: [_route95],
        read: [_route95],
        observe: [_route95],
      },
    });

    const abort = new AbortController();
    const seen: string[] = [];

    // Start observing in background
    const done = (async () => {
      for await (
        const ev of rig.observe(["mutable://open/wasub/:key"], abort.signal)
      ) {
        seen.push(ev[1][0]);
        if (seen.length >= 2) abort.abort();
      }
    })();

    // Write two matching values
    await rig.receive([["mutable://open/wasub/a", { v: 1 }]]);
    await rig.receive([["mutable://open/wasub/b", { v: 2 }]]);

    await done;

    assertEquals(seen, ["mutable://open/wasub/a", "mutable://open/wasub/b"]);
  },
});

Deno.test({
  name: "Rig.observe - empty when no connection accepts observe",
  async fn() {
    const _route96 = connection(memClient(), ["*"]);
    const rig = new Rig({
      routes: {
        receive: [_route96],
        read: [_route96],
      },
    });

    const abort = new AbortController();
    const results: unknown[] = [];

    // Should immediately complete (no connection accepts observe)
    abort.abort();
    for await (
      const result of rig.observe(["mutable://open/*"], abort.signal)
    ) {
      results.push(result);
    }

    assertEquals(results.length, 0);
  },
});

Deno.test({
  name: "Rig.observe - merges streams across multiple urls",
  async fn() {
    const mem = memClient();
    const _route97 = connection(mem, ["*"]);
    const rig = new Rig({
      routes: {
        receive: [_route97],
        read: [_route97],
        observe: [_route97],
      },
    });

    const abort = new AbortController();
    const seen: string[] = [];

    const done = (async () => {
      for await (
        const [, uris] of rig.observe(
          ["mutable://app/users/:id", "mutable://app/posts/:id"],
          abort.signal,
        )
      ) {
        seen.push(...uris);
        if (seen.length >= 2) abort.abort();
      }
    })();

    await rig.receive([
      ["mutable://app/users/alice", {}],
      ["mutable://app/posts/p1", {}],
    ]);
    await done;

    assertEquals(seen.sort(), [
      "mutable://app/posts/p1",
      "mutable://app/users/alice",
    ]);
  },
});

// ── Hooks integration tests ──

Deno.test("Rig hooks - beforeReceive throw rejects receive", async () => {
  const _route99 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route99],
      read: [_route99],
    },
    hooks: {
      beforeReceive: () => {
        throw new Error("blocked");
      },
    },
  });

  await assertRejects(
    () => rig.receive([["mutable://open/test", { x: 1 }]]),
    Error,
    "blocked",
  );
});

Deno.test("Rig hooks - beforeReceive mutates context", async () => {
  const _route100 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route100],
      read: [_route100],
    },
    hooks: {
      beforeReceive: (ctx) => ({
        ctx: {
          ...ctx,
          data: {
            ...(ctx.data as Record<string, unknown>),
            injected: true,
          },
        },
      }),
    },
  });

  await rig.receive([["mutable://open/test", { x: 1 }]]);
  const data = await readData(rig, "mutable://open/test");
  assertEquals((data as Record<string, unknown>).injected, true);
});

Deno.test("Rig hooks - afterRead observes result without modifying", async () => {
  const observed: unknown[] = [];
  const _route101 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route101],
      read: [_route101],
    },
    hooks: {
      afterRead: (_ctx, result) => {
        observed.push(result);
      },
    },
  });

  await rig.receive([["mutable://open/test", { x: 1 }]]);
  const results = await rig.read(["mutable://open/test"]);
  const result = results[0];
  assertEquals((result?.[1] as Record<string, unknown>).x, 1);
  assertEquals(observed.length, 1);
});

Deno.test("Rig hooks - afterRead throw propagates to caller", async () => {
  const _route102 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route102],
      read: [_route102],
    },
    hooks: {
      afterRead: () => {
        throw new Error("post-condition failed");
      },
    },
  });

  await rig.receive([["mutable://open/test", { x: 1 }]]);
  await assertRejects(
    () => rig.read(["mutable://open/test"]),
    Error,
    "post-condition failed",
  );
});

// rig.delete() no longer exists — beforeDelete hook test removed

Deno.test("Rig hooks - beforeSend throw rejects send", async () => {
  const _route103 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route103],
      read: [_route103],
    },
    hooks: {
      beforeSend: () => {
        throw new Error("rate limited");
      },
    },
  });

  await assertRejects(
    () => rig.send([["mutable://open/x", { v: 1 }]]),
    Error,
    "rate limited",
  );
});

// ── Events integration tests ──

Deno.test("Rig events - fires on receive success", async () => {
  const events: unknown[] = [];
  const _route104 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route104],
      read: [_route104],
    },
    on: {
      "receive:success": [(e) => {
        events.push(e);
      }],
    },
  });

  await rig.receive([["mutable://open/test", { x: 1 }]]);
  await new Promise((r) => setTimeout(r, 20));

  assertEquals(events.length, 1);
  assertEquals((events[0] as { op: string }).op, "receive");
});

Deno.test("Rig events - fires on receive error (program rejection)", async () => {
  const errors: unknown[] = [];
  const _route105 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route105],
      read: [_route105],
    },
    programs: {
      "mutable://invalid-domain": rejectUnknown,
    },
    on: {
      "receive:error": [(e) => {
        errors.push(e);
      }],
    },
  });

  await rig.receive([["mutable://invalid-domain/test", { x: 1 }]]);
  await new Promise((r) => setTimeout(r, 20));

  assertEquals(errors.length, 1);
});

Deno.test("Rig events - wildcard fires for all ops", async () => {
  const events: unknown[] = [];
  const _route106 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route106],
      read: [_route106],
    },
    on: {
      "*:success": [(e) => {
        events.push(e);
      }],
    },
  });

  await rig.receive([["mutable://open/a", { v: 1 }]]);
  await rig.read(["mutable://open/a"]);
  await new Promise((r) => setTimeout(r, 20));

  assertEquals(events.length, 2);
  assertEquals((events[0] as { op: string }).op, "receive");
  assertEquals((events[1] as { op: string }).op, "read");
});

// ── Reaction integration tests ──

Deno.test("Rig reaction - fires on receive matching pattern", async () => {
  const calls: { uri: string; params: Record<string, string> }[] = [];
  const _route107 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route107],
      read: [_route107],
    },
    reactions: {
      // deno-lint-ignore require-await
      "mutable://open/:key": async (out, _read, params) => {
        calls.push({ uri: out[0], params });
        return [];
      },
    },
  });

  await rig.receive([["mutable://open/hello", { v: 1 }]]);
  await new Promise((r) => setTimeout(r, 20));

  assertEquals(calls.length, 1);
  assertEquals(calls[0].uri, "mutable://open/hello");
  assertEquals(calls[0].params, { key: "hello" });
});

Deno.test("Rig reaction - fires on send for each tuple", async () => {
  const uris: string[] = [];
  const _route108 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route108],
      read: [_route108],
    },
    reactions: {
      // deno-lint-ignore require-await
      "mutable://open/:key": async (out) => {
        uris.push(out[0]);
        return [];
      },
    },
  });

  // rig.send takes Output[] directly — each tuple goes through the
  // pipeline and fires matching reactions.
  await rig.send([
    ["mutable://open/a", { v: 1 }],
    ["mutable://open/b", { v: 2 }],
  ]);
  await new Promise((r) => setTimeout(r, 20));

  assertEquals(uris.length, 2);
  assertEquals(uris.includes("mutable://open/a"), true);
  assertEquals(uris.includes("mutable://open/b"), true);
});

Deno.test("Rig reaction - does not fire on read", async () => {
  let called = false;
  const _route109 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route109],
      read: [_route109],
    },
    reactions: {
      // deno-lint-ignore require-await
      "mutable://open/:key": async () => {
        called = true;
        return [];
      },
    },
  });

  await rig.receive([["mutable://open/test", { v: 1 }]]);
  await new Promise((r) => setTimeout(r, 20));
  called = false; // reset from the receive

  await rig.read(["mutable://open/test"]);
  await new Promise((r) => setTimeout(r, 20));

  assertEquals(called, false);
});

// ── Runtime API tests ──

Deno.test("Rig hooks - immutable after init", () => {
  const _route110 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route110],
      read: [_route110],
    },
    hooks: {
      beforeReceive: () => {},
    },
  });

  // Hooks are frozen — no runtime mutation possible
  // deno-lint-ignore no-explicit-any
  assertEquals(typeof (rig as any).hook, "undefined");
});

Deno.test("Rig.on - runtime event handler works", async () => {
  const _route111 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route111],
      read: [_route111],
    },
  });
  const events: unknown[] = [];

  const unsub = rig.on("receive:success", (e) => {
    events.push(e);
  });

  await rig.receive([["mutable://open/test", { x: 1 }]]);
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(events.length, 1);

  unsub();

  await rig.receive([["mutable://open/test2", { x: 2 }]]);
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(events.length, 1); // no new event
});

Deno.test("Rig.off - removes event handler", async () => {
  const _route112 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route112],
      read: [_route112],
    },
  });
  const events: unknown[] = [];
  const handler = (e: unknown) => {
    events.push(e);
  };

  rig.on("receive:success", handler);
  await rig.receive([["mutable://open/a", { v: 1 }]]);
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(events.length, 1);

  rig.off("receive:success", handler);
  await rig.receive([["mutable://open/b", { v: 2 }]]);
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(events.length, 1);
});

Deno.test("Rig.reaction - runtime react works", async () => {
  const _route113 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route113],
      read: [_route113],
    },
  });
  const calls: string[] = [];

  // deno-lint-ignore require-await
  const unsub = rig.reaction("mutable://open/:key", async (out) => {
    calls.push(out[0]);
    return [];
  });

  await rig.receive([["mutable://open/hello", { v: 1 }]]);
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(calls.length, 1);

  unsub();

  await rig.receive([["mutable://open/world", { v: 2 }]]);
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(calls.length, 1); // no new call
});

// ── Per-operation connection routing tests ──

Deno.test("Rig connections - per-op routing uses separate backends", async () => {
  const writeClient = memClient();
  const readClient = memClient();

  // Write some data to readClient directly
  await readClient.receive([["mutable://open/cached", { from: "cache" }]]);

  const _route114 = connection(writeClient, [
    "mutable://*",
    "immutable://*",
    "hash://*",
  ]);
  const _route115 = connection(readClient, [
    "mutable://*",
    "immutable://*",
    "hash://*",
  ]);
  const rig = new Rig({
    routes: {
      receive: [_route114],
      read: [_route115],
    },
  });

  // Read should come from readClient
  const data = await readData(rig, "mutable://open/cached");
  assertEquals((data as Record<string, unknown>).from, "cache");

  // Receive should go to writeClient
  await rig.receive([["mutable://open/new", { from: "write" }]]);
  await writeClient.read(["mutable://open/new"]);

  // readClient should NOT have the write
  await readClient.read(["mutable://open/new"]);
});

Deno.test("Rig - programs still work with hooks", async () => {
  const _route116 = connection(memClient(), ["*"]);
  const rig = new Rig({
    routes: {
      receive: [_route116],
      read: [_route116],
    },
    programs: {
      ...createTestPrograms(),
      "mutable://invalid": rejectUnknown,
    },
    hooks: {
      afterReceive: () => {}, // observer hook
    },
  });

  const [r1] = await rig.receive([["mutable://open/test", { v: 1 }]]);
  assertEquals(r1.accepted, true);

  const [r2] = await rig.receive([["mutable://invalid/test", { v: 1 }]]);
  assertEquals(r2.accepted, false);
});

// No hook chain replacement test — hooks are immutable after init.

Deno.test("Rig dispatch - status returns healthy for multi-client", async () => {
  const c1 = memClient();
  const c2 = memClient();

  await c1.receive([["mutable://open/x", "data"]]);
  await c2.receive([["hash://sha256/abc", "data"]]);

  const _route117 = connection(c1, ["mutable://*"]);
  const _route118 = connection(c2, ["hash://*"]);
  const rig = new Rig({
    routes: {
      receive: [
        _route117,
        _route118,
      ],
      read: [
        _route117,
        _route118,
      ],
    },
  });

  const status = await rig.status();
  assertEquals(status.status, "healthy");
});
