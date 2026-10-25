import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDuration } from "../src/duration.ts";
import { Pool, RETRY_GRACE, WaitletError } from "../src/pool.ts";

let home: string;
let pools: Pool[];
let owners: ChildProcess[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "waitlet-test-"));
  pools = [];
  owners = [];
});

afterEach(() => {
  for (const p of pools) p.close();
  for (const o of owners) o.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
});

/** A pool handle; each one stands in for a separate agent process's connection. */
function open(options: { now?: () => number } = {}): Pool {
  const pool = new Pool({ home, ...options });
  pools.push(pool);
  return pool;
}

/** A live process to own a lease, like an agent session would. */
function owner(): number {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  owners.push(child);
  return child.pid!;
}

function kill(pid: number): Promise<void> {
  const child = owners.find((o) => o.pid === pid)!;
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof WaitletError) return error.code;
    throw error;
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

test("grants up to the limit, then queues in arrival order", async () => {
  const pool = open();
  pool.setLimit(2);
  await pool.acquire({ key: "a", pid: owner() });
  await pool.acquire({ key: "b", pid: owner() });
  const order: string[] = [];
  const c = open()
    .acquire({ key: "c", pid: owner() })
    .then(() => order.push("c"));
  await settle();
  const d = open()
    .acquire({ key: "d", pid: owner() })
    .then(() => order.push("d"));
  await settle();
  expect(pool.status().queue.map((w) => w.key)).toEqual(["c", "d"]);

  pool.release({ key: "a" });
  await c;
  expect(order).toEqual(["c"]);
  expect(pool.status().leases.map((l) => l.key)).toEqual(["b", "c"]);
  pool.release({ key: "b" });
  await d;
  expect(order).toEqual(["c", "d"]);
});

test("higher priority goes first", async () => {
  const pool = open();
  await pool.acquire({ key: "a", pid: owner() });
  const low = open().acquire({ key: "low", pid: owner() });
  await settle();
  const high = open().acquire({ key: "high", pid: owner(), priority: 5 });
  await settle();
  expect(pool.status().queue.map((w) => w.key)).toEqual(["high", "low"]);
  pool.release({ key: "a" });
  await high;
  pool.release({ key: "high" });
  await low;
});

test("reclaims a slot whose owner exited without releasing", async () => {
  const pool = open();
  const crashed = owner();
  await pool.acquire({ key: "a", pid: crashed });
  const next = open().acquire({ key: "b", pid: owner() });
  await settle();
  await kill(crashed);
  pool.status(); // Any operation prunes; the waiter's own poll would get there too.
  await next;
  expect(pool.status().leases.map((l) => l.key)).toEqual(["b"]);
});

test("refuses to acquire for an owner that is not running", async () => {
  const pid = owner();
  await kill(pid);
  expect(await code(open().acquire({ key: "a", pid }))).toBe("no-owner");
});

test("a lease lapses after its TTL unless renewed, and stays lapsed", async () => {
  let now = 1_000_000;
  const pool = open({ now: () => now });
  const pid = owner();
  await pool.acquire({ key: "a", pid, ttl: 60_000 });
  now += 50_000;
  expect(pool.renew({ pid })).toBe(1);
  now += 50_000;
  expect(pool.status().leases).toHaveLength(1);
  now += 20_000;
  expect(pool.renew({ pid })).toBe(0);
  expect(pool.status().leases).toHaveLength(0);
});

test("re-acquiring a held key renews it for the same owner and conflicts for another", async () => {
  const pool = open();
  const pid = owner();
  const first = await pool.acquire({ key: "a", pid });
  expect((await pool.acquire({ key: "a", pid })).acquiredAt).toBe(first.acquiredAt);
  expect(pool.status().leases).toHaveLength(1);
  expect(await code(pool.acquire({ key: "a", pid: owner() }))).toBe("conflict");
});

test("a key queued by one owner conflicts for another", async () => {
  const pool = open();
  await pool.acquire({ key: "a", pid: owner() });
  const queued = code(open().acquire({ key: "b", pid: owner() }));
  await settle();
  expect(await code(open().acquire({ key: "b", pid: owner() }))).toBe("conflict");
  pool.release({ key: "b" });
  expect(await queued).toBe("cancelled");
});

