---
description: Make Claude Code sessions acquire a Waitlet slot before working, with hooks for idle timeouts and cleanup.
---

# Claude Code

Tell the agent to acquire before it starts and release when it finishes, for example in a prompt, a slash command, or `CLAUDE.md`:

```md
Before any other work, run `waitlet acquire <issue-id>` as a background command
(run_in_background) and wait for it to finish; it exits once a slot is free.
If it exits with 3, another agent already has this issue: stop.
When you are done, or if you stop early, run `waitlet release`.
```

A background command doesn't hit Claude Code's 10-minute tool timeout, and the agent spends no tokens while it waits: Claude Code wakes it when the command exits. Where background commands aren't available, use `waitlet acquire <id> --timeout 9m` in a loop: exit code 75 means "run it again", and the queue place is kept for 60 seconds between attempts.

## Hooks

Optional hooks in `.claude/settings.json` (or `~/.claude/settings.json`) make the TTL an idle timeout and free the slot when the session ends:

```json
{
  "hooks": {
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "waitlet renew -q || true" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "waitlet release -q || true" }] }]
  }
}
```

Then acquire with a short TTL, such as `waitlet acquire <id> --ttl 20m`: every tool call renews the lease, and a session that stops calling tools for 20 minutes gives its slot up.

Hooks find the session through their parent processes. If that fails (for example, Claude Code running under a renamed binary), pass `--pid "$PPID"`.
