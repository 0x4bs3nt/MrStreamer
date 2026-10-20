import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Marked } from "marked";
import type { Downloads } from "../src/downloads.ts";
import { PACKAGE_ROUTES, type PackageRoutes } from "../src/packages.ts";
import { RELEASES, type Release } from "./releases.ts";

export const SITE = "https://mrstreamer.app";
const REPOSITORY = "https://github.com/Mr-Streamer-OSS/MrStreamer";
const root = join(import.meta.dirname, "..");
const repository = resolve(root, "../..");

export const GUIDES = [
  {
    slug: "subscriptions",
    title: "Subscriptions",
    description:
      "Connect and manage Xtream Codes subscriptions and M3U playlists, programme guides and channel mappings in Mr. Streamer.",
  },
  {
    slug: "live-tv",
    title: "Live TV",
    description:
      "Watch live TV in Mr. Streamer, use the programme guide, search channels and control playback with the keyboard.",
  },
  {
    slug: "movies-and-series",
    title: "Movies and series",
    description:
      "Find movies and series, use the watchlist and continue episodes from your Xtream Codes subscriptions in Mr. Streamer.",
  },
  {
    slug: "downloads",
    title: "Downloads",
    description:
      "Download movies and episodes in Mr. Streamer, manage the queue and watch saved copies offline.",
  },
  {
    slug: "updates",
    title: "Updates and channels",
    description:
      "Update Mr. Streamer, choose Stable or Nightly, and understand how Microsoft Store updates work.",
  },
  {
    slug: "playback",
    title: "What plays",
    description:
      "The streams, formats, sound and subtitles Mr. Streamer plays, playing on a TV, and known playback limits.",
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    description:
      "Fix login, programme guide, playback and update problems in Mr. Streamer, and find your local data.",
  },
] as const;

interface Page {
  readonly address: string;
  readonly file: string;
  readonly title: string;
  readonly description: string;
  readonly markdown?: string;
}

/** One address list for Vite, Vercel, metadata and the sitemap checks. */
export const PAGES: readonly Page[] = [
  {
    address: "/",
    file: "index.html",
    title: "Mr. Streamer: free IPTV player for Mac, Windows and Linux",
    description: "Free, open source IPTV player for Mac, Windows and Linux.",
  },
  {
    address: "/faq",
    file: "faq/index.html",
    title: "Mr. Streamer: questions",
    description:
      "Answers about channels, M3U playlists, downloads, supported systems, updates and privacy in Mr. Streamer.",
  },
  {
    address: "/privacy",
    file: "privacy/index.html",
    title: "Mr. Streamer: privacy policy",
    description:
      "What Mr. Streamer stores on your computer, what it sends, and how the website uses analytics.",
    markdown: "docs/privacy.md",
  },
  {
    address: "/docs",
    file: "docs/index.html",
    title: "Mr. Streamer guides",
    description:
      "Set up Mr. Streamer, watch live TV, movies and series, manage updates and fix common problems.",
  },
  ...GUIDES.map((guide) => ({
    address: `/docs/${guide.slug}`,
    file: `docs/${guide.slug}/index.html`,
    title: `${guide.title} | Mr. Streamer guides`,
    description: guide.description,
    markdown: `docs/user/${guide.slug}.md`,
  })),
  {
    address: "/about",
    file: "about/index.html",
    title: "About Mr. Streamer: free IPTV player for Mac, Windows and Linux",
    description: "What Mr. Streamer plays, supported systems, its limits, licence and source code.",
    markdown: "docs/about.md",
  },
  {
    address: "/security",
    file: "security/index.html",
    title: "Mr. Streamer: security",
    description:
      "How Mr. Streamer stores logins, how to report security problems, installer signing and checking downloads.",
    markdown: "docs/security.md",
  },
  {
    address: "/download",
    file: "download/index.html",
    title: "Download Mr. Streamer for Mac, Windows and Linux",
    description:
      "Download Mr. Streamer's stable installers for macOS, Windows and Linux, with requirements, checksums and source code.",
  },
  {
    address: "/releases",
    file: "releases/index.html",
    title: "Mr. Streamer releases",
    description:
      "Stable Mr. Streamer releases, newest first, with release dates and the complete release notes.",
  },
];

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );
}

