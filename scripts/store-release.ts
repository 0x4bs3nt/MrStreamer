// The GitHub side of a Microsoft Store submission: whether the package a release run built carries
// the Store's identity, whether the Store jobs may run, which release it is for, and whether
// the package a release run kept is that release's. scripts/store-submission.ts is the Microsoft
// side; docs/maintainers/microsoft-store.md describes both.
//
//   node scripts/store-release.ts package --manifest <AppxManifest.xml> --dir <folder> --version <0.0.5> --sha <commit>
//   node scripts/store-release.ts gate --action <preflight|status|submit> --ref <ref> [--enabled <value>] [--release-run]
//   node scripts/store-release.ts release --version <0.0.5> --out <file> [--sha <commit>] [--run <id>] [--package]
//   node scripts/store-release.ts verify --release <file> --dir <folder> [--sha256 <checksum>]
//
// - package: the release run's MSIX job checks the manifest it unpacked from the package it built
//   against STORE_APP and STORE_NAME, and writes the record that travels with the package.
// - gate: submitting needs the repository variable STORE_AUTOMATION_ENABLED to be "true", and every
//   action needs the microsoft-store environment to exist for main alone. It runs before any job
//   names that environment, because GitHub creates a missing one, unprotected, for the first job
//   that does.
// - release: the version must be a published stable release whose tag is on main. With --package
//   it also names the release run whose artifact holds the package: the one given, or the newest
//   that still has it.
// - verify: the downloaded package must be that release's: its record, its checksum, and the
//   identity and version in its own manifest. It adds the package to the file release wrote, with
//   the name the manifest gives the app.
//
// Reads GitHub with gh, prints GitHub Actions outputs, and fails with the reason. The Store job
// runs it with plain node and installs no packages, so it imports only node: modules and
// dependency-free files, by relative path.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { packageVersion } from "../packages/contracts/src/package-version.ts";
import { formatVersion, parseVersion } from "../packages/contracts/src/version.ts";
import { readZipEntry } from "./zip.ts";

/**
 * The app in the Store, from Partner Center's Product identity page. Public, and never changes.
 * apps/desktop/electron-builder.yml writes the same values into the package, and the release run's
 * package check and the Store job hold every package to these.
 */
export const STORE_APP = {
  /** The Store ID, which the submission API takes as the application ID. */
  id: "9N45GG76ZP4T",
  identityName: "MrStreamerOSS.Mr.Streamer",
  publisher: "CN=A132E842-C4C9-40BF-83C4-D304E7952C2D",
  /** No period: Partner Center doesn't allow one here. */
  publisherDisplayName: "Mr Streamer OSS",
  /** Windows derives it from the identity name and publisher, and installs the package under it. */
  familyName: "MrStreamerOSS.Mr.Streamer_5yzg1erdm3xmr",
  /** Names the app inside the package. With the family name, the id Windows pins it by. */
  applicationId: "MrStreamer",
  architecture: "x64",
} as const;

/**
 * The name the Store lists the app under, one of those Partner Center reserved for it.
 * electron-builder writes it into the package, and a listing has to carry its package's name.
 * Packages built before it are named "Mr. Streamer", which stays reserved.
 */
export const STORE_NAME = "Mr. Streamer: IPTV Player";

/** The GitHub environment that holds the Store credential. */
export const STORE_ENVIRONMENT = "microsoft-store";

/** The workflow whose stable runs build the package. */
const RELEASE_WORKFLOW = ".github/workflows/release.yml";

const ACTIONS = ["preflight", "status", "submit"] as const;

/** What the Store job can do: the first two only read. */
export type StoreAction = (typeof ACTIONS)[number];

/** A release as GitHub lists it under its tag. */
export interface TaggedRelease {
  readonly draft: boolean;
  readonly prerelease: boolean;
  /** ISO time; null while unpublished. */
  readonly publishedAt: string | null;
  /** The release body, in Markdown. */
  readonly notes: string;
}

export interface WorkflowRun {
  /** The workflow file, such as .github/workflows/release.yml. */
  readonly path: string;
  readonly event: string;
  readonly branch: string | null;
  /** The repository whose code the run used: another one for a fork's pull request. */
  readonly headRepository: string | null;
}

