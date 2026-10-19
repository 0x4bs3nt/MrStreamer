import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeNative } from "./e2e/analytics-exit.ts";
import { ownedGroup, type OwnershipSample } from "./e2e/installed-media-posix.ts";

vi.mock("node:fs", { spy: true });
const { readFileSync: readFile } = await vi.importActual<typeof fs>("node:fs");
const children: ChildProcess[] = [];
const executable = fs.realpathSync(process.execPath);
function child(detached = true) {
  const app = spawn(process.execPath, ["-e", "process.on('message',()=>process.exit(0))"], {
    detached,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  children.push(app);
  return app;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    children.splice(0).map(async (app) => {
      if (app.exitCode !== null || app.signalCode !== null) return;
      const exit = once(app, "exit");
      app.kill("SIGTERM");
      await exit;
    }),
  );
});

const posix = process.platform === "linux" || process.platform === "darwin";

/** A real detached main exits first; its child keeps the same group until released or timed out.
 * The host init reaps the orphan. No installed application or native media is involved.
 */
async function lingeringChild(autoExitMs: number) {
  const profile = fs.mkdtempSync(join(tmpdir(), "installed-media-drain-"));
  const release = join(profile, "release");
  const signals = join(profile, "signals");
  const companion = `
    const fs = require('node:fs');
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'])
      process.on(signal, () => fs.appendFileSync(${JSON.stringify(signals)}, signal + '\\n'));
    process.on('disconnect', () => {
      const until = Date.now() + ${autoExitMs};
      setInterval(() => {
        if (fs.existsSync(${JSON.stringify(release)}) || Date.now() >= until) process.exit(0);
      }, 20);
    });
    process.send('ready');
  `;
  const app = spawn(
    process.execPath,
    [
      "-e",
      `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(companion)}], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      });
      child.once('message', () => process.send(child.pid));
      process.on('message', () => process.exit(0));
    `,
    ],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  children.push(app);
  const samples: OwnershipSample[] = [];
  const owner = ownedGroup(app, executable, Date.now(), (sample) => samples.push(sample));
  const [pid] = await once(app, "message");
  const exit = await closeNative(app, async () => app.send("stop"));
  expect(exit).toMatchObject({
    code: 0,
    signal: null,
    forced: false,
    alreadyExited: false,
    requestError: null,
  });
  return {
    owner,
    samples,
    pid,
    profile,
    signals,
    async dispose() {
      fs.writeFileSync(release, "release only this test child");
      await owner.drain(5000);
      fs.rmSync(profile, { recursive: true });
    },
  };
}

describe.runIf(posix)("installed media POSIX ownership", () => {
  it("waits for an actual owned child after strict main close and retains the transient rows", async () => {
    const fixture = await lingeringChild(600);
    try {
      const immediate = fixture.owner.sample();
      expect(immediate.map((row) => row.pid)).toContain(fixture.pid);
      expect(immediate.some((row) => row.pid === fixture.owner.root.pid)).toBe(false);
      await expect(fixture.owner.drain()).resolves.toEqual([]);
      expect(fixture.samples.at(-1)?.group).toEqual([]);
      expect(
        fixture.samples.some((sample) =>
          sample.group.some((row) => row.pid === fixture.pid && row.raw),
        ),
      ).toBe(true);
      expect(fs.existsSync(fixture.signals)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  it("fails at the child deadline, preserves the actual survivor and profile, and sends no signal", async () => {
    const fixture = await lingeringChild(5000);
    try {
      await expect(fixture.owner.drain(60)).rejects.toThrow("survivors; profile retained");
      expect(fixture.samples.at(-1)?.group).toEqual([
        expect.objectContaining({
          pid: fixture.pid,
          group: fixture.owner.root.pid,
          raw: expect.any(String),
        }),
      ]);
      expect(fs.existsSync(fixture.profile)).toBe(true);
      expect(fs.existsSync(fixture.signals)).toBe(false);
      expect(fixture.owner.sample().map((row) => row.pid)).toContain(fixture.pid);
    } finally {
      await fixture.dispose();
    }
  });

  it("pins an actually spawned detached child and observes its disappearance after exit", async () => {
    const startedAt = Date.now();
    const app = child();
    const samples: OwnershipSample[] = [];
    const owner = ownedGroup(app, executable, startedAt, (sample) => samples.push(sample));
    expect(owner.root).toMatchObject({
      pid: app.pid,
      parent: process.pid,
      group: app.pid,
      executable,
    });
    expect(owner.sample().map((row) => row.pid)).toContain(app.pid);
    const exit = once(app, "exit");
    app.send("stop");
    await exit;
    expect(owner.sample()).toEqual([]);
    expect(samples[0]?.root?.raw).toBeTruthy();
  });

  it("rejects a child without its own detached group and retains the rejected sample", () => {
    const startedAt = Date.now();
    const app = child(false);
    const samples: OwnershipSample[] = [];
    expect(() => ownedGroup(app, executable, startedAt, (sample) => samples.push(sample))).toThrow(
      "detached process group",
    );
    expect(samples[0]?.root).toMatchObject({ pid: app.pid, parent: process.pid });
    expect(samples[0]?.root?.raw).toBeTruthy();
  });

  it("rejects an unowned older process even when its executable matches", () => {
    const samples: OwnershipSample[] = [];
    expect(() =>
      ownedGroup(
        { pid: process.pid, exitCode: null, signalCode: null },
        executable,
        Date.now(),
        (sample) => samples.push(sample),
      ),
    ).toThrow("live direct child");
    expect(samples[0]?.root?.pid).toBe(process.pid);
  });

  it("rejects a different installed executable with the actual path retained", () => {
    const startedAt = Date.now();
    const app = child();
    const samples: OwnershipSample[] = [];
    expect(() =>
      ownedGroup(app, `${executable}.other`, startedAt, (sample) => samples.push(sample)),
    ).toThrow("executable differs");
    expect(samples[0]?.executable).toBe(executable);
  });

  it("refuses acquisition after the spawned child has exited", async () => {
    const startedAt = Date.now();
    const app = child();
    const exit = once(app, "exit");
    app.send("stop");
    await exit;
    const samples: OwnershipSample[] = [];
    expect(() => ownedGroup(app, executable, startedAt, (sample) => samples.push(sample))).toThrow(
      "live direct child",
    );
    expect(samples[0]?.exitCode).toBe(0);
  });

  it.runIf(process.platform === "linux")(
    "accepts the real child independently of a changed wall clock",
    () => {
      const app = child();
      // A wall-clock adjustment is not evidence that this live direct child is older/unowned.
      const owner = ownedGroup(app, executable, Date.now() + 60_000, () => {});
      expect(owner.root.startClock).toBe("boot-ticks");
      expect(owner.sample().map((row) => row.pid)).toContain(app.pid);
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects a reused root PID even with the same parent, group and executable",
    () => {
      const app = child();
      const samples: OwnershipSample[] = [];
      const owner = ownedGroup(app, executable, Date.now(), (sample) => samples.push(sample));
      const stat = fs.readFileSync(`/proc/${app.pid}/stat`, "utf8");
      // Model the OS assigning this PID to a later process. Only its birth identity changes.
      const end = stat.lastIndexOf(")") + 2;
      const fields = stat.slice(end).trim().split(/\s+/);
      fields[19] = String(Number(fields[19]) + 1);
      const reused = stat.slice(0, end) + fields.join(" ");
      vi.mocked(fs.readFileSync).mockImplementation((path, options) =>
        path === `/proc/${app.pid}/stat` ? reused : readFile(path, options),
      );
      expect(() => owner.sample()).toThrow("PID was reused");
      expect(samples.at(-1)?.root?.raw).toBe(reused);
    },
  );
  it.runIf(process.platform === "linux")(
    "rejects an older process found in the owned detached group",
    () => {
      const app = child();
      const samples: OwnershipSample[] = [];
      const owner = ownedGroup(app, executable, Date.now(), (sample) => samples.push(sample));
      const stat = readFile(`/proc/${process.pid}/stat`, "utf8");
      // An older process appears in this group. Its real birth identity stays unchanged.
      const end = stat.lastIndexOf(")") + 2;
      const fields = stat.slice(end).trim().split(/\s+/);
      fields[2] = String(app.pid);
      const unowned = stat.slice(0, end) + fields.join(" ");
      vi.mocked(fs.readFileSync).mockImplementation((path, options) =>
        path === `/proc/${process.pid}/stat` ? unowned : readFile(path, options),
      );
      expect(() => owner.sample()).toThrow("Group member predates owned app");
      expect(samples.at(-1)?.group.some((row) => row.pid === process.pid)).toBe(true);
    },
  );
});
