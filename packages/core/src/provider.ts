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
  /**
   * An XMLTV document, as it downloads, and how many bytes it is when the server says: null
   * when it doesn't, or when the connection unpacks it on the way.
   */
  | {
      readonly kind: "document";
      readonly body: ReadableStream<Uint8Array>;
      readonly size: number | null;
    }
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
   * Requests an address `liveStream`, `archiveStream` or `titleFile` gave, or, with that address
   * as `from`, one its playlists named, the way `providerFetch` does: after an https address,
   * sending http nothing that holds the login as it recognizes it.
   */
  request(url: string, init?: RequestInit, from?: string): Promise<Response>;
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
 * What of a provider's login its addresses and headers can carry, as its adapter knows it.
 * `secrets` are the login for certain: an account's username and password, or a playlist link's
 * user info and token. They count wherever they are, however short. `uncertain` values can be a
 * token as well as a setting, such as the `output=ts` a panel's playlist link carries beside the
 * login: those count only as a whole part (`whole`).
 */
export interface ProviderLogin {
  readonly secrets: readonly string[];
  readonly uncertain?: readonly string[];
}

/**
 * Fetch for a provider's addresses, which carry `login`. It follows GET redirects itself. After an
 * https address it sends nothing to http that holds the login as `exposesLogin` reads it, and a
 * header that holds it goes to no other origin (`sentWith`). `from` is
 * the stream's address when its playlists named `url`, as they name variants, segments and keys:
 * those are held to `from` as its redirects are. Its errors name no address beyond its origin.
 */
export function providerFetch(fetchImpl: typeof fetch, login: ProviderLogin) {
  // An empty value would be in everything.
  const known: ProviderLogin = {
    secrets: login.secrets.filter(Boolean),
    uncertain: login.uncertain?.filter(Boolean) ?? [],
  };
  return async (url: string, init: RequestInit = {}, from = url): Promise<Response> => {
    try {
      const admitted = new URL(from);
      const headers = new Headers(init.headers);
      let target = new URL(url);
      for (let redirects = 0; ; redirects++) {
        if (exposesLogin(admitted, target, known)) {
          throw new TypeError(
            redirects === 0
              ? t(
                  "The stream's playlist named an unencrypted address with your login in it, so Mr. Streamer stopped.",
                )
              : t(
                  "It redirected to an unencrypted address with your login in it, so Mr. Streamer stopped.",
                ),
          );
        }
        const response = await fetchImpl(target.href, {
          ...init,
          headers: sentWith(headers, admitted, target, known),
          redirect: "manual",
        });
        const location = REDIRECTS.has(response.status) ? response.headers.get("location") : null;
        if (location === null) return response;
        void response.body?.cancel().catch(() => {});
        if (redirects === MAX_REDIRECTS) throw new TypeError(t("It redirected too many times."));
        target = new URL(location, target);
      }
    } catch (cause) {
      throw withoutAddress(cause);
    }
  };
}

/**
 * Whether a request to `target` sends the login unencrypted, its stream's address `admitted`
 * being https: an http target whose user info, path or query holds any of it (`holdsLogin`). Its
 * host isn't looked at: a request names that in the clear over https too. One that holds none,
 * such as a stream's address with a token of its own, is asked. The stricter rule, never following
 * https to http, would be `admitted.protocol === "https:" && target.protocol === "http:"`.
 */
function exposesLogin(admitted: URL, target: URL, login: ProviderLogin): boolean {
  if (admitted.protocol !== "https:" || target.protocol !== "http:") return false;
  const { username, password, pathname, search, searchParams } = target;
  const written: Carried[] = [{ text: username }, { text: password }, { text: pathname }];
  // Uncertain values count in the query's values only: its names, as the `ts` of
  // `?ts=1700000000`, name settings.
  return holdsLogin(
    login,
    [...written, { text: search, query: true }],
    [...written, ...Array.from(searchParams.values(), (text) => ({ text, query: true }))],
  );
}

/**
 * The headers a request to `target` carries: all of them at the origin of its stream's address,
 * `admitted`. Elsewhere one that holds any of the login stays behind, except a Referer, which
 * goes cut to its origin, as a browser sends one to another origin.
 */
