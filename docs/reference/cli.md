---
description: Waitlet CLI commands, options, exit codes, and environment variables.
---

# CLI

```sh
waitlet <command> [key] [options]
```

The key names the work, such as an issue ID. It defaults to the Claude Code session ID.

## Commands

### acquire

`waitlet acquire [key]` waits for a slot, then holds it for the calling agent. Acquiring a key the same agent already holds renews its lease instead of taking a second slot.

### release

`waitlet release [key]` frees the slot or queue place of `key`. Without a key, it frees everything the calling agent holds or waits for, in every pool unless `--pool` or `$WAITLET_POOL` names one, so a `SessionEnd` hook needs no pool. With both a key and `--pid`, only that owner's entry is freed.

### renew

`waitlet renew [key]` extends the calling agent's leases by their TTL, across pools as `release` does without a key. Exits with 1 when there is no live lease to renew; a lapsed lease can't be renewed, because its slot may already belong to someone else.

### run

`waitlet run [key] -- <cmd>` holds a slot while `<cmd>` runs, for scripts and tools that aren't agents. The `waitlet` process owns the lease and has no TTL by default, so the slot frees when the command ends, however it ends. Signals are forwarded to the command, and `run` exits with the command's exit code.

### status

`waitlet status` shows holders and the queue.

### limit

`waitlet limit [n]` shows or sets how many slots the pool has. Lowering the limit revokes no leases; it takes effect as holders release.

## Options

| Option             | Meaning                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `--pool <name>`    | Pool to use, for separate limits such as one per repository. Default: `$WAITLET_POOL` or `default`                              |
| `--ttl <duration>` | `acquire`: the lease lapses this long after acquiring or the last renew. Default `2h`; `none` relies on the owner process alone |
| `--timeout <dur>`  | `acquire`: stop waiting after this long, keeping the queue place for 60s                                                        |
| `--priority <n>`   | `acquire`: higher goes first. Default `0`                                                                                       |
| `--pid <pid>`      | Owner process. Default: the calling Claude Code or Codex session (`CLAUDE_PID` or the nearest parent), else the parent process  |
| `--json`           | Machine-readable output                                                                                                         |
| `-q`, `--quiet`    | Print nothing on success                                                                                                        |
| `-v`, `--version`  | Print the version                                                                                                               |

## Exit codes

| Code  | Meaning                                                                      |
| ----- | ---------------------------------------------------------------------------- |
| 0     | OK                                                                           |
| 1     | Error                                                                        |
| 2     | Usage error                                                                  |
| 3     | Key held or queued by another owner, or already awaited by another `acquire` |
| 4     | Removed from the queue                                                       |
| 75    | Timed out; run again to keep the place                                       |
| 128+n | Stopped by signal `n` while waiting                                          |

## Environment

| Variable                 | Meaning                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| `WAITLET_HOME`           | State directory. Default: `$XDG_STATE_HOME/waitlet` or `~/.local/state/waitlet` |
| `WAITLET_POOL`           | Default pool name                                                               |
| `CLAUDE_PID`             | Set by Claude Code; the default lease owner                                     |
| `CLAUDE_CODE_SESSION_ID` | Set by Claude Code; the default key                                             |

All state is one SQLite file in `$WAITLET_HOME`. Deleting that directory resets every pool.
