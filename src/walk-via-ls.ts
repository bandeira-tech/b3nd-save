/**
 * @module
 * `walkViaLs` — caller-invoked polyfill that simulates `fn=find`
 * against stores that advertise only `fn=ls`.
 *
 * **When to use.** A caller wants every entry under a prefix (the
 * recursive-listing use case `fn=find` solves) but is targeting a store
 * whose `status().fns` includes `"ls"` and NOT `"find"`. Without this
 * helper the caller would have to hand-roll the recursive walk.
 *
 * **When NOT to use.** If the target store advertises `"find"`, call
 * `?fn=find` directly — it will be cheaper (push-down where possible,
 * single network round-trip in many cases). `walkViaLs` is the explicit
 * fallback, *never* an auto-engaged dispatch fallback (per v1 spec §7
 * `.cc-chat/20260625093437-listing-spec/output.md`). Capability check
 * is the caller's responsibility:
 *
 * ```ts
 * const status = await rig.status();
 * const fns = status?.fns ?? [];
 * const uris = fns.includes("find")
 *   ? await rig.read([`${prefix}**?fn=find&format=uris`])
 *   : await walkViaLs(rig.read.bind(rig), prefix, { format: "uris" });
 * ```
 *
 * **Contract.** `walkViaLs` uses ONLY the standard b3nd PIN `read`
 * surface — no privileged store access, no rig internals. It issues
 * repeated shallow `?fn=ls&format=uris` calls level-by-level, recursing
 * into each child whose own `?fn=ls&format=uris` returns at least one
 * entry (probe-based directory detection — see Design notes below).
 *
 * **What this DOES NOT do:**
 *   - No streaming. The full result accumulates before returning.
 *   - No pagination. The helper always returns the complete walk; if
 *     the underlying store's `ls` paginates, callers must wrap that
 *     concern themselves (or push for `fn=find` support).
 *   - No parallelism. Each level is walked serially. This is a
 *     polyfill; the right answer for performance is `fn=find`.
 *   - No content-equivalence guarantees with `fn=find`. Push-down
 *     `fn=find` may sort/paginate differently. `walkViaLs` returns a
 *     stable depth-first traversal in the order each level's `ls`
 *     yields its children.
 *
 * **Cost model.** O(D) sequential round-trips where D is the count of
 * non-empty directories under `prefix`. For deep trees this is much
 * worse than a single `fn=find` push-down. Use only when capability
 * forces it.
 *
 * **Design notes** (decisions documented for reviewers):
 *
 * 1. *Directory detection: probe via ls, not URI shape.* A naive
 *    "no trailing slash → leaf" or "no dot-extension → directory"
 *    heuristic would mis-classify common shapes (an entity named
 *    `notes` with no extension; a file URI ending in `/`). Probing
 *    via `?fn=ls&format=uris` is authoritative: if it returns any
 *    URIs, recurse; if it returns the empty set, treat as terminal.
 *    The cost is one extra ls per leaf URI — accepted because
 *    `walkViaLs` is already O(D) and the spec calls it out as a slow
 *    polyfill.
 *
 * 2. *Pattern filtering happens at the helper, not the wire.* The
 *    underlying store's `ls` only supports `*` / `?` (no `**` — that's
 *    why we're walking via ls). `compileSaveGlob` from `./glob.ts`
 *    applies the full v2 §3.3 grammar (including `**`) to the
 *    accumulated tail-URIs before returning. Callers see the same
 *    glob semantics they would from `fn=find`.
 *
 * 3. *No cursor pagination.* `fn=find` ships a trailing cursor slot
 *    (v2 §3.5); this polyfill always returns the full accumulated set
 *    and never appends a cursor slot. Callers needing pagination must
 *    upgrade to `fn=find`-capable storage.
 */

import type { Output } from "@bandeira-tech/b3nd-core/types";
import { compileSaveGlob } from "./glob.ts";

/**
 * Options for {@link walkViaLs}. Mirrors the subset of `find` params
 * the helper can honor against a `ls`-only store.
 */
export interface WalkViaLsOptions {
  /**
   * Glob pattern applied to URI tails (relative to `prefix`). Uses the
   * v2 §3.3 grammar — `*`, `?`, and `**` all work. Patterns are matched
   * against the post-prefix tail (same anchoring as `matchesGlob`).
   * Defaults to "all descendants" (no pattern filter).
   */
  pattern?: string;
  /**
   * `"full"` (default) returns `Output[]` — each `[uri, payload]` is
   * the result of a separate `?fn=read` on that leaf. `"uris"` returns
   * `string[]` — leaf URIs only, no payload reads.
   */
  format?: "full" | "uris";
  /**
   * Soft cap on the number of distinct directories the helper will
   * probe. Defaults to 10_000. When exceeded, the helper throws — the
   * caller is almost certainly walking a larger tree than they meant
   * to (or hitting a backend cycle). Set explicitly to opt into deeper
   * walks.
   */
  maxDirs?: number;
}

