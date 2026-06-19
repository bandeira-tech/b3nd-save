# Changelog

## 0.12.1 — Push `?sortBy=<field>` down to the query engine

Completes the push-down matrix. The four backends with a real query engine now
translate `sortBy=<field>` directly into their native sort clause:

| Backend       | Push-down                                                |
| ------------- | -------------------------------------------------------- |
| Postgres      | `ORDER BY "<field>" ASC\|DESC`                           |
| SQLite        | same                                                     |
| Mongo         | `options.sort = { [field]: 1 \| -1 }`                    |
| Elasticsearch | `body.sort = [{ "<field>[.keyword]": "asc" \| "desc" }]` |

Each backend gates on `meta.declared.has(sortBy)` so unknown field names fall
through to no-sort instead of SQL-injecting or emitting a backend error.
`sortBy="uri"` continues to sort on the implicit URI / path column.

Elasticsearch picks the sort target based on the field's declared canonical tag
— text-ish (string, base64 bytes, decimal bigint, ISO timestamp) hit `.keyword`
since ES 8+ disables `fielddata` on `text` by default; numeric / boolean fields
sort directly; `json` fields aren't sortable in ES and dispatch's post-sort
handles them as a fallback contract.

Behaviour is unchanged from the caller's perspective — dispatch already handled
`sortBy=<field>` via post-sort in 0.12.0. This is the perf optimisation that
lets indexed backends use their native sort path instead of buffering the full
result into JS first.

### Full push-down coverage — now complete

| Backend                                   | Pattern              | Cursor               | sortBy=<field>     |
| ----------------------------------------- | -------------------- | -------------------- | ------------------ |
| Postgres                                  | SQL `LIKE … ESCAPE`  | `AND uri >/< $N`     | `ORDER BY`         |
| SQLite                                    | same                 | `AND uri >/< ?`      | `ORDER BY`         |
| Mongo                                     | `$regex` on `uri`    | `$gt`/`$lt`          | `$sort`            |
| Elasticsearch                             | Lucene `regexp`      | `bool.must` `range`  | `sort: [...]`      |
| Memory                                    | in-memory            | in-memory            | in-memory          |
| fs / ipfs / s3 / localstorage / indexeddb | dispatch post-filter | dispatch post-filter | dispatch post-sort |

762 unit tests on main.

## 0.12.0 — `?sortBy=<field>` sort by record field

The last standard ReadParams to lift its uri-only restriction. `sortBy` now
accepts any record field name; dispatch post-sorts uniformly so every backend
supports it without per-backend changes:

```
mutable://users/?fn=ls&sortBy=age              # ascending by age
mutable://users/?fn=ls&sortBy=age&sortOrder=desc
mutable://users/?fn=ls&sortBy=name&limit=10
```

`format=uris` with a non-uri `sortBy` still works — dispatch forces
`format=full` in the handler call (records are needed to read the sort key) and
strips back to URIs after sorting. Pagination, pattern, cursor, and projection
all compose with the post-sort.

### Canonical comparator

New `compareSortable(a, b)` in `src/read.ts`:

- numbers / bigints compare numerically
- `Date` via `valueOf()`
- booleans as `false < true`
- strings via `localeCompare`
- `undefined` / `null` sort last
- heterogeneous types fall back to string coercion (never throws)

### Push-down (opt-in for the future)

`ReadHandlers.pushDownSortBy: true` is the opt-in flag, parallel to
`pushDownPattern` / `pushDownCursor`. None of the backends opts in yet — every
backend uses the dispatch-layer post-sort. SQL / Mongo / ES push-down (ORDER BY
column / `$sort` / `sort[]`) can land later as a perf optimisation; the contract
is fixed.

`MemoryStore` (which has its own switch instead of routing through dispatch)
sorts by field explicitly using the same `compareSortable`.

### Read+url?fn surface, every standard param uniform on every backend

