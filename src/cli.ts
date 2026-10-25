#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { parseArgs } from "node:util";

import { formatDuration, parseDuration } from "./duration.ts";
import { Pool, WaitletError, type Lease, type PoolStatus } from "./pool.ts";
import { findOwnerPid } from "./process.ts";

// Node 22 flags node:sqlite as experimental when it loads; agents and hooks parse stderr, so
// drop that one warning. It is emitted on the next tick, so wrapping the listeners here is in time.
for (const listener of process.listeners("warning")) {
  process.off("warning", listener);
  process.on("warning", (warning) => {
    if (warning.name !== "ExperimentalWarning" || !warning.message.startsWith("SQLite")) listener(warning);
  });
}

const USAGE = `waitlet: cooperative concurrency slots for AI coding agents

Usage:
  waitlet acquire [key]        wait for a slot, then hold it for the calling agent
  waitlet release [key]        free key's slot or queue place; without a key, every one the
                               calling agent holds, in every pool unless --pool is given
  waitlet renew [key]          extend the calling agent's leases by their TTL (all pools, as above)
  waitlet run [key] -- <cmd>   hold a slot while <cmd> runs
  waitlet status               show holders and the queue
  waitlet limit [n]            show or set how many slots the pool has

Options:
  --pool <name>      pool to use (default: $WAITLET_POOL or "default")
  --ttl <duration>   acquire: lease lapses this long after acquiring or the last renew
                     (default 2h; "none" to rely on the owner process alone)
  --timeout <dur>    acquire: stop waiting after this long, keeping the place for 60s
  --priority <n>     acquire: higher goes first (default 0)
  --pid <pid>        owner process (default: the calling Claude Code or Codex session,
                     else the parent process)
  --json             machine-readable output
  -q, --quiet        print nothing on success
  -v, --version      print the version

The key names the work (e.g. an issue ID); it defaults to the Claude Code session ID.

Exit codes: 0 ok, 1 error, 2 usage, 3 key held or awaited elsewhere,
            4 removed from the queue, 75 timed out (retry to keep the place).`;

const EXIT = { conflict: 3, cancelled: 4, aborted: 130, timeout: 75, "no-owner": 1 } as const;
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/** The signal that stopped a wait, for a conventional 128 + n exit code. */
let stoppedBy: NodeJS.Signals | undefined;

function signalExit(signal: NodeJS.Signals): number {
  return 128 + (constants.signals[signal] ?? 0);
}

class UsageError extends Error {}

/** How many positional arguments each command takes after its name. */
const ARITY: Record<string, number> = { acquire: 1, release: 1, renew: 1, run: 1, status: 0, limit: 1 };

