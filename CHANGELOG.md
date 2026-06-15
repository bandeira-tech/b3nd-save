# Changelog

## 0.8.1 — `SqliteStore.status()` reports provisioned schemas

- `SqliteStore.provisionEntity(meta)` now records `meta.schema.name` when
  the schema is the supported one (`BYTES_ENTITY`); `status().schema` lists
  every recorded entity as `entity:<name>`, mirroring `MemoryStore`.
- Non-bytes schemas remain silently un-provisioned at the storage layer
  (the shim already returns "Unsupported schema" on `write`/`read`) and
  are intentionally omitted from `status().schema` so callers don't think
  they have a usable surface.
- Idempotent — provisioning the same schema twice does not duplicate.

This unblocks UIs (e.g. `b3nd-web-rig`) that build their navigation root
from `rig.status().schema`. Other backends with empty `schema: []` (s3, fs,
postgres, mongo, elasticsearch, indexeddb, localstorage) are unchanged in
this release.

## 0.7.0 — Atomic batches, structured errors, streaming payload

Three contract-level changes land together: writes that advertise atomicity
actually enforce it, write/delete failures carry structured `B3ndError` codes,
and `payload` accepts a `ReadableStream<Uint8Array>` in addition to `Uint8Array`
so large objects can flow through fs/s3/ipfs without buffering.

### Breaking — `StoreEntry.payload` widens to a union

- `payload: Uint8Array` → `payload: Uint8Array | ReadableStream<Uint8Array>`
  (`StorePayload` is exported from the root and from
  `@bandeira-tech/b3nd-save`).
- Buffered backends (memory, postgres, sqlite, mongo, indexeddb, localstorage,
  elasticsearch) collect any incoming stream to bytes before storing and still
  return `Uint8Array` on read.
- Streamer backends keep streams end-to-end. `read` on `fs` / `s3` / `ipfs` now
  returns `ReadableStream<Uint8Array>` so large objects never need to fit in
  memory. Callers that want bytes regardless can use the exported
  `toBytes(payload)` helper (or `await new Response(payload).bytes()`).
- `SimpleClient.receive` accepts `Message<StorePayload>[]`;
  `DataStoreClient.receive` accepts `Message<StorePayload | null>[]` (`null`
  still signals delete).

### Breaking — `atomicBatch: true` now means what it says

- `PostgresStore` and `SqliteStore` wrap batch `write` and `delete` loops in the
  executor's `transaction` primitive. The whole batch commits or none of it
  does. On failure every result is `{ success: false }` with the same root-cause
  error.
- Previously these advertised the flag but issued N independent statements with
  no transaction wrapping. UTXO-style message batches relying on the flag could
  observe partially-applied batches on mid-batch failure.
- Backends that don't advertise the flag keep per-entry best-effort semantics —
  unchanged.

### Non-breaking — structured errors on write/delete

- `StoreWriteResult` gains `errorDetail?: B3ndError` (mirrors what
  `DeleteResult` already had). Failures carry `code: "STORAGE_ERROR"`, the
  driver's message, and the failing `uri` when the failure attributes to a
  single entry.
- The `error: string` field stays for human-readable logs; existing consumers
  reading only that field don't break.
- New `storageFailure(err, fallback, uri?)` helper in
  `@bandeira-tech/b3nd-save/shared` translates a thrown executor error into the
  structured shape — backend authors should use it in catch blocks to stay
  consistent.

### Shared helpers added

- `toBytes(payload)` / `toStream(payload)` — payload normalizers.
- `storageFailure(err, fallback, uri?)` — structured-failure builder.

### Notes for backend authors

- The `binaryData` capability flag is gone for good (was already removed in
  0.6.0). Every backend handles bytes; nothing else to advertise.
- The empty-batch case (`write([])` / `delete([])`) now short-circuits to an
  empty result without touching the executor.

## 0.6.0 — `Store` is local; bytes-only payload; drop the JSON envelope

The framework no longer treats `Store` as a core concept. The interface and its
supporting types move into b3nd-save itself; clients (`SimpleClient`,
`DataStoreClient`) are the only seam through which the rest of b3nd sees
storage. Companion release: `@bandeira-tech/b3nd-core@0.18.0` (which removes
`Store` / `StoreEntry` / `StoreWriteResult` / `StoreCapabilities` from
`b3nd-core/types`).

