// Holds a native project's Podfile.lock to the inventory Settings' Licences shows: every pod it
// links must be the version and come from the place Licences describes. scripts/licences.ts
// --pods runs it; testflight.sh does after prebuild.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Licences } from "../src/licences.ts";
import { app, packageNameAt, type Manifest } from "./licence-manifest.ts";

/** Where React Native's prebuilt dependency facades are made, inside the native project. */
const DEPENDENCY_FACADES = "build/rndeps-facades";

/** A section of a Podfile.lock, from its heading to the blank line after it. */
function section(text: string, name: string): string {
  const start = text.indexOf(`\n${name}:\n`);
  if (start < 0) return "";
  const end = text.indexOf("\n\n", start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

/** A component's version, as Licences shows it. */
const versionIn = (licences: Licences, name: string) =>
  licences.components
    .find((each) => each.name === name)
    ?.facts.find((fact) => fact.label === "Version")?.value;

/**
 * What in `lockfile` Licences doesn't account for, a line each; none when every pod is:
 *
 * - a manifest component's pod, at that component's version, from the CocoaPods specs, a
 *   react-native podspec or React Native's prebuilt facade for it;
 * - the aggregate (ReactNativeDependencies), at react-native's version, from react-native;
 * - a pod React Native generates, in the very directory it generates it in;
 * - one of the app's own modules;
 * - or a package Licences lists as native code.
 *
 * Any other pod, or a source that doesn't exist, is a problem.
 */
export function podProblems(lockfile: string, licences: Licences, manifest: Manifest): string[] {
  const text = `\n${readFileSync(lockfile, "utf8")}`;
  const pods = new Map<string, string>();
  for (const [, name = "", version = ""] of section(text, "PODS").matchAll(
    /^ {2}- "?([^\s"/]+)(?:\/[^\s"]+)? \(([^)]+)\)/gm,
  )) {
    pods.set(name, version);
  }
  if (pods.size === 0) return [`${lockfile} lists no pods`];
  const sources = new Map(
    [
      ...section(text, "EXTERNAL SOURCES").matchAll(
        /^ {2}"?([^:"\n]+)"?:\n {4}:(?:path|podspec): "?([^"\n]+)"?/gm,
      ),
    ].map(([, pod = "", source = ""]) => [pod, source] as const),
  );
  const project = dirname(resolve(lockfile));
  const within = (path: string, dir: string) => !relative(dir, path).startsWith("..");
  const native = new Set(
    licences.components
      .filter((each) =>
        each.facts.some((fact) => fact.label === "In the app" && fact.value !== "JavaScript"),
      )
      .map((each) => each.name),
  );
  // Their pins hold: scripts/licences.ts checked them as it generated the inventory.
  const { aggregate, generated } = manifest;
  const problems: string[] = [];

  for (const [pod, version] of [...pods].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    const source = sources.get(pod);
    const path = source === undefined ? null : resolve(project, source);
    if (path && !existsSync(path)) {
      problems.push(`${pod}'s source ${source} is missing`);
      continue;
    }
    const where = source === undefined ? "from the CocoaPods specs" : source;

    if (pod === aggregate.pod) {
      const expected = versionIn(licences, aggregate.versionOf);
      if (version !== expected) {
        problems.push(
          `${pod} ${version} resolves, but Licences has ${aggregate.versionOf} ${expected}`,
        );
      }
      if (!path || packageNameAt(path) !== aggregate.versionOf) {
        problems.push(`${pod} comes ${where}, not from ${aggregate.versionOf}`);
      }
      continue;
    }

    const component = manifest.components.find((entry) => entry.pods?.includes(pod));
    if (component) {
      if (version !== component.version) {
        problems.push(
          `${pod} ${version} resolves, but Licences has ${component.name} ${component.version}`,
        );
      }
      const facade = path !== null && relative(project, path) === join(DEPENDENCY_FACADES, pod);
      if (path && !facade && packageNameAt(path) !== "react-native") {
        problems.push(`${pod} comes from ${source}, not where ${component.name}'s pins say`);
      }
      continue;
    }

    if (!path) {
      problems.push(`${pod} (${where}) has no notice in Licences`);
    } else if (within(path, project)) {
      const expected = generated.pods[pod];
      if (expected === undefined || relative(project, path) !== expected) {
        problems.push(`${pod} (${source}) is in the native project but isn't a pod it generates`);
      }
    } else if (within(path, join(app, "modules"))) {
      // The app's own modules, under the app's licence.
    } else {
      const name = packageNameAt(path);
      if (!name || !native.has(name)) problems.push(`${pod} (${source}) has no notice in Licences`);
    }
  }
  return problems;
}