async function main(argv: string[]): Promise<number> {
  // What follows `--` is run's command; for any other command `--` only ends the options.
  const dashdash = argv.indexOf("--");
  const { values, positionals } = parseArgs({
    args: dashdash === -1 ? argv : argv.slice(0, dashdash),
    allowPositionals: true,
    options: {
      pool: { type: "string" },
      ttl: { type: "string" },
      timeout: { type: "string" },
      priority: { type: "string" },
      pid: { type: "string" },
      json: { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.version) {
    // src/ and dist/ both sit next to package.json.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    console.log(pkg.version);
    return 0;
  }
  const [command, ...args] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command || values.help ? 0 : 2;
  }
  const tail = dashdash === -1 ? [] : argv.slice(dashdash + 1);
  if (command !== "run") args.push(...tail);
  const arity = ARITY[command];
  if (arity === undefined) throw new UsageError(`unknown command "${command}"`);
  if (args.length > arity) throw new UsageError(`too many arguments for ${command}`);
  if (command === "run" && tail.length === 0) throw new UsageError("run needs a command after --");

  // Validated before touching state, so bad input exits 2 and changes nothing.
  const ttl = values.ttl === undefined ? undefined : duration(values.ttl, "--ttl");
  if (ttl === 0) throw new UsageError('--ttl must be positive, or "none"');
  const options = {
    ttl,
    timeout: values.timeout === undefined ? undefined : (duration(values.timeout, "--timeout") ?? undefined),
    priority: values.priority === undefined ? undefined : integer(values.priority, "--priority"),
    quiet: values.quiet,
  };
  const limit = command === "limit" && args[0] !== undefined ? integer(args[0], "limit", 1) : undefined;
  const explicitPid = values.pid === undefined ? undefined : integer(values.pid, "--pid", 1);
  const owner = () => explicitPid ?? findOwnerPid();

  const out = (text: string, json: unknown) => {
    if (values.json) console.log(JSON.stringify(json, null, 2));
    else if (!values.quiet) console.log(text);
  };
  const poolName = values.pool ?? process.env.WAITLET_POOL;
  const pool = new Pool({ name: poolName });
  // An agent's own leases may sit in any pool; hooks can't know which, so without a key or a
  // chosen pool, release and renew cover every pool.
  const ownerWide = <T>(fn: (p: Pool) => T): T[] => {
    if (poolName !== undefined) return [fn(pool)];
    return pool.names().map((name) => {
      const p = name === pool.name ? pool : new Pool({ name });
      try {
        return fn(p);
      } finally {
        if (p !== pool) p.close();
      }
    });
  };

  try {
    switch (command) {
      case "acquire": {
        const pid = owner();
        const key = args[0] ?? process.env.CLAUDE_CODE_SESSION_ID ?? `pid-${pid}`;
        const lease = await acquire(pool, key, pid, options);
        out(`waitlet: acquired ${key} (${slots(pool.status())} slots in use, pool ${pool.name})`, lease);
        return 0;
      }
      case "release": {
        const key = args[0];
        const all =
          key === undefined ? ownerWide((p) => p.release({ pid: owner() })) : [pool.release({ key, pid: explicitPid })];
        const counts = {
          leases: all.reduce((n, c) => n + c.leases, 0),
          waiters: all.reduce((n, c) => n + c.waiters, 0),
        };
        const what = key ?? "the calling agent";
        const inUse = key === undefined && poolName === undefined ? "" : ` (${slots(pool.status())} slots in use)`;
        out(
          counts.leases + counts.waiters === 0
            ? `waitlet: nothing held or queued for ${what}`
            : `waitlet: released ${what}${inUse}`,
          counts,
        );
        return 0;
      }
      case "renew": {
        const key = args[0];
        const pid = owner();
        const renewed =
          key === undefined ? ownerWide((p) => p.renew({ pid })).reduce((a, b) => a + b, 0) : pool.renew({ key, pid });
        out(renewed ? `waitlet: renewed ${renewed} lease(s)` : "waitlet: no live lease to renew", { renewed });
        return renewed ? 0 : 1;
      }
      case "run": {
        const key = args[0] ?? `run-${process.pid}`;
        // This process owns the lease, so it frees itself when the command ends however it ends.
        await acquire(pool, key, process.pid, { ...options, ttl: options.ttl === undefined ? null : options.ttl });
        return await new Promise<number>((resolve) => {
          const [cmd, ...cmdArgs] = tail;
          const child = spawn(cmd!, cmdArgs, { stdio: "inherit" });
          const forward = (signal: NodeJS.Signals) => child.kill(signal);
          // Dying on a signal would free the slot while the command still runs.
          for (const signal of FORWARDED) process.on(signal, forward);
          child.on("error", (error) => {
            console.error(`waitlet: ${error.message}`);
            resolve(127);
          });
          child.on("exit", (code, signal) => resolve(code ?? (signal ? signalExit(signal) : 1)));
          // If a --ttl lapsed meanwhile, the key may be someone else's now: release only our own.
        }).finally(() => pool.release({ key, pid: process.pid }));
      }
      case "status": {
        const status = pool.status();
        out(formatStatus(status), status);
        return 0;
      }
      case "limit": {
        if (limit !== undefined) pool.setLimit(limit);
        const status = pool.status();
        out(`waitlet: pool ${pool.name} has ${status.limit} slot(s)`, { pool: pool.name, limit: status.limit });
        return 0;
      }
      default:
        throw new Error(`unhandled command "${command}"`);
    }
  } finally {
    pool.close();
  }
}

async function acquire(
  pool: Pool,
  key: string,
  pid: number,
  options: { ttl?: number | null; timeout?: number; priority?: number; quiet?: boolean },
): Promise<Lease> {
  const controller = new AbortController();
  const abort = (signal: NodeJS.Signals) => {
    stoppedBy = signal;
    controller.abort();
  };
  for (const signal of FORWARDED) process.once(signal, abort);
  try {
    return await pool.acquire({
      key,
      pid,
      ttl: options.ttl,
      timeout: options.timeout,
      priority: options.priority,
      signal: controller.signal,
      meta: context(),
      onWait: (position, status) => {
        if (options.quiet) return;
        const holders = status.leases.map((l) => l.key).join(", ");
        console.error(
          `waitlet: waiting for ${key}: position ${position}, ${slots(status)} slots held by ${holders || "nobody"}`,
        );
      },
    });
  } finally {
    for (const signal of FORWARDED) process.off(signal, abort);
  }
}

/** Where a lease comes from, for `status`. */
function context(): Record<string, string> {
  const env = process.env;
  const meta: Record<string, string> = { cwd: process.cwd() };
  if (env.CLAUDE_CODE_SESSION_ID) meta.claudeSession = env.CLAUDE_CODE_SESSION_ID;
  if (env.SUPERSET_WORKSPACE_ID) meta.supersetWorkspace = env.SUPERSET_WORKSPACE_ID;
  if (env.SUPERSET_AGENT_ID) meta.supersetAgent = env.SUPERSET_AGENT_ID;
  return meta;
}

function slots(status: PoolStatus): string {
  return `${status.leases.length}/${status.limit}`;
}

function formatStatus(status: PoolStatus): string {
  const now = Date.now();
  const lines = [`pool ${status.pool}: ${slots(status)} slots in use, ${status.queue.length} waiting`];
  for (const l of status.leases) {
    const expires = l.expiresAt === null ? "no ttl" : `lapses in ${formatDuration(l.expiresAt - now)}`;
    lines.push(
      `  held    ${l.key}  pid ${l.pid}  for ${formatDuration(now - l.acquiredAt)}, ${expires}  ${where(l.meta)}`,
    );
  }
  status.queue.forEach((w, i) => {
    const priority = w.priority ? `, priority ${w.priority}` : "";
    lines.push(
      `  ${String(i + 1).padEnd(6)}  ${w.key}  pid ${w.pid}  waiting ${formatDuration(now - w.enqueuedAt)}${priority}  ${where(w.meta)}`,
    );
  });
  return lines.join("\n");
}

function where(meta: Record<string, string>): string {
  return meta.supersetWorkspace ? `superset workspace ${meta.supersetWorkspace}` : (meta.cwd ?? "");
}

function integer(text: string, name: string, min = -Infinity): number {
  const n = Number(text);
  if (text.trim() === "" || !Number.isInteger(n) || n < min) {
    throw new UsageError(`${name} must be ${min === 1 ? "a positive integer" : "an integer"}, got "${text}"`);
  }
  return n;
}

function duration(text: string, name: string): number | null {
  try {
    return parseDuration(text);
  } catch (error) {
    throw new UsageError(`${name}: ${(error as Error).message}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof WaitletError) {
      console.error(`waitlet: ${error.message}`);
      process.exit(error.code === "aborted" && stoppedBy ? signalExit(stoppedBy) : EXIT[error.code]);
    }
    const usage = error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    console.error(`waitlet: ${(error as Error).message}${usage ? "\nRun waitlet --help for usage." : ""}`);
    process.exit(usage ? 2 : 1);
  },
);
