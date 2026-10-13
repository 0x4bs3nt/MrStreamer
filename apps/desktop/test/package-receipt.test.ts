// Synthetic package bytes prove the producer/resolver contract. Native packaging stays separate.
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  packageArtifacts,
  producePackageReceipt,
  resolvePackageReceipt,
  type PackageIdentity,
  type PackageReceipt,
  type PackageRequest,
} from "../scripts/package-receipt.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const NOW = Date.parse("2026-10-11T00:00:00Z");
const VERSION = "0.0.11-nightly.20261011.300";
const builds: Pick<PackageIdentity, "platform" | "distribution" | "packageVersion">[] = [
  { platform: "mac-arm64", distribution: "direct", packageVersion: VERSION },
  { platform: "linux-x64", distribution: "direct", packageVersion: VERSION },
  { platform: "win-x64", distribution: "direct", packageVersion: VERSION },
  { platform: "win-x64", distribution: "store", packageVersion: "1.0.10.300" },
];

function fixture(build = builds[2]!) {
  const base = `Mr-Streamer-${VERSION}-${build.platform}`;
  const names =
    build.distribution === "store"
      ? [`${base}.msix`, `${base}.msix.json`, `${base}.wack.xml`]
      : build.platform === "mac-arm64"
        ? [`${base}.dmg`, `${base}.zip`, `${base}.zip.blockmap`, "latest-mac.yml"]
        : build.platform === "linux-x64"
          ? [
              `Mr-Streamer-${VERSION}-linux-x86_64.AppImage`,
              `Mr-Streamer-${VERSION}-linux-amd64.deb`,
              "latest-linux.yml",
            ]
          : [`${base}-setup.exe`, `${base}-setup.exe.blockmap`, "latest.yml"];
  const files = new Map(names.map((name) => [name, strToU8(`Synthetic ${name}`)]));
  if (build.platform === "linux-x64") {
    const name = names[0]!;
    const installer = files.get(name)!;
    const sha512 = createHash("sha512").update(installer).digest("base64");
    files.set(
      "latest-linux.yml",
      strToU8(
        stringify({
          version: VERSION,
          files: names.slice(0, 2).map((url) => ({
            url,
            sha512: createHash("sha512").update(files.get(url)!).digest("base64"),
            size: files.get(url)!.length,
          })),
          path: name,
          sha512,
        }),
      ),
    );
  }
  const archive = zipSync(Object.fromEntries(files));
  const identity: PackageIdentity = {
    ...build,
    repository: "owner/player",
    sourceCommit: "a".repeat(40),
    workflowCommit: "b".repeat(40),
    appVersion: VERSION,
    run: { id: 900, attempt: 2, headCommit: "c".repeat(40) },
    artifact: {
      id: 30,
      name:
        build.distribution === "store" ? `msix-${VERSION}` : `release-${build.platform}-${VERSION}`,
      sha256: sha256(archive),
    },
  };
  const initialReceipt = producePackageReceipt(identity, files);
  const artifact = {
    id: 30,
    name: identity.artifact.name,
    digest: `sha256:${sha256(archive)}`,
    expired: false,
    expires_at: "2026-10-24T00:00:00Z",
    workflow_run: { id: 900, head_sha: identity.run.headCommit },
  };
  const receiptArtifact = {
    ...artifact,
    id: 31,
    name: `package-receipt-${build.platform}-${build.distribution}-${VERSION}-attempt-2`,
  };
  const archives = new Map([[30, archive]]);
  const artifacts = [artifact, receiptArtifact];
  const github = {
    repository: identity.repository,
    json: async () => ({ total_count: artifacts.length, artifacts }),
    bytes: async (path: string) => {
      if (path === "/actions/artifacts/31/zip") return archives.get(31)!;
      if (path === "/actions/artifacts/30/zip") return archives.get(30)!;
      throw new Error(`Unexpected download ${path}`);
    },
  };
  const updateReceipt = (value: unknown) => {
    const bytes = zipSync({ "package-receipt.json": strToU8(JSON.stringify(value)) });
    archives.set(31, bytes);
    receiptArtifact.digest = `sha256:${sha256(bytes)}`;
  };
  updateReceipt(initialReceipt);
  return {
    identity,
    files,
    artifact,
    receiptArtifact,
    artifacts,
    archives,
    github,
    updateReceipt,
    receipt: () => structuredClone(initialReceipt),
    resolve: (request: PackageRequest = identity) =>
      resolvePackageReceipt(github, request, artifacts, NOW),
  };
}

