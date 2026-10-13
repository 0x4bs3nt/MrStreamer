// Plans releases for the release workflow: whether a run is a dry run, the commit it builds, its
// version and tag, and whether a scheduled nightly is due. Right before publishing it checks the
// release is complete and still new, and after publishing it writes the update feed the app reads.
// docs/maintainers/releasing.md describes the policy.
//
//   node scripts/release-plan.ts plan --event <event> --ref <ref> --sha <commit> --run <number>
//       [--channel nightly|stable] [--nightly <tested nightly>] [--version 0.1.0] [--dry-run]
//   node scripts/release-plan.ts check --version <version> --dir <folder> --sources <names>   right before publishing
//   node scripts/release-plan.ts notes --tag <tag> --sha <commit> [--previous-tag <tag>]
//   node scripts/release-plan.ts record --version <version>  after a stable release, on main
//   node scripts/release-plan.ts feed --out <file> [--current <url>] [--allow-regress]
//
// Versions: the app's package.json (apps/desktop/package.json) on main holds the newest stable
// release (0.0.0 before the first). Nightlies preview the next patch, 0.0.2-nightly.20261002.14,
// counting from that package.json or the
// newest stable release, whichever is newer, so a stable release that main has not recorded yet
// never makes later nightlies sort below it. A stable release rebuilds the commit of the tested
// nightly it is given, as the version that nightly previewed unless another is given. The nightly
// must sort above the newest stable release and strictly descend from its commit, the rule
// packages/contracts/src/promotion.ts holds for the plan and the upgrade check alike. When main
// has commits no published nightly holds, the stable run publishes a nightly of main first, so
// Nightly users have every change before Stable users get any of it.
//
// Reads GitHub with gh, prints the plan as GitHub Actions outputs, and fails with the reason when
// a release is refused. Release jobs run it with plain node before installing packages, so it
// imports only node: modules and dependency-free files, by relative path rather than package name.
import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  channelOf,
  compareVersions,
  formatVersion,
  parseVersion,
  type Channel,
  type Version,
} from "../packages/contracts/src/version.ts";
import { promotionProblem } from "../packages/contracts/src/promotion.ts";
import { releaseFiles } from "../packages/contracts/src/release-files.ts";
import {
  buildFeed,
  mergeFeeds,
  readFeed,
  type GitHubRelease,
  type UpdateFeed,
} from "../packages/contracts/src/update-feed.ts";

/** The app's manifest, whose version records the newest stable release. */
const MANIFEST = "apps/desktop/package.json";

/**
 * A scheduled nightly waits at least this long after the previous one: five hours, so the check
 * every six hours finds a nightly that took an hour to publish due, and nightlies come about
 * every six hours.
 */
export const NIGHTLY_INTERVAL_MS = 5 * 60 * 60 * 1000;

const HISTORIES = ["ahead", "behind", "identical", "diverged"] as const;

/** How a head commit relates to a base, as GitHub's compare API reports it. */
export type History = (typeof HISTORIES)[number];

/** A pull request merged into the default branch. */
export interface PullRequest {
  readonly number: number;
  readonly title: string;
  /** The author's login. */
  readonly author: string;
  readonly url: string;
}

/** What a plan reads from GitHub. The command line answers through gh, tests from fixtures. */
export interface Repository {
  /** The repository's page, such as https://github.com/owner/repo. */
  readonly url: string;
  readonly defaultBranch: string;
  /** Every release, drafts included. */
  readonly releases: readonly GitHubRelease[];
  /** Every tag, with or without a release. */
  readonly tags: readonly string[];
  /** How `head` relates to `base`: "ahead" when head contains base and more. */
  compare(base: string, head: string): Promise<History>;
  /** The commit a tag points at, through annotated tags. */
  commitOf(tag: string): Promise<string>;
  /**
   * The commits `head` has and `base` doesn't, oldest first. With no `base`, every commit up to
   * and including `head`.
   */
  commits(base: string | null, head: string): Promise<readonly string[]>;
  /** The pull requests merged into the default branch that brought `commit` in. */
  pullRequestsOf(commit: string): Promise<readonly PullRequest[]>;
}

