// The installers the Windows installed upgrade check accepts, from GitHub's answers: three rising
// versions, each the build its pins name, and nothing else. Answers come from fixtures shaped
// like GitHub's; a check that doubts anything installs nothing.
import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { producePackageReceipt } from "../scripts/package-receipt.ts";
import {
  readPins,
  resolvePackages,
  type GitHub,
  type Pins,
} from "./e2e/installed-upgrade-packages.ts";

const REPOSITORY = "owner/player";
const A = "0.0.10-nightly.20261010.282";
const B = "0.0.10-nightly.20261010.290";
const PINS: Pins = { aTag: `v${A}`, aSha: "a".repeat(40), bRun: 900, bSha: "b".repeat(40) };
const NOW = Date.parse("2026-10-11T00:00:00Z");

const hex = (bytes: Uint8Array, algorithm = "sha256") =>
  createHash(algorithm).update(bytes).digest("hex");
const setup = (version: string) => `Mr-Streamer-${version}-win-x64-setup.exe`;
const latest = (version: string, bytes: Uint8Array) => {
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  return strToU8(
    `version: ${version}\nfiles:\n  - url: ${setup(version)}\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: ${setup(version)}\nsha512: ${sha512}\nreleaseDate: '2026-10-10T08:00:00.000Z'\n`,
  );
};