### Breaking — `Store` types move out of core

- `Store`, `StoreEntry`, `StoreWriteResult`, `StoreCapabilities` are now defined
  in `src/types.ts` of this package and re-exported from the root. Imports that
  came from `@bandeira-tech/b3nd-core/types` need to switch to
  `@bandeira-tech/b3nd-save` (or `@bandeira-tech/b3nd-save/clients` for the
  client-side).
- Bumps the core dep to `^0.18.0`.

### Breaking — bytes-only payload

- `StoreEntry.payload: Uint8Array` (was `StoreEntry.data: unknown`). The `Store`
  is mechanical byte storage — no JSON, no envelope walker, no kind
  discriminators. Higher layers own serialization.
- Each backend uses its most natural byte primitive:
  - **Postgres** — `BYTEA` column.
  - **SQLite** — `BLOB` column.
  - **MongoDB** — BSON `Binary`.
  - **Filesystem** — raw file bytes (`.bin` extension).
  - **S3** — raw object body with `application/octet-stream` content type
    (`.bin` key suffix).
  - **IPFS** — raw block bytes.
  - **Elasticsearch** — base64 string in a regular field (ES has no native
    `_source`-round-tripping binary type).
  - **LocalStorage** — base64 string.
  - **Memory** / **IndexedDB** — `Uint8Array` directly (native).
- Schema versions: PostgreSQL → `v3.0.0`. SQLite schema reshaped to a single
  `payload BLOB NOT NULL` column.

### Breaking — `src/shared/binary.ts` removed

- The recursive `__b3nd_binary__` JSON envelope walker (`encodeBinaryForJson` /
  `decodeBinaryFromJson`) is gone. Callers who need to round-trip JSON through
  the store should encode/decode themselves (e.g.
  `TextEncoder().encode(JSON.stringify(...))`).
- The root `* as shared` namespace re-export is dropped. The `/shared` subpath
  stays for the backend-author helpers (`dispatchRead`, `validateReadParams`,
  `applyReadParams`).

### Breaking — `StoreCapabilities.binaryData` removed

- Every backend handles bytes now, so the flag conveyed nothing.

### Tooling

- Test-only `JsonClient` helper in `tests/helpers/json-client.ts` — wraps a
  bytes-only client with JSON encode/decode for integration tests that want to
  keep arbitrary-shape payloads. Not exported from the package; production code
  should encode/decode on its own terms.

## 0.5.0 — Rename to `@bandeira-tech/b3nd-save`, `src/` layout, zero built-in protocols

Public-release preparation. The package is renamed from `b3nd-stores` to
`b3nd-save` to reflect what it actually covers — not just stores, but the whole
data-saving layer: backends, Store→Client adapters, the URL-based backend
factory, and the shared helpers backend authors need to stay on contract.

### Breaking — package rename

- `@bandeira-tech/b3nd-stores` → `@bandeira-tech/b3nd-save`. Update every import
  path: `jsr:@bandeira-tech/b3nd-stores/postgres` becomes
  `jsr:@bandeira-tech/b3nd-save/postgres`, and so on.

### Breaking — layout

- All module source moved under `src/`. The published export map is unchanged in
  shape except for the renames below; consumers who use the documented subpaths
  (`/postgres`, `/mongo`, …) are unaffected by the move itself, only by the
  package rename.

### Breaking — export renames

- `/adapters` → `/clients`. `SimpleClient` and `DataStoreClient` move to
  `@bandeira-tech/b3nd-save/clients`. The reframing: these are _clients_ that
  turn `ProtocolInterfaceNode` actions into Store actions, not generic
  "adapters."
- `_shared` (internal) is promoted to public as `/shared`. Backend authors
  building a custom `Store` should import `encodeBinaryForJson`,
  `applyReadParams`, `dispatchRead` from there to stay consistent with the
  contract every built-in backend follows.

### Breaking — MemoryStore now follows the shallow ls/count contract

- `MemoryStore.read` with `fn=ls` and `fn=count` is now **shallow direct-leaves
  only**, matching every other backend in this package. Previously it walked
  recursively. Code that relied on the deep walk must call `ls` per level to
  recurse.
