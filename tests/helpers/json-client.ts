/**
 * JsonClient — test-only wrapper that adds JSON encoding/decoding to
 * any bytes-only `ProtocolInterfaceNode`.
 *
 * The Save layer is bytes-only by design (Stores never inspect
 * content), but the integration tests in this folder predate that
 * decision and pass arbitrary JSON values around. This wrapper
 * encodes user payloads to JSON bytes on `receive` and decodes them
 * on `read`, so the tests can keep their existing shape while still
 * exercising the new bytes-only Store contract underneath.
 *
 * Production code should NOT use this — apps that want JSON ergonomics
 * roll their own thin wrapper on top of the bytes layer.
 */

import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";

const enc = new TextEncoder();
const dec = new TextDecoder();

function encodePayload(value: unknown): Uint8Array | null {
  if (value === null) return null;
  return enc.encode(JSON.stringify(value));
}

function decodePayload(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value instanceof Uint8Array) {
    try {
      return JSON.parse(dec.decode(value));
    } catch {
      return undefined;
    }
  }
  // `fn=ls&format=full` returns an `Output[]` whose payloads are
  // themselves bytes — walk one level so nested bytes get decoded too.
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (Array.isArray(entry) && entry.length === 2) {
        return [entry[0], decodePayload(entry[1])];
      }
      return entry;
    });
  }
  return value;
}

export class JsonClient implements ProtocolInterfaceNode {
  constructor(private readonly inner: ProtocolInterfaceNode) {}

  receive(msgs: Output[]): Promise<ReceiveResult[]> {
    const encoded = msgs.map(
      ([uri, payload]) =>
        [uri, encodePayload(payload)] as Output<Uint8Array | null>,
    );
    return Promise.resolve(this.inner.receive(encoded));
  }

  async read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
    const raw = await this.inner.read<unknown>(urls);
    return raw.map((
      [uri, payload],
    ): Output<T> => [uri, decodePayload(payload) as T]);
  }

  observe(
    urls: string[],
    signal: AbortSignal,
  ): AsyncIterable<readonly string[]> {
    return this.inner.observe(urls, signal);
  }

  status(): Promise<StatusResult> {
    return this.inner.status();
  }
}