export interface Artifact {
  /** The run that uploaded it. */
  readonly runId: number | null;
  readonly expired: boolean;
  /** ISO time. */
  readonly createdAt: string;
}

/** What these checks read from GitHub. The command line answers through gh, tests from fixtures. */
export interface GitHub {
  /** Such as owner/repo. */
  readonly repository: string;
  readonly defaultBranch: string;
  /** The release tagged `tag`, or null. A draft has no tag to find it by. */
  release(tag: string): Promise<TaggedRelease | null>;
  /** The commit a tag points at, through annotated tags. */
  commitOf(tag: string): Promise<string>;
  /** How `head` relates to `base`: "ahead" when head contains base and more. */
  compare(base: string, head: string): Promise<string>;
  run(id: number): Promise<WorkflowRun | null>;
  /** Every artifact called `name`, in any run. */
  artifacts(name: string): Promise<readonly Artifact[]>;
  /**
   * Who may use the environment `name`: "any" branch, the "protected" ones, or the branches and
   * tags it lists, a tag as "tag:name". Null when there is no such environment.
   */
  environment(name: string): Promise<"any" | "protected" | readonly string[] | null>;
}

/** A published stable release, as the Store scripts hand it on. */
export interface StoreRelease {
  /** The GitHub version, such as 0.0.5. */
  readonly version: string;
  readonly tag: string;
  /** The commit the tag points at, which the release was built from. */
  readonly commit: string;
  /** The package version the Store reads, such as 1.0.5.0. */
  readonly packageVersion: string;
  /** The release's notes on GitHub, in Markdown. */
  readonly notes: string;
  /** The release run whose artifact holds the package. Null when no package was asked for. */
  readonly run: number | null;
  /** The checked package, once `verify` has seen it. */
  readonly package?: StorePackage;
}

export interface StorePackage {
  /** The file on this machine. */
  readonly path: string;
  /**
   * The name it is uploaded under, which carries the release's commit and the file's checksum, so
   * a later run finds its own package among the Store's submissions.
   */
  readonly fileName: string;
  readonly sha256: string;
  /** The app's name in its manifest, which the Store's listings have to carry too. */
  readonly displayName: string;
}

/** The artifact a release run keeps the package in. */
export function artifactName(version: string): string {
  return `msix-${version}`;
}

/** The package's name in that artifact, as electron-builder writes it. */
function packageFile(version: string): string {
  return `Mr-Streamer-${version}-win-${STORE_APP.architecture}.msix`;
}

/** What the Store's name for any package of `release` starts with: its version and its commit. */
export function storeFilePrefix(release: Pick<StoreRelease, "version" | "commit">): string {
  return `${packageFile(release.version).replace(/\.msix$/, "")}.${release.commit.slice(0, 12)}.`;
}

/**
 * Whether publish.yml's Store gate may go on to the job that names the environment. Null when it may,
 * and otherwise why a release's own run leaves the Store alone, which is no failure. Throws when
 * the setup is wrong or someone asked by hand for what is turned off.
 */
export async function storeGate(
  github: GitHub,
  request: {
    readonly action: string;
    /** The repository variable STORE_AUTOMATION_ENABLED. */
    readonly enabled: string | undefined;
    /** The ref the run was started from. */
    readonly ref: string;
    /** Whether a release's own run is asking, rather than someone by hand. */
    readonly releaseRun: boolean;
  },
): Promise<string | null> {
  const action = ACTIONS.find((known) => known === request.action);
  if (!action) throw new Error(`"${request.action}" is not preflight, status or submit.`);
  if (action === "submit" && request.enabled !== "true") {
    const off = `Microsoft Store submissions are off: the repository variable STORE_AUTOMATION_ENABLED isn't "true".`;
    if (request.releaseRun) return off;
    throw new Error(`${off} docs/maintainers/microsoft-store.md#setting-up turns them on.`);
  }
  if (request.ref !== `refs/heads/${github.defaultBranch}`) {
    throw new Error(`Run the Store job from ${github.defaultBranch}, not ${request.ref}.`);
  }
  const branches = await github.environment(STORE_ENVIRONMENT);
  if (branches === null) {
    throw new Error(
      `The ${STORE_ENVIRONMENT} environment doesn't exist. scripts/setup-microsoft-store.sh creates it for ${github.defaultBranch} alone; a job that named it first would create it open to every branch.`,
    );
  }
  if (typeof branches === "string" || branches.join() !== github.defaultBranch) {
    const allowed =
      typeof branches === "string" ? `${branches} branches` : branches.join(", ") || "nothing";
    throw new Error(
      `The ${STORE_ENVIRONMENT} environment allows ${allowed}. It must allow ${github.defaultBranch} alone, or another branch's workflow could read the Store credential.`,
    );
  }
  return null;
}