function sentWith(headers: Headers, admitted: URL, target: URL, login: ProviderLogin): Headers {
  if (target.origin === admitted.origin) return headers;
  // A header reads as written, its "+" a plus; one that is an address, as a Referer is, has a
  // query as well.
  const holds = (text: string) =>
    holdsLogin(login, [{ text }, { text: URL.parse(text)?.search ?? "", query: true }]);
  const sent = new Headers();
  headers.forEach((value, name) => {
    if (!holds(value)) sent.set(name, value);
    else if (name === "referer") {
      const origin = URL.parse(value)?.origin;
      if (origin && origin !== "null" && !holds(origin)) sent.set(name, `${origin}/`);
    }
  });
  return sent;
}

/**
 * Text a request carries: user info, a path or a header, where "+" is a plus, or a query, which
 * servers read with "+" a space as well, as a form spells one.
 */
interface Carried {
  readonly text: string;
  readonly query?: boolean;
}

/**
 * Whether texts hold any of `login`: a secret anywhere in one of `anywhere`, joined to other text
 * as in `user:password` too, and an uncertain value as a whole part of one of `parts`. Each is
 * read as written and decoded (`decodings`). Text still encoded after that counts as holding a
 * secret: what it hides can't be told.
 */
function holdsLogin(login: ProviderLogin, anywhere: readonly Carried[], parts = anywhere): boolean {
  const { secrets, uncertain = [] } = login;
  return (
    (secrets.length > 0 &&
      anywhere.some(({ text, query }) => {
        const { forms, deeper } = decodings(text, query);
        return deeper || forms.some((form) => secrets.some((secret) => form.includes(secret)));
      })) ||
    parts.some(({ text, query }) =>
      decodings(text, query).forms.some((form) => uncertain.some((value) => whole(form, value))),
    )
  );
}

/** How many times text is decoded after it is read as written. */
const DECODINGS = 4;

/**
 * `text` as written and each text `decoded` reads from it, up to `DECODINGS` decodings deep. Each
 * decoding of a query reads its "+" both as a plus and as a space, so every order counts: a
 * server reads a form's "+" as a space, and code given the value can decode it again either way.
 * A query's texts at most double with each decoding. `deeper` when one more decoding would read
 * text none of these is.
 */
function decodings(
  text: string,
  query = false,
): { readonly forms: readonly string[]; readonly deeper: boolean } {
  const forms = new Set([text]);
  for (let layer = [text], times = 0; ; times++) {
    const next = new Set<string>();
    for (const form of layer) {
      for (const spaces of query ? [false, true] : [false]) {
        const read = decoded(form, spaces);
        if (!forms.has(read)) next.add(read);
      }
    }
    if (next.size === 0 || times === DECODINGS) return { forms: [...forms], deeper: next.size > 0 };
    for (const form of next) forms.add(form);
    layer = [...next];
  }
}

/** What runs on in a name, as in `index.m3u8` or `seg_1.ts`: beside it, a value is part of one. */
const NAME = /[\p{L}\p{N}\-._~]/u;

/**
 * Whether `value` is in `text` without a name's character right before or after it: a path
 * segment, a query value or a part of one between separators, as in `auth=guest:k9x`, but not
 * the `ts` of `index.ts`.
 */
function whole(text: string, value: string): boolean {
  for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
    if (!NAME.test(text[at - 1] ?? "") && !NAME.test(text[at + value.length] ?? "")) return true;
  }
  return false;
}

/**
 * `text` decoded once: with `spaces`, "+" as a space first, then its percent escapes as UTF-8, as
 * URLSearchParams decodes them. A byte order mark stays; bytes that are no UTF-8 read as U+FFFD,
 * one for each character cut short or byte that starts none, and the characters beside them
 * still decode; a `%` that encodes nothing stays as it is.
 */
function decoded(text: string, spaces: boolean): string {
  const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });
  return (spaces ? text.replaceAll("+", " ") : text).replace(/(?:%[\da-f]{2})+/gi, (run) =>
    utf8.decode(Uint8Array.from(run.slice(1).split("%"), (hex) => Number.parseInt(hex, 16))),
  );
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
