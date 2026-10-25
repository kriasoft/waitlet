---
description: Add a concurrency limit to Superset automations without changing them.
---

# Superset

Superset automations start a run for every matching event and have no concurrency limit. Waitlet adds one without changing the automation: put the [Claude Code instructions](./claude-code) at the top of the automation's prompt, keyed by the issue in `<automation_trigger_info>`.

```md
First, run `waitlet acquire <issue identifier> --pool <repo> --ttl 20m` as a
background command and wait for it to finish. Do not touch the issue before then.
Once it succeeds, re-read the issue; if it is no longer in Todo, run
`waitlet release` and stop. Run `waitlet release` when you finish or give up.
```

While a run waits, its workspace exists but its issue is untouched, so the issue's status still tells you it's queued. Deleting a waiting run's workspace ends its session, which removes it from the queue. `waitlet status` shows each lease's Superset workspace ID.
