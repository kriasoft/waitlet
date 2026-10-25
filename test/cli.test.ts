import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the CLI under Node, as `npx waitlet` would.
const CLI = join(import.meta.dir, "../src/cli.ts");
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "waitlet-cli-"));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}) {
  const { CLAUDE_PID, CLAUDE_CODE_SESSION_ID, ...rest } = process.env;
  return { ...rest, WAITLET_HOME: home, ...extra };
}

function waitlet(args: string[], extra: Record<string, string> = {}) {
  return spawnSync("node", [CLI, ...args], { encoding: "utf8", env: env(extra) });
}

test("five agents, two slots: never more than two run at once", async () => {
  expect(waitlet(["limit", "2", "--pool", "five"]).status).toBe(0);
  const log = join(home, "five.log");
  const stamp = (kind: string) => `node -e 'require("fs").appendFileSync("${log}", "${kind} " + Date.now() + "\\n")'`;
  const work = `${stamp("start")}; sleep 0.4; ${stamp("end")}`;
  const runs = Array.from(
    { length: 5 },
    (_, i) =>
      new Promise<number | null>((resolve) =>
        spawn("node", [CLI, "run", `agent-${i}`, "--pool", "five", "-q", "--", "sh", "-c", work], {
          env: env(),
          stdio: "inherit",
        }).on("exit", resolve),
      ),
  );
  expect(await Promise.all(runs)).toEqual([0, 0, 0, 0, 0]);

  const events = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split(" "))
    // At equal times an end sorts first: a slot freed and retaken in the same millisecond is no overlap.
    .toSorted((a, b) => Number(a[1]) - Number(b[1]) || (a[0] === "end" ? -1 : 1));
  let running = 0;
  let peak = 0;
  for (const [kind] of events) {
    running += kind === "start" ? 1 : -1;
    peak = Math.max(peak, running);
  }
  expect(events).toHaveLength(10);
  expect(peak).toBe(2);
  expect(JSON.parse(waitlet(["status", "--pool", "five", "--json"]).stdout).leases).toEqual([]);
}, 20_000);

test("acquire holds the slot for the agent process, not the shell that ran it", () => {
  const agent = spawn("sleep", ["30"]);
  try {
    const acquired = waitlet(["acquire", "ISS-5", "--pool", "agent", "--json"], { CLAUDE_PID: String(agent.pid) });
    expect(acquired.status).toBe(0);
    expect(JSON.parse(acquired.stdout)).toMatchObject({ key: "ISS-5", pid: agent.pid });
    // The command has exited; the slot stays held while the agent lives.
    const status = JSON.parse(waitlet(["status", "--pool", "agent", "--json"]).stdout);
    expect(status.leases.map((l: { key: string }) => l.key)).toEqual(["ISS-5"]);
    expect(waitlet(["acquire", "ISS-6", "--pool", "agent", "--timeout", "0"]).status).toBe(75);
    expect(waitlet(["release", "--pool", "agent"], { CLAUDE_PID: String(agent.pid) }).status).toBe(0);
    expect(JSON.parse(waitlet(["status", "--pool", "agent", "--json"]).stdout).leases).toEqual([]);
  } finally {
    agent.kill();
  }
});

test("exit codes: conflict 3, renew without a lease 1, bad usage 2", () => {
  const a = spawn("sleep", ["30"]);
  const b = spawn("sleep", ["30"]);
  try {
    expect(waitlet(["limit", "5", "--pool", "codes"]).status).toBe(0);
    expect(waitlet(["acquire", "X", "--pool", "codes", "--pid", String(a.pid)]).status).toBe(0);
    expect(waitlet(["acquire", "X", "--pool", "codes", "--pid", String(b.pid)]).status).toBe(3);
    expect(waitlet(["renew", "--pool", "codes", "--pid", String(b.pid)]).status).toBe(1);
    for (const args of [
      ["bogus"],
      ["acquire", "--nope"],
      ["acquire", "A", "B"],
      ["acquire", "A", "--ttl", "0"],
      ["acquire", "A", "--ttl", "banana"],
      ["acquire", "A", "--priority", ""],
      ["limit", "0"],
      ["status", "extra"],
      ["run", "--"],
    ]) {
      expect(waitlet(["--pool", "codes", ...args]).status).toBe(2);
    }
    expect(JSON.parse(waitlet(["status", "--pool", "codes", "--json"]).stdout).leases).toHaveLength(1);
  } finally {
    a.kill();
    b.kill();
  }
});

