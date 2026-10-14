import type { ArchiveWindow, StreamFormat } from "@mrstreamer/contracts/playback";
import type { AccountStatus } from "@mrstreamer/contracts/subscription";
import { t } from "./i18n.ts";

/** A category as the provider lists it. */
export interface ProviderCategory {
  readonly id: string;
  /** Exactly as the provider wrote it: "BE | VLAANDEREN". */
  readonly name: string;
}

/** A channel as the provider lists it, with the provider's loose fields made consistent. */
export interface ProviderChannel {
  readonly id: string;
  /** Exactly as the provider wrote it: "BE | VRT 1 FHD (VLAANDEREN)". */
  readonly name: string;
  readonly number: number | null;
  readonly logoUrl: string | null;
  readonly categoryIds: readonly string[];
  /** The channel's id in the provider's programme guide, when it has one. */
  readonly guideId: string | null;
  /** Marked for adults by the provider, where its list says so. */
  readonly adult?: boolean;
  /** How many days of catch-up the provider keeps of the channel, or null for none. */
  readonly catchupDays: number | null;
}

/**
 * A live catalogue as the provider delivers it. Adapters report names as they are; the catalogue
 * module decides how to show them, the same way for every provider.
 */
export interface LiveCatalogue {
  readonly categories: readonly ProviderCategory[];
  readonly channels: readonly ProviderChannel[];
}

/** A movie or a series as the provider lists it. */
export interface ProviderTitle {
  readonly id: string;
  /** Exactly as the provider wrote it: "Blow 2001 (NL)". */
  readonly name: string;
  readonly posterUrl: string | null;
  readonly backdropUrl: string | null;
  /** Out of 10. */
  readonly rating: number | null;
  /** Movies: when added. Series: when last changed. Epoch milliseconds. */
  readonly addedAt: number | null;
  /** "2026-08-20", for the year when the name has none. */
  readonly releaseDate: string | null;
  readonly categoryIds: readonly string[];
  readonly adult: boolean;
  /** The file type movies stream as: "mkv", "mp4". Null for series, whose episodes have their own. */
  readonly container: string | null;
  /**
   * The Movie Database's id, which Xtream Codes lists carry when the provider filled it: the same
   * film in several language versions shares it.
   */
  readonly tmdbId?: string | null;
  /** Playlist metadata is requested when details open, never for the whole import. */
  readonly metadata?: "lazy";
  /** Mapped series' current exact files. No URLs, headers or guessed episode identities. */
  readonly episodeFiles?: readonly string[];
}

/** Movies and series as the provider delivers them, each with its own categories. */
export interface OnDemandCatalogue {
  readonly movieCategories: readonly ProviderCategory[];
  readonly movies: readonly ProviderTitle[];
  readonly seriesCategories: readonly ProviderCategory[];
  readonly series: readonly ProviderTitle[];
}

/** What the provider knows about one movie or series beyond its list entry. */
export interface ProviderDetails {
  readonly originalName: string | null;
  readonly plot: string | null;
  readonly genres: readonly string[];
  readonly cast: readonly string[];
  readonly directors: readonly string[];
  readonly releaseDate: string | null;
  /** Seconds: the movie, or a usual episode. */
  readonly duration: number | null;
  readonly posterUrl: string | null;
  readonly backdropUrl: string | null;
  /** Series only, in any order; empty for movies. */
  readonly seasons: readonly {
    readonly number: number;
    readonly name: string | null;
    readonly posterUrl: string | null;
  }[];
  /** Series only, in any order; empty for movies. */
  readonly episodes: readonly ProviderEpisode[];
  /** M3U episodes follow playlist order. Xtream keeps its established numeric ordering. */
  readonly episodeOrder?: "source";
  /** Movies only: the file type, when the details name it. */
  readonly container: string | null;
}

export interface ProviderEpisode {
  readonly id: string;
  readonly season: number;
  readonly number: number;
  /** Exactly as the provider wrote it: "Race Across the World (NL) - S02E03 - Tbilisi". */
  readonly name: string;
  readonly plot: string | null;
  readonly duration: number | null;
  readonly stillUrl: string | null;
  readonly airDate: string | null;
  /** Epoch milliseconds the file arrived, when the provider says. */
  readonly addedAt: number | null;
  readonly container: string;
}

