import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import {
  STORE_APP,
  STORE_NAME,
  packageRecord,
  storeGate,
  storeRelease,
  verifyPackage,
  type Artifact,
  type GitHub,
  type StoreRelease,
  type TaggedRelease,
  type WorkflowRun,
} from "../scripts/store-release.ts";
import { storedZip } from "../scripts/zip.ts";
import { removeArtifacts, writeArtifact, type Built } from "./fake-store.ts";

const COMMIT = "5f3a9c".padEnd(40, "0");
const MAIN = "refs/heads/main";
const PUBLISHED: TaggedRelease = {
  draft: false,
  prerelease: false,
  publishedAt: "2026-10-05T10:00:00Z",
  notes: "**Stable**",
};
/** A stable release run: started by hand, from main, in the repository itself. */
const STABLE_RUN: WorkflowRun = {
  path: ".github/workflows/release.yml",
  event: "workflow_dispatch",
  branch: "main",
  headRepository: "owner/app",
};

interface Fixture {
  releases: Record<string, TaggedRelease>;
  commits: Record<string, string>;
  histories: Record<string, string>;
  runs: Record<number, WorkflowRun>;
  artifacts: Record<string, Artifact[]>;
  environment: Awaited<ReturnType<GitHub["environment"]>>;
}

/**
 * A repository that released 0.0.5 from COMMIT, on main, in run 77, with the Store's environment
 * set up for main. Tags and comparisons it wasn't told about throw.
 */
function github(overrides: Partial<Fixture> = {}): GitHub {
  const fixture: Fixture = {
    releases: { "v0.0.5": PUBLISHED },
    commits: { "v0.0.5": COMMIT },
    histories: { [`${COMMIT}...main`]: "ahead" },
    runs: { 77: STABLE_RUN },
    artifacts: {},
    environment: ["main"],
    ...overrides,
  };
  return {
    repository: "owner/app",
    defaultBranch: "main",
    async release(tag) {
      return fixture.releases[tag] ?? null;
    },
    async commitOf(tag) {
      const commit = fixture.commits[tag];
      if (!commit) throw new Error(`Unknown tag ${tag}`);
      return commit;
    },
    async compare(base, head) {
      const history = fixture.histories[`${base}...${head}`];
      if (!history) throw new Error(`Unexpected comparison ${base}...${head}`);
      return history;
    },
    async run(id) {
      return fixture.runs[id] ?? null;
    },
    async artifacts(name) {
      return fixture.artifacts[name] ?? [];
    },
    async environment() {
      return fixture.environment;
    },
  };
}

const RELEASE: StoreRelease = {
  version: "0.0.5",
  tag: "v0.0.5",
  commit: COMMIT,
  packageVersion: "1.0.5.0",
  notes: "**Stable**",
  run: 77,
};

/** The artifact of a build of RELEASE whose manifest or record says `wrong` instead. */
const built = (wrong: Partial<Built> = {}) => writeArtifact({ ...RELEASE, ...wrong });

/**
 * A manifest as electron-builder writes it, its layout copied from the 0.0.7 package: each identity
 * attribute on a line of its own, the publisher alone in single quotes, and by default the name
 * from before the Store name.
 */
const builderManifest = ({
  publisher = STORE_APP.publisher as string,
  name = "Mr. Streamer",
  startName = name,
  publisherName = "Mr Streamer OSS",
  applicationId = "MrStreamer",
}: Partial<
  Record<"publisher" | "name" | "startName" | "publisherName" | "applicationId", string>
> = {}) => `<?xml version="1.0" encoding="utf-8"?>
<!--suppress XmlUnusedNamespaceDeclaration -->
<Package
   xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
   xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
   xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
   xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities">
  <!-- use single quotes to avoid double quotes escaping in the publisher value  -->
  <Identity Name="${STORE_APP.identityName}"
    ProcessorArchitecture="${STORE_APP.architecture}"
    Publisher='${publisher}'
    Version="${RELEASE.packageVersion}" />
  <Properties>
    <DisplayName>${name}</DisplayName>
    <PublisherDisplayName>${publisherName}</PublisherDisplayName>
    <Description>A clean, fast, open-source IPTV player for macOS, Windows and Linux.</Description>
    <Logo>assets\\StoreLogo.png</Logo>
  </Properties>
  <Applications>
    <Application Id="${applicationId}" Executable="app\\Mr. Streamer.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
       BackgroundColor="#000000"
       DisplayName="${startName}"
       Square150x150Logo="assets\\Square150x150Logo.png"
       Square44x44Logo="assets\\Square44x44Logo.png"
       Description="A clean, fast, open-source IPTV player for macOS, Windows and Linux.">
      </uap:VisualElements>
    </Application>
  </Applications>
</Package>
`;

