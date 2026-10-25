# Waitlet

<a href="https://www.npmjs.com/package/waitlet"><img src="https://img.shields.io/npm/v/waitlet?label=npm" height="20"></a>
<a href="https://www.npmjs.com/package/waitlet"><img src="https://img.shields.io/npm/dm/waitlet" height="20"></a>
<a href="https://kriasoft.com/waitlet/"><img src="https://img.shields.io/badge/Docs-007ec6" height="20"></a>
<a href="https://github.com/sponsors/koistya"><img src="https://img.shields.io/badge/-GitHub-%23555.svg?logo=github-sponsors" height="20"></a>
<a href="https://discord.gg/bSsv7XM"><img src="https://img.shields.io/discord/643523529131950086?label=Chat" height="20"></a>
<a href="https://github.com/kriasoft/waitlet/stargazers"><img src="https://img.shields.io/github/stars/kriasoft/waitlet.svg?style=social&label=Star&maxAge=3600" height="20"></a>
<a href="https://x.com/koistya"><img src="https://img.shields.io/badge/Follow-%40koistya-black?logo=x&style=social" height="20"></a>

Run as many AI coding agents as you like; Waitlet lets only N of them work at once.

Each agent asks Waitlet for a slot before its real work. If every slot is taken, it waits in a queue, spending no tokens, and continues as soon as a slot frees up. A session that finishes, crashes, or sits idle gives its slot back on its own.

Waitlet is a small CLI and TypeScript library for Claude Code, Codex, Superset automations, or any agent that can run a command. It doesn't launch agents, and it needs no daemon or account: its state is one SQLite file on your machine.

## Quick start

1. Install it (needs Node.js 22.13+):

   ```sh
   npm install -g waitlet
   ```

2. Choose how many agents may work at once:

   ```sh
   waitlet limit 2
   ```

3. Tell your agents to take a slot first, in a prompt, a slash command, or `CLAUDE.md`:

   ```md
   Before any other work, run `waitlet acquire <issue-id>` as a background command
   and wait for it to finish. Start work only if it exits with 0. If it exits with 3,
   another agent already has this issue: stop. On any other error, stop and report it.
   When you are done, or if you stop early, run `waitlet release`.
   ```

4. Start your agents. See who works and who waits:

   ```text
   $ waitlet status
   pool default: 2/2 slots in use, 1 waiting
     held    ISS-5  pid 4121  for 12m, lapses in 1h48m  /home/me/dev/app
     held    ISS-6  pid 4388  for 3m, lapses in 1h57m  /home/me/dev/app-2
     1       ISS-7  pid 4502  waiting 1m  /home/me/dev/app-3
   ```

## How it works

- **The slot belongs to the agent, not the command.** `waitlet acquire` exits as soon as it gets a slot, but the slot stays with the agent session that ran it until the agent runs `waitlet release` or exits. Waitlet finds the session through `CLAUDE_PID` or the nearest `claude` or `codex` parent process; pass `--pid` for other agents.
- **Idle slots come back.** A lease lapses 2 hours after it was taken or last renewed (`--ttl`), so a session left sitting at its prompt can't hold a slot forever. Waitlet never stops an agent, though: if one is still working when its lease lapses, it keeps working without a slot. Renew from a hook (below) or choose a TTL longer than the work.
- **Fair queue.** First come, first served; `--priority <n>` lets urgent work go first. A release wakes the next waiter at once.
- **One key, one agent.** The key names the work, such as an issue ID. If another agent already holds or waits for that key, `acquire` exits with 3, so a re-triggered automation can't do the same work twice.

## Commands

| Command                      | What it does                                                                |
| ---------------------------- | --------------------------------------------------------------------------- |
| `waitlet acquire [key]`      | Wait for a slot, then hold it for the calling agent                         |
| `waitlet release [key]`      | Free `key`'s slot or queue place; without a key, all of the calling agent's |
| `waitlet renew [key]`        | Restart the calling agent's lease timers; a lapsed lease can't be renewed   |
| `waitlet run [key] -- <cmd>` | Hold a slot while `<cmd>` runs, for scripts and tools that aren't agents    |
| `waitlet status`             | Show who holds slots and who waits                                          |
| `waitlet limit [n]`          | Show or set the number of slots                                             |