```
mutable://users/                              # default fn=ls
mutable://users/?fn=count                      # count
mutable://users/?fn=ls&limit=10&page=2         # page pagination
mutable://users/?fn=ls&cursor=users/b&limit=2  # cursor pagination
mutable://users/?fn=ls&sortBy=age&sortOrder=desc
mutable://users/?fn=ls&pattern=al*             # URI-tail glob filter
mutable://users/?fn=ls&fields=name,age         # record projection
mutable://users/alice?fields=name              # point read + projection
```

### Test coverage

Unit-test count: 754 → 762. New `compareSortable` unit tests covering each type
branch; `applyReadParams` test for `sortBy=<field>`; `MemoryStore` tests for
`sortBy=age` and `sortBy=age&sortOrder=desc`; shared store suite's
`ls throws on unsupported sortBy` test replaced with
`ls accepts sortBy=<field> without throwing` across every backend.

## 0.11.1 — Push `?cursor=…` down to the query engine

The 0.11.0 cursor shipped via a dispatch-layer post-filter so the contract was
uniform across every backend. This patch adds opt-in push-down for the backends
with a real query engine — the cursor combines with the active sort order and
drops straight into their native filter language:

| Backend       | Push-down                                    |
| ------------- | -------------------------------------------- |
| Postgres      | `AND uri > $cursor` (or `<` for desc)        |
| SQLite        | same (`@db/sqlite` parameter binding)        |
| Mongo         | `{ uri: { ..., $gt: cursor } }` (or `$lt`)   |
| Elasticsearch | `bool.must` adding `range` on `path.keyword` |

`count` returns to a native indexed count on these backends instead of the
list-then-length fallback. Backends without a query engine (fs, ipfs, s3,
localstorage, indexeddb, memory) keep the dispatch post-filter — same semantics,
fewer hops.

Backends opt in via `ReadHandlers.pushDownCursor: true` (parallel to
`pushDownPattern`); dispatch inspects each flag per call so the choice is
per-store, not per-URL.

### Full push-down coverage matrix

| Backend                                   | Pattern                           | Cursor                                  |
| ----------------------------------------- | --------------------------------- | --------------------------------------- |
| Postgres                                  | SQL `LIKE … ESCAPE '\\'`          | `AND uri >/< $N`                        |
| SQLite                                    | SQL `LIKE … ESCAPE '\\'`          | `AND uri >/< ?`                         |
| Mongo                                     | `$regex` on `uri`                 | `$gt`/`$lt` on `uri`                    |
| Elasticsearch                             | Lucene `regexp` on `path.keyword` | `bool.must` + `range` on `path.keyword` |
| Memory                                    | in-memory regex on tail           | in-memory `localeCompare`               |
| fs / ipfs / s3 / localstorage / indexeddb | dispatch post-filter              | dispatch post-filter                    |

754 unit tests on main.

## 0.11.0 — `?cursor=…` for stateless pagination

Closes the last standard ReadParams gap. Every backend now honours
`?cursor=<uri>` on `fn=ls` and `fn=count` — returning entries strictly past the
cursor under the active sort order:

```
store://users/?fn=ls&format=uris&limit=2          # users/a, users/b
store://users/?fn=ls&format=uris&limit=2&cursor=users/b
                                                  # users/c, users/d
```

The cursor is just the URI of the last entry from the previous page — no opaque
token format, no server-side state. Works alongside `format`, `fields`,
`pattern`, `sortBy=uri`, `sortOrder`. Combining cursor with `page` throws
(they're alternative pagination modes; the check is enforced in `dispatchRead`
up front).

For `count` with cursor: returns the number of entries past the cursor — the
natural answer to "how many more after this point". Combines with `pattern` for
a filtered remainder count.

### Where it lives

`dispatchRead` handles cursor uniformly so every backend that routes through it
inherits the new behaviour without changes. `MemoryStore` (the only one with its
own switch) honours cursor explicitly via the same `localeCompare` semantics
dispatch uses, keeping the result identical regardless of backend choice.

### Full read+url?fn surface, now uniform across every backend