/** GitHub as the check sees it when every pin holds; each test spoils one answer. */
function github(withReceipt = false) {
  const files = {
    stable: strToU8("prior stable setup"),
    a: strToU8("nightly A setup"),
    b: strToU8("dry run B setup"),
  };
  const stablePin = { tag: "v0.0.9", source: "5".repeat(40), sha256: hex(files.stable) };
  const assets = new Map<number, Uint8Array>([
    [1, files.stable],
    [2, files.a],
    [3, strToU8(`${hex(files.a)}  ${setup(A)}\n${"0".repeat(64)}  latest.yml\n`)],
    [4, latest(A, files.a)],
  ]);
  const archive = zipSync({
    [setup(B)]: files.b,
    [`${setup(B)}.blockmap`]: strToU8("blockmap"),
    "latest.yml": latest(B, files.b),
  });
  const release = (tag: string, prerelease: boolean, list: [number, string][]) => ({
    tag_name: tag,
    draft: false,
    prerelease,
    published_at: "2026-10-10T08:52:00Z",
    assets: list.map(([id, name]) => ({
      id,
      name,
      size: assets.get(id)!.length,
      digest: `sha256:${hex(assets.get(id)!)}`,
    })),
  });
  const aRelease = release(`v${A}`, true, [
    [2, setup(A)],
    [3, "SHA256SUMS.txt"],
    [4, "latest.yml"],
  ]);
  const onMain = { status: "ahead", ahead_by: 3, behind_by: 0, files: [] };
  const run = {
    id: 900,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_sha: PINS.bSha,
    head_branch: "t3/upgrade-check",
    workflow_id: 7,
    run_attempt: 1,
    run_number: 290,
    html_url: "https://github.com/owner/player/actions/runs/900",
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
  };
  const jobs = {
    jobs: [
      { id: 11, name: "Plan", conclusion: "success" },
      { id: 12, name: "Release / Package win-x64", conclusion: "success" },
      { id: 13, name: "Release / Publish GitHub Release", conclusion: "skipped" },
      { id: 14, name: "Release / Update feed", conclusion: "skipped" },
      { id: 15, name: "Nightly first", conclusion: "skipped" },
    ],
  };
  const pull = {
    number: 200,
    state: "open",
    merged_at: null,
    base: { ref: "main" },
    head: { ref: "t3/upgrade-check", repo: { full_name: REPOSITORY } },
  };
  const diff: {
    status: string;
    ahead_by: number;
    behind_by: number;
    files: { filename: string; previous_filename?: string }[];
  } = {
    status: "ahead",
    ahead_by: 1,
    behind_by: 0,
    files: [
      { filename: ".github/workflows/windows-installed-upgrade.yml" },
      { filename: "apps/desktop/test/e2e/installed-upgrade.ts" },
      { filename: "docs/contributing/testing.md" },
    ],
  };
  const artifacts = {
    total_count: 3,
    artifacts: [`release-win-x64-${B}`, `release-linux-x64-${B}`, `msix-${B}`].map(
      (name, index) => ({
        id: 30 + index,
        name,
        expired: false,
        expires_at: "2026-10-24T00:00:00Z",
        digest: `sha256:${hex(archive)}`,
        workflow_run: { id: 900, head_sha: PINS.bSha },
      }),
    ),
  };
  const json: Record<string, unknown> = {
    "": { default_branch: "main" },
    "/releases/tags/v0.0.9": release("v0.0.9", false, [[1, setup("0.0.9")]]),
    "/commits/v0.0.9": { sha: stablePin.source },
    [`/releases/tags/v${A}`]: aRelease,
    [`/commits/v${A}`]: { sha: PINS.aSha },
    [`/compare/${PINS.aSha}...main?per_page=1`]: onMain,
    "/actions/workflows/release.yml": { id: 7 },
    "/actions/runs/900": run,
    "/actions/runs/900/attempts/1/jobs?per_page=100": jobs,
    "/pulls/200": pull,
    "/pulls/200/commits?per_page=100": [{ sha: PINS.aSha }, { sha: PINS.bSha }],
    [`/compare/${PINS.aSha}...${PINS.bSha}`]: diff,
    "/actions/runs/900/artifacts?per_page=100&page=1": artifacts,
    [`/commits/${PINS.bSha}/pulls?per_page=100`]: [{ ...pull, number: 200 }],
  };
  const log = [
    '2026-10-10T09:00:00.0000000Z ##[group]Run gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/200/labels/release%20dry%20run" --silent || echo "The label was already off."',
    "2026-10-10T09:00:01.0000000Z skip=false",
    "2026-10-10T09:00:01.0000000Z channel=nightly",
    `2026-10-10T09:00:01.0000000Z version=${B}`,
    `2026-10-10T09:00:01.0000000Z tag=v${B}`,
    `2026-10-10T09:00:01.0000000Z sha=${PINS.bSha}`,
    "2026-10-10T09:00:01.0000000Z previous-tag=",
  ];
  const text: Record<string, string> = { "/actions/jobs/11/logs": log.join("\n") };
  const bytes: Record<string, Uint8Array> = {
    ...Object.fromEntries([...assets].map(([id, value]) => [`/releases/assets/${id}`, value])),
    "/actions/artifacts/30/zip": archive,
  };
  if (withReceipt) {
    const receipt = producePackageReceipt(
      {
        repository: REPOSITORY,
        sourceCommit: PINS.bSha,
        workflowCommit: "c".repeat(40),
        appVersion: B,
        packageVersion: B,
        platform: "win-x64",
        distribution: "direct",
        run: { id: 900, attempt: 1, headCommit: PINS.bSha },
        artifact: { id: 30, name: `release-win-x64-${B}`, sha256: hex(archive) },
      },
      new Map([
        [setup(B), files.b],
        [`${setup(B)}.blockmap`, strToU8("blockmap")],
        ["latest.yml", latest(B, files.b)],
      ]),
    );
    const receiptArchive = zipSync({ "package-receipt.json": strToU8(JSON.stringify(receipt)) });
    artifacts.artifacts.push({
      ...artifacts.artifacts[0]!,
      id: 33,
      name: `package-receipt-win-x64-direct-${B}-attempt-1`,
      digest: `sha256:${hex(receiptArchive)}`,
    });
    artifacts.total_count++;
    bytes["/actions/artifacts/33/zip"] = receiptArchive;
    // New selection must succeed even when logs are unavailable or change their presentation.
    delete text["/actions/jobs/11/logs"];
  }
  const answer = <T>(table: Record<string, T>, path: string): T => {
    if (!(path in table)) throw new Error(`No fixture for ${path}`);
    return table[path]!;
  };
  const api: GitHub = {
    repository: REPOSITORY,
    json: async (path) => structuredClone(answer(json, path)),
    text: async (path) => answer(text, path),
    bytes: async (path) => answer(bytes, path),
  };
  return {
    api,
    json,
    aRelease,
    onMain,
    run,
    jobs,
    pull,
    diff,
    artifacts,
    text,
    bytes,
    files,
    stablePin,
    resolve: () => resolvePackages(api, PINS, stablePin, NOW),
  };
}
type World = ReturnType<typeof github>;

