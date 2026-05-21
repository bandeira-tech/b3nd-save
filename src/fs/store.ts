/**
 * FsStore — Filesystem implementation of Store.
 *
 * Pure mechanical byte storage with no protocol awareness. Writes one
 * file per entry; the file body is the payload bytes verbatim. The
 * store is opaque — it does not parse or transform contents.
 *
 * `fn=ls` / `fn=count` are shallow direct-leaves only: they list the
 * `.bin` files directly inside the prefix's mapped directory, never
 * recursing into subdirectories.
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

import type { ParsedUrl } from "@bandeira-tech/b3nd-core/url";
import { dispatchRead } from "../dispatch.ts";
import { storageFailure } from "../errors.ts";
import { validateReadParams } from "../read.ts";
import type {
  StoreCapabilities,
  StoreEntry,
  StoreWriteResult,
} from "../types.ts";
import type { FsExecutor } from "./mod.ts";

const STORE_NAME = "FsStore";
const EXT = ".bin";

/**
 * Convert a URI to a relative filesystem path.
 * `protocol://host/path` becomes `protocol_host/path.bin`.
 *
 * Only the FIRST `://` is rewritten — embedded `://` (rare but legal
 * in protocol-tunneling uris) stays in the path.
 */
function uriToRelPath(uri: string): string {
  return uri.replace("://", "_") + EXT;
}

/**
 * Convert a relative filesystem path back to a URI.
 * `protocol_host/path.bin` becomes `protocol://host/path`.
 */
function relPathToUri(relPath: string): string {
  const withoutExt = relPath.endsWith(EXT)
    ? relPath.slice(0, -EXT.length)
    : relPath;
  return withoutExt.replace("_", "://");
}

export class FsStore implements EntityStore<BytesOnlyEntityMeta> {
  private readonly rootDir: string;
  private readonly executor: FsExecutor;

  constructor(rootDir: string, executor: FsExecutor) {
    if (!rootDir) throw new Error("rootDir is required");
    if (!executor) throw new Error("executor is required");

    this.rootDir = rootDir.replace(/\/+$/, "");
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
        await this.executor.writeFile(
          this._resolvePath(entry.uri),
          entry.payload,
        );
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

  private async _readOne(
    uri: string,
  ): Promise<ReadableStream<Uint8Array> | undefined> {
    try {
      return await this.executor.readFile(this._resolvePath(uri));
    } catch {
      return undefined;
    }
  }

  /** Resolve the on-disk directory that holds the direct leaves of `prefixUri`. */
  private _dirForPrefix(prefixUri: string): string {
    const rel = uriToRelPath(prefixUri).slice(0, -EXT.length).replace(
      /\/+$/,
      "",
    );
    return rel ? `${this.rootDir}/${rel}` : this.rootDir;
  }

  /** List direct-child URIs under a prefix (no recursion). */
  private async _listChildUris(prefixUri: string): Promise<string[]> {
    let files: string[];
    try {
      files = await this.executor.listFiles(this._dirForPrefix(prefixUri));
    } catch {
      return [];
    }
    const relDir = uriToRelPath(prefixUri).slice(0, -EXT.length).replace(
      /\/+$/,
      "",
    );
    return files
      .filter((f) => f.endsWith(EXT) && !f.includes("/"))
      .map((f) => relPathToUri(`${relDir}/${f}`));
  }

  private async _ls(parsed: ParsedUrl): Promise<Output[] | string[]> {
    validateReadParams(parsed.params, STORE_NAME);
    const { params } = parsed;
    const format = params.format ?? "full";

    let uris = await this._listChildUris(parsed.uri);

    if (params.sortBy === "uri") {
      const dir = params.sortOrder === "desc" ? -1 : 1;
      uris = [...uris].sort((a, b) => a.localeCompare(b) * dir);
    }
    if (params.limit !== undefined) {
      const page = params.page ?? 1;
      const start = (page - 1) * params.limit;
      uris = uris.slice(start, start + params.limit);
    }

    if (format === "uris") return uris;

    const out: Output[] = [];
    for (const uri of uris) {
      out.push([uri, await this._readOne(uri)]);
    }
    return out;
  }

  private async _count(parsed: ParsedUrl): Promise<number> {
    if (parsed.params.pattern !== undefined) {
      throw new Error(`${STORE_NAME}: pattern filter not supported`);
    }
    return (await this._listChildUris(parsed.uri)).length;
  }

  private async _deleteBytes(uris: string[]): Promise<DeleteResult[]> {
    const results: DeleteResult[] = [];

    for (const uri of uris) {
      try {
        await this.executor.removeFile(this._resolvePath(uri));
        results.push({ success: true });
      } catch {
        // File may not exist — succeed silently (matches the
        // miss-is-not-an-error convention)
        results.push({ success: true });
      }
    }

    return results;
  }

  // ── Status ───────────────────────────────────────────────────────

  async status(): Promise<StatusResult> {
    try {
      const rootExists = await this.executor.exists(this.rootDir);
      if (!rootExists) {
        return {
          status: "unhealthy",
          message: `Root directory not found: ${this.rootDir}`,
          fns: ["read", "ls", "count"],
        };
      }
      return {
        status: "healthy",
        message: "Filesystem store is operational",
        fns: ["read", "ls", "count"],
        details: { rootDir: this.rootDir },
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

  private _resolvePath(uri: string): string {
    return `${this.rootDir}/${uriToRelPath(uri)}`;
  }
}
