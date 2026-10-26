import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Exercise the shipping CLI with a saved archive and an Xcode stand-in, without Apple access. */
function candidate(options: { fresh?: boolean; environment?: Partial<NodeJS.ProcessEnv> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ios-distribution-"));
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("EXPO_PUBLIC_")) delete environment[name];
  }
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, options.fresh ? "build" : "build/MrStreamer.xcarchive"), {
    recursive: true,
  });
  cpSync(
    join(import.meta.dirname, "../scripts/testflight.sh"),
    join(root, "scripts/testflight.sh"),
  );
  writeFileSync(join(root, ".gitignore"), "build/\n");
  writeFileSync(
    join(root, "bin/xcodebuild"),
    "#!/bin/sh\ncp build/ExportOptions.plist build/called.plist\n",
    { mode: 0o755 },
  );
  writeFileSync(join(root, "bin/xcbeautify"), "#!/bin/sh\ncat\n", { mode: 0o755 });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  const commit = (message: string) => {
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      message,
    );
  };
  commit("candidate");
  if (!options.fresh) {
    writeFileSync(join(root, "build/source.txt"), `${git("rev-parse", "HEAD")}\n`);
    symlinkSync("main.jsbundle", join(root, "build/MrStreamer.xcarchive/bundle-link"));
    const files = {
      "build/MrStreamer.xcarchive/main.jsbundle": "fixture archive bytes",
      "build/main.jsbundle.map": "fixture map",
      "build/configuration.json": "{}",
      "build/archive-symlinks.json": `${JSON.stringify([["build/MrStreamer.xcarchive/bundle-link", "main.jsbundle"]])}\n`,
    };
    for (const [path, contents] of Object.entries(files)) {
      writeFileSync(join(root, path), contents);
    }
    writeFileSync(
      join(root, "build/archive.sha256"),
      Object.entries(files)
        .map(
          ([path, contents]) => `${createHash("sha256").update(contents).digest("hex")}  ${path}\n`,
        )
        .join(""),
    );
  }
  return {
    run: (...args: string[]) =>
      spawnSync("bash", ["scripts/testflight.sh", ...args], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...environment,
          PATH: `${join(root, "bin")}:${process.env["PATH"]}`,
          APPLE_TEAM_ID: "ABCDEFGHIJ",
          ...options.environment,
        },
      }),
    plist: () => readFileSync(join(root, "build/called.plist"), "utf8"),
    changeBundle: () =>
      writeFileSync(join(root, "build/MrStreamer.xcarchive/main.jsbundle"), "changed bytes"),
    addResource: () =>
      writeFileSync(join(root, "build/MrStreamer.xcarchive/added.txt"), "unrecorded resource"),
    addSymlink: () =>
      symlinkSync("main.jsbundle", join(root, "build/MrStreamer.xcarchive/added-link")),
    removeSymlink: () => rmSync(join(root, "build/MrStreamer.xcarchive/bundle-link")),
    retargetSymlink: () => {
      const path = join(root, "build/MrStreamer.xcarchive/bundle-link");
      rmSync(path);
      symlinkSync("../configuration.json", path);
    },
    orphanMap: () => writeFileSync(join(root, "build/main.jsbundle.map"), "retained map"),
    map: () => readFileSync(join(root, "build/main.jsbundle.map"), "utf8"),
    changeSource: () => {
      writeFileSync(join(root, "changed.txt"), "another source");
      commit("changed");
    },
  };
}

it.each(["app-store", "internal-only"])(
  "exports %s locally with explicit audience and preserved version",
  (intent) => {
    const c = candidate();
    const result = c.run("export", intent);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(c.plist()).toContain("<key>destination</key><string>export</string>");
    expect(c.plist()).toContain("<key>method</key><string>app-store-connect</string>");
    expect(c.plist()).toContain(
      `<key>testFlightInternalTestingOnly</key><${intent === "internal-only" ? "true" : "false"}/>`,
    );
    expect(c.plist()).toContain("<key>manageAppVersionAndBuildNumber</key><false/>");
  },
);

it("requires an explicit intent for export and upload", () => {
  const c = candidate();
  for (const args of [["export"], ["upload"], ["upload", "public"]]) {
    const result = c.run(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
  }
});

it("refuses an archive changed after its source binding", () => {
  const c = candidate();
  c.changeBundle();
  const result = c.run("export", "app-store");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("did NOT match");
  expect(() => c.plist()).toThrow();
});

it.each(["export", "upload"])("refuses added archive resources before %s", (command) => {
  const c = candidate({
    environment: { ASC_KEY_PATH: "/fixture/key", ASC_KEY_ID: "fixture", ASC_ISSUER_ID: "fixture" },
  });
  c.addResource();
  const result = c.run(command, "app-store");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Archive contents differ from the receipt");
  expect(() => c.plist()).toThrow();
});

it.each(
  ["export", "upload"].flatMap((command) =>
    (["addSymlink", "removeSymlink", "retargetSymlink"] as const).map((change) => ({
      command,
      change,
    })),
  ),
)("refuses $change before $command", ({ command, change }) => {
  const c = candidate({
    environment: { ASC_KEY_PATH: "/fixture/key", ASC_KEY_ID: "fixture", ASC_ISSUER_ID: "fixture" },
  });
  c[change]();
  const result = c.run(command, "app-store");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Archive symlinks differ from the receipt");
  expect(() => c.plist()).toThrow();
});

it("requires a new archive when committed source changes", () => {
  const c = candidate();
  c.changeSource();
  const result = c.run("export", "app-store");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("No archive of this commit");
});

it("requires production inputs before starting an archive", () => {
  const c = candidate({ fresh: true, environment: { EXPO_PUBLIC_TMDB_KEY: "" } });
  const result = c.run("archive");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Load the approved production");
});

it("refuses fixture overrides in distribution archives", () => {
  for (const name of [
    "EXPO_PUBLIC_TMDB_API",
    "EXPO_PUBLIC_PROOF_URL",
    "EXPO_PUBLIC_MR_STREAMER_ANALYTICS_LOCAL_ENDPOINT",
  ]) {
    const c = candidate({ fresh: true, environment: { [name]: "http://127.0.0.1:8080" } });
    const result = c.run("archive");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Fixture overrides are not allowed");
  }
});

it("preserves a retained map when the archive has already been moved", () => {
  const c = candidate({ fresh: true });
  c.orphanMap();
  const result = c.run("archive");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Candidate files already exist");
  expect(c.map()).toBe("retained map");
});