describe("the installers an installed upgrade check accepts", () => {
  it("are the pinned stable release, nightly A and dry run B, in rising versions", async () => {
    const world = github();
    const { receipt, files } = await world.resolve();
    expect(receipt.packages.map(({ stage, version, source }) => [stage, version, source])).toEqual([
      ["stable", "0.0.9", world.stablePin.source],
      ["a", A, PINS.aSha],
      ["b", B, PINS.bSha],
    ]);
    expect(receipt.packages.map((each) => each.sha256)).toEqual(
      [world.files.stable, world.files.a, world.files.b].map((each) => hex(each)),
    );
    for (const each of receipt.packages) expect(files.get(each.file)).toBeDefined();
    expect(receipt.limits[0]).toMatch(/no GitHub release or SHA256SUMS\.txt covers it/);
  });

  it.each<[string, (world: World) => void, RegExp]>([
    [
      "a stable setup other than the pinned one",
      (world) => (world.bytes["/releases/assets/1"] = strToU8("another stable setup")),
      /is \d+ bytes|does not match its digest/,
    ],
    [
      "a tag A that moved to another commit",
      (world) => (world.json[`/commits/v${A}`] = { sha: "c".repeat(40) }),
      /does not name/,
    ],
    [
      "an A that is still a draft",
      (world) => (world.aRelease.draft = true),
      /not a published nightly/,
    ],
    [
      "an A the default branch doesn't hold",
      (world) => (world.onMain.status = "diverged"),
      /does not contain A/,
    ],
    [
      "an A setup SHA256SUMS.txt doesn't list",
      (world) => (world.bytes["/releases/assets/3"] = strToU8(`${"1".repeat(64)}  ${setup(A)}\n`)),
      /is \d+ bytes|does not match/,
    ],
    [
      "an A whose latest.yml names another version",
      (world) => {
        const other = latest("0.0.10-nightly.20261010.281", world.files.a);
        world.bytes["/releases/assets/4"] = other;
        world.aRelease.assets[2] = {
          ...world.aRelease.assets[2]!,
          size: other.length,
          digest: `sha256:${hex(other)}`,
        };
      },
      /latest\.yml names/,
    ],
    ["a B run of another event", (world) => (world.run.event = "push"), /not a pull request/],
    ["a B run that failed", (world) => (world.run.conclusion = "failure"), /completed\/failure/],
    [
      "a B run of another workflow",
      (world) => (world.json["/actions/workflows/release.yml"] = { id: 8 }),
      /not of the Release workflow/,
    ],
    [
      "a B run from a fork",
      (world) => (world.run.head_repository.full_name = "fork/player"),
      /own branch/,
    ],
    [
      "a B whose Plan built another commit than the run's head",
      (world) =>
        (world.text["/actions/jobs/11/logs"] = world.text["/actions/jobs/11/logs"]!.replace(
          `sha=${PINS.bSha}`,
          `sha=${"d".repeat(40)}`,
        )),
      /Plan built/,
    ],
    [
      "a B run that published",
      (world) => (world.jobs.jobs[2]!.conclusion = "success"),
      /no dry run/,
    ],
    [
      "a B that changes the app",
      (world) => world.diff.files.push({ filename: "apps/desktop/src/main/index.ts" }),
      /1 besides verification files, such as apps\/desktop\/src\/main\/index\.ts/,
    ],
    [
      "a B that renames app source into a test",
      (world) =>
        world.diff.files.push({
          filename: "apps/desktop/test/moved.ts",
          previous_filename: "apps/desktop/src/main/moved.ts",
        }),
      /besides verification files/,
    ],
    [
      "a B that doesn't descend from A",
      (world) => Object.assign(world.diff, { status: "diverged", behind_by: 2 }),
      /does not descend from A/,
    ],
    [
      "a B pull request into another branch",
      (world) => (world.pull.base.ref = "release"),
      /into main/,
    ],
    [
      "a B pull request that never held its commit",
      (world) => (world.json["/pulls/200/commits?per_page=100"] = [{ sha: PINS.aSha }]),
      /does not hold/,
    ],
    [
      "a B run with two Windows artifacts",
      (world) => {
        world.artifacts.artifacts.push({
          ...world.artifacts.artifacts[0]!,
          id: 40,
          name: `release-win-x64-${A}`,
        });
        world.artifacts.total_count++;
      },
      /2 Windows artifacts/,
    ],
    [
      "a B artifact that expired",
      (world) => (world.artifacts.artifacts[0]!.expires_at = "2026-10-10T00:00:00Z"),
      /has expired/,
    ],
    [
      "a B archive other than its digest",
      (world) =>
        (world.bytes["/actions/artifacts/30/zip"] = zipSync({ [setup(B)]: world.files.b })),
      /does not match its digest/,
    ],
    [
      "a B no newer than A",
      (world) =>
        (world.text["/actions/jobs/11/logs"] = world.text["/actions/jobs/11/logs"]!.replace(
          `version=${B}`,
          "version=0.0.10-nightly.20261010.270",
        )),
      /is not newer than A/,
    ],
  ])("refuses %s", async (_, spoil, message) => {
    const world = github();
    spoil(world);
    await expect(world.resolve()).rejects.toThrow(message);
  });
});

