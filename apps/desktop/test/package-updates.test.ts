// Synthetic published releases exercise preparation, without claiming native package acceptance.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { releaseFiles, platformFiles } from "@mrstreamer/contracts/release-files";
import { readConfig, releaseSources } from "../scripts/licences.ts";
import {
  Artifact,
  producePackageReceipt,
  type PackageReceipt,
} from "../scripts/package-receipt.ts";
import {
  generateSrcinfo,
  preparePackages,
  readTemplates,
  renderRecipes,
  writePreparation,
  type PreparationRequest,
} from "../scripts/package-updates.ts";

const REPOSITORY = "Mr-Streamer-OSS/MrStreamer";
const SOURCE = "a".repeat(40);
const MERGE = "3f8b06939023f95717de2b216f1c1a8f1736aeec";
const NIGHTLY = "0.0.18-nightly.20261020.397";
const NOW = Date.parse("2026-10-20T12:00:00Z");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const CLI = resolve("apps/desktop/scripts/package-updates.ts");

async function fixture(mode: "stable" | "candidate" = "stable") {
  const version = mode === "stable" ? "0.0.18" : NIGHTLY;
  const request: PreparationRequest =
    mode === "stable" ? { mode, version } : { mode, version, run: 900 };
  const config = await readConfig(resolve("apps/desktop"));
  // Prove enumeration uses the tag's config, rather than this checkout's archive names.
  config.sources[0] = {
    file: "tag-source-{app}.tar.gz",
    git: "https://example.com/source",
    commit: SOURCE,
  };
  const buildScript = await readFile("apps/desktop/scripts/build-ffmpeg.sh");
  const root = await mkdtemp(join(tmpdir(), "package-updates-fixture-"));
  let sources: Awaited<ReturnType<typeof releaseSources>>;
  try {
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "package.json"), JSON.stringify({ version }));
    await writeFile(join(root, "licences.config.json"), JSON.stringify(config));
    await writeFile(join(root, "scripts/build-ffmpeg.sh"), buildScript);
    sources = await releaseSources(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const bodies = new Map<string, Uint8Array>(
    [...releaseFiles(version), ...sources.map((source) => source.file)].map((name) => [
      name,
      strToU8(`Synthetic ${name}`),
    ]),
  );
  const assets = [...bodies].map(([name, bytes], index) => ({
    id: index + 1,
    name,
    size: bytes.length,
    digest: `sha256:${sha256(bytes)}` as string | null,
    state: "uploaded",
    browser_download_url: `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`,
  }));
  const replaceAsset = (name: string, bytes: Uint8Array) => {
    bodies.set(name, bytes);
    const asset = assets.find((asset) => asset.name === name);
    const facts = { size: bytes.length, digest: `sha256:${sha256(bytes)}` };
    if (asset) Object.assign(asset, facts);
    else
      assets.push({
        ...facts,
        id: assets.length + 100,
        name,
        state: "uploaded",
        browser_download_url: `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`,
      });
  };
  const sums = () =>
    replaceAsset(
      "SHA256SUMS.txt",
      strToU8(
        assets
          .filter((asset) => asset.name !== "SHA256SUMS.txt")
          .map((asset) => `${sha256(bodies.get(asset.name)!)}  ${asset.name}\n`)
          .join(""),
      ),
    );
  sums();
  const release = {
    tag_name: `v${version}`,
    target_commitish: SOURCE,
    draft: false,
    prerelease: mode === "candidate",
    published_at: "2026-10-20T11:59:00Z" as string | null,
    assets,
  };
  const histories = new Map(
    [`${SOURCE}...main`, `${MERGE}...${SOURCE}`].map((name) => [
      name,
      { status: "ahead", behind_by: 0 },
    ]),
  );
  const run = {
    id: 900,
    run_number: 397,
    run_attempt: 9,
    event: "schedule",
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/release.yml",
    head_sha: SOURCE,
    head_branch: "main",
    head_repository: { full_name: REPOSITORY },
  };
  const artifacts: (typeof Artifact.infer)[] = [];
  const archives = new Map<number, Uint8Array>();
  const builds = (["mac-arm64", "linux-x64"] as const).map((platform, index) => {
    const attempt = index + 2;
    const files = new Map(
      platformFiles(version, platform).map((name) => [name, bodies.get(name)!]),
    );
    const archive = zipSync(Object.fromEntries(files));
    const artifact = {
      id: 300 + index * 2,
      name: `release-${platform}-${version}`,
      digest: `sha256:${sha256(archive)}`,
      expired: false,
      expires_at: "2026-10-23T11:57:21Z",
      workflow_run: { id: 900, head_sha: SOURCE },
    };
    const receipt = producePackageReceipt(
      {
        repository: REPOSITORY,
        sourceCommit: SOURCE,
        workflowCommit: SOURCE,
        appVersion: version,
        packageVersion: version,
        platform,
        distribution: "direct",
        run: { id: 900, attempt, headCommit: SOURCE },
        artifact: { id: artifact.id, name: artifact.name, sha256: sha256(archive) },
      },
      files,
    );
    const receiptArtifact = {
      ...artifact,
      workflow_run: { ...artifact.workflow_run },
      id: artifact.id + 1,
      name: `package-receipt-${platform}-direct-${version}-attempt-${attempt}`,
    };
    const updateReceipt = (receipt: unknown) => {
      const bytes = zipSync({ "package-receipt.json": strToU8(JSON.stringify(receipt)) });
      archives.set(receiptArtifact.id, bytes);
      receiptArtifact.digest = `sha256:${sha256(bytes)}`;
    };
    archives.set(artifact.id, archive);
    artifacts.push(artifact, receiptArtifact);
    updateReceipt(receipt);
    return { platform, artifact, receiptArtifact, files, receipt, updateReceipt };
  });
  const reads: string[] = [];
  const github = {
    repository: REPOSITORY,
    json: async (path: string) => {
      reads.push(path);
      if (path === `/releases/tags/v${version}`) return release;
      if (path === `/commits/v${version}`) return { sha: SOURCE };
      if (path.startsWith("/compare/")) return histories.get(path.slice(9).split("?")[0]!);
      if (mode === "candidate" && path === "/actions/runs/900") return run;
      if (mode === "candidate" && path === "/actions/runs/900/artifacts?per_page=100&page=1")
        return { artifacts, total_count: artifacts.length };
      throw new Error(`Unexpected GET ${path}`);
    },
    bytes: async (path: string) => {
      reads.push(path);
      if (path === `/contents/apps/desktop/licences.config.json?ref=${SOURCE}`)
        return strToU8(JSON.stringify(config));
      if (path === `/contents/apps/desktop/scripts/build-ffmpeg.sh?ref=${SOURCE}`)
        return buildScript;
      if (path === `/contents/LICENSE?ref=${SOURCE}`)
        return strToU8("Synthetic upstream GPL license\n");
      const asset = assets.find((asset) => path === `/releases/assets/${asset.id}`);
      if (asset) return bodies.get(asset.name)!;
      const artifact = artifacts.find(
        (artifact) => path === `/actions/artifacts/${artifact.id}/zip`,
      );
      if (mode === "candidate" && artifact) return archives.get(artifact.id)!;
      throw new Error(`Unexpected download ${path}`);
    },
  };
  return {
    version,
    request,
    github,
    release,
    histories,
    run,
    builds,
    artifacts,
    archives,
    bodies,
    sources,
    reads,
    sums,
    replaceAsset,
    prepare: () => preparePackages(github, request, NOW),
  };
}
type World = Awaited<ReturnType<typeof fixture>>;