/** The artifact of a build of RELEASE whose package holds `manifest` as it is. */
function builtWith(manifest: string): { dir: string; sha256: string } {
  const { dir } = built();
  const path = join(dir, "Mr-Streamer-0.0.5-win-x64.msix");
  const file = storedZip("AppxManifest.xml", Buffer.from(manifest));
  const sha256 = createHash("sha256").update(file).digest("hex");
  const described: Record<string, string> = JSON.parse(readFileSync(`${path}.json`, "utf8"));
  writeFileSync(path, file);
  writeFileSync(`${path}.json`, JSON.stringify({ ...described, sha256 }));
  return { dir, sha256 };
}

afterAll(removeArtifacts);

describe("whether the Store workflow may run", () => {
  const ask = (action: string, enabled: string | undefined, releaseRun = false, ref = MAIN) => ({
    action,
    enabled,
    ref,
    releaseRun,
  });

  it("leaves the Store alone after a release while submissions are off, without failing the run", async () => {
    for (const enabled of [undefined, "", "false"]) {
      expect(await storeGate(github(), ask("submit", enabled, true))).toContain(
        "Microsoft Store submissions are off",
      );
    }
  });

  it("refuses to submit by hand while submissions are off", async () => {
    await expect(storeGate(github(), ask("submit", undefined))).rejects.toThrow(
      "submissions are off",
    );
  });

  it("goes ahead once submissions are on, and with the read-only actions before that", async () => {
    expect(await storeGate(github(), ask("submit", "true", true))).toBeNull();
    expect(await storeGate(github(), ask("preflight", undefined))).toBeNull();
    expect(await storeGate(github(), ask("status", undefined))).toBeNull();
  });

  it("runs from main alone", async () => {
    await expect(
      storeGate(github(), ask("preflight", "true", false, "refs/heads/feature")),
    ).rejects.toThrow("from main");
  });

  it("stops before a job could create the environment, open to every branch", async () => {
    await expect(
      storeGate(github({ environment: null }), ask("submit", "true", true)),
    ).rejects.toThrow("environment doesn't exist");
  });

  it.each([
    ["any", "any branches"],
    ["protected", "protected branches"],
    [["main", "release/*"], "main, release/*"],
    [["main", "tag:v*"], "main, tag:v*"],
    [[], "nothing"],
  ] as const)(
    "refuses an environment that allows %j, not main alone",
    async (environment, named) => {
      await expect(storeGate(github({ environment }), ask("preflight", "true"))).rejects.toThrow(
        `allows ${named}`,
      );
    },
  );

  it("knows no other action", async () => {
    await expect(storeGate(github(), ask("delete", "true"))).rejects.toThrow("not preflight");
  });
});

