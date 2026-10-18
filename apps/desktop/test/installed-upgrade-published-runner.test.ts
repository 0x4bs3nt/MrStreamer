import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPublished, runCommand, telemetryCommand } from "./e2e/installed-upgrade.ts";
import { installedTelemetryPair } from "./e2e/analytics-installed-pair.ts";
import type { Receipt } from "./e2e/installed-upgrade-packages.ts";
import {
  disposableRunner,
  install,
  processes,
  uninstall,
} from "./e2e/installed-upgrade-windows.ts";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock("./e2e/installed-upgrade-windows.ts", async (original) => ({
  ...(await original<typeof import("./e2e/installed-upgrade-windows.ts")>()),
  disposableRunner: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  processes: vi.fn(),
}));

describe("the installed upgrade run before and around native installation", () => {
  let temp: string;
  let packages: string;
  let root: string;
  let receipt: Receipt;
  const setup = new TextEncoder().encode("synthetic published setup");
  const sha256 = createHash("sha256").update(setup).digest("hex");
  const sha512 = createHash("sha512").update(setup).digest("base64");
  const save = () => writeFile(join(packages, "receipt.json"), JSON.stringify(receipt));

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(processes).mockReturnValue([]);
    temp = await mkdtemp(join(tmpdir(), "published-upgrade-contract-"));
    packages = join(temp, "packages");
    root = join(temp, "fresh-run");
    await mkdir(packages);
    const stableTag = "v0.0.11";
    const candidateTag = "v0.0.12-nightly.20261013.330";
    const stableSha = "a".repeat(40);
    const candidateSha = "b".repeat(40);
    const pkg = (stage: "stable" | "candidate", tag: string, source: string) => ({
      stage,
      version: tag.slice(1),
      source,
      file: `${stage}-Mr-Streamer-${tag.slice(1)}-win-x64-setup.exe`,
      sha256,
      bytes: setup.length,
      provenance: {
        tag,
        releaseKind: stage === "stable" ? ("stable" as const) : ("nightly" as const),
        publishedAt: "2026-10-13T00:00:00Z",
        assetId: stage === "stable" ? 1 : 2,
        assetDigest: `sha256:${sha256}`,
        metadata: { sha256sums: sha256, latestYml: sha256, sha512 },
      },
    });
    receipt = {
      repository: "owner/player",
      resolvedAt: "2026-10-13T00:01:00Z",
      resolved: { stableTag, stableSha, candidateTag, candidateSha },
      packages: [pkg("stable", stableTag, stableSha), pkg("candidate", candidateTag, candidateSha)],
      defaultBranch: "main",
      candidateAheadBy: 8,
      limits: ["Synthetic contract test, no native proof."],
    };
    await save();
    for (const pkg of receipt.packages) await writeFile(join(packages, pkg.file), setup);
    vi.stubEnv("GITHUB_REPOSITORY", receipt.repository);
    vi.stubEnv("GITHUB_SHA", "c".repeat(40));
    vi.stubEnv("GITHUB_REF", "refs/heads/main");
    vi.mocked(disposableRunner).mockReturnValue({
      id: "synthetic-test",
      temp,
      installRoot: join(temp, "install"),
      executable: join(temp, "install", "app.exe"),
      tools: [],
    });
  });

  it("refuses telemetry outside main or against a different stable before creating a native root", async () => {
    vi.stubEnv("GITHUB_REF", "refs/heads/feature");
    await expect(telemetryCommand(["--packages", packages, "--root", root])).rejects.toThrow(
      "main only",
    );
    vi.stubEnv("GITHUB_REF", "refs/heads/main");
    await expect(telemetryCommand(["--packages", packages, "--root", root])).rejects.toThrow(
      "v0.0.15",
    );
    await expect(readFile(join(root, "evidence", "proof.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(install).not.toHaveBeenCalled();
  });

  it("awaits the installed pair's owned uninstaller and propagates its failure", async () => {
    receipt.resolved.stableTag = "v0.0.15";
    receipt.resolved.candidateTag = "v0.0.16-nightly.20261018.379";
    receipt.packages[0].version = "0.0.15";
    receipt.packages[0].provenance.tag = receipt.resolved.stableTag;
    receipt.resolved.stableSha = "cc6980d88673c838a5da4ee80af9495e430a4210";
    receipt.packages[0].source = receipt.resolved.stableSha;
    receipt.packages[1].version = receipt.resolved.candidateTag.slice(1);
    receipt.packages[1].provenance.tag = receipt.resolved.candidateTag;
    for (const pkg of receipt.packages) {
      pkg.file = `${pkg.stage}-Mr-Streamer-${pkg.version}-win-x64-setup.exe`;
      await writeFile(join(packages, pkg.file), setup);
    }
    await save();
    const evidence = join(temp, "pair-evidence");
    await mkdir(evidence);
    const runner = disposableRunner();
    const candidate = receipt.packages[1];
    vi.mocked(install).mockResolvedValue({
      version: candidate.version,
      seconds: 1,
      entry: { name: "Mr. Streamer", version: candidate.version },
      executable: runner.executable,
      executableSha256: sha256,
      appAsarSha256: sha256,
      tools: {},
    });
    vi.mocked(processes)
      .mockReturnValueOnce([
        {
          pid: 123,
          parent: process.pid,
          name: "setup.exe",
          path: join(packages, candidate.file),
          created: "2099-01-01T00:00:00Z",
        },
      ])
      .mockReturnValue([]);
    const pair = await installedTelemetryPair(packages, evidence, {
      executable: runner.executable,
      version: candidate.version,
      source: candidate.source,
    });
    await pair.select("candidate");
    pair.accepted();
    let rejectUninstall: (error: Error) => void = () => {
      throw new Error("Uninstaller was not called");
    };
    vi.mocked(uninstall).mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectUninstall = reject;
        }),
    );
    let settled = false;
    const closing = pair.close().finally(() => {
      settled = true;
    });
    const outcome = expect(closing).rejects.toThrow("owned uninstall refused");
    await Promise.resolve();
    expect(uninstall).toHaveBeenCalledWith(runner);
    expect(settled).toBe(false);
    rejectUninstall(new Error("owned uninstall refused"));
    await outcome;
    expect(
      JSON.parse(await readFile(join(evidence, "native-uninstall.json"), "utf8")),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("owned uninstall refused"),
    });
  });

  it("keeps full telemetry as default and forwards focused coverage with the resolved product pins", async () => {
    receipt.resolved.stableTag = "v0.0.15";
    receipt.resolved.stableSha = "cc6980d88673c838a5da4ee80af9495e430a4210";
    receipt.resolved.candidateTag = "v0.0.16-nightly.20261018.387";
    receipt.packages[0].version = "0.0.15";
    receipt.packages[0].source = receipt.resolved.stableSha;
    receipt.packages[0].provenance.tag = receipt.resolved.stableTag;
    receipt.packages[1].version = receipt.resolved.candidateTag.slice(1);
    receipt.packages[1].provenance.tag = receipt.resolved.candidateTag;
    for (const pkg of receipt.packages)
      pkg.file = `${pkg.stage}-Mr-Streamer-${pkg.version}-win-x64-setup.exe`;
    await save();
    const { spawn: realSpawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const child = vi.mocked(spawn);
    try {
      for (const focused of [false, true]) {
        // Replace only the child execution boundary. This Linux test cannot own a Windows install.
        child.mockImplementationOnce(() => realSpawn(process.execPath, ["-e", "process.exit(0)"]));
        await telemetryCommand([
          "--packages",
          packages,
          "--root",
          root + (focused ? "-focused" : "-all"),
          ...(focused
            ? ["--native-case", "compatibility", "--sha", receipt.resolved.candidateSha]
            : []),
        ]);
        const argv = child.mock.calls.at(-1)![1];
        expect(argv).toContain(`--expected-version=${receipt.packages[1].version}`);
        expect(argv).toContain(`--expected-source=${receipt.packages[1].source}`);
        expect(argv).not.toContain(`--expected-source=${process.env["GITHUB_SHA"]}`);
        expect(argv?.includes("--native-case=compatibility")).toBe(focused);
      }
      expect(install).not.toHaveBeenCalled();
    } finally {
      child.mockReset();
      child.mockImplementation(realSpawn);
    }
  });

  it("rejects an unpinned focused run, unsupported selection, wrong product pin or wrong .15 source before creating a root", async () => {
    const args = ["--packages", packages, "--root", root];
    await expect(telemetryCommand([...args, "--native-case", "compatibility"])).rejects.toThrow(
      "explicit full",
    );
    await expect(telemetryCommand([...args, "--native-case", "reenable"])).rejects.toThrow(
      "all or compatibility",
    );
    await expect(telemetryCommand([...args, "--sha", "main"])).rejects.toThrow(
      "full candidate SHA",
    );
    receipt.resolved.stableTag = "v0.0.15";
    receipt.resolved.candidateTag = "v0.0.16-nightly.20261018.387";
    receipt.packages[1].version = receipt.resolved.candidateTag.slice(1);
    receipt.packages[1].provenance.tag = receipt.resolved.candidateTag;
    receipt.packages[0].version = "0.0.15";
    receipt.packages[0].provenance.tag = receipt.resolved.stableTag;
    for (const pkg of receipt.packages)
      pkg.file = `${pkg.stage}-Mr-Streamer-${pkg.version}-win-x64-setup.exe`;
    await save();
    await expect(telemetryCommand(args)).rejects.toThrow("published .15 source");
    receipt.resolved.stableSha = "cc6980d88673c838a5da4ee80af9495e430a4210";
    receipt.packages[0].source = receipt.resolved.stableSha;
    await save();
    await expect(
      telemetryCommand([...args, "--native-case", "compatibility", "--sha", "d".repeat(40)]),
    ).rejects.toThrow("differs from the resolved receipt");
    await expect(readFile(join(root, "evidence", "proof.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(install).not.toHaveBeenCalled();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(temp, { recursive: true, force: true });
  });

  it("checks candidate bytes before installing stable", async () => {
    await writeFile(join(packages, receipt.packages[1].file), "altered candidate");
    await expect(runCommand(["--packages", packages, "--root", root])).rejects.toThrow(
      /changed since resolution/,
    );
    expect(install).not.toHaveBeenCalled();
  });

  it("refuses a receipt for another repository and a reused root", async () => {
    receipt.repository = "different/player";
    await save();
    await expect(runCommand(["--packages", packages, "--root", root])).rejects.toThrow(
      /another repository/,
    );
    expect(install).not.toHaveBeenCalled();
    receipt.repository = "owner/player";
    await save();
    await mkdir(root);
    await expect(runCommand(["--packages", packages, "--root", root])).rejects.toThrow(/EEXIST/);
    expect(install).not.toHaveBeenCalled();
  });

  it("starts from the resolved stable on a fresh profile and retains an honest failure receipt", async () => {
    vi.mocked(install).mockRejectedValue(
      new Error("Synthetic installer refused before native installation."),
    );
    await expect(runCommand(["--packages", packages, "--root", root])).rejects.toThrow(
      /Synthetic installer refused/,
    );
    expect(install).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({ id: "synthetic-test" }),
      join(packages, receipt.packages[0].file),
      "0.0.11",
      null,
    );
    const proof: unknown = JSON.parse(await readFile(join(root, "evidence", "proof.json"), "utf8"));
    expect(proof).toMatchObject({
      status: "failed",
      installs: {},
      starts: {},
      verification: { workflowCommit: "c".repeat(40) },
      cleanup: { services: expect.anything(), kept: ["profile", "profile.lock"] },
    });
  });

  it("records the setup's own PID/start time and hash, and refuses a foreign parent", async () => {
    const runner = disposableRunner();
    const setupPath = join(packages, receipt.packages[0].file);
    const installed = {
      version: "0.0.11",
      seconds: 1,
      entry: { name: "Mr. Streamer", version: "0.0.11" },
      executable: runner.executable,
      executableSha256: sha256,
      appAsarSha256: sha256,
      tools: {},
    };
    vi.mocked(install).mockResolvedValue(installed);
    const child = {
      pid: 123,
      parent: process.pid,
      name: "setup.exe",
      path: setupPath,
      created: "2099-01-01T00:00:00Z",
    };
    vi.mocked(processes).mockReturnValueOnce([child]).mockReturnValue([]);
    await expect(installPublished(runner, setupPath, "0.0.11", null)).resolves.toMatchObject({
      installer: {
        pid: 123,
        parent: process.pid,
        executable: setupPath,
        createdAt: child.created,
        setupSha256: sha256,
        ended: true,
      },
    });
    vi.mocked(processes).mockReturnValue([{ ...child, parent: process.pid + 1 }]);
    await expect(installPublished(runner, setupPath, "0.0.11", null)).rejects.toThrow(
      /installer child owned/,
    );
    vi.mocked(processes).mockReturnValue([child]);
    await expect(installPublished(runner, setupPath, "0.0.11", null)).rejects.toThrow(
      /still running/,
    );
  });
});
