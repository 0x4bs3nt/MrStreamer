// Read-only release preparation. Publication and installed acceptance belong to the runbooks.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type } from "arktype";
import { platformFiles, releaseFiles } from "@mrstreamer/contracts/release-files";
import { compareVersions, formatVersion, parseVersion } from "@mrstreamer/contracts/version";
import { releaseSources } from "./licences.ts";
import { packageArtifacts, resolvePackageReceipt, type PackageRequest } from "./package-receipt.ts";
import { restGitHub, type GitHub } from "../test/e2e/installed-upgrade-packages.ts";

const REPOSITORY = "Mr-Streamer-OSS/MrStreamer";
const MANAGED_UPDATES_COMMIT = "3f8b06939023f95717de2b216f1c1a8f1736aeec";
const MINIMUM_VERSION = "0.0.18";
const CANDIDATE_NOTICE = "CANDIDATE TEST ONLY. NEVER PUBLISH.";
const ROOT = resolve(import.meta.dirname, "../../..");
const Sha = type(/^[0-9a-f]{40}$/);
const Hash = type(/^[0-9a-f]{64}$/);
const Id = type("number.integer > 0").narrow(Number.isSafeInteger);
const VerifiedAsset = type({ name: "string", id: Id, bytes: Id, sha256: Hash, url: "string" });
const ArtifactProof = type({ id: Id, name: "string", sha256: Hash, expiresAt: "string" });
const ReceiptProof = type({ attempt: Id, receipt: ArtifactProof, package: ArtifactProof });
const Native = type({
  makepkg: "string",
  srcinfo: Hash,
  vercmp: type({ candidate: "string", stable: "string", result: "-1" }).or("null"),
});
const Preparation = type({
  schema: "1",
  mode: "'stable' | 'candidate'",
  repository: type.enumerated(REPOSITORY),
  version: "string",
  tag: "string",
  sourceCommit: Sha,
  managedUpdatesCommit: type.enumerated(MANAGED_UPDATES_COMMIT),
  publishedAt: "string",
  checksums: { sha256: Hash, entries: Id },
  assets: { dmg: VerifiedAsset, deb: VerifiedAsset },
  license: { sha256: Hash },
  candidate: type({
    run: { id: Id, number: Id, event: "'schedule' | 'workflow_dispatch'", headCommit: Sha },
    receipts: { "mac-arm64": ReceiptProof, "linux-x64": ReceiptProof },
  }).or("null"),
});
type Preparation = typeof Preparation.infer;
const PreparationFile = Preparation.and({
  notice: type.enumerated("Verified stable release", CANDIDATE_NOTICE),
  arch: {
    pkgname: "'mrstreamer-bin'",
    pkgver: type(/^\d+\.\d+\.\d+(?:alpha\d{8}\.\d+)?$/),
    pkgrel: Id,
  },
  homebrew: { token: "'mr-streamer'", version: "string" },
  outputs: { PKGBUILD: Hash, "mr-streamer.rb": Hash, LICENSE: Hash },
  native: Native.or("null"),
});