describe("the release a submission is for", () => {
  it("is a published stable release whose tag is on main", async () => {
    expect(await storeRelease(github(), { version: "0.0.5", withPackage: false })).toEqual({
      ...RELEASE,
      run: null,
    });
  });

  it("is never a nightly, a draft, a pre-release or a version without a release", async () => {
    const nightly = "0.0.6-nightly.20261005.40";
    const repo = github({
      releases: {
        [`v${nightly}`]: { ...PUBLISHED, prerelease: true },
        "v0.0.6": { ...PUBLISHED, draft: true, publishedAt: null },
        "v0.0.7": { ...PUBLISHED, prerelease: true },
      },
    });
    const refused = (version: string) =>
      expect(storeRelease(repo, { version, withPackage: false })).rejects;

    await refused(nightly).toThrow("not a stable version");
    await refused("v0.0.5").toThrow("not a stable version");
    await refused("0.0.6").toThrow("a draft or a pre-release");
    await refused("0.0.7").toThrow("a draft or a pre-release");
    await refused("0.0.8").toThrow("No published release is tagged v0.0.8");
  });

  it("is refused when its tag points at another commit than the run built", async () => {
    await expect(
      storeRelease(github(), { version: "0.0.5", sha: "another-commit", withPackage: false }),
    ).rejects.toThrow(`v0.0.5 points at ${COMMIT}, not at another-commit`);
  });

  it("is refused when main doesn't contain its commit", async () => {
    const repo = github({ histories: { [`${COMMIT}...main`]: "diverged" } });

    await expect(storeRelease(repo, { version: "0.0.5", withPackage: false })).rejects.toThrow(
      "main does not contain",
    );
  });
});

describe("the run a package comes from", () => {
  const from = (repo: GitHub, run?: number) =>
    storeRelease(repo, { version: "0.0.5", sha: COMMIT, run, withPackage: true });

  it("is the release's own run when that asks", async () => {
    expect(await from(github(), 77)).toMatchObject({ run: 77, commit: COMMIT });
  });

  it.each([
    ["another workflow", { path: ".github/workflows/ci.yml" }, "ran .github/workflows/ci.yml"],
    ["a dry run", { event: "pull_request", branch: "feature" }, "was started by pull_request"],
    ["another branch", { branch: "feature" }, "ran on feature"],
    ["a fork's code", { headRepository: "someone/app" }, "ran another repository's code"],
  ])("is never %s", async (_, change, reason) => {
    const repo = github({ runs: { 77: { ...STABLE_RUN, ...change } } });

    await expect(from(repo, 77)).rejects.toThrow(`Run 77 ${reason}`);
    await expect(from(github(), 78)).rejects.toThrow("Run 78 doesn't exist");
  });

  it("is the newest stable release run that still holds the package, when asked by hand", async () => {
    const at = (day: number, runId: number, expired = false): Artifact => ({
      runId,
      expired,
      createdAt: `2026-10-0${day}T10:00:00Z`,
    });
    const repo = github({
      runs: { 70: STABLE_RUN, 77: STABLE_RUN, 80: { ...STABLE_RUN, branch: "feature" } },
      artifacts: { "msix-0.0.5": [at(1, 70), at(2, 77), at(3, 80), at(4, 81), at(5, 77, true)] },
    });

    expect(await from(repo)).toMatchObject({ run: 77 });
  });

  it("is missing once no run holds the package any more", async () => {
    const expired = github({
      artifacts: {
        "msix-0.0.5": [{ runId: 77, expired: true, createdAt: "2026-06-01T10:00:00Z" }],
      },
    });

    await expect(from(expired)).rejects.toThrow("No run holds the artifact msix-0.0.5 any more");
  });
});

