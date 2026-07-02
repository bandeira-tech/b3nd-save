# @bandeira-tech/b3nd-save

The **data-saving layer** for B3nd — everything between a node's
`ProtocolInterfaceNode` and the storage it persists to. One package covers:

- **Backends** — ten storage implementations on a single uniform contract.
- **Clients** — backend→`ProtocolInterfaceNode` adapters that turn raw storage
  into something a `Rig` can talk to.
- **Shared helpers** — for authors building their own backends without
  re-deriving the contract details.

## Quick start

A `SaveClient` reads as **"receive payloads X, map as Y, store on S"**:

```ts
import { PostgresStore } from "@bandeira-tech/b3nd-save/postgres";
import {
  passThroughRecord,
  SaveClient,
} from "@bandeira-tech/b3nd-save/clients";
import { TYPE_TAGS } from "@bandeira-tech/b3nd-save/entity";

const users = {
  name: "users",
  fields: [
    { name: "name", type: [TYPE_TAGS.STRING] },
    { name: "age", type: [TYPE_TAGS.NUMBER] },
  ],
};

const store = new PostgresStore("myapp", executor);
// Provision once at app boot (idempotent — safe to call on every start).
await store.provisionEntity(store.entitySupport(users));

const client = new SaveClient(
  passThroughRecord, //                                  ← mapper: wire ↔ record
  users, //                                              ← entity schema
  store, //                                              ← store
);

await client.receive([
  ["data://users/alice", { name: "Alice", age: 30 }],
  ["data://users/alice", null], // null payload = delete
]);
const [[, alice]] = await client.read(["data://users/alice"]);
```

The mapper is a **`SaveMapper`** — a bidirectional codec between the wire
vocabulary `(wireUri, wirePayload)` and the store vocabulary
`(storeUri, storeRecord)`. `toStore(wireUri, payload?)` runs on every write and
URI-only op; `fromStore(storeUri, record?)` runs on every result coming back
out. Return `null` from `fromStore` to drop a foreign entry (e.g. a stray file
the app did not write). Two built-in mappers cover the common cases:

- `passThroughRecord` — wire payload is already the record.
- `mapToBytes` — wraps an opaque byte payload into `{ payload }` for
  `BYTES_ENTITY`.

Use `mapToBytes` with `BYTES_ENTITY` to get bytes-on-the-wire against any
backend in the package.

## The contract

Every backend implements one interface: `EntityStore`. A backend instance hosts
many typed entities side by side; the meta handle is per-call, not pinned at
construction, so a single instance can serve any number of programs at once.

```ts
interface EntityStore<TMeta extends EntityMeta = EntityMeta> {
  entitySupport(schema: EntitySchema): TMeta;
  entityStatus(meta: TMeta): Promise<"live" | "unprovisioned">;
  provisionEntity(meta: TMeta): Promise<void>;
  write(
    meta: TMeta,
    entries: { uri: string; record: EntityRecord }[],
  ): Promise<StoreWriteResult[]>;
  read<T = EntityRecord | undefined>(
    meta: TMeta,
    urls: string[],
  ): Promise<Output<T>[]>;
  delete(meta: TMeta, uris: string[]): Promise<DeleteResult[]>;
  status(): Promise<StatusResult>;
  capabilities?(): StoreCapabilities;
}
```

Lifecycle is three steps the caller drives:

- **`entitySupport(schema)`** is pure — it compiles the schema into the
  backend's opaque operational handle (column plans, target collection / index
  names, bytes-field sets, the per-field `EntitySupport` report). No IO.
- **`provisionEntity(meta)`** is idempotent — it materialises the entity on the
  medium (creates the table, writes the meta record, allocates the bucket).
  Running with a meta whose shape conflicts with what is already provisioned at
  the same name throws.
- **`entityStatus(meta)`** checks whether the entity is live on the medium right
  now. Returns `"live"` only when the medium's current shape matches the meta
  exactly — a same-name different-shape entity reports `"unprovisioned"`.