export type PreparationRequest =
  { mode: "stable"; version: string } | { mode: "candidate"; version: string; run: number };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Refused: ${message}`);
}

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function requestVersion(request: PreparationRequest) {
  const version = parseVersion(request.version);
  check(version && formatVersion(version) === request.version, "Use a bare canonical version.");
  const stable = { ...version, nightly: null };
  check(compareVersions(stable, parseVersion(MINIMUM_VERSION)!) >= 0, "Requires 0.0.18 or newer.");
  check(
    !!version.nightly === (request.mode === "candidate"),
    "Version channel does not match mode.",
  );
  if (request.mode === "candidate") {
    check(formatVersion(stable) === MINIMUM_VERSION, "Candidate tests require a 0.0.18 nightly.");
    Id.assert(request.run);
    Id.assert(version.nightly!.run);
  }
  return version;
}

function archPkgver(version: string) {
  return version.replace("-nightly.", "alpha");
}

/** Verifies published release facts and bytes, plus the exact successful CI receipts for a candidate. */
export async function preparePackages(
  github: GitHub,
  request: PreparationRequest,
  now = Date.now(),
): Promise<Preparation> {
  const version = requestVersion(request);
  check(github.repository === REPOSITORY, "Unexpected repository.");
  const tag = `v${request.version}`;
  const release = type({
    tag_name: "string",
    target_commitish: "string",
    draft: "boolean",
    prerelease: "boolean",
    published_at: "string | null",
    assets: type({
      id: Id,
      name: "string",
      size: Id,
      "digest?": "string | null",
      state: "string",
      browser_download_url: "string",
    }).array(),
  }).assert(await github.json(`/releases/tags/${encodeURIComponent(tag)}`));
  check(
    release.tag_name === tag &&
      !release.draft &&
      release.prerelease === (request.mode === "candidate") &&
      release.published_at &&
      Number.isFinite(Date.parse(release.published_at)),
    "Release tag/channel is not published as requested.",
  );
  const source = type({ sha: Sha }).assert(
    await github.json(`/commits/${encodeURIComponent(tag)}`),
  ).sha;
  check(release.target_commitish === source, "Release target does not match the tag source.");
  for (const comparison of [`${source}...main`, `${MANAGED_UPDATES_COMMIT}...${source}`]) {
    const ancestry = type({ status: "string", behind_by: "number.integer" }).assert(
      await github.json(`/compare/${comparison}?per_page=1`),
    );
    check(
      (ancestry.status === "ahead" || ancestry.status === "identical") && ancestry.behind_by === 0,
      `Required ancestry is missing: ${comparison}.`,
    );
  }
  const content = (path: string) =>
    github.bytes(`/contents/${path}?ref=${source}`, "application/vnd.github.raw+json");
  const root = await mkdtemp(join(tmpdir(), "mrstreamer-release-sources-"));
  let sources: Awaited<ReturnType<typeof releaseSources>>;
  try {
    await mkdir(join(root, "scripts"));
    await writeFile(
      join(root, "licences.config.json"),
      await content("apps/desktop/licences.config.json"),
    );
    await writeFile(
      join(root, "scripts/build-ffmpeg.sh"),
      await content("apps/desktop/scripts/build-ffmpeg.sh"),
    );
    await writeFile(join(root, "package.json"), JSON.stringify({ version: request.version }));
    // An older tag config incompatible with today's parser fails closed.
    sources = await releaseSources(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const expected = new Set([
    ...releaseFiles(request.version),
    ...sources.map((source) => source.file),
  ]);
  const names = release.assets.map((asset) => asset.name);
  check(
    names.length === expected.size + 1 &&
      new Set(names).size === names.length &&
      names.includes("SHA256SUMS.txt") &&
      [...expected].every((name) => names.includes(name)),
    "Release must contain exactly the expected binaries, metadata, source archives and SHA256SUMS.txt.",
  );
  for (const asset of release.assets) {
    check(
      asset.state === "uploaded" &&
        asset.browser_download_url ===
          `https://github.com/${REPOSITORY}/releases/download/${tag}/${asset.name}`,
      `${asset.name} is not uploaded at its canonical versioned URL.`,
    );
    check(/^sha256:[0-9a-f]{64}$/.test(asset.digest ?? ""), `${asset.name} has no SHA-256 digest.`);
  }
  const download = async (name: string) => {
    const asset = release.assets.find((asset) => asset.name === name)!;
    const bytes = await github.bytes(`/releases/assets/${asset.id}`, "application/octet-stream");
    const sha256 = hash(bytes);
    check(
      bytes.length === asset.size && asset.digest === `sha256:${sha256}`,
      `${name} bytes do not match size/digest.`,
    );
    return {
      bytes,
      facts: { name, id: asset.id, bytes: bytes.length, sha256, url: asset.browser_download_url },
    };
  };
  const checksums = await (async () => {
    const sums = await download("SHA256SUMS.txt");
    const entries = new Map<string, string>();
    for (const line of new TextDecoder().decode(sums.bytes).replace(/\n$/, "").split("\n")) {
      const match = /^([0-9a-f]{64})[ \t]+\*?([^\r\n]+)$/.exec(line);
      check(
        match && expected.has(match[2]!) && !entries.has(match[2]!),
        "Malformed, duplicate or unexpected SHA256SUMS.txt entry.",
      );
      entries.set(match[2]!, match[1]!);
    }
    check(entries.size === expected.size, "SHA256SUMS.txt has missing entries.");
    for (const asset of release.assets) {
      if (asset.name !== "SHA256SUMS.txt")
        check(
          asset.digest === `sha256:${entries.get(asset.name)}`,
          `${asset.name} checksum does not match GitHub's digest.`,
        );
    }
    return { sha256: sums.facts.sha256, entries: entries.size };
  })();
  const dmgName = platformFiles(request.version, "mac-arm64").find((name) =>
    name.endsWith(".dmg"),
  )!;
  const debName = platformFiles(request.version, "linux-x64").find((name) =>
    name.endsWith(".deb"),
  )!;
  const dmg = (await download(dmgName)).facts;
  const deb = (await download(debName)).facts;
  const license = await content("LICENSE");
  check(license.length > 0, "Upstream LICENSE is empty.");
  let candidate: Preparation["candidate"] = null;
  if (request.mode === "candidate") {
    const run = type({
      id: Id,
      run_number: Id,
      path: "string",
      head_repository: { full_name: "string" },
      head_branch: "string",
      event: "'schedule' | 'workflow_dispatch'",
      status: "string",
      conclusion: "string | null",
      head_sha: Sha,
    }).assert(await github.json(`/actions/runs/${request.run}`));
    check(
      run.id === request.run &&
        run.path === ".github/workflows/release.yml" &&
        run.head_repository.full_name === REPOSITORY &&
        run.head_branch === "main" &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        run.head_sha === source &&
        run.run_number === version.nightly!.run,
      "Candidate run does not match the successful published nightly source/workflow.",
    );
    const artifacts = await packageArtifacts(github, request.run);
    const proof = async (platform: "mac-arm64" | "linux-x64", asset: typeof dmg) => {
      const prefix = `package-receipt-${platform}-direct-${request.version}-attempt-`;
      const matches = artifacts.filter(
        (artifact) =>
          artifact.name.startsWith(prefix) && /^[1-9]\d*$/.test(artifact.name.slice(prefix.length)),
      );
      check(matches.length === 1, `Expected one unambiguous ${platform} receipt attempt.`);
      const attempt = Id.assert(Number(matches[0]!.name.slice(prefix.length)));
      const receiptRequest: PackageRequest = {
        sourceCommit: source,
        workflowCommit: source,
        appVersion: request.version,
        packageVersion: request.version,
        platform,
        distribution: "direct",
        run: { id: request.run, attempt, headCommit: source },
      };
      const resolved = await resolvePackageReceipt(github, receiptRequest, artifacts, now);
      const file = resolved.receipt.files.find((file) => file.name === asset.name);
      check(
        file && file.sha256 === asset.sha256 && file.bytes === asset.bytes,
        `${platform} published bytes do not match the package receipt.`,
      );
      return {
        attempt,
        receipt: {
          id: resolved.receiptArtifact.id,
          name: resolved.receiptArtifact.name,
          sha256: resolved.receiptArtifact.digest!.slice(7),
          expiresAt: resolved.receiptArtifact.expires_at,
        },
        package: {
          id: resolved.artifact.id,
          name: resolved.artifact.name,
          sha256: resolved.archiveSha256,
          expiresAt: resolved.artifact.expires_at,
        },
      };
    };
    candidate = {
      run: { id: run.id, number: run.run_number, event: run.event, headCommit: source },
      receipts: {
        "mac-arm64": await proof("mac-arm64", dmg),
        "linux-x64": await proof("linux-x64", deb),
      },
    };
  }
  return Preparation.assert({
    schema: 1,
    mode: request.mode,
    repository: REPOSITORY,
    version: request.version,
    tag,
    sourceCommit: source,
    managedUpdatesCommit: MANAGED_UPDATES_COMMIT,
    publishedAt: release.published_at,
    checksums,
    assets: { dmg, deb },
    license: { sha256: hash(license) },
    candidate,
  });
}

