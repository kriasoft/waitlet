# 1. SQLite state through node:sqlite, no daemon

Status: accepted (2026-10-25)

## Context

Agents run `waitlet` as short-lived commands from many processes at once, often through `npx`, so it runs on Node as well as Bun. The state must stay consistent across concurrent writers and survive a process being killed mid-operation.

## Decision

All state lives in one SQLite database (`$WAITLET_HOME/waitlet.db`, WAL mode), opened with `node:sqlite`, which both Node (22.13+) and Bun provide. Each operation is a `BEGIN IMMEDIATE` transaction. Waiters block in their own process: they wake when a writer touches `$WAITLET_HOME/wake` (`fs.watch`) and re-check every 3 seconds to notice owners that died, which no event reports.

Source code uses `node:` APIs and erasable TypeScript only, so Node runs `src/` directly and the published bundle needs no runtime dependencies.

## Alternatives

- **A coordinator daemon** with a socket: instant wake-ups and a single owner of the state, but something to start, supervise, and recover; its crash would stall every agent.
- **Lock directories or files** (`mkdir` per slot): no SQLite, but stale-lock stealing races, and no transactional queue for fair ordering.
- **`bun:sqlite`**: faster, but `npx` would then need Bun installed.

## Consequences

SQLite's locks are released by the OS when a process dies, so a crash never leaves the pool locked. Wake-ups are near-instant on macOS and Linux; where `fs.watch` is unavailable, waiting falls back to the 3-second poll.
