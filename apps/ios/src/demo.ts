import { AppFailure } from "@mrstreamer/contracts/errors";
import type { AccountStatus } from "@mrstreamer/contracts/subscription";
import {
  playlistCatalogue,
  streamFormat,
  type PlaylistStream,
} from "@mrstreamer/core/playlist/catalogue";
import { m3uReader, type PlaylistEntry } from "@mrstreamer/core/playlist/m3u";
import {
  providerFetch,
  type LiveCatalogue,
  type OnDemandCatalogue,
  type Provider,
  type ProviderDetails,
} from "@mrstreamer/core/provider";
import { bodySize, describeNetworkError } from "@mrstreamer/core/xtream";

// Existing demo subscriptions use this provider without a login. Its movie and its
// series are original generated samples kept in this repository (apps/ios/demo-media). They are
// listed here, and play and download from GitHub at the commit that added them, through the app's
// usual title, player and download owners. Nothing here has a TMDB id, a year, a cast, a rating
// or a language: the samples have none, and their audio is a generated tone.
//
// Live is off: the demo lists no channels and asks nothing for them. The adapter can read the
// certification playlist instead, for when its broadcasters' rights are settled, but only a test
// turns that on. That read is one bounded HTTPS file, of which only HTTPS HLS channels are kept,
// with no guide and no catch-up. Only an adapter's newest successful read replaces its streams.
// Nothing here retries, caches or touches the media itself; failures are the usual typed errors.

/** The demo's subscription id: no colon (`ownedKey`), never made for an account. */
export const DEMO_ID = "demo";

/** The media commit must remain an ancestor of main when these pinned assets are delivered. */
const MEDIA_COMMIT = "9791b09908e03742cee981c97e37d47829fc7a18";
const MEDIA = `https://raw.githubusercontent.com/Mr-Streamer-OSS/MrStreamer/${MEDIA_COMMIT}/apps/ios/demo-media/`;

/** The demo as the roster will list it. It is never saved with the accounts and has no login. */
export const demoEntry = {
  id: DEMO_ID,
  kind: "demo",
  name: "Demo",
  /** Where its lists and files come from, for failure copy that names a host. */
  server: new URL(MEDIA).origin,
  username: "",
} as const;
export type DemoEntry = typeof demoEntry;

/** What the demo's Live lists: nothing, or the certification playlist. */
export type DemoLive = { readonly kind: "none" } | { readonly kind: "playlist" };

/** Off until the broadcasters' rights are settled. Only a test passes another. */
const LIVE: DemoLive = { kind: "none" };

const PLAYLIST =
  "https://raw.githubusercontent.com/Mr-Streamer-OSS/certification-playlist/main/reviewer.m3u";
const PLAYLIST_BYTES = 64 * 1024;
const PLAYLIST_CHANNELS = 32;
const PLAYLIST_TIMEOUT_MS = 20_000;

/** The account line Settings and the login check see. Nothing is asked. */
const STATUS: AccountStatus = {
  state: "active",
  expiresAt: null,
  maxConnections: null,
  activeConnections: null,
};

const NO_CHANNELS: LiveCatalogue = { categories: [], channels: [] };

const MOVIE_ID = "movie";
const SERIES_ID = "series";
const MOVIE_CATEGORY = "sample-movies";
const SERIES_CATEGORY = "sample-series";

/** Seconds, measured from the files (apps/ios/demo-media/catalogue.tsv). */
const MOVIE_SECONDS = 150;
const EPISODE_SECONDS = 90;

const CATALOGUE: OnDemandCatalogue = {
  movieCategories: [{ id: MOVIE_CATEGORY, name: "Sample movies" }],
  movies: [
    {
      id: MOVIE_ID,
      name: "Generated sample movie",
      posterUrl: `${MEDIA}movie-cover.png`,
      backdropUrl: `${MEDIA}movie-backdrop.png`,
      rating: null,
      addedAt: null,
      releaseDate: null,
      categoryIds: [MOVIE_CATEGORY],
      adult: false,
      container: "mp4",
      tmdbId: null,
    },
  ],
  seriesCategories: [{ id: SERIES_CATEGORY, name: "Sample series" }],
  series: [
    {
      id: SERIES_ID,
      name: "Generated sample series",
      posterUrl: `${MEDIA}series-cover.png`,
      backdropUrl: `${MEDIA}series-backdrop.png`,
      rating: null,
      addedAt: null,
      releaseDate: null,
      categoryIds: [SERIES_CATEGORY],
      adult: false,
      container: null,
      tmdbId: null,
    },
  ],
};

