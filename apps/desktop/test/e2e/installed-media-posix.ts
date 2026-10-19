// Ownership and read-only survivor audits for the installed-media verifier's detached POSIX app.
import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

function posixProcesses() {
  if (process.platform === "linux")
    return readdirSync("/proc").flatMap((entry) => {
      if (!/^\d+$/.test(entry)) return [];
      let raw: string;
      try {
        raw = readFileSync(`/proc/${entry}/stat`, "utf8");
      } catch (error) {
        // A process can exit between the directory listing and stat read.
        if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
        throw error;
      }
      // comm is parenthesized and may itself contain spaces or closing parentheses.
      const fields = raw
        .slice(raw.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const started = Number(fields[19]); // stat field 22: exact start ticks since boot.
      assert(Number.isSafeInteger(started) && started >= 0, `Invalid process stat: ${raw}`);
      return [
        { pid: Number(entry), parent: Number(fields[1]), group: Number(fields[2]), started, raw },
      ];
    });
  assert.equal(process.platform, "darwin", "POSIX ownership supports Linux and macOS only");
  return execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,args="], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, LC_ALL: "C" },
  })
    .split("\n")
    .flatMap((raw) => {
      const match = raw
        .trim()
        .match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
      if (!match) return [];
      return [
        {
          pid: Number(match[1]),
          parent: Number(match[2]),
          group: Number(match[3]),
          started: Date.parse(match[4]!),
          raw,
        },
      ];
    });
}

type ProcessRow = ReturnType<typeof posixProcesses>[number];
export interface OwnershipSample {
  at: number;
  elapsedMs: number;
  wallMs: number;
  phase: "acquire" | "audit";
  platform: NodeJS.Platform;
  startClock: "boot-ticks" | "epoch-ms";
  pid: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  root: ProcessRow | undefined;
  group: ProcessRow[];
  executable?: string;
}

/**
 * Call synchronously immediately after spawn, before yielding: the live direct child and its
 * parent identify this launch without comparing Linux's rounded ps boot epoch with wall time.
 * Pin exact kernel start ticks on Linux for subsequent reuse and detached-group member audits.
 * macOS retains its ps start identity and wall-time bound. No process is killed by this helper.
 */
export function ownedGroup(
  app: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">,
  expectedExecutable: string,
  startedAt: number,
  record: (sample: OwnershipSample) => void,
) {
  const started = performance.now();
  const pid = app.pid;
  const snapshot = (phase: OwnershipSample["phase"]) => {
    const at = Date.now();
    const before = performance.now();
    const all = posixProcesses();
    const sample: OwnershipSample = {
      at,
      elapsedMs: before - started,
      wallMs: performance.now() - before,
      phase,
      platform: process.platform,
      startClock: process.platform === "linux" ? "boot-ticks" : "epoch-ms",
      pid,
      exitCode: app.exitCode,
      signalCode: app.signalCode,
      root: all.find((row) => row.pid === pid),
      group: all.filter((row) => row.group === pid),
    };
    record(sample); // Keep the raw rejected row, including acquisition and post-exit audits.
    return sample;
  };
  const first = snapshot("acquire");
  const root = first.root;
  assert(
    root &&
      root.group === pid &&
      root.parent === process.pid &&
      app.exitCode === null &&
      app.signalCode === null,
    "Spawned app is not a live direct child owning its detached process group",
  );
  if (process.platform === "darwin")
    assert(root.started >= Math.floor(startedAt / 1000) * 1000, "Process start predates spawn");
  const executable = realpathSync(
    process.platform === "linux"
      ? readlinkSync(`/proc/${pid}/exe`)
      : execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
          encoding: "utf8",
          timeout: 5000,
        }).trim(),
  );
  first.executable = executable;
  assert.equal(executable, expectedExecutable, "Process group root executable differs");
  const sample = () => {
    const { root: current, group } = snapshot("audit");
    assert(
      !current ||
        (current.started === root.started &&
          current.parent === root.parent &&
          current.group === root.group &&
          app.exitCode === null &&
          app.signalCode === null),
      "Owned process group PID was reused or its identity changed",
    );
    assert(
      group.every((row) => row.started >= root.started),
      "Group member predates owned app",
    );
    return group;
  };
  return {
    root: { ...root, executable, startClock: first.startClock },
    sample,
    /** After a strict successful main close, observe children ending without signaling them.
     * Match Windows' child grace. Every poll retains raw rows and rechecks pinned ownership;
     * deadline or audit failure leaves the last actual sample and profile for diagnosis.
     */
    async drain(childGraceMs = 20_000) {
      const until = performance.now() + childGraceMs;
      let remaining = sample();
      while (remaining.length && performance.now() < until) {
        await delay(Math.min(200, Math.max(0, until - performance.now())));
        remaining = sample();
      }
      assert.equal(remaining.length, 0, "Owned process group survivors; profile retained");
      return remaining;
    },
  };
}