test("a conflicting acquire in the same process keeps the other owner's wait", async () => {
  const pool = open();
  await pool.acquire({ key: "a", pid: owner() });
  const first = code(open().acquire({ key: "b", pid: owner() }));
  await settle();
  expect(await code(open().acquire({ key: "b", pid: owner() }))).toBe("conflict");
  expect(pool.status().queue.map((w) => w.key)).toEqual(["b"]);
  pool.release({ key: "a" });
  expect(await first).toBe("ok");
});

test("releasing by key and owner leaves another owner's lease alone", async () => {
  const pool = open();
  const holder = owner();
  await pool.acquire({ key: "a", pid: holder });
  expect(pool.release({ key: "a", pid: owner() })).toEqual({ leases: 0, waiters: 0 });
  expect(pool.release({ key: "a", pid: holder })).toEqual({ leases: 1, waiters: 0 });
});

test("rejects a TTL that is not positive", async () => {
  expect(open().acquire({ key: "a", pid: owner(), ttl: 0 })).rejects.toThrow(RangeError);
  expect(open().acquire({ key: "a", pid: owner(), ttl: -1 })).rejects.toThrow(RangeError);
});

test("releasing a queued key cancels its wait", async () => {
  const pool = open();
  await pool.acquire({ key: "a", pid: owner() });
  const waiting = code(open().acquire({ key: "b", pid: owner() }));
  await settle();
  expect(pool.release({ key: "b" })).toEqual({ leases: 0, waiters: 1 });
  expect(await waiting).toBe("cancelled");
});

test("aborting leaves the queue", async () => {
  const pool = open();
  await pool.acquire({ key: "a", pid: owner() });
  const controller = new AbortController();
  const waiting = code(open().acquire({ key: "b", pid: owner(), signal: controller.signal }));
  await settle();
  controller.abort();
  expect(await waiting).toBe("aborted");
  expect(pool.status().queue).toHaveLength(0);
});

test("a timed-out waiter keeps its place for a retry, then loses it", async () => {
  let now = 1_000_000;
  const clock = () => now;
  const pool = open({ now: clock });
  await pool.acquire({ key: "a", pid: owner() });
  const retrier = owner();
  expect(await code(open({ now: clock }).acquire({ key: "b", pid: retrier, timeout: 0 }))).toBe("timeout");
  const later = open({ now: clock }).acquire({ key: "c", pid: owner() });
  await settle();
  expect(pool.status().queue.map((w) => w.key)).toEqual(["b", "c"]);

  // Retrying keeps "b" ahead of "c".
  const retry = open({ now: clock }).acquire({ key: "b", pid: retrier });
  await settle();
  pool.release({ key: "a" });
  await retry;
  expect(pool.status().queue.map((w) => w.key)).toEqual(["c"]);

  // A place nobody comes back for lapses after the grace period.
  pool.release({ key: "b" });
  await later;
  expect(await code(open({ now: clock }).acquire({ key: "d", pid: owner(), timeout: 0 }))).toBe("timeout");
  now += RETRY_GRACE + 1;
  expect(pool.status().queue).toHaveLength(0);
});

test("pools are independent", async () => {
  const a = new Pool({ home, name: "a" });
  const b = new Pool({ home, name: "b" });
  pools.push(a, b);
  await a.acquire({ key: "x", pid: owner() });
  await b.acquire({ key: "x", pid: owner() });
  expect(a.status().leases).toHaveLength(1);
  expect(b.status().leases).toHaveLength(1);
});

test("parses durations", () => {
  expect(parseDuration("90")).toBe(90_000);
  expect(parseDuration("20m")).toBe(1_200_000);
  expect(parseDuration("1h30m")).toBe(5_400_000);
  expect(parseDuration("none")).toBeNull();
  expect(() => parseDuration("2 hours")).toThrow();
});

test("renewing a key checks the caller owns it", async () => {
  const pool = open();
  const pid = owner();
  await pool.acquire({ key: "a", pid });
  expect(pool.renew({ key: "a", pid: owner() })).toBe(0);
  expect(pool.renew({ key: "a", pid })).toBe(1);
});

test("a wait that fails unexpectedly leaves the queue", async () => {
  const pool = open();
  await pool.acquire({ key: "a", pid: owner() });
  const failing = open().acquire({
    key: "b",
    pid: owner(),
    onWait: () => {
      throw new Error("boom");
    },
  });
  expect(failing).rejects.toThrow("boom");
  await failing.catch(() => {});
  expect(pool.status().queue).toEqual([]);
});
