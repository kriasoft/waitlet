# Waitlet

Cooperative concurrency slots for AI coding agents: acquire, queue, continue. Before adding a feature, read `docs/product.md` (objective, principles, non-goals). Design decisions: `docs/adr/`.

- `src/` runs unbundled on Node ≥22.13 as well as Bun: use `node:` APIs, never `Bun.*` or `bun:*`; import local files with `.ts` extensions ([ADR 0001](docs/adr/0001-sqlite-state-no-daemon.md)).
- No runtime dependencies.
- Public contract: exports of `src/index.ts`, plus CLI flags, exit codes and output, which agents and hooks parse.
- Record new design decisions as ADRs in `docs/adr/`.

## Invariants

Changes must keep these true; tests cover most, but not every interleaving.

- Every read-then-write of slots or the queue runs inside one `BEGIN IMMEDIATE` transaction (`Pool.transaction`). That is the only thing keeping grants within the limit across processes.
- When liveness is uncertain, the owner is alive: an unusable `ps` falls back to `kill(pid, 0)`, never to "everyone is dead". Wrongly freeing a slot breaks the limit; wrongly keeping one only delays, until the TTL.
- Only a timeout keeps a queue place (60s, for retry loops); every other failed wait leaves the queue.
- Any change that frees capacity or moves the queue calls `notify()`, or waiters sleep until the 3s poll.

## Commands

`bun test` · `bun run typecheck` · `bun run lint` · `bun run format` · `bun run build` (to `dist/`; run it after changing exports or build config)

## Tests

- Lease owners are real spawned processes; CLI tests run `src/cli.ts` under `node`.
- Control time through `Pool`'s `now` option instead of sleeping.
- To check the real agent flow by hand, from a Claude Code session: with a temporary `WAITLET_HOME`, fill the pool (`waitlet acquire X --pid <a sleep's PID>`), run `waitlet acquire Y` as a background command, then `waitlet release X`; the background command should finish with `acquired Y`, owned by `$CLAUDE_PID`.