```
mutable://users/                                  # default fn=ls
mutable://users/?fn=count                          # count
mutable://users/?fn=ls&format=uris&limit=10        # paginated URIs
mutable://users/?fn=ls&pattern=al*                 # URI-tail glob
mutable://users/?fn=ls&fields=name,age             # projection
mutable://users/?fn=ls&cursor=users/b&limit=2      # cursor pagination
mutable://users/alice?fields=name                  # point read + projection
```

### Test coverage

Unit-test count: 730 → 754. The shared store suite gains `ls honours cursor=`
and `ls rejects cursor= combined with page=` cases that run against every
backend; `applyReadParams` gets direct unit tests for the cursor filter and the
combo-throw.

## 0.10.1 — Push `?pattern=…` down to the query engine

The 0.10.0 pattern filter shipped via a dispatch-layer post-filter so the
contract was uniform across every backend. This patch adds opt-in push-down for
the backends with a real query engine — the URL-grammar glob translates directly
into their native filter language and the post-filter is skipped:

| Backend       | Push-down                                            |
| ------------- | ---------------------------------------------------- |
| Postgres      | `uri LIKE $1 \|\| $N ESCAPE '\\'` (`*`→`%`, `?`→`_`) |
| SQLite        | same (`@db/sqlite` parameter binding + `ESCAPE`)     |
| Mongo         | `{ uri: { $regex: '^<prefix><body>$' } }`            |
| Elasticsearch | Lucene `regexp` on `path.keyword`, body spliced in   |

Behaviour is unchanged. `count` returns to a native indexed count on these
backends instead of the list-then-length fallback. Backends without a query
engine (fs, ipfs, s3, localstorage, indexeddb, memory) keep the dispatch
post-filter — same semantics, fewer hops.

Backends opt in via `ReadHandlers.pushDownPattern: true`; dispatch inspects it
per-call so the choice is per-store, not per-URL.

### Helpers added to `src/read.ts`