/**
 * The published stable release `request.version` names. Throws unless it is one whose tag is on the
 * default branch and, when the run that built it says so, on `request.sha`. With `withPackage` it
 * also names the release run that holds the package: `request.run`, or the newest that still does.
 */
export async function storeRelease(
  github: GitHub,
  request: {
    readonly version: string;
    readonly sha?: string | undefined;
    readonly run?: number | undefined;
    readonly withPackage: boolean;
  },
): Promise<StoreRelease> {
  const parsed = parseVersion(request.version);
  if (!parsed || parsed.nightly || formatVersion(parsed) !== request.version) {
    throw new Error(
      `"${request.version}" is not a stable version such as 0.0.5. Only stable releases go to the Store.`,
    );
  }
  const tag = `v${request.version}`;
  const release = await github.release(tag);
  if (!release) throw new Error(`No published release is tagged ${tag}.`);
  if (release.draft || release.prerelease || !release.publishedAt) {
    throw new Error(
      `${tag} is a draft or a pre-release. Only a published stable release goes to the Store.`,
    );
  }
  const commit = await github.commitOf(tag);
  if (request.sha && request.sha !== commit) {
    throw new Error(`${tag} points at ${commit}, not at ${request.sha}, which this run built.`);
  }
  const history = await github.compare(commit, github.defaultBranch);
  if (history !== "ahead" && history !== "identical") {
    throw new Error(
      `${tag} points at ${commit}, which ${github.defaultBranch} does not contain (${history}).`,
    );
  }
  return {
    version: request.version,
    tag,
    commit,
    packageVersion: packageVersion(request.version),
    notes: release.notes,
    run: request.withPackage ? await packageRun(github, request.version, request.run) : null,
  };
}

/** The release run to take the package of `version` from: `given` when it is one, else the newest. */
async function packageRun(github: GitHub, version: string, given?: number): Promise<number> {
  if (given !== undefined) {
    const problem = releaseRunProblem(github, await github.run(given));
    if (problem)
      throw new Error(`Run ${given} ${problem}, so its package doesn't go to the Store.`);
    return given;
  }
  const name = artifactName(version);
  const kept = (await github.artifacts(name))
    .filter((artifact) => !artifact.expired)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const { runId } of kept) {
    if (runId !== null && !releaseRunProblem(github, await github.run(runId))) return runId;
  }
  throw new Error(
    kept.length === 0
      ? `No run holds the artifact ${name} any more: release runs keep it for 90 days. A later stable release brings a new package.`
      : `Only runs that aren't stable releases from ${github.defaultBranch} hold an artifact called ${name}.`,
  );
}

/**
 * Why `run` isn't a stable release run of this repository, or null when it is. Stable releases
 * are started by hand from the default branch, and only they build a package with a stable
 * version: a dry run's is a nightly's, from a pull request.
 */
function releaseRunProblem(github: GitHub, run: WorkflowRun | null): string | null {
  if (!run) return "doesn't exist";
  // GitHub adds the ref to the path of some runs.
  if (run.path.replace(/@.*$/, "") !== RELEASE_WORKFLOW) return `ran ${run.path}`;
  if (run.event !== "workflow_dispatch") return `was started by ${run.event}`;
  if (run.branch !== github.defaultBranch) return `ran on ${run.branch ?? "no branch"}`;
  if (run.headRepository !== github.repository) return "ran another repository's code";
  return null;
}

