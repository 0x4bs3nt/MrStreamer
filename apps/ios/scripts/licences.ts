// Generates src/licences.json, the notices Settings' Licences shows offline, from what the build
// really carries:
//
// - JavaScript: the release bundle, made as the Xcode build makes it (`expo export:embed`), whose
//   source map names every file in it. Each node_modules file names its package; a licence file
//   between that file and its package's root, as vendored code has, comes along.
// - Native code: the modules Expo's autolinking links into the iOS project, read from this
//   install, and React Native's own pods.
// - licences/manifest.json: what isn't an npm package (FFmpeg, Hermes and React Native's
//   third-party pods), and texts for packages published without one. Each pin there must be a
//   line of the file that really pins it, so an upgrade fails here until the manifest follows.
// - The app, under its GPL-3.0-only licence, with its own native modules.
//
// A package with no licence text fails the run; nothing is left out quietly. The output is sorted
// and holds no paths or dates, so the same install makes the same file.
//
//   node scripts/licences.ts                writes src/licences.json
//   node scripts/licences.ts --check        fails when src/licences.json isn't what it would write
//   node scripts/licences.ts --check --pods ios/Podfile.lock
//                                           also fails when a pod the native project links isn't
//                                           one Licences describes, at its version
//                                           (scripts/native-pods.ts; testflight.sh, after prebuild)
//   node scripts/licences.ts --fetch        downloads the manifest's texts into licences/texts
//                                           at their pinned tags, after the manifest changed
import { type } from "arktype";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import type { Component, Fact, Licences, Notice } from "../src/licences.ts";
import {
  app,
  PackageJson,
  packageRoot,
  pinProblems,
  readManifest,
  type TextSource,
  type Manifest,
} from "./licence-manifest.ts";
import { podProblems } from "./native-pods.ts";

const repository = resolve(app, "../..");
const output = join(app, "src/licences.json");
const texts = join(app, "licences/texts");
const APP_SOURCE = "https://github.com/Mr-Streamer-OSS/MrStreamer";

/** A file named as a licence, notice or patent grant is: LICENSE, LICENSE.md, COPYING, NOTICE… */
const LICENCE_FILE = /^(?:licen[cs]e|copying|notice|patents|unlicense)(?:[-._].*)?$/i;

const SourceMap = type({ sections: type({ map: { sources: "string[]" } }).array() });

const Autolinked = type({
  modules: type({
    packageName: "string",
    packageVersion: "string",
    pods: type({ podName: "string", podspecDir: "string" }).array(),
  }).array(),
});

const ReactNativeConfig = type({
  dependencies: type({
    "[string]": { root: "string", platforms: { "ios?": "object | null" } },
  }),
});

/** Stops the run with what to do about it. */
function fail(message: string): never {
  console.error(`licences: ${message}`);
  process.exit(1);
}

