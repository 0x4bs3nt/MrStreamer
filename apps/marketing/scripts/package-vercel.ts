// Packs the built site as Vercel's Build Output API, version 3, in .vercel/output/, and checks
// the package before anything deploys it: `vercel deploy --prebuilt` uploads exactly this folder.
//
//   node scripts/package-vercel.ts    (after `vite build`)
//
// - static/: everything in dist/.
// - config.json: each page answers its canonical address, with or without a trailing slash. A POST
//   to /ingest/i/v0/e/ goes on to PostHog's EU capture, the only route that leaves the site.
//   An unknown address or an HTML alias answers 404.html with status 404. No builds.json: without one the CLI deploys to the target it is told,
//   where a builds.json naming a preview would win.
//
// Fails, listing every problem, when:
// - a page names a file the package lacks, or has no script or styles
// - a listed page lacks its address, description or social picture, or the sitemap
//   doesn't list it
// - the home page lacks the script that picks its one download button, links an installer
//   anywhere but this repository's releases, or describes the app to search engines in data
//   that doesn't read or shows a picture the package lacks
// - a Markdown page lacks source headings, or a public link or fragment is missing
// - search engines could list 404.html
// - robots.txt doesn't name the sitemap, or a route answers with a missing page
// - the site's script sends to PostHog directly, past its own route
import { execFileSync } from "node:child_process";
import { INDEXNOW_KEY, INDEXNOW_MARKER, readIndexNowBuild } from "./indexnow.ts";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PAGES, SITE } from "./pages.ts";
import { INGEST_ROUTE } from "./site-analytics.ts";

const LISTED = Object.fromEntries(PAGES.map(({ address, file }) => [address, file]));

const root = join(import.meta.dirname, "..");
const output = join(root, ".vercel/output");
const files = join(output, "static");

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync(join(root, "dist"), files, { recursive: true });
// Vercel matches src against the path without its query. The routes above "filesystem" answer
// before the package's files, the one below it after them.
const missing = { status: 404, dest: "/404.html" };
const routes = [
  INGEST_ROUTE,
  {
    src: `^/${INDEXNOW_KEY}\\.txt$`,
    dest: `/${INDEXNOW_KEY}.txt`,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  },
  {
    src: "^/indexnow-build\\.json$",
    dest: `/${INDEXNOW_MARKER}`,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  },
  ...PAGES.map(({ address, file }) => ({
    src: address === "/" ? "^/$" : `^${address}/?$`,
    dest: `/${file}`,
  })),
  { src: "^/.*\\.html$", ...missing },
  { handle: "filesystem" },
  { src: "^/.*$", ...missing },
];
writeFileSync(join(output, "config.json"), `${JSON.stringify({ version: 3, routes }, null, 2)}\n`);

const problems: string[] = [];
const read = (name: string) =>
  existsSync(join(files, name)) ? readFileSync(join(files, name), "utf8") : "";

const everyPage = {
  "the site's script": '<script type="module"',
  "the site's styles": '<link rel="stylesheet"',
};
const packed = new Set<string>();
/** Checks that a page holds each piece of markup and that every file it names is packed. */
function check(name: string, expected: Record<string, string>) {
  const page = read(name);
  for (const [what, markup] of Object.entries({ ...everyPage, ...expected })) {
    // Vite keeps attributes as written and may change the space between them.
    if (!page.replace(/\s+/g, " ").includes(markup)) problems.push(`${name} lacks ${what}.`);
  }
  // Every file the page names: pictures, styles, the script, icons and the social picture.
  const named = [...page.matchAll(/\s(?:href|src|srcset|content)="([^"]+)"/g)]
    .flatMap(([, value = ""]) => value.split(","))
    .map((entry) => entry.trim().split(/\s+/)[0] ?? "")
    .map((address) => (address.startsWith(`${SITE}/`) ? address.slice(SITE.length) : address))
    .filter((address) => /^\/[^/].*\.\w+$/.test(address));
  for (const path of new Set(named)) {
    packed.add(path);
    if (!existsSync(join(files, path))) problems.push(`${name} names ${path}, which is missing.`);
  }
  if (named.length === 0) problems.push(`${name} names no files.`);
}

const sitemap = read("sitemap.xml");
try {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const build = readIndexNowBuild(read(INDEXNOW_MARKER), revision, sitemap);
  const canonical = new Set(PAGES.map(({ address }) => SITE + address));
  if (build.urlList.length !== canonical.size || build.urlList.some((url) => !canonical.has(url)))
    problems.push("IndexNow URLs differ from the canonical page registry.");
  if (read(`${build.key}.txt`) !== build.key)
    problems.push("IndexNow ownership file is missing or incorrect.");
} catch {
  problems.push("IndexNow build marker or sitemap is missing or invalid.");
}
for (const [address, name] of Object.entries(LISTED)) {
  check(name, {
    "its address": `<link rel="canonical" href="${SITE}${address}"`,
    "a description": '<meta name="description" content="',
    "a title for shared links": '<meta property="og:title"',
    "a description for shared links": '<meta property="og:description" content="',
    "its address for shared links": `<meta property="og:url" content="${SITE}${address}"`,
    "a picture for shared links": `<meta property="og:image" content="${SITE}/generated/social.png"`,
  });
  if (!/<title\b[^>]*>[^<\s][^<]*<\/title>/.test(read(name))) {
    problems.push(`${name} lacks a title.`);
  }
  if (!sitemap.includes(`<loc>${SITE}${address}</loc>`)) {
    problems.push(`sitemap.xml doesn't list ${address}.`);
  }
}
check("404.html", {
  "the tag that keeps it out of search results": '<meta name="robots" content="noindex"',
});

