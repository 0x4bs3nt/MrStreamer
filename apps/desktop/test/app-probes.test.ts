import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { cpuDelta, wakeupSupport } from "./e2e/app-probes.ts";

it("reports cumulative CPU in seconds and percent of one core over the actual window", () => {
  expect(cpuDelta(20, 21.2, 60_000)).toMatchObject({
    status: "supported",
    cpuSeconds: expect.closeTo(1.2),
    percentOneCore: expect.closeTo(2),
  });
  expect(cpuDelta(20, 20, 60_000)).toMatchObject({
    status: "supported",
    cpuSeconds: 0,
    percentOneCore: 0,
  });
  for (const [before, after, elapsed] of [
    [undefined, 1, 60_000],
    [1, undefined, 60_000],
    [2, 1, 60_000],
    [0, NaN, 60_000],
    [0, 1, 0],
  ] as const)
    expect(cpuDelta(before, after, elapsed).status).toBe("unsupported");
});

it("does not label Linux context switches or Windows placeholder zero as wakeups", () => {
  expect(wakeupSupport("linux").status).toBe("unsupported");
  expect(wakeupSupport("win32").status).toBe("unsupported");
  expect(wakeupSupport("darwin")).toMatchObject({ status: "supported", unit: "wakeups/s" });
});

it("refuses ambiguous diagnostic CLI invocations before starting an app", () => {
  for (const args of [
    ["--diagnostics-only"],
    ["--covered-idle", "--idle-probes"],
    ["--host-condition", "possibly-quiet"],
  ]) {
    const result = spawnSync(process.execPath, ["apps/desktop/test/e2e/measure-app.ts", ...args], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /requires --idle-probes|Run --covered-idle separately|--host-condition must/,
    );
  }
});
