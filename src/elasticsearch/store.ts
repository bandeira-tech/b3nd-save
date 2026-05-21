/**
 * ElasticsearchStore — Elasticsearch implementation of Store.
 *
 * Pure mechanical byte storage with no protocol awareness. URIs are
 * partitioned into one index per `protocol_hostname` pair, with the
 * path as the document `_id`. Payload bytes are base64-encoded into a
 * string field — ES has no native binary type that round-trips
 * arbitrary bytes through `_source`.
 *
 * `fn=ls` / `fn=count` are pushed down via an ES regex query that
 * enforces the shallow-direct-leaves contract: `<docPrefix>[^/]+`.
 * Lucene regex queries are auto-anchored, so the pattern must match
 * the full `_id`.
 */

import type {
  DeleteResult,
  Output,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import {
  bytesOnlyDelete,
  type BytesOnlyEntityMeta,
  bytesOnlyEntitySupport,
  bytesOnlyRead,
  bytesOnlyWrite,
} from "../byte-entity-shim.ts";
import type { EntityStore } from "../entity-store.ts";
import type { EntityRecord, EntitySchema } from "../entity.ts";

import { decodeBase64, encodeBase64 } from "@bandeira-tech/b3nd-core";
import type { ParsedUrl } from "@bandeira-tech/b3nd-core/url";
import { dispatchRead } from "../dispatch.ts";
import { storageFailure } from "../errors.ts";
import { toBytes } from "../payload.ts";
import { validateReadParams } from "../read.ts";
import type {
  StoreCapabilities,
  StoreEntry,
  StoreWriteResult,
} from "../types.ts";
import type { ElasticsearchExecutor } from "./mod.ts";

const STORE_NAME = "ElasticsearchStore";

/** Escape characters that are special in Lucene regex syntax. */
function escapeLuceneRegex(input: string): string {
  return input.replace(/[.?+*|{}\[\]()"\\#@&<>~]/g, "\\$&");
}

/**
 * Parse a URI into an Elasticsearch index name and document ID.
 * `protocol://hostname/path` → index: `prefix_protocol_hostname`,
 * docId: `path` (without leading slash).
 */
function uriToIndexAndDocId(
  uri: string,
  indexPrefix: string,
): { index: string; docId: string } {
  const url = new URL(uri);
  const protocol = url.protocol.replace(":", "");
  const hostname = url.hostname;
  return {
    index: `${indexPrefix}_${protocol}_${hostname}`,
    docId: url.pathname.substring(1),
  };
}

/** Reconstruct a URI from an index name + document ID. */
function indexAndDocIdToUri(
  index: string,
  indexPrefix: string,
  docId: string,
): string {
  const withoutPrefix = index.substring(indexPrefix.length + 1);
  const firstUnderscore = withoutPrefix.indexOf("_");
  const protocol = withoutPrefix.substring(0, firstUnderscore);
  const hostname = withoutPrefix.substring(firstUnderscore + 1);
  return `${protocol}://${hostname}/${docId}`;
}

export class ElasticsearchStore implements EntityStore<BytesOnlyEntityMeta> {
  private readonly indexPrefix: string;
  private readonly executor: ElasticsearchExecutor;

  constructor(indexPrefix: string, executor: ElasticsearchExecutor) {
    if (!indexPrefix) throw new Error("indexPrefix is required");
    if (!executor) throw new Error("executor is required");

    this.indexPrefix = indexPrefix;
    this.executor = executor;
  }

  // ── EntityStore surface ──────────────────────────────────────────

  entitySupport(schema: EntitySchema): BytesOnlyEntityMeta {
    return bytesOnlyEntitySupport(schema);
  }

  entityStatus(meta: BytesOnlyEntityMeta): Promise<"live" | "unprovisioned"> {
    return Promise.resolve(meta.isBytes ? "live" : "unprovisioned");
  }

  provisionEntity(_meta: BytesOnlyEntityMeta): Promise<void> {
    return Promise.resolve();
  }

  write(
    meta: BytesOnlyEntityMeta,
    entries: { uri: string; record: EntityRecord }[],
  ): Promise<StoreWriteResult[]> {
    return bytesOnlyWrite(
      meta,
      STORE_NAME,
      entries,
      (e) => this._writeBytes(e),
    );
  }

  read<T = EntityRecord | undefined>(
    meta: BytesOnlyEntityMeta,
    urls: string[],
  ): Promise<Output<T>[]> {
    return bytesOnlyRead<T>(
      meta,
      STORE_NAME,
      urls,
      (u) => this._readBytes(u),
    );
  }

  delete(meta: BytesOnlyEntityMeta, uris: string[]): Promise<DeleteResult[]> {
    return bytesOnlyDelete(
      meta,
      STORE_NAME,
      uris,
      (u) => this._deleteBytes(u),
    );
  }

  // ── Byte ops (BYTES_ENTITY routing) ──────────────────────────────

  private async _writeBytes(
    entries: StoreEntry[],
  ): Promise<StoreWriteResult[]> {
    const results: StoreWriteResult[] = [];

    for (const entry of entries) {
      try {
        const { index, docId } = uriToIndexAndDocId(
          entry.uri,
          this.indexPrefix,
        );
        // We mirror docId into a `path` source field so `ls`/`count`
        // can run analyzed queries against it — ES 8 disallows
        // `regexp` (and prefix/wildcard) against the `_id` metadata
        // field. ES's default dynamic mapping for a string source
        // field produces `path` (text) + `path.keyword` (keyword);
        // we target `path.keyword` for exact-match regex push-down.
        const bytes = await toBytes(entry.payload);
        await this.executor.index(index, docId, {
          payload: encodeBase64(bytes),
          path: docId,
        });
        results.push({ success: true });
      } catch (err) {
        results.push({
          success: false,
          ...storageFailure(err, "Write failed", entry.uri),
        });
      }
    }

    return results;
  }

  private _readBytes(urls: string[]): Promise<Output<unknown>[]> {
    return dispatchRead<unknown>(urls, STORE_NAME, {
      read: (p) => this._readOne(p.uri),
      ls: (p) => this._ls(p),
      count: (p) => this._count(p),
    });
  }

  private async _readOne(uri: string): Promise<Uint8Array | undefined> {
    const { index, docId } = uriToIndexAndDocId(uri, this.indexPrefix);
    const doc = await this.executor.get(index, docId);
    if (!doc) return undefined;
    return decodeBase64(doc.payload as string);
  }

  private _leafQuery(docPrefix: string): Record<string, unknown> {
    return {
      regexp: {
        "path.keyword": `${escapeLuceneRegex(docPrefix)}[^/]+`,
      },
    };
  }

  private async _ls(parsed: ParsedUrl): Promise<Output[] | string[]> {
    validateReadParams(parsed.params, STORE_NAME);
    const { params } = parsed;
    const format = params.format ?? "full";
    const { index, docId } = uriToIndexAndDocId(parsed.uri, this.indexPrefix);

    const body: Record<string, unknown> = {
      query: this._leafQuery(docId),
    };
    if (params.sortBy === "uri") {
      // Sort on the keyword subfield, same reason as the query above.
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

    const result = await this.executor.search(index, body);
    if (format === "uris") {
      return result.hits.map((hit) =>
        indexAndDocIdToUri(index, this.indexPrefix, hit._id)
      );
    }
    return result.hits.map((hit): Output => [
      indexAndDocIdToUri(index, this.indexPrefix, hit._id),
      hit._source ? decodeBase64(hit._source.payload as string) : undefined,
    ]);
  }

  private async _count(parsed: ParsedUrl): Promise<number> {
    if (parsed.params.pattern !== undefined) {
      throw new Error(`${STORE_NAME}: pattern filter not supported`);
    }
    const { index, docId } = uriToIndexAndDocId(parsed.uri, this.indexPrefix);
    return await this.executor.count(index, { query: this._leafQuery(docId) });
  }

  private async _deleteBytes(uris: string[]): Promise<DeleteResult[]> {
    const results: DeleteResult[] = [];

    for (const uri of uris) {
      try {
        const { index, docId } = uriToIndexAndDocId(uri, this.indexPrefix);
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

  // ── Status ───────────────────────────────────────────────────────

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
      return {
        status: "healthy",
        message: "Elasticsearch store is operational",
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
}