export interface Plan {
  readonly channel: Channel;
  readonly version: string;
  readonly tag: string;
  /** The commit every job of the run checks out. */
  readonly sha: string;
  /**
   * Notes list the changes since this release of the same channel: the previous stable release
   * for a stable one, the previous nightly for a nightly. Null for a channel's first release.
   */
  readonly previousTag: string | null;
}

export interface Skip {
  readonly skip: string;
  /** Set when skipping needs a maintainer's attention. */
  readonly warning: boolean;
}

export interface NightlyRequest {
  /** The ref the run was started from. */
  readonly ref: string;
  readonly sha: string;
  /** The workflow run number, unique per workflow. */
  readonly run: number;
  readonly now: number;
  /** The version in package.json at `sha`. */
  readonly recorded: string;
  /** Scheduled runs build only when a nightly is due. */
  readonly scheduled: boolean;
  /** Dry runs build any branch and publish nothing. */
  readonly dryRun: boolean;
}

/** `sha`, `run`, `now` and `recorded` plan the nightly a stable run may publish first. */
export interface StableRequest extends Omit<NightlyRequest, "scheduled" | "dryRun"> {
  /**
   * Replaces the version the nightly previewed; the commit stays the nightly's. Required when the
   * newest stable release already has or passed that version.
   */
  readonly version?: string | undefined;
  /** The tested nightly to promote, by version or tag. Required. */
  readonly nightly: string;
}

export interface StablePlan extends Plan {
  /**
   * A nightly of main's commit to publish before the stable release, when main has commits no
   * published nightly holds. Null when the latest nightly already has main's commit.
   */
  readonly nightlyFirst: Plan | null;
}

/** What started a release run, as the plan job hands it over. */
export interface RunRequest extends Omit<NightlyRequest, "scheduled" | "dryRun"> {
  /** The event that started the run: schedule, workflow_dispatch or pull_request. */
  readonly event: string;
  /** Started by hand: nightly or stable. */
  readonly channel?: string | undefined;
  /** Started by hand: the stable version, as StableRequest takes it. */
  readonly version?: string | undefined;
  /** Started by hand: the tested nightly a stable release promotes. */
  readonly nightly?: string | undefined;
  /** Started by hand as a dry run. */
  readonly dryRun: boolean;
}

/** A run's plan, and whether it is a dry run, which builds and tests and publishes nothing. */
export interface RunPlan {
  readonly dryRun: boolean;
  readonly plan: Plan | StablePlan | Skip;
  /** The tag of the tested nightly a stable release promotes, which its upgrade check installs. */
  readonly promoted: string | null;
}

/**
 * Plans a run of the release workflow from what started it. A pull request event is always a dry
 * run of its head, whatever else it says: only the "release dry run" label starts one, and a fork's
 * code never gets past that. A run by hand is a dry run when asked, and otherwise a nightly or a
 * stable release; the schedule asks for a nightly only when one is due.
 */
export async function planRun(repo: Repository, request: RunRequest): Promise<RunPlan> {
  const nightly = { ...request, scheduled: false, dryRun: false };
  switch (request.event) {
    case "pull_request":
      return dryRun(await planNightly(repo, { ...nightly, dryRun: true }));
    case "schedule":
      return published(await planNightly(repo, { ...nightly, scheduled: true }));
    case "workflow_dispatch":
      if (request.dryRun) {
        if (request.channel === "stable") {
          throw new Error(
            "A dry run builds the branch as a nightly. Leave the channel at nightly.",
          );
        }
        return dryRun(await planNightly(repo, { ...nightly, dryRun: true }));
      }
      if (request.channel === "stable") {
        const plan = await planStable(repo, { ...request, nightly: request.nightly ?? "" });
        return { dryRun: false, plan, promoted: tagOf(parseVersion(request.nightly ?? "")!) };
      }
      return published(await planNightly(repo, nightly));
    default:
      throw new Error(`A release run doesn't start on ${request.event}.`);
  }
}

const dryRun = (plan: Plan | Skip): RunPlan => ({ dryRun: true, plan, promoted: null });
const published = (plan: Plan | Skip): RunPlan => ({ dryRun: false, plan, promoted: null });