test("callers in different time zones agree a live owner is alive", () => {
  const agent = spawn("sleep", ["30"]);
  try {
    expect(waitlet(["acquire", "A", "--pool", "tz", "--pid", String(agent.pid)], { TZ: "UTC" }).status).toBe(0);
    const status = JSON.parse(waitlet(["status", "--pool", "tz", "--json"], { TZ: "Asia/Tokyo" }).stdout);
    expect(status.leases).toHaveLength(1);
  } finally {
    agent.kill();
  }
});

test("works without ps, falling back to signalling the owner", () => {
  const bin = mkdtempSync(join(tmpdir(), "waitlet-bin-"));
  symlinkSync(spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim(), join(bin, "node"));
  const agent = spawn("sleep", ["30"]);
  try {
    const noPs = { PATH: bin };
    const run = (args: string[]) => spawnSync(join(bin, "node"), [CLI, ...args], { encoding: "utf8", env: env(noPs) });
    expect(run(["acquire", "A", "--pool", "nops", "--pid", String(agent.pid)]).status).toBe(0);
    expect(JSON.parse(run(["status", "--pool", "nops", "--json"]).stdout).leases).toHaveLength(1);
  } finally {
    agent.kill();
    rmSync(bin, { recursive: true, force: true });
  }
});

test("run exits 128 + n when its command dies from signal n", () => {
  expect(waitlet(["run", "sig", "--pool", "sig", "--", "sh", "-c", "kill -TERM $$"]).status).toBe(143);
});

test("without a key or pool, release and renew cover the agent's leases in every pool", () => {
  const agent = spawn("sleep", ["30"]);
  try {
    const as = { CLAUDE_PID: String(agent.pid) };
    expect(waitlet(["acquire", "A", "--pool", "wide-1"], as).status).toBe(0);
    expect(waitlet(["acquire", "B", "--pool", "wide-2"], as).status).toBe(0);
    expect(JSON.parse(waitlet(["renew", "--json"], as).stdout)).toEqual({ renewed: 2 });
    expect(JSON.parse(waitlet(["release", "--json"], as).stdout)).toEqual({ leases: 2, waiters: 0 });
  } finally {
    agent.kill();
  }
});

test("--version prints the package version", () => {
  const { version } = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));
  expect(waitlet(["--version"]).stdout).toBe(`${version}\n`);
});

test("after --, a dash-led key is still the key", () => {
  const agent = spawn("sleep", ["30"]);
  try {
    const as = { CLAUDE_PID: String(agent.pid) };
    expect(waitlet(["limit", "2", "--pool", "dash"]).status).toBe(0);
    expect(waitlet(["acquire", "--pool", "dash", "--", "-x"], as).status).toBe(0);
    expect(waitlet(["acquire", "--pool", "dash", "--", "-y"], as).status).toBe(0);
    expect(waitlet(["release", "--pool", "dash", "--json", "--", "-x"]).stdout).toContain('"leases": 1');
    const status = JSON.parse(waitlet(["status", "--pool", "dash", "--json"]).stdout);
    expect(status.leases.map((l: { key: string }) => l.key)).toEqual(["-y"]);
  } finally {
    agent.kill();
  }
});

test("a second wait on the same key conflicts and leaves the first in place", async () => {
  const holder = spawn("sleep", ["30"]);
  const agent = spawn("sleep", ["30"]);
  try {
    expect(waitlet(["acquire", "A", "--pool", "twice", "--pid", String(holder.pid)]).status).toBe(0);
    const args = ["acquire", "B", "--pool", "twice", "--pid", String(agent.pid), "-q"];
    const first = spawn("node", [CLI, ...args], { env: env() });
    const exited = new Promise<number | null>((resolve) => first.on("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(waitlet([...args, "--timeout", "0"]).status).toBe(3);
    const status = JSON.parse(waitlet(["status", "--pool", "twice", "--json"]).stdout);
    expect(status.queue.map((w: { key: string }) => w.key)).toEqual(["B"]);
    expect(waitlet(["release", "B", "--pool", "twice"]).status).toBe(0);
    expect(await exited).toBe(4);
  } finally {
    holder.kill();
    agent.kill();
  }
});
