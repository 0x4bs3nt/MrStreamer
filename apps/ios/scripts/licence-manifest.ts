// licences/manifest.json and what reading it needs, shared by scripts/licences.ts, which
// generates the inventory, and scripts/native-pods.ts, which holds a native project to it.
import { type } from "arktype";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** apps/ios. */
export const app = resolve(import.meta.dirname, "..");

export const TextSource = type({
  repo: "string",
  ref: "string",
  path: "string",
  "lines?": ["number", "number"],
});
export type TextSource = typeof TextSource.infer;

/** A line `file`, relative to apps/ios, must hold for the manifest to describe the build. */
const Pin = type({ file: "string", text: "string" });
type Pin = typeof Pin.infer;

const Manifest = type({
  "$comment?": "string",
  components: type({
    name: "string",
    version: "string",
    licence: "string",
    source: "string",
    "facts?": type({ label: "string", value: "string" }).array(),
    pins: Pin.array(),
    "configuration?": { file: "string", from: "string", to: "string", without: "string[]" },
    /** The pods carrying it, each resolved at its version. */
    "pods?": "string[]",
    texts: TextSource.array(),
  }).array(),
  /** One pod carrying several components, resolved at the version of the package `versionOf`. */
  aggregate: {
    "$comment?": "string",
    pod: "string",
    versionOf: "string",
    components: "string[]",
    pins: Pin.array(),
  },
  /** Pods React Native generates inside the native project, by the directory each is made in. */
  generated: {
    "$comment?": "string",
    pods: type({ "[string]": "string" }),
    pins: Pin.array(),
  },
  packages: type({ "[string]": { reason: "string", texts: TextSource.array() } }),
});
export type Manifest = typeof Manifest.infer;

export const PackageJson = type({
  name: "string",
  version: "string",
  "license?": "unknown",
});

/** Where a component's version goes in its pins, source and text refs. */
const VERSION = "{version}";

/**
 * The manifest (licences/manifest.json unless `file` names another), with each component's
 * `{version}` filled in from its `version`. The version is written once: every component needs a
 * pin with `{version}`, so a version the file that really pins it doesn't hold fails that pin, and
 * its source and texts follow it. Throws when a component has no such pin.
 */
export function readManifest(file = join(app, "licences/manifest.json")): Manifest {
  const manifest = Manifest.assert(JSON.parse(readFileSync(file, "utf8")));
  const unpinned = manifest.components.filter(
    ({ pins }) => !pins.some(({ text }) => text.includes(VERSION)),
  );
  if (unpinned.length) {
    throw new Error(
      `${unpinned.map(({ name }) => name).join(", ")} in ${file} pin no version: give a pin "${VERSION}" where its version is set`,
    );
  }
  return {
    ...manifest,
    components: manifest.components.map((entry) => {
      const at = (text: string) => text.replaceAll(VERSION, entry.version);
      return {
        ...entry,
        source: at(entry.source),
        pins: entry.pins.map((pin) => ({ ...pin, text: at(pin.text) })),
        texts: entry.texts.map((text) => ({ ...text, ref: at(text.ref) })),
      };
    }),
  };
}

/** What of `pins` no longer holds, as a line each. */
export const pinProblems = (owner: string, pins: readonly Pin[]): string[] =>
  pins.flatMap(({ file, text }) => {
    const path = join(app, file);
    if (!existsSync(path)) return [`${owner}'s pin ${file} is missing`];
    if (readFileSync(path, "utf8").includes(text)) return [];
    return [`${file} no longer has "${text}": ${owner} changed. Update licences/manifest.json.`];
  });

/** The directory of the package a path inside node_modules belongs to. */
export function packageRoot(file: string): string | null {
  const at = file.lastIndexOf(`node_modules${sep}`);
  if (at < 0) return null;
  const [scope, name] = file.slice(at + `node_modules${sep}`.length).split(sep);
  if (!scope) return null;
  return (
    file.slice(0, at) + join("node_modules", scope.startsWith("@") ? `${scope}/${name}` : scope)
  );
}

/** The name of the npm package an existing path is in, if any. */
export function packageNameAt(path: string): string | null {
  const root = packageRoot(realpathSync(path));
  if (!root) return null;
  return PackageJson.assert(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).name;
}