export async function planNightly(repo: Repository, request: NightlyRequest): Promise<Plan | Skip> {
  if (!request.dryRun) assertDefaultBranch(repo, request.ref, "nightly");
  if (request.scheduled) {
    const skip = await nightlySkip(repo, request.sha, request.now);
    if (skip) return skip;
  }
  return nextNightly(repo, request);
}

/** The next nightly of `sha`: the patch after the newest stable release, today, this run. */
function nextNightly(
  repo: Repository,
  request: Pick<NightlyRequest, "sha" | "run" | "now" | "recorded">,
): Plan {
  const known = releasedVersions(repo);
  const recorded = parseVersion(request.recorded);
  if (!recorded || recorded.nightly) {
    throw new Error(
      `package.json holds "${request.recorded}", not a stable version such as 0.1.0.`,
    );
  }
  const base = [recorded, ...known.filter((version) => !version.nightly)]
    .sort(compareVersions)
    .at(-1)!;
  const version: Version = {
    ...base,
    patch: base.patch + 1,
    nightly: { date: utcDate(request.now), run: request.run },
  };
  assertUnreleased(known, version);
  return {
    channel: "nightly",
    version: formatVersion(version),
    tag: tagOf(version),
    sha: request.sha,
    previousTag: latestNightly(repo.releases)?.tag ?? null,
  };
}

export async function planStable(repo: Repository, request: StableRequest): Promise<StablePlan> {
  assertDefaultBranch(repo, request.ref, "stable");
  if (!request.nightly) {
    throw new Error(
      "Enter the nightly you tested, such as 0.0.2-nightly.20260930.30. A stable release promotes only a tested nightly.",
    );
  }
  const nightly = pinnedNightly(repo.releases, request.nightly);
  const previewed = parseVersion(nightly.tag)!;
  const sha = await repo.commitOf(nightly.tag);
  const history = await repo.compare(sha, repo.defaultBranch);
  if (history !== "ahead" && history !== "identical") {
    throw new Error(
      `${nightly.tag} was built from ${sha}, which ${repo.defaultBranch} does not contain (${history}).`,
    );
  }

  const previousStable = repo.releases
    .filter((release) => !release.draft && !release.prerelease)
    .flatMap((release) => {
      const parsed = parseVersion(release.tag);
      return parsed && !parsed.nightly ? [parsed] : [];
    })
    .sort(compareVersions)
    .at(-1);
  // The upgrade check installs the newest stable release and upgrades it to this nightly, so the
  // plan holds the nightly to the same rule before any release work starts.
  if (previousStable) {
    const stableTag = tagOf(previousStable);
    const problem = promotionProblem(
      { tag: nightly.tag, version: previewed },
      { tag: stableTag, version: previousStable },
      await repo.compare(stableTag, nightly.tag),
    );
    if (problem) throw new Error(problem);
  }

  const version = request.version ? parseVersion(request.version) : { ...previewed, nightly: null };
  if (!version || version.nightly) {
    throw new Error(`"${request.version}" is not a stable version such as 0.1.0.`);
  }
  if (compareVersions(version, previewed) <= 0) {
    throw new Error(
      `${formatVersion(version)} would sort before ${nightly.tag}, the nightly it promotes.`,
    );
  }
  assertUnreleased(releasedVersions(repo), version);
  const nightlyFirst = await nightlyBefore(repo, request);
  if (nightlyFirst && compareVersions(parseVersion(nightlyFirst.version)!, version) >= 0) {
    throw new Error(
      `${nightlyFirst.tag}, the nightly of ${repo.defaultBranch} to publish first, would sort after ${tagOf(version)}.`,
    );
  }
  return {
    channel: "stable",
    version: formatVersion(version),
    tag: tagOf(version),
    sha,
    previousTag: previousStable ? tagOf(previousStable) : null,
    nightlyFirst,
  };
}

/**
 * The nightly a stable run publishes before the stable release, or null when the latest published
 * nightly holds `request.sha` already. Like a nightly started by hand, it skips the five hours.
 */