describe("the package a run kept", () => {
  it("is the release's when its record, checksum and manifest all say so", () => {
    const { dir, sha256 } = built();

    expect(verifyPackage(RELEASE, dir, sha256)).toEqual({
      path: join(dir, "Mr-Streamer-0.0.5-win-x64.msix"),
      fileName: `Mr-Streamer-0.0.5-win-x64.5f3a9c000000.${sha256.slice(0, 16)}.msix`,
      sha256,
      displayName: STORE_NAME,
    });
  });

  it("is the release's with the manifest electron-builder writes, its publisher in single quotes", () => {
    const { dir, sha256 } = builtWith(builderManifest());

    expect(verifyPackage(RELEASE, dir, sha256)).toMatchObject({
      sha256,
      displayName: "Mr. Streamer",
    });
    const elsewhere = builderManifest({ publisher: "CN=Someone Else" });
    expect(() => verifyPackage(RELEASE, builtWith(elsewhere).dir)).toThrow(
      `The package's publisher is "CN=Someone Else"`,
    );
  });

  it.each([
    ["identity name", { identityName: "Someone.Else" }],
    ["publisher", { publisher: "CN=Someone Else" }],
    ["architecture", { architecture: "arm64" }],
    // A dry run's test package, which the Store would refuse too.
    ["version", { manifestVersion: "1.0.4.14" }],
  ])("is refused when its manifest has another %s", (what, wrong) => {
    expect(() => verifyPackage(RELEASE, built(wrong).dir)).toThrow(`The package's ${what} is`);
  });

  it("is refused when its checksum isn't the one the build job reported", () => {
    const { dir } = built();

    expect(() => verifyPackage(RELEASE, dir, "0".repeat(64))).toThrow(
      "The checksum the build job reported",
    );
  });

  it("is refused when its record names another commit, or is missing", () => {
    expect(() => verifyPackage(RELEASE, built({ commit: "another-commit" }).dir)).toThrow(
      "The record's commit",
    );

    const { dir } = built();
    rmSync(join(dir, "Mr-Streamer-0.0.5-win-x64.msix.json"));
    expect(() => verifyPackage(RELEASE, dir)).toThrow("no record of the package");
  });

  it("is refused when the file isn't the one its record describes", () => {
    const { dir } = built();
    const record = join(dir, "Mr-Streamer-0.0.5-win-x64.msix.json");
    const described: Record<string, string> = JSON.parse(readFileSync(record, "utf8"));
    writeFileSync(record, JSON.stringify({ ...described, sha256: "0".repeat(64) }));

    expect(() => verifyPackage(RELEASE, dir)).toThrow("The record's checksum");
  });

  it("carries the identity and the name electron-builder builds the package with", () => {
    const builder: { appx: Record<string, unknown> } = parse(
      readFileSync("apps/desktop/electron-builder.yml", "utf8"),
    );

    expect(builder.appx).toMatchObject({
      identityName: STORE_APP.identityName,
      publisher: STORE_APP.publisher,
      publisherDisplayName: STORE_APP.publisherDisplayName,
      applicationId: STORE_APP.applicationId,
      displayName: STORE_NAME,
    });
  });
});

describe("the package a stable release or dry run builds", () => {
  const msix = Buffer.from("the package's bytes");
  const storeManifest = (wrong: Parameters<typeof builderManifest>[0] = {}) =>
    builderManifest({ name: STORE_NAME, ...wrong });

  it("is recorded with its release, Store version, commit and checksum when Partner Center's identity is all there", () => {
    expect(packageRecord(storeManifest(), msix, { version: "0.0.5", commit: COMMIT })).toEqual({
      version: "0.0.5",
      packageVersion: "1.0.5.0",
      commit: COMMIT,
      sha256: createHash("sha256").update(msix).digest("hex"),
    });
  });

  it.each([
    ["publisher", { publisher: "CN=Someone Else" }, "The package's publisher"],
    ["publisher's name", { publisherName: "Mr. Streamer OSS" }, "The publisher's name"],
    ["application id", { applicationId: "App" }, "The application id"],
    ["name, from before the Store name", { name: "Mr. Streamer" }, "The package's name"],
    ["Start entry's name", { startName: "Mr. Streamer" }, "The Start entry's name"],
  ])("is refused with another %s", (_, wrong, message) => {
    expect(() =>
      packageRecord(storeManifest(wrong), msix, { version: "0.0.5", commit: COMMIT }),
    ).toThrow(message);
  });

  it("is refused with another release's Store version", () => {
    expect(() =>
      packageRecord(storeManifest(), msix, { version: "0.0.6", commit: COMMIT }),
    ).toThrow(`The package's version is "1.0.5.0", not "1.0.6.0"`);
  });
});
