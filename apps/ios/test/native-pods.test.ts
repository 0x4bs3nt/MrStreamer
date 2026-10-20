import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Licences } from "../src/licences.ts";
import { readManifest } from "../scripts/licence-manifest.ts";
import { podProblems } from "../scripts/native-pods.ts";

// The archive's native gate (testflight.sh runs it after prebuild): a Podfile.lock is held to the
// committed inventory and manifest. Each case writes a native project in a temporary directory, its
// pods' sources made as CocoaPods would find them, with react-native and react-native-screens as
// stand-in packages beside it: CI has no iOS install.

const app = join(import.meta.dirname, "..");
const licences: Licences = JSON.parse(readFileSync(join(app, "src/licences.json"), "utf8"));
const manifest = readManifest();
const RN = "0.88.0-rc.4";

/** A pod: its name, resolved version, and external source unless it comes from the specs. */
type Pod = readonly [name: string, version: string, source?: string];

const DEPENDENCIES =
  "../node_modules/react-native/third-party-podspecs/ReactNativeDependencies.podspec";

/** The prebuilt native project as React Native and the app's modules make it. */
const PREBUILT: readonly Pod[] = [
  ["boost", "1.84.0", "build/rndeps-facades/boost"],
  ["RCT-Folly", "2024.11.18.00", "build/rndeps-facades/RCT-Folly"],
  ["SocketRocket", "0.7.1", "build/rndeps-facades/SocketRocket"],
  ["ReactNativeDependencies", RN, DEPENDENCIES],
  ["hermes-engine", "260318099.0.4", "../node_modules/react-native/sdks/hermes-engine"],
  ["React-Core", RN, "build/rncore-facades/React-Core"],
  ["ReactCodegen", RN, "build/generated/ios/ReactCodegen"],
  ["RNScreens", "4.29.0", "../node_modules/react-native-screens"],
  ["TitleFormats", "1.0.0", join(app, "modules/title-formats/ios")],
];

/** Every project a test wrote: one test can write several. */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Writes a native project linking `pods`, making their sources but those named `missing`. */
function project(pods: readonly Pod[], missing: readonly string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "native-pods-"));
  roots.push(root);
  const ios = join(root, "ios");
  for (const [name, version] of [
    ["react-native", RN],
    ["react-native-screens", "4.29.0"],
  ] as const) {
    mkdirSync(join(root, "node_modules", name), { recursive: true });
    writeFileSync(
      join(root, "node_modules", name, "package.json"),
      JSON.stringify({ name, version }),
    );
  }
  for (const [name, , source] of pods) {
    if (!source || missing.includes(name) || source.startsWith(app)) continue;
    const path = join(ios, source);
    mkdirSync(source.endsWith(".podspec") ? dirname(path) : path, { recursive: true });
    if (source.endsWith(".podspec")) writeFileSync(path, "");
  }
  const lock = [
    "PODS:",
    ...pods.map(([name, version]) => `  - ${name} (${version})`),
    "",
    "EXTERNAL SOURCES:",
    ...pods.flatMap(([name, , source]) =>
      source
        ? [`  ${name}:`, `    :${source.endsWith(".podspec") ? "podspec" : "path"}: "${source}"`]
        : [],
    ),
    "",
    "COCOAPODS: 1.16.2",
  ].join("\n");
  mkdirSync(ios, { recursive: true });
  writeFileSync(join(ios, "Podfile.lock"), lock);
  return podProblems(join(ios, "Podfile.lock"), licences, manifest);
}

describe("the native gate", () => {
  it("accepts the project React Native, the packages and the app's modules make", () => {
    expect(project(PREBUILT)).toEqual([]);
    expect(
      project([
        ["SocketRocket", "0.7.1"],
        ["boost", "1.84.0", "../node_modules/react-native/third-party-podspecs/boost.podspec"],
      ]),
    ).toEqual([]);
  });

  it("refuses a component's pod at another version than Licences shows", () => {
    expect(project([["SocketRocket", "0.7.2"]])).toEqual([
      "SocketRocket 0.7.2 resolves, but Licences has SocketRocket 0.7.1",
    ]);
    expect(project([["fmt", "12.2.0", "build/rndeps-facades/fmt"]])).toEqual([
      "fmt 12.2.0 resolves, but Licences has fmt 12.1.0",
    ]);
  });

  it("holds the aggregate to react-native's version, not a component's", () => {
    expect(project([["ReactNativeDependencies", RN, DEPENDENCIES]])).toEqual([]);
    expect(project([["ReactNativeDependencies", "0.7.1", DEPENDENCIES]])).toEqual([
      `ReactNativeDependencies 0.7.1 resolves, but Licences has react-native ${RN}`,
    ]);
  });

  it("refuses a pod inside the project that React Native doesn't generate there", () => {
    expect(project([["NewPod", "1.0.0", "vendor/NewPod"]])).toEqual([
      "NewPod (vendor/NewPod) is in the native project but isn't a pod it generates",
    ]);
    expect(project([["ReactCodegen", RN, "build/generated/other"]])).toEqual([
      "ReactCodegen (build/generated/other) is in the native project but isn't a pod it generates",
    ]);
  });

  it("refuses a missing source and a pod with no notice", () => {
    expect(project([["NewPod", "1.0.0", "vendor/NewPod"]], ["NewPod"])).toEqual([
      "NewPod's source vendor/NewPod is missing",
    ]);
    expect(project([["Mystery", "1.0.0"]])).toEqual([
      "Mystery (from the CocoaPods specs) has no notice in Licences",
    ]);
  });
});
