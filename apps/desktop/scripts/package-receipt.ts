// Successful package jobs write this contract after native verification and artifact upload.
// A receipt identifies bytes and their build, but never replaces installed acceptance.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import { unzipSync } from "fflate";
import { PLATFORMS, platformFiles } from "@mrstreamer/contracts/release-files";
import { packageVersion } from "./msix-version.ts";

const Sha = type(/^[0-9a-f]{40}$/);
const Hash = type(/^[0-9a-f]{64}$/);
const Id = type("number.integer > 0").narrow(Number.isSafeInteger);
const FileName = type(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const AppVersion = type(/^\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/);
const Target = type.enumerated(...PLATFORMS);
const Distribution = type("'direct' | 'store'");

const Identity = type({
  repository: type(/^[\w.-]+\/[\w.-]+$/),
  sourceCommit: Sha,
  workflowCommit: Sha,
  appVersion: AppVersion,
  packageVersion: "string",
  platform: Target,
  distribution: Distribution,
  run: { id: Id, attempt: Id, headCommit: Sha },
  artifact: { id: Id, name: FileName, sha256: Hash },
});
const Schema = Identity.and({
  schemaVersion: "1",
  status: "'success'",
  files: type({ name: FileName, bytes: Id, sha256: Hash }).array(),
});
export type PackageReceipt = typeof Schema.infer;
export type PackageIdentity = typeof Identity.infer;
export type PackageRequest = Pick<
  PackageIdentity,
  | "sourceCommit"
  | "workflowCommit"
  | "appVersion"
  | "packageVersion"
  | "platform"
  | "distribution"
  | "run"
>;

export const Artifact = type({
  id: Id,
  name: "string",
  expired: "boolean",
  expires_at: "string",
  "digest?": "string | null",
  workflow_run: { id: Id, head_sha: Sha },
});

export interface PackageGitHub {
  readonly repository: string;
  json(path: string): Promise<unknown>;
  bytes(path: string): Promise<Uint8Array>;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Package receipt: ${message}`);
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactName(identity: Pick<PackageIdentity, "platform" | "distribution" | "appVersion">) {
  return identity.distribution === "store"
    ? `msix-${identity.appVersion}`
    : `release-${identity.platform}-${identity.appVersion}`;
}

function receiptName(
  identity: Pick<PackageIdentity, "platform" | "distribution" | "appVersion" | "run">,
) {
  return `package-receipt-${identity.platform}-${identity.distribution}-${identity.appVersion}-attempt-${identity.run.attempt}`;
}

/** The complete uploaded file set, including updater metadata and Store verification records. */
function requiredFiles(
  identity: Pick<PackageIdentity, "platform" | "distribution" | "appVersion">,
) {
  if (identity.distribution === "direct")
    return platformFiles(identity.appVersion, identity.platform);
  const base = `Mr-Streamer-${identity.appVersion}-${identity.platform}`;
  return [`${base}.msix`, `${base}.msix.json`, `${base}.wack.xml`];
}

/** Validate downloaded JSON before trusting any field, including the success marker. */
function readReceipt(value: unknown): PackageReceipt {
  const receipt = Schema.assert(value);
  check(
    receipt.distribution !== "store" || receipt.platform === "win-x64",
    "Store requires win-x64.",
  );
  check(
    receipt.distribution === "store"
      ? receipt.packageVersion === packageVersion(receipt.appVersion)
      : receipt.packageVersion === receipt.appVersion,
    "packageVersion does not match the distribution.",
  );
  check(receipt.artifact.name === artifactName(receipt), "artifact name does not match the build.");
  const expected = requiredFiles(receipt).sort();
  const names = receipt.files.map((file) => file.name).sort();
  check(
    JSON.stringify(names) === JSON.stringify(expected),
    `expected exactly ${expected.join(", ")}.`,
  );
  return receipt;
}

/** Produces a receipt only for a complete package set after the workflow's checks succeeded. */
export function producePackageReceipt(
  identity: PackageIdentity,
  files: ReadonlyMap<string, Uint8Array>,
): PackageReceipt {
  Identity.assert(identity);
  return readReceipt({
    ...identity,
    schemaVersion: 1,
    status: "success",
    files: [...files].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: hash(bytes) })),
  });
}

/** Lists every artifact without mistaking a truncated response for a missing receipt. */
export async function packageArtifacts(github: PackageGitHub, runId: number) {
  const all: (typeof Artifact.infer)[] = [];
  for (let page = 1; page <= 10; page++) {
    const result = type({ total_count: "number.integer >= 0", artifacts: Artifact.array() }).assert(
      await github.json(`/actions/runs/${runId}/artifacts?per_page=100&page=${page}`),
    );
    all.push(...result.artifacts);
    if (all.length === result.total_count) return all;
    check(
      result.artifacts.length > 0 && all.length < result.total_count,
      "incomplete artifact listing.",
    );
  }
  throw new Error("Package receipt: run has too many artifacts to check.");
}

async function download(
  github: PackageGitHub,
  artifact: typeof Artifact.infer,
  request: PackageRequest,
  now: number,
) {
  check(
    !artifact.expired && Date.parse(artifact.expires_at) > now,
    `${artifact.name} has expired.`,
  );
  check(
    artifact.workflow_run.id === request.run.id &&
      artifact.workflow_run.head_sha === request.run.headCommit,
    `${artifact.name} belongs to another run or head commit.`,
  );
  check(
    /^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? ""),
    `${artifact.name} has no SHA-256 digest.`,
  );
  const archive = await github.bytes(`/actions/artifacts/${artifact.id}/zip`);
  check(
    artifact.digest === `sha256:${hash(archive)}`,
    `${artifact.name} does not match its digest.`,
  );
  const names = new Set<string>();
  const entries = unzipSync(archive, {
    filter: (file) => {
      check(!names.has(file.name), `${artifact.name} repeats ${file.name}.`);
      names.add(file.name);
      return true;
    },
  });
  return { archive, files: new Map(Object.entries(entries)) };
}

/** Resolves one exact successful receipt and verifies its package artifact and every file's bytes. */
export async function resolvePackageReceipt(
  github: PackageGitHub,
  request: PackageRequest,
  artifacts: readonly (typeof Artifact.infer)[],
  now = Date.now(),
) {
  const named = artifacts.filter((artifact) => artifact.name === receiptName(request));
  check(named.length === 1, `expected one ${receiptName(request)}, found ${named.length}.`);
  const receiptArtifact = named[0]!;
  const downloaded = await download(github, receiptArtifact, request, now);
  check(
    downloaded.files.size === 1 && downloaded.files.has("package-receipt.json"),
    `${receiptArtifact.name} must hold package-receipt.json alone.`,
  );
  const receipt = readReceipt(
    JSON.parse(new TextDecoder().decode(downloaded.files.get("package-receipt.json")!)),
  );
  check(receipt.repository === github.repository, "repository does not match the request.");
  for (const key of [
    "sourceCommit",
    "workflowCommit",
    "appVersion",
    "packageVersion",
    "platform",
    "distribution",
  ] as const)
    check(receipt[key] === request[key], `${key} is ${receipt[key]}, expected ${request[key]}.`);
  for (const key of ["id", "attempt", "headCommit"] as const)
    check(receipt.run[key] === request.run[key], `run.${key} does not match the request.`);
  const packages = artifacts.filter((artifact) => artifact.name === artifactName(request));
  check(packages.length === 1, `expected one ${artifactName(request)}, found ${packages.length}.`);
  const artifact = packages[0]!;
  check(receipt.artifact.id === artifact.id, "package artifact id does not match GitHub.");
  check(
    artifact.digest === `sha256:${receipt.artifact.sha256}`,
    "package artifact digest does not match the receipt.",
  );
  const packaged = await download(github, artifact, request, now);
  check(
    packaged.files.size === receipt.files.length,
    "package artifact has missing or additional files.",
  );
  for (const file of receipt.files) {
    const bytes = packaged.files.get(file.name);
    check(bytes, `package artifact is missing ${file.name}.`);
    check(bytes.length === file.bytes, `${file.name} byte count does not match the receipt.`);
    check(hash(bytes) === file.sha256, `${file.name} SHA-256 does not match the receipt.`);
  }
  return {
    receipt,
    receiptArtifact,
    artifact,
    archiveSha256: hash(packaged.archive),
    files: packaged.files,
  };
}

// Workflow-only CLI, run by .github/actions/package-receipt from the release's own commit, the one
// that names and builds these files. It runs after native verification and the successful
// package upload.
if (import.meta.main) {
  const env = process.env;
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  check(sourceCommit === env["PACKAGE_SOURCE"], "checkout is not the planned source commit.");
  const app = type({ version: AppVersion }).assert(
    JSON.parse(await readFile("package.json", "utf8")),
  );
  check(app.version === env["PACKAGE_APP_VERSION"], "package.json is not the planned app version.");
  const identity = Identity.assert({
    repository: env["GITHUB_REPOSITORY"],
    sourceCommit,
    workflowCommit: env["PACKAGE_WORKFLOW_COMMIT"],
    appVersion: app.version,
    packageVersion: env["PACKAGE_VERSION"],
    platform: env["PACKAGE_PLATFORM"],
    distribution: env["PACKAGE_DISTRIBUTION"],
    run: {
      id: Number(env["GITHUB_RUN_ID"]),
      attempt: Number(env["GITHUB_RUN_ATTEMPT"]),
      headCommit: env["PACKAGE_RUN_HEAD"],
    },
    artifact: {
      id: Number(env["PACKAGE_ARTIFACT_ID"]),
      name: env["PACKAGE_ARTIFACT_NAME"],
      sha256: env["PACKAGE_ARTIFACT_SHA256"],
    },
  });
  const expected = requiredFiles(identity);
  // Match the upload action's extensions so an extra installer fails before a success receipt.
  const uploaded = (await readdir("dist")).filter((file) =>
    identity.distribution === "store"
      ? /\.(?:msix|msix\.json|wack\.xml)$/.test(file)
      : /\.(?:dmg|zip|exe|AppImage|deb|blockmap)$/.test(file) || /^latest.*\.yml$/.test(file),
  );
  check(
    JSON.stringify(uploaded.sort()) === JSON.stringify(expected.sort()),
    "dist does not hold the exact uploaded package set.",
  );
  const files = new Map(
    await Promise.all(
      expected.map(async (name) => [name, await readFile(join("dist", name))] as const),
    ),
  );
  if (identity.distribution === "store") {
    const record = type({
      version: "string",
      packageVersion: "string",
      commit: Sha,
      sha256: Hash,
    }).assert(
      JSON.parse(
        new TextDecoder().decode(files.get(expected.find((name) => name.endsWith(".msix.json"))!)!),
      ),
    );
    check(
      record.version === identity.appVersion &&
        record.packageVersion === identity.packageVersion &&
        record.commit === identity.sourceCommit,
      "MSIX verification record does not match the build.",
    );
    check(
      record.sha256 === hash(files.get(expected.find((name) => name.endsWith(".msix"))!)!),
      "MSIX verification record does not match the bytes.",
    );
  }
  const receipt = producePackageReceipt(identity, files);
  await writeFile("package-receipt.json", `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
}
