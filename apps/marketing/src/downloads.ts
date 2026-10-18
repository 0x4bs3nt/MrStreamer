// The site's download links: where each installer of the current stable release is, and how
// the page shows it. README.md, Downloads, has the whole account.
//
// - index.html is written with every installer link on the Releases page and no version: what
//   the page says when nothing is known.
// - The build takes the highest stable version from fresh GitHub release history, falling back
//   to the update feed if history is unavailable. It asks GitHub whether each installer answers
//   (`verifiedDownloads`) and writes the ones that do into the page (`writeDownloads`).
// - The open page reads the feed once and shows the installers it lists (`listedDownloads`,
//   `showDownloads`), so a release published after the build still reaches the page.
//
// A link is never guessed. Its address is this repository's release folder, a version shaped
// like a stable one and a file name from INSTALLERS, and it is written only after GitHub
// answered for that file or the feed listed it. Nothing else from the feed reaches the page.

const RELEASES = "https://github.com/Mr-Streamer-OSS/MrStreamer/releases";

/** The update feed the release workflow publishes (packages/contracts/src/update-feed.ts). */
export const FEED = "https://mr-streamer-oss.github.io/MrStreamer/updates.json";

/** The newest stable release's page. An installer link goes here while its file is unknown. */
export const LATEST = `${RELEASES}/latest`;

/**
 * The installers the page links, each with how its file name ends after the version, as
 * apps/desktop/electron-builder.yml names it. index.html marks a link with one of these names in
 * data-installer.
 */
const INSTALLERS = {
  dmg: "mac-arm64.dmg",
  exe: "win-x64-setup.exe",
  appImage: "linux-x86_64.AppImage",
  deb: "linux-amd64.deb",
} as const;

type Installer = keyof typeof INSTALLERS;
export const installers = Object.keys(INSTALLERS) as Installer[];

/** A stable release and the installers known to be there. */
export interface Downloads {
  /** Such as 0.0.7. */
  readonly version: string;
  readonly installers: readonly Installer[];
}

const fileOf = (version: string, installer: Installer): string =>
  `Mr-Streamer-${version}-${INSTALLERS[installer]}`;

const urlOf = (version: string, installer: Installer): string =>
  `${RELEASES}/download/v${version}/${fileOf(version, installer)}`;

/**
 * The feed's stable version, or null when the feed is not one, names no stable release, or names
 * one this site won't link: a nightly, or files from anywhere but this repository's release of
 * that version.
 */
function stableOf(feed: unknown): { version: string; listed: unknown } | null {
  if (!isRecord(feed) || feed["schema"] !== 1 || !isRecord(feed["stable"])) return null;
  const { version, files, installers: listed } = feed["stable"];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  return files === `${RELEASES}/download/v${version}` ? { version, listed } : null;
}

/**
 * What the open page shows: the feed's stable release and the installers the feed lists for it.
 * null leaves the page as the build wrote it: when the feed can't be trusted, and when it comes
 * from before feeds listed installers.
 */
export function listedDownloads(feed: unknown): Downloads | null {
  const stable = stableOf(feed);
  const listed = stable?.listed;
  if (!stable || !Array.isArray(listed)) return null;
  return {
    version: stable.version,
    installers: installers.filter((installer) =>
      listed.includes(fileOf(stable.version, installer)),
    ),
  };
}

/**
 * What the build writes: the published stable release and the installers GitHub answers for,
 * one HEAD request each. Without fresh release history, use the validated feed instead.
 * null leaves the page on GitHub Releases. `request` is fetch, or a test's stand-in.
 */
export async function verifiedDownloads(
  request: typeof fetch = fetch,
  released?: { readonly version: string; readonly published: string } | null,
): Promise<Downloads | null> {
  // A complete history with no eligible stable release is authoritative, not a network failure.
  if (released === null) return null;
  // The API history is freshly read during the build. Pages may cache its feed for ten minutes.
  // If the history is unavailable, preserve the verified feed fallback used by earlier builds.
  const feed = released
    ? null
    : await request(FEED, {
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      })
        .then((response): Promise<unknown> | null => (response.ok ? response.json() : null))
        .catch(() => null);
  const published = released && Date.parse(released.published);
  const stable =
    released &&
    /^\d+\.\d+\.\d+$/.test(released.version) &&
    typeof published === "number" &&
    Number.isFinite(published)
      ? { version: released.version }
      : stableOf(feed);
  if (!stable) return null;
  // GitHub answers 302 for an installer that exists and 404 for one that doesn't. Other redirects
  // don't count: a renamed repository redirects every address, a missing file's too.
  const answers = await Promise.all(
    installers.map((installer) =>
      request(urlOf(stable.version, installer), {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      }).then(
        ({ ok, status }) => ok || status === 302,
        () => false,
      ),
    ),
  );
  return {
    version: stable.version,
    installers: installers.filter((_, index) => answers[index]),
  };
}

