import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectScenario,
  recordBuild,
  requiredScenarios,
  runReleaseUI,
  verifyBuild,
} from "../scripts/release-ui.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A disposable release source, with actual child CLIs standing in for app scenario contracts. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "release-ui-contract-"));
  roots.push(root);
  const write = async (path: string, content: string) => {
    const absolute = join(root, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, content);
  };
  await write(".gitignore", ".local/\napps/desktop/out/\n");
  await write("apps/desktop/package.json", JSON.stringify({ name: "fixture", version: "0.0.11" }));
  for (const path of ["main/index.js", "preload/index.cjs", "renderer/index.html"])
    await write(`apps/desktop/out/${path}`, path);
  const child = `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv[2] !== 'doctor') {
  const scenario = process.argv[2] ?? 'analytics';
  const output = process.env.MR_STREAMER_VERIFICATION_OUTPUT;
  const receipt = JSON.parse(readFileSync('apps/desktop/out/release-ui-build.json'));
  const options = JSON.parse(readFileSync('.local/options.json'));
  const proof = {
    scenario, status: options.status ?? 'passed',
    build: { revision: receipt.revision, appVersion: receipt.appVersion, mainSha256: receipt.files['main/index.js'] },
    actions: [{action: 'Observe public fixture', at: new Date().toISOString()}],
    observed: {requests: 1},
    cleanup: {appExited: true, profileRemoved: true, fixturesClosed: !options.cleanupFailure, errors: []},
  };
  const finish = (code) => {
    if (!options.missingProof) writeFileSync(join(output, 'proof.json'), JSON.stringify(proof));
    writeFileSync(join(output, 'result.png'), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC", "base64"));
    if (options.invalidScreenshot) writeFileSync(join(output, 'result.png'), 'broken PNG');
    writeFileSync(join(output, 'electron.log'), 'owned session ended');
    process.exit(code);
  };
  writeFileSync(join(output, 'started'), scenario);
  if (options.hold) {
    process.on('SIGTERM', () => {proof.status = 'failed'; finish(7);});
    setInterval(() => {}, 1000);
  } else finish(options.exit ?? 0);
}
`;
  await write(".cursor/skills/verify-mrstreamer/scripts/control.ts", child);
  await write("apps/desktop/test/e2e/analytics-app.ts", child);
  await write(".local/options.json", "{}");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "release source",
  );
  const revision = git("rev-parse", "HEAD");
  const build = await recordBuild(root, revision, "0.0.11");
  return {
    root,
    revision,
    build,
    write,
    run: (output = ".local/proof") =>
      runReleaseUI({ root, revision, appVersion: "0.0.11", output: join(root, output) }),
  };
}

describe("release UI public runner/report contract", () => {
  it("requires all seven actual child outcomes and retains original exits and build bytes", async () => {
    const f = await fixture();
    const report = await f.run();
    expect(report.status).toBe("passed");
    expect(report.results.map((result) => result.scenario)).toEqual(requiredScenarios);
    expect(report.results.every((result) => result.status === "passed" && result.code === 0)).toBe(
      true,
    );
    expect(
      JSON.parse(await readFile(join(f.root, ".local/proof/home/cli.json"), "utf8")),
    ).toMatchObject({ code: 0, signal: null });
    expect(report.build).toEqual(f.build);
    expect(await verifyBuild(f.root, f.revision, "0.0.11")).toEqual(f.build);
  });

  it.each([
    { status: "skipped" },
    { missingProof: true },
    { cleanupFailure: true },
    { exit: 23 },
    { invalidScreenshot: true },
  ])("fails required proof even with otherwise successful children: %j", async (options) => {
    const f = await fixture();
    await f.write(".local/options.json", JSON.stringify(options));
    const report = await f.run();
    expect(report.status).toBe("failed");
    expect(report.exitCode).toBe("exit" in options ? 23 : 1);
    expect(report.results.every((result) => result.status === "failed")).toBe(true);
  });

  it("rejects absent scenario proof even when the child exits zero", async () => {
    const f = await fixture();
    const result = await inspectScenario(join(f.root, ".local/absent"), "analytics", f.build, {
      code: 0,
      signal: null,
    });
    expect(result.status).toBe("failed");
    expect(result.errors.some((error) => error.includes("ENOENT"))).toBe(true);
  });

  it("retains cancellation cleanup and the original child exit, and marks unstarted scenarios missing", async () => {
    const f = await fixture();
    await f.write(".local/options.json", JSON.stringify({ hold: true }));
    const abort = new AbortController();
    const output = join(f.root, ".local/cancel");
    const pending = runReleaseUI({
      root: f.root,
      revision: f.revision,
      appVersion: "0.0.11",
      output,
      signal: abort.signal,
    });
    for (let i = 0; i < 100; i++) {
      if (
        await readFile(join(output, "live-tv/started")).then(
          () => true,
          () => false,
        )
      )
        break;
      await delay(20);
    }
    abort.abort();
    const report = await pending;
    expect(report.exitCode).toBe(130);
    expect(report.results[0]).toMatchObject({ scenario: "live-tv", code: 7, status: "failed" });
    expect(report.results.slice(1).every((result) => result.status === "missing")).toBe(true);
    const proof = JSON.parse(await readFile(join(output, "live-tv/proof.json"), "utf8"));
    expect(proof.cleanup).toMatchObject({
      appExited: true,
      profileRemoved: true,
      fixturesClosed: true,
    });
  });

  it("bounds a stalled child and fails its timeout despite completed teardown", async () => {
    const f = await fixture();
    await f.write(".local/options.json", JSON.stringify({ hold: true }));
    const report = await runReleaseUI({
      root: f.root,
      revision: f.revision,
      appVersion: "0.0.11",
      output: join(f.root, ".local/timeout"),
      timeoutMs: 200,
    });
    expect(report.status).toBe("failed");
    expect(report.results.every((result) => result.errors.includes("timeout"))).toBe(true);
  });

  it("rejects altered bundle bytes, the wrong source and unstamped package changes", async () => {
    const f = await fixture();
    await expect(verifyBuild(f.root, "0".repeat(40), "0.0.11")).rejects.toThrow("revision");
    await f.write("apps/desktop/out/main/index.js", "stale bundle");
    await expect(verifyBuild(f.root, f.revision, "0.0.11")).rejects.toThrow("bytes or provenance");
    const report = await f.run();
    expect(report.results.every((result) => result.status === "missing")).toBe(true);
    await f.write(
      "apps/desktop/package.json",
      JSON.stringify({ name: "different", version: "0.0.11" }),
    );
    await expect(recordBuild(f.root, f.revision, "0.0.11")).rejects.toThrow("identity");
  });

  it("permits only the planned package version stamp, keeping the original source tree", async () => {
    const f = await fixture();
    await f.write(
      "apps/desktop/package.json",
      JSON.stringify({ name: "fixture", version: "0.0.11-nightly.20261011.1" }),
    );
    const receipt = await recordBuild(f.root, f.revision, "0.0.11-nightly.20261011.1");
    expect(receipt.tree).toBe(f.build.tree);
    expect(await verifyBuild(f.root, f.revision, receipt.appVersion)).toEqual(receipt);
  });
});
