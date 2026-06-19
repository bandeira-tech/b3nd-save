/**
 * ElasticsearchStore — Elasticsearch implementation of `EntityStore`.
 *
 * One backend, many entities. Per-entity index naming partitions
 * documents in a way that keeps queries simple:
 *
 * - `BYTES_ENTITY` → index `{indexPrefix}_{protocol}_{hostname}`,
 *   docId = uri path. Document `_source` carries `payload` (base64)
 *   and a mirrored `path` field that `ls`/`count` regex-queries hit
 *   (ES 8 disallows regex on `_id`). This is the original layout —
 *   no migration.
 * - any other schema → index
 *   `{indexPrefix}_{entityName}_{protocol}_{hostname}`, same docId
 *   convention. Document `_source` carries the record fields encoded
 *   per canonical `TYPE_TAGS` (bytes → base64, bigint → string,
 *   timestamp → ISO-8601 — see `./fields.ts`) plus the mirrored
 *   `path` field.
 *
 * ## Lifecycle
 *
 * `entitySupport(schema)` is pure — it plans the field set and computes
 * a collision signature. `provisionEntity(meta)` writes a tiny meta
 * doc to `{indexPrefix}__meta__/entities` keyed by entity name, body
 * `{signature}`; subsequent `entityStatus(meta)` reads it back. The
 * meta doc is also used by `status()` to list provisioned entities.
 *
 * ## Read params
 *
 * `fn=ls` / `fn=count` push down to an ES regex query against the
 * mirrored `path.keyword` field with the shallow-direct-leaves
 * predicate `<docPrefix>[^/]+`. Standard params (`limit`/`page`/
 * `sortBy=uri`/`sortOrder`/`format`) translate to `size`/`from`/`sort`,
 * with `_source: false` for the `format=uris` fast path.
 */