Writes / reads / deletes consume the meta directly: no per-call cache lookup
gate. If a meta refers to an entity that is not live, ops surface the backend's
natural failure (storage error / undefined table / etc.) per entry.

Records are open `Record<string, unknown>`, validated against the meta by the
backend. The contract is **strict**: a record with extra or mistyped keys
produces a `StoreWriteResult` failure for that entry — backends never silently
coerce or drop fields. Coercion is the **client's** job (see `SaveClient` below
— its `BYTES_ENTITY` mode wraps raw bytes into a `{ payload }` record for the
store).

### Raw bytes — `BYTES_ENTITY`

Plain byte storage is the same contract under a canonical schema:

```ts
export const BYTES_ENTITY: EntitySchema = {
  name: "bytes",
  fields: [{ name: "payload", type: ["bytes"] }],
};
```

Every backend routes `BYTES_ENTITY` writes/reads through its native byte path
(Postgres `BYTEA`, S3 object body, the filesystem file itself), so byte-shaped
wires pay no schema overhead and benefit from native streaming on backends that
support it (`fs`, `s3`, `ipfs`). Use `BYTES_ENTITY` with the `mapToBytes` client
mapper for any opaque-bytes wire.

## Imports

Each subpath is independent — import only what you need and the rest stays out
of your bundle.

```ts
// Narrow imports — footprint-aware
import { PostgresStore } from "@bandeira-tech/b3nd-save/postgres";
import {
  mapToBytes,
  passThroughRecord,
  SaveClient,
  type SaveMapper,
} from "@bandeira-tech/b3nd-save/clients";
import { BYTES_ENTITY, TYPE_TAGS } from "@bandeira-tech/b3nd-save/entity";
import type { EntityStore } from "@bandeira-tech/b3nd-save/entity-store";

// Root barrel — convenient, namespaced
import { clients, postgres } from "@bandeira-tech/b3nd-save";
```

## Backends

Every backend implements the full `EntityStore` contract natively — both
`BYTES_ENTITY` and arbitrary user schemas — and supports the complete read
surface (`fn=read|ls|find|count` + `limit`/`page`/`cursor`/`sortBy=uri|<field>`/
`sortOrder`/`format`/`fields`) and the URI-embedded glob grammar.

| Backend       | Import                                   | Executor                               | Native-entity layout                                                     | Streams? |
| ------------- | ---------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------ | -------- |
| Memory        | `@bandeira-tech/b3nd-save/memory`        | none                                   | one record map per entity                                                | no       |
| PostgreSQL    | `@bandeira-tech/b3nd-save/postgres`      | inject any `pg`-style executor         | one table per entity, columns per declared field                         | no       |
| SQLite        | `@bandeira-tech/b3nd-save/sqlite`        | inject any `@db/sqlite`-style executor | one table per entity, columns per declared field                         | no       |
| MongoDB       | `@bandeira-tech/b3nd-save/mongo`         | inject a `MongoExecutor`               | one collection per entity, BSON-typed fields                             | no       |
| Elasticsearch | `@bandeira-tech/b3nd-save/elasticsearch` | inject an `ElasticsearchExecutor`      | `{prefix}_{name}_{protocol}_{host}` per-entity index, JSON `_source`     | no       |
| S3            | `@bandeira-tech/b3nd-save/s3`            | inject an `S3Executor`                 | `{prefix}entities/{name}/…` key prefix, JSON objects                     | yes      |
| Filesystem    | `@bandeira-tech/b3nd-save/fs`            | inject an `FsExecutor`                 | `{rootDir}/entities/{name}/…` directory, JSON files                      | yes      |
| IPFS          | `@bandeira-tech/b3nd-save/ipfs`          | inject an `IpfsExecutor`               | per-entity in-memory URI → CID index, JSON-encoded blocks                | yes      |
| LocalStorage  | `@bandeira-tech/b3nd-save/localstorage`  | injects browser `Storage`              | `{prefix}entities/{name}/{uri}` keys, JSON-encoded records               | no       |
| IndexedDB     | `@bandeira-tech/b3nd-save/indexeddb`     | injects `indexedDB` / `IDBKeyRange`    | `__entities__/{name}/{uri}` storage-key prefix, structured-clone records | no       |

