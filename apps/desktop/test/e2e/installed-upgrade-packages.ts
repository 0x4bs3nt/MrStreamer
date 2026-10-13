// The three Windows installers the installed upgrade check runs, one over another, and why each is
// the build it claims to be. Every input is pinned, every answer from GitHub is checked, and any
// doubt stops the check before anything is installed:
//
// - stable: v0.0.11's published setup, by its SHA-256.
// - A: a published nightly, by tag and commit. The tag must still name that commit, the commit be
//   on the default branch, and the setup match the release's SHA256SUMS.txt and latest.yml.
// - B: the Windows artifact of one successful release dry run of a same-repository pull request
//   into the default branch, by run id and commit. Its successful package receipt must bind the
//   source and version to its artifact and bytes. Publishing jobs must have been skipped, and the
//   commit must descend from A and change nothing but
//   verification files, and the artifact must match its digest, its own latest.yml and its version.
//   A dry run attaches no SHA256SUMS.txt, so no release checksum covers B.
//
// Versions must rise: stable, then A, then B. Nothing is looked up by "latest".
import { createHash } from "node:crypto";
import { type } from "arktype";
import { unzipSync } from "fflate";
import { parse } from "yaml";
import { packageArtifacts, resolvePackageReceipt } from "../../scripts/package-receipt.ts";
import { compareVersions, parseVersion } from "../../../../packages/contracts/src/version.ts";

/** What the person running the check pins: nothing here is looked up as "latest". */
export interface Pins {
  /** A published nightly's tag, such as v0.0.10-nightly.20261010.282. */
  readonly aTag: string;
  /** The full commit that tag names. */
  readonly aSha: string;
  /** The id of a successful release dry run of a pull request, made after A. */
  readonly bRun: number;
  /** The full commit that dry run built. */
  readonly bSha: string;
}

/** The prior stable release the chain starts from, as published. */
export interface StablePin {
  readonly tag: string;
  readonly source: string;
  readonly sha256: string;
}

export const STABLE: StablePin = {
  tag: "v0.0.11",
  source: "5db40b13ec7b3bf7a39781a71363f4fb17f2ad6d",
  sha256: "7413b501aa675f86a6c94f35a0c624f27417e84b302b57dad17823197aebbfd5",
};

/**
 * Paths a dry run B may change after A: none of them goes into the app. electron-builder packs
 * `out/` and package.json alone.
 */
const VERIFICATION_ONLY = [
  /^\.github\/workflows\/windows-installed-upgrade\.yml$/,
  /^apps\/desktop\/test\//,
  /^test\//,
  /^docs\//,
  /^\.cursor\/skills\/verify-mrstreamer\//,
];

export type Stage = "stable" | "a" | "b";

/** One installer, checked, with what vouches for it. */
export interface Package {
  readonly stage: Stage;
  readonly version: string;
  /** The commit it was built from, which Settings > About links to. */
  readonly source: string;
  /** The setup's file name, beside the receipt. */
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Where it came from and each check it passed, for the evidence. */
  readonly provenance: Record<string, unknown>;
}

export interface Receipt {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly resolvedAt: string;
  readonly pins: Pins;
  readonly packages: readonly [Package, Package, Package];
  readonly limits: readonly string[];
}

