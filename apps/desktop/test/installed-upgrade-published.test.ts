import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readPublishedPins,
  readPublishedReceipt,
  resolvePublishedPair,
  type PublishedPins,
} from "./e2e/installed-upgrade.ts";
import type { GitHub } from "./e2e/installed-upgrade-packages.ts";

const PINS: PublishedPins = {
  stableTag: "v0.0.11",
  stableSha: "a".repeat(40),
  candidateTag: "v0.0.12-nightly.20261013.330",
  candidateSha: "b".repeat(40),
};
const INPUT = {
  "stable-tag": PINS.stableTag,
  "stable-sha": PINS.stableSha,
  "candidate-tag": PINS.candidateTag,
  "candidate-sha": PINS.candidateSha,
};
const bytes = (text: string) => new TextEncoder().encode(text);
const digest = (data: Uint8Array, algorithm = "sha256", encoding: "hex" | "base64" = "hex") =>
  createHash(algorithm).update(data).digest(encoding);

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
  const stable = release(PINS.stableTag, 1, false);
  const candidate = release(PINS.candidateTag, 4, true);
  const diff = { status: "ahead", ahead_by: 8, behind_by: 0 };
  const onMain = { status: "ahead", ahead_by: 1, behind_by: 0 };
  const json: Record<string, unknown> = {
    "": { default_branch: "main" },
    [`/releases/tags/${PINS.stableTag}`]: stable.value,
    [`/releases/tags/${PINS.candidateTag}`]: candidate.value,
    [`/commits/${PINS.stableTag}`]: { sha: PINS.stableSha },
    [`/commits/${PINS.candidateTag}`]: { sha: PINS.candidateSha },
    [`/compare/${PINS.stableSha}...main?per_page=1`]: onMain,
    [`/compare/${PINS.candidateSha}...main?per_page=1`]: onMain,
    [`/compare/${PINS.stableSha}...${PINS.candidateSha}?per_page=1`]: diff,
  };
  const api: GitHub = {
    repository: "owner/player",
    json: vi.fn(async (path) => {
      if (!(path in json)) throw new Error(`Unexpected API request ${path}`);
      return structuredClone(json[path]);
    }),
    text: async () => {
      throw new Error("Published resolution must not read dry-run logs.");
    },
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
    stable,
    candidate,
    diff,
    onMain,
    replace,
    resolve: () => resolvePublishedPair(api, PINS),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("pinned published stable to nightly packages", () => {
  it("accepts an explicit pair, checks both published sets and records a two-package receipt", async () => {
    const world = published();
    const { receipt, files } = await world.resolve();
    expect(readPublishedPins(INPUT)).toEqual(PINS);
    expect(readPublishedReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
    expect(receipt.packages.map(({ stage, version, source }) => [stage, version, source])).toEqual([
      ["stable", PINS.stableTag.slice(1), PINS.stableSha],
      ["candidate", PINS.candidateTag.slice(1), PINS.candidateSha],
    ]);
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      mode: "published-pair",
      candidateAheadBy: 8,
      pins: PINS,
    });
    for (const pkg of receipt.packages) {
      const data = files.get(pkg.file)!;
      expect(pkg.sha256).toBe(digest(data));
      expect(pkg.bytes).toBe(data.length);
      expect(pkg.provenance.metadata.sha512).toBe(digest(data, "sha512", "base64"));
    }
    expect(JSON.stringify(receipt)).not.toMatch(/token|Authorization|workflowCommit/);
    expect(world.api.json).not.toHaveBeenCalledWith(expect.stringContaining("/actions/"));
  });

  it.each([
    ["a nightly baseline", { "stable-tag": PINS.candidateTag }],
    ["a stable candidate", { "candidate-tag": "v0.0.12" }],
    ["a decreasing version", { "candidate-tag": "v0.0.11-nightly.20261013.330" }],
    ["an unpinned stable", { "stable-sha": "" }],
    ["an unpinned candidate", { "candidate-sha": "" }],
    ["a short commit", { "candidate-sha": "b1234" }],
    ["the same source", { "candidate-sha": PINS.stableSha }],
    ["a moving ref", { "stable-tag": "latest" }],
    ["a mixed mode", { "a-tag": PINS.candidateTag }],
    ["an unknown input", { "stable-hash": "unrecognized" }],
  ])("rejects %s before asking GitHub", (_name, changed) => {
    expect(() => readPublishedPins({ ...INPUT, ...changed })).toThrow();
  });

  it.each(["stable", "candidate"] as const)(
    "rejects the wrong published kind or moved tag for %s",
    async (stage) => {
      const world = published();
      world[stage].value.prerelease = !world[stage].value.prerelease;
      await expect(world.resolve()).rejects.toThrow(/pinned published/);
      world[stage].value.prerelease = stage === "candidate";
      const tag = stage === "stable" ? PINS.stableTag : PINS.candidateTag;
      world.json[`/commits/${tag}`] = { sha: "c".repeat(40) };
      await expect(world.resolve()).rejects.toThrow(/does not name/);
    },
  );

  it("rejects a draft, wrong release tag or missing publication", async () => {
    const world = published();
    world.candidate.value.draft = true;
    await expect(world.resolve()).rejects.toThrow(/pinned published/);
    world.candidate.value.draft = false;
    world.candidate.value.tag_name = "v0.0.12-nightly.20261013.331";
    await expect(world.resolve()).rejects.toThrow(/pinned published/);
    world.candidate.value.tag_name = PINS.candidateTag;
    world.json[`/releases/tags/${PINS.candidateTag}`] = {
      ...world.candidate.value,
      published_at: null,
    };
    await expect(world.resolve()).rejects.toThrow(/pinned published/);
  });

  it("rejects non-descendants and sources absent from main", async () => {
    const world = published();
    world.diff.status = "diverged";
    await expect(world.resolve()).rejects.toThrow(/strictly descend/);
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

  it("refuses a legacy receipt and mismatched published package identities", async () => {
    const { receipt } = await published().resolve();
    expect(() => readPublishedReceipt({ ...receipt, schemaVersion: 1, mode: undefined })).toThrow();
    receipt.packages[1].source = "c".repeat(40);
    expect(() => readPublishedReceipt(receipt)).toThrow(/identity does not match/);
  });
});

describe("the installed-upgrade public CLI", () => {
  it.each([
    ["resolve-published", ["--a-tag", PINS.candidateTag]],
    ["resolve", ["--stable-tag", PINS.stableTag]],
    ["resolve-published", ["--unknown", "value"]],
    ["run-published", ["--b-run", "123"]],
  ])("%s rejects unknown or mixed inputs", (command, args) => {
    const result = spawnSync(
      process.execPath,
      ["apps/desktop/test/e2e/installed-upgrade.ts", command, ...args],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown option");
  });

  it("refuses missing pins before network access, without creating output", () => {
    const result = spawnSync(
      process.execPath,
      [
        "apps/desktop/test/e2e/installed-upgrade.ts",
        "resolve-published",
        "--out",
        "/missing-published-pins",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GH_TOKEN: "synthetic-never-sent",
          GITHUB_REPOSITORY: "owner/player",
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toMatch(/GitHub answered|fetch failed|synthetic-never-sent/);
    expect(result.stderr).toContain("stableSha");
  });

  it.skipIf(process.platform === "win32")(
    "run-published refuses native installs on this non-Windows host",
    () => {
      const result = spawnSync(
        process.execPath,
        [
          "apps/desktop/test/e2e/installed-upgrade.ts",
          "run-published",
          "--packages",
          "/packages",
          "--root",
          "/root",
        ],
        { encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Windows only");
    },
  );
});