async function nightlyBefore(repo: Repository, request: StableRequest): Promise<Plan | null> {
  const last = latestNightly(repo.releases);
  if (last) {
    const history = await repo.compare(last.tag, request.sha);
    if (history === "identical" || history === "behind") return null;
  }
  return nextNightly(repo, request);
}

/**
 * Throws unless `version` is still unused and sorts after every release it competes with: a
 * stable release after every stable release, a nightly after every release. Runs again right
 * before publishing, in case a release appeared in the meantime. Drafts don't count: users never
 * see them and they have no tag.
 */
export function checkUnreleased(repo: Repository, version: string): void {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`"${version}" is not a release version.`);
  assertUnreleased(releasedVersions(repo), parsed);
}

/**
 * Throws unless `present`, the files about to be attached to the release of `version`, holds every
 * platform's installers and update metadata and every source archive the sources job prepared.
 * Each package job checked its own files already; this catches one lost on the way to publishing.
 */
export function checkFiles(
  version: string,
  present: readonly string[],
  sources: readonly string[],
): void {
  if (sources.length === 0) throw new Error("The sources job named no source archives.");
  const missing = [...releaseFiles(version), ...sources].filter((name) => !present.includes(name));
  if (missing.length > 0) throw new Error(`The release of ${version} lacks ${missing.join(", ")}.`);
}

/**
 * The notes of a release: every pull request merged from the previous release of its channel up
 * to the commit it builds, once each, oldest first. A channel's first release lists everything up
 * to its commit. Pull requests merged after that commit are left out, even once main has them.
 */
export async function releaseNotes(
  repo: Repository,
  plan: Pick<Plan, "tag" | "sha" | "previousTag">,
): Promise<string> {
  const commits = await repo.commits(plan.previousTag, plan.sha);
  const pulls = (await Promise.all(commits.map((commit) => repo.pullRequestsOf(commit)))).flat();
  const listed = new Map(pulls.map((pull) => [pull.number, pull]));
  const changes = [...listed.values()].map(
    (pull) => `* ${pull.title} by @${pull.author} in ${pull.url}`,
  );
  const changelog = plan.previousTag
    ? `${repo.url}/compare/${plan.previousTag}...${plan.tag}`
    : `${repo.url}/commits/${plan.tag}`;
  return [
    ...(changes.length > 0 ? ["## What's Changed", ...changes, ""] : []),
    `**Full Changelog**: ${changelog}`,
  ].join("\n");
}

/** The version main records after `released` is published, or null when it already has it or a newer one. */
export function recordedVersion(current: string, released: string): string | null {
  const now = parseVersion(current);
  const next = parseVersion(released);
  if (!next || next.nightly) throw new Error(`"${released}" is not a stable version.`);
  return now && compareVersions(now, next) >= 0 ? null : formatVersion(next);
}

/** Drafts and pre-releases without a nightly version aren't published nightlies. */
function isPublishedNightly(release: GitHubRelease): boolean {
  return (
    !release.draft &&
    release.prerelease &&
    release.publishedAt !== null &&
    Boolean(parseVersion(release.tag)?.nightly)
  );
}

/** The newest published nightly. */
function latestNightly(releases: readonly GitHubRelease[]): GitHubRelease | undefined {
  return releases
    .filter(isPublishedNightly)
    .sort((a, b) => Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!))[0];
}

/** The published nightly `text` names, by version or tag, such as 0.0.2-nightly.20260930.30. */
function pinnedNightly(releases: readonly GitHubRelease[], text: string): GitHubRelease {
  const version = parseVersion(text);
  if (!version?.nightly) {
    throw new Error(`"${text}" is not a nightly version, such as 0.0.2-nightly.20260930.30.`);
  }
  const tag = tagOf(version);
  const named = releases.filter((release) => release.tag === tag);
  const nightly = named.find(isPublishedNightly);
  if (nightly) return nightly;
  throw new Error(
    named.length === 0
      ? `No release is tagged ${tag}.`
      : `${tag} is not a published nightly: it is a draft or not a pre-release.`,
  );
}