// The home page's download button, installer links and structured data.
const home = read("index.html");
if (!home.includes("document.documentElement.dataset.os=")) {
  problems.push(`${LISTED["/"]} lacks the script that names the visitor's system.`);
}
const RELEASES = "https://github.com/Mr-Streamer-OSS/MrStreamer/releases";
const installer = new RegExp(
  `^${RELEASES}/(latest|download/v(\\d+\\.\\d+\\.\\d+)/Mr-Streamer-\\2-[\\w.-]+)$`,
);
const links = [
  ...[home, read("download/index.html")]
    .join("\n")
    .matchAll(/<a\s[^>]*\bdata-installer="\w+"[^>]*>/g),
].map(([tag]) => /\shref="([^"]*)"/.exec(tag)?.[1] ?? "");
if (links.length === 0) problems.push(`${LISTED["/"]} links no installer.`);
for (const link of new Set(links.filter((link) => !installer.test(link)))) {
  problems.push(`${LISTED["/"]} links an installer at "${link}", outside the project's releases.`);
}
try {
  const [, json = ""] = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(home) ?? [];
  const { "@type": type, screenshot }: Record<string, unknown> = JSON.parse(json);
  const pictures = Array.isArray(screenshot) ? screenshot : [screenshot];
  if (
    !(Array.isArray(type)
      ? type.includes("SoftwareApplication")
      : type === "SoftwareApplication") ||
    pictures.length === 0 ||
    pictures.some(
      (picture: unknown) =>
        typeof picture !== "string" ||
        !picture.startsWith(`${SITE}/`) ||
        !existsSync(join(files, picture.slice(SITE.length))),
    )
  ) {
    problems.push(`${LISTED["/"]} describes no app, or shows a picture that is missing.`);
  }
} catch {
  problems.push(`${LISTED["/"]} holds structured data that doesn't read.`);
}

// Every Markdown page holds its source's headings, even without JavaScript.
for (const page of PAGES) {
  if (!page.markdown) continue;
  const headings = readFileSync(join(root, "../..", page.markdown), "utf8").match(/^#+ /gm) ?? [];
  const rendered = read(page.file).match(/<h[1-6][ >]/g) ?? [];
  const extra = page.address.startsWith("/docs/") ? 1 : 0;
  if (headings.length === 0 || rendered.length !== headings.length + extra) {
    problems.push(`${page.file} doesn't hold the whole Markdown document.`);
  }
}

// Public links and fragments must lead to a real page, rather than maintainer-only 404s.
for (const page of PAGES) {
  for (const [, href = ""] of read(page.file).matchAll(/\shref="([^"<>]+)"/g)) {
    if (!href.startsWith("/") && !href.startsWith("#")) continue;
    const url = new URL(href.replaceAll("&amp;", "&"), SITE + page.address);
    const target = PAGES.find(({ address }) => address === url.pathname);
    if (!target) {
      if (!existsSync(join(files, url.pathname)))
        problems.push(`${page.file} links missing ${url.pathname}.`);
      continue;
    }
    if (url.hash && !read(target.file).includes(`id="${decodeURIComponent(url.hash.slice(1))}"`)) {
      problems.push(`${page.file} links missing fragment ${url.pathname}${url.hash}.`);
    }
  }
}

if (!read("robots.txt").includes(`Sitemap: ${SITE}/sitemap.xml`)) {
  problems.push("robots.txt doesn't name the sitemap.");
}
for (const dest of new Set(routes.flatMap((route) => ("dest" in route ? route.dest : [])))) {
  if (dest === INGEST_ROUTE.dest) continue;
  if (!existsSync(join(files, dest))) {
    problems.push(`A route answers with ${dest}, which is missing.`);
  }
}
const scripts = readdirSync(join(files, "assets"))
  .filter((name) => name.endsWith(".js"))
  .map((name) => read(`assets/${name}`));
if (scripts.some((script) => script.includes("i.posthog.com")))
  problems.push("The site's script sends to PostHog directly, past its own /ingest route.");
if (existsSync(join(output, "builds.json"))) problems.push("The package holds a builds.json.");

if (problems.length > 0) throw new Error(`The package isn't ready:\n${problems.join("\n")}`);
console.log(`Packed the pages and the ${packed.size} files they name into ${output}`);
