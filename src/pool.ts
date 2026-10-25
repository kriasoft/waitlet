import { mkdirSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { livenessOf, processIdentity } from "./process.ts";

export interface Lease {
  pool: string;
  key: string;
  /** Owner process: the lease is reclaimed as soon as it exits. */
  pid: number;
  acquiredAt: number;
  /** When an unrenewed lease lapses; null for none. */
  expiresAt: number | null;
  meta: Record<string, string>;
}

export interface Waiter {
  pool: string;
  key: string;
  pid: number;
  priority: number;
  enqueuedAt: number;
  meta: Record<string, string>;
}

export interface PoolStatus {
  pool: string;
  limit: number;
  leases: Lease[];
  /** In grant order. */
  queue: Waiter[];
}

export interface AcquireOptions {
  /** Names the work, e.g. an issue ID. One lease or queue entry per key and pool. */
  key: string;
  /** Owner process; defaults to this one. */
  pid?: number;
  /** Lease lifetime from acquisition or last renewal; null for none. Default 2h. */
  ttl?: number | null;
  /** Higher goes first; ties go first come, first served. Default 0. */
  priority?: number;
  /** Give up waiting after this long, keeping the queue position briefly for a retry. */
  timeout?: number;
  signal?: AbortSignal;
  meta?: Record<string, string>;
  /** Called when the caller has to wait, and whenever its position changes. */
  onWait?: (position: number, status: PoolStatus) => void;
}

export type WaitletErrorCode = "conflict" | "timeout" | "cancelled" | "aborted" | "no-owner";

export class WaitletError extends Error {
  readonly code: WaitletErrorCode;

  constructor(code: WaitletErrorCode, message: string) {
    super(message);
    this.name = "WaitletError";
    this.code = code;
  }
}

export interface PoolOptions {
  /** Defaults to "default". */
  name?: string;
  /** State directory; defaults to $WAITLET_HOME, then $XDG_STATE_HOME/waitlet, then ~/.local/state/waitlet. */
  home?: string;
  /** Injectable clock for tests. */
  now?: () => number;
}

export const DEFAULT_LIMIT = 1;
export const DEFAULT_TTL = 2 * 3_600_000;
/** How long a waiter that timed out keeps its place for a retry. */
export const RETRY_GRACE = 60_000;
/** Fallback re-check while waiting: notices owners that died or leases that lapsed. */
const POLL_INTERVAL = 3_000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS pools (name TEXT PRIMARY KEY, "limit" INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS leases (
    pool TEXT NOT NULL, key TEXT NOT NULL,
    pid INTEGER NOT NULL, pid_start TEXT,
    acquired_at INTEGER NOT NULL, ttl INTEGER, expires_at INTEGER,
    meta TEXT NOT NULL,
    PRIMARY KEY (pool, key));
  CREATE TABLE IF NOT EXISTS waiters (
    id INTEGER PRIMARY KEY,
    pool TEXT NOT NULL, key TEXT NOT NULL,
    pid INTEGER NOT NULL, pid_start TEXT,
    -- The process blocked in acquire(); null after it timed out, from detached_at.
    waiter_pid INTEGER, waiter_start TEXT, detached_at INTEGER,
    priority INTEGER NOT NULL, enqueued_at INTEGER NOT NULL,
    meta TEXT NOT NULL,
    UNIQUE (pool, key));
`;

interface LeaseRow {
  pool: string;
  key: string;
  pid: number;
  pid_start: string | null;
  acquired_at: number;
  ttl: number | null;
  expires_at: number | null;
  meta: string;
}

interface WaiterRow {
  id: number;
  pool: string;
  key: string;
  pid: number;
  pid_start: string | null;
  waiter_pid: number | null;
  waiter_start: string | null;
  detached_at: number | null;
  priority: number;
  enqueued_at: number;
  meta: string;
}

type Attempt = { lease: Lease } | { position: number; status: PoolStatus };

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WAITLET_HOME) return env.WAITLET_HOME;
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "waitlet");
}

/**
 * A named counting semaphore shared by every process on the machine.
 *
 * State lives in one SQLite database; each operation is a transaction, so no
 * daemon is needed and a crash mid-operation leaves nothing half-done.
 * Waiters wake when the wake file changes and re-check on a slow poll for owners
 * that died without releasing.
 */
export class Pool {
  readonly name: string;
  readonly home: string;
  private readonly db: DatabaseSync;
  private readonly wakeFile: string;
  private readonly now: () => number;

  constructor(options: PoolOptions = {}) {
    this.name = options.name ?? "default";
    this.home = options.home ?? defaultHome();
    this.now = options.now ?? Date.now;
    mkdirSync(this.home, { recursive: true });
    this.wakeFile = join(this.home, "wake");
    writeFileSync(this.wakeFile, "", { flag: "a" });
    this.db = new DatabaseSync(join(this.home, "waitlet.db"));
    this.db.exec("PRAGMA busy_timeout = 10000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Waits for a slot and returns the lease. Re-acquiring a key the owner already holds renews it. */
  async acquire(options: AcquireOptions): Promise<Lease> {
    const { ttl, timeout } = options;
    if (ttl != null && !(ttl > 0 && Number.isFinite(ttl))) throw new RangeError("ttl must be positive, or null");
    if (timeout !== undefined && !(timeout >= 0)) throw new RangeError("timeout must not be negative");
    const pid = options.pid ?? process.pid;
    const { alive, start } = processIdentity(pid);
    if (!alive) throw new WaitletError("no-owner", `owner process ${pid} is not running`);
    const owner = { pid, start };
    const waiter = { pid: process.pid, start: pid === process.pid ? start : processIdentity(process.pid).start };
    const deadline = timeout === undefined ? Infinity : this.now() + timeout;
    const wake = new Wake(this.wakeFile);
    let enqueued = false;
    let position = 0;
    try {
      for (;;) {
        if (options.signal?.aborted) throw new WaitletError("aborted", "stopped waiting");
        const attempt = this.transaction(() => this.attempt(options, owner, waiter, enqueued));
        if ("lease" in attempt) return attempt.lease;
        enqueued = true;
        if (attempt.position !== position) {
          position = attempt.position;
          options.onWait?.(position, attempt.status);
        }
        const remaining = deadline - this.now();
        if (remaining <= 0) {
          this.detach(options.key, pid, waiter.pid);
          throw new WaitletError(
            "timeout",
            `no slot within the timeout; position ${position} kept for ${RETRY_GRACE / 1000}s`,
          );
        }
        await wake.next(Math.min(remaining, POLL_INTERVAL), options.signal);
      }
    } catch (error) {
      // Only a timeout keeps the place. Any other failure (an abort, a throwing onWait, a
      // database error) must not leave an entry that this still-running process keeps alive.
      // Before the first queued attempt commits, any entry for the key is someone else's.
      if (enqueued && !(error instanceof WaitletError && error.code === "timeout")) {
        this.leaveQueue(options.key, pid, waiter.pid);
      }
      throw error;
    } finally {
      wake.close();
    }
  }

  /** Extends owner `pid`'s leases (only `key`'s, when given) by their TTL. Returns how many. */
  renew(filter: { pid: number; key?: string }): number {
    const now = this.now();
    const { sql, params } = this.match(filter);
    // A lapsed lease stays lapsed: its slot may already be someone else's.
    return Number(
      this.db
        .prepare(`UPDATE leases SET expires_at = ? + ttl WHERE (expires_at IS NULL OR expires_at > ?) AND ${sql}`)
        .run(now, now, ...params).changes,
    );
  }

  /**
   * Drops leases and queue entries matching `key` and/or owner `pid`.
   * Removing a queue entry makes its blocked acquire() fail as cancelled.
   */
  release(filter: { key?: string; pid?: number }): { leases: number; waiters: number } {
    const { sql, params } = this.match(filter);
    const counts = this.transaction(() => ({
      leases: Number(this.db.prepare(`DELETE FROM leases WHERE ${sql}`).run(...params).changes),
      waiters: Number(this.db.prepare(`DELETE FROM waiters WHERE ${sql}`).run(...params).changes),
    }));
    if (counts.leases + counts.waiters > 0) this.notify();
    return counts;
  }

  status(): PoolStatus {
    return this.transaction(() => {
      this.prune();
      return this.read();
    });
  }

  /** Names of every pool in this home that has a limit, a lease, or a waiter. */
  names(): string[] {
    const rows = this.db
      .prepare("SELECT name FROM pools UNION SELECT pool FROM leases UNION SELECT pool FROM waiters")
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  /** Sets how many leases may be held at once. Lowering it revokes nothing. */
  setLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    this.db
      .prepare(
        `INSERT INTO pools (name, "limit") VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET "limit" = excluded."limit"`,
      )
      .run(this.name, limit);
    this.notify();
  }

  private attempt(
    options: AcquireOptions,
    owner: { pid: number; start: string | null },
    waiter: { pid: number; start: string | null },
    enqueued: boolean,
  ): Attempt {
    const now = this.now();
    this.prune();
    // An unknown start time (no usable `ps`) matches any: uncertainty must not cost an owner its lease.
    const sameOwner = (row: { pid: number; pid_start: string | null }) =>
      row.pid === owner.pid && (row.pid_start === null || owner.start === null || row.pid_start === owner.start);

    const held = this.db.prepare("SELECT * FROM leases WHERE pool = ? AND key = ?").get(this.name, options.key) as
      | LeaseRow
      | undefined;
    if (held) {
      if (!sameOwner(held)) throw new WaitletError("conflict", `${options.key} is already held by process ${held.pid}`);
      this.db
        .prepare("UPDATE leases SET expires_at = ? + ttl WHERE pool = ? AND key = ?")
        .run(now, this.name, options.key);
      return { lease: toLease({ ...held, expires_at: held.ttl === null ? null : now + held.ttl }) };
    }

    const queued = this.db.prepare("SELECT * FROM waiters WHERE pool = ? AND key = ?").get(this.name, options.key) as
      | WaiterRow
      | undefined;
    if (queued && !sameOwner(queued)) {
      throw new WaitletError("conflict", `${options.key} is already queued by process ${queued.pid}`);
    }
    if (!queued && enqueued) throw new WaitletError("cancelled", `${options.key} was removed from the queue`);
    // Pruned already, so a waiter_pid is a live process; two waits would cancel each other on exit.
    if (queued && queued.waiter_pid !== null && queued.waiter_pid !== waiter.pid) {
      throw new WaitletError("conflict", `${options.key} is already being waited for by process ${queued.waiter_pid}`);
    }
    const ttl = options.ttl === undefined ? DEFAULT_TTL : options.ttl;
    if (queued) {
      this.db
        .prepare(
          "UPDATE waiters SET waiter_pid = ?, waiter_start = ?, detached_at = NULL, priority = ?, meta = ? WHERE id = ?",
        )
        .run(
          waiter.pid,
          waiter.start,
          options.priority ?? queued.priority,
          JSON.stringify(options.meta ?? {}),
          queued.id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO waiters (pool, key, pid, pid_start, waiter_pid, waiter_start, priority, enqueued_at, meta)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.name,
          options.key,
          owner.pid,
          owner.start,
          waiter.pid,
          waiter.start,
          options.priority ?? 0,
          now,
          JSON.stringify(options.meta ?? {}),
        );
    }

    const status = this.read();
    const index = status.queue.findIndex((w) => w.key === options.key);
    if (index >= status.limit - status.leases.length) return { position: index + 1, status };

    this.db.prepare("DELETE FROM waiters WHERE pool = ? AND key = ?").run(this.name, options.key);
    const lease: LeaseRow = {
      pool: this.name,
      key: options.key,
      pid: owner.pid,
      pid_start: owner.start,
      acquired_at: now,
      ttl,
      expires_at: ttl === null ? null : now + ttl,
      meta: JSON.stringify(options.meta ?? {}),
    };
    this.db
      .prepare(
        "INSERT INTO leases (pool, key, pid, pid_start, acquired_at, ttl, expires_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        lease.pool,
        lease.key,
        lease.pid,
        lease.pid_start,
        lease.acquired_at,
        lease.ttl,
        lease.expires_at,
        lease.meta,
      );
    // Others' positions moved up.
    this.notify();
    return { lease: toLease(lease) };
  }

  /** Drops lapsed leases, and leases and queue entries whose processes are gone. */
  private prune(): void {
    const now = this.now();
    const leases = this.db.prepare("SELECT * FROM leases WHERE pool = ?").all(this.name) as unknown as LeaseRow[];
    const waiters = this.db.prepare("SELECT * FROM waiters WHERE pool = ?").all(this.name) as unknown as WaiterRow[];
    const alive = livenessOf([
      ...leases.map((l) => l.pid),
      ...waiters.flatMap((w) => (w.waiter_pid === null ? [w.pid] : [w.pid, w.waiter_pid])),
    ]);
    let pruned = 0;
    for (const l of leases) {
      if ((l.expires_at !== null && l.expires_at <= now) || !alive(l.pid, l.pid_start)) {
        this.db.prepare("DELETE FROM leases WHERE pool = ? AND key = ?").run(l.pool, l.key);
        pruned++;
      }
    }
    for (const w of waiters) {
      const gone =
        !alive(w.pid, w.pid_start) ||
        (w.waiter_pid === null ? now - (w.detached_at ?? 0) > RETRY_GRACE : !alive(w.waiter_pid, w.waiter_start));
      if (gone) {
        this.db.prepare("DELETE FROM waiters WHERE id = ?").run(w.id);
        pruned++;
      }
    }
    if (pruned > 0) this.notify();
  }

  private read(): PoolStatus {
    const row = this.db.prepare(`SELECT "limit" FROM pools WHERE name = ?`).get(this.name) as
      | { limit: number }
      | undefined;
    const leases = this.db
      .prepare("SELECT * FROM leases WHERE pool = ? ORDER BY acquired_at")
      .all(this.name) as unknown as LeaseRow[];
    const queue = this.db
      .prepare("SELECT * FROM waiters WHERE pool = ? ORDER BY priority DESC, enqueued_at, id")
      .all(this.name) as unknown as WaiterRow[];
    return {
      pool: this.name,
      limit: row?.limit ?? DEFAULT_LIMIT,
      leases: leases.map(toLease),
      queue: queue.map((w) => ({
        pool: w.pool,
        key: w.key,
        pid: w.pid,
        priority: w.priority,
        enqueuedAt: w.enqueued_at,
        meta: JSON.parse(w.meta),
      })),
    };
  }

  // Both act only on this owner's entry while this process waits on it, never on another wait.
  private leaveQueue(key: string, pid: number, waiterPid: number): void {
    const sql = "DELETE FROM waiters WHERE pool = ? AND key = ? AND pid = ? AND waiter_pid = ?";
    if (this.db.prepare(sql).run(this.name, key, pid, waiterPid).changes) this.notify();
  }

  private detach(key: string, pid: number, waiterPid: number): void {
    this.db
      .prepare(
        "UPDATE waiters SET waiter_pid = NULL, waiter_start = NULL, detached_at = ? WHERE pool = ? AND key = ? AND pid = ? AND waiter_pid = ?",
      )
      .run(this.now(), this.name, key, pid, waiterPid);
  }

  private match(filter: { key?: string; pid?: number }): { sql: string; params: (string | number)[] } {
    if (filter.key === undefined && filter.pid === undefined) throw new TypeError("pass a key, a pid, or both");
    const clauses = ["pool = ?"];
    const params: (string | number)[] = [this.name];
    if (filter.key !== undefined) {
      clauses.push("key = ?");
      params.push(filter.key);
    }
    if (filter.pid !== undefined) {
      clauses.push("pid = ?");
      params.push(filter.pid);
    }
    return { sql: clauses.join(" AND "), params };
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Wakes every waiter on the machine; each re-checks its own pool. */
  private notify(): void {
    writeFileSync(this.wakeFile, String(this.now()));
  }
}

function toLease(row: LeaseRow): Lease {
  return {
    pool: row.pool,
    key: row.key,
    pid: row.pid,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    meta: JSON.parse(row.meta),
  };
}

/** Resolves on a change to the wake file, a timeout, or an abort, whichever comes first. */
class Wake {
  private watcher: FSWatcher | undefined;
  private pending = false;
  private resolve: (() => void) | undefined;

  constructor(file: string) {
    try {
      this.watcher = watch(file, () => this.fire());
      this.watcher.on("error", () => this.close());
    } catch {
      // Polling alone still works.
    }
  }

  next(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        this.resolve = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      this.resolve = done;
    });
  }

  close(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  private fire(): void {
    if (this.resolve) this.resolve();
    else this.pending = true;
  }
}