/** The files a check downloaded, with the receipt that names them. */
export interface Resolved {
  readonly receipt: Receipt;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

/** The read-only GitHub REST answers the check takes. Tests answer from fixtures. */
export interface GitHub {
  /** owner/name of the repository the workflow runs in. */
  readonly repository: string;
  /** GET `/repos/{repository}{path}` as JSON. */
  json(path: string): Promise<unknown>;
  /** GET `/repos/{repository}{path}` as text or bytes, following a redirect without the token. */
  text(path: string): Promise<string>;
  bytes(path: string, accept?: string): Promise<Uint8Array>;
}

const Sha = type(/^[0-9a-f]{40}$/);
const Asset = type({ id: "number", name: "string", size: "number", "digest?": "string | null" });
const Release = type({
  tag_name: "string",
  draft: "boolean",
  prerelease: "boolean",
  published_at: "string | null",
  assets: Asset.array(),
});
const Commit = type({ sha: Sha });
const Compare = type({
  status: "'ahead' | 'behind' | 'identical' | 'diverged'",
  ahead_by: "number",
  behind_by: "number",
  files: type({ filename: "string", "previous_filename?": "string" }).array(),
});
const Repo = type({ full_name: "string" });
const Run = type({
  id: "number",
  event: "string",
  status: "string",
  conclusion: "string | null",
  head_sha: Sha,
  head_branch: "string",
  workflow_id: "number",
  run_attempt: "number",
  run_number: "number",
  html_url: "string",
  repository: Repo,
  head_repository: Repo,
});
const Jobs = type({
  jobs: type({ id: "number", name: "string", conclusion: "string | null" }).array(),
});
const Pull = type({
  number: "number",
  state: "string",
  merged_at: "string | null",
  base: { ref: "string" },
  head: { ref: "string", repo: Repo.or("null") },
});
const LatestYml = type({
  version: "string",
  path: "string",
  sha512: "string",
  files: type({ url: "string", sha512: "string", size: "number" }).array(),
});

/** Throws with `message` unless `condition` holds: every check fails the whole resolution. */
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Refused: ${message}`);
}

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Checks the pins' form before anything is asked of GitHub. */
export function readPins(values: Record<string, string | undefined>): Pins {
  const aTag = values["a-tag"] ?? "";
  const version = parseVersion(aTag);
  check(aTag.startsWith("v") && version?.nightly, `A must be a nightly tag, not "${aTag}".`);
  const aSha = values["a-sha"] ?? "";
  const bSha = values["b-sha"] ?? "";
  for (const [name, sha] of [
    ["a-sha", aSha],
    ["b-sha", bSha],
  ])
    check(/^[0-9a-f]{40}$/.test(sha!), `${name} must be a full lowercase commit.`);
  const bRun = values["b-run"] ?? "";
  check(/^[1-9][0-9]*$/.test(bRun), `b-run must be a workflow run id, not "${bRun}".`);
  check(aSha !== bSha, "A and B must be different commits.");
  return { aTag, aSha, bRun: Number(bRun), bSha };
}

/**
 * Resolves and downloads the three installers, or throws on the first doubt. `stable` is the
 * published prior release, `now` the time artifacts must outlive.
 */
export async function resolvePackages(
  github: GitHub,
  pins: Pins,
  stable: StablePin = STABLE,
  now = Date.now(),
): Promise<Resolved> {
  const files = new Map<string, Uint8Array>();
  const defaultBranch = type({ default_branch: "string" }).assert(
    await github.json(""),
  ).default_branch;
  const commitOf = async (ref: string) =>
    Commit.assert(await github.json(`/commits/${encodeURIComponent(ref)}`)).sha;

  // Prior stable: a published release, its tag on its commit, its setup by checksum.
  const stableVersion = stable.tag.slice(1);
  const stableRelease = Release.assert(
    await github.json(`/releases/tags/${encodeURIComponent(stable.tag)}`),
  );
  check(
    !stableRelease.draft && !stableRelease.prerelease && stableRelease.published_at,
    `${stable.tag} is not a published stable release.`,
  );
  check((await commitOf(stable.tag)) === stable.source, `${stable.tag} moved off its commit.`);
  const stableName = setupName(stableVersion);
  const stableSetup = await asset(github, stableRelease.assets, stableName);
  check(sha256(stableSetup.bytes) === stable.sha256, `${stableName} is not the pinned file.`);
  files.set(`stable-${stableName}`, stableSetup.bytes);

  // A: a published nightly whose tag still names the pinned commit, on the default branch.
  const aVersion = pins.aTag.slice(1);
  const aRelease = Release.assert(
    await github.json(`/releases/tags/${encodeURIComponent(pins.aTag)}`),
  );
  check(aRelease.tag_name === pins.aTag, `GitHub answered ${aRelease.tag_name} for ${pins.aTag}.`);
  check(
    !aRelease.draft && aRelease.prerelease && aRelease.published_at,
    `${pins.aTag} is not a published nightly.`,
  );
  check((await commitOf(pins.aTag)) === pins.aSha, `${pins.aTag} does not name ${pins.aSha}.`);
  const onMain = Compare.assert(
    await github.json(`/compare/${pins.aSha}...${encodeURIComponent(defaultBranch)}?per_page=1`),
  );
  check(
    onMain.status === "ahead" || onMain.status === "identical",
    `${defaultBranch} does not contain A (${onMain.status}).`,
  );
  check(newer(aVersion, stableVersion), `A ${aVersion} is not newer than ${stableVersion}.`);
  const aName = setupName(aVersion);
  const aSetup = await asset(github, aRelease.assets, aName);
  const sums = new TextDecoder().decode(
    (await asset(github, aRelease.assets, "SHA256SUMS.txt")).bytes,
  );
  const listed = sums
    .split("\n")
    .map((line) => /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim()))
    .filter((match) => match?.[2] === aName);
  check(listed.length === 1, `SHA256SUMS.txt lists ${aName} ${listed.length} times.`);
  check(listed[0]![1] === sha256(aSetup.bytes), `${aName} does not match SHA256SUMS.txt.`);
  const aLatest = latest(
    (await asset(github, aRelease.assets, "latest.yml")).bytes,
    aVersion,
    aName,
    aSetup.bytes,
  );
  files.set(`a-${aName}`, aSetup.bytes);

  // B: one successful dry run of the Release workflow on a pull request of this repository.
  const run = Run.assert(await github.json(`/actions/runs/${pins.bRun}`));
  const releaseWorkflow = type({ id: "number" }).assert(
    await github.json("/actions/workflows/release.yml"),
  );
  check(run.id === pins.bRun, `GitHub answered run ${run.id} for ${pins.bRun}.`);
  check(
    run.repository.full_name === github.repository &&
      run.head_repository.full_name === github.repository,
    "B's run is not of this repository's own branch.",
  );
  check(run.workflow_id === releaseWorkflow.id, "B's run is not of the Release workflow.");
  check(run.event === "pull_request", `B's run came from ${run.event}, not a pull request.`);
  check(
    run.status === "completed" && run.conclusion === "success",
    `B's run is ${run.status}/${run.conclusion}.`,
  );
  check(run.head_sha === pins.bSha, `B's run is of ${run.head_sha}, not ${pins.bSha}.`);

