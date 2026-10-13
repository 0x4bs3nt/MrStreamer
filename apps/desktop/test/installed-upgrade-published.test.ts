// The installers the Windows installed upgrade check accepts, from GitHub's answers: the newest
// published stable release and the candidate nightly the caller names, each the build its tag
// names, and nothing else. Answers come from fixtures shaped like GitHub's; a check that doubts
// anything installs nothing.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readReceipt,
  resolvePackages,
  type GitHub,
  type Resolved,
} from "./e2e/installed-upgrade-packages.ts";

const EXPECTED: Resolved = {
  stableTag: "v0.0.11",
  stableSha: "a".repeat(40),
  candidateTag: "v0.0.12-nightly.20261013.330",
  candidateSha: "b".repeat(40),
};
const bytes = (text: string) => new TextEncoder().encode(text);
const digest = (data: Uint8Array, algorithm = "sha256", encoding: "hex" | "base64" = "hex") =>
  createHash(algorithm).update(data).digest(encoding);
const listed = (tag_name: string, changes: { draft?: boolean; prerelease?: boolean } = {}) => ({
  tag_name,
  draft: false,
  prerelease: tag_name.includes("-nightly."),
  published_at: changes.draft ? null : "2026-10-01T00:00:00Z",
  ...changes,
});

/** Published release API contracts, with real recomputed synthetic package hashes. */
function published() {
  const assets = new Map<number, Uint8Array>();
  const release = (tag: string, first: number, prerelease: boolean) => {
    const version = tag.slice(1);
    const name = `Mr-Streamer-${version}-win-x64-setup.exe`;
    const setup = bytes(`Published installer ${version}`);
    const sha512 = digest(setup, "sha512", "base64");
    const latest = {
      version,
      path: name,
      sha512,
      files: [{ url: name, sha512, size: setup.length }],
    };
    const entries = [
      { id: first, name, data: setup },
      { id: first + 1, name: "SHA256SUMS.txt", data: bytes(`${digest(setup)}  ${name}\n`) },
      { id: first + 2, name: "latest.yml", data: bytes(JSON.stringify(latest)) },
    ];
    for (const entry of entries) assets.set(entry.id, entry.data);
    return {
      name,
      latest,
      metadataId: first + 2,
      value: {
        tag_name: tag,
        draft: false,
        prerelease,
        published_at: "2026-10-13T00:00:00Z",
        assets: entries.map(({ id, name, data }) => ({
          id,
          name,
          size: data.length,
          digest: `sha256:${digest(data)}`,
        })),
      },
    };
  };
  const stable = release(EXPECTED.stableTag, 1, false);
  const candidate = release(EXPECTED.candidateTag, 4, true);
  // GitHub lists releases newest-created first; the newest stable is found by version.
  const releases = [
    listed(EXPECTED.candidateTag),
    listed("v0.0.9"),
    listed(EXPECTED.stableTag),
    listed("v0.0.11-nightly.20261001.300"),
    listed("v0.0.10"),
  ];
  const diff = { status: "ahead", ahead_by: 8, behind_by: 0 };
  const onMain = { status: "ahead", ahead_by: 1, behind_by: 0 };
  const json: Record<string, unknown> = {
    "": { default_branch: "main" },
    [`/releases/tags/${EXPECTED.stableTag}`]: stable.value,
    [`/releases/tags/${EXPECTED.candidateTag}`]: candidate.value,
    [`/commits/${EXPECTED.stableTag}`]: { sha: EXPECTED.stableSha },
    [`/commits/${EXPECTED.candidateTag}`]: { sha: EXPECTED.candidateSha },
    [`/compare/${EXPECTED.stableSha}...main?per_page=1`]: onMain,
    [`/compare/${EXPECTED.candidateSha}...main?per_page=1`]: onMain,
    [`/compare/${EXPECTED.stableSha}...${EXPECTED.candidateSha}?per_page=1`]: diff,
  };
  const api: GitHub = {
    repository: "owner/player",
    json: vi.fn(async (path: string) => {
      const page = /^\/releases\?per_page=100&page=(\d+)$/.exec(path)?.[1];
      if (page) return structuredClone(releases.slice((+page - 1) * 100, +page * 100));
      if (!(path in json)) throw new Error(`Unexpected API request ${path}`);
      return structuredClone(json[path]);
    }),
    bytes: async (path) => {
      const id = Number(path.split("/").at(-1));
      const data = assets.get(id);
      if (!data) throw new Error(`Unexpected asset request ${path}`);
      return data;
    },
  };
  const replace = (id: number, data: Uint8Array) => {
    assets.set(id, data);
    const entry = [...stable.value.assets, ...candidate.value.assets].find(
      (each) => each.id === id,
    )!;
    entry.size = data.length;
    entry.digest = `sha256:${digest(data)}`;
  };
  return {
    api,
    json,
    assets,
    releases,
    stable,
    candidate,
    diff,
    onMain,
    replace,
    resolve: (tag = EXPECTED.candidateTag, sha?: string) => resolvePackages(api, { tag, sha }),
  };
}