- `patternToSqlLike(pattern)` — glob → SQL `LIKE` body, with literal `%`/`_`/`\`
  escaped under `ESCAPE '\\'`.
- `patternToRegexBody(pattern)` — glob → regex body without anchors, composable
  into Mongo `$regex` and Lucene `regexp` queries.
- `patternToRegex(pattern)` (existing) now composes `patternToRegexBody` for a
  single source of truth.

Unit-test count: 727 → 730. New `patternToSqlLike` + `patternToRegexBody` unit
tests; the cross-backend `ls/count honours pattern=` cases in the shared store
suite now exercise the push-down path on the four backends that opt in.

## 0.10.0 — `?pattern=…` URI-tail glob filter for ls and count

Closes the remaining read-side parity gap surfaced after 0.9.0. Every backend
now honours `?pattern=<glob>` on `fn=ls` and `fn=count`:

```
mutable://users/?fn=ls&pattern=al*       # alice, albert
mutable://users/?fn=count&pattern=al*    # 2
mutable://users/?fn=ls&pattern=a?ice     # alice
```

### Glob semantics

- `*` matches any run of non-`/` characters
- `?` matches a single non-`/` character
- All other regex metacharacters escaped
- Anchored on both ends; use `*alice*` for substring match

### Implementation

Lives in `dispatchRead`, so all 9 backends that route through it (postgres,
sqlite, mongo, fs, ipfs, s3, elasticsearch, localstorage, indexeddb) inherit the
filter with no per-backend changes. `MemoryStore` (the only backend with its own
switch) filters explicitly via the same `patternToRegex` helper.

Pattern + `limit`/`page` interact correctly: dispatch strips pagination from the
handler call so the backend returns the full sorted result, then filters →
paginates → projects in one pass. `count` with `pattern` routes through
`handlers.ls(format=uris)` and returns the matching length — avoids loading
payloads. Push-down per backend (translating glob to SQL `LIKE` / Mongo regex /
ES regex) is a future optimisation; the contract stays identical.

### Test coverage

Unit-test count: 712 → 727. The shared store suite gains `ls honours pattern=`
and `fn=count honours pattern=` cases that run against every backend, plus
`patternToRegex` / `matchesUriPattern` unit tests.

## 0.9.0 — Native entities everywhere + field projection

Every backend now implements the full `EntityStore` contract natively — no more
bytes-only shim. Each store hosts arbitrary user schemas side-by-side with
`BYTES_ENTITY` and round-trips canonical `TYPE_TAGS`
(string/number/bigint/boolean/bytes/timestamp/json) through whatever storage
shape the medium naturally affords.

### New native-entity backends

| Backend       | Layout                                                                   | Provisioning bookkeeping                           |
| ------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| mongo         | one collection per entity, BSON-native typed fields                      | per-entity meta doc with collision signature       |
| sqlite        | one table per entity, columns per declared field                         | live `PRAGMA table_info` shape check               |
| localstorage  | `{prefix}entities/{name}/{uri}` keys, JSON-encoded records               | `{prefix}__meta__/entities/{name}` signature       |
| indexeddb     | `__entities__/{name}/{uri}` storage-key prefix, structured-clone records | `__meta__/{name}` doc in same object store         |
| fs            | `{rootDir}/entities/{name}/` directory, JSON files                       | `{rootDir}/__meta__/entities/{name}` file          |
| s3            | `{prefix}entities/{name}/` key prefix, JSON objects                      | `{prefix}__meta__/entities/{name}` object          |
| ipfs          | per-entity in-memory URI → CID index, JSON-encoded blocks                | in-memory bucket signature                         |
| elasticsearch | `{prefix}_{name}_{protocol}_{host}` per-entity indices, JSON `_source`   | `{prefix}__meta__` index with `{name → signature}` |

(`memory` and `postgres` already shipped native; their pattern set the template
the others mirror.)

All backends follow the meta-handle lifecycle: `entitySupport(schema)` is pure,
`provisionEntity(meta)` is idempotent and throws on same-name-different-shape
collisions, `entityStatus(meta)` checks the medium. Writes/reads/deletes consume
the meta directly.

`status().schema` advertises every provisioned entity as `entity:<name>` across
all backends, so UIs that derive navigation from `rig.status().schema` see the
full set without per-backend special-casing.

### New `?fields=…` read param

The save-layer URL grammar adds `fields` to `ReadParams` — a comma-separated
list of field names to project from each returned record. Applies to `fn=read`
and `fn=ls&format=full`; ignored for `format=uris` / `fn=count` since those
return no record payloads.

```
mutable://users/alice?fields=name,age
mutable://users/?fields=name
```

Unknown projection fields are silently absent — projection is a presentation
directive, not a validation, matching SQL `SELECT` column-list semantics for
missing columns.

Implementation lives in `dispatchRead` so every store routing through that
helper inherits projection without per-backend changes; the memory store (the
only one with its own switch) projects explicitly.

### Test coverage

Unit-test count grew from 541 → 720+. Each new native-entity backend landed with
21–24 entity-targeted tests on top of the 30-test shared bytes suite, covering:
`entitySupport` purity, `entityStatus` collision detection, `provisionEntity`
idempotence and collision-throwing, multi-entity isolation, `BYTES_ENTITY` ×
custom entity coexistence at the same URI, ls/count parity with
limit/page/sortBy=uri/sortOrder/format, strict validation (extra-field error
per-entry), and the natural-failure path against unprovisioned entities.

## 0.8.1 — `SqliteStore.status()` reports provisioned schemas

- `SqliteStore.provisionEntity(meta)` now records `meta.schema.name` when the
  schema is the supported one (`BYTES_ENTITY`); `status().schema` lists every
  recorded entity as `entity:<name>`, mirroring `MemoryStore`.
- Non-bytes schemas remain silently un-provisioned at the storage layer (the
  shim already returns "Unsupported schema" on `write`/`read`) and are
  intentionally omitted from `status().schema` so callers don't think they have
  a usable surface.
- Idempotent — provisioning the same schema twice does not duplicate.

This unblocks UIs (e.g. `b3nd-web-rig`) that build their navigation root from
`rig.status().schema`. Other backends with empty `schema: []` (s3, fs, postgres,
mongo, elasticsearch, indexeddb, localstorage) are unchanged in this release.

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