/** What a package's AppxManifest.xml says about the app; undefined where it says nothing. */
export interface PackageManifest {
  readonly identityName: string | undefined;
  readonly publisher: string | undefined;
  readonly architecture: string | undefined;
  readonly version: string | undefined;
  /** The package's name, which the Store's listings carry. */
  readonly displayName: string | undefined;
  readonly publisherDisplayName: string | undefined;
  readonly applicationId: string | undefined;
  /** The name of the app's Start entry. */
  readonly startName: string | undefined;
}

/** The fields of `xml`, a manifest as electron-builder's appx target writes it. */
export function readManifest(xml: string): PackageManifest {
  const element = (name: string) => new RegExp(`<${name}\\b[^>]*>`).exec(xml)?.[0] ?? "";
  // electron-builder writes the publisher in single quotes and the other attributes in double.
  const attribute = (from: string, name: string) =>
    new RegExp(`\\s${name}=(["'])(.*?)\\1`).exec(from)?.[2];
  const text = (name: string) => new RegExp(`<${name}>([^<]+)</${name}>`).exec(xml)?.[1];
  const identity = element("Identity");
  return {
    identityName: attribute(identity, "Name"),
    publisher: attribute(identity, "Publisher"),
    architecture: attribute(identity, "ProcessorArchitecture"),
    version: attribute(identity, "Version"),
    displayName: text("DisplayName"),
    publisherDisplayName: text("PublisherDisplayName"),
    applicationId: attribute(element("Application"), "Id"),
    startName: attribute(element("uap:VisualElements"), "DisplayName"),
  };
}

/** Throws unless `actual` is `wanted`, saying what `what` is instead. */
function differs(what: string, actual: unknown, wanted: string): void {
  if (actual !== wanted) throw new Error(`${what} is ${JSON.stringify(actual)}, not "${wanted}".`);
}

/**
 * `manifest`, once it carries the Store's identity and architecture and `packageVersion`. Throws
 * at the first that differs. The name is left to the caller: a package built before the Store
 * name carries the one before it, and the Store job may still send one of those.
 */
function checkIdentity(manifest: PackageManifest, packageVersion: string): PackageManifest {
  differs("The package's identity name", manifest.identityName, STORE_APP.identityName);
  differs("The package's publisher", manifest.publisher, STORE_APP.publisher);
  differs("The package's architecture", manifest.architecture, STORE_APP.architecture);
  differs("The package's version", manifest.version, packageVersion);
  return manifest;
}

/** What a release run records beside the Store package it built, and the Store job reads back. */
export interface PackageRecord {
  readonly version: string;
  readonly packageVersion: string;
  readonly commit: string;
  readonly sha256: string;
}

/**
 * The record of the package `msix` a release run built for `version` from `commit`, once its
 * manifest, `xml`, carries everything Partner Center reserved: the identity, the publisher's
 * name, the application id, the Store name for the package and its Start entry, x64, and the
 * release's Store version. Throws at the first that differs.
 */
export function packageRecord(
  xml: string,
  msix: Buffer,
  request: { readonly version: string; readonly commit: string },
): PackageRecord {
  const version = packageVersion(request.version);
  const manifest = checkIdentity(readManifest(xml), version);
  differs("The publisher's name", manifest.publisherDisplayName, STORE_APP.publisherDisplayName);
  differs("The application id", manifest.applicationId, STORE_APP.applicationId);
  differs("The package's name", manifest.displayName, STORE_NAME);
  differs("The Start entry's name", manifest.startName, STORE_NAME);
  return {
    version: request.version,
    packageVersion: version,
    commit: request.commit,
    sha256: createHash("sha256").update(msix).digest("hex"),
  };
}

/**
 * The package in `dir`, the release run's downloaded artifact, once it is shown to be `release`'s:
 * the record beside it names the release, its commit and its checksum, the file has that checksum
 * and `expected` when the job that built it reported one, and its manifest carries the Store's
 * identity and the release's package version. Throws at the first that differs. The app's name is
 * read, not checked: a package built before the Store name carries the one before it.
 */
