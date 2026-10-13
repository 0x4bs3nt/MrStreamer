import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPublished, runCommand } from "./e2e/installed-upgrade.ts";
import type { Receipt } from "./e2e/installed-upgrade-packages.ts";
import { disposableRunner, install, processes } from "./e2e/installed-upgrade-windows.ts";

vi.mock("./e2e/installed-upgrade-windows.ts", async (original) => ({
  ...(await original<typeof import("./e2e/installed-upgrade-windows.ts")>()),
  disposableRunner: vi.fn(),
  install: vi.fn(),
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