describe("the pins of an installed upgrade check", () => {
  const valid = { "a-tag": `v${A}`, "a-sha": PINS.aSha, "b-run": "900", "b-sha": PINS.bSha };

  it("take a nightly tag, full commits and a run id", () => {
    expect(readPins(valid)).toEqual(PINS);
  });

  it.each<[string, Record<string, string>]>([
    ["a stable tag for A", { "a-tag": "v0.0.9" }],
    ["a short commit", { "a-sha": "abc1234" }],
    ["a run that isn't a number", { "b-run": "latest" }],
    ["the same commit for A and B", { "b-sha": PINS.aSha }],
  ])("refuse %s", (_, change) => {
    expect(() => readPins({ ...valid, ...change })).toThrow(/Refused/);
  });
});

describe("installed-upgrade selection from package receipts", () => {
  it("resolves the complete chain with no Plan log", async () => {
    const world = github(true);
    const { receipt } = await world.resolve();
    expect(receipt.packages[2].version).toBe(B);
    expect(receipt.packages[2].provenance).toMatchObject({
      selection: "package receipt v1",
      receiptArtifactId: 33,
    });
  });

  it("records the bounded historical fallback when the old run genuinely lacks receipts", async () => {
    const world = github();
    expect((await world.resolve()).receipt.packages[2].provenance.selection).toBe(
      "historical Plan log",
    );
  });

  it("rejects newer runs that lack receipts", async () => {
    const world = github();
    world.run.run_number = 297;
    await expect(world.resolve()).rejects.toThrow(/new run has no package receipt/);
  });

  it("never uses old logs after malformed JSON or an unsupported receipt schema", async () => {
    for (const value of ["{ broken JSON", '{"schemaVersion":2}']) {
      const world = github(true);
      const archive = zipSync({ "package-receipt.json": strToU8(value) });
      world.bytes["/actions/artifacts/33/zip"] = archive;
      world.artifacts.artifacts[3]!.digest = `sha256:${hex(archive)}`;
      await expect(world.resolve()).rejects.toThrow();
    }
  });

  it("rejects an earlier attempt's receipt rather than reading logs", async () => {
    const world = github(true);
    world.run.run_attempt = 2;
    world.json["/actions/runs/900/attempts/2/jobs?per_page=100"] = world.jobs;
    await expect(world.resolve()).rejects.toThrow(/attempt-2.*found 0/);
  });

  it("requires a single matching pull request from GitHub metadata", async () => {
    const world = github(true);
    world.json[`/commits/${PINS.bSha}/pulls?per_page=100`] = [];
    await expect(world.resolve()).rejects.toThrow(/no single matching/);
  });
});
