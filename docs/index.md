---
layout: home

hero:
  name: Waitlet
  text: Run N agents at a time
  tagline: Cooperative concurrency slots for Claude Code, Codex, and any agent that can run a command.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: CLI reference
      link: /reference/cli

features:
  - icon: ⏳
    title: Waiting costs nothing
    details: Queued agents spend no tokens. A release wakes the next one at once.
  - icon: 🧹
    title: Nothing gets stuck
    details: A session that crashes, exits, or idles loses its slot automatically.
  - icon: 🔒
    title: One file, no daemon
    details: State is one SQLite file on your machine. No account, no service.
---

## Three lines to coordinate

::: code-group

```sh [Terminal]
npm install -g waitlet
waitlet limit 2
waitlet acquire ISS-7   # waits for a slot, then holds it for the agent
```

```md [Agent prompt]
Before any other work, run `waitlet acquire <issue-id>` as a background
command and wait for it to finish. When you are done, run `waitlet release`.
```

```sh [Scripts]
waitlet run build -- bun run build   # holds a slot while the command runs
```

```ts [Library]
import { Pool } from "waitlet";

const pool = new Pool({ name: "builds" });
const lease = await pool.acquire({ key: "ISS-7" });
try {
  // ... the work
} finally {
  pool.release({ key: lease.key });
}
```

:::