describe("the newest published stable release", () => {
  it("is derived with both tags' commits and recorded in a two-package receipt", async () => {
    const world = published();
    const { receipt, files } = await world.resolve();
    expect(receipt.resolved).toEqual(EXPECTED);
    expect(readReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
    expect(receipt.packages.map(({ stage, version, source }) => [stage, version, source])).toEqual([
      ["stable", "0.0.11", EXPECTED.stableSha],
      ["candidate", "0.0.12-nightly.20261013.330", EXPECTED.candidateSha],
    ]);
    expect(receipt.candidateAheadBy).toBe(8);
    for (const pkg of receipt.packages) {
      const data = files.get(pkg.file)!;
      expect(pkg.sha256).toBe(digest(data));
      expect(pkg.bytes).toBe(data.length);
      expect(pkg.provenance.metadata.sha512).toBe(digest(data, "sha512", "base64"));
    }
    expect(JSON.stringify(receipt)).not.toMatch(/token|Authorization|workflowCommit/);
    expect(world.api.json).not.toHaveBeenCalledWith(expect.stringContaining("/actions/"));
  });

  it("ignores drafts, prereleases, nightlies and tags that are not canonical stable versions", async () => {
    const world = published();
    world.releases.unshift(
      listed("v0.0.14", { draft: true }),
      listed("v0.0.13", { prerelease: true }),
      listed("v0.0.15-nightly.20261020.400", { prerelease: false }),
      listed("v0.0.016"),
      listed("latest"),
    );
    expect((await world.resolve()).receipt.resolved.stableTag).toBe(EXPECTED.stableTag);
  });

  it("reads every page of the release list", async () => {
    const world = published();
    world.releases.unshift(
      ...Array.from({ length: 100 }, (_, run) => listed(`v0.0.12-nightly.20261012.${run + 1}`)),
    );
    expect((await world.resolve()).receipt.resolved.stableTag).toBe(EXPECTED.stableTag);
    expect(world.api.json).toHaveBeenCalledWith("/releases?per_page=100&page=2");
  });

  it("refuses when no published stable release exists", async () => {
    const world = published();
    world.releases.splice(
      0,
      Infinity,
      listed(EXPECTED.candidateTag),
      listed("v0.0.11", { draft: true }),
    );
    await expect(world.resolve()).rejects.toThrow(/no published stable release/);
  });

  // The release plan's rule (packages/contracts/src/promotion.ts), so a promotion the plan
  // accepts is one this check accepts too.
  it("refuses a candidate no newer than the newest stable, whatever it holds", async () => {
    const world = published();
    const newer = "c".repeat(40);
    world.releases.unshift(listed("v0.0.12"));
    world.json["/commits/v0.0.12"] = { sha: newer };
    world.json[`/compare/${newer}...main?per_page=1`] = world.onMain;
    world.json[`/compare/${newer}...${EXPECTED.candidateSha}?per_page=1`] = world.diff;
    await expect(world.resolve()).rejects.toThrow(
      `${EXPECTED.candidateTag} sorts below v0.0.12, the newest stable release, so the upgrade check can't install it over that release. A stable release needs a fresh tested nightly: test one published after v0.0.12.`,
    );
  });

  it("refuses tags that name the same commit", async () => {
    const world = published();
    world.json[`/commits/${EXPECTED.candidateTag}`] = { sha: EXPECTED.stableSha };
    world.json[`/compare/${EXPECTED.stableSha}...${EXPECTED.stableSha}?per_page=1`] = {
      status: "identical",
      ahead_by: 0,
      behind_by: 0,
    };
    await expect(world.resolve()).rejects.toThrow(
      `${EXPECTED.candidateTag} was built from the same commit as ${EXPECTED.stableTag}, so it holds nothing new.`,
    );
  });
});

describe("the candidate and both published packages", () => {
  it.each([
    "v0.0.12",
    "latest",
    "0.0.12-nightly.20261013.330",
    "v0.0.12-nightly.20261013.0330",
    "",
  ])("refuses the candidate %j before asking GitHub", async (tag) => {
    const world = published();
    await expect(world.resolve(tag)).rejects.toThrow(/canonical nightly tag/);
    expect(world.api.json).not.toHaveBeenCalled();
  });

  it("is the commit a stable release planned, when the release names one, and its tag's otherwise", async () => {
    const planned = await published().resolve(EXPECTED.candidateTag, EXPECTED.candidateSha);
    expect(planned.receipt.resolved.candidateSha).toBe(EXPECTED.candidateSha);

    const moved = published();
    await expect(moved.resolve(EXPECTED.candidateTag, "f".repeat(40))).rejects.toThrow(
      `${EXPECTED.candidateTag} names ${EXPECTED.candidateSha}, not ${"f".repeat(40)}, the commit the release planned.`,
    );

    const short = published();
    await expect(short.resolve(EXPECTED.candidateTag, "abc123")).rejects.toThrow(
      "abc123 is not a full commit SHA.",
    );
    expect(short.api.json).not.toHaveBeenCalled();
  });

  it.each(["stable", "candidate"] as const)(
    "rejects the wrong published kind for %s",
    async (stage) => {
      const world = published();
      world[stage].value.prerelease = !world[stage].value.prerelease;
      await expect(world.resolve()).rejects.toThrow(/is not a published/);
    },
  );

  it("rejects a draft, wrong release tag or missing publication", async () => {
    const world = published();
    world.candidate.value.draft = true;
    await expect(world.resolve()).rejects.toThrow(/is not a published nightly/);
    world.candidate.value.draft = false;
    world.candidate.value.tag_name = "v0.0.12-nightly.20261013.331";
    await expect(world.resolve()).rejects.toThrow(/is not a published nightly/);
    world.candidate.value.tag_name = EXPECTED.candidateTag;
    world.json[`/releases/tags/${EXPECTED.candidateTag}`] = {
      ...world.candidate.value,
      published_at: null,
    };
    await expect(world.resolve()).rejects.toThrow(/is not a published nightly/);
  });

  it("rejects non-descendants and sources absent from main", async () => {
    const world = published();
    for (const status of ["diverged", "behind"]) {
      world.diff.status = status;
      await expect(world.resolve()).rejects.toThrow(
        `${EXPECTED.candidateTag} doesn't contain ${EXPECTED.stableTag}'s commit (${status})`,
      );
    }
    world.diff.status = "ahead";
    world.diff.ahead_by = 0;
    await expect(world.resolve()).rejects.toThrow(/strictly descend/);
    world.diff.ahead_by = 8;
    world.diff.status = "ahead";
    world.onMain.status = "behind";
    await expect(world.resolve()).rejects.toThrow(/main does not contain/);
  });

  it.each([1, 4])("checks SHA256SUMS.txt for installer asset %s", async (id) => {
    const world = published();
    world.replace(id, bytes("replaced setup with consistent GitHub asset digest"));
    await expect(world.resolve()).rejects.toThrow(/SHA256SUMS/);
  });

  it.each(["version", "size", "sha512", "filename", "extra file"])(
    "rejects wrong latest.yml %s",
    async (field) => {
      const world = published();
      const latest = world.candidate.latest;
      if (field === "version") latest.version = "0.0.12";
      if (field === "size") latest.files[0]!.size++;
      if (field === "sha512") latest.files[0]!.sha512 = "incorrect";
      if (field === "filename") latest.path = "other.exe";
      if (field === "extra file") latest.files.push({ ...latest.files[0]! });
      world.replace(world.candidate.metadataId, bytes(JSON.stringify(latest)));
      await expect(world.resolve()).rejects.toThrow(/latest.yml does not describe/);
    },
  );

  it("rejects GitHub asset digest/size mismatches and duplicate assets/checksum entries", async () => {
    const world = published();
    world.candidate.value.assets[0]!.digest = `sha256:${"0".repeat(64)}`;
    await expect(world.resolve()).rejects.toThrow(/asset digest/);
    world.candidate.value.assets[0]!.digest = `sha256:${digest(world.assets.get(4)!)}`;
    world.candidate.value.assets[0]!.size++;
    await expect(world.resolve()).rejects.toThrow(/asset size/);
    world.candidate.value.assets[0]!.size--;
    world.candidate.value.assets.push({ ...world.candidate.value.assets[0]! });
    await expect(world.resolve()).rejects.toThrow(/no single/);
    world.candidate.value.assets.pop();
    const sum = `${digest(world.assets.get(4)!)}  ${world.candidate.name}\n`;
    world.replace(5, bytes(sum + sum));
    await expect(world.resolve()).rejects.toThrow(/single SHA256SUMS/);
  });

  it("refuses a receipt of another shape and mismatched package identities", async () => {
    const { receipt } = await published().resolve();
    const { resolved, ...rest } = receipt;
    expect(() => readReceipt({ ...rest, pins: resolved })).toThrow();
    receipt.packages[1].source = "c".repeat(40);
    expect(() => readReceipt(receipt)).toThrow(/identity does not match/);
  });
});

// Each case starts Node on the script, which can take seconds while other suites run.
describe("the installed-upgrade public CLI", { timeout: 30_000 }, () => {
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ["apps/desktop/test/e2e/installed-upgrade.ts", ...args], {
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: "synthetic-never-sent", GITHUB_REPOSITORY: "owner/player" },
    });

  it.each([
    ["resolve", ["--stable-tag", EXPECTED.stableTag]],
    ["run", ["--candidate", EXPECTED.candidateTag]],
  ])("%s rejects unknown inputs", (command, args) => {
    const result = cli([command, ...args]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown option");
  });

  it.each([
    [[], "Usage"],
    [["--candidate", "v0.0.12"], "canonical nightly tag"],
  ])("resolve %j refuses before network access, without creating output", (args, message) => {
    const out = join(tmpdir(), `installed-upgrade-never-${process.pid}`);
    const result = cli(["resolve", ...args, "--out", out]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toMatch(/GitHub answered|fetch failed|synthetic-never-sent/);
    expect(result.stderr).toContain(message);
    expect(existsSync(out)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "run refuses native installs on this non-Windows host",
    () => {
      const result = cli(["run", "--packages", "/packages", "--root", "/root"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Windows only");
    },
  );
});
