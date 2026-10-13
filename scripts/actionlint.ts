// Lints the GitHub Actions workflows with actionlint, which runs shellcheck on every run: step, at
// pinned versions, so a contributor's machine and CI's Check job report the same things:
//
//   pnpm actionlint [actionlint's own options]
//
// Each tool is downloaded once from its GitHub release into node_modules/.cache/actionlint,
// checked against the SHA-256 pinned below, and unpacked there. .github/actionlint.yaml holds
// actionlint's settings. To move to a newer release, change its version and every checksum: the
// actionlint release lists them, and shellcheck's are those of the files it publishes.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The platforms the tools publish builds for, as Node names them: `${platform}-${arch}`. */
type Host = "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64" | "win32-x64";

/** One tool's release: where each platform's archive is, its checksum, and the program inside. */
interface Tool {
  readonly name: string;
  readonly version: string;
  /** The archive's address for a host's file name. */
  readonly url: (file: string) => string;
  readonly files: Readonly<Record<Host, { readonly file: string; readonly sha256: string }>>;
  /** The program's path inside the unpacked archive. */
  readonly program: (host: Host) => string;
}

const ACTIONLINT: Tool = {
  name: "actionlint",
  version: "1.7.12",
  url: (file) => `https://github.com/rhysd/actionlint/releases/download/v1.7.12/${file}`,
  files: {
    "linux-x64": {
      file: "actionlint_1.7.12_linux_amd64.tar.gz",
      sha256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
    },
    "linux-arm64": {
      file: "actionlint_1.7.12_linux_arm64.tar.gz",
      sha256: "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
    },
    "darwin-x64": {
      file: "actionlint_1.7.12_darwin_amd64.tar.gz",
      sha256: "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644",
    },
    "darwin-arm64": {
      file: "actionlint_1.7.12_darwin_arm64.tar.gz",
      sha256: "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
    },
    "win32-x64": {
      file: "actionlint_1.7.12_windows_amd64.zip",
      sha256: "6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9",
    },
  },
  program: (host) => (host === "win32-x64" ? "actionlint.exe" : "actionlint"),
};

const SHELLCHECK: Tool = {
  name: "shellcheck",
  version: "0.11.0",
  url: (file) => `https://github.com/koalaman/shellcheck/releases/download/v0.11.0/${file}`,
  files: {
    "linux-x64": {
      file: "shellcheck-v0.11.0.linux.x86_64.tar.xz",
      sha256: "8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198",
    },
    "linux-arm64": {
      file: "shellcheck-v0.11.0.linux.aarch64.tar.xz",
      sha256: "12b331c1d2db6b9eb13cfca64306b1b157a86eb69db83023e261eaa7e7c14588",
    },
    "darwin-x64": {
      file: "shellcheck-v0.11.0.darwin.x86_64.tar.xz",
      sha256: "3c89db4edcab7cf1c27bff178882e0f6f27f7afdf54e859fa041fca10febe4c6",
    },
    "darwin-arm64": {
      file: "shellcheck-v0.11.0.darwin.aarch64.tar.xz",
      sha256: "56affdd8de5527894dca6dc3d7e0a99a873b0f004d7aabc30ae407d3f48b0a79",
    },
    "win32-x64": {
      file: "shellcheck-v0.11.0.zip",
      sha256: "8a4e35ab0b331c85d73567b12f2a444df187f483e5079ceffa6bda1faa2e740e",
    },
  },
  program: (host) => (host === "win32-x64" ? "shellcheck.exe" : "shellcheck-v0.11.0/shellcheck"),
};

const CACHE = resolve("node_modules/.cache/actionlint");

/** This machine as the tools' releases name it, or a failure naming what they cover. */
function host(): Host {
  const name = `${process.platform}-${process.arch}`;
  const known = Object.keys(ACTIONLINT.files);
  const found = known.find((each): each is Host => each === name);
  if (!found) throw new Error(`actionlint runs here on ${known.join(", ")}, not ${name}.`);
  return found;
}

/**
 * The folder `tool` is unpacked in for `on`, downloading and checking it first when it isn't there
 * yet. A download whose checksum differs is deleted and fails the run.
 */
async function install(tool: Tool, on: Host): Promise<string> {
  const folder = join(CACHE, `${tool.name}-${tool.version}-${on}`);
  if (existsSync(join(folder, tool.program(on)))) return folder;
  const { file, sha256 } = tool.files[on];
  const response = await fetch(tool.url(file));
  if (!response.ok) throw new Error(`${tool.url(file)} answered HTTP ${response.status}.`);
  const archive = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== sha256) {
    throw new Error(`${file} has SHA-256 ${actual}, not the pinned ${sha256}.`);
  }
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, file), archive);
  // tar reads all three archive kinds: bsdtar on macOS and Windows unpacks ZIP files too.
  execFileSync("tar", ["-xf", file], { cwd: folder, stdio: "inherit" });
  rmSync(join(folder, file));
  return folder;
}

async function main(): Promise<number> {
  const on = host();
  const actionlint = join(await install(ACTIONLINT, on), ACTIONLINT.program(on));
  const shellcheck = join(await install(SHELLCHECK, on), SHELLCHECK.program(on));
  // No step runs Python, and a pyflakes on one machine's PATH alone would make them disagree.
  const { status } = spawnSync(
    actionlint,
    ["-shellcheck", shellcheck, "-pyflakes=", ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  return status ?? 1;
}

if (import.meta.main) {
  process.exitCode = await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  });
}
