/**
 * Shared test helper — null-aware ProtocolInterfaceNode backed by an
 * in-memory store, provisioned for `BYTES_ENTITY` and wrapped in
 * `JsonClient` so tests can pass arbitrary JSON payloads through the
 * bytes-only Save layer underneath.
 *
 * Async by design: provisioning is the caller's job in this codebase
 * and we don't paper over that with a sync-shaped escape hatch. Tests
 * `await memClient()` exactly like production code awaits store setup.
 */

import { mapToBytes, SaveClient } from "../../src/clients/save-client.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { BYTES_ENTITY } from "../../src/entity.ts";
import { JsonClient } from "./json-client.ts";

export async function memClient(): Promise<JsonClient> {
  const store = new MemoryStore();
  await store.provisionEntity(store.entitySupport(BYTES_ENTITY));
  return new JsonClient(new SaveClient(mapToBytes, BYTES_ENTITY, store));
}