describe("successful package receipts", () => {
  it.each(builds)(
    "binds $platform $distribution to the uploaded bytes and source, apart from workflow code",
    async (build) => {
      const world = fixture(build);
      const result = await world.resolve();
      expect(result.receipt.sourceCommit).toBe("a".repeat(40));
      expect(result.receipt.workflowCommit).toBe("b".repeat(40));
      expect(result.receipt.run.headCommit).toBe("c".repeat(40));
      expect(result.files).toEqual(world.files);
      expect(result.receiptArtifact.id).toBe(31);
      expect(result.archiveSha256).toBe(world.identity.artifact.sha256);
    },
  );

  it("accepts exactly the four final Mac files after notarization and refuses a missing real file", async () => {
    const world = fixture(builds[0]!);
    const base = `Mr-Streamer-${VERSION}-mac-arm64`;
    expect([...world.files.keys()].sort()).toEqual(
      [`${base}.dmg`, `${base}.zip`, `${base}.zip.blockmap`, "latest-mac.yml"].sort(),
    );
    expect((await world.resolve()).files).toEqual(world.files);
    for (const name of world.files.keys()) {
      const incomplete = new Map(world.files);
      incomplete.delete(name);
      expect(() => producePackageReceipt(world.identity, incomplete)).toThrow(/expected exactly/);
    }
    const receipt = world.receipt();
    const files = new Map(world.files);
    files.delete(`${base}.dmg`);
    const archive = zipSync(Object.fromEntries(files));
    world.archives.set(30, archive);
    world.artifact.digest = `sha256:${sha256(archive)}`;
    receipt.artifact.sha256 = sha256(archive);
    world.updateReceipt(receipt);
    await expect(world.resolve()).rejects.toThrow(/missing or additional files/);
  });

  it("keeps stable rebuilds distinct from their nightly source and Store package version", async () => {
    const world = fixture(builds[3]!);
    const nightly = world.receipt();
    const appVersion = "0.0.11";
    const files = new Map(
      [...world.files].map(([name, bytes]) => [name.replace(VERSION, appVersion), bytes]),
    );
    const archive = zipSync(Object.fromEntries(files));
    const identity = {
      ...world.identity,
      appVersion,
      packageVersion: "1.0.11.0",
      artifact: { ...world.identity.artifact, name: `msix-${appVersion}`, sha256: sha256(archive) },
    };
    const stable = producePackageReceipt(identity, files);
    world.archives.set(30, archive);
    world.artifact.name = identity.artifact.name;
    world.artifact.digest = `sha256:${identity.artifact.sha256}`;
    world.receiptArtifact.name = `package-receipt-win-x64-store-${appVersion}-attempt-2`;
    world.updateReceipt(stable);
    expect((await world.resolve(identity)).receipt).toEqual(stable);
    expect(stable.sourceCommit).toBe(nightly.sourceCommit);
    expect(stable.workflowCommit).toBe(nightly.workflowCommit);
    expect(stable.appVersion).toBe("0.0.11");
    expect(stable.packageVersion).toBe("1.0.11.0");
    expect(() =>
      producePackageReceipt({ ...identity, packageVersion: nightly.packageVersion }, files),
    ).toThrow(/packageVersion/);
  });

  it("refuses a producer with an empty, missing or extra installer", () => {
    const world = fixture();
    const installer = `Mr-Streamer-${VERSION}-win-x64-setup.exe`;
    expect(() =>
      producePackageReceipt(
        world.identity,
        new Map([...world.files, [installer, new Uint8Array()]]),
      ),
    ).toThrow(/bytes/);
    world.files.delete(installer);
    expect(() => producePackageReceipt(world.identity, world.files)).toThrow(/expected exactly/);
    world.files.set("other.exe", strToU8("Other setup"));
    expect(() => producePackageReceipt(world.identity, world.files)).toThrow(/expected exactly/);
  });

  it.each([
    ["sourceCommit", "d".repeat(40)],
    ["workflowCommit", "d".repeat(40)],
    ["appVersion", "0.0.11"],
    ["packageVersion", "0.0.11"],
    ["platform", "linux-x64"],
    ["distribution", "store"],
  ] as const)("refuses a request for another %s", async (key, value) => {
    const world = fixture();
    await expect(world.resolve({ ...world.identity, [key]: value })).rejects.toThrow();
  });

  it.each([
    ["schema version", (r: PackageReceipt) => ({ ...r, schemaVersion: 2 }), /schemaVersion/],
    ["failure", (r: PackageReceipt) => ({ ...r, status: "failure" }), /status/],
    [
      "workflow commit",
      (r: PackageReceipt) => ({ ...r, workflowCommit: "d".repeat(40) }),
      /workflowCommit/,
    ],
    ["repository", (r: PackageReceipt) => ({ ...r, repository: "fork/player" }), /repository/],
    ["run", (r: PackageReceipt) => ({ ...r, run: { ...r.run, id: 901 } }), /run.id/],
    ["attempt", (r: PackageReceipt) => ({ ...r, run: { ...r.run, attempt: 1 } }), /run.attempt/],
    [
      "head",
      (r: PackageReceipt) => ({ ...r, run: { ...r.run, headCommit: "f".repeat(40) } }),
      /run.headCommit/,
    ],
    [
      "artifact id",
      (r: PackageReceipt) => ({ ...r, artifact: { ...r.artifact, id: 40 } }),
      /artifact id/,
    ],
    [
      "artifact hash",
      (r: PackageReceipt) => ({ ...r, artifact: { ...r.artifact, sha256: "0".repeat(64) } }),
      /artifact digest/,
    ],
    [
      "unsafe file",
      (r: PackageReceipt) => ({
        ...r,
        files: [{ ...r.files[0], name: "../setup.exe" }, ...r.files.slice(1)],
      }),
      /files/,
    ],
    [
      "duplicate file",
      (r: PackageReceipt) => ({ ...r, files: [...r.files, r.files[0]] }),
      /expected exactly/,
    ],
    [
      "file hash",
      (r: PackageReceipt) => ({
        ...r,
        files: [{ ...r.files[0], sha256: "0".repeat(64) }, ...r.files.slice(1)],
      }),
      /SHA-256/,
    ],
    [
      "file size",
      (r: PackageReceipt) => ({ ...r, files: [{ ...r.files[0], bytes: 1 }, ...r.files.slice(1)] }),
      /byte count/,
    ],
  ] satisfies [string, (r: PackageReceipt) => unknown, RegExp][])(
    "refuses a receipt with wrong %s",
    async (_, spoil, message) => {
      const world = fixture();
      world.updateReceipt(spoil(world.receipt()));
      await expect(world.resolve()).rejects.toThrow(message);
    },
  );

  it("requires the current attempt and one exact receipt artifact", async () => {
    const world = fixture();
    world.receiptArtifact.name = world.receiptArtifact.name.replace("attempt-2", "attempt-1");
    await expect(world.resolve()).rejects.toThrow(/found 0/);
    world.receiptArtifact.name = world.receiptArtifact.name.replace("attempt-1", "attempt-2");
    world.artifacts.push({ ...world.receiptArtifact, id: 32 });
    await expect(world.resolve()).rejects.toThrow(/found 2/);
  });

  it("refuses missing, expired or duplicate package artifacts", async () => {
    const world = fixture();
    world.artifact.expired = true;
    await expect(world.resolve()).rejects.toThrow(/expired/);
    world.artifact.expired = false;
    world.artifacts.push({ ...world.artifact, id: 32 });
    await expect(world.resolve()).rejects.toThrow(/found 2/);
    world.artifacts.splice(0, world.artifacts.length, world.receiptArtifact);
    await expect(world.resolve()).rejects.toThrow(/found 0/);
  });

  it("requires GitHub's digest and recomputes it for both downloads", async () => {
    const world = fixture();
    world.artifact.digest = "";
    await expect(world.resolve()).rejects.toThrow(/artifact digest/);
    world.artifact.digest = `sha256:${world.identity.artifact.sha256}`;
    world.archives.set(30, strToU8("Wrong artifact bytes"));
    await expect(world.resolve()).rejects.toThrow(/does not match its digest/);
    world.archives.set(31, strToU8("Wrong receipt bytes"));
    await expect(world.resolve()).rejects.toThrow(/does not match its digest/);
  });

  it.each([builds[1]!, builds[2]!])(
    "fails modified $platform installers or updater metadata even when the archive digest matches",
    async (build) => {
      for (const file of fixture(build).receipt().files) {
        const world = fixture(build);
        const bytes = zipSync({
          ...Object.fromEntries(world.files),
          [file.name]: strToU8("x".repeat(file.bytes)),
        });
        world.archives.set(30, bytes);
        world.artifact.digest = `sha256:${sha256(bytes)}`;
        const receipt = world.receipt();
        receipt.artifact.sha256 = sha256(bytes);
        world.updateReceipt(receipt);
        await expect(world.resolve()).rejects.toThrow(/SHA-256/);
      }
    },
  );

  it("rejects missing or unexpected package files", async () => {
    const world = fixture();
    const bytes = zipSync({ "unexpected.exe": strToU8("unexpected") });
    world.archives.set(30, bytes);
    world.artifact.digest = `sha256:${sha256(bytes)}`;
    const receipt = world.receipt();
    receipt.artifact.sha256 = sha256(bytes);
    world.updateReceipt(receipt);
    await expect(world.resolve()).rejects.toThrow(/missing or additional files/);
  });

  it("rejects ZIP entries that repeat a file name before extracting them", async () => {
    const world = fixture();
    const archive = Buffer.from(
      zipSync({ "same.exe": strToU8("first"), "dupe.exe": strToU8("second") }),
    );
    const original = Buffer.from("dupe.exe");
    for (
      let offset = archive.indexOf(original);
      offset !== -1;
      offset = archive.indexOf(original, offset + original.length)
    ) {
      archive.set(Buffer.from("same.exe"), offset);
    }
    world.archives.set(30, archive);
    world.artifact.digest = `sha256:${sha256(archive)}`;
    const receipt = world.receipt();
    receipt.artifact.sha256 = sha256(archive);
    world.updateReceipt(receipt);
    await expect(world.resolve()).rejects.toThrow(/repeats same.exe/);
  });

  it("binds both artifacts to the run and head reported by GitHub", async () => {
    const world = fixture();
    world.artifact.workflow_run = { id: 901, head_sha: world.identity.run.headCommit };
    await expect(world.resolve()).rejects.toThrow(/another run or head commit/);
    world.artifact.workflow_run.id = 900;
    world.receiptArtifact.workflow_run = { id: 900, head_sha: "e".repeat(40) };
    await expect(world.resolve()).rejects.toThrow(/another run or head commit/);
  });

  it("reads all artifact pages before reporting absence", async () => {
    const world = fixture();
    const paths: string[] = [];
    const artifacts = await packageArtifacts(
      {
        ...world.github,
        json: async (path) => {
          paths.push(path);
          return {
            total_count: 2,
            artifacts: [paths.length === 1 ? world.artifact : world.receiptArtifact],
          };
        },
      },
      900,
    );
    expect(artifacts).toEqual(world.artifacts);
    expect(paths).toEqual([
      "/actions/runs/900/artifacts?per_page=100&page=1",
      "/actions/runs/900/artifacts?per_page=100&page=2",
    ]);
    await expect(
      packageArtifacts(
        { ...world.github, json: async () => ({ total_count: 1, artifacts: [] }) },
        900,
      ),
    ).rejects.toThrow(/incomplete artifact listing/);
  });

  it.concurrent.each([builds[1]!, builds[2]!])(
    "the workflow CLI binds $platform installers and updater metadata, leaving out unfinished files",
    async (build) => {
      const world = fixture(build);
      const { dir, env, run } = await checkout(world);
      try {
        // Unfinished files are not uploaded, so they must not appear in a success receipt.
        const installer = [...world.files.keys()][0]!;
        await writeFile(join(dir, "dist", `${installer}.part`), "unfinished download");
        const successful = await run();
        expect(successful.status, successful.stderr).toBe(0);
        const receipt = JSON.parse(await readFile(join(dir, "package-receipt.json"), "utf8"));
        expect(receipt).toMatchObject({
          schemaVersion: 1,
          status: "success",
          sourceCommit: env.PACKAGE_SOURCE,
        });
        world.updateReceipt(receipt);
        const resolved = await world.resolve({
          ...world.identity,
          sourceCommit: env.PACKAGE_SOURCE,
        });
        expect(resolved.files).toEqual(world.files);
        expect(resolved.receipt.platform).toBe(build.platform);
        if (build.platform === "linux-x64") {
          const image = `Mr-Streamer-${VERSION}-linux-x86_64.AppImage`;
          const deb = `Mr-Streamer-${VERSION}-linux-amd64.deb`;
          const metadata = parse(new TextDecoder().decode(resolved.files.get("latest-linux.yml")!));
          expect(metadata).toEqual({
            version: VERSION,
            path: image,
            sha512: createHash("sha512").update(resolved.files.get(image)!).digest("base64"),
            files: [image, deb].map((url) => ({
              url,
              sha512: createHash("sha512").update(resolved.files.get(url)!).digest("base64"),
              size: resolved.files.get(url)!.length,
            })),
          });
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    // Each runs git and the receipt CLI as processes, which a busy suite can hold up.
    20_000,
  );

  it.concurrent.each([
    ["another source commit", { PACKAGE_SOURCE: "e".repeat(40) }, null, /checkout is not/],
    ["another app version", { PACKAGE_APP_VERSION: "0.0.11" }, null, /package.json is not/],
    ["a missing installer", {}, "missing", /exact uploaded package set/],
    ["an extra installer", {}, "extra", /exact uploaded package set/],
  ] as const)(
    "the workflow CLI writes no receipt for %s",
    async (_, overrides, change, message) => {
      const world = fixture();
      const { dir, run } = await checkout(world);
      try {
        if (change === "missing") await rm(join(dir, "dist", [...world.files.keys()][0]!));
        if (change === "extra") await writeFile(join(dir, "dist", "other.exe"), "extra installer");
        const failed = await run(overrides);
        expect(failed.status).toBe(1);
        expect(failed.stderr).toMatch(message);
        await expect(readFile(join(dir, "package-receipt.json"))).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

/**
 * A committed checkout with `world`'s package files in dist, and `run`, which runs the receipt CLI
 * in it as the workflow does, with `overrides` on the workflow's environment.
 */
async function checkout(world: ReturnType<typeof fixture>) {
  const dir = await mkdtemp(join(tmpdir(), "package-receipt-cli-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  await writeFile(join(dir, "package.json"), JSON.stringify({ version: VERSION }));
  git("add", "package.json");
  git(
    "-c",
    "user.name=Receipt test",
    "-c",
    "user.email=receipt@example.com",
    "commit",
    "-qm",
    "Synthetic source",
  );
  await mkdir(join(dir, "dist"));
  for (const [name, bytes] of world.files) await writeFile(join(dir, "dist", name), bytes);
  const env = {
    PATH: process.env["PATH"],
    GITHUB_REPOSITORY: world.identity.repository,
    GITHUB_RUN_ID: "900",
    GITHUB_RUN_ATTEMPT: "2",
    PACKAGE_SOURCE: git("rev-parse", "HEAD"),
    PACKAGE_WORKFLOW_COMMIT: world.identity.workflowCommit,
    PACKAGE_APP_VERSION: VERSION,
    PACKAGE_VERSION: VERSION,
    PACKAGE_PLATFORM: world.identity.platform,
    PACKAGE_DISTRIBUTION: "direct",
    PACKAGE_RUN_HEAD: world.identity.run.headCommit,
    PACKAGE_ARTIFACT_ID: "30",
    PACKAGE_ARTIFACT_NAME: world.identity.artifact.name,
    PACKAGE_ARTIFACT_SHA256: world.identity.artifact.sha256,
  };
  const run = async (overrides: Partial<Record<keyof typeof env, string>> = {}) => {
    const child = spawn(process.execPath, [resolve("apps/desktop/scripts/package-receipt.ts")], {
      cwd: dir,
      env: { ...env, ...overrides },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const [status] = (await once(child, "close")) as [number | null];
    return { status, stderr };
  };
  return { dir, env, run };
}
