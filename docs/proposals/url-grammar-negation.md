# URL grammar for negation — "paths that do NOT have a given leaf or branch"

Status: **proposal / RFC** · Owner: save-layer grammar · Depends on: v2 listing
spec (`src/url.ts` module docs), glob adapters (`src/glob.ts`), dispatch
push-down (`src/dispatch.ts`).

## Problem

The v2 grammar can only express **positive** membership. `pattern`/URI-embedded
globs match a _prefix_ + a _tail glob_; there is no way to ask the inverse:

- **negate a leaf** — "every record under `blog://` whose basename is **not**
  `index.md`" (the leaf is the last path segment — `leafOf()` in `src/read.ts`).
- **negate a branch** — "every record under `blog://` that does **not** live
  under a `drafts/` segment anywhere in its path" (a branch is an intermediate
  segment / subtree).

Today a caller has to over-fetch with `**?fn=find` and filter in application
code. That defeats push-down (the whole point of `pushDownPattern` /
`_leafQuery`), and forces every caller to re-implement `leafOf` + segment
splitting.

### Grounding vocabulary in the existing code

| Term      | Definition                                         | Where it lives today                                              |
| --------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| leaf      | last `/`-segment (basename)                        | `leafOf()` `src/read.ts:138`, `sortBy=leaf` `src/dispatch.ts:374` |
| branch    | any intermediate segment / subtree                 | implicit — the `[^/]+/` runs in `saveGlobToRegexBody`             |
| glob tail | wildcard portion split off the URI path            | `splitLocatorGlob()` `src/url.ts:152`                             |
| prefix    | literal routing identity before the first wildcard | `parsed.uri` `src/url.ts:106`                                     |

## Constraints any proposal must respect

1. **Core stays a strict subset.** `b3nd-core`'s `compilePattern` (`?` literal,
   `*`→`[^/]+`, trailing-only `**`) is load-bearing for route/observe semantics
   (v2 §7.1). Save may add grammar _on top_ but must not require core to learn
   negation, or observe-match keys and read-match keys drift apart.
   (`src/glob.ts` header, `isInsideCoreSubset` `src/glob.ts:64`.)
2. **Push-down or honest fallback.** Every filter must either translate to each
   backend's native query (SQL `LIKE`, Mongo `$regex`, ES `regexp`) **or**
   degrade to a dispatch-level post-filter (`needsPatternPostFilter`
   `src/dispatch.ts:275`). No silent shallow-wrong results (§3.5 loud-failure
   rule).
3. **No silent-default trap (§3.4).** A URL that _looks_ like it filters but
   isn't understood must throw, not return the unfiltered set.
4. **Round-trips through `parseUrl`/`buildUrl`.** Whatever we add has to survive
   `src/url.ts` parsing and `buildUrl` serialization without ambiguity.

Two architectural directions are open, and the brief asks to follow one of them:

- **Glob direction** — a new _token inside the URI path_ (extends
  `splitLocatorGlob` + the three `glob.ts` compilers).
- **fn/param direction** — a new _query param or verb_ (extends `ReadParams` +
  the `dispatchRead` switch + `pushDown*` flags).

Proposals A/E/F are glob-direction; B/C/D are fn/param-direction.

---

## Proposal A — Inline negated segment token `!seg` (glob direction)

Add one token to the glob grammar: a path segment prefixed with `!` matches any
single segment that is **not** equal to the rest of the token.

```
blog://posts/**/!index.md?fn=find     # leaf is not index.md
blog://!drafts/**?fn=find             # top branch is not drafts
blog://**/!drafts/**?fn=find          # no drafts branch anywhere
```

Compilation:

- regex (`compileSaveGlob`): `!index.md` → `(?!index\.md$)[^/]+` (negative
  lookahead + segment body). Falls entirely on the **save-local** path
  (`buildSaveLocalRegexBody`) — `!` is never inside `isInsideCoreSubset`.
- SQL (`globToSqlLike`): a single `LIKE` cannot negate a segment. Emit the
  positive skeleton and add a sibling `AND uri NOT LIKE prefix||'%/index.md'`
  predicate — i.e. the token must _lift out_ of the LIKE body into a companion
  clause. sqlite alternatively uses `GLOB`/regex; postgres uses `!~`.
- Mongo/ES: negative lookahead in the `regexp` body (both engines support it).

**Tradeoffs**

