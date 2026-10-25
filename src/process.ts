import { spawnSync } from "node:child_process";
import { basename } from "node:path";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Start time as `ps` reports it; tells a live owner from a process that reused its PID. */
  start: string;
  command: string;
}

/** Agent CLIs whose process outlives each shell command they run, so it can own a lease. */
const AGENT_COMMANDS = new Set(["claude", "codex"]);

/**
 * Reads the given processes (all when `pids` is omitted) from `ps`.
 * Returns null where `ps` is unavailable (Windows, minimal containers).
 */
export function readProcesses(pids?: number[]): Map<number, ProcessInfo> | null {
  if (process.platform === "win32") return null;
  if (pids?.length === 0) return new Map();
  const select = pids ? ["-p", pids.join(",")] : ["-A"];
  // Fixed locale and zone: start times recorded by one caller must match another's.
  const ps = spawnSync("ps", [...select, "-o", "pid=,ppid=,stat=,lstart=,comm="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  // `ps -p` exits 1 when some PIDs are gone but still lists the rest, silently. Anything on
  // stderr means a `ps` without these columns (BusyBox): unusable, not "everyone is dead".
  // Same for a `ps` killed by a signal, or a row we can't read.
  if (ps.error || ps.signal || ps.stdout === null || ps.stderr.trim() !== "") return null;
  const table = new Map<number, ProcessInfo>();
  for (const line of ps.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/);
    if (!m) return null;
    // A zombie has exited; only its parent hasn't reaped it yet.
    if (m[3]!.startsWith("Z")) continue;
    const pid = Number(m[1]);
    table.set(pid, { pid, ppid: Number(m[2]), start: m[4]!.replace(/\s+/g, " "), command: m[5]! });
  }
  return table;
}

function signalable(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Returns a liveness check for owners recorded as (pid, start time). */
export function livenessOf(pids: number[]): (pid: number, start: string | null) => boolean {
  const table = readProcesses([...new Set(pids)]);
  if (!table) return (pid) => signalable(pid);
  return (pid, start) => {
    const info = table.get(pid);
    return info !== undefined && (start === null || info.start === start);
  };
}

/** The process's identity for a lease: whether it runs, and its start time where `ps` can tell. */
export function processIdentity(pid: number): { alive: boolean; start: string | null } {
  const table = readProcesses([pid]);
  if (!table) return { alive: signalable(pid), start: null };
  const start = table.get(pid)?.start ?? null;
  return { alive: start !== null, start };
}

/**
 * The process that should own a lease taken from a shell command: the agent
 * session running it, since the shell exits as soon as the command returns.
 * Prefers Claude Code's CLAUDE_PID, then the nearest agent ancestor, then the parent.
 */
export function findOwnerPid(env: NodeJS.ProcessEnv = process.env): number {
  const claude = Number(env.CLAUDE_PID);
  if (Number.isInteger(claude) && claude > 0 && signalable(claude)) return claude;
  const table = readProcesses();
  for (let pid = process.ppid; pid > 1;) {
    const info = table?.get(pid);
    if (!info) break;
    if (AGENT_COMMANDS.has(basename(info.command))) return pid;
    pid = info.ppid;
  }
  return process.ppid;
}