/** Why a scheduled nightly should not build `sha` now, or null when it should. */
async function nightlySkip(repo: Repository, sha: string, now: number): Promise<Skip | null> {
  const last = latestNightly(repo.releases);
  if (!last) return null;
  if (now - Date.parse(last.publishedAt!) < NIGHTLY_INTERVAL_MS) {
    return { skip: `${last.tag} was published less than five hours ago.`, warning: false };
  }
  switch (await repo.compare(last.tag, sha)) {
    case "ahead":
      return null;
    case "identical":
      return { skip: `Nothing new since ${last.tag}.`, warning: false };
    case "behind":
      return { skip: `${sha} is older than ${last.tag}.`, warning: false };
    case "diverged":
      return {
        skip: `${repo.defaultBranch} no longer contains ${last.tag}. Start a nightly by hand to continue from ${repo.defaultBranch}.`,
        warning: true,
      };
  }
}

function assertDefaultBranch(repo: Repository, ref: string, channel: Channel): void {
  if (ref !== `refs/heads/${repo.defaultBranch}`) {
    throw new Error(
      `Start ${channel} releases from ${repo.defaultBranch}, not ${ref}. Label a pull request "release dry run" to try a branch.`,
    );
  }
}

/** Versions of every tag and published release. */
function releasedVersions(repo: Repository): Version[] {
  const published = repo.releases.filter((release) => !release.draft).map((release) => release.tag);
  return [...new Set([...repo.tags, ...published])].flatMap((tag) => {
    const parsed = parseVersion(tag);
    return parsed ? [parsed] : [];
  });
}

function assertUnreleased(known: readonly Version[], version: Version): void {
  if (known.some((other) => compareVersions(other, version) === 0)) {
    throw new Error(`${tagOf(version)} already exists.`);
  }
  const rivals = version.nightly ? known : known.filter((other) => channelOf(other) === "stable");
  const newest = rivals.toSorted(compareVersions).at(-1);
  if (newest && compareVersions(version, newest) < 0) {
    throw new Error(
      `${formatVersion(version)} would sort before ${formatVersion(newest)}, which is already released.`,
    );
  }
}

function tagOf(version: Version): string {
  return `v${formatVersion(version)}`;
}

function utcDate(time: number): number {
  return Number(new Date(time).toISOString().slice(0, 10).replaceAll("-", ""));
}

/** The repository the workflow runs in, read through gh. */
function githubRepository(): Repository {
  const name = process.env["GITHUB_REPOSITORY"] ?? "{owner}/{repo}";
  const api = (path: string, jq: string, paginate = false) =>
    execFileSync(
      "gh",
      ["api", ...(paginate ? ["--paginate"] : []), `repos/${name}${path}`, "--jq", jq],
      { encoding: "utf8" },
    ).trim();
  const lines = (text: string) => text.split("\n").filter(Boolean);

  // One release a line, as JSON: notes span lines.
  const releases = lines(
    api(
      "/releases?per_page=100",
      '.[] | {tag: .tag_name, draft, prerelease, publishedAt: .published_at, page: .html_url, notes: (.body // ""), assets: [.assets[].name]} | @json',
      true,
    ),
  ).map((line): GitHubRelease => JSON.parse(line));
  const [defaultBranch = "", url = ""] = api("", "[.default_branch, .html_url] | @tsv").split("\t");
  return {
    url,
    defaultBranch,
    releases,
    tags: lines(api("/tags?per_page=100", ".[].name", true)),
    async compare(base, head) {
      const status = api(
        `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`,
        ".status",
      );
      const history = HISTORIES.find((known) => known === status);
      if (!history) throw new Error(`GitHub compared ${base} and ${head} as "${status}".`);
      return history;
    },
    async commitOf(tag) {
      return api(`/commits/${encodeURIComponent(tag)}`, ".sha");
    },
    async commits(base, head) {
      if (base === null) {
        return lines(
          api(`/commits?sha=${encodeURIComponent(head)}&per_page=100`, ".[].sha", true),
        ).reverse();
      }
      return lines(
        api(
          `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100`,
          ".commits[].sha",
          true,
        ),
      );
    },
    async pullRequestsOf(commit) {
      const merged = `.[] | select(.merged_at != null and .base.ref == "${defaultBranch}") | [.number, .user.login, .html_url, .title] | @tsv`;
      return lines(api(`/commits/${commit}/pulls`, merged)).map((line): PullRequest => {
        const [number = "", author = "", url = "", title = ""] = line.split("\t");
        return { number: Number(number), title, author, url };
      });
    },
  };
}