/**
 * Caller-invoked recursive `ls` walker — the polyfill for stores that
 * advertise only `fn=ls`.
 *
 * @param read   The b3nd `read` surface (`rig.read`, a connection's
 *               `read`, or any function with the same signature). Every
 *               call passes a single-element URL array; the helper never
 *               batches.
 * @param prefix The routing prefix to walk. Trailing `/` is normalized
 *               in — callers can pass either form.
 * @param opts   See {@link WalkViaLsOptions}.
 *
 * @returns `Output[]` for `format=full` (default) or `string[]` for
 *          `format=uris`. The ordering is depth-first, in the order each
 *          probed directory's `ls` yields its children.
 *
 * @throws If a probed directory's `ls` rejects, the rejection
 *         propagates. If the per-walk directory cap is exceeded, throws
 *         `Error("walkViaLs: maxDirs exceeded")`.
 */
export async function walkViaLs(
  read: <T = unknown>(urls: string[]) => Promise<Output<T>[]>,
  prefix: string,
  opts: WalkViaLsOptions = {},
): Promise<Output[] | string[]> {
  const format = opts.format ?? "full";
  const maxDirs = opts.maxDirs ?? 10_000;
  const root = prefix.endsWith("/") ? prefix : prefix + "/";

  // Collect every URI surfaced by the recursive walk. Depth-first;
  // a URI counts as a "leaf" iff its own ls returns the empty set.
  // The probe-vs-shape decision is documented at module scope.
  const leaves: string[] = [];
  let dirsProbed = 0;

  // Stack of directory URIs (each ends with "/") still to probe. We
  // process LIFO for predictable depth-first ordering.
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    dirsProbed++;
    if (dirsProbed > maxDirs) {
      throw new Error(
        `walkViaLs: maxDirs exceeded (${maxDirs}) while walking ${prefix}`,
      );
    }

    const lsUrl = `${dir}?fn=ls&format=uris`;
    const outs = await read<string[]>([lsUrl]);
    // `read([url])` is 1:1; the single output's payload is the uri list
    // for `format=uris`. Defensive: treat missing / non-array as empty.
    const payload = outs[0]?.[1];
    const children: string[] = Array.isArray(payload) ? payload : [];

    if (children.length === 0) {
      // Empty ls = terminal. The dir URI itself is the "leaf" the
      // caller asked about — but only if dir !== root (the caller did
      // not ask for the root itself). Skip the root from leaves.
      if (dir !== root) leaves.push(dir);
      continue;
    }

    // Push children in reverse so the first child is popped first
    // (depth-first, left-to-right ordering on the original list).
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      // Normalize a child URI for the next probe: directories should
      // end with `/` so the `?fn=ls` URL composes cleanly. We can't
      // tell yet whether `child` is a leaf or directory — we add the
      // trailing slash for the probe and rely on the empty-ls case to
      // detect "this was actually a leaf, the ls just returned []".
      // For files this means one extra ls call per file; documented.
      stack.push(child.endsWith("/") ? child : child + "/");
    }
  }

  // Strip the trailing `/` we added during probing so URIs surface to
  // the caller as `?fn=find` would surface them (find returns leaf
  // URIs as the store wrote them; the probe-slash is a helper artifact).
  const normalized = leaves.map(stripProbeSlash);

  // Apply the user's pattern (if any) to the accumulated leaves. The
  // helper does this in-process because the underlying store's `ls`
  // can't express `**` — if it could, we wouldn't be polyfilling.
  let filtered: string[];
  if (opts.pattern !== undefined) {
    const re = compileSaveGlob(opts.pattern);
    filtered = normalized.filter((uri) => {
      if (!uri.startsWith(root)) return false;
      return re.test(uri.slice(root.length));
    });
  } else {
    filtered = normalized;
  }

  if (format === "uris") return filtered;

  // `format=full`: fetch payloads for each leaf in a single batched
  // read. Callers that want streaming should not use walkViaLs.
  if (filtered.length === 0) return [];
  const outs = await read(filtered);
  return outs;
}

/**
 * The walker appends `/` to every child URI before probing so the
 * `?fn=ls` URL composes cleanly. Strip that artifact before returning
 * URIs to the caller — `?fn=find` would surface the leaf URI as the
 * store wrote it, without the helper's probe-slash.
 *
 * We only strip a single trailing slash; URIs the caller-supplied root
 * are already filtered out before this is called.
 */
function stripProbeSlash(uri: string): string {
  return uri.endsWith("/") ? uri.slice(0, -1) : uri;
}