/** Templates are checkout-owned, independent of the caller's working directory. */
export async function readTemplates() {
  return {
    pkgbuild: await readFile(join(ROOT, "packaging/aur/PKGBUILD.in"), "utf8"),
    cask: await readFile(join(ROOT, "packaging/homebrew/mr-streamer.rb.in"), "utf8"),
    license: await readFile(join(ROOT, "packaging/aur/LICENSE"), "utf8"),
  };
}

/** Literal, single-use substitutions only. The templates own URLs and package layout. */
export function renderRecipes(
  preparation: Preparation,
  pkgrel: number,
  templates: Awaited<ReturnType<typeof readTemplates>>,
) {
  check(
    (preparation.mode === "candidate") === (preparation.candidate !== null),
    "Candidate proof does not match preparation mode.",
  );
  requestVersion(
    preparation.mode === "candidate"
      ? { mode: "candidate", version: preparation.version, run: preparation.candidate!.run.id }
      : { mode: "stable", version: preparation.version },
  );
  Id.assert(pkgrel);
  const notice = preparation.mode === "candidate" ? CANDIDATE_NOTICE : "Verified stable release";
  const substitute = (input: string, values: Record<string, string>) => {
    const markers = input.match(/@[A-Za-z_][A-Za-z0-9_]*@|\{\{[^{}\r\n]*\}\}/g) ?? [];
    check(
      markers.length === Object.keys(values).length &&
        Object.keys(values).every((key) => markers.filter((marker) => marker === key).length === 1),
      "Unknown, missing or repeated template marker.",
    );
    return input.replace(
      /@[A-Za-z_][A-Za-z0-9_]*@|\{\{[^{}\r\n]*\}\}/g,
      (marker) => values[marker]!,
    );
  };
  return {
    notice,
    arch: { pkgname: "mrstreamer-bin" as const, pkgver: archPkgver(preparation.version), pkgrel },
    homebrew: { token: "mr-streamer" as const, version: preparation.version },
    pkgbuild: substitute(templates.pkgbuild, {
      "@PREPARATION_NOTICE@": notice,
      "@PKGVER@": archPkgver(preparation.version),
      "@PKGREL@": String(pkgrel),
      "@UPSTREAM_VERSION@": preparation.version,
      "@SOURCE_COMMIT@": preparation.sourceCommit,
      "@DEB_SHA256@": preparation.assets.deb.sha256,
      "@LICENSE_SHA256@": preparation.license.sha256,
    }),
    cask:
      (preparation.mode === "candidate" ? `# ${notice}\n` : "") +
      substitute(templates.cask, {
        "{{VERSION}}": preparation.version,
        "{{SHA256}}": preparation.assets.dmg.sha256,
      }),
  };
}