| +                                                                         | −                                                                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Reads naturally, lives in the path like every other wildcard              | `!` must lift out of `LIKE` into a companion predicate — `globToSqlLike` can no longer be a pure body-string function; changes its contract |
| Regex/Mongo/ES push-down is a clean negative lookahead                    | Furthest from core's subset — always save-local, so this token can never appear in an observe/route pattern                                 |
| One token covers both leaf (`!x` as last seg) and branch (`!x/` mid-path) | `!` is not currently reserved; existing literal keys containing `!` need an escape (`\!`), a back-compat break                              |
| No new fn/param surface                                                   | Composing multiple negations (`!a` and `!b` in the same query) means multiple lookaheads — readable but the SQL companion-clause list grows |

Best when callers think in path shapes and most traffic hits regex-capable
backends (Mongo/ES/memory). Weakest on the SQL backends that the push-down
matrix is proudest of.

---

## Proposal B — `exclude=<glob>` companion param (fn/param direction)

Keep the positive glob as the _candidate set_; add a symmetric query param that
removes matches. Mirrors how `pattern` already works, including its push-down
opt-in.

```
blog://**?fn=find&exclude=**/index.md         # candidates = all; drop index.md leaves
blog://**?fn=find&exclude=**/drafts/**        # drop anything under a drafts branch
blog://posts/*?fn=ls&exclude=_*               # ls, minus underscore-prefixed leaves
```

Implementation is almost mechanical against today's code:

- `ReadParams.exclude?: string` in `src/url.ts`; parse it exactly like `pattern`
  (it is a glob, reuses all of `glob.ts`).
- `dispatchRead`: add
  `needsExcludePostFilter = exclude !== undefined &&
  !handlers.pushDownExclude`.
  In the post-filter block, after the `pattern` keep-filter, run a
  **drop**-filter with the same `compileSaveGlob(exclude)` regex
  (`arr.filter(uri => !re.test(tail))`).
- Push-down opt-in `pushDownExclude`: SQL appends `AND uri NOT LIKE …`; Mongo
  wraps `$not`; ES adds a `must_not` regexp clause (`_leafQuery`
  `src/elasticsearch/store.ts:369` already composes a `bool` — drop the exclude
  body into `must_not`).

**Tradeoffs**

