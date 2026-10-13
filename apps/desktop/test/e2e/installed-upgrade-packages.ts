// The two Windows installers the installed upgrade check runs, one over the other, and why each is
// the build it claims to be. The person or release run supplies one input, the candidate nightly's
// tag. Everything else is derived from GitHub and checked, and any doubt stops the check before
// anything is installed:
//
// - stable: the newest published stable release by version. Drafts, prereleases and nightlies
//   never count.
// - candidate: the published nightly the tag names.
//
// Both commits come from their tags and must be on main, the candidate must descend from stable
// with a higher version, and each setup must match its asset size and digest, its release's
// SHA256SUMS.txt and its latest.yml exactly. `resolvePackages` writes nothing; `readReceipt`
// re-checks the receipt it produced before the runner installs anything.
import { createHash } from "node:crypto";
import { type } from "arktype";
import { parse } from "yaml";
import {
  compareVersions,
  formatVersion,
  parseVersion,
  type Version,
} from "../../../../packages/contracts/src/version.ts";
import {
  promotionProblem,
  type Ancestry as History,
} from "../../../../packages/contracts/src/promotion.ts";

const ANCESTRIES: readonly History[] = ["ahead", "identical", "behind", "diverged"];

/** The read-only GitHub REST answers the check takes. Tests answer from fixtures. */
export interface GitHub {
  /** owner/name of the repository the workflow runs in. */
  readonly repository: string;
  /** GET `/repos/{repository}{path}` as JSON. */
  json(path: string): Promise<unknown>;
  /** GET `/repos/{repository}{path}` as bytes, following a redirect without the token. */
  bytes(path: string, accept?: string): Promise<Uint8Array>;
}

const FullSha = type(/^[0-9a-f]{40}$/);
const Digest = type(/^[0-9a-f]{64}$/);
const Resolved = type({
  stableTag: "string",
  stableSha: FullSha,
  candidateTag: "string",
  candidateSha: FullSha,
  "+": "reject",
});
/** The tags and the commits they named when the check resolved them. */
export type Resolved = typeof Resolved.infer;
const Package = type({
  stage: "'stable' | 'candidate'",
  version: "string",
  source: FullSha,
  file: "string",
  sha256: Digest,
  bytes: "number.integer > 0",
  provenance: {
    tag: "string",
    releaseKind: "'stable' | 'nightly'",
    publishedAt: "string",
    assetId: "number.integer > 0",
    assetDigest: "string | null",
    metadata: {
      sha256sums: Digest,
      latestYml: Digest,
      sha512: "string",
    },
  },
});
/** One checked installer, with what vouches for it. */
export type Package = typeof Package.infer;
const Receipt = type({
  repository: "string",
  resolvedAt: "string",
  resolved: Resolved,
  packages: [Package, Package],
  defaultBranch: "'main'",
  candidateAheadBy: "number.integer > 0",
  limits: "string[]",
});
/** receipt.json beside the downloaded setups: what `run` installs, in order. */
export type Receipt = typeof Receipt.infer;

const Asset = type({
  id: "number.integer > 0",
  name: "string",
  size: "number.integer > 0",
  "digest?": "string | null",
});
const Release = type({
  tag_name: "string",
  draft: "boolean",
  prerelease: "boolean",
  published_at: "string | null",
  assets: Asset.array(),
});
const Listed = type({
  tag_name: "string",
  draft: "boolean",
  prerelease: "boolean",
  published_at: "string | null",
});
const Ancestry = type({
  status: "string",
  ahead_by: "number.integer",
  behind_by: "number.integer",
});
const LatestYml = type({
  version: "string",
  path: "string",
  sha512: "string",
  files: type({ url: "string", sha512: "string", size: "number.integer > 0" }).array(),
});

