# CLAUDE.md — b3nd-save

## Working conventions

### Feature branches and worktrees

Every non-trivial change gets a feature branch with a dedicated local worktree:

```sh
git worktree add .claude/worktrees/<branch-name> -b <branch-name>
```

Work inside that worktree. When the change is complete, commit, push, and open a
PR — then remove the worktree:

```sh
git worktree remove .claude/worktrees/<branch-name>
```

Never leave a worktree unattended without at least a WIP commit and push. A
worktree with local-only changes is invisible to everyone else and will be lost
if the machine is reset.

### End of every session

Before stopping work:

1. Commit all changes — even a `wip:` commit is better than nothing.
2. Push the branch to origin.
3. If work is done, open a PR and remove the worktree.

## Code principles

This package provides raw b3nd protocols, types, and storage contracts to be
composed by higher-order SDKs. It must never impose behavior through defaults,
convenience wrappers, or opinionated sugar.

Concretely:

- **No defaults on required knobs.** If a caller must choose (executor,
  namespace, serialization format), require the argument — do not silently pick
  one.
- **No serialization inside the store.** `payload` is always
  `Uint8Array | ReadableStream<Uint8Array>` in and the same shape out. The store
  does not parse, encode, compress, or sign content.
- **No auto-wiring.** Executors, clients, and stores are injected by the caller;
  this package does not construct them from environment variables or globals.
- **Prefer explicit over ergonomic.** If making something easier to use requires
  hiding a choice, don't. Surface the choice instead and let higher layers
  provide the shortcut.

Convenience belongs in the consuming SDK, not here.

## Release rule

Releasing any `@bandeira-tech` package requires, **same day**: bumping its pin
in every direct workspace consumer and publishing their patch releases. The
`dep-drift` CI job (running on every PR and weekly) fails when a pin lags JSR
latest — a failing dep-drift check blocks the PR.

Run `deno task check:deps` locally before opening a PR that touches pins.