function output(values: Record<string, string>): void {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  console.log(lines.join("\n"));
  const file = process.env["GITHUB_OUTPUT"];
  if (file) appendFileSync(file, `${lines.join("\n")}\n`);
}

function summary(markdown: string): void {
  const file = process.env["GITHUB_STEP_SUMMARY"];
  if (file) appendFileSync(file, `${markdown}\n`);
}

/**
 * Prints the run's plan as outputs; a stable plan's nightly to publish first goes in the first-*
 * ones, and the nightly it promotes in promoted.
 */
function outputPlan({ dryRun, plan, promoted }: RunPlan): void {
  if ("skip" in plan) {
    console.log(`${plan.warning ? "::warning::" : ""}${plan.skip}`);
    summary(`No nightly: ${plan.skip}`);
    output({ skip: "true", "dry-run": String(dryRun) });
    return;
  }
  const first = "nightlyFirst" in plan ? plan.nightlyFirst : null;
  summary(
    `${dryRun ? "Dry run, publishing nothing: " : ""}${first ? `Nightly ${first.version} from \`${first.sha}\` first, then ` : ""}${plan.channel === "stable" ? "Stable" : "Nightly"} ${plan.version} from \`${plan.sha}\``,
  );
  output({
    skip: "false",
    "dry-run": String(dryRun),
    promoted: promoted ?? "",
    channel: plan.channel,
    version: plan.version,
    tag: plan.tag,
    sha: plan.sha,
    "previous-tag": plan.previousTag ?? "",
    ...(first && {
      "first-version": first.version,
      "first-tag": first.tag,
      "first-sha": first.sha,
      "first-previous-tag": first.previousTag ?? "",
    }),
  });
}

/**
 * Logs what a scheduled nightly and a stable release of the latest nightly would do right now, for
 * dry runs.
 */
async function reportChannels(
  repo: Repository,
  request: Omit<NightlyRequest, "scheduled" | "dryRun">,
): Promise<void> {
  const ref = `refs/heads/${repo.defaultBranch}`;
  const describe = (plan: Plan | StablePlan | Skip) => {
    if ("skip" in plan) return `skips. ${plan.skip}`;
    const first = "nightlyFirst" in plan ? plan.nightlyFirst : null;
    return `${first ? `publishes ${first.version} from ${first.sha} first, then ` : ""}builds ${plan.version} from ${plan.sha}.`;
  };
  const refused = (error: unknown) =>
    `is refused. ${error instanceof Error ? error.message : String(error)}`;
  const sha = await repo.commitOf(repo.defaultBranch);
  const nightly = await planNightly(repo, {
    ...request,
    ref,
    sha,
    scheduled: true,
    dryRun: false,
  }).then(describe, refused);
  const stable = await planStable(repo, {
    ...request,
    ref,
    sha,
    nightly: latestNightly(repo.releases)?.tag ?? "",
  }).then(describe, refused);
  console.log(
    `A scheduled nightly now ${nightly}\nA stable release of the latest nightly now ${stable}`,
  );
}

/**
 * The feed deployed at `url`, or null when there is none yet: no address, as before Pages is
 * enabled, or a 404. Any other answer, or none, throws: without the deployed feed, a stale list of
 * releases could take a channel back.
 */