| +                                                                                                                       | −                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Smallest blast radius** — reuses `glob.ts` verbatim, one new param, one new post-filter branch, one new pushDown flag | Two glob expressions in one URL; caller must know to write `**/index.md` not `index.md`                                                           |
| Push-down is a textbook `NOT LIKE` / `must_not` on every backend                                                        | Doesn't name "leaf" or "branch" — the _caller_ encodes that distinction in the glob (`**/x` = leaf, `**/x/**` = branch). Easy to get subtly wrong |
| Core untouched; observe/route unaffected (it's a read-only param)                                                       | Semantics "exclude relative to what?" must be pinned: exclude applies to the **full URI tail**, evaluated after `pattern`, before pagination      |
| Composes: `pattern` narrows, `exclude` subtracts — orthogonal                                                           | Only one `exclude` per URL unless we allow repeats (`exclude=a&exclude=b`)                                                                        |

Best all-round fit with the existing architecture. Recommended as the general
mechanism (see recommendation).

---

## Proposal C — First-class `leaf`/`branch` predicates with `!=` (fn/param direction)

Name the two concepts the brief actually asks for. Add semantic params whose
_negated_ form is the headline feature:

```
blog://**?fn=find&leaf!=index.md      # leaf (basename) is not index.md
blog://**?fn=find&branch!=drafts      # no path segment equals drafts
blog://**?fn=find&leaf=*.md&branch!=drafts   # positive + negative combined
```

`leaf`/`branch` take an exact segment (or a **segment-glob** — a glob with no
`/`, so `leaf!=*.tmp` works). Backend translation is a fixed template, so
push-down is trivial and index-friendly:

| predicate   | SQL                                                           | regex body  |
| ----------- | ------------------------------------------------------------- | ----------- |
| `leaf!=X`   | `uri NOT LIKE prefix\|\|'%/'\|\|X` (and `uri <> prefix\|\|X`) | `(?!.*/X$)` |
| `branch!=X` | `uri NOT LIKE prefix\|\|'%/'\|\|X\|\|'/%'`                    | `(?!.*/X/)` |
| `leaf=X`    | `uri LIKE prefix\|\|'%/'\|\|X`                                | positive    |

Parsing note: `URLSearchParams` treats `leaf!=index.md` as key `leaf!` value
`index.md`. `parseUrl` (`src/url.ts:274`) would special-case the trailing `!`
into a negation flag, or we spell it `notLeaf=`/`notBranch=` to avoid touching
the parser. (Recommend `notLeaf=`/`notBranch=` for parser cleanliness; `!=` is
prettier but leaks into the URLSearchParams key.)

**Tradeoffs**

| +                                                                                                              | −                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Directly answers the brief** — "leaf or branch" become named, discoverable params                            | Most new _concept_ surface: two params × two polarities, plus validation rules                                                                           |
| Cleanest possible push-down — each maps to one fixed `NOT LIKE` / lookahead template, no glob compiler changes | Less general than B — a predicate is one segment; "not under `a/b/`" (a two-segment branch) needs either `branch` to accept sub-paths or falls back to B |
| Self-documenting; hard to misuse (unlike encoding leaf-vs-branch in a glob)                                    | New param names to teach; `!=` vs `notLeaf=` bikeshed; interaction matrix with `pattern` must be defined                                                 |
| Backend-agnostic: even memory store gets an obvious `leafOf(uri) !== X` check                                  | Scope creep risk — callers will ask for `leaf>`, `depth<`, etc. once predicates exist                                                                    |

Best when the leaf/branch distinction is the _primary_ use case (which the brief
implies) and readability/discoverability matter more than generality.

---

## Proposal D — Set difference via `fn=find&except=<sub-locator>` (fn/param direction)

Model negation as full set subtraction: `result = find(A) \ find(B)`, where `B`
is an entire nested locator.

```
blog://**?fn=find&except=blog://**/index.md
blog://**?fn=find&except=blog://drafts/**
```

Dispatch runs both walks, subtracts by URI (`Set` of B's URIs), returns the
remainder. No glob-compiler or backend changes required for the baseline
(in-process subtraction); backends with anti-join/`NOT IN (subquery)` can opt
into a push-down later.

**Tradeoffs**

| +                                                                                           | −                                                                                                                             |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Most general** — B is an arbitrary locator (any glob, any depth, even a different prefix) | **Most expensive** — two full result sets materialized, then a set difference; no push-down in the baseline                   |
| Zero glob-grammar change; reuses `find` end-to-end                                          | A URL nested inside a URL param is ugly and needs careful encoding (`except=` value must be percent-encoded)                  |
| Trivially correct semantics (literal set minus)                                             | Overkill for the common single-leaf/single-branch case — pays N× cost for a 1-token need                                      |
| Naturally extends to intersection/union later                                               | Cursor pagination over a subtraction is hard (the trailing-slot cursor logic in `buildCursorSlot` assumes one ordered stream) |

Best as an _escape hatch_ for genuinely complex exclusions, not the everyday
path. Poor as the primary mechanism.

---

## Proposal E — Extended-glob operators `!(…)` / `[!…]` (glob direction)

Adopt shell extglob / character-class negation into the tokenizer:

```
blog://**/!(index.md)?fn=find         # extglob: segment that is not index.md
blog://logs/2026-[!01]?.txt?fn=ls     # char class: month not 00-19
```

Extends `buildSaveLocalRegexBody` (`src/glob.ts:230`) with `!(…)`→`(?!…)[^/]*`
and `[!…]`→`[^…]`, and teaches `isInsideCoreSubset` to always reject them.

**Tradeoffs**

| +                                                                                            | −                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Familiar to anyone who knows bash extglob / fnmatch                                          | **Heaviest compiler change** — `glob.ts` gains a real sub-parser (nested groups, char classes, ranges)                                                                       |
| Most expressive within the glob direction (char-level + segment-level negation, alternation) | `LIKE` cannot express char-class negation at all → SQL backends must fall back to `GLOB`(sqlite) / `~`(postgres) or to dispatch post-filter; `globToSqlLike` contract breaks |
| Single grammar for many needs beyond leaf/branch                                             | Furthest drift from core; biggest test surface; easiest to introduce regex-injection / catastrophic-backtracking bugs                                                        |
| No new fn/param                                                                              | Two negation syntaxes (`!(…)` vs `[!…]`) to document and validate                                                                                                            |

Best only if the project wants a full glob engine long-term. Highest cost for
this specific ask.

---

## Proposal F — Provider extension `x-match.exclude=<glob>` (glob-value via ext bag)

Ship exclusion as an `x-<ns>.<key>` extension param (`ext` bag,
`src/url.ts:276`) instead of reserving new grammar. Stores opt in; stores that
don't understand it throw at the `ext` handler.

```
blog://**?fn=find&x-match.exclude=**/index.md
```

**Tradeoffs**

| +                                                                             | −                                                                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Zero risk to the locked v2 grammar** — nothing reserved, fully experimental | `ext` is opaque and per-provider → _no uniform guarantee_, which is exactly the drift the grammar exists to prevent |
| Ship in one backend, learn, promote to a real param later                     | Poor discoverability; every store re-implements parsing of the same glob                                            |
| Reuses `glob.ts` for the value                                                | Awkward permanent home — this only makes sense as a staging ground for B or C                                       |

Best purely as a **transition vehicle**: prototype B/C behind `x-match.*`, then
graduate it into reserved grammar once proven.

---

## Comparison matrix

| #                         | Direction | Answers "leaf/branch" directly |             SQL push-down              | Regex push-down (Mongo/ES/mem) |    Core impact    | Impl. cost | Generality  |
| ------------------------- | --------- | :----------------------------: | :------------------------------------: | :----------------------------: | :---------------: | :--------: | :---------: |
| A `!seg`                  | glob      |         via convention         | companion `NOT LIKE` (contract change) |          ✅ lookahead          | none (save-local) |   medium   |   medium    |
| B `exclude=`              | param     |         via convention         |             ✅ `NOT LIKE`              |         ✅ `must_not`          |       none        |  **low**   |    high     |
| C `notLeaf=`/`notBranch=` | param     |          ✅ **named**          |           ✅ fixed template            |       ✅ fixed lookahead       |       none        |  low–med   |   medium    |
| D `except=<url>`          | param     |         via convention         |         ❌ (baseline in-proc)          |               ❌               |       none        |   medium   | **highest** |
| E `!(…)`/`[!…]`           | glob      |         via convention         |        ❌ (regex/GLOB fallback)        |               ✅               | none (save-local) |  **high**  |    high     |
| F `x-match.exclude`       | ext       |         via convention         |               per-store                |           per-store            |       none        |    low     |    high     |

## Recommendation

Ship **C (`notLeaf=` / `notBranch=`)** as the primary, headline feature — it
names the exact concepts the brief asks for, is self-documenting, and pushes
down to a single fixed `NOT LIKE`/lookahead template on every backend without
touching `glob.ts` or core. Layer **B (`exclude=<glob>`)** underneath as the
general escape hatch for multi-segment or glob-shaped exclusions that a single
leaf/branch predicate can't express. The two compose cleanly (C is the common
case, B the general case), share the same push-down machinery (`pushDown*` flag

- `dispatchRead` post-filter fallback), and leave the v2 reserved grammar and
  `b3nd-core` untouched.

Sequencing:

1. Land **B** first (smallest diff: one `ReadParams` field, one dispatch
   drop-filter branch, one `pushDownExclude` flag) — it unblocks every caller
   immediately with an honest in-process fallback.
2. Add **C** as sugar over the same plumbing, with the fixed SQL/regex templates
   for real index use.
3. Keep **D** on the shelf as a documented pattern for the rare arbitrary-set
   subtraction; reach for **F** only if we want to prototype behind `x-` before
   reserving grammar.

Explicitly **not** recommended for this ask: **E** (a full glob engine is far
more than "negate a leaf or branch" needs) and **A** (breaks `globToSqlLike`'s
pure-body contract and reserves `!` in path segments — a back-compat hazard for
keys that legitimately contain `!`).

## Validation & edge rules (apply to whichever lands)

- **§3.4 no-silent-trap:** an `exclude`/`notLeaf`/`notBranch` on a URL with no
  `**`/`*` is still meaningful (filters a shallow `ls`); but an _unknown_
  negation param must throw via the existing `default:` in the `parseUrl` param
  switch (`src/url.ts:302`), never be ignored.
- **Empty result is content, not error** — consistent with "miss is
  `payload === undefined`".
- **Ordering:** negation filters run _after_ `pattern` (positive narrowing) and
  _before_ pagination/cursor — same slot as the current `needsPatternPostFilter`
  block so `limit`/`cursor` see the final set.
- **Push-down honesty:** a backend that sets `pushDownExclude`/predicate flags
  owns the full translation; a backend that doesn't gets the dispatch
  post-filter. No backend returns an unfiltered set silently.