/** An existing output leaf always refuses. The final receipt marks a complete render. */
export async function writePreparation(
  dir: string,
  preparation: Preparation,
  recipes: ReturnType<typeof renderRecipes>,
  templates: Pick<Awaited<ReturnType<typeof readTemplates>>, "license">,
) {
  const outputs = {
    PKGBUILD: recipes.pkgbuild,
    "mr-streamer.rb": recipes.cask,
    LICENSE: templates.license,
  };
  const receipt = PreparationFile.assert({
    ...preparation,
    notice: recipes.notice,
    arch: recipes.arch,
    homebrew: recipes.homebrew,
    outputs: {
      PKGBUILD: hash(outputs.PKGBUILD),
      "mr-streamer.rb": hash(outputs["mr-streamer.rb"]),
      LICENSE: hash(outputs.LICENSE),
    },
    native: null,
  });
  await mkdir(dirname(resolve(dir)), { recursive: true });
  await mkdir(dir);
  for (const [name, text] of Object.entries(outputs))
    await writeFile(join(dir, name), text, { flag: "wx" });
  await writeFile(join(dir, "preparation.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
  });
  return receipt;
}

/** Offline native consistency check. makepkg sources the local PKGBUILD as usual. */
export async function generateSrcinfo(dir: string, env: NodeJS.ProcessEnv = process.env) {
  const receipt = PreparationFile.assert(
    JSON.parse(await readFile(join(dir, "preparation.json"), "utf8")),
  );
  check(
    (receipt.mode === "candidate") === (receipt.candidate !== null),
    "Candidate proof does not match preparation mode.",
  );
  const version = requestVersion(
    receipt.mode === "candidate"
      ? { mode: "candidate", version: receipt.version, run: receipt.candidate!.run.id }
      : { mode: "stable", version: receipt.version },
  );
  check(
    receipt.arch.pkgver === archPkgver(receipt.version),
    "Recorded pkgver does not match upstream version.",
  );
  check(
    hash(await readFile(join(dir, "PKGBUILD"))) === receipt.outputs.PKGBUILD,
    "PKGBUILD digest differs from preparation.json.",
  );
  const native = (file: string, args: string[]) => {
    try {
      return execFileSync(file, args, { cwd: dir, env, encoding: "utf8" });
    } catch (error) {
      throw new Error(
        `Native preparation incomplete: ${file} ${args.join(" ")} failed. Run srcinfo in a clean Arch environment with makepkg and vercmp.`,
        { cause: error },
      );
    }
  };
  const makepkg = native("makepkg", ["--version"]).split("\n")[0]!;
  const srcinfo = native("makepkg", ["--printsrcinfo"]);
  check(srcinfo === native("makepkg", ["--printsrcinfo"]), "Native .SRCINFO regeneration differs.");
  const first = (key: string) =>
    srcinfo
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith(`${key} = `))
      ?.slice(key.length + 3);
  check(
    first("pkgver") === receipt.arch.pkgver &&
      first("pkgrel") === String(receipt.arch.pkgrel) &&
      first("source") === receipt.assets.deb.url &&
      first("sha256sums") === receipt.assets.deb.sha256,
    "Native .SRCINFO does not match the verified version/revision/deb URL/hash.",
  );
  let vercmp: (typeof Native.infer)["vercmp"] = null;
  if (version.nightly) {
    const stable = formatVersion({ ...version, nightly: null });
    check(
      native("vercmp", [receipt.arch.pkgver, stable]).trim() === "-1",
      "Candidate pkgver must sort below matching stable.",
    );
    vercmp = { candidate: receipt.arch.pkgver, stable, result: -1 };
  }
  try {
    await writeFile(join(dir, ".SRCINFO"), srcinfo, { flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    check(
      (await readFile(join(dir, ".SRCINFO"), "utf8")) === srcinfo,
      "Existing .SRCINFO differs.",
    );
  }
  receipt.native = { makepkg, srcinfo: hash(srcinfo), vercmp };
  const temporary = await mkdtemp(join(dir, ".preparation-"));
  try {
    const staged = join(temporary, "preparation.json");
    await writeFile(staged, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    await rename(staged, join(dir, "preparation.json"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return receipt.native;
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      version: { type: "string" },
      candidate: { type: "string" },
      run: { type: "string" },
      out: { type: "string" },
      pkgrel: { type: "string" },
      dir: { type: "string" },
    },
  });
  check(positionals.length === 1, 'Use "render" or "srcinfo".');
  if (positionals[0] === "srcinfo") {
    check(
      values.dir && Object.keys(values).length === 1,
      "Use srcinfo --dir <rendered-directory>.",
    );
    const result = await generateSrcinfo(values.dir);
    console.log(`.SRCINFO ${result.srcinfo} from ${result.makepkg}.`);
    return;
  }
  check(
    positionals[0] === "render" && values.out && !values.dir,
    "Use render --version <stable> --out <new-directory>, or --candidate <nightly> --run <id>.",
  );
  check(
    (values.version !== undefined) !== (values.candidate !== undefined),
    "Choose exactly one of --version and --candidate.",
  );
  check(
    values.candidate !== undefined || values.run === undefined,
    "--run is only valid with --candidate.",
  );
  const positive = (value: string | undefined, name: string) => {
    check(value && /^[1-9]\d*$/.test(value), `${name} must be a positive integer.`);
    return Id.assert(Number(value));
  };
  const request: PreparationRequest =
    values.candidate !== undefined
      ? { mode: "candidate", version: values.candidate, run: positive(values.run, "--run") }
      : { mode: "stable", version: values.version! };
  requestVersion(request);
  const pkgrel = positive(values.pkgrel ?? "1", "--pkgrel");
  check(
    !lstatSync(values.out, { throwIfNoEntry: false }),
    "Output directory already exists. Use a new --out directory.",
  );
  const token =
    process.env["GH_TOKEN"] ??
    execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const preparation = await preparePackages(restGitHub(REPOSITORY, token), request);
  const templates = await readTemplates();
  const receipt = await writePreparation(
    values.out,
    preparation,
    renderRecipes(preparation, pkgrel, templates),
    templates,
  );
  console.log(
    `${receipt.notice} ${receipt.tag} from ${receipt.sourceCommit}. Native checks pending; see packaging/aur/README.md and packaging/homebrew/README.md.`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
