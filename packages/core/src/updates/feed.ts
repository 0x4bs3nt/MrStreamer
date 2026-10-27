// Finds the releases an update can install. The app reads a small static feed the release
// workflow publishes (see @mrstreamer/contracts/update-feed): one request, and no share of
// GitHub's API limit of 60 requests an hour per network address. When the feed is missing or
// broken, as before it is first published, it asks GitHub's API instead, unless GitHub said it is
// limiting requests from this network and that hasn't passed yet. Installers always come from
// GitHub Releases.
//
// A release counts only when its version and channel agree and it carries this platform's update
// metadata. Each channel takes its own highest release: Stable never sees a nightly and Nightly
// never sees a stable release. Highest by version order, never by date, so a build published late
// cannot replace a newer one.
import { type } from "arktype";
import type { CheckFailure } from "@mrstreamer/contracts/updates";
import { readFeed } from "@mrstreamer/contracts/update-feed";
import {
  channelOf,
  compareVersions,
  parseVersion,
  type Channel,
  type Version,
} from "@mrstreamer/contracts/version";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";

/** A release this platform can update to. */
export interface Offer {
  /** The Stable release just below this one, when known. Missing history never implies overdue. */
  readonly previousStable?: Version;
  readonly version: Version;
  /** The folder holding the release's files, for electron-updater's generic provider. */
  readonly feedUrl: string;
  /** Release notes in Markdown, when the source has them. */
  readonly notes: string | null;
  /** The release's page. */
  readonly page: string | null;
}

/** What one request to an update source answered, without anything but numbers and names. */
export interface SourceAnswer {
  readonly source: "feed" | "github";
  /** The HTTP status, or null when there was no answer. */
  readonly status: number | null;
  /** GitHub's rate-limit headers, when it sent them. */
  readonly remaining: number | null;
  readonly reset: number | null;
  readonly retryAfter: number | null;
}

/** A check that found nothing, why in terms the UI explains, and what the sources answered. */
export class DiscoveryFailed extends Error {
  readonly failure: CheckFailure;
  readonly answers: readonly SourceAnswer[];

  constructor(failure: CheckFailure, answers: readonly SourceAnswer[]) {
    super(`The update check failed: ${failure.kind}`);
    this.name = "DiscoveryFailed";
    this.failure = failure;
    this.answers = answers;
  }
}

/**
 * The newest release a channel receives, whether or not it is newer than the installed one. A
 * channel receives only its own releases: a stable release is a promoted nightly, so the nightlies
 * after it already hold its changes.
 */
export function newestOn(channel: Channel, offers: readonly Offer[]): Offer | null {
  return (
    offers
      .filter((offer) => channelOf(offer.version) === channel)
      .sort((a, b) => compareVersions(b.version, a.version))[0] ?? null
  );
}

/** The update metadata file electron-builder writes for this platform. */
export function metadataFileFor(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "latest-mac.yml";
  if (platform === "win32") return "latest.yml";
  return "latest-linux.yml";
}