`BYTES_ENTITY` keeps its original layout per backend (no migration). Custom
schemas land alongside under the per-entity layout above; provisioning
bookkeeping holds a signature so same-name-different-shape collisions are caught
up front. Per-field canonical `TYPE_TAGS` round-trip through whatever encoding
the medium needs (BSON, JSON, base64 for bytes, ISO-8601 for timestamps, decimal
strings for `bigint`).

"Streams?" = whether reads of `BYTES_ENTITY` return a
`ReadableStream<Uint8Array>` directly (no buffering). Buffered backends collect
streamed write input to bytes before storing and always return `Uint8Array` on
read.

### Read push-down matrix

Every backend honours the full read+url?fn surface, but they differ in whether
`pattern` / `cursor` / `sortBy=<field>` are pushed into the native query
language or applied in JS after the backend returns:

| Backend                                   | `pattern`                         | `cursor`                                | `sortBy=<field>`                       |
| ----------------------------------------- | --------------------------------- | --------------------------------------- | -------------------------------------- |
| Postgres                                  | SQL `LIKE … ESCAPE '\\'`          | `AND uri >/< $N`                        | `ORDER BY`                             |
| SQLite                                    | SQL `LIKE … ESCAPE '\\'`          | `AND uri >/< ?`                         | `ORDER BY`                             |
| Mongo                                     | `$regex` on `uri`                 | `$gt`/`$lt` on `uri`                    | `$sort`                                |
| Elasticsearch                             | Lucene `regexp` on `path.keyword` | `bool.must` + `range` on `path.keyword` | `sort: […]` (auto `.keyword` for text) |
| Memory                                    | in-memory regex on tail           | in-memory `localeCompare`               | in-memory                              |
| fs / ipfs / s3 / localstorage / indexeddb | dispatch post-filter              | dispatch post-filter                    | dispatch post-sort                     |

For the dispatch-layer fallback path, the cost is one full prefix scan per
query; for the push-down path, the backend's index handles the filter+sort
natively. The caller-visible contract is identical either way.

## Client

`@bandeira-tech/b3nd-save/clients` exports **`SaveClient`** — the adapter from
an `EntityStore` to `ProtocolInterfaceNode`. Three required args, read as a
sentence:

```ts
new SaveClient(mapper, entity, store);
```

- **mapper** — a `SaveMapper<TIn, TOut>`: a bidirectional codec between the wire
  vocabulary `(wireUri, wirePayload)` and the store vocabulary
  `(storeUri, storeRecord)`. `toStore(wireUri, payload?)` runs on every request
  going into the store (write, read, delete); `fromStore(storeUri, record?)`
  runs on every result coming back out. Return `null` from `fromStore` to drop a
  foreign entry (a store URI the mapper does not recognise — e.g. a stray file
  the app did not write). Throwing from either direction produces a per-entry
  failure; the rest of the batch proceeds.
- **entity** — the `EntitySchema` this client routes. Use `BYTES_ENTITY` for
  opaque bytes.
- **store** — any `EntityStore`. Every backend in the package implements it.

### Lifecycle

`SaveClient` has no `init()` method — provisioning the underlying store is the
caller's job, handled out of band (app boot for production, test setup for
tests):

```ts
await store.provisionEntity(store.entitySupport(target));
const client = new SaveClient(mapper, target, store);
```

If provisioning is skipped, the backend surfaces its natural failure on first IO
(storage error for write/delete, throw or miss for read) — same as calling any
`EntityStore` method against an unprovisioned entity.

Two mappers ship with the package:

- `passThroughRecord` — wire payload is already an `EntityRecord`; URI passes
  through unchanged in both directions.