const MOVIE: ProviderDetails = {
  originalName: null,
  plot: "An original sample made for Mr. Streamer: generated shapes and a quiet tone, no speech.",
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: MOVIE_SECONDS,
  posterUrl: `${MEDIA}movie-cover.png`,
  backdropUrl: `${MEDIA}movie-backdrop.png`,
  seasons: [],
  episodes: [],
  container: "mp4",
};

const episode = (number: number) => ({
  id: `episode-${number}`,
  season: 1,
  number,
  name: `Episode ${number}`,
  plot: null,
  duration: EPISODE_SECONDS,
  stillUrl: null,
  airDate: null,
  addedAt: null,
  container: "mp4",
});

const SERIES: ProviderDetails = {
  originalName: null,
  plot: "Two original samples made for Mr. Streamer: generated shapes and a quiet tone, no speech.",
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: EPISODE_SECONDS,
  posterUrl: `${MEDIA}series-cover.png`,
  backdropUrl: `${MEDIA}series-backdrop.png`,
  seasons: [{ number: 1, name: null, posterUrl: null }],
  episodes: [episode(1), episode(2)],
  container: null,
};

/** Each playable file's name in apps/ios/demo-media, by the kind and id `titleFile` is asked. */
const FILES = {
  movie: new Map([[MOVIE_ID, "movie.mp4"]]),
  episode: new Map(SERIES.episodes.map(({ id }): [string, string] => [id, `${id}.mp4`])),
} as const;

const notFound = (titleId: string) => new AppFailure({ kind: "title-not-found", titleId });

/** One channel's stream as the demo plays it: the playlist's address and headers, nothing else. */
type Stream = Pick<PlaylistStream, "url" | "headers">;

/**
 * The built-in demo. `fetch` and `live` are for tests: the app passes neither, so Live stays off
 * and nothing is fetched for it.
 */
export function demoProvider(
  options: { readonly fetch?: typeof fetch; readonly live?: DemoLive } = {},
): Provider {
  const live = options.live ?? LIVE;
  const get = providerFetch(httpsOnly(options.fetch ?? fetch), { secrets: [] });
  /** The streams of the newest read that installed them, by channel id. */
  let streams: ReadonlyMap<string, Stream> | null = null;
  /** Reads started, and the number of the one whose streams are installed. */
  let started = 0;
  let installed = 0;

  async function channels(signal?: AbortSignal): Promise<LiveCatalogue> {
    if (live.kind === "none") return NO_CHANNELS;
    const mine = ++started;
    const entries = await playlistEntries(get, signal);
    const parsed = playlistCatalogue(entries.filter(isHttpsHls).slice(0, PLAYLIST_CHANNELS));
    if (signal?.aborted) throw stopped(signal);
    // An older read that ends after a newer one, or an aborted one, keeps the newer streams.
    if (mine > installed) {
      installed = mine;
      const next = new Map<string, Stream>();
      for (const [id, { url, headers }] of parsed.streams) next.set(id, { url, headers });
      streams = next;
    }
    return {
      categories: parsed.categories,
      channels: parsed.channels.map((channel) => ({
        ...channel,
        logoUrl: channel.logoUrl?.startsWith("https://") ? channel.logoUrl : null,
        catchupDays: null,
      })),
    };
  }

  return {
    authenticate: async () => STATUS,
    liveCatalogue: channels,
    async liveStream(channelId, signal) {
      if (live.kind === "none") throw new AppFailure({ kind: "channel-not-found", channelId });
      // After a launch that showed the saved list, this adapter hasn't read the playlist yet.
      if (!streams?.has(channelId)) await channels(signal);
      const stream = streams?.get(channelId);
      if (!stream) throw new AppFailure({ kind: "channel-not-found", channelId });
      return Object.keys(stream.headers).length > 0
        ? { url: stream.url, format: "hls", headers: stream.headers }
        : { url: stream.url, format: "hls" };
    },
    archiveStream: async () => {
      throw new AppFailure({ kind: "catch-up", reason: "none" });
    },
    request: (url, init) => get(url, init),
    liveGuide: async () => ({ kind: "none" }),
    liveGuideRequest: async () => ({ kind: "none" }),
    onDemandCatalogue: async () => CATALOGUE,
    async movieDetails(id) {
      if (id !== MOVIE_ID) throw notFound(id);
      return MOVIE;
    },
    async seriesDetails(id) {
      if (id !== SERIES_ID) throw notFound(id);
      return SERIES;
    },
    async titleFile(kind, id) {
      const file = FILES[kind].get(id);
      if (!file) throw notFound(id);
      return { url: `${MEDIA}${file}`, container: "mp4" };
    },
  };
}

