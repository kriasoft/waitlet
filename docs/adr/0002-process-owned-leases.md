# 2. Leases owned by the agent process, bounded by a renewable TTL

Status: accepted (2026-10-25)

## Context

An agent acquires a slot by running a shell command that exits right away, so the command's process can't stand for the agent. A slot must still come back when the agent finishes, crashes, or, as happens with Superset automation runs, stays alive but idle at its prompt.

## Decision

A lease records an owner PID and that process's start time. In the CLI the owner is `--pid`, else Claude Code's `CLAUDE_PID`, else the nearest `claude` or `codex` parent process, else the parent process. A lease is reclaimed when its owner is gone (PID absent, or reused by a process with another start time) or when its TTL runs out. The TTL (default 2h) counts from acquisition or the last renewal. Renewing it from Claude Code's PostToolUse hook turns it into an idle timeout. A lapsed lease can't be renewed, because its slot may already belong to someone else.

Queue entries also record the blocked `waitlet acquire` process: if that process is killed, the agent has stopped waiting and the entry goes. A waiter that timed out keeps its place for 60 seconds, so `--timeout` loops stay fair.

A key (the work's name) can be held or queued by only one owner at a time; re-acquiring with the same owner renews the lease instead of taking a second slot. A second `acquire` waiting on a queued key gets a conflict too, since either one's exit would cancel the other's wait.

Without a key, `release` and `renew` act on the owner's entries in every pool, unless a pool is chosen: hooks and closing instructions are written once, not per pool, so they must not miss a lease taken with `--pool`.

## Consequences

The limit is cooperative: an agent that ignores Waitlet, or keeps working after its lease lapsed, isn't stopped. Lowering the limit revokes nothing. Where `ps` is missing or lacks the needed columns (Windows, BusyBox), liveness falls back to `kill(pid, 0)`, which can't detect PID reuse. Start times are read in UTC, so callers in different time zones agree, and a zombie counts as exited.