/** Writes only independently verified package routes, never inferred from the release feed. */
export function writePackages(html: string, routes: PackageRoutes = PACKAGE_ROUTES): string {
  return html.replaceAll(
    /<!-- package:(homebrew|aur):(link|details) -->/g,
    (_mark, name: "homebrew" | "aur", part: "link" | "details") => {
      const route = routes[name];
      if (
        route.publication.state !== "published" ||
        !/^\d+\.\d+\.\d+$/.test(route.publication.lastVerifiedVersion)
      )
        return "";
      const link = `<a data-package="${name}" href="${escapeHtml(route.url)}">${escapeHtml(route.name)} · ${escapeHtml(route.platform)}, ${escapeHtml(route.architecture)}</a>`;
      if (part === "link") return link;
      return `<div class="package-route">${link}<small>${escapeHtml(route.updates)} Package ${escapeHtml(route.publication.lastVerifiedVersion)}.</small><pre><code>${escapeHtml(route.install)}</code></pre></div>`;
    },
  );
}

/** Relative documentation links keep their public address and section, or go to GitHub. */
function linkTo(href: string, source: string): string | null {
  if (href.startsWith("#")) {
    const page = PAGES.find((page) => page.markdown === source);
    return page ? page.address + href : `${REPOSITORY}/blob/main/${source}${href}`;
  }
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (/^(\/\/|[a-z][\w+.-]*:)/i.test(href)) return null;
  const [path = "", fragment] = href.split("#", 2);
  const suffix = fragment === undefined ? "" : `#${fragment}`;
  if (path.startsWith("/")) return PAGES.some((page) => page.address === path) ? href : null;
  const target = relative(repository, resolve(repository, dirname(source), path));
  const page = PAGES.find((page) => page.markdown === target);
  if (page) return page.address + suffix;
  if (target.startsWith("..")) return null;
  // Contributing and maintainer documents are not public website routes.
  return `${REPOSITORY}/blob/main/${target}${suffix}`;
}

/** Render Markdown without embedded HTML, unsafe URLs or third-party image requests. */
export function renderMarkdown(
  text: string,
  source: string,
  headingOffset = 0,
  anchorPrefix = "",
): string {
  const headings = new Map<string, number>();
  const markdown = new Marked({
    renderer: {
      heading({ text, tokens, depth }) {
        const slug = text
          .toLowerCase()
          .replace(/[^\w\s-]/g, "")
          .trim()
          .replace(/\s+/g, "-");
        const count = headings.get(slug) ?? 0;
        headings.set(slug, count + 1);
        const id = anchorPrefix + (count === 0 ? slug : `${slug}-${count}`);
        const level = Math.min(depth + headingOffset, 6);
        return `<h${level} id="${id}">${this.parser.parseInline(tokens)}</h${level}>\n`;
      },
      link({ href, title, tokens }) {
        const target =
          anchorPrefix && href.startsWith("#")
            ? `/releases#${anchorPrefix}${href.slice(1)}`
            : linkTo(href, source);
        const text = this.parser.parseInline(tokens);
        return target
          ? `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ""}>${text}</a>`
          : text;
      },
      image({ href, text }) {
        const target = linkTo(href, source);
        return target
          ? `<a href="${escapeHtml(target)}">${escapeHtml(text || "Image")}</a>`
          : escapeHtml(text);
      },
      html({ text }) {
        return escapeHtml(text);
      },
    },
  });
  return markdown.parse(text, { async: false });
}

const markdownOf = (file: string) => readFileSync(join(repository, file), "utf8");

function guideIndex(): string {
  return `<h1>Guides</h1><dl class="guide-list">${GUIDES.map((guide) => {
    const summary = escapeHtml(guide.description);
    return `<div><dt><a href="/docs/${guide.slug}">${guide.title}</a></dt><dd>${summary}</dd></div>`;
  }).join("")}</dl>`;
}