- `mapToBytes` — wraps an opaque byte payload as `{ payload: bytes }` on the way
  in, unwraps on the way out. Pair with `BYTES_ENTITY`.

The triple `(mapper, entity, store)` is sealed at construction — one client
routes one entity. Route a different entity with a different `SaveClient`. Every
read result passes through `mapper.fromStore`; the URI translation runs in both
directions so the rig's wire vocabulary never leaks into the store.

## Backend-author helpers

- **`@bandeira-tech/b3nd-save/entity`** — `EntitySchema`, `EntityField`,
  `EntityRecord`, `EntitySupport`, `TYPE_TAGS`, `BYTES_ENTITY`. The data
  vocabulary every backend speaks.
- **`@bandeira-tech/b3nd-save/entity-store`** — the `EntityStore` interface.
- **`@bandeira-tech/b3nd-save/dispatch`** — `dispatchRead` helper that handles
  the `fn=read|ls|find|count|x-*` switch so every backend stays consistent.
- **`@bandeira-tech/b3nd-save/read`** — `validateReadParams`, `applyReadParams`
  for the read-params contract.
- **`@bandeira-tech/b3nd-save/errors`** — `storageFailure`, the catch-block
  helper that builds a structured `B3ndError` for store result tuples.
- **`@bandeira-tech/b3nd-save/payload`** — `toBytes` / `toStream` payload
  normalizers for the `Uint8Array | ReadableStream<Uint8Array>` union used by
  `BYTES_ENTITY`.

Use these when implementing a new `EntityStore` so it matches the contract the
built-ins follow.

## Entities

### Open type vocabulary

`EntityField.type` is `string[]`, **not** a closed literal union. The canonical
tags this package recognises live in `TYPE_TAGS`:

```ts
TYPE_TAGS = {
  STRING: "string",
  NUMBER: "number",
  BIGINT: "bigint",
  BOOLEAN: "boolean",
  BYTES: "bytes",
  TIMESTAMP: "timestamp",
  JSON: "json",
};
```

Custom protocols may freely add their own tags (e.g. `"money"`, `"geo"`,
`"email"`). Multiple tags on a field are refinements describing the same value —
e.g. `["string", "email"]` is a string semantically known to be an email.
Backends consult the tags they understand to decide how to materialise the
column / field / index; unknown tags pass through the schema unchanged. The
`EntitySupport` report on `meta.support` (returned by `entitySupport(schema)`)
declares which fields the medium accepted and which it could not, so callers see
incompatibilities once at init time rather than mid-flight.

### Strict validation

Backends do not coerce. A record under `schema` may only contain keys declared
in `schema.fields`, with values compatible with the field's recognised tags.
Anything else produces a `StoreWriteResult` failure for that entry. This is
deliberate — rig misconfigurations stay loud rather than silently corrupting
data. Coercion lives in the client (this is what `SaveClient` does in its
default `BYTES_ENTITY` mode when it projects raw bytes into
`{ payload: bytes }`).

### Encoding bytes any shape you like

`BYTES_ENTITY.payload` is opaque bytes. Encode on write, decode on read —
backends never inspect content. JSON, protobuf, FlatBuffers, CBOR, MessagePack,
encrypted blobs — all work; only the encode/decode line in your code changes.

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

await bytes.receive([
  ["mutable://users/alice", enc(JSON.stringify({ name: "Alice" }))],
]);
const [[, payload]] = await bytes.read(["mutable://users/alice"]);
const user = JSON.parse(dec(payload as Uint8Array));
```

### Streaming large byte payloads

`BYTES_ENTITY.payload` accepts either `Uint8Array` or
`ReadableStream<Uint8Array>` (same union as `fetch` `BodyInit`). Backends with
native streaming (`fs`, `s3`, `ipfs`) keep streams end-to-end; the rest collect
to bytes.

```ts
const res = await fetch("https://example.com/big.bin");
await bytes.receive([["hash://big", res.body!]]);

