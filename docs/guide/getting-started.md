---
description: Install Waitlet, set a slot limit, and learn how leases, the queue, and keys work.
---

# Getting started

::: code-group

```sh [npm]
npm install -g waitlet
```

```sh [bun]
bun add -g waitlet
```

:::

Requires Node.js 22.13+ or Bun. Then set how many agents may work at once:

```sh
waitlet limit 2
```

## How it works

<PoolDiagram />

An agent runs `waitlet acquire <key>` before its real work. It returns at once if a slot is free; otherwise it waits in the queue, spending no tokens:

```text
$ waitlet acquire ISS-7
waitlet: waiting for ISS-7: position 1, 2/2 slots held by ISS-5, ISS-6
waitlet: acquired ISS-7 (2/2 slots in use, pool default)
```

| Rule                    | What it means                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent owns the slot** | The lease belongs to the agent session (`CLAUDE_PID` or the nearest `claude`/`codex` parent), not the command, until it releases or exits |
| **Leases lapse**        | 2 hours after acquiring or the last renew (`--ttl`). [Renew from a hook](./claude-code#hooks) to make it an idle timeout                  |
| **Fair queue**          | First come, first served; `--priority` goes first. A release wakes the next waiter at once                                                |
| **One key, one agent**  | The key names the work, such as an issue ID. A key another live agent holds fails with exit code 3                                        |

## Next steps

- [Claude Code](./claude-code) or [Superset](./superset): tell agents to acquire and release.
- [`waitlet run`](../reference/cli#run): hold a slot around any command.
- [Library](../reference/library): the same pool from TypeScript.