  // Job conclusions still prove this was a successful dry run; receipt metadata replaces logs.
  const { jobs } = Jobs.assert(
    await github.json(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`),
  );
  const named = (name: RegExp) => jobs.filter((job) => name.test(job.name));
  const plans = named(/^Plan$/);
  check(plans.length === 1 && plans[0]!.conclusion === "success", "B's run has no single Plan.");
  const windows = named(/(^|\/ )Package win-x64$/);
  check(
    windows.length === 1 && windows[0]!.conclusion === "success",
    "B's Windows package job did not succeed once.",
  );
  const publishing = named(
    /(^|\/ )(Publish GitHub Release|Update feed|Microsoft Store|Record the stable version on main)( \/|$)/,
  );
  check(
    publishing.every((job) => job.conclusion === "skipped"),
    "B's run published something: it is no dry run.",
  );
  const artifacts = await packageArtifacts(github, run.id);
  const windowsArtifacts = artifacts.filter((each) => each.name.startsWith("release-win-x64-"));
  check(
    windowsArtifacts.length === 1,
    `B's run has ${windowsArtifacts.length} Windows artifacts, not one.`,
  );
  const artifact = windowsArtifacts[0]!;
  let bVersion = artifact.name.slice("release-win-x64-".length);
  const hasReceipts = artifacts.some((each) => each.name.startsWith("package-receipt-"));
  let legacyPlan: ReturnType<typeof planOutputs> | undefined;
  let packaged: Awaited<ReturnType<typeof resolvePackageReceipt>> | undefined;
  let pullNumber: number;
  if (hasReceipts) {
    // Referenced reusable workflows belong to this attempt, not whichever attempt was latest
    // when the run was first queried. Source, run head and workflow code remain separate pins.
    const attempt = Run.and({
      referenced_workflows: type({ path: "string", sha: Sha }).array(),
    }).assert(await github.json(`/actions/runs/${run.id}/attempts/${run.run_attempt}`));
    check(
      attempt.id === run.id &&
        attempt.run_attempt === run.run_attempt &&
        attempt.head_sha === run.head_sha &&
        attempt.workflow_id === run.workflow_id &&
        attempt.repository.full_name === github.repository &&
        attempt.head_repository.full_name === github.repository &&
        attempt.event === "pull_request" &&
        attempt.status === "completed" &&
        attempt.conclusion === "success",
      "B's selected attempt does not match the successful pinned run.",
    );
    const workflows = attempt.referenced_workflows.filter(
      (each) =>
        each.path.split("@")[0] === `${github.repository}/.github/workflows/build-release.yml`,
    );
    check(
      workflows.length === 1,
      "B's selected attempt has no single build-release.yml workflow identity.",
    );
    packaged = await resolvePackageReceipt(
      github,
      {
        sourceCommit: pins.bSha,
        workflowCommit: workflows[0]!.sha,
        appVersion: bVersion,
        packageVersion: bVersion,
        platform: "win-x64",
        distribution: "direct",
        run: { id: run.id, attempt: run.run_attempt, headCommit: run.head_sha },
      },
      artifacts,
      now,
    );
    const pulls = Pull.array().assert(
      await github.json(`/commits/${pins.bSha}/pulls?per_page=100`),
    );
    const matching = pulls.filter(
      (each) =>
        each.base.ref === defaultBranch &&
        each.head.repo?.full_name === github.repository &&
        each.head.ref === run.head_branch,
    );
    check(matching.length === 1, "B's commit has no single matching repository pull request.");
    pullNumber = matching[0]!.number;
  } else {
    // The last Release run observed before receipts were introduced. This never advances with
    // time or falls back from a missing current-attempt receipt, a broken JSON or a bad hash.
    check(
      run.id <= 38104229048 && run.run_number <= 296,
      "B's new run has no package receipt; legacy Plan logs are limited to historical runs through 296.",
    );
    legacyPlan = planOutputs(await github.text(`/actions/jobs/${plans[0]!.id}/logs`));
    check(
      legacyPlan.skip === "false" && legacyPlan.channel === "nightly",
      "B's Plan built no nightly.",
    );
    check(legacyPlan.sha === pins.bSha, `B's Plan built ${legacyPlan.sha}, not ${pins.bSha}.`);
    bVersion = legacyPlan.version;
    pullNumber = legacyPlan.pullRequest;
  }
  check(parseVersion(bVersion)?.nightly, `B's package named "${bVersion}", not a nightly version.`);
  check(newer(bVersion, aVersion), `B ${bVersion} is not newer than A ${aVersion}.`);
  check(artifact.name === `release-win-x64-${bVersion}`, `${artifact.name} is not B ${bVersion}.`);

  const pull = Pull.assert(await github.json(`/pulls/${pullNumber}`));
  check(
    pull.base.ref === defaultBranch && pull.head.repo?.full_name === github.repository,
    `Pull request #${pull.number} is not from this repository into ${defaultBranch}.`,
  );
  check(pull.head.ref === run.head_branch, `B's run is not of #${pull.number}'s branch.`);
  const pullCommits = type({ sha: Sha })
    .array()
    .assert(await github.json(`/pulls/${pull.number}/commits?per_page=100`));
  check(
    pullCommits.some((commit) => commit.sha === pins.bSha),
    `#${pull.number} does not hold ${pins.bSha}.`,
  );

  const diff = Compare.assert(await github.json(`/compare/${pins.aSha}...${pins.bSha}`));
  check(
    diff.status === "ahead" && diff.behind_by === 0 && diff.ahead_by > 0,
    `B does not descend from A (${diff.status}).`,
  );
  // GitHub lists at most 300 files: a longer list could hide one.
  check(diff.files.length < 300, "B changes too many files to check.");
  const outside = [
    ...new Set(
      diff.files.flatMap((file) => [file.filename, file.previous_filename ?? file.filename]),
    ),
  ].filter((path) => !VERIFICATION_ONLY.some((allowed) => allowed.test(path)));
  check(
    outside.length === 0,
    `B changes ${outside.length} besides verification files, such as ${outside.slice(0, 5).join(", ")}.`,
  );

  check(
    !artifact.expired && Date.parse(artifact.expires_at) > now,
    `${artifact.name} has expired.`,
  );
  check(
    artifact.workflow_run.id === run.id && artifact.workflow_run.head_sha === pins.bSha,
    `${artifact.name} belongs to another run.`,
  );
  // Legacy archives retain their historical optional digest policy. Receipts require a digest.
  const archive = packaged
    ? undefined
    : await github.bytes(`/actions/artifacts/${artifact.id}/zip`);
  const archiveSha256 = packaged?.archiveSha256 ?? sha256(archive!);
  if (artifact.digest)
    check(
      artifact.digest === `sha256:${archiveSha256}`,
      `${artifact.name} does not match its digest.`,
    );
  const entries = packaged ? Object.fromEntries(packaged.files) : unzipSync(archive!);
  const bName = setupName(bVersion);
  const installers = Object.keys(entries).filter((name) => /\.exe$/i.test(name));
  check(
    installers.length === 1 && installers[0] === bName,
    `${artifact.name} holds ${installers.join(", ") || "no setup"}, not ${bName} alone.`,
  );
  const bSetup = entries[bName]!;
  check(entries["latest.yml"], `${artifact.name} has no latest.yml.`);
  const bLatest = latest(entries["latest.yml"], bVersion, bName, bSetup);
  files.set(`b-${bName}`, bSetup);

  const receipt: Receipt = {
    schemaVersion: 1,
    repository: github.repository,
    resolvedAt: new Date(now).toISOString(),
    pins,
    packages: [
      {
        stage: "stable",
        version: stableVersion,
        source: stable.source,
        file: `stable-${stableName}`,
        sha256: stable.sha256,
        bytes: stableSetup.bytes.length,
        provenance: {
          tag: stable.tag,
          publishedAt: stableRelease.published_at,
          assetId: stableSetup.id,
          assetDigest: stableSetup.digest,
          checked: "Published stable release; tag on its commit; setup equals the pinned SHA-256.",
        },
      },
      {
        stage: "a",
        version: aVersion,
        source: pins.aSha,
        file: `a-${aName}`,
        sha256: sha256(aSetup.bytes),
        bytes: aSetup.bytes.length,
        provenance: {
          tag: pins.aTag,
          publishedAt: aRelease.published_at,
          assetId: aSetup.id,
          assetDigest: aSetup.digest,
          defaultBranch: `${defaultBranch} ${onMain.status} of A`,
          latestYml: aLatest,
          checked:
            "Published nightly; tag on the pinned commit; commit on the default branch; setup in SHA256SUMS.txt and latest.yml.",
        },
      },
      {
        stage: "b",
        version: bVersion,
        source: pins.bSha,
        file: `b-${bName}`,
        sha256: sha256(bSetup),
        bytes: bSetup.length,
        provenance: {
          run: run.id,
          runNumber: run.run_number,
          runAttempt: run.run_attempt,
          runUrl: run.html_url,
          pullRequest: { number: pull.number, state: pull.state, mergedAt: pull.merged_at },
          selection: packaged ? "package receipt v1" : "historical Plan log",
          packageReceipt: packaged?.receipt ?? null,
          receiptArtifactId: packaged?.receiptArtifact.id ?? null,
          plannedSha: packaged?.receipt.sourceCommit ?? legacyPlan!.sha,
          plannedVersion: bVersion,
          aheadOfA: diff.ahead_by,
          changedFiles: diff.files.map((file) => file.filename),
          artifact: {
            id: artifact.id,
            name: artifact.name,
            expiresAt: artifact.expires_at,
            digest: artifact.digest ?? null,
            archiveSha256,
          },
          latestYml: bLatest,
          checked:
            "Successful pull request dry run of the Release workflow; package receipt or bounded historical Plan built the pinned commit; publishing skipped; descends from A with verification files only; one Windows artifact matching its digest and latest.yml.",
        },
      },
    ],
    limits: [
      "B is a release dry run's artifact: no GitHub release or SHA256SUMS.txt covers it. Its digest, latest.yml and recomputed hash do.",
      ...(artifact.digest ? [] : [`${artifact.name} had no digest to compare.`]),
    ],
  };
  return { receipt, files };
}

/** The NSIS setup's name in every Windows release. */
function setupName(version: string): string {
  return `Mr-Streamer-${version}-win-x64-setup.exe`;
}

function newer(version: string, than: string): boolean {
  const [a, b] = [parseVersion(version), parseVersion(than)];
  return !!a && !!b && compareVersions(a, b) > 0;
}

/** Downloads the one asset named `name`, checking GitHub's digest of it when there is one. */
async function asset(
  github: GitHub,
  assets: readonly (typeof Asset.infer)[],
  name: string,
): Promise<{ id: number; digest: string | null; bytes: Uint8Array }> {
  const found = assets.filter((each) => each.name === name);
  check(found.length === 1, `The release has ${found.length} files named ${name}.`);
  const { id, size, digest } = found[0]!;
  const bytes = await github.bytes(`/releases/assets/${id}`, "application/octet-stream");
  check(bytes.length === size, `${name} is ${bytes.length} bytes, not ${size}.`);
  if (digest) check(digest === `sha256:${sha256(bytes)}`, `${name} does not match its digest.`);
  return { id, digest: digest ?? null, bytes };
}

/** Checks latest.yml names `version` and describes `setup` exactly, as the updater would. */
function latest(text: Uint8Array, version: string, name: string, setup: Uint8Array) {
  const yml = LatestYml.assert(parse(new TextDecoder().decode(text)));
  const sha512 = createHash("sha512").update(setup).digest("base64");
  check(yml.version === version, `latest.yml names ${yml.version}, not ${version}.`);
  check(yml.path === name && yml.sha512 === sha512, `latest.yml does not describe ${name}.`);
  check(
    yml.files.length === 1 &&
      yml.files[0]!.url === name &&
      yml.files[0]!.sha512 === sha512 &&
      yml.files[0]!.size === setup.length,
    `latest.yml's files do not describe ${name} alone.`,
  );
  return { version: yml.version, path: yml.path, sha512 };
}

/**
 * The outputs release-plan.ts printed in a Plan job's log, and the pull request whose label the
 * job took off. Each must appear once: two would be ambiguous.
 */
export function planOutputs(log: string) {
  const one = (pattern: RegExp, what: string) => {
    const found = [...log.matchAll(pattern)].map((match) => match[1]!);
    check(new Set(found).size === 1, `B's Plan log names ${found.length} ${what}.`);
    return found[0]!;
  };
  // Each log line starts with its time; outputs are printed as name=value.
  const output = (name: string) => one(new RegExp(`^\\S+ ${name}=(\\S+)\\r?$`, "gm"), name);
  return {
    skip: output("skip"),
    channel: output("channel"),
    version: output("version"),
    sha: output("sha"),
    pullRequest: Number(one(/issues\/(\d+)\/labels\/release%20dry%20run/g, "pull request")),
  };
}

/** GitHub's REST API with the workflow's read-only token. */
export function restGitHub(repository: string, token: string): GitHub {
  const api = `https://api.github.com/repos/${repository}`;
  const get = async (path: string, accept = "application/vnd.github+json") => {
    const headers = {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    let response = await fetch(`${api}${path}`, { headers, redirect: "manual" });
    // Logs, assets and artifacts redirect to storage, which gets no token.
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location)
      response = await fetch(location, { headers: { Accept: accept } });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}.`);
    return response;
  };
  return {
    repository,
    json: async (path) => (await get(path)).json(),
    text: async (path) => (await get(path)).text(),
    bytes: async (path, accept) => new Uint8Array(await (await get(path, accept)).arrayBuffer()),
  };
}