/** Where a channel streams from, and how. */
export interface LiveStream {
  readonly url: string;
  readonly format: StreamFormat;
  /** Headers the stream wants on every request, such as a playlist's User-Agent or Referer. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** A recording from the catch-up archive: where it streams from, and the moment it starts at. */
export interface ArchiveStream extends LiveStream {
  /**
   * Epoch milliseconds the recording starts at: the start asked for, or the whole minute or
   * second before it where the provider's address counts in those.
   */
  readonly start: number;
}

/** What a subscription answers when asked for its programme guide. */
export type LiveGuide =
  /** An XMLTV document, as it downloads. */
  | { readonly kind: "document"; readonly body: ReadableStream<Uint8Array> }
  /**
   * The subscription has no guide: a playlist whose first line names none. An answer, not a
   * failure, which a guide that can't be reached or read is.
   */
  | { readonly kind: "none" };

/**
 * One connected subscription. Adapters translate a provider's API into the catalogue model and
 * throw `AppFailure` with a specific error when the provider refuses or cannot be reached.
 */
export interface Provider {
  authenticate(signal?: AbortSignal): Promise<AccountStatus>;
  liveCatalogue(signal?: AbortSignal): Promise<LiveCatalogue>;
  /**
   * Upstream stream location for a channel. Contains credentials, so it stays in the main process.
   * A playlist may first read itself again, as after a restart that loaded channels from disk.
   */
  liveStream(channelId: string, signal?: AbortSignal): Promise<LiveStream>;
  /**
   * Upstream location of a channel's recorded past in `window`, from the provider's catch-up
   * archive. Some addresses name no end, and the provider then sends on past the window: playback
   * stops it there. Contains credentials, so it stays in the main process. Whether
   * the channel keeps that window is the caller's to check first (see ./catchup.ts); a playlist
   * channel without catch-up fails with `catch-up`.
   */
  archiveStream(
    channelId: string,
    window: ArchiveWindow,
    signal?: AbortSignal,
  ): Promise<ArchiveStream>;
  /**
   * Requests an address `liveStream` or `titleFile` gave, the way `providerFetch` does: never
   * sending the login unencrypted after an https address.
   */
  request(url: string, init?: RequestInit): Promise<Response>;
  /**
   * The provider's programme guide, or that it has none. A playlist reads its first line again
   * for it, so a guide its publisher added, moved or dropped since is found.
   */
  liveGuide(signal?: AbortSignal): Promise<LiveGuide>;
  onDemandCatalogue(signal?: AbortSignal): Promise<OnDemandCatalogue>;
  movieDetails(id: string, signal?: AbortSignal): Promise<ProviderDetails>;
  seriesDetails(id: string, signal?: AbortSignal): Promise<ProviderDetails>;
  /**
   * Upstream file location of a movie or an episode, with its file type. Contains credentials, so
   * it stays in the main process.
   */
  titleFile(
    kind: "movie" | "episode",
    id: string,
    container: string,
    signal?: AbortSignal,
  ): Promise<ProviderFile>;
  /** Main-only import snapshot; bounded Settings inspection uses the last read, refresh asks afresh. */
  playlistImport?(
    signal?: AbortSignal,
    fresh?: boolean,
  ): Promise<import("./playlist/catalogue.ts").ImportedPlaylist>;
}

export interface ProviderFile {
  readonly url: string;
  readonly container: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Options every adapter shares. `fetch` is injectable so tests can run against a local server. */
export interface ProviderOptions {
  readonly userAgent: string;
  readonly fetch?: typeof fetch;
}

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** As many redirects as fetch follows. */
const MAX_REDIRECTS = 20;

/**
 * Fetch for a provider's addresses, which carry `login`, its username and password. It follows
 * GET redirects itself and refuses one that `exposesLogin`, so an https address never sends the
 * login unencrypted. Its errors name no address beyond its origin.
 */
export function providerFetch(fetchImpl: typeof fetch, login: readonly string[]) {
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    try {
      const start = new URL(url);
      let target = start;
      for (let redirects = 0; ; redirects++) {
        const response = await fetchImpl(target.href, { ...init, redirect: "manual" });
        const location = REDIRECTS.has(response.status) ? response.headers.get("location") : null;
        if (location === null) return response;
        void response.body?.cancel().catch(() => {});
        if (redirects === MAX_REDIRECTS) throw new TypeError(t("It redirected too many times."));
        const next = new URL(location, target);
        if (exposesLogin(start, next, login)) {
          throw new TypeError(
            t(
              "It redirected to an unencrypted address with your login in it, so Mr. Streamer stopped.",
            ),
          );
        }
        target = next;
      }
    } catch (cause) {
      throw withoutAddress(cause);
    }
  };
}

/**
 * Whether following a redirect to `target` sends the login unencrypted when the request started
 * at an https address: an http target whose user info, path segments or query values hold the
 * username or the password. One that holds neither, such as a stream's address with a token of
 * its own, is followed. The stricter rule, never following https to http, would be
 * `start.protocol === "https:" && target.protocol === "http:"`.
 */
function exposesLogin(start: URL, target: URL, login: readonly string[]): boolean {
  if (start.protocol !== "https:" || target.protocol !== "http:") return false;
  const parts = [
    ...[target.username, target.password, ...target.pathname.split("/")].map(decoded),
    ...target.searchParams.values(),
  ];
  return login.some((secret) => secret !== "" && parts.includes(secret));
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * `text` with every web address cut to its origin, `http://host:8080/…`: provider addresses carry
 * the login in their path and query, and messages from fetch can quote them.
 */
export function withoutAddresses(text: string): string {
  return text.replace(/\b([a-z][a-z\d+.-]*):\/\/[^\s"'<>]+/gi, (address, scheme: string) => {
    const origin = URL.parse(address)?.origin;
    return origin && origin !== "null" ? `${origin}/…` : `${scheme}://…`;
  });
}

/** What was thrown, or when its message quotes an address, a TypeError saying it without one. */
function withoutAddress(cause: unknown): unknown {
  const messages = [cause, cause instanceof Error ? cause.cause : null].map((each) =>
    each instanceof Error ? each.message : "",
  );
  if (!messages.some((message) => message.includes("://"))) return cause;
  return new TypeError(withoutAddresses(messages[0] ?? ""));
}
