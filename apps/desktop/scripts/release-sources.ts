// Prepares the source archives a release attaches for what the installers carry: FFmpeg and x264,
// Chromium's FFmpeg and Electron, and the NSIS plug-ins of the Windows setup. "sources" in
// licences.config.json lists them.
//
//   node scripts/release-sources.ts <folder>
//
// Each archive lands in the folder under the name the notices link. A download has to match its
// pinned SHA-256; a repository is fetched at its pinned commit and archived from there. Then the
// notices of the build in out/, which `pnpm build` wrote, are read: every file they link on this
// release has to be in the folder, and every file in the folder has to be linked. The release
// workflow runs this for dry runs too, so a missing source shows before a release needs it.
// Needs git and curl.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { type } from "arktype";
import { NoticeManifest } from "@mrstreamer/contracts/licences";
import { linkProblems, releaseSources, type Source } from "./licences.ts";

const run = promisify(execFile);

/**
 * Puts `source` in `folder` under its name and returns its full path. Throws, leaving no file,
 * when a download differs from its SHA-256 or a repository doesn't hold the commit.
 */
export async function prepare(source: Source, folder: string): Promise<string> {
  // Resolved here, because git writes the archive from inside its temporary repository, where a
  // folder relative to this process would name another place.
  const path = resolve(folder, source.file);
  await mkdir(folder, { recursive: true });
  if ("url" in source) {
    await run("curl", ["-sSfL", "--retry", "4", "--retry-all-errors", "-o", path, source.url]);
    const found = await sha256(path);
    if (found !== source.sha256) {
      await rm(path);
      throw new Error(`${source.url} has SHA-256 ${found}, not the pinned ${source.sha256}.`);
    }
    return path;
  }
  const repository = await mkdtemp(join(tmpdir(), "mrstreamer-source-"));
  try {
    const git = (...args: string[]) => run("git", ["-C", repository, ...args]);
    await git("init", "-q");
    await git("fetch", "-q", "--depth", "1", source.git, source.commit);
    // Git checks what it fetched against the hash it asked for; this guards against a ref.
    const fetched = (await git("rev-parse", "FETCH_HEAD")).stdout.trim();
    if (fetched !== source.commit) {
      throw new Error(`${source.git} gave ${fetched}, not the pinned ${source.commit}.`);
    }
    const prefix = `${source.file.slice(0, -".tar.gz".length)}/`;
    await git("archive", "--format=tar.gz", `--prefix=${prefix}`, "-o", path, "FETCH_HEAD");
    return path;
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

export async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

if (import.meta.main) {
  const folder = process.argv[2];
  if (!folder) throw new Error("Usage: node scripts/release-sources.ts <folder>");
  const root = join(import.meta.dirname, "..");
  const { version } = type({ version: "string" }).assert(
    JSON.parse(await readFile(join(root, "package.json"), "utf8")),
  );

  for (const source of await releaseSources(root)) {
    const path = await prepare(source, folder);
    const { size } = await stat(path);
    console.log(`${await sha256(path)}  ${source.file}  ${(size / 2 ** 20).toFixed(1)} MB`);
  }

  const manifest = NoticeManifest().assert(
    JSON.parse(await readFile(join(root, "out", "licences", "third-party.json"), "utf8")),
  );
  const files = await readdir(folder);
  const problems = linkProblems(manifest.notices, version, files);
  if (problems.length > 0) {
    throw new Error(
      `The notices and the sources of ${version} differ:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
  }
  console.log(`The notices of ${version} link all ${files.length} sources, and nothing else.`);
  // For the workflow's publish job, which checks that each of these reached the release.
  const output = process.env["GITHUB_OUTPUT"];
  if (output) await appendFile(output, `files=${files.join(" ")}\n`);
}