export function verifyPackage(
  release: StoreRelease,
  dir: string,
  expected?: string | undefined,
): StorePackage {
  const path = join(dir, packageFile(release.version));
  if (!existsSync(path)) throw new Error(`The artifact holds no ${packageFile(release.version)}.`);
  const bytes = readFileSync(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expected !== undefined) differs("The checksum the build job reported", expected, sha256);

  if (!existsSync(`${path}.json`)) throw new Error("The artifact holds no record of the package.");
  // Records written by PowerShell, before packageRecord wrote them, may start with a byte order mark.
  const record: unknown = JSON.parse(readFileSync(`${path}.json`, "utf8").replace(/^\uFEFF/, ""));
  const recorded = isRecord(record) ? record : {};
  differs("The record's release", recorded["version"], release.version);
  differs("The record's commit", recorded["commit"], release.commit);
  differs("The record's package version", recorded["packageVersion"], release.packageVersion);
  differs("The record's checksum", recorded["sha256"], sha256);

  const xml = readZipEntry(bytes, "AppxManifest.xml")?.toString("utf8");
  if (!xml) throw new Error("The package has no manifest with an identity.");
  const { displayName } = checkIdentity(readManifest(xml), release.packageVersion);
  if (!displayName) throw new Error("The package's manifest names no app.");

  return {
    path,
    fileName: `${storeFilePrefix(release)}${sha256.slice(0, 16)}.msix`,
    sha256,
    displayName,
  };
}

/** Whether `value` is a JSON object, whose fields are still to be checked. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The release file `release` wrote, with the package once `verify` added it. */
export function readStoreRelease(path: string): StoreRelease {
  const file: unknown = JSON.parse(readFileSync(path, "utf8"));
  const text = (from: unknown, key: string) => {
    const value = isRecord(from) ? from[key] : undefined;
    if (typeof value !== "string") throw new Error(`${path} names no ${key}.`);
    return value;
  };
  const checked = isRecord(file) ? file["package"] : undefined;
  const run = isRecord(file) ? file["run"] : undefined;
  return {
    version: text(file, "version"),
    tag: text(file, "tag"),
    commit: text(file, "commit"),
    packageVersion: text(file, "packageVersion"),
    notes: text(file, "notes"),
    run: typeof run === "number" ? run : null,
    ...(checked !== undefined && {
      package: {
        path: text(checked, "path"),
        fileName: text(checked, "fileName"),
        sha256: text(checked, "sha256"),
        displayName: text(checked, "displayName"),
      },
    }),
  };
}