- `MemoryStore` now runs against the same shared test suite as every other
  backend; the contract is enforced uniformly across all ten implementations.

### Breaking — factory has no built-in protocols

- `memory://` is no longer a built-in scheme in the factory. Every backend,
  memory included, registers via `BackendResolver[]`. Apps that relied on
  `createStoreFromUrl("memory://...")` working out-of-the-box must now pass a
  memory resolver alongside their other backends.
- `getSupportedProtocols()` returns only what the caller registered.
- The factory itself no longer imports `MemoryStore`, so consumers using only
  `/factory` no longer pay the memory backend's footprint.

### New — root export

- `import { postgres, clients, factory } from "@bandeira-tech/b3nd-save"` now
  works. The root barrel re-exports every subpath as a namespace — convenient
  for discoverability. Footprint-aware consumers should keep using the narrow
  subpath imports; the namespaced barrel is opt-in.

### Migration

```diff
- import { PostgresStore } from "jsr:@bandeira-tech/b3nd-stores/postgres";
- import { SimpleClient } from "jsr:@bandeira-tech/b3nd-stores/adapters";
- import { createStoreFromUrl } from "jsr:@bandeira-tech/b3nd-stores/factory";
+ import { PostgresStore } from "jsr:@bandeira-tech/b3nd-save/postgres";
+ import { SimpleClient } from "jsr:@bandeira-tech/b3nd-save/clients";
+ import { createStoreFromUrl, type BackendResolver } from "jsr:@bandeira-tech/b3nd-save/factory";
+ import { MemoryStore } from "jsr:@bandeira-tech/b3nd-save/memory";
+
+ const memoryResolver: BackendResolver = {
+   protocols: ["memory:"],
+   resolve: () => new MemoryStore(),
+ };
+ const store = await createStoreFromUrl("memory://", { backends: [memoryResolver] });
```

## 0.4.0 — Absorb `MemoryStore`, Store→Client adapters, and the backend factory

Cross-repo move from `@bandeira-tech/b3nd-core`. After this release,
`b3nd-stores` is the single home for Store implementations _and_ the adapters
that put them behind `ProtocolInterfaceNode`.

### New exports

- **`/memory`** — `MemoryStore`. Recursive in-memory reference Store. Tenth
  backend; deliberately the only one not following the shallow ls/count contract
  (see README).
- **`/adapters`** — `SimpleClient`, `DataStoreClient`. The Store→Client adapter
  classes formerly in `@bandeira-tech/b3nd-core`.
- **`/factory`** — `createStoreFromUrl`, `createClientFromUrl`,
  `createStoreResolver`, `createClientResolver`, `getSupportedProtocols`,
  `BackendResolver`, `BackendFactoryOptions`, `StoreClientConstructor`. Backend
  resolution by URL scheme. Built-in storage scheme: `memory://`. Transport
  schemes (`https://`, `wss://`, `console://`) and the `SimpleClient` default
  client wrapper still come from `@bandeira-tech/b3nd-core/...`.

### Coordinated breaking change in `b3nd-core` (`@^0.16.0`)

The same release removes `MemoryStore`, `SimpleClient`, `DataStoreClient`, and
the backend factory from `@bandeira-tech/b3nd-core`. Anything that used to
import them from core should now import them from
`@bandeira-tech/b3nd-stores/{memory,adapters,factory}`.

### Integration tests live here now