describe("package preparation", () => {
  it.each(["stable", "candidate"] as const)(
    "renders deterministic %s outputs and a final receipt",
    async (mode) => {
      const world = await fixture(mode);
      const preparation = await world.prepare();
      const templates = await readTemplates();
      const recipes = renderRecipes(preparation, 2, templates);
      const root = await mkdtemp(join(tmpdir(), "package-updates-output-"));
      try {
        const receipt = await writePreparation(
          join(root, "first"),
          preparation,
          recipes,
          templates,
        );
        await writePreparation(
          join(root, "second"),
          await world.prepare(),
          renderRecipes(preparation, 2, templates),
          templates,
        );
        expect((await readdir(join(root, "first"))).sort()).toEqual([
          "LICENSE",
          "PKGBUILD",
          "mr-streamer.rb",
          "preparation.json",
        ]);
        for (const name of await readdir(join(root, "first")))
          expect(await readFile(join(root, "first", name))).toEqual(
            await readFile(join(root, "second", name)),
          );
        expect(receipt.native).toBeNull();
        expect(receipt.outputs.PKGBUILD).toBe(sha256(recipes.pkgbuild));
        expect(await readFile(join(root, "first/LICENSE"), "utf8")).toBe(templates.license);
        expect(receipt.license.sha256).toBe(sha256("Synthetic upstream GPL license\n"));
        expect(recipes.pkgbuild).toContain(`_upstream_version='${world.version}'`);
        expect(recipes.pkgbuild).toContain(`_source_commit='${SOURCE}'`);
        expect(recipes.pkgbuild).toContain(preparation.assets.deb.sha256);
        expect(recipes.pkgbuild).toContain(preparation.license.sha256);
        expect(recipes.pkgbuild).toContain("${_upstream_version//-/\\~}");
        expect(recipes.pkgbuild).toContain("pkgrel=2");
        expect(recipes.cask).toContain(`version "${world.version}"`);
        expect(recipes.cask).toContain(preparation.assets.dmg.sha256);
        expect(preparation.assets.deb.url).toBe(
          `https://github.com/${REPOSITORY}/releases/download/v${world.version}/Mr-Streamer-${world.version}-linux-amd64.deb`,
        );
        expect(recipes.pkgbuild + recipes.cask).not.toMatch(/@[A-Z_]+@|\{\{/);
        if (mode === "stable") {
          expect(recipes.pkgbuild).toContain("pkgver=0.0.18\n");
          expect(recipes.cask.startsWith('cask "mr-streamer"')).toBe(true);
          expect(preparation.candidate).toBeNull();
          expect(world.reads.some((path) => path.startsWith("/actions"))).toBe(false);
        } else {
          expect(recipes.pkgbuild).toContain("pkgver=0.0.18alpha20261020.397\n");
          expect(recipes.cask.startsWith("# CANDIDATE TEST ONLY. NEVER PUBLISH.\n")).toBe(true);
          expect(preparation.candidate?.receipts["mac-arm64"].attempt).toBe(2);
          expect(preparation.candidate?.receipts["linux-x64"].attempt).toBe(3);
          expect(preparation.candidate?.receipts["linux-x64"].package.sha256).toBe(
            world.builds[1]!.receipt.artifact.sha256,
          );
        }
        // Archive enumeration must not download source archives, even for a candidate.
        for (const source of world.sources)
          expect(world.reads).not.toContain(
            `/releases/assets/${world.release.assets.find((asset) => asset.name === source.file)!.id}`,
          );
        const before = await readFile(join(root, "first/preparation.json"));
        await expect(
          writePreparation(join(root, "first"), preparation, recipes, templates),
        ).rejects.toThrow(/EEXIST/);
        expect(await readFile(join(root, "first/preparation.json"))).toEqual(before);
        await mkdir(join(root, "empty"));
        await expect(
          writePreparation(join(root, "empty"), preparation, recipes, templates),
        ).rejects.toThrow(/EEXIST/);
        expect(await readdir(join(root, "empty"))).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [
      "draft",
      (w: World) => {
        w.release.draft = true;
      },
      /published/,
    ],
    [
      "channel",
      (w: World) => {
        w.release.prerelease = true;
      },
      /published/,
    ],
    [
      "unpublished",
      (w: World) => {
        w.release.published_at = null;
      },
      /published/,
    ],
    [
      "wrong tag",
      (w: World) => {
        w.release.tag_name = "v0.0.19";
      },
      /published/,
    ],
    [
      "moved source",
      (w: World) => {
        w.release.target_commitish = "b".repeat(40);
      },
      /target/,
    ],
    [
      "off main",
      (w: World) => {
        w.histories.get(`${SOURCE}...main`)!.status = "diverged";
      },
      /ancestry/,
    ],
    [
      "before marker",
      (w: World) => {
        w.histories.get(`${MERGE}...${SOURCE}`)!.behind_by = 1;
      },
      /ancestry/,
    ],
    [
      "missing source and checksum",
      (w: World) => {
        const name = w.sources[0]!.file;
        w.release.assets.splice(
          w.release.assets.findIndex((asset) => asset.name === name),
          1,
        );
        w.sums();
      },
      /exactly/,
    ],
    [
      "extra asset and checksum",
      (w: World) => {
        w.replaceAsset("unknown-source.tar.gz", strToU8("extra"));
        w.sums();
      },
      /exactly/,
    ],
    [
      "duplicate asset",
      (w: World) => {
        w.release.assets.push(w.release.assets[0]!);
      },
      /exactly/,
    ],
    [
      "missing digest",
      (w: World) => {
        w.release.assets[0]!.digest = null;
      },
      /no SHA-256/,
    ],
    [
      "checksum file digest",
      (w: World) => {
        w.release.assets.find((asset) => asset.name === "SHA256SUMS.txt")!.digest =
          `sha256:${"0".repeat(64)}`;
      },
      /bytes/,
    ],
    [
      "wrong digest",
      (w: World) => {
        w.release.assets[0]!.digest = `sha256:${"0".repeat(64)}`;
      },
      /checksum/,
    ],
    [
      "wrong bytes",
      (w: World) => {
        const asset = w.release.assets[0]!;
        w.bodies.set(asset.name, new Uint8Array(asset.size).fill(120));
      },
      /bytes/,
    ],
    [
      "wrong size",
      (w: World) => {
        w.release.assets[0]!.size++;
      },
      /bytes/,
    ],
    [
      "pending asset",
      (w: World) => {
        w.release.assets[0]!.state = "new";
      },
      /canonical/,
    ],
    [
      "foreign host",
      (w: World) => {
        w.release.assets[0]!.browser_download_url = "https://example.com/package.dmg";
      },
      /canonical/,
    ],
    [
      "foreign repository",
      (w: World) => {
        w.release.assets[0]!.browser_download_url =
          w.release.assets[0]!.browser_download_url.replace(REPOSITORY, "foreign/MrStreamer");
      },
      /canonical/,
    ],
    [
      "moving URL",
      (w: World) => {
        w.release.assets[0]!.browser_download_url =
          w.release.assets[0]!.browser_download_url.replace(
            `/download/v${w.version}/`,
            "/latest/download/",
          );
      },
      /canonical/,
    ],
    [
      "incompatible tag config",
      (w: World) => {
        w.github.bytes = async () => strToU8("{}");
      },
      /sources|packages/,
    ],
  ] satisfies [string, (w: World) => void, RegExp][])("refuses %s", async (_, spoil, message) => {
    const world = await fixture();
    spoil(world);
    await expect(world.prepare()).rejects.toThrow(message);
  });

  it.each(["missing", "duplicate", "extra", "malformed"] as const)(
    "refuses a %s checksum entry",
    async (kind) => {
      const world = await fixture();
      const lines = new TextDecoder()
        .decode(world.bodies.get("SHA256SUMS.txt"))
        .trimEnd()
        .split("\n");
      if (kind === "missing") lines.pop();
      if (kind === "duplicate") lines.push(lines[0]!);
      if (kind === "extra") lines.push(`${"0".repeat(64)}  unknown.zip`);
      if (kind === "malformed") lines[0] = "not a checksum";
      world.replaceAsset("SHA256SUMS.txt", strToU8(`${lines.join("\n")}\n`));
      await expect(world.prepare()).rejects.toThrow(/SHA256SUMS/);
    },
  );

  it.each([
    [
      "wrong workflow",
      (w: World) => {
        w.run.path = ".github/workflows/other.yml";
      },
      /Candidate run/,
    ],
    [
      "foreign repository",
      (w: World) => {
        w.run.head_repository.full_name = "fork/player";
      },
      /Candidate run/,
    ],
    [
      "pull request",
      (w: World) => {
        w.run.event = "pull_request";
      },
      /event must be/,
    ],
    [
      "branch",
      (w: World) => {
        w.run.head_branch = "feature";
      },
      /Candidate run/,
    ],
    [
      "failed run",
      (w: World) => {
        w.run.conclusion = "failure";
      },
      /Candidate run/,
    ],
    [
      "incomplete run",
      (w: World) => {
        w.run.status = "in_progress";
      },
      /Candidate run/,
    ],
    [
      "source",
      (w: World) => {
        w.run.head_sha = "b".repeat(40);
      },
      /Candidate run/,
    ],
    [
      "run number",
      (w: World) => {
        w.run.run_number = 398;
      },
      /Candidate run/,
    ],
    [
      "run id",
      (w: World) => {
        w.run.id = 901;
      },
      /Candidate run/,
    ],
    [
      "missing receipt",
      (w: World) => {
        w.artifacts.splice(w.artifacts.indexOf(w.builds[1]!.receiptArtifact), 1);
      },
      /unambiguous linux-x64 receipt/,
    ],
    [
      "ambiguous attempt",
      (w: World) => {
        w.artifacts.push({
          ...w.builds[0]!.receiptArtifact,
          id: 500,
          name: `package-receipt-mac-arm64-direct-${w.version}-attempt-4`,
        });
      },
      /unambiguous mac-arm64 receipt/,
    ],
    [
      "invalid attempt",
      (w: World) => {
        w.builds[0]!.receiptArtifact.name = `package-receipt-mac-arm64-direct-${w.version}-attempt-0`;
      },
      /unambiguous mac-arm64 receipt/,
    ],
    [
      "wrong version in receipt name",
      (w: World) => {
        w.builds[0]!.receiptArtifact.name = w.builds[0]!.receiptArtifact.name.replace(
          w.version,
          "0x0x18-nightlyx20261020x397",
        );
      },
      /unambiguous mac-arm64 receipt/,
    ],
    [
      "expired artifact",
      (w: World) => {
        w.builds[0]!.artifact.expires_at = "2026-10-20T11:00:00Z";
      },
      /release-mac-arm64-\S+ has expired/,
    ],
    [
      "wrong artifact run",
      (w: World) => {
        w.builds[0]!.artifact.workflow_run.id = 901;
      },
      /Package receipt: release-mac-arm64-\S+ belongs to another run/,
    ],
    [
      "altered ZIP",
      (w: World) => {
        w.archives.set(w.builds[0]!.artifact.id, strToU8("wrong"));
      },
      /release-mac-arm64-\S+ does not match its digest/,
    ],
  ] satisfies [string, (w: World) => void, RegExp][])(
    "refuses candidate %s",
    async (_, spoil, message) => {
      const world = await fixture("candidate");
      spoil(world);
      await expect(world.prepare()).rejects.toThrow(message);
    },
  );

  it.each([
    [
      "receipt source",
      (r: PackageReceipt) => {
        r.sourceCommit = "b".repeat(40);
      },
      /sourceCommit is .* expected/,
    ],
    [
      "receipt workflow",
      (r: PackageReceipt) => {
        r.workflowCommit = "b".repeat(40);
      },
      /workflowCommit is .* expected/,
    ],
    [
      "receipt version",
      (r: PackageReceipt) => {
        r.appVersion = "0.0.18";
      },
      /packageVersion does not match the distribution/,
    ],
    [
      "receipt attempt",
      (r: PackageReceipt) => {
        r.run.attempt = 8;
      },
      /run\.attempt does not match the request/,
    ],
    [
      "receipt file bytes",
      (r: PackageReceipt) => {
        r.files[0]!.sha256 = "0".repeat(64);
      },
      /\.dmg SHA-256 does not match the receipt/,
    ],
  ] satisfies [string, (r: PackageReceipt) => void, RegExp][])(
    "refuses candidate %s",
    async (_, spoil, message) => {
      const world = await fixture("candidate");
      const build = world.builds[0]!;
      spoil(build.receipt);
      build.updateReceipt(build.receipt);
      await expect(world.prepare()).rejects.toThrow(message);
    },
  );

  it("binds published DMG bytes to the independently valid CI receipt", async () => {
    const world = await fixture("candidate");
    world.replaceAsset(
      platformFiles(world.version, "mac-arm64")[0]!,
      strToU8("Different valid published DMG"),
    );
    world.sums();
    await expect(world.prepare()).rejects.toThrow(/published bytes/);
  });

  it.each([
    [{ mode: "stable", version: "0.0.17" }, /Requires 0\.0\.18 or newer/],
    [{ mode: "stable", version: NIGHTLY }, /Version channel does not match mode/],
    [{ mode: "stable", version: "v0.0.18" }, /bare canonical version/],
    [{ mode: "stable", version: "00.0.18" }, /bare canonical version/],
    [{ mode: "stable", version: "latest" }, /bare canonical version/],
    [{ mode: "stable", version: "0.0.18 " }, /bare canonical version/],
    [{ mode: "candidate", version: "0.0.18", run: 900 }, /Version channel does not match mode/],
    [
      { mode: "candidate", version: "0.0.19-nightly.20261020.397", run: 900 },
      /Candidate tests require a 0\.0\.18 nightly/,
    ],
    [{ mode: "candidate", version: NIGHTLY, run: Number.MAX_SAFE_INTEGER + 1 }, /isSafeInteger/],
  ] satisfies [PreparationRequest, RegExp][])(
    "refuses invalid request %j before GitHub",
    async (request, message) => {
      const world = await fixture();
      await expect(preparePackages(world.github, request, NOW)).rejects.toThrow(message);
      expect(world.reads).toEqual([]);
    },
  );

  it.each(["missing", "duplicate", "unknown"] as const)(
    "refuses %s recipe markers",
    async (kind) => {
      const world = await fixture();
      const preparation = await world.prepare();
      for (const file of ["pkgbuild", "cask"] as const) {
        const templates = await readTemplates();
        const marker = file === "pkgbuild" ? "@PKGVER@" : "{{VERSION}}";
        if (kind === "missing") templates[file] = templates[file].replace(marker, "");
        if (kind === "duplicate") templates[file] += marker;
        if (kind === "unknown") templates[file] += "{{UNKNOWN}}";
        expect(() => renderRecipes(preparation, 1, templates)).toThrow(/marker/);
      }
    },
  );

  it("leaves native preparation visibly incomplete without makepkg", async () => {
    const world = await fixture("candidate");
    const preparation = await world.prepare();
    const templates = await readTemplates();
    const root = await mkdtemp(join(tmpdir(), "package-updates-native-"));
    const dir = join(root, "output");
    try {
      const receipt = await writePreparation(
        dir,
        preparation,
        renderRecipes(preparation, 1, templates),
        templates,
      );
      const before = await readFile(join(dir, "preparation.json"));
      await expect(generateSrcinfo(dir, { PATH: root })).rejects.toThrow(
        /Native preparation incomplete/,
      );
      expect(await readFile(join(dir, "preparation.json"))).toEqual(before);
      expect(await readdir(dir)).not.toContain(".SRCINFO");
      await writeFile(join(dir, "PKGBUILD"), "changed");
      await expect(generateSrcinfo(dir, { PATH: root })).rejects.toThrow(/PKGBUILD digest/);
      receipt.arch.pkgver = "0.0.18;touch injected";
      await writeFile(join(dir, "preparation.json"), JSON.stringify(receipt));
      await expect(generateSrcinfo(dir, { PATH: root })).rejects.toThrow(/pkgver/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // These executable shell stand-ins test the protocol, not native Arch acceptance.
  it.skipIf(process.platform === "win32").each(["write", "replace"] as const)(
    "preserves the receipt after a failed native receipt %s and permits a rerun",
    async (failure) => {
      const world = await fixture("candidate");
      const preparation = await world.prepare();
      const templates = await readTemplates();
      const root = await mkdtemp(join(tmpdir(), "package-updates-receipt-"));
      const dir = join(root, "rendered directory");
      try {
        const receipt = await writePreparation(
          dir,
          preparation,
          renderRecipes(preparation, 1, templates),
          templates,
        );
        const srcinfo = [
          "pkgbase = mrstreamer-bin",
          `\tpkgver = ${receipt.arch.pkgver}`,
          "\tpkgrel = 1",
          `\tsource = ${receipt.assets.deb.url}`,
          `\tsha256sums = ${receipt.assets.deb.sha256}`,
          "",
        ].join("\n");
        await writeFile(
          join(root, "makepkg"),
          '#!/bin/sh\ncase "$1" in\n--version) printf "%s\\n" "makepkg protocol stand-in" ;;\n--printsrcinfo) printf "%s" "$SRCINFO_PROTOCOL_FIXTURE" ;;\n*) exit 2 ;;\nesac\n',
          { mode: 0o755 },
        );
        await writeFile(join(root, "vercmp"), '#!/bin/sh\nprintf "%s\\n" -1\n', {
          mode: 0o755,
        });
        const env = { ...process.env, PATH: root, SRCINFO_PROTOCOL_FIXTURE: srcinfo };
        const injector = join(root, "receipt-failure.mjs");
        await writeFile(
          injector,
          `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
const { writeFile, rename } = fs;
if (${JSON.stringify(failure)} === "write") {
  fs.writeFile = async (path, data, options) => {
    if (basename(path) === "preparation.json") {
      await writeFile(path, data.slice(0, 17), options);
      throw new Error("Injected receipt write failure");
    }
    return writeFile(path, data, options);
  };
} else {
  fs.rename = async (source, target) => {
    if (basename(target) === "preparation.json")
      throw new Error("Injected receipt replace failure");
    return rename(source, target);
  };
}
syncBuiltinESMExports();
`,
        );
        // An unrelated temporary-looking entry must survive failed cleanup and the rerun.
        await mkdir(join(dir, ".preparation-unrelated"));
        await writeFile(join(dir, ".preparation-unrelated", "keep"), "unrelated bytes");
        const before = await readFile(join(dir, "preparation.json"));
        const names = [...(await readdir(dir)), ".SRCINFO"].sort();
        const failed = spawnSync(
          process.execPath,
          ["--import", injector, CLI, "srcinfo", "--dir", dir],
          { cwd: root, env, encoding: "utf8" },
        );
        expect(failed.status, failed.stdout + failed.stderr).toBe(1);
        expect(failed.stdout).toContain(`::error::Injected receipt ${failure} failure`);
        expect(await readFile(join(dir, "preparation.json"))).toEqual(before);
        expect(await readFile(join(dir, ".SRCINFO"), "utf8")).toBe(srcinfo);
        expect((await readdir(dir)).sort()).toEqual(names);

        const native = await generateSrcinfo(dir, env);
        expect(native).toEqual({
          makepkg: "makepkg protocol stand-in",
          srcinfo: sha256(srcinfo),
          vercmp: { candidate: receipt.arch.pkgver, stable: "0.0.18", result: -1 },
        });
        const completed = { ...receipt, native };
        expect(await readFile(join(dir, "preparation.json"), "utf8")).toBe(
          `${JSON.stringify(completed, null, 2)}\n`,
        );
        const rerun = spawnSync(process.execPath, [CLI, "srcinfo", "--dir", dir], {
          cwd: root,
          env,
          encoding: "utf8",
        });
        expect(rerun.status, rerun.stdout + rerun.stderr).toBe(0);
        expect(rerun.stdout).toContain(`.SRCINFO ${native.srcinfo} from ${native.makepkg}.`);
        expect(await readFile(join(dir, "preparation.json"), "utf8")).toBe(
          `${JSON.stringify(completed, null, 2)}\n`,
        );
        expect((await readdir(dir)).sort()).toEqual(names);
        expect(await readFile(join(dir, ".preparation-unrelated", "keep"), "utf8")).toBe(
          "unrelated bytes",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects malformed CLI inputs and existing outputs before authentication or network, from any working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "package-updates-cli-"));
    try {
      const cases = [
        [],
        ["render", "--version", "0.0.18"],
        ["render", "--out", "out"],
        ["render", "--version", "0.0.18", "--candidate", NIGHTLY, "--out", "out"],
        ...["0", "-1", "1.5", "x", "9007199254740992"].map((value) => [
          "render",
          "--version",
          "0.0.18",
          "--out",
          "out",
          "--pkgrel",
          value,
        ]),
        ...["0", "1.5", "9007199254740992"].map((value) => [
          "render",
          "--candidate",
          NIGHTLY,
          "--run",
          value,
          "--out",
          "out",
        ]),
        ["render", "--candidate", NIGHTLY, "--out", "out"],
        ["render", "--version", "0.0.18", "--run", "900", "--out", "out"],
        ["render", "--version", "v0.0.18", "--out", "out"],
        ["render", "--candidate", `v${NIGHTLY}`, "--run", "900", "--out", "out"],
        ["srcinfo", "--dir", "out", "--run", "900"],
      ];
      for (const args of cases) {
        const result = spawnSync(process.execPath, [CLI, ...args], {
          cwd: root,
          env: { PATH: root },
          encoding: "utf8",
        });
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stdout).toContain("::error::");
        expect(result.stdout + result.stderr).not.toMatch(/spawnSync gh|ENOENT|GitHub/);
      }
      expect(await readdir(root)).toEqual([]);
      // The module's real templates still resolve when imported from another cwd.
      const text = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const {readTemplates} = await import(${JSON.stringify(pathToFileURL(CLI).href)}); console.log((await readTemplates()).cask);`,
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(text).toContain('cask "mr-streamer"');
      const blockNetwork = join(root, "block-network.mjs");
      await writeFile(
        blockNetwork,
        'globalThis.fetch = () => { throw new Error("Network blocked by CLI test"); };\n',
      );
      for (const populated of [false, true]) {
        const dir = join(root, populated ? "populated" : "empty");
        await mkdir(dir);
        if (populated) await writeFile(join(dir, "PKGBUILD"), "Existing recipe\n");
        for (const token of [undefined, "blocked-network-test"]) {
          const result = spawnSync(
            process.execPath,
            ["--import", blockNetwork, CLI, "render", "--version", "0.0.18", "--out", dir],
            {
              cwd: root,
              env: token === undefined ? { PATH: root } : { PATH: root, GH_TOKEN: token },
              encoding: "utf8",
            },
          );
          expect(result.status, result.stdout + result.stderr).toBe(1);
          expect(result.stdout).toMatch(/::error::Refused: Output directory already exists/);
          expect(result.stdout + result.stderr).not.toMatch(
            /spawnSync gh|ENOENT|GitHub|Network blocked/,
          );
        }
        expect(await readdir(dir)).toEqual(populated ? ["PKGBUILD"] : []);
        if (populated)
          expect(await readFile(join(dir, "PKGBUILD"), "utf8")).toBe("Existing recipe\n");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