/** A fetch that asks only https addresses, so no redirect takes the playlist to a cleartext one. */
function httpsOnly(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) =>
    new URL(input instanceof Request ? input.url : String(input)).protocol === "https:"
      ? fetchImpl(input, init)
      : Promise.reject(new TypeError("The demo's lists must come over https."));
}

const isHttpsHls = (entry: PlaylistEntry) =>
  URL.parse(entry.url)?.protocol === "https:" && streamFormat(entry.url) === "hls";

const stopped = (signal: AbortSignal): unknown => signal.reason ?? new Error("The read stopped.");

const tooLarge = () =>
  new AppFailure({
    kind: "invalid-input",
    detail: "The demo channel list is larger than the app reads.",
  });

const notAPlaylist = () =>
  new AppFailure({ kind: "invalid-input", detail: "The demo channel list isn't a playlist." });

/** A fetch with no body stream can't be read in bounded pieces, so the list isn't read at all. */
const unbounded = () =>
  new AppFailure({
    kind: "unexpected",
    detail: "The demo channel list can't be read in bounded pieces on this device.",
  });

/**
 * The playlist's entries, read no further than PLAYLIST_BYTES: a size the server declares past
 * that is refused before the body is read, and a body that grows past it is cancelled there. A
 * fetch that gives no body stream is refused, never read whole: its declared size can be wrong,
 * or describe a packed body that unpacks larger.
 */
async function playlistEntries(
  get: (url: string, init?: RequestInit) => Promise<Response>,
  signal?: AbortSignal,
): Promise<PlaylistEntry[]> {
  const timeout = AbortSignal.timeout(PLAYLIST_TIMEOUT_MS);
  const origin = new URL(PLAYLIST).origin;
  try {
    const response = await get(PLAYLIST, {
      headers: { "Cache-Control": "no-store" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const declared = bodySize(response);
    if (!response.ok || (declared !== null && declared > PLAYLIST_BYTES)) {
      void response.body?.cancel().catch(() => {});
      throw response.ok
        ? tooLarge()
        : new AppFailure({ kind: "provider-error", status: response.status });
    }
    if (!response.body) throw unbounded();
    const reader = m3uReader();
    const entries: PlaylistEntry[] = [];
    const decoder = new TextDecoder();
    const pieces = response.body.getReader();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await pieces.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > PLAYLIST_BYTES) throw tooLarge();
        entries.push(...reader.push(decoder.decode(value, { stream: true })));
        if (reader.playlist === false) throw notAPlaylist();
      }
    } catch (cause) {
      void pieces.cancel().catch(() => {});
      throw cause;
    }
    entries.push(...reader.push(decoder.decode()), ...reader.end());
    if (reader.playlist !== true) throw notAPlaylist();
    return entries;
  } catch (cause) {
    if (cause instanceof AppFailure || signal?.aborted) throw cause;
    throw new AppFailure({
      kind: "unreachable",
      server: origin,
      detail: describeNetworkError(cause),
    });
  }
}
