---
description: Use Waitlet's Pool from TypeScript to limit concurrent work across processes.
---

# Library

```ts
import { Pool } from "waitlet";

const pool = new Pool({ name: "builds" });
pool.setLimit(2);
const lease = await pool.acquire({ key: "ISS-7", ttl: 20 * 60_000, onWait: (position) => console.log(`#${position}`) });
try {
  // ... the work
} finally {
  pool.release({ key: lease.key });
  pool.close();
}
```

`acquire` rejects with a `WaitletError` whose `code` is `conflict`, `timeout`, `cancelled`, `aborted`, or `no-owner`. The owner defaults to the current process; pass `pid` to tie the lease to another one.