import type {
  DeleteResult,
  Output,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { decodeBase64, encodeBase64 } from "@bandeira-tech/b3nd-core";
import type { ParsedUrl } from "../url.ts";
import { dispatchRead } from "../dispatch.ts";
import { storageFailure } from "../errors.ts";
import { toBytes } from "../payload.ts";
import { patternToRegexBody, validateReadParams } from "../read.ts";
import type { EntityStore } from "../entity-store.ts";
import {
  BYTES_ENTITY,
  type EntityMeta,
  type EntityRecord,
  type EntitySchema,
} from "../entity.ts";
import type { StoreCapabilities, StoreWriteResult } from "../types.ts";
import {
  computeSignature,
  decodeRecord,
  encodeRecord,
  type FieldPlan,
  planFields,
} from "./fields.ts";
import type { ElasticsearchExecutor } from "./mod.ts";

const STORE_NAME = "ElasticsearchStore";
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const META_INDEX_SUFFIX = "__meta__";

/** Escape characters that are special in Lucene regex syntax. */
function escapeLuceneRegex(input: string): string {
  return input.replace(/[.?+*|{}\[\]()"\\#@&<>~]/g, "\\$&");
}

/**
 * Parse a URI into the `(protocol, hostname, docId)` tuple. ES index
 * naming gets layered on top by each entity meta.
 */
function uriParts(uri: string): {
  protocol: string;
  hostname: string;
  docId: string;
} {
  const url = new URL(uri);
  return {
    protocol: url.protocol.replace(":", ""),
    hostname: url.hostname,
    docId: url.pathname.substring(1),
  };
}

/**
 * ElasticsearchStore-specific entity handle.
 *
 * `indexInfix` is `""` for BYTES_ENTITY (current layout) or
 * `{entityName}_` for custom entities — it's spliced between the
 * store-level `indexPrefix` and the URI's `protocol_hostname` to
 * partition documents by entity without changing the docId scheme.
 * `isBytes` selects the legacy bytes-payload doc shape vs the
 * JSON-encoded record shape. `fields`/`declared`/`bytesFields` drive
 * write-time validation and encoding; `signature` is used for
 * collision detection in `entityStatus` / `provisionEntity`.
 */
export interface ElasticsearchEntityMeta extends EntityMeta {
  readonly indexInfix: string;
  readonly isBytes: boolean;
  readonly fields: readonly FieldPlan[];
  readonly declared: ReadonlySet<string>;
  readonly bytesFields: ReadonlySet<string>;
  readonly signature: string;
}

function isBytesSchema(schema: EntitySchema): boolean {
  return schema.name === BYTES_ENTITY.name;
}

export class ElasticsearchStore
  implements EntityStore<ElasticsearchEntityMeta> {
  private readonly indexPrefix: string;
  private readonly executor: ElasticsearchExecutor;

  constructor(indexPrefix: string, executor: ElasticsearchExecutor) {
    if (!indexPrefix) throw new Error("indexPrefix is required");
    if (!executor) throw new Error("executor is required");

    this.indexPrefix = indexPrefix;
    this.executor = executor;
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  entitySupport(schema: EntitySchema): ElasticsearchEntityMeta {
    if (isBytesSchema(schema)) {
      const fields: FieldPlan[] = [{ name: "payload", tag: "bytes" }];
      return {
        support: {
          entity: schema.name,
          supported: ["payload"],
          unsupported: [],
        },
        indexInfix: "",
        isBytes: true,
        fields,
        declared: new Set(["payload"]),
        bytesFields: new Set(["payload"]),
        signature: computeSignature(schema.name, fields),
      };
    }
    if (!NAME_PATTERN.test(schema.name)) {
      throw new Error(
        `${STORE_NAME}: entity name '${schema.name}' must match ${NAME_PATTERN.source}`,
      );
    }
    const { fields, unsupported } = planFields(schema.fields);
    const declared = new Set(fields.map((f) => f.name));
    const bytesFields = new Set(
      fields.filter((f) => f.tag === "bytes").map((f) => f.name),
    );
    return {
      support: {
        entity: schema.name,
        supported: fields.map((f) => f.name),
        unsupported,
      },
      indexInfix: `${schema.name}_`,
      isBytes: false,
      fields,
      declared,
      bytesFields,
      signature: computeSignature(schema.name, fields),
    };
  }

  async entityStatus(
    meta: ElasticsearchEntityMeta,
  ): Promise<"live" | "unprovisioned"> {
    const recorded = await this._readMetaSignature(meta.support.entity);
    if (recorded === null) return "unprovisioned";
    return recorded === meta.signature ? "live" : "unprovisioned";
  }

  async provisionEntity(meta: ElasticsearchEntityMeta): Promise<void> {
    const recorded = await this._readMetaSignature(meta.support.entity);
    if (recorded !== null) {
      if (recorded !== meta.signature) {
        throw new Error(
          `${STORE_NAME}: entity '${meta.support.entity}' is already ` +
            `provisioned with a different shape`,
        );
      }
      return;
    }
    await this.executor.index(
      this._metaIndex(),
      meta.support.entity,
      { signature: meta.signature },
    );
  }

  // ── Write ────────────────────────────────────────────────────────

  async write(
    meta: ElasticsearchEntityMeta,
    entries: { uri: string; record: EntityRecord }[],
  ): Promise<StoreWriteResult[]> {
    if (entries.length === 0) return [];
    if (
      (await this._readMetaSignature(meta.support.entity)) !== meta.signature
    ) {
      return entries.map(({ uri }) => ({
        success: false,
        ...storageFailure(
          new Error(
            `${STORE_NAME}: entity '${meta.support.entity}' is not provisioned`,
          ),
          "Entity not provisioned",
          uri,
        ),
      }));
    }
    const results: StoreWriteResult[] = [];
    for (const { uri, record } of entries) {
      const extras = Object.keys(record).filter((k) => !meta.declared.has(k));
      if (extras.length > 0) {
        results.push({
          success: false,
          ...storageFailure(
            new Error(
              `record contains keys not declared in schema '${meta.support.entity}': ${
                extras.join(", ")
              }`,
            ),
            "Schema mismatch",
            uri,
          ),
        });
        continue;
      }
      try {
        const { protocol, hostname, docId } = uriParts(uri);
        const index = this._dataIndex(meta, protocol, hostname);
        let body: Record<string, unknown>;
        if (meta.isBytes) {
          const payload = record.payload;
          if (
            !(payload instanceof Uint8Array) &&
            !(payload instanceof ReadableStream)
          ) {
            throw new Error(
              "BYTES_ENTITY record.payload must be Uint8Array or ReadableStream",
            );
          }
          const bytes = await toBytes(payload);
          body = { payload: encodeBase64(bytes), path: docId };
        } else {
          const normalised = await this._normaliseBytesFields(
            record,
            meta.bytesFields,
          );
          body = {
            ...encodeRecord(meta.fields, normalised),
            path: docId,
          };
        }
        await this.executor.index(index, docId, body);
        results.push({ success: true });
      } catch (err) {
        results.push({
          success: false,
          ...storageFailure(err, "Write failed", uri),
        });
      }
    }
    return results;
  }

  // ── Read ─────────────────────────────────────────────────────────

  read<T = EntityRecord | undefined>(
    meta: ElasticsearchEntityMeta,
    urls: string[],
  ): Promise<Output<T>[]> {
    return dispatchRead<T>(urls, STORE_NAME, {
      read: (p) => this._readOne(meta, p.uri) as Promise<T | undefined>,
      ls: (p) => this._ls(meta, p) as Promise<Output<T>[] | string[]>,
      count: (p) => this._count(meta, p),
      pushDownPattern: true,
    });
  }

  private async _readOne(
    meta: ElasticsearchEntityMeta,
    uri: string,
  ): Promise<EntityRecord | undefined> {
    try {
      const { protocol, hostname, docId } = uriParts(uri);
      const index = this._dataIndex(meta, protocol, hostname);
      const doc = await this.executor.get(index, docId);
      if (!doc) return undefined;
      if (meta.isBytes) {
        return { payload: decodeBase64(doc.payload as string) };
      }
      return decodeRecord(meta.fields, doc);
    } catch {
      return undefined;
    }
  }

  /**
   * Lucene regex query for shallow direct-leaves under `docPrefix`.
   * Pattern push-down: when a glob pattern is set, splice its regex
   * body in place of the default `[^/]+` segment so the matcher both
   * keeps the shallow contract (wildcards never cross `/`) and applies
   * the glob in the same query.
   */
  private _leafQuery(
    docPrefix: string,
    pattern?: string,
  ): Record<string, unknown> {
    const body = pattern !== undefined ? patternToRegexBody(pattern) : "[^/]+";
    return {
      regexp: {
        "path.keyword": `${escapeLuceneRegex(docPrefix)}${body}`,
      },
    };
  }

  private async _ls(
    meta: ElasticsearchEntityMeta,
    parsed: ParsedUrl,
  ): Promise<Output<EntityRecord>[] | string[]> {
    validateReadParams(parsed.params, STORE_NAME);
    const { params } = parsed;
    const format = params.format ?? "full";
    const { protocol, hostname, docId } = uriParts(parsed.uri);
    const index = this._dataIndex(meta, protocol, hostname);

    const body: Record<string, unknown> = {
      query: this._leafQuery(docId, params.pattern),
    };
    if (params.sortBy === "uri") {
      body.sort = [{
        "path.keyword": params.sortOrder === "desc" ? "desc" : "asc",
      }];
    }
    if (params.limit !== undefined) {
      const page = params.page ?? 1;
      body.size = params.limit;
      body.from = (page - 1) * params.limit;
    } else {
      body.size = 10_000;
    }
    if (format === "uris") body._source = false;

    let result;
    try {
      result = await this.executor.search(index, body);
    } catch {
      return format === "uris" ? [] : [];
    }
    if (format === "uris") {
      return result.hits.map((hit) => `${protocol}://${hostname}/${hit._id}`);
    }
    return result.hits.map((hit): Output<EntityRecord> => {
      const uri = `${protocol}://${hostname}/${hit._id}`;
      if (!hit._source) return [uri, undefined as unknown as EntityRecord];
      if (meta.isBytes) {
        return [uri, { payload: decodeBase64(hit._source.payload as string) }];
      }
      return [uri, decodeRecord(meta.fields, hit._source)];
    });
  }

  private async _count(
    meta: ElasticsearchEntityMeta,
    parsed: ParsedUrl,
  ): Promise<number> {
    const { protocol, hostname, docId } = uriParts(parsed.uri);
    const index = this._dataIndex(meta, protocol, hostname);
    try {
      return await this.executor.count(index, {
        query: this._leafQuery(docId, parsed.params.pattern),
      });
    } catch {
      return 0;
    }
  }

  // ── Delete ───────────────────────────────────────────────────────

  async delete(
    meta: ElasticsearchEntityMeta,
    uris: string[],
  ): Promise<DeleteResult[]> {
    if (uris.length === 0) return [];
    if (
      (await this._readMetaSignature(meta.support.entity)) !== meta.signature
    ) {
      return uris.map((uri) => ({
        success: false,
        ...storageFailure(
          new Error(
            `${STORE_NAME}: entity '${meta.support.entity}' is not provisioned`,
          ),
          "Entity not provisioned",
          uri,
        ),
      }));
    }
    const results: DeleteResult[] = [];
    for (const uri of uris) {
      try {
        const { protocol, hostname, docId } = uriParts(uri);
        const index = this._dataIndex(meta, protocol, hostname);
        await this.executor.delete(index, docId);
        results.push({ success: true });
      } catch (err) {
        results.push({
          success: false,
          ...storageFailure(err, "Delete failed", uri),
        });
      }
    }
    return results;
  }

  // ── Status / capabilities ────────────────────────────────────────

  async status(): Promise<StatusResult> {
    try {
      const ok = await this.executor.ping();
      if (!ok) {
        return {
          status: "unhealthy",
          message: "Elasticsearch cluster is not reachable",
          fns: ["read", "ls", "count"],
        };
      }
      const schema = await this._listProvisionedEntities();
      return {
        status: "healthy",
        message: "Elasticsearch store is operational",
        schema: schema.map((s) => `entity:${s}`),
        fns: ["read", "ls", "count"],
        details: { indexPrefix: this.indexPrefix },
      };
    } catch (error) {
      return {
        status: "unhealthy",
        message: error instanceof Error ? error.message : String(error),
        fns: ["read", "ls", "count"],
      };
    }
  }

  capabilities(): StoreCapabilities {
    return { atomicBatch: false };
  }

  // ── Internals ────────────────────────────────────────────────────

  /** Per-entity, per-`protocol_hostname` data index. */
  private _dataIndex(
    meta: ElasticsearchEntityMeta,
    protocol: string,
    hostname: string,
  ): string {
    return `${this.indexPrefix}_${meta.indexInfix}${protocol}_${hostname}`;
  }

  /** Single meta index holding `{name → signature}` provisioning records. */
  private _metaIndex(): string {
    return `${this.indexPrefix}_${META_INDEX_SUFFIX}`;
  }

  /**
   * Read the persisted signature for an entity, or `null` if no
   * provisioning record exists.
   */
  private async _readMetaSignature(
    entityName: string,
  ): Promise<string | null> {
    try {
      const doc = await this.executor.get(this._metaIndex(), entityName);
      if (!doc) return null;
      return (doc.signature as string) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Scan the meta index for every provisioned entity name. Used by
   * `status()` to advertise the entities a peer can talk to.
   */
  private async _listProvisionedEntities(): Promise<string[]> {
    try {
      const result = await this.executor.search(this._metaIndex(), {
        query: { match_all: {} },
        size: 10_000,
      });
      return result.hits.map((h) => h._id);
    } catch {
      return [];
    }
  }

  /**
   * Collect any `ReadableStream` values on `bytes`-tagged fields into
   * `Uint8Array` and return a shallow-copied record.
   */
  private async _normaliseBytesFields(
    record: EntityRecord,
    bytesFields: ReadonlySet<string>,
  ): Promise<EntityRecord> {
    const out: EntityRecord = { ...record };
    for (const name of bytesFields) {
      const v = out[name];
      if (v === undefined || v === null) continue;
      if (v instanceof Uint8Array) continue;
      if (v instanceof ReadableStream) {
        out[name] = await toBytes(v);
        continue;
      }
      throw new Error(
        `field '${name}' must be Uint8Array or ReadableStream, got ${typeof v}`,
      );
    }
    return out;
  }
}