/** The repository the workflow runs in, read through gh. */
function github(): GitHub {
  const repository = process.env["GITHUB_REPOSITORY"] ?? "";
  if (!repository) throw new Error("GITHUB_REPOSITORY doesn't name the repository.");
  const api = (path: string, jq: string, paginate = false) =>
    execFileSync(
      "gh",
      ["api", ...(paginate ? ["--paginate"] : []), `repos/${repository}${path}`, "--jq", jq],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  /** `read`'s answer, or null when GitHub has nothing at that address. */
  const found = <Value>(read: () => Value): Value | null => {
    try {
      return read();
    } catch (error) {
      const missing =
        error instanceof Error && "stderr" in error && String(error.stderr).includes("HTTP 404");
      if (missing) return null;
      throw error;
    }
  };
  return {
    repository,
    defaultBranch: api("", ".default_branch"),
    async release(tag) {
      return found((): TaggedRelease =>
        JSON.parse(
          api(
            `/releases/tags/${encodeURIComponent(tag)}`,
            '{draft, prerelease, publishedAt: .published_at, notes: (.body // "")}',
          ),
        ),
      );
    },
    async commitOf(tag) {
      return api(`/commits/${encodeURIComponent(tag)}`, ".sha");
    },
    async compare(base, head) {
      return api(
        `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`,
        ".status",
      );
    },
    async run(id) {
      return found((): WorkflowRun =>
        JSON.parse(
          api(
            `/actions/runs/${id}`,
            "{path, event, branch: .head_branch, headRepository: .head_repository.full_name}",
          ),
        ),
      );
    },
    async artifacts(name) {
      return api(
        `/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
        ".artifacts[] | {runId: .workflow_run.id, expired, createdAt: .created_at} | @json",
        true,
      )
        .split("\n")
        .filter(Boolean)
        .map((line): Artifact => JSON.parse(line));
    },
    async environment(name) {
      const policy = found(() =>
        api(
          `/environments/${name}`,
          '.deployment_branch_policy | if . == null then "any" elif .protected_branches then "protected" else "listed" end',
        ),
      );
      if (policy === null) return null;
      if (policy === "any" || policy === "protected") return policy;
      return api(
        `/environments/${name}/deployment-branch-policies?per_page=100`,
        '.branch_policies[] | if .type == "tag" then "tag:" + .name else .name end',
        true,
      )
        .split("\n")
        .filter(Boolean);
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

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      action: { type: "string" },
      ref: { type: "string" },
      enabled: { type: "string" },
      "release-run": { type: "boolean", default: false },
      version: { type: "string" },
      sha: { type: "string" },
      run: { type: "string" },
      package: { type: "boolean", default: false },
      out: { type: "string" },
      release: { type: "string" },
      dir: { type: "string" },
      sha256: { type: "string" },
      manifest: { type: "string" },
    },
  });
  const [command] = positionals;

  switch (command) {
    case "gate": {
      const off = await storeGate(github(), {
        action: values.action ?? "",
        enabled: values.enabled,
        ref: values.ref ?? "",
        releaseRun: values["release-run"],
      });
      if (off) {
        console.log(`::notice::${off} Nothing was sent to the Store.`);
        summary(
          `### Microsoft Store: not submitted\n${off} \`docs/maintainers/microsoft-store.md\` lists what to set up first, and how to submit the release's package by hand.`,
        );
      }
      output({ ready: String(off === null) });
      return;
    }
    case "release": {
      if (!values.out) throw new Error("Name the file to write with --out.");
      const release = await storeRelease(github(), {
        version: values.version ?? "",
        sha: values.sha || undefined,
        run: values.run ? Number(values.run) : undefined,
        withPackage: values.package,
      });
      writeFileSync(values.out, `${JSON.stringify(release, null, 2)}\n`);
      console.log(
        `${release.tag} is a published stable release of ${release.commit}, package ${release.packageVersion}.`,
      );
      output({ "run-id": release.run === null ? "" : String(release.run) });
      return;
    }
    case "package": {
      if (!values.manifest || !values.dir || !values.version || !values.sha) {
        throw new Error("Give --manifest, --dir, --version and --sha.");
      }
      const path = join(values.dir, packageFile(values.version));
      const record = packageRecord(readFileSync(values.manifest, "utf8"), readFileSync(path), {
        version: values.version,
        commit: values.sha,
      });
      writeFileSync(`${path}.json`, `${JSON.stringify(record, null, 2)}\n`);
      output({
        sha256: record.sha256,
        "package-version": record.packageVersion,
        "identity-name": STORE_APP.identityName,
        "family-name": STORE_APP.familyName,
      });
      summary(
        `Mr. Streamer ${record.version} is package ${record.packageVersion}, named "${STORE_NAME}", built from ${record.commit}. SHA-256 ${record.sha256}.`,
      );
      return;
    }
    case "verify": {
      if (!values.release || !values.dir) throw new Error("Give --release and --dir.");
      if (values.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(values.sha256)) {
        throw new Error("The build job reported no checksum for the package.");
      }
      const release = readStoreRelease(values.release);
      const checked = verifyPackage(release, values.dir, values.sha256);
      writeFileSync(
        values.release,
        `${JSON.stringify({ ...release, package: checked }, null, 2)}\n`,
      );
      const record = `The package of ${release.version} is ${release.packageVersion}, named "${checked.displayName}", built from ${release.commit} in run ${release.run}, SHA-256 ${checked.sha256}. The Store knows it as ${checked.fileName}.`;
      console.log(record);
      summary(record);
      return;
    }
    default:
      throw new Error(`Unknown command "${command}". Use package, gate, release or verify.`);
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