/** One browser refresh. A cached feed cannot undo the release or withdrawal this build verified. */
export function showFeedDownloads(page: ParentNode, feed: unknown): void {
  const release = page.querySelector<HTMLElement>("[data-release-verified]");
  const minimum = release?.dataset["releaseVerified"];
  const downloads = listedDownloads(feed);
  if (minimum !== undefined) {
    const generated =
      isRecord(feed) && typeof feed["generated"] === "string" ? Date.parse(feed["generated"]) : NaN;
    if (
      !Number.isFinite(generated) ||
      (generated < Number(minimum) && downloads?.version !== release?.dataset["releaseSelected"])
    )
      return;
  }
  if (downloads) showDownloads(page, downloads);
}

/** Where an installer link goes: its file when the release is known to hold it. */
function hrefOf(downloads: Downloads, installer: string | undefined): string {
  const known = downloads.installers.find((each) => each === installer);
  return known ? urlOf(downloads.version, known) : LATEST;
}

/** General release facts name a version only when at least one of its installers is known. */
function releaseVersion(downloads: Downloads): string {
  return downloads.installers.length
    ? `Version ${downloads.version}.`
    : "Stable release on GitHub.";
}

function releaseLink(downloads: Downloads, kind: string | undefined): string {
  if (!downloads.installers.length) return LATEST;
  const release = `${RELEASES}/tag/v${downloads.version}`;
  return kind === "notes" ? release : `${release}#assets`;
}

function downloadTitle(downloads: Downloads): string {
  return `Download Mr. Streamer${downloads.installers.length ? ` ${downloads.version}` : ""} for Mac, Windows and Linux`;
}

/**
 * The open page with `downloads` in it: every a[data-installer] goes to its installer. An
 * installer the release lacks goes to the Releases page. General release facts name the version.
 */
export function showDownloads(page: ParentNode, downloads: Downloads): void {
  for (const link of page.querySelectorAll<HTMLAnchorElement>("a[data-installer]")) {
    link.href = hrefOf(downloads, link.dataset["installer"]);
  }
  for (const line of page.querySelectorAll<HTMLElement>("[data-release-version]")) {
    line.textContent = releaseVersion(downloads);
  }
  for (const link of page.querySelectorAll<HTMLAnchorElement>("a[data-release-link]")) {
    link.href = releaseLink(downloads, link.dataset["releaseLink"]);
  }
  for (const title of page.querySelectorAll("[data-download-title]")) {
    if (title instanceof HTMLMetaElement) title.content = downloadTitle(downloads);
    else title.textContent = downloadTitle(downloads);
  }
  for (const script of page.querySelectorAll('script[type="application/ld+json"]')) {
    script.textContent = writeSoftwareVersion(script.textContent ?? "", downloads);
  }
}

/** The version describes verified/listed installers, rather than an unreleased package version. */
function writeSoftwareVersion(json: string, downloads: Downloads): string {
  const data: unknown = JSON.parse(json);
  if (!isRecord(data)) return json;
  if (downloads.installers.length) data["softwareVersion"] = downloads.version;
  else delete data["softwareVersion"];
  return JSON.stringify(data, null, 2);
}

/** The page's HTML with `downloads` in it, as `showDownloads` leaves the open page. */
export function writeDownloads(
  html: string,
  downloads: Downloads | null,
  verifiedAt?: number,
): string {
  // Even a versionless page needs this guard when history proves every release was withdrawn.
  const stamped = html.replace(/<span\s[^>]*\bdata-release-version[^>]*>/g, (tag) =>
    tag
      .replace(/\sdata-release-verified="[^"]*"/, "")
      .replace(/\sdata-release-selected="[^"]*"/, "")
      .replace(
        />$/,
        verifiedAt === undefined
          ? ">"
          : ` data-release-verified="${verifiedAt}" data-release-selected="${downloads?.version ?? ""}">`,
      ),
  );
  if (!downloads) return stamped;
  return stamped
    .replace(/<a\s[^>]*\bdata-installer="(\w+)"[^>]*>/g, (tag, installer: string) =>
      tag.replace(/\shref="[^"]*"/, ` href="${hrefOf(downloads, installer)}"`),
    )
    .replace(
      /(<span\s[^>]*\bdata-release-version[^>]*>)[^<]*/g,
      (_, tag: string) => tag + releaseVersion(downloads),
    )
    .replace(/<a\s[^>]*\bdata-release-link="(\w+)"[^>]*>/g, (tag, kind: string) =>
      tag.replace(/\shref="[^"]*"/, ` href="${releaseLink(downloads, kind)}"`),
    )
    .replace(
      /(<title\s[^>]*\bdata-download-title[^>]*>)[^<]*/,
      (_, tag: string) => tag + downloadTitle(downloads),
    )
    .replace(/<meta\s[^>]*\bdata-download-title[^>]*>/g, (tag) =>
      tag.replace(/\scontent="[^"]*"/, ` content="${downloadTitle(downloads)}"`),
    )
    .replace(
      /(<script type="application\/ld\+json">)(.*?)(<\/script>)/s,
      (_, open: string, json: string, close: string) =>
        open + writeSoftwareVersion(json, downloads) + close,
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