The key defaults to the Claude Code session ID. Common options: `--pool <name>` for a separate limit (say, one per repository; each new pool starts with 1 slot), `--ttl <duration>` (`20m`, `2h`, or `none`), `--timeout <duration>`, `--json`, and `-q`. Without a key, `release` and `renew` cover the agent's leases in every pool, unless `--pool` or `$WAITLET_POOL` selects one.

Exit codes: `0` ok, `1` error, `2` bad usage, `3` key already held or awaited by another agent, `4` removed from the queue, `75` timed out (run again to keep your place).

See the [CLI reference](https://kriasoft.com/waitlet/reference/cli) for every option.

## Claude Code

Run `waitlet acquire` as a background command, as in the quick start. Claude Code wakes the agent when the command exits, so waiting spends no tokens and isn't cut off by the 10-minute tool timeout. Where background commands aren't available, run `waitlet acquire <issue-id> --timeout 9m` in a loop: exit code 75 means "run it again", and the queue place is kept for 60 seconds between attempts.

### Hooks (recommended)

Add these to `~/.claude/settings.json` (or a project's `.claude/settings.json`) to renew the lease on every tool call and free the slot when a session ends:

```json
{
  "hooks": {
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "waitlet renew -q || true" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "waitlet release -q || true" }] }]
  }
}
```

With the hooks in place, acquire with a short TTL, such as `waitlet acquire <issue-id> --ttl 20m`. The TTL then works as an idle timeout: a session that makes no tool calls for 20 minutes gives its slot up. Pick a TTL longer than your longest single tool call, because a lapsed lease can't be renewed; the agent has to acquire again.

Hooks find the session through their parent processes. If that fails (for example, Claude Code running under a renamed binary), add `--pid "$PPID"` to both commands.

## Superset

Superset automations start a run for every matching event, with no limit on how many run at once. To add one, put the quick start instructions at the top of the automation's prompt, using the issue from `<automation_trigger_info>` as the key, plus one check:

```md
Before any other work, run `waitlet acquire <issue identifier>` as a background
command and wait for it to finish. Do not touch the issue before then. Start only
if it exits with 0; if it exits with 3, stop. Once you have the slot, re-read the
issue; if its status has changed since this run was triggered, run
`waitlet release` and stop. Run `waitlet release` when you finish or give up.
```

While a run waits, its issue is untouched, so the issue's status still shows it's queued. Deleting a waiting run's workspace ends its session and removes it from the queue. `waitlet status` shows each lease's Superset workspace ID.

With the [hooks](#hooks-recommended) installed in `~/.claude/settings.json`, add `--ttl 20m` so a run left idle at its prompt frees its slot after 20 minutes instead of 2 hours.

## Library

```ts
import { Pool } from "waitlet";

const pool = new Pool({ name: "builds" });
pool.setLimit(2); // stored; every process using this pool shares it

// Waits for a slot. With no TTL, the lease lasts until it's released or this process exits.
const lease = await pool.acquire({ key: "ISS-7", ttl: null, onWait: (position) => console.log(`queued #${position}`) });
try {
  // ... the work
} finally {
  pool.release({ key: lease.key, pid: lease.pid });
  pool.close();
}
```

`acquire` rejects with a `WaitletError` whose `code` is `conflict`, `timeout`, `cancelled`, `aborted`, or `no-owner`. The lease belongs to the current process unless you pass `pid`. More in the [library reference](https://kriasoft.com/waitlet/reference/library).

## State

Everything lives in `$WAITLET_HOME`, which defaults to `$XDG_STATE_HOME/waitlet` or `~/.local/state/waitlet`. Every agent must see the same directory. Deleting it resets every pool.

## License

MIT. Design decisions are recorded in [docs/adr](docs/adr).