Tests that exercise _framework + Store together_ (rig+memory dispatch,
network/peer behaviour, the backend factory's URL resolution) moved from
`b3nd-core` into `_integration/` here. They run alongside the unit suite. Core's
own tests now use the new `RecordingClient` for dispatch-level verification.

## 0.3.0 — Store contract migration to `b3nd-core@0.15`

**Breaking across every backend.** This release rewrites all nine stores against
the new `Store` contract from `@bandeira-tech/b3nd-core@^0.15.0`.

### Contract changes (apply to every store)

- **Tuple output.** `Store.read()` now returns `Output<T> = [uri, payload]`
  tuples, 1:1 with the input urls. The previous
  `{ success, record: { data,
  values } }` envelope is gone. Misses are encoded
  in the payload — package-wide convention is `payload === undefined`.
- **URLs, not URIs.** `read()` accepts urls (uri + query string). The function
  to run (`fn=read` / `fn=ls` / `fn=count` / `fn=x-…`) and the standard
  parameters (`limit`, `page`, `sortBy`, `sortOrder`, `format`, `pattern`,
  `cursor`) come from the query string. See `@bandeira-tech/b3nd-core/url`.
- **`fn=ls` and `fn=count` are shallow direct-leaves only.** Entries whose URI
  is `prefix + <segment>` with no further `/` are surfaced; subtree-only paths
  are absent. Diverges from the recursive `MemoryStore` reference — this is
  uniform across all nine backends so clients can reason about ls behaviour
  once. Clients that want recursion call `ls` repeatedly.
- **Strict params.** `pattern` and `cursor` throw "not supported" everywhere in
  this release. Unknown `sortBy` or `format` throws too. The previous
  silent-no-op behaviour is gone.
- **`fn=count` returns a number.** Number of direct leaves under the prefix.
- **`format=uris` fast path.** `fn=ls&format=uris` returns `string[]` instead of
  `Output[]`. Every store skips fetching payload bodies in this mode — matters
  most for s3, ipfs, fs, indexeddb, and elasticsearch (`_source: false`).
- **`StoreEntry.values` removed.** `StoreEntry` is now `{ uri, data }`.
- **`status().fns`** advertises the supported read functions, e.g.
  `["read","ls","count"]`. Rigs can validate caller requests against this.

### Per-backend breaking changes

| Store             | What broke                                                                                                                                                         | Migration                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| **postgres**      | Schema drops the `values` JSONB column from the data table and `by_program` view                                                                                   | `ALTER TABLE <prefix>_data DROP COLUMN "values"; DROP VIEW <prefix>_data_by_program; …` then regenerate with `generatePostgresSchema()` |
| **sqlite**        | Schema drops the `"values"` TEXT column from the data table                                                                                                        | `ALTER TABLE <prefix>_data DROP COLUMN "values"` (sqlite ≥ 3.35) or recreate the table                                                  |
| **mongo**         | `MongoExecutor.countDocuments` and `.deleteOne` are now required (were optional); `findMany` gains optional `projection: Record<string, 0 \| 1>`                   | Implement the two required methods on custom executors; existing real-driver wrappers already satisfy the surface                       |
| **elasticsearch** | `ElasticsearchExecutor.count` is new and required; `.delete` is now required (was optional); `search` returns `_source` as optional                                | Implement `count` (maps to `_count` endpoint) and `delete` on custom executors                                                          |
| **fs**            | File body simplified from `{ values, data }` envelope to top-level encoded payload; `FsExecutor.listFiles` is now documented to return **direct-child files only** | Greenfield only — existing files won't parse. Rewrite or migrate offline                                                                |
| **s3**            | Object body simplified from `{ values, data }` envelope to top-level encoded payload                                                                               | Greenfield only — existing objects won't parse                                                                                          |
| **ipfs**          | Pinned content body simplified from `{ values, data }` envelope to top-level encoded payload                                                                       | Greenfield only — existing pins won't parse                                                                                             |
| **indexeddb**     | `StoredRecord` schema drops the `values` field; new optional `IDBKeyRange` constructor parameter; `capabilities().binaryData` is now `true`                        | Recreate the IndexedDB store; pass `IDBKeyRange` if injecting a mock factory                                                            |
| **localstorage**  | Value body simplified to JSON-stringified encoded payload (no envelope)                                                                                            | Greenfield only                                                                                                                         |

### Internal & infra

- New `_shared/` helpers: `dispatchRead`, `validateReadParams`,
  `applyReadParams`, `encodeBinaryForJson` / `decodeBinaryFromJson` (replacing
  the helpers that were removed from `b3nd-core@0.15`).
- Shared test suite (`_testing/shared-store-suite.ts`) rewritten against the new
  contract. Every store passes 32 tests against an in-memory mock; real backend
  integrations run in CI for postgres, mongo, sqlite, fs, ipfs, s3.
- `indexeddb` unit tests now run in Deno via `npm:fake-indexeddb@5`.
- `s3` integration suite isolates tests with a unique per-test key prefix.
- No `elasticsearch` integration test yet; no real-browser test for `indexeddb`
  or `localstorage` yet — both planned as follow-ups.

## 0.2.0 and earlier

Predates this changelog. See git history.