function releaseHistory(releases: readonly Release[] | null): string {
  const intro = "<h1>Releases</h1>";
  if (!releases?.length)
    return `${intro}<p>Release history is unavailable here. Read the stable releases and notes on <a href="${RELEASES}">GitHub Releases</a>.</p>`;
  return `${intro}<p>Every stable release, newest first. Nightly builds are on <a href="${RELEASES}">GitHub</a>.</p>${releases
    .map((release) => {
      const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" }).format(
        new Date(release.published),
      );
      const headings: number[] = [];
      const markdown = new Marked();
      markdown.walkTokens(markdown.lexer(release.notes), (token) => {
        if (token.type === "heading") headings.push(token.depth);
      });
      const offset = 3 - (headings.length ? Math.min(...headings) : 3);
      return `<section class="release"><h2 id="v${release.version}">${release.version}</h2><p><time datetime="${escapeHtml(release.published)}">${date}</time>. <a href="${RELEASES}/tag/v${release.version}">Download and source</a></p>${release.notes ? renderMarkdown(release.notes, "README.md", offset, `v${release.version}-`) : "<p>No release notes were published.</p>"}</section>`;
    })
    .join("")}`;
}

/** The policy's own website analytics switch, under its heading. analytics.ts brings it to life. */
function withAnalyticsSwitch(policy: string): string {
  const heading = /<h\d id="website-analytics">.*?<\/h\d>\n/;
  if (!heading.test(policy))
    throw new Error("docs/privacy.md lacks its Website analytics heading.");
  return policy.replace(
    heading,
    (found) =>
      `${found}<p class="site-analytics" data-site-analytics="policy"><span data-site-analytics-status>Website analytics are off in this browser.</span></p>\n`,
  );
}

/** Expands the shared privacy layout before Vite resolves its stylesheet and script. */
export function renderPage(
  file: string,
  downloads: Downloads | null,
  releases: readonly Release[] | null,
): string {
  const page = PAGES.find((page) => page.file === file);
  if (!page || page.address === "/") throw new Error(`No document page for ${file}`);
  const version = downloads?.installers.length ? downloads.version : null;
  const title =
    page.address === "/download" && version
      ? `Download Mr. Streamer ${version} for Mac, Windows and Linux`
      : page.title;
  let content = page.markdown ? renderMarkdown(markdownOf(page.markdown), page.markdown) : "";
  if (page.address === "/about")
    content = content.replace(
      "<h2",
      '<p><span data-release-version>Stable release on GitHub.</span> <a data-release-link="notes" href="' +
        RELEASES +
        '/latest">Release notes</a>.</p><h2',
    );
  if (page.address === "/privacy") content = withAnalyticsSwitch(content);
  if (page.address === "/docs") content = guideIndex();
  if (page.address === "/faq") content = readFileSync(join(root, "src/faq.html"), "utf8");
  if (page.address === "/download")
    content = writePackages(readFileSync(join(root, "src/download.html"), "utf8"));
  if (page.address === "/releases") content = releaseHistory(releases);
  const guide = GUIDES.find((guide) => page.address === `/docs/${guide.slug}`);
  const crumb = guide ? `<p class="crumb"><a href="/docs">Guides</a> / ${guide.title}</p>` : "";
  const other = guide
    ? `<nav class="other-guides" aria-label="Other guides"><h2>Other guides</h2><ul>${GUIDES.filter(
        (other) => other.slug !== guide.slug,
      )
        .map((other) => `<li><a href="/docs/${other.slug}">${other.title}</a></li>`)
        .join("")}</ul></nav>`
    : "";
  let html = readFileSync(join(root, "src/page.html"), "utf8")
    .replaceAll("<!-- title -->", escapeHtml(title))
    .replaceAll("<!-- description -->", escapeHtml(page.description))
    .replaceAll("<!-- address -->", SITE + page.address)
    .replaceAll(`href="${guide ? "/docs" : page.address}"`, `$& aria-current="page"`)
    .replace("<!-- content -->", () => crumb + content + other);
  if (page.address === "/download")
    html = html
      .replace("<title>", "<title data-download-title>")
      .replace('<meta property="og:title"', '<meta property="og:title" data-download-title');
  return html;
}