export interface DiscoveryOptions {
  /** Where the feed is: updates.json on the project's site. */
  readonly feedUrl: string;
  /** GitHub's API, or a test server that answers like it. */
  readonly api: string;
  readonly repository: string;
  readonly metadataFile: string;
  readonly userAgent: string;
  /**
   * Where the feed may send downloads: the repository's GitHub Releases unless given, so the feed
   * can't point the app at files from anywhere else. A test feed serving its own files passes "".
   */
  readonly filesFrom?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/**
 * A discovery function for the updates service. It remembers when GitHub asked it to wait, so
 * the fallback leaves GitHub alone until then.
 */
export function discovery(options: DiscoveryOptions): (signal: AbortSignal) => Promise<Offer[]> {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const filesFrom =
    options.filesFrom ?? `https://github.com/${options.repository}/releases/download/`;
  let githubBusyUntil = 0;

  return async (signal) => {
    const answers: SourceAnswer[] = [];
    const fromFeed = await attempt("feed", signal, answers, async (response) => {
      const feed = readFeed(await response.json());
      return [feed.stable, feed.nightly].flatMap((entry): Offer[] => {
        const version = entry && parseVersion(entry.version);
        if (!entry || !version || !entry.platforms.includes(options.metadataFile)) return [];
        // Unreadable, like a broken feed, so the check asks GitHub instead.
        // Resolved first, so dot segments can't climb out of the folder.
        if (!new URL(entry.files).href.startsWith(filesFrom)) {
          throw new Error(`Files from ${entry.files}.`);
        }
        return [
          {
            version,
            feedUrl: entry.files,
            notes: entry.notes || null,
            page: entry.page,
            ...(entry.previousStable && { previousStable: parseVersion(entry.previousStable)! }),
          },
        ];
      });
    });
    if (fromFeed.ok) return fromFeed.offers;
    // Offline reaches GitHub no better; asking it while it limits us only extends the wait.
    if (fromFeed.failure.kind === "offline") throw new DiscoveryFailed(fromFeed.failure, answers);
    if (now() < githubBusyUntil) {
      throw new DiscoveryFailed({ kind: "busy", until: githubBusyUntil }, answers);
    }
    const fromGitHub = await githubReleases(signal, answers);
    if (fromGitHub.ok) return fromGitHub.offers;
    if (fromGitHub.failure.kind === "busy") {
      githubBusyUntil = fromGitHub.failure.until ?? now() + 60 * 60_000;
    }
    throw new DiscoveryFailed(fromGitHub.failure, answers);
  };

  /** One request, and what it answered. */
  async function attempt(
    source: SourceAnswer["source"],
    signal: AbortSignal,
    answers: SourceAnswer[],
    read: (response: Response) => Promise<Offer[]>,
    path: string = options.feedUrl,
  ): Promise<{ ok: true; offers: Offer[] } | { ok: false; failure: CheckFailure }> {
    let response: Response;
    try {
      response = await fetchImpl(path, {
        headers: {
          "User-Agent": options.userAgent,
          Accept: source === "github" ? "application/vnd.github+json" : "application/json",
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      });
    } catch {
      signal.throwIfAborted();
      answers.push({ source, status: null, remaining: null, reset: null, retryAfter: null });
      return { ok: false, failure: { kind: "offline" } };
    }
    const answer = answerOf(source, response);
    answers.push(answer);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return { ok: false, failure: failureOf(answer, now()) };
    }
    try {
      return { ok: true, offers: await read(response) };
    } catch {
      signal.throwIfAborted();
      return { ok: false, failure: { kind: "invalid" } };
    }
  }

  /**
   * The newest hundred releases hold the newest nightly. The newest stable release can be older
   * than all of them, so it also comes from the latest-release endpoint, which only a stable
   * release can be.
   */
  async function githubReleases(signal: AbortSignal, answers: SourceAnswer[]) {
    const base = `${options.api}/repos/${options.repository}`;
    const page = await attempt(
      "github",
      signal,
      answers,
      async (response) =>
        offersOf(
          GitHubRelease()
            .array()
            .assert(await response.json()),
        ),
      `${base}/releases?per_page=100`,
    );
    if (!page.ok) return page;
    const latest = await attempt(
      "github",
      signal,
      answers,
      async (response) => offersOf([GitHubRelease().assert(await response.json())]),
      `${base}/releases/latest`,
    );
    // No stable release yet answers 404; the page alone has everything then. Any other failure
    // fails the check, since the newest stable release may be missing from the page.
    const none = !latest.ok && latest.failure.kind === "http" && latest.failure.status === 404;
    if (!latest.ok && !none) return latest;
    const stable = latest.ok ? latest.offers : [];
    const known = new Set(page.offers.map((offer) => offer.feedUrl));
    const offers = [...page.offers, ...stable.filter((each) => !known.has(each.feedUrl))];
    return {
      ok: true as const,
      offers: offers.map((offer) => {
        const previous = newestOn(
          "stable",
          offers.filter((each) => compareVersions(each.version, offer.version) < 0),
        );
        return !offer.version.nightly && previous
          ? { ...offer, previousStable: previous.version }
          : offer;
      }),
    };
  }

  function offersOf(releases: readonly Infer<typeof GitHubRelease>[]): Offer[] {
    return releases.flatMap((release): Offer[] => {
      const version = parseVersion(release.tag_name);
      if (!version || release.draft) return [];
      if ((channelOf(version) === "nightly") !== release.prerelease) return [];
      const metadata = release.assets.find((asset) => asset.name === options.metadataFile);
      if (!metadata) return [];
      const url = metadata.browser_download_url;
      return [
        {
          version,
          feedUrl: url.slice(0, url.lastIndexOf("/")),
          notes: release.body ?? null,
          page: release.html_url ?? null,
        },
      ];
    });
  }
}

const GitHubRelease = lazy(() =>
  type({
    tag_name: "string",
    prerelease: "boolean",
    draft: "boolean",
    "body?": "string | null",
    "html_url?": "string",
    assets: type({ name: "string", browser_download_url: "string" }).array(),
  }),
);

function answerOf(source: SourceAnswer["source"], response: Response): SourceAnswer {
  const number = (name: string) => {
    const value = Number(response.headers.get(name));
    return response.headers.has(name) && Number.isFinite(value) ? value : null;
  };
  return {
    source,
    status: response.status,
    remaining: number("x-ratelimit-remaining"),
    reset: number("x-ratelimit-reset"),
    retryAfter: number("retry-after"),
  };
}

/**
 * GitHub answers 403 or 429 when it limits requests: with no requests remaining until a reset
 * time, or with a Retry-After for its secondary limits. Other refusals are plain HTTP errors.
 */
function failureOf(answer: SourceAnswer, now: number): CheckFailure {
  const status = answer.status ?? 0;
  const limited =
    status === 429 || (status === 403 && (answer.remaining === 0 || answer.retryAfter !== null));
  if (!limited) return { kind: "http", status };
  if (answer.retryAfter !== null) return { kind: "busy", until: now + answer.retryAfter * 1000 };
  return { kind: "busy", until: answer.reset !== null ? answer.reset * 1000 : null };
}