/** Throws with `message` unless `condition` holds: every check fails the whole resolution. */
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Refused: ${message}`);
}

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The NSIS setup's name in every Windows release. */
const setupName = (version: string) => `Mr-Streamer-${version}-win-x64-setup.exe`;

/** The version a canonical `v`-prefixed release tag of `kind` names, or undefined. */
function tagVersion(tag: string, kind: Package["provenance"]["releaseKind"]): Version | undefined {
  const version = parseVersion(tag);
  return tag.startsWith("v") &&
    version &&
    !!version.nightly === (kind === "nightly") &&
    formatVersion(version) === tag.slice(1)
    ? version
    : undefined;
}

/**
 * Checks a stable and candidate pair's form: canonical tags of the right kinds, a strictly higher
 * candidate version and two different commits. Resolution and `readReceipt` both apply it.
 */
function checkPair(pair: Resolved): Resolved {
  Resolved.assert(pair);
  const stable = tagVersion(pair.stableTag, "stable");
  const candidate = tagVersion(pair.candidateTag, "nightly");
  check(stable, `${pair.stableTag} is not a canonical stable tag.`);
  check(candidate, `${pair.candidateTag} is not a canonical nightly tag.`);
  check(
    compareVersions(candidate, stable) > 0,
    `The candidate ${pair.candidateTag} is not newer than stable ${pair.stableTag}.`,
  );
  check(
    pair.stableSha !== pair.candidateSha,
    "The candidate must strictly descend from stable, with a different source commit.",
  );
  return pair;
}

/**
 * The tag of the newest published stable release by version, from every page of the release
 * list. Drafts, prereleases, unpublished entries and tags that are not canonical stable versions
 * never count. Refuses when there is none.
 */
async function newestStable(github: GitHub): Promise<string> {
  let newest: { tag: string; version: Version } | undefined;
  for (let page = 1; ; page++) {
    const releases = Listed.array().assert(
      await github.json(`/releases?per_page=100&page=${page}`),
    );
    for (const release of releases) {
      const version = tagVersion(release.tag_name, "stable");
      if (release.draft || release.prerelease || !release.published_at || !version) continue;
      if (!newest || compareVersions(version, newest.version) > 0)
        newest = { tag: release.tag_name, version };
    }
    if (releases.length < 100) break;
  }
  check(newest, "There is no published stable release to upgrade from.");
  return newest.tag;
}

/**
 * Resolves and downloads the newest published stable and the candidate nightly `candidate.tag`, or
 * throws on the first doubt. The tag's form is checked before GitHub is asked anything. With
 * `candidate.sha`, the commit a stable release run planned to promote, the tag must name exactly
 * that commit, so the check proves the source the release builds; without it, as when dispatched
 * alone, the tag's commit is taken. `now` stamps the receipt.
 */
export async function resolvePackages(
  github: GitHub,
  candidate: { readonly tag: string; readonly sha?: string | undefined },
  now = Date.now(),
) {
  const candidateTag = candidate.tag;
  check(tagVersion(candidateTag, "nightly"), `${candidateTag} is not a canonical nightly tag.`);
  if (candidate.sha !== undefined)
    check(FullSha.allows(candidate.sha), `${candidate.sha} is not a full commit SHA.`);
  const branch = type({ default_branch: "string" }).assert(await github.json("")).default_branch;
  check(branch === "main", "The installed upgrade check requires this repository's main branch.");
  const stableTag = await newestStable(github);
  const commitOf = async (tag: string) =>
    type({ sha: FullSha }).assert(await github.json(`/commits/${encodeURIComponent(tag)}`)).sha;
  const candidateSha = await commitOf(candidateTag);
  check(
    candidate.sha === undefined || candidateSha === candidate.sha,
    `${candidateTag} names ${candidateSha}, not ${candidate.sha}, the commit the release planned.`,
  );
  const stableSha = await commitOf(stableTag);
  for (const source of [stableSha, candidateSha]) {
    const onMain = Ancestry.assert(await github.json(`/compare/${source}...main?per_page=1`));
    check(
      (onMain.status === "ahead" || onMain.status === "identical") && onMain.behind_by === 0,
      `main does not contain ${source}.`,
    );
  }
  const diff = Ancestry.assert(
    await github.json(`/compare/${stableSha}...${candidateSha}?per_page=1`),
  );
  // The release plan's own rule for which nightly a stable release may promote.
  const ancestry = ANCESTRIES.find((known) => known === diff.status);
  check(ancestry, `GitHub compared ${stableTag} and ${candidateTag} as "${diff.status}".`);
  const problem = promotionProblem(
    { tag: candidateTag, version: tagVersion(candidateTag, "nightly")! },
    { tag: stableTag, version: tagVersion(stableTag, "stable")! },
    ancestry,
  );
  check(!problem, problem ?? "");
  check(
    diff.ahead_by > 0 && diff.behind_by === 0,
    "The candidate does not strictly descend from stable.",
  );
  const resolved = checkPair({ stableTag, stableSha, candidateTag, candidateSha });

  const files = new Map<string, Uint8Array>();
  const resolve = async (stage: Package["stage"], tag: string, source: string) => {
    const kind = stage === "stable" ? "stable" : "nightly";
    const version = tag.slice(1);
    const release = Release.assert(await github.json(`/releases/tags/${encodeURIComponent(tag)}`));
    check(
      release.tag_name === tag &&
        !release.draft &&
        release.prerelease === (kind === "nightly") &&
        release.published_at &&
        Number.isFinite(Date.parse(release.published_at)),
      `${tag} is not a published ${kind === "stable" ? "stable release" : "nightly"}.`,
    );
    /** Downloads the one asset named `name`, checking its size and GitHub's digest of it. */
    const asset = async (name: string) => {
      const found = release.assets.filter((each) => each.name === name);
      check(found.length === 1, `${tag} has no single ${name}.`);
      const item = found[0]!;
      const bytes = await github.bytes(`/releases/assets/${item.id}`, "application/octet-stream");
      check(bytes.length === item.size, `${name} does not match its asset size.`);
      if (item.digest)
        check(
          item.digest === `sha256:${sha256(bytes)}`,
          `${name} does not match its asset digest.`,
        );
      return { item, bytes };
    };
    const name = setupName(version);
    const setup = await asset(name);
    const sums = await asset("SHA256SUMS.txt");
    const metadata = await asset("latest.yml");
    const matches = new TextDecoder()
      .decode(sums.bytes)
      .split("\n")
      .map((line) => /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim()))
      .filter((match) => match?.[2] === name);
    const hash = sha256(setup.bytes);
    check(
      matches.length === 1 && matches[0]![1] === hash,
      `${name} does not match a single SHA256SUMS.txt entry.`,
    );
    // latest.yml must describe the setup exactly, as the updater would read it.
    const latest = LatestYml.assert(parse(new TextDecoder().decode(metadata.bytes)));
    const sha512 = createHash("sha512").update(setup.bytes).digest("base64");
    check(
      latest.version === version &&
        latest.path === name &&
        latest.sha512 === sha512 &&
        latest.files.length === 1 &&
        latest.files[0]!.url === name &&
        latest.files[0]!.sha512 === sha512 &&
        latest.files[0]!.size === setup.bytes.length,
      `latest.yml does not describe ${name}, its version, SHA-512 and size exactly.`,
    );
    const file = `${stage}-${name}`;
    files.set(file, setup.bytes);
    return Package.assert({
      stage,
      version,
      source,
      file,
      sha256: hash,
      bytes: setup.bytes.length,
      provenance: {
        tag,
        releaseKind: kind,
        publishedAt: release.published_at,
        assetId: setup.item.id,
        assetDigest: setup.item.digest ?? null,
        metadata: { sha256sums: sha256(sums.bytes), latestYml: sha256(metadata.bytes), sha512 },
      },
    });
  };
  const receipt: Receipt = {
    repository: github.repository,
    resolvedAt: new Date(now).toISOString(),
    resolved,
    packages: [
      await resolve("stable", resolved.stableTag, resolved.stableSha),
      await resolve("candidate", resolved.candidateTag, resolved.candidateSha),
    ],
    defaultBranch: "main",
    candidateAheadBy: diff.ahead_by,
    limits: [
      "Published tags, SHA256SUMS.txt and latest.yml bind each setup. Package receipts are not read.",
      "The last phase restarts the same candidate. It does not prove a second version upgrade.",
    ],
  };
  return { receipt, files };
}

/** Refuses a receipt of another shape or with inconsistent identities before anything installs. */
export function readReceipt(value: unknown): Receipt {
  const receipt = Receipt.assert(value);
  const pair = checkPair(receipt.resolved);
  for (const [index, stage, tag, source] of [
    [0, "stable", pair.stableTag, pair.stableSha],
    [1, "candidate", pair.candidateTag, pair.candidateSha],
  ] as const) {
    const pkg = receipt.packages[index];
    check(
      pkg.stage === stage &&
        pkg.version === tag.slice(1) &&
        pkg.source === source &&
        pkg.file === `${stage}-${setupName(pkg.version)}` &&
        pkg.provenance.tag === tag &&
        pkg.provenance.releaseKind === (stage === "stable" ? "stable" : "nightly"),
      "The receipt's package identity does not match its resolved tags.",
    );
  }
  return receipt;
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
    // Assets redirect to storage, which gets no token.
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location)
      response = await fetch(location, { headers: { Accept: accept } });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}.`);
    return response;
  };
  return {
    repository,
    json: async (path) => (await get(path)).json(),
    bytes: async (path, accept) => new Uint8Array(await (await get(path, accept)).arrayBuffer()),
  };
}
