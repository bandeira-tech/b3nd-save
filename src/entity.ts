/**
 * Entity schema types.
 *
 * `b3nd-save` ships one store interface: `EntityStore` (see
 * `./entity-store.ts`) — schema-aware: every operation takes the
 * `EntitySchema` it targets, so a single store instance can host many
 * entities side-by-side. Schema is per-call, not pinned at
 * construction.
 *
 * Entities are a client-layer concern. Clients map their wire payload
 * (`Output<T>`) into `EntityRecord`s and call the store with an
 * explicit schema; the store organises the medium accordingly
 * (separate Postgres tables, separate Mongo collections, separate
 * in-memory record maps). The schema travels with the data: there is
 * no implicit "current entity" inside the store.
 *
 * ## Open type vocabulary
 *
 * `EntityField.type` is `string[]`. The strings this package knows
 * about live in {@link TYPE_TAGS}, but the field type itself is
 * intentionally not a literal union — entities are shared across
 * protocols and custom stores, and one protocol's `"money"` or
 * `"geo"` tag should travel unchanged through stores that don't
 * recognise it. A field may carry multiple tags (e.g.
 * `["string", "email"]`) — they are refinements, not a value-type
 * union. A store consults the tags it knows to decide how to
 * materialise the field, and reports any field whose tags it cannot
 * make sense of as unsupported.
 *
 * ## Coercion vs. error reporting
 *
 * The store is strict: anything that doesn't fit the schema becomes
 * an error result so the rig wiring can be fixed. Coercion and field
 * projection are the client's job — `SaveClient` in its default
 * `BYTES_ENTITY` mode builds a `{ payload: bytes }` record from
 * incoming bytes; in record mode it passes records through verbatim.
 * If a record arrives with extra or mistyped fields, the store
 * reports the error rather than silently dropping data.
 */

/**
 * Canonical type tags published by this package.
 *
 * Stores in `b3nd-save` recognise these tags. Other protocols and
 * custom stores may freely add their own; `EntityField.type` stays
 * `string[]` so unknown tags pass through intact.
 */
export const TYPE_TAGS = {
  STRING: "string",
  NUMBER: "number",
  BIGINT: "bigint",
  BOOLEAN: "boolean",
  BYTES: "bytes",
  TIMESTAMP: "timestamp",
  JSON: "json",
} as const;

/**
 * A field of an entity — a name plus an open list of type tags.
 *
 * Multiple tags are refinements describing the same value (e.g.
 * `["string", "email"]` — a string value semantically an email). A
 * store that understands `"string"` can store the value; the
 * `"email"` tag is a hint stores that want to validate or index
 * differently can use.
 */
export interface EntityField {
  name: string;
  type: string[];
}

/**
 * Declarative description of an entity.
 *
 * `name` is the entity's identifier in the medium — e.g. the Postgres
 * table name, the Mongo collection name. Authors should pick a value
 * that is safe for those mediums (lowercase, no special chars).
 */
export interface EntitySchema {
  name: string;
  fields: EntityField[];
}

/**
 * A record of an entity — values keyed by field name. The type is
 * `Record<string, unknown>` because the schema is open: per-field
 * value types are decided by the tags an adapter understands. Store
 * implementations validate against the schema on the way in.
 */
export type EntityRecord = Record<string, unknown>;

/**
 * Per-field support reported by `EntityStore.entitySupport`.
 *
 * A field is *supported* when the store recognised at least one of
 * its tags and would provision storage for it. Unsupported fields
 * carry a human-readable `reason`. Stores do not silently drop
 * unsupported fields on write — see the file header on coercion.
 */
export interface EntitySupport {
  entity: string;
  supported: string[];
  unsupported: { name: string; reason: string }[];
}

/**
 * Opaque operational handle for an entity on a specific store.
 *
 * Returned by `EntityStore.entitySupport(schema)` and threaded back
 * to `provisionEntity`, `entityStatus`, `write`, `read`, and
 * `delete`. The base shape only exposes `support`; each backend
 * extends this with whatever it needs to operate (column plans,
 * target table names, bytes-field sets, etc.). The caller treats
 * the meta as opaque and owns its lifetime — the store keeps no
 * per-entity caches of its own.
 */
export interface EntityMeta {
  readonly support: EntitySupport;
}

/**
 * Canonical entity for raw-byte storage.
 *
 * `EntityStore.write(BYTES_ENTITY, [{ uri, record: { payload: bytes }}])`
 * is how opaque bytes go into the store; pair it with `mapToBytes`
 * from `./clients` to expose a bytes-on-the-wire `ProtocolInterfaceNode`.
 */
export const BYTES_ENTITY: EntitySchema = {
  name: "bytes",
  fields: [{ name: "payload", type: [TYPE_TAGS.BYTES] }],
};
