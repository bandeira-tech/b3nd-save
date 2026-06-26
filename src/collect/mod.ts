/**
 * Buffered-bytes wiring for `SaveClient`.
 *
 * `SaveClient.read` over `BYTES_ENTITY` returns
 * `Output<Uint8Array | ReadableStream<Uint8Array>>` — the underlying
 * store chooses the natural payload shape (memory/pg buffer; fs/s3/ipfs
 * may stream). This sub-export gives a host two ways to opt into
 * uniform `Uint8Array` payloads at the rig boundary:
 *
 * - {@link collectBytes} — normalize a single read row.
 * - {@link BufferedSaveClient} — a `ProtocolInterfaceNode` wrapper that
 *   normalizes every row of every `read` call.
 *
 * Neither changes the wire contract, the store contract, or
 * `SaveClient` itself. They are explicit host-side wiring choices,
 * documented at the rig-host layer where the cost (full materialization
 * in memory) is paid honestly.
 *
 * Background: ratified in the payload-shape contract round
 * (`immutable://open/cc-chat/20260624224342-payload-contract/`).
 */

import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import type { SaveClient } from "../clients/save-client.ts";
import type { StorePayload } from "../types.ts";

/**
 * Normalize a single `read` row whose payload is the bytes/stream
 * union to `Uint8Array`. Null payloads pass through unchanged. Other
 * shapes throw — there is no silent JSON coercion at this boundary.
 *
 * @throws TypeError if the payload is neither bytes, stream, nor null.
 */
export async function collectBytes<U extends string = string>(
  output: Output<StorePayload | null>,
): Promise<Output<Uint8Array | null>> {
  const [uri, payload] = output;
  if (payload === null || payload === undefined) {
    return [uri, null] as Output<Uint8Array | null>;
  }
  if (payload instanceof Uint8Array) {
    return [uri, payload] as Output<Uint8Array | null>;
  }
  if (
    typeof payload === "object" &&
    typeof (payload as ReadableStream<Uint8Array>).getReader === "function"
  ) {
    const ab = await new Response(payload as ReadableStream<Uint8Array>)
      .arrayBuffer();
    return [uri, new Uint8Array(ab)] as Output<Uint8Array | null>;
  }
  throw new TypeError(
    "collectBytes: payload is not bytes-or-stream (got " +
      (payload === null ? "null" : typeof payload) +
      ")",
  );
}

/**
 * `ProtocolInterfaceNode` wrapper that normalizes every `read` row's
 * payload to `Uint8Array` via {@link collectBytes}. Use when the rig
 * host knows its payloads fit in memory and wants a uniform
 * round-trip — `receive(bytes) → read(uri) → bytes`, always.
 *
 * `receive`, `observe`, `status` delegate to the inner client
 * unchanged.
 *
 * **Cost.** Streams are materialized in full at `read` time. A 2 GB
 * file read becomes a 2 GB `Uint8Array` allocation; V8 caps near 4 GB
 * on 64-bit, and worker/edge runtimes typically fail earlier. Mounting
 * this wrapper is an explicit, named declaration that the host is
 * willing to pay that cost.
 *
 * **What it isn't.** Not a default. `SaveClient` keeps the union; hosts
 * who don't mount `BufferedSaveClient` get the natural per-store shape
 * (bytes from memory/pg/sqlite, streams from fs/s3/ipfs).
 */
// deno-lint-ignore no-explicit-any
type AnySaveClient = SaveClient<any>;

export class BufferedSaveClient implements ProtocolInterfaceNode {
  private readonly inner: AnySaveClient;

  constructor(inner: AnySaveClient) {
    this.inner = inner;
  }

  async read<T = Uint8Array | null>(urls: string[]): Promise<Output<T>[]> {
    const rows = await this.inner.read<StorePayload | null>(urls);
    const normalized = await Promise.all(
      rows.map((row) => collectBytes(row as Output<StorePayload | null>)),
    );
    return normalized as unknown as Output<T>[];
  }

  receive<TIn = unknown>(
    msgs: Output<TIn | null>[],
  ): Promise<ReceiveResult[]> {
    return this.inner.receive(msgs as Output<unknown | null>[]);
  }

  observe(
    locators: string[],
    signal: AbortSignal,
  ): AsyncIterable<readonly string[]> {
    return this.inner.observe(locators, signal);
  }

  status(): Promise<StatusResult> {
    return this.inner.status();
  }
}
