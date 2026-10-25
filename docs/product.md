# Product

Waitlet is a local-first CLI and TypeScript library that limits how many AI coding agents (Claude Code, Codex, agents started by Superset, Zed or VS Code) work at once. Agents acquire a slot before their real work, wait in a queue while every slot is taken, and continue when one frees up. Waitlet doesn't launch or manage agents: it's a shared primitive they call through a command, their instructions, or lifecycle hooks.

Read this before adding a feature: a feature that doesn't serve the objective, or that crosses a non-goal, doesn't belong here.

## Objective

No more than a configured number of participating agents run at once, and freed capacity reaches waiting agents without anyone managing the queue.

## Principles

- **Agent-native:** agents use Waitlet directly through a minimal CLI and optional lifecycle hooks; its output and exit codes are written for them to act on.
- **Tool-agnostic:** works with any agent or editor that can run a command. Agent-specific code is limited to finding the agent's process and recording its context.
- **Local-first:** runs entirely on the developer's machine, with no account, service, or daemon.
- **Cooperative:** explicit acquire and release at safe points; Waitlet never suspends or kills an agent.
- **Reliable:** durable state and ownership-aware leases; a crashed, exited, or idle agent can't block the queue for good.
- **Efficient:** waiting costs no LLM calls and next to no CPU.
- **Minimal:** coordination done exceptionally well, and nothing else. It feels like a small system utility, not a platform.

## Non-goals

- Launching or replacing coding agents.
- Managing Git worktrees, repositories, or issues.
- Its own agent execution environment.
- A graphical dashboard.
- A hosted service or user account.
- Interrupting agents that are working.
- Promising to resume an IDE-hosted session where the host doesn't support it.

## Success criteria

Each criterion is checked by a test.

- With a limit of two and five agents, two work while three wait, and the waiting ones get slots in order as slots free up: `test/cli.test.ts`, "five agents, two slots", and `test/pool.test.ts`, "grants up to the limit, then queues in arrival order".
- Waiting needs no LLM polling: the agent runs `waitlet acquire` as a background command and is woken when it exits (README, Claude Code).
- Stale leases don't block progress: `test/pool.test.ts`, "reclaims a slot whose owner exited" and "a lease lapses after its TTL".
- Uncertainty doesn't cause duplicate work: one owner per key (`test/pool.test.ts`, "re-acquiring a held key …").

**What Waitlet promises:** admission control and slot availability. Whether a waiting agent actually continues depends on its host: Claude Code wakes an agent when a background command ends, but not every host does.

## Not yet

- Finding the owner process for agents other than Claude Code and Codex (`--pid` covers them for now).
- Detecting PID reuse on Windows (liveness falls back to `kill(pid, 0)`).