/** The licence files in `dir`, sorted. */
const licenceFiles = (dir: string) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENCE_FILE.test(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort();

/** Text as the app keeps it: Unix line ends, no trailing blank lines. */
const normalized = (text: string) => text.replaceAll("\r\n", "\n").trimEnd();

/** Where a manifest text is kept, and its title in the app. */
function textFile({ repo, ref, path, lines }: TextSource) {
  const file = join(texts, repo, ref, lines ? `${path}.L${lines[0]}-${lines[1]}` : path);
  return { file, title: `${repo} ${path}${lines ? `, lines ${lines[0]} to ${lines[1]}` : ""}` };
}

/** Collects texts once each, under a key derived from the text. */
class TextStore {
  readonly byKey = new Map<string, string>();
  add(text: string): string {
    const body = normalized(text);
    if (!body) fail("an empty licence text");
    const key = createHash("sha256").update(body).digest("hex").slice(0, 16);
    this.byKey.set(key, body);
    return key;
  }
  notice(title: string, text: string): Notice {
    return { title, text: this.add(text) };
  }
}

/** A package found in the bundle or linked natively, with the licence directories it brought. */
interface Found {
  readonly root: string;
  javascript: boolean;
  native: boolean;
  /** Directories under the root, vendored code's, whose licence files come along. */
  readonly within: Set<string>;
}

/** Makes the release bundle in a temporary directory and returns its source map's sources. */
function bundleSources(): string[] {
  const out = mkdtempSync(join(tmpdir(), "mrstreamer-licences-"));
  try {
    execFileSync(
      join(app, "node_modules/.bin/expo"),
      [
        "export:embed",
        ...["--platform", "ios", "--dev", "false", "--entry-file", "index.ts"],
        ...["--bundle-output", join(out, "main.jsbundle")],
        ...["--sourcemap-output", join(out, "main.map")],
        ...["--assets-dest", join(out, "assets")],
      ],
      { cwd: app, env: { ...process.env, CI: "1" }, stdio: ["ignore", "ignore", "inherit"] },
    );
    const map = SourceMap.assert(JSON.parse(readFileSync(join(out, "main.map"), "utf8")));
    return map.sections.flatMap((section) => section.map.sources);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Runs one of expo-modules-autolinking's commands and returns its JSON. */
const autolinking = (args: readonly string[]): unknown =>
  JSON.parse(
    execFileSync(join(app, "node_modules/.bin/expo-modules-autolinking"), args, {
      cwd: app,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  );

/** Every npm package the build carries, JavaScript or native, by its directory. */
function shippedPackages(): Map<string, Found> {
  const found = new Map<string, Found>();
  const take = (root: string) => {
    const real = realpathSync(root);
    let each = found.get(real);
    if (!each) {
      each = { root: real, javascript: false, native: false, within: new Set() };
      found.set(real, each);
    }
    return each;
  };
  const inApp = (file: string) => !relative(repository, file).startsWith("..");

  for (const source of bundleSources()) {
    // Metro's own preamble, not a file.
    if (source === "__prelude__" || source === "") continue;
    const file = join(app, source);
    const root = packageRoot(file);
    if (!root) {
      if (!inApp(file)) fail(`the bundle has ${source}, outside the repository and any package`);
      continue;
    }
    const each = take(root);
    each.javascript = true;
    for (let dir = dirname(file); dir.startsWith(root + sep); dir = dirname(dir)) {
      each.within.add(dir);
    }
  }

  const linked = Autolinked.assert(autolinking(["resolve", "--platform", "apple", "--json"]));
  for (const module of linked.modules) {
    for (const pod of module.pods) {
      const root = packageRoot(pod.podspecDir);
      // The app's own modules, in modules/: part of the app.
      if (!root) {
        if (!inApp(pod.podspecDir)) fail(`${pod.podName} links from ${pod.podspecDir}`);
        continue;
      }
      const each = take(root);
      each.native = true;
      const dir = realpathSync(pod.podspecDir);
      for (let at = dir; at.startsWith(each.root + sep); at = dirname(at)) each.within.add(at);
    }
  }
  const config = ReactNativeConfig.assert(
    autolinking(["react-native-config", "--platform", "ios", "--json"]),
  );
  for (const dependency of Object.values(config.dependencies)) {
    if (dependency.platforms.ios) take(dependency.root).native = true;
  }
  // React Native's own pods (React-Core, Yoga, the codegen's) come from react-native itself.
  take(join(app, "node_modules/react-native")).native = true;
  return found;
}

/** The app's patches, by the `name@version` each changes. */
const patches = () =>
  new Map(
    readdirSync(join(app, "patches"))
      .filter((file) => file.endsWith(".patch"))
      .map((file) => [file.slice(0, -".patch".length).replace("__", "/"), file] as const),
  );

/** How a component is in the app, as Settings says it. */
const partOf = ({ javascript, native }: { javascript: boolean; native: boolean }) =>
  javascript && native ? "JavaScript and native code" : javascript ? "JavaScript" : "Native code";

/** A manifest text, as fetched into licences/texts. */
function manifestNotice(store: TextStore, source: TextSource): Notice {
  const { file, title } = textFile(source);
  if (!existsSync(file)) fail(`${title} isn't in licences/texts: run with --fetch`);
  return store.notice(title, readFileSync(file, "utf8"));
}

/** An npm package as a component: its licence, archive, patch and notices. */
function packageComponent(
  store: TextStore,
  found: Found,
  manifest: Manifest,
  patched: ReadonlyMap<string, string>,
  used: Set<string>,
): Component {
  const pkg = PackageJson.assert(
    JSON.parse(readFileSync(join(found.root, "package.json"), "utf8")),
  );
  const id = `${pkg.name}@${pkg.version}`;
  if (typeof pkg.license !== "string") fail(`${id} names no SPDX licence in its package.json`);
  const files = [found.root, ...[...found.within].sort()].flatMap(licenceFiles);
  const notices = files.map((file) =>
    store.notice(relative(found.root, file).split(sep).join("/"), readFileSync(file, "utf8")),
  );
  const extra = manifest.packages[id];
  if (extra) {
    used.add(id);
    notices.push(...extra.texts.map((source) => manifestNotice(store, source)));
  }
  if (notices.length === 0) {
    fail(
      `${id} (${pkg.license}) has no licence file. Add the text its repository publishes at that version to licences/manifest.json's packages, then run with --fetch.`,
    );
  }
  const patch = patched.get(id);
  const facts: Fact[] = [
    { label: "Version", value: pkg.version },
    { label: "In the app", value: partOf(found) },
    ...(patch ? [{ label: "Changed by", value: `apps/ios/patches/${patch}` }] : []),
  ];
  const base = pkg.name.split("/").at(-1);
  return {
    id,
    name: pkg.name,
    licence: pkg.license,
    source: `https://registry.npmjs.org/${pkg.name}/-/${base}-${pkg.version}.tgz`,
    facts,
    notices,
  };
}

/** A manifest component, once its pins hold. */
function nativeComponent(store: TextStore, entry: Manifest["components"][number]): Component {
  const drifted = pinProblems(entry.name, entry.pins);
  if (drifted.length) fail(`${drifted.join("\n")} Then run with --fetch.`);
  const notices: Notice[] = [];
  if (entry.configuration) {
    const { file, from, to, without } = entry.configuration;
    const text = readFileSync(join(app, file), "utf8");
    const start = text.indexOf(from);
    const end = text.indexOf(`\n${to}`, start);
    if (start < 0 || end < 0) fail(`${file} has no ${from} … ${to} block for ${entry.name}`);
    const block = text
      .slice(start + from.length, end)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");
    const banned = without.filter((flag) => block.includes(flag));
    if (banned.length)
      fail(`${entry.name} is configured with ${banned.join(", ")}: not ${entry.licence}`);
    notices.push(store.notice("Configuration", block));
  }
  notices.push(...entry.texts.map((source) => manifestNotice(store, source)));
  return {
    id: `${entry.name}@${entry.version}`,
    name: entry.name,
    licence: entry.licence,
    source: entry.source,
    facts: [
      { label: "Version", value: entry.version },
      { label: "In the app", value: "Native code" },
      ...(entry.facts ?? []),
    ],
    notices,
  };
}

/** The app: its licence, its source, and what of it is in the build. */
function appComponent(store: TextStore): Component {
  const { license } = type({ license: "string" }).assert(
    JSON.parse(readFileSync(join(app, "package.json"), "utf8")),
  );
  if (license !== "GPL-3.0-only") fail(`apps/ios/package.json's licence is ${license}`);
  return {
    id: "mrstreamer",
    name: "Mr. Streamer",
    licence: license,
    source: APP_SOURCE,
    facts: [{ label: "Copyright", value: "Mr. Streamer contributors" }],
    notices: [store.notice("LICENSE", readFileSync(join(repository, "LICENSE"), "utf8"))],
  };
}

/** Everything Settings shows, in order. */
function generate(manifest: Manifest): Licences {
  const { aggregate, generated } = manifest;
  const drifted = [
    ...pinProblems(aggregate.pod, aggregate.pins),
    ...pinProblems("React Native's generated pods", generated.pins),
  ];
  if (drifted.length) fail(drifted.join("\n"));
  const unknown = aggregate.components.filter(
    (name) => !manifest.components.some((entry) => entry.name === name),
  );
  if (unknown.length) fail(`${aggregate.pod} names unknown components: ${unknown.join(", ")}`);
  const store = new TextStore();
  const patched = patches();
  const used = new Set<string>();
  const packages = [...shippedPackages().values()].map((found) =>
    packageComponent(store, found, manifest, patched, used),
  );
  const unused = Object.keys(manifest.packages).filter((id) => !used.has(id));
  if (unused.length)
    fail(`licences/manifest.json names packages the build doesn't carry: ${unused.join(", ")}`);
  for (const id of patched.keys()) {
    if (!packages.some((each) => each.id === id))
      fail(`patches/ changes ${id}, which the build doesn't carry`);
  }
  const components = [
    ...packages,
    ...manifest.components.map((entry) => nativeComponent(store, entry)),
  ].sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en"));
  const ids = new Set(components.map((each) => each.id));
  if (ids.size !== components.length) fail("two components share an id");
  return {
    components: [appComponent(store), ...components],
    texts: Object.fromEntries([...store.byKey].sort(([a], [b]) => a.localeCompare(b, "en"))),
  };
}

/** Downloads every manifest text at its pinned ref. */
async function fetchTexts(manifest: Manifest) {
  const sources = [
    ...manifest.components.flatMap((entry) => entry.texts),
    ...Object.values(manifest.packages).flatMap((entry) => entry.texts),
  ];
  for (const source of sources) {
    const { file, title } = textFile(source);
    const response = await fetch(
      `https://raw.githubusercontent.com/${source.repo}/${source.ref}/${source.path}`,
    );
    if (!response.ok) fail(`${title}: ${response.status} ${response.statusText}`);
    const body = await response.text();
    const text = source.lines
      ? body
          .split("\n")
          .slice(source.lines[0] - 1, source.lines[1])
          .join("\n")
      : body;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${normalized(text)}\n`);
    console.log(`licences: ${relative(app, file)}`);
  }
}

const { values } = parseArgs({
  options: { check: { type: "boolean" }, pods: { type: "string" }, fetch: { type: "boolean" } },
});
const manifest = (() => {
  try {
    return readManifest();
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
})();
if (values.fetch) {
  await fetchTexts(manifest);
} else {
  if (values.check || !values.pods) {
    // The bundle imports the file it is about to describe: give a first run something to import.
    if (!existsSync(output))
      writeFileSync(output, `${JSON.stringify({ components: [], texts: {} })}\n`);
    const json = `${JSON.stringify(generate(manifest), null, 2)}\n`;
    if (!values.check) writeFileSync(output, json);
    else if (readFileSync(output, "utf8") !== json) {
      fail("src/licences.json is out of date: run node scripts/licences.ts and commit it");
    }
    console.log(`licences: src/licences.json is ${values.check ? "current" : "written"}`);
  }
  if (values.pods) {
    const committed: Licences = JSON.parse(readFileSync(output, "utf8"));
    const problems = podProblems(values.pods, committed, manifest);
    if (problems.length) fail(`${values.pods} doesn't match Licences:\n  ${problems.join("\n  ")}`);
    console.log(`licences: every pod in ${values.pods} has its notices`);
  }
}