const [[, payload]] = await fsBytes.read(["hash://big"]);
await (payload as ReadableStream<Uint8Array>).pipeTo(somewhere);
```

## Reading contract

`read()` takes **urls** (uri + query string). The url grammar is owned by this
package and exported from `@bandeira-tech/b3nd-save/url`:

```
<uri-with-glob>[?fn=<fn>][&<param>=<value>...][&x-<ns>.<key>=<value>...]
```

Glob tokens in the URI path:

- `?` — exactly one non-`/` character
- `*` — zero or more non-`/` characters (single path segment)
- `**` — zero or more path segments (any depth); **`fn=find` only**

A URI with wildcards requires an explicit `?fn=`. `?fn=ls` rejects `**`;
`?fn=find` requires `**`. A bare URI with no wildcards defaults to `fn=read` (no
trailing `/`) or `fn=ls` (trailing `/`).

Reserved `fn` values:

- `read` — point read of a single URI (default for bare non-trailing-`/` URIs)
- `ls` — list direct children under a prefix (default for trailing-`/` URIs)
- `find` — recursive walk; URI must contain `**`
- `count` — count entries under a prefix (accepts any URI shape including `**`)
- `x-…` — provider-defined extension fns

Standard params honoured by every backend:

- `limit`, `page` — offset-based pagination
- `cursor=<uri>` — stateless cursor pagination (entries strictly past the cursor
  under the active sort order). Mutually exclusive with `page`.
- `sortBy=uri` or `sortBy=<field>`, `sortOrder=asc|desc` — sorts on the URI or
  on any declared record field; `compareSortable` is the canonical JS comparator
  for non-uri sortBy (numbers/bigints numerically, Dates via `valueOf`, strings
  via `localeCompare`, undefined/null last).
- `format=full` returns `Output[]`; `format=uris` returns `string[]`
- `fields=name,age,…` — record projection for `fn=read` and `fn=ls&format=full`.
  Unknown projection fields are silently absent.
- URI-embedded glob (preferred v2 form) — wildcards directly in the URI path, as
  above. Glob semantics: `*` and `?` match within a single segment; `**` matches
  across segments. Anchored to the prefix up to the first wildcard.
- `pattern=al*` — **deprecated** URI-tail glob filter for `fn=ls` and
  `fn=count`. Logs a one-time deprecation warning per process. Use URI-embedded
  glob instead. Removal scheduled one minor version out.

Examples:

```
mutable://users/alice                          # fn=read default
mutable://users/                               # fn=ls default
mutable://users/?fn=count                      # count under prefix
mutable://users/alice?fields=name,age          # project record
mutable://users/al*?fn=ls                      # list URIs starting with "al" (v2)
mutable://users/**?fn=find                     # recursive walk of all descendants (v2)
mutable://users/**?fn=find&limit=10            # first page of recursive walk (cursor slot appended)
mutable://users/?fn=count&pattern=al*          # deprecated: count with ?pattern= glob
mutable://users/?fn=ls&fields=name&limit=10    # paginated list, projected (cursor slot appended)
mutable://users/?fn=ls&cursor=users/b&limit=2  # cursor pagination
mutable://users/?fn=ls&sortBy=age&sortOrder=desc
```

`parseUrl(url)` decomposes a string into
`{protocol, hostname, path, program, uri, glob, fn, params, ext}` — `uri` is the
literal prefix before the first wildcard segment; `glob` is the wildcard tail.
`buildUrl(parsed)` is the inverse. `uriOf(url)` is the cheap query-stripping
helper.

Throws on unknown `format` values, on `cursor` + `page` combined, on URIs with
wildcards but no explicit `?fn=`, and on any `fn=<x>` the store doesn't
implement (programmer errors).

### Locked semantics

- **Strict schemas.** Records must match `schema.fields`. Extra or mistyped
  fields are per-entry errors, not silent coercions.
- **Miss is `payload === undefined`.** A point read for an absent uri returns
  `[inputUrl, undefined]`. Misses are _content_, not errors.
- **`ls` and `count` are shallow direct-leaves only.** An entry is _in_
  `ls(prefix)` iff its URI is `prefix + <segment>` with no further `/`.
  Subtree-only paths (`users/bob/posts/1` under `users/`) are absent from both.
  Callers that want recursion use `fn=find` with a `**` URI glob.
- **`fn=find` walks the full subtree.** Every store that advertises `"find"` in
  `status().fns` honours `**` globs across all depths. Stores that do not
  advertise `"find"` throw on `fn=find` — no silent fall-back through `ls` (v2
  §3.5). The `walkViaLs` helper in `@bandeira-tech/b3nd-save/walk-via-ls` is
  available for stores that need an in-process recursive walk built on `ls`.
- **`format=uris` skips payload reads.** Every backend implements this as a fast
  path (S3 / IPFS / FS / IndexedDB never fetch bodies; Postgres / SQLite issue
  `SELECT uri`; Mongo uses a projection; Elasticsearch passes `_source: false`).
- **`fields=…` projects after the read.** Implemented in `dispatchRead`, so
  every backend that routes through it (postgres, sqlite, mongo, fs, ipfs, s3,
  elasticsearch, localstorage, indexeddb) inherits projection without
  per-backend changes; the memory store projects explicitly. Unknown projection
  fields are silently absent — projection is a presentation directive, not a
  validation.
- **`limit=` with `fn=ls` or `fn=find` appends a cursor slot.** When `limit` is
  set, dispatch appends ONE extra `Output` at the tail of the result:
  `[cursorUri, { next: "<opaque>" | null }]`. `next: null` signals the last
  page; otherwise `next` is the opaque cursor token for re-issue. The cursor URI
  is the original locator with `cursor=<opaque>` set — callers can do
  `read([slot.uri])` to walk the next page. The slot is appended unconditionally
  (an empty page still carries `next: null`) so callers never need to
  special-case the last page.
- **`pattern=…` / `cursor=…` / `sortBy=<field>` filter before pagination.**
  Dispatch strips `limit`/`page` from the handler call so the backend returns
  the full result; dispatch then filters → paginates → projects in one pass.
  Backends with a real query engine opt into push-down via `pushDownPattern` /
  `pushDownCursor` / `pushDownSortBy` and combine these params natively in their
  query — see the push-down matrix below for which backend handles what
  natively.
- **Unsupported params throw.** Misses are payload, but bad params are
  programmer errors.
- **Atomic batches when advertised.** Backends that declare
  `capabilities.atomicBatch: true` (Postgres, SQLite) wrap the batch in a
  transaction — every entry commits together or none do. On failure every result
  carries the same root-cause error.
- **Structured errors.** Write and delete failures carry an
  `errorDetail?:
  B3ndError` with `code: "STORAGE_ERROR"` and (when
  entry-attributable) the failing `uri`. The `error: string` field is kept for
  human-readable logs.

## Testing

- `deno task test` — runs every backend's unit suite against an in-memory mock,
  plus the client tests and the cross-cutting integration suite under `tests/`.
- `deno task test:integration:{postgres,mongo,sqlite,fs,ipfs,s3,elasticsearch}`
  — runs the same suite against real backends. Wired up in CI; locally requires
  the matching service running on the conventional port.
- `deno task test:integration:{indexeddb,localstorage}` — runs the suites inside
  a real headless Chromium via Astral + esbuild. Astral downloads its own
  Chromium on first run.
- `deno task check`, `deno lint`, `deno fmt --check .` — type/lint/format gates.

### Pre-push hook

A tracked `.githooks/pre-push` runs the same CI gates (fmt / lint / check / unit
tests) so a broken push never leaves your machine. Install once per clone:

```sh
deno task install-hooks   # sets `git config core.hooksPath .githooks`
```

Bypass in emergencies with `git push --no-verify`.

## License

MIT — see `LICENSE`.