export async function deployedFeed(url: string | undefined): Promise<UpdateFeed | null> {
  if (!url) {
    console.log("No deployed feed given: the releases alone decide.");
    return null;
  }
  // Pages' cache can serve a copy up to ten minutes old; a query it hasn't seen reads the latest.
  const latest = new URL(url);
  latest.searchParams.set("at", String(Date.now()));
  const response = await fetch(latest, { signal: AbortSignal.timeout(20_000) }).catch(
    (error: unknown) => {
      throw new Error(
        `${url} is unreachable, so the deployed feed can't be compared. Run this again. ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );
  if (response.status === 404) {
    console.log(`Nothing is deployed at ${url} yet: the releases alone decide.`);
    return null;
  }
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}.`);
  try {
    return readFeed(await response.json());
  } catch (error) {
    throw new Error(
      `${url} holds no feed this script can read. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** One line per channel: the release the feed names, and what it replaced or kept. */
function describeFeed(current: UpdateFeed | null, listed: UpdateFeed, feed: UpdateFeed): string[] {
  return (["stable", "nightly"] as const).map((channel) => {
    const label = channel === "stable" ? "Stable" : "Nightly";
    const named = feed[channel]?.version ?? "none";
    const released = listed[channel]?.version ?? "none";
    const was = current && (current[channel]?.version ?? "none");
    if (named !== released) {
      return `${label}: ${named}, kept from the deployed feed over ${released} from the releases`;
    }
    return was && was !== named ? `${label}: ${named}, was ${was}` : `${label}: ${named}`;
  });
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      ref: { type: "string" },
      sha: { type: "string" },
      run: { type: "string" },
      version: { type: "string" },
      tag: { type: "string" },
      "previous-tag": { type: "string" },
      nightly: { type: "string" },
      current: { type: "string" },
      out: { type: "string" },
      dir: { type: "string" },
      sources: { type: "string" },
      event: { type: "string" },
      channel: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "allow-regress": { type: "boolean", default: false },
    },
  });
  const [command] = positionals;
  const ref = values.ref ?? "";
  // What planning a nightly needs; a stable run may publish one first.
  const nightlyOf = () => ({
    ref,
    sha: values.sha ?? "",
    run: Number(values.run),
    now: Date.now(),
    recorded: String(JSON.parse(readFileSync(MANIFEST, "utf8")).version),
  });

  switch (command) {
    case "plan": {
      const repo = githubRepository();
      const request: RunRequest = {
        ...nightlyOf(),
        event: values.event ?? "",
        channel: values.channel || undefined,
        version: values.version || undefined,
        nightly: values.nightly || undefined,
        dryRun: values["dry-run"],
      };
      const planned = await planRun(repo, request);
      outputPlan(planned);
      if (planned.dryRun) await reportChannels(repo, request);
      return;
    }
    case "check": {
      if (!values.dir) throw new Error("Name the folder of the release's files with --dir.");
      const version = values.version ?? "";
      const sources = values.sources?.split(/\s+/).filter(Boolean) ?? [];
      checkFiles(version, readdirSync(values.dir), sources);
      checkUnreleased(githubRepository(), version);
      console.log(
        `${version} is still new, and the release has every platform's files and source.`,
      );
      return;
    }
    case "notes":
      console.log(
        await releaseNotes(githubRepository(), {
          tag: values.tag ?? "",
          sha: values.sha ?? "",
          previousTag: values["previous-tag"] || null,
        }),
      );
      return;
    case "record": {
      const manifest: Record<string, unknown> = JSON.parse(readFileSync(MANIFEST, "utf8"));
      const next = recordedVersion(String(manifest.version), values.version ?? "");
      if (next) {
        writeFileSync(MANIFEST, `${JSON.stringify({ ...manifest, version: next }, null, 2)}\n`);
      }
      console.log(
        next
          ? `${MANIFEST} now records ${next}.`
          : `${MANIFEST} already records ${manifest.version}.`,
      );
      return;
    }
    case "feed": {
      if (!values.out) throw new Error("Name the file to write with --out.");
      const repo = githubRepository();
      const current = await deployedFeed(values.current);
      const listed = buildFeed(repo.url, repo.releases, new Date().toISOString());
      const feed = mergeFeeds(current, listed, { allowRegress: values["allow-regress"] });
      writeFileSync(values.out, `${JSON.stringify(feed, null, 2)}\n`);
      const lines = describeFeed(current, listed, feed);
      console.log(lines.join("\n"));
      summary(lines.map((line) => `- ${line}`).join("\n"));
      return;
    }
    default:
      throw new Error(`Unknown command "${command}". Use plan, check, notes, record or feed.`);
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
