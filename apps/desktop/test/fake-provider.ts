// A fake Xtream Codes provider for tests. Its catalogue has the messiness of real panels:
// prefixed names, separator entries, numbers sent as strings and missing logos. It allows one
// connection at a time by default, like most subscriptions. The category "TEST | Formats and
// failures" streams the recordings in test/fixtures, one codec combination each, plus an offline
// channel; every other channel streams an empty MPEG-TS program. About half the channels have a
// guide id, shared by variants of one channel, and xmltv.php serves their programmes. The last
// category, "BE | Kwaliteit", lists one channel in Full HD, HD and SD, the Full HD one off air.
//
// "TEST | H.264 + AAC" keeps three days of catch-up and "TEST | HEVC + AAC" two, as `tv_archive`
// and `tv_archive_duration` say; the login's answer names the panel's time zone. Their timeshift
// addresses, `/timeshift/user/pass/<minutes>/<YYYY-MM-DD:HH-MM>/<id>.ts`, send the channel's
// recording once and end, and `archiveRequests` lists the windows asked for.
//
// Movies and series come with their own categories, one of them for adults, and one series is
// marked for adults in an ordinary category. Their files redirect
// to another address, as real panels do, and answer byte ranges; each open file holds a
// connection slot like a live stream. The "TEST" movies and the "TEST | Formats" series stream the
// title clips in test/fixtures; every other title streams the MP4 clip. One TEST movie and the
// "TEST | Formats" series come in two versions sharing a TMDB id, as providers list a title once
// per language.
//
// With `second`, it is another provider beside that one, whose panel numbers everything as the
// first's does: the same ids, most of them for other titles, and some of the first's films and
// series under ids of its own.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable, type Writable } from "node:stream";
import { URL } from "node:url";
import { crc32 as zlibCrc32, deflateSync } from "node:zlib";

export interface FakeChannel {
  readonly streamId: number;
  readonly num: number;
  readonly name: string;
  readonly categoryId: string;
  readonly hasLogo: boolean;
  /** Answers 404 instead of a stream. */
  readonly offline: boolean;
  /** File in test/fixtures that the channel streams. */
  readonly fixture: string | null;
  /** The channel's id in the guide, or null. */
  readonly guideId: string | null;
  /** Flagged for adults. */
  readonly adult?: boolean;
  /** Days of catch-up the panel keeps of it; none when absent. */
  readonly archiveDays?: number;
}

/** A timeshift request that reached the provider: the minutes and start in its address. */
export interface ArchiveRequest {
  readonly streamId: string;
  readonly minutes: number;
  /** As the address writes it, on the panel's clock: "2026-10-13:14-00". */
  readonly start: string;
}

interface FakeCatalogue {
  readonly categories: readonly { readonly id: string; readonly name: string }[];
  readonly channels: readonly FakeChannel[];
}

/** Writes a channel's stream to `out` until `signal` aborts or the stream ends. */
type StreamSource = (channel: FakeChannel, out: Writable, signal: AbortSignal) => void;

export interface FakeProviderOptions {
  readonly channels?: number;
  /** Custom channel metadata for layout and guide scenarios, without changing stream handling. */
  readonly channelOf?: (channel: FakeChannel) => FakeChannel;
  /** Serves synthetic channel marks of different natural dimensions instead of missing logos. */
  readonly logoSvg?: (channel: FakeChannel) => string;
  /**
   * Lists channel logos as PNG files, `/logos/<id>.png`, and serves these bytes for them, such as
   * `pngLogo`'s: raster marks, as most panels send, in place of `logoSvg`'s SVG ones.
   */
  readonly logoPng?: (channel: FakeChannel) => Buffer;
  readonly username?: string;
  readonly password?: string;
  readonly maxConnections?: number;
  readonly accountStatus?: "Active" | "Expired" | "Banned" | "Disabled";
  /**
   * The time zone the login's answer names as the panel's (`server_info.timezone`), whose clock
   * its timeshift addresses are on: "Europe/Amsterdam" unless given, none with null.
   */
  readonly timeZone?: string | null;
  /**
   * How long a closed stream keeps its connection slot. Real panels often lag behind; with 0 the
   * slot is free as soon as the provider hears the close.
   */
  readonly slotReleaseMs?: number;
  /** Replaces the default streams. */
  readonly streams?: StreamSource;
  /**
   * Sends recordings at their real-time rate and then keeps the connection open, like a live
   * channel, instead of sending them at once and closing.
   */
  readonly live?: boolean;
  /** The guide id the channel list sends for a channel, in place of its own. */
  readonly guideIdOf?: (channel: FakeChannel) => string | null;
  /**
   * Serves `gridGuide` over these hours around each request in place of the default guide: what a
   * guide grid scrolls through, past and ahead.
   */
  readonly guideHours?: { readonly past: number; readonly ahead: number };
  /** Programme lengths, in minutes, for a grid fixture that includes very short slots. */
  readonly guideLengths?: readonly number[];
  /** About how many movies and series to list, besides the test titles. */
  readonly titles?: number;
  /** Exact series count, independent of movie count, including a requested long series. */
  readonly series?: number;
  /**
   * The movies and series to list in place of the built ones, made from them, such as
   * `browseTitles` adds: these have details and files like the built titles, which
   * `serveTitles`' new ids lack.
   */
  readonly titlesOf?: (built: FakeTitles) => FakeTitles;
  /**
   * Answers every request for a movie's or episode's file with the whole file, whatever range it
   * asks for, as a provider that knows no byte ranges does.
   */
  readonly wholeFiles?: boolean;
  /**
   * How many file servers take turns behind a title's address, each with its own ETag for the
   * same file, as a provider's load balancer spreads requests; one when absent.
   */
  readonly fileHosts?: number;
  /**
   * Marks each answer for a file with the time it was sent as Last-Modified, and no ETag, as
   * servers do that stamp their answers rather than their files.
   */
  readonly fileDates?: boolean;
  /**
   * Adds channels for adults: "AFTER HOURS", flagged in an ordinary category, with guide id
   * "afterhours.adult", and "LATE SHOW" and "NIGHT CLUB" in a category named "XXX | ADULTS".
   */
  readonly adultChannels?: boolean;
  /**
   * Adds "TEST | Long-running (EN)", the newest series: 20 seasons of 26 episodes, each with a
   * story and the file facts panels send: 1 MB of details, near a long-running show's on a panel.
   */
  readonly longSeries?: boolean;
  /**
   * Another provider's movies and series, listed under the very ids the default lists use. The
   * TEST movies are the same films under the same ids. Of the others, every second one is the
   * default's next film in English, so under another id than it has there, with its TMDB id or,
   * where the default sends none, without; the rest are films of its own, "Other Story". Its
   * "TEST | Formats (DE)" is the default's series of that TMDB id with one season of two episodes,
   * under the default's own series and episode ids; its other series are its own.
   */
  readonly second?: boolean;
}

interface FakeTitle {
  readonly id: number;
  readonly name: string;
  readonly categoryId: string;
  readonly adult: boolean;
  readonly rating: number;
  /** Epoch seconds. */
  readonly added: number;
  readonly container: string;
  /** File in test/fixtures it streams; null answers 404. */
  readonly fixture: string | null;
  /** The TMDB id it shares with another version of the film, when it is one. */
  readonly tmdb?: string;
}

/**
 * An episode's file, numbered by its place in the season unless `number` says otherwise. `info`
 * adds to what its details send about it.
 */
type FakeEpisode = FakeTitle & {
  readonly number?: number;
  readonly info?: Readonly<Record<string, unknown>>;
};

interface FakeSeries {
  readonly id: number;
  readonly name: string;
  readonly categoryId: string;
  /** Marked for adults, though its category's name doesn't say so. */
  readonly adult: boolean;
  readonly added: number;
  /** Episodes per season, in order. */
  readonly seasons: readonly (readonly FakeEpisode[])[];
  /** Explicit provider season numbers, including Specials at zero. */
  readonly seasonNumbers?: readonly number[];
  /** The TMDB id it shares with another version of the series, when it is one. */
  readonly tmdb?: string;
}

export interface FakeTitles {
  readonly movieCategories: readonly { readonly id: string; readonly name: string }[];
  readonly movies: readonly FakeTitle[];
  readonly seriesCategories: readonly { readonly id: string; readonly name: string }[];
  readonly series: readonly FakeSeries[];
}

export interface FakeProvider {
  readonly url: string;
  readonly catalogue: FakeCatalogue;
  readonly titles: FakeTitles;
  /** Requests for the movie/series lists and their categories, including refused ones. */
  titleListRequests(): number;
  /** How many requests for movie and episode files reached the provider, redirects included. */
  fileRequests(): number;
  /** How many bytes of movie and episode files the provider has sent. */
  fileBytes(): number;
  /** The most movie and episode files the provider was sending at the same moment. */
  mostFilesAtOnce(): number;
  /**
   * Puts another file behind a movie's address, as a provider that replaces one does: a clip by
   * its name in test/fixtures, or its bytes. Its ETag changes with it.
   */
  replaceMovieFile(movieId: number, file: string | Buffer): void;
  /**
   * Has a movie's file count as another with every answer, its ETag changing each time and its
   * bytes not, as a provider's whose file never stays the same one; or stops that.
   */
  unsettleMovieFile(movieId: number, unsettled: boolean): void;
  /**
   * Makes a movie's file stall: each time the provider reaches byte `at` of it, it waits `ms`
   * before sending on, as a slow provider keeps a reader waiting in the middle of a file.
   */
  stallMovieFile(movieId: number, at: number, ms: number): void;
  /**
   * Makes the provider wait `ms` before it answers a request for a part of a file that names
   * where it ends, which is how the subtitles before a position are read and never how ffmpeg
   * reads a run.
   */
  slowFileParts(ms: number): void;
  /**
   * Holds every request for a part of a file that names where it ends, as `slowFileParts` slows
   * them, until the function it answers is called: then they, and any asked for later, are
   * answered at once. A held request that closes meanwhile is never answered.
   */
  holdFileParts(): () => void;
  /** Hold an episode transfer at a byte boundary for UI queue/progress proof. */
  stallEpisodeFile(episodeId: number, at: number, ms: number): void;
  /** Replace an episode file, including an empty answer to exercise failure and retry. */
  replaceEpisodeFile(episodeId: number, file: string | Buffer): void;
  /** How many requests for a movie's or series' details reached the provider. */
  detailRequests(): number;
  /**
   * Makes movie and series list requests answer with this HTTP status, or restores them. "login"
   * answers the two lists with a refused login and HTTP 200, as panels do, while their categories
   * still answer.
   */
  failTitles(status: number | "login" | null): void;
  /** Makes requests for a movie's or series' details answer with this HTTP status, or restores them. */
  failDetails(status: number | null): void;
  /** Makes the movie and series categories answer an empty list, as a busy panel does, or not. */
  emptyTitleCategories(empty: boolean): void;
  /**
   * Picks the movies, series and categories each later list request returns, as a panel's
   * updates would: titles dropped, listed again, renamed, given another TMDB id, or a series
   * given other episodes, which its details then list.
   */
  serveTitles(select: (all: FakeTitles) => FakeTitles): void;
  /** Streams currently holding a connection slot. */
  activeStreams(): number;
  /** Picks the channel list each later request returns, as panel updates would. */
  serveChannels(select: (all: readonly FakeChannel[]) => readonly FakeChannel[]): void;
  /** Picks category metadata each later request returns, for browsing and refresh checks. */
  serveCategories(select: (all: FakeCatalogue["categories"]) => FakeCatalogue["categories"]): void;
  /** Makes catalogue requests answer with this HTTP status, or restores them with null. */
  failCatalogue(status: number | null): void;
  /**
   * Replaces what xmltv.php answers: a document, an HTTP status, or "hold" to never answer. By
   * default it serves `fakeGuide` around the time of each request. `pieceBytes` sends the document
   * in writes of that size, so tags split across network chunks.
   */
  serveGuide(answer: string | number | "hold" | null, options?: { pieceBytes?: number }): void;
  /** How many times xmltv.php was requested. */
  guideRequests(): number;
  /**
   * Leaves requests for the channel list, the guide or the movie and series lists unanswered.
   * `arrived` settles when the first reaches the provider, and `release` has them answered.
   */
  hold(what: Held): { readonly arrived: Promise<void>; release(): void };
  /** How many stream requests reached the provider. */
  streamRequests(): number;
  /** The timeshift requests that reached the provider, in order, refused ones too. */
  archiveRequests(): readonly ArchiveRequest[];
  /**
   * Breaks off the next timeshift answer sent at its real-time rate after `pieces` tenths of a
   * second of it, as a connection that drops does.
   */
  breakNextArchive(pieces: number): void;
  close(): Promise<void>;
}

/** Requests a test can keep waiting, by what they ask for. */
type Held = "channels" | "guide" | "titles";
/** What each `player_api.php` action a test can hold asks for. */
const HELD_ACTIONS: Readonly<Record<string, Held>> = {
  get_live_streams: "channels",
  get_vod_streams: "titles",
  get_series: "titles",
};

/** The fixture channels, in the order the test category lists them. */
const FIXTURE_CHANNELS: readonly { name: string; fixture: string | null; archiveDays?: number }[] =
  [
    { name: "TEST | H.264 + AAC", fixture: "h264-aac.mpegts", archiveDays: 3 },
    { name: "TEST | H.264 + MP2", fixture: "h264-mp2.mpegts" },
    { name: "TEST | H.264 + MP3", fixture: "h264-mp3.mpegts" },
    { name: "TEST | H.264 + AC-3", fixture: "h264-ac3.mpegts" },
    { name: "TEST | H.264 + AC-3 DVB", fixture: "h264-ac3-dvb.mpegts" },
    { name: "TEST | H.264 + E-AC-3", fixture: "h264-eac3.mpegts" },
    { name: "TEST | HEVC + AAC", fixture: "hevc-aac.mpegts", archiveDays: 2 },
    { name: "TEST | HEVC 10-bit + AAC", fixture: "hevc10-aac.mpegts" },
    { name: "TEST | MPEG-2 + MP2", fixture: "mpeg2-mp2.mpegts" },
    /** An open-GOP broadcast joined mid-sequence: it starts with frames that cannot be decoded. */
    { name: "TEST | H.264 joined mid-stream", fixture: "h264-open-gop-joined.mpegts" },
    /** Lost packets mid-stream, which a decoder has to conceal. */
    { name: "TEST | H.264 damaged", fixture: "h264-damaged.mpegts" },
    /** English and Dutch sound, DVB subtitles, teletext page 888 and captions in the picture. */
    { name: "TEST | Subtitles and two sound tracks", fixture: "h264-subtitles.mpegts" },
    { name: "TEST | Offline", fixture: null },
  ];

export async function startFakeProvider(options: FakeProviderOptions = {}): Promise<FakeProvider> {
  const username = options.username ?? "demo";
  const password = options.password ?? "demo";
  const maxConnections = options.maxConnections ?? 1;
  const slotReleaseMs = options.slotReleaseMs ?? 300;
  const streams = options.streams ?? (options.live ? liveStreams : defaultStreams);
  const built = buildCatalogue(options.channels ?? 300, options.adultChannels ?? false);
  const catalogue = options.channelOf
    ? { ...built, channels: built.channels.map(options.channelOf) }
    : built;
  const listed = buildTitles(options.titles ?? 120, options.second ?? false, options.series);
  const withLong = options.longSeries
    ? { ...listed, series: [longSeries(), ...listed.series].slice(0, options.series) }
    : listed;
  const titles = options.titlesOf ? options.titlesOf(withLong) : withLong;
  const movieFiles = new Map(titles.movies.map((movie) => [String(movie.id), movie]));
  const episodeFiles = new Map(
    titles.series
      .flatMap((series) => series.seasons.flat())
      .map((episode) => [String(episode.id), episode]),
  );
  let titleFailure: number | "login" | null = null;
  let detailFailure: number | null = null;
  let titleCategoriesEmpty = false;
  let selectTitles = (all: FakeTitles): FakeTitles => all;
  let fileCount = 0;
  /** The bytes put behind a title's address in place of its clip, and how many times. */
  const replaced = new Map<FakeTitle, { readonly bytes: Buffer; readonly times: number }>();
  /** The titles whose file is put in its own place again with every answer. */
  const unsettled = new Set<FakeTitle>();
  const stalls = new Map<FakeTitle, Stall>();
  let partsWait = 0;
  /** Settles when held parts may be answered; null when none are held. */
  let partsHeld: Promise<void> | null = null;
  let fileTurn = 0;
  let fileBytesSent = 0;
  let filesOpen = 0;
  let mostFilesOpen = 0;
  let detailCount = 0;
  let titleListCount = 0;
  let select = (all: readonly FakeChannel[]): readonly FakeChannel[] => all;
  let selectCategories = (all: FakeCatalogue["categories"]): FakeCatalogue["categories"] => all;
  let catalogueFailure: number | null = null;
  const channels = new Map(
    catalogue.channels.map((channel) => [String(channel.streamId), channel]),
  );
  let slots = 0;
  /** Gives back the connection slot of a request that closed, `slotReleaseMs` later. */
  const freeSlot = () => {
    if (slotReleaseMs > 0) setTimeout(() => slots--, slotReleaseMs);
    else slots--;
  };
  let origin = "";
  let guideAnswer: string | number | "hold" | null = null;
  let guidePieceBytes = 0;
  let guideCount = 0;
  let streamCount = 0;
  const archiveAsked: ArchiveRequest[] = [];
  let archiveBreak: number | null = null;
  const timeZone = options.timeZone === undefined ? "Europe/Amsterdam" : options.timeZone;
  /** What a test asked to keep waiting, until it releases each. */
  const held = new Map<Held, { readonly arrived: () => void; readonly released: Promise<void> }>();
  /** Answers a request now, or once the test releases it when it is being held. */
  const answering = (what: Held, answer: () => void): void => {
    const hold = held.get(what);
    if (!hold) return answer();
    hold.arrived();
    void hold.released.then(answer);
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/player_api.php") {
      const what = HELD_ACTIONS[url.searchParams.get("action") ?? ""];
      return what ? answering(what, () => api(url, response)) : api(url, response);
    }
    const logo = /^\/logos\/(\d+)\.(svg|png)$/.exec(url.pathname);
    const logoChannel = logo
      ? catalogue.channels.find((channel) => String(channel.streamId) === logo[1])
      : undefined;
    if (logoChannel && logo?.[2] === "svg" && options.logoSvg) {
      return void response
        .writeHead(200, { "Content-Type": "image/svg+xml" })
        .end(options.logoSvg(logoChannel));
    }
    if (logoChannel && logo?.[2] === "png" && options.logoPng) {
      return void response
        .writeHead(200, { "Content-Type": "image/png" })
        .end(options.logoPng(logoChannel));
    }
    if (url.pathname === "/xmltv.php") return answering("guide", () => guide(url, response));
    const live = /^\/live\/([^/]+)\/([^/]+)\/(\d+)\.ts$/.exec(url.pathname);
    if (live) return stream(live[1] ?? "", live[2] ?? "", live[3] ?? "", request, response);
    const shifted = /^\/timeshift\/([^/]+)\/([^/]+)\/(\d+)\/([\d:-]+)\/(\d+)\.ts$/.exec(
      url.pathname,
    );
    if (shifted) return timeshift(shifted, request, response);
    const title = /^\/(movie|series)\/([^/]+)\/([^/]+)\/(\d+)\.(\w+)$/.exec(url.pathname);
    if (title) return redirectFile(title, response);
    const file = /^\/files\/(\d+)\/(movie|series)\/(\d+)$/.exec(url.pathname);
    if (file)
      return serveFile(
        file[2] === "movie" ? movieFiles : episodeFiles,
        file[3] ?? "",
        file[1] ?? "",
        request,
        response,
      );
    response.writeHead(404).end();
  });

  function api(url: URL, response: ServerResponse): void {
    if (
      url.searchParams.get("username") !== username ||
      url.searchParams.get("password") !== password
    ) {
      return json(response, { user_info: { auth: 0 } });
    }
    const action = url.searchParams.get("action");
    if (
      ["get_vod_categories", "get_series_categories", "get_vod_streams", "get_series"].includes(
        action ?? "",
      )
    )
      titleListCount++;
    if (action === null) {
      const now = Math.floor(Date.now() / 1000);
      return json(response, {
        user_info: {
          username,
          auth: 1,
          status: options.accountStatus ?? "Active",
          exp_date: String(now + 180 * 24 * 60 * 60),
          active_cons: String(slots),
          max_connections: String(maxConnections),
        },
        server_info: {
          timestamp_now: now,
          ...(timeZone === null ? {} : { timezone: timeZone }),
        },
      });
    }
    if (catalogueFailure !== null && action?.startsWith("get_live")) {
      return void response.writeHead(catalogueFailure).end();
    }
    if (titleFailure === "login" && (action === "get_vod_streams" || action === "get_series")) {
      return json(response, { user_info: { auth: 0 } });
    }
    if (
      typeof titleFailure === "number" &&
      (action?.startsWith("get_vod") || action?.startsWith("get_series"))
    ) {
      return void response.writeHead(titleFailure).end();
    }
    const categoryRows = (categories: FakeTitles["movieCategories"]) =>
      (titleCategoriesEmpty ? [] : categories).map((category) => ({
        category_id: category.id,
        category_name: category.name,
        parent_id: 0,
      }));
    const listedNow = selectTitles(titles);
    if (action === "get_vod_categories")
      return json(response, categoryRows(listedNow.movieCategories));
    if (action === "get_series_categories") {
      return json(response, categoryRows(listedNow.seriesCategories));
    }
    if (action === "get_vod_streams") {
      return json(
        response,
        listedNow.movies.map((movie) => ({
          num: movie.id,
          name: movie.name,
          stream_type: "movie",
          stream_id: movie.id,
          stream_icon: movie.id % 4 === 0 ? "" : `https://image.example/p/${movie.id}.jpg`,
          // Panels send ratings as strings and "0" for none.
          rating: movie.rating ? String(movie.rating) : "0",
          added: String(movie.added),
          // Panels flag some titles for adults, here every other one, and leave the rest to their
          // category's name.
          is_adult: movie.adult && movie.id % 8 === 3 ? 1 : 0,
          category_id: movie.categoryId,
          category_ids: [Number(movie.categoryId)],
          container_extension: movie.container,
          // TMDB ids, as the standard list field: 10,000 more than the stream id, and "0" for a
          // few, as panels write for none.
          tmdb: movie.tmdb ?? (movie.id % 7 === 0 ? "0" : String(movie.id + 10_000)),
        })),
      );
    }
    if (action === "get_series") {
      return json(
        response,
        listedNow.series.map((series) => ({
          num: series.id,
          name: series.name,
          series_id: series.id,
          cover: `https://image.example/s/${series.id}.jpg`,
          backdrop_path: series.id % 2 === 0 ? [`https://image.example/b/${series.id}.jpg`] : [],
          rating: "7.5",
          last_modified: String(series.added),
          releaseDate: "2024-03-01",
          category_id: series.categoryId,
          category_ids: [Number(series.categoryId)],
          is_adult: series.adult ? 1 : 0,
          tmdb: series.tmdb ?? String(series.id + 10_000),
        })),
      );
    }
    if (action === "get_vod_info" || action === "get_series_info") {
      detailCount++;
      if (detailFailure !== null) return void response.writeHead(detailFailure).end();
    }
    if (action === "get_vod_info") {
      const movie = movieFiles.get(url.searchParams.get("vod_id") ?? "");
      if (!movie) return json(response, { info: [], movie_data: [] });
      return json(response, {
        info: {
          name: movie.name,
          o_name: movie.name.replace(/ \(\w+\)$/, ""),
          plot: `The story of ${movie.name}.`,
          genre: "Actie, Thriller",
          cast: "Ada Lovelace, Alan Turing",
          director: "Grace Hopper",
          releasedate: "1981-05-23",
          duration_secs: 6000,
          duration: "01:40:00",
          backdrop_path: [`https://image.example/b/m${movie.id}.jpg`],
          cover_big: `https://image.example/p/${movie.id}.jpg`,
        },
        movie_data: { stream_id: movie.id, container_extension: movie.container },
      });
    }
    if (action === "get_series_info") {
      // As the lists have it now, with the episodes a panel's update gave it, or as it was listed
      // before it was dropped.
      const asked = (each: FakeSeries) => String(each.id) === url.searchParams.get("series_id");
      const series = listedNow.series.find(asked) ?? titles.series.find(asked);
      if (!series) return json(response, { info: [], episodes: [] });
      // Panels list seasons incompletely: the last season is missing here.
      return json(response, {
        seasons: series.seasons.slice(0, -1).map((_episodes, index) => ({
          season_number: series.seasonNumbers?.[index] ?? index + 1,
          name: `Seizoen ${index + 1}`,
          cover: "",
        })),
        info: { name: series.name, plot: `All about ${series.name}.`, episode_run_time: "45" },
        episodes: Object.fromEntries(
          series.seasons.map((episodes, index) => [
            String(series.seasonNumbers?.[index] ?? index + 1),
            episodes.map((episode, place) => {
              const number = episode.number ?? place + 1;
              return {
                id: String(episode.id),
                episode_num: number,
                season: series.seasonNumbers?.[index] ?? index + 1,
                title: `${series.name} - S${String(series.seasonNumbers?.[index] ?? index + 1).padStart(2, "0")}E${String(number).padStart(2, "0")} - Part ${number}`,
                container_extension: episode.container,
                added: String(episode.added),
                info: {
                  duration_secs: 2700,
                  movie_image: `https://image.example/e/${episode.id}.jpg`,
                  ...episode.info,
                },
              };
            }),
          ]),
        ),
      });
    }
    if (action === "get_live_categories") {
      return json(
        response,
        selectCategories(catalogue.categories).map((category) => ({
          category_id: category.id,
          category_name: category.name,
          parent_id: 0,
        })),
      );
    }
    if (action === "get_live_streams") {
      return json(
        response,
        select(catalogue.channels).map((channel) => ({
          // Real panels mix numbers and numeric strings.
          num: channel.num % 3 === 0 ? String(channel.num) : channel.num,
          name: channel.name,
          stream_type: "live",
          stream_id: channel.streamId,
          stream_icon: channel.hasLogo
            ? `${origin}/logos/${channel.streamId}.${options.logoPng ? "png" : "svg"}`
            : "",
          category_id: channel.categoryId,
          category_ids: [Number(channel.categoryId)],
          is_adult: channel.adult ? 1 : 0,
          // Panels mark catch-up 0 or 1, its days as a number or a string.
          tv_archive: channel.archiveDays ? 1 : 0,
          tv_archive_duration: channel.archiveDays ? String(channel.archiveDays) : 0,
          // Panels send null or "" for channels without a guide.
          epg_channel_id:
            (options.guideIdOf ?? ((each) => each.guideId))(channel) ??
            (channel.streamId % 2 === 0 ? "" : null),
        })),
      );
    }
    json(response, []);
  }

  function guide(url: URL, response: ServerResponse): void {
    guideCount++;
    if (
      url.searchParams.get("username") !== username ||
      url.searchParams.get("password") !== password
    ) {
      return void response.writeHead(401).end();
    }
    if (guideAnswer === "hold") return;
    if (typeof guideAnswer === "number") return void response.writeHead(guideAnswer).end();
    const document =
      guideAnswer ??
      (options.guideHours
        ? gridGuide(catalogue, Date.now(), options.guideHours, options.guideLengths)
        : fakeGuide(catalogue, Date.now()));
    response.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
    if (!guidePieceBytes) return void response.end(document);
    const bytes = Buffer.from(document, "utf8");
    const size = guidePieceBytes;
    let offset = 0;
    const next = () => {
      if (offset >= bytes.length) return void response.end();
      response.write(bytes.subarray(offset, offset + size));
      offset += size;
      setImmediate(next);
    };
    next();
  }

  function stream(
    user: string,
    pass: string,
    id: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const channel = channels.get(id);
    if (decodeURIComponent(user) !== username || decodeURIComponent(pass) !== password) {
      return void response.writeHead(401).end();
    }
    streamCount++;
    if (!channel || channel.offline) return void response.writeHead(404).end();
    if (slots >= maxConnections) return void response.writeHead(403).end();

    slots++;
    const closed = new AbortController();
    request.on("close", () => {
      if (closed.signal.aborted) return;
      closed.abort();
      freeSlot();
    });
    response.writeHead(200, { "Content-Type": "video/mp2t" });
    streams(channel, response, closed.signal);
  }

  /**
   * A channel's recording from its catch-up archive: its clip, once, at its real-time rate when
   * `live`, then the end. Holds a connection slot as a stream does.
   */
  function timeshift(match: RegExpExecArray, request: IncomingMessage, response: ServerResponse) {
    const [, user = "", pass = "", minutes = "", start = "", id = ""] = match;
    if (decodeURIComponent(user) !== username || decodeURIComponent(pass) !== password) {
      return void response.writeHead(401).end();
    }
    archiveAsked.push({ streamId: id, minutes: Number(minutes), start });
    const channel = channels.get(id);
    if (!channel?.archiveDays || !channel.fixture) return void response.writeHead(404).end();
    if (slots >= maxConnections) return void response.writeHead(403).end();
    slots++;
    let released = false;
    request.on("close", () => {
      if (released) return;
      released = true;
      freeSlot();
    });
    response.writeHead(200, { "Content-Type": "video/mp2t" });
    const recording = fixture(channel.fixture);
    if (!options.live) return void response.end(recording);
    // A tenth of a second at a time, as `liveStreams` sends it, unless the connection breaks.
    const pieces = chunked(recording, Math.ceil(recording.length / 30));
    const breaks = archiveBreak;
    archiveBreak = null;
    const sent = Readable.from(
      (async function* () {
        for (const [index, piece] of pieces.entries()) {
          if (index === breaks) return void response.destroy();
          yield piece;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      })(),
    );
    response.on("close", () => sent.destroy());
    sent.pipe(response);
  }

  /** Sends a movie or episode request on to where the file is, like a panel's load balancer. */
  function redirectFile(match: RegExpExecArray, response: ServerResponse): void {
    fileCount++;
    const [, folder, user, pass, id] = match;
    if (
      decodeURIComponent(user ?? "") !== username ||
      decodeURIComponent(pass ?? "") !== password
    ) {
      return void response.writeHead(401).end();
    }
    const host = fileTurn++ % (options.fileHosts ?? 1);
    response.writeHead(302, { Location: `${origin}/files/${host}/${folder}/${id}` }).end();
  }

  /** Puts `bytes` behind a title's address as another file than was there. */
  function replace(title: FakeTitle, bytes: Buffer): void {
    replaced.set(title, { bytes, times: (replaced.get(title)?.times ?? 0) + 1 });
  }

  /** A title's file, whole or the byte range asked for. An open file holds a connection slot. */
  function serveFile(
    files: ReadonlyMap<string, FakeTitle>,
    id: string,
    host: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    fileCount++;
    const title = files.get(id);
    if (!title?.fixture) return void response.writeHead(404).end();
    if (slots >= maxConnections) return void response.writeHead(403).end();
    if (unsettled.has(title)) replace(title, replaced.get(title)?.bytes ?? fixture(title.fixture));
    const other = replaced.get(title);
    const bytes = other?.bytes ?? fixture(title.fixture);
    const range = options.wholeFiles
      ? null
      : /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    if (start >= bytes.length) {
      return void response.writeHead(416, { "Content-Range": `bytes */${bytes.length}` }).end();
    }
    slots++;
    filesOpen++;
    mostFilesOpen = Math.max(mostFilesOpen, filesOpen);
    let released = false;
    request.on("close", () => {
      if (released) return;
      released = true;
      filesOpen--;
      freeSlot();
    });
    const answer = () => {
      if (response.destroyed) return;
      response.writeHead(range ? 206 : 200, {
        "Content-Type": title.container === "mkv" ? "video/x-matroska" : "video/mp4",
        ...(options.wholeFiles ? {} : { "Accept-Ranges": "bytes" }),
        ...(options.fileDates
          ? { "Last-Modified": new Date().toUTCString() }
          : { ETag: `"${host}-${id}-${other?.times ?? 0}"` }),
        "Content-Length": end - start + 1,
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` } : {}),
      });
      // In pieces, counted as they leave: a reader that stops early took only so many.
      const pieces = Readable.from(sent(bytes.subarray(start, end + 1), start, stalls.get(title)));
      pieces.on("data", (piece: Buffer) => (fileBytesSent += piece.length));
      response.on("close", () => pieces.destroy());
      pieces.pipe(response);
    };
    if (range?.[2] && partsHeld) void partsHeld.then(answer);
    else if (range?.[2] && partsWait > 0) setTimeout(answer, partsWait);
    else answer();
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fake provider has no address.");
  origin = `http://127.0.0.1:${address.port}`;

  return {
    url: origin,
    catalogue,
    titles,
    fileRequests: () => fileCount,
    fileBytes: () => fileBytesSent,
    mostFilesAtOnce: () => mostFilesOpen,
    replaceMovieFile(movieId, file) {
      const movie = movieFiles.get(String(movieId));
      if (movie) replace(movie, typeof file === "string" ? fixture(file) : file);
    },
    unsettleMovieFile(movieId, on) {
      const movie = movieFiles.get(String(movieId));
      if (!movie) return;
      if (on) unsettled.add(movie);
      else unsettled.delete(movie);
    },
    stallMovieFile(movieId, at, ms) {
      const movie = movieFiles.get(String(movieId));
      if (movie) stalls.set(movie, { at, ms });
    },
    stallEpisodeFile(episodeId, at, ms) {
      const episode = episodeFiles.get(String(episodeId));
      if (episode) stalls.set(episode, { at, ms });
    },
    replaceEpisodeFile(episodeId, file) {
      const episode = episodeFiles.get(String(episodeId));
      if (episode) replace(episode, typeof file === "string" ? fixture(file) : file);
    },
    slowFileParts(ms) {
      partsWait = ms;
    },
    holdFileParts() {
      const held = Promise.withResolvers<void>();
      partsHeld = held.promise;
      return () => {
        partsHeld = null;
        held.resolve();
      };
    },
    detailRequests: () => detailCount,
    titleListRequests: () => titleListCount,
    failTitles(status) {
      titleFailure = status;
    },
    failDetails(status) {
      detailFailure = status;
    },
    emptyTitleCategories(empty) {
      titleCategoriesEmpty = empty;
    },
    serveTitles(select) {
      selectTitles = select;
    },
    activeStreams: () => slots,
    serveChannels(next) {
      select = next;
    },
    serveCategories(next) {
      selectCategories = next;
    },
    failCatalogue(status) {
      catalogueFailure = status;
    },
    serveGuide(answer, options = {}) {
      guideAnswer = answer;
      guidePieceBytes = options.pieceBytes ?? 0;
    },
    guideRequests: () => guideCount,
    hold(what) {
      const arrived = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      held.set(what, { arrived: arrived.resolve, released: released.promise });
      return {
        arrived: arrived.promise,
        release() {
          held.delete(what);
          released.resolve();
        },
      };
    },
    streamRequests: () => streamCount,
    archiveRequests: () => archiveAsked,
    breakNextArchive(pieces) {
      archiveBreak = pieces;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Thirty minutes, the length of every fake programme. */
const SLOT_MS = 30 * 60 * 1000;

/**
 * An XMLTV document for the catalogue's guide channels: half-hour programmes from two hours before
 * `around` to a day after it, written with a +02:00 offset as European panels do. Titles repeat per
 * channel with the slot number, "Earth News 3", and every third has no description.
 */
export function fakeGuide(catalogue: FakeCatalogue, around: number): string {
  const first = Math.floor(around / SLOT_MS) * SLOT_MS - 4 * SLOT_MS;
  const ids = [...new Set(catalogue.channels.flatMap((channel) => channel.guideId ?? []))];
  const parts = ['<?xml version="1.0" encoding="utf-8" ?><tv generator-info-name="fake">'];
  for (const id of ids)
    parts.push(`<channel id="${id}"><display-name>${id}</display-name></channel>`);
  for (const [index, id] of ids.entries()) {
    const word = WORDS[index % WORDS.length] ?? "Earth";
    for (let slot = 0; slot < 52; slot++) {
      const start = first + slot * SLOT_MS;
      const description =
        slot % 3 === 0 ? "" : `<desc>Episode ${slot} of ${word} &amp; friends.</desc>`;
      parts.push(
        `<programme start="${xmltvTime(start)}" stop="${xmltvTime(start + SLOT_MS)}" channel="${id}">` +
          `<title lang="en">${word} News ${slot}</title>${description}</programme>`,
      );
    }
  }
  parts.push("</tv>");
  return parts.join("\n");
}

/** Programme lengths a grid guide mixes, in minutes. */
const LENGTHS = [15, 30, 45, 60, 90, 120];
const SHOWS = ["Journal", "Report", "Live", "Weekly", "Tonight", "Classics", "Kids", "Film"];

/**
 * An XMLTV document for the catalogue's guide channels over `hours` before and after `around`, as
 * a guide grid shows it: programmes of 15 minutes to two hours, in a mix that differs per channel,
 * and on every fifth channel two hours without any, from three hours before `around`. Titles
 * name the channel's word and a show, "Harbour Weekly"; every third has no description.
 */
function gridGuide(
  catalogue: FakeCatalogue,
  around: number,
  hours: { readonly past: number; readonly ahead: number },
  lengths: readonly number[] = LENGTHS,
): string {
  const hour = 60 * 60 * 1000;
  const first = Math.floor(around / hour) * hour - hours.past * hour;
  const last = around + hours.ahead * hour;
  const missing = Math.floor(around / hour) * hour - 3 * hour;
  const ids = [...new Set(catalogue.channels.flatMap((channel) => channel.guideId ?? []))];
  const parts = ['<?xml version="1.0" encoding="utf-8" ?><tv generator-info-name="fake">'];
  for (const id of ids)
    parts.push(`<channel id="${id}"><display-name>${id}</display-name></channel>`);
  for (const [index, id] of ids.entries()) {
    const word = WORDS[index % WORDS.length] ?? "Earth";
    for (let slot = 0, start = first; start < last; slot++) {
      const minutes = lengths[(index * 7 + slot * 13) % lengths.length] ?? 30;
      const stop = start + minutes * 60 * 1000;
      if (index % 5 !== 4 || stop <= missing || start >= missing + 2 * hour) {
        const show = SHOWS[(index + slot) % SHOWS.length] ?? "Journal";
        const description = slot % 3 === 0 ? "" : `<desc>${word} ${show}, part ${slot}.</desc>`;
        parts.push(
          `<programme start="${xmltvTime(start)}" stop="${xmltvTime(stop)}" channel="${id}">` +
            `<title lang="en">${word} ${show}</title>${description}</programme>`,
        );
      }
      start = stop;
    }
  }
  parts.push("</tv>");
  return parts.join("\n");
}

/** "20261002140000 +0200" */
function xmltvTime(time: number): string {
  const local = new Date(time + 2 * 60 * 60 * 1000).toISOString();
  return `${local.slice(0, 19).replace(/[-T:]/g, "")} +0200`;
}

/** Reads a recording from test/fixtures. */
export function fixture(name: string): Buffer {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
}

/** Fixture channels send their recording once; the rest send an empty program without end. */
const defaultStreams: StreamSource = (channel, out, signal) => {
  if (channel.fixture) {
    out.end(fixture(channel.fixture));
    return;
  }
  out.write(EMPTY_PROGRAM);
  const timer = setInterval(() => out.write(NULL_PACKETS), 20);
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
};

/** Recordings play out over their three seconds, then the connection stays open without data. */
export const liveStreams: StreamSource = (channel, out, signal) => {
  if (!channel.fixture) return defaultStreams(channel, out, signal);
  const recording = fixture(channel.fixture);
  const step = Math.ceil(recording.length / 30);
  let offset = 0;
  const timer = setInterval(() => {
    out.write(recording.subarray(offset, offset + step));
    offset += step;
    if (offset >= recording.length) clearInterval(timer);
  }, 100);
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
};

/** Builds a catalogue of roughly `size` channels. The same size always gives the same catalogue. */
function buildCatalogue(size: number, adultChannels: boolean): FakeCatalogue {
  const random = mulberry32(size);
  const pick = (items: readonly string[]): string =>
    items[Math.floor(random() * items.length)] ?? items[0] ?? "";

  const categories = [{ id: "1", name: "TEST | Formats and failures" }];
  const channels: FakeChannel[] = FIXTURE_CHANNELS.map((test, index) => ({
    streamId: 1000 + index,
    num: index + 1,
    name: test.name,
    categoryId: "1",
    hasLogo: false,
    offline: test.fixture === null,
    fixture: test.fixture,
    // The first test channel has a guide, so a packaged app shows programmes on Home.
    guideId: index === 0 ? "aac.test" : null,
    ...(test.archiveDays ? { archiveDays: test.archiveDays } : {}),
  }));

  const groups = REGIONS.flatMap((region) => GENRES.map((genre) => `${region} | ${genre}`));
  const perGroup = Math.max(1, Math.ceil((size - channels.length) / groups.length));
  for (const [groupIndex, group] of groups.entries()) {
    const categoryId = String(groupIndex + 2);
    categories.push({ id: categoryId, name: group });
    const region = group.split(" | ")[0] ?? "UK";
    // Many panels open each group with a separator "channel".
    channels.push({
      streamId: 2000 + channels.length,
      num: channels.length + 1,
      name: `##### ${group.toUpperCase()} #####`,
      categoryId,
      hasLogo: false,
      offline: true,
      fixture: null,
      guideId: null,
    });
    for (let i = 0; i < perGroup && channels.length < size; i++) {
      const style = random();
      const word = pick(WORDS);
      const suffix = pick(SUFFIXES);
      const base = `${word}${suffix}${pick(QUALITY)}`.toUpperCase();
      const name = style < 0.4 ? `${region}: ${base}` : style < 0.6 ? `${region} | ${base}` : base;
      const streamId = 2000 + channels.length;
      channels.push({
        streamId,
        num: channels.length + 1,
        name,
        categoryId,
        hasLogo: random() < 0.7,
        offline: false,
        fixture: null,
        // Quality variants of one channel share its guide id, as on real panels.
        guideId:
          streamId % 2 === 0
            ? `${word}${suffix}.${region}`.replaceAll(" ", "").toLowerCase()
            : null,
      });
    }
  }
  // One channel in three qualities, as panels list them, of which Full HD is off air.
  const qualities = String(categories.length + 1);
  categories.push({ id: qualities, name: "BE | Kwaliteit" });
  for (const [index, quality] of ["FHD", "HD", "SD"].entries()) {
    channels.push({
      streamId: QUALITY_STREAM_IDS + index,
      num: channels.length + 1,
      name: `BE | KWALITEIT 1 ${quality}`,
      categoryId: qualities,
      hasLogo: false,
      offline: quality === "FHD",
      fixture: null,
      guideId: index === 2 ? null : "kwaliteit1.be",
    });
  }
  if (adultChannels) {
    const adult = String(categories.length + 1);
    categories.push({ id: adult, name: "XXX | ADULTS" });
    const add = (streamId: number, name: string, categoryId: string, flagged: boolean) =>
      channels.push({
        streamId,
        num: channels.length + 1,
        name,
        categoryId,
        hasLogo: false,
        offline: false,
        fixture: "h264-aac.mpegts",
        guideId: flagged ? "afterhours.adult" : null,
        ...(flagged ? { adult: true } : {}),
      });
    add(4000, "AFTER HOURS", "2", true);
    add(4001, "LATE SHOW", adult, false);
    add(4002, "NIGHT CLUB", adult, false);
  }
  return { categories, channels };
}

/** Where the provider waits in a file, and for how long. */
interface Stall {
  readonly at: number;
  readonly ms: number;
}

/** `bytes`, which begin at byte `start` of their file, in pieces, waiting at `stall` on the way. */
async function* sent(bytes: Buffer, start: number, stall: Stall | undefined) {
  const before = stall ? stall.at - start : 0;
  if (!stall || before <= 0 || before >= bytes.length) return yield* chunked(bytes, 16 * 1024);
  yield* chunked(bytes.subarray(0, before), 16 * 1024);
  await new Promise((resolve) => setTimeout(resolve, stall.ms));
  yield* chunked(bytes.subarray(before), 16 * 1024);
}

/** `bytes` in pieces of at most `size`. */
function chunked(bytes: Buffer, size: number): Buffer[] {
  const pieces: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    pieces.push(bytes.subarray(offset, offset + size));
  }
  return pieces;
}

/** Stream ids of the channel in three qualities, after every other channel's. */
export const QUALITY_STREAM_IDS = 100_000;

/**
 * The movies that stream the title clips, and what each one tests. `versionOf` makes one another
 * version of an earlier film, by the index of that film here: they share its TMDB id.
 */
const TEST_MOVIES: readonly {
  name: string;
  container: string;
  fixture: string | null;
  versionOf?: number;
}[] = [
  {
    name: "TEST | Two sound tracks and subtitles (MULTI)",
    container: "mkv",
    fixture: "title-h264-eac3-subs.mkv",
  },
  { name: "TEST | Index at the end (NL)", container: "mp4", fixture: "title-h264-aac.mp4" },
  { name: "TEST | Old AVI (NL)", container: "avi", fixture: "title-mpeg4-mp3.avi" },
  { name: "TEST | Missing file (NL)", container: "mkv", fixture: null },
  {
    name: "TEST | Picture subtitles (MULTI)",
    container: "mkv",
    fixture: "title-h264-picture-subs.mkv",
  },
  { name: "TEST | Broadcast recording (NL)", container: "ts", fixture: "h264-subtitles.mpegts" },
  // Dubbed, so an English viewer gets the version above, with this one to pick.
  {
    name: "TEST | Two sound tracks and subtitles 1080p (NL AUDIO)",
    container: "mp4",
    fixture: "title-h264-aac.mp4",
    versionOf: 0,
  },
  // Subtitles that last long or build on earlier ones; see scripts/subtitle-fixtures.ts.
  { name: "TEST | Long subtitles (MULTI)", container: "mkv", fixture: "title-long-subs.mkv" },
  {
    name: "TEST | Index with a gap (MULTI)",
    container: "mkv",
    fixture: "title-long-subs-uncued.mkv",
  },
  {
    name: "TEST | Index doubled (MULTI)",
    container: "mkv",
    fixture: "title-long-subs-doubled.mkv",
  },
  {
    name: "TEST | Long recording (NL)",
    container: "ts",
    fixture: "recording-long-subtitles.mpegts",
  },
  { name: "TEST | Caption track (EN)", container: "mov", fixture: "title-caption-track.mov" },
];

/**
 * The moment, in epoch seconds, the test movies and series were added and the others before:
 * fixed, so "recently added" orders are the same in every run.
 */
export const TITLES_ADDED = 1_790_000_000;

/** Builds roughly `size` movies and series. The same size always gives the same titles. */
function buildTitles(
  size: number,
  second: boolean,
  seriesCount = Math.max(2, Math.floor(size / 4)),
): FakeTitles {
  const random = mulberry32(size + 7);
  const base = TITLES_ADDED;
  const movieCategories = [
    { id: "501", name: "TEST | FORMATS" },
    { id: "502", name: "NL | FILMS" },
    { id: "503", name: "NL | KOMEDIE FILMS" },
    { id: "504", name: "MULTI | NETFLIX MOVIES" },
    { id: "505", name: "XXX | FOR ADULTS" },
  ];
  const movies: FakeTitle[] = TEST_MOVIES.map((test, index) => ({
    id: 90_000 + index,
    name: test.name,
    categoryId: "501",
    adult: false,
    rating: 7,
    added: base - index,
    container: test.container,
    fixture: test.fixture,
    ...(test.versionOf === undefined ? {} : { tmdb: String(90_000 + test.versionOf + 10_000) }),
  }));
  for (let index = 0; movies.length < size; index++) {
    const id = 91_000 + index;
    // The film a second provider lists under this id: the default's next one, or one of its own.
    const of = second ? index + 1 : index;
    const own = second && index % 2 === 1;
    const category = own
      ? movieCategories[1]!
      : (movieCategories[1 + (of % 4)] ?? movieCategories[1]!);
    const adult = category.id === "505";
    const word = WORDS[of % WORDS.length] ?? "Earth";
    const language = second ? "EN" : category.id === "504" ? "MULTI" : "NL";
    const name = own
      ? `Other Story ${index} (NL)`
      : adult
        ? `Adult Film ${of} (EN)`
        : `${word} Story ${of} (${language})`;
    movies.push({
      id,
      name: index % 9 === 0 ? name.toUpperCase() : name,
      categoryId: category.id,
      adult,
      rating: Math.round(random() * 90) / 10,
      added: base - 1000 - Math.floor(random() * 1_000_000),
      container: index % 3 === 0 ? "mkv" : "mp4",
      fixture: "title-h264-aac.mp4",
      ...(!second
        ? {}
        : own
          ? { tmdb: String(id + 20_000) }
          : // What the default sends for that film: its TMDB id, and "0" for a few.
            { tmdb: (91_000 + of) % 7 === 0 ? "0" : String(91_000 + of + 10_000) }),
    });
  }
  const seriesCategories = [
    { id: "601", name: "NL | SERIES" },
    { id: "602", name: "BE | KINDER SERIES" },
  ];
  const episode = (id: number, fixture: string, container: string): FakeTitle => ({
    id,
    name: "",
    categoryId: "601",
    adult: false,
    rating: 0,
    added: base,
    container,
    fixture,
  });
  if (second) {
    const series: FakeSeries[] = [
      {
        id: 80_000,
        name: "TEST | Formats (DE)",
        categoryId: "601",
        adult: false,
        added: base - 250,
        seasons: [
          [
            episode(81_000, "title-h264-aac.mp4", "mp4"),
            episode(81_001, "title-h264-aac.mp4", "mp4"),
          ],
        ],
        tmdb: "90000",
      },
    ];
    for (let index = 0; series.length < seriesCount; index++) {
      const id = 80_001 + index;
      series.push({
        id,
        name: `Other Files ${index} (NL)`,
        categoryId: "601",
        adult: false,
        added: base - 2000 - Math.floor(random() * 1_000_000),
        seasons: [[episode(id * 10, "title-h264-aac.mp4", "mp4")]],
        tmdb: String(id + 20_000),
      });
    }
    return { movieCategories, movies, seriesCategories, series };
  }
  const series: FakeSeries[] = [
    {
      id: 80_000,
      name: "TEST | Formats (NL)",
      categoryId: "601",
      adult: false,
      added: base,
      seasons: [
        [
          episode(81_000, "title-h264-eac3-subs.mkv", "mkv"),
          episode(81_001, "title-h264-aac.mp4", "mp4"),
          episode(81_002, "title-h264-aac.mp4", "mp4"),
          // An older file of episode 2, listed beside it as some panels do.
          { ...episode(81_003, "title-h264-aac.mp4", "mp4"), number: 2, added: base - 100 },
        ],
        [
          episode(81_010, "title-h264-aac.mp4", "mp4"),
          episode(81_011, "title-h264-aac.mp4", "mp4"),
        ],
      ],
    },
    {
      // Another version of the one above, with two of its episodes.
      id: 79_998,
      name: "TEST | Formats (EN)",
      categoryId: "601",
      adult: false,
      added: base - 500,
      seasons: [
        [
          episode(799_980, "title-h264-aac.mp4", "mp4"),
          episode(799_981, "title-h264-aac.mp4", "mp4"),
        ],
      ],
      tmdb: "90000",
    },
    {
      id: 79_999,
      name: "After Dark (EN)",
      categoryId: "601",
      adult: true,
      added: base - 1000,
      seasons: [[episode(799_990, "title-h264-aac.mp4", "mp4")]],
    },
  ];
  for (let index = 0; series.length < seriesCount; index++) {
    const word = WORDS[(index * 7) % WORDS.length] ?? "Earth";
    const id = 80_001 + index;
    series.push({
      id,
      name: `${word} Files ${index} (NL)`,
      categoryId: index % 2 === 0 ? "601" : "602",
      adult: false,
      added: base - 2000 - Math.floor(random() * 1_000_000),
      seasons: [
        [
          episode(id * 10, "title-h264-aac.mp4", "mp4"),
          episode(id * 10 + 1, "title-h264-aac.mp4", "mp4"),
        ],
      ],
    });
  }
  return { movieCategories, movies, seriesCategories, series };
}

/** A day, in seconds. */
const DAY_SECONDS = 24 * 60 * 60;

/** What `measurementTitles` made of one kind's titles: how many it put in 4K and among the new. */
interface MeasuredKind {
  /** Renamed 4K or UHD. */
  readonly fourK: number;
  /** Dated two days before the anchor. */
  readonly week: number;
  /** Dated fifteen days before the anchor. */
  readonly month: number;
}

/** The titles `measurementTitles` makes, and what it declares about them. */
export interface Measurement {
  readonly titles: FakeTitles;
  /** Epoch seconds the additions are dated from. */
  readonly anchor: number;
  /**
   * Epoch seconds between which a clock finds exactly the declared titles new this week and this
   * month: from the anchor to three days after it.
   */
  readonly now: { readonly from: number; readonly to: number };
  readonly movies: MeasuredKind;
  readonly series: MeasuredKind;
}

/**
 * Movies and series to measure the Movies and Series tabs with, made from `all` for `serveTitles`:
 * known titles in 4K and in New at `anchor`, epoch seconds, whatever the viewer's language. The
 * default lists have neither: no version is 4K, and every title was added in the days before
 * `TITLES_ADDED`, so New empties as time passes.
 *
 * Of each kind's titles besides the test ones and those for adults, in list order, every 20th from
 * the first is renamed 4K or UHD in turn, every 20th from the second is dated two days before the
 * anchor, every 20th from the third and the fourth fifteen days before, and the rest 45 days or
 * more before, with the test titles and those for adults. The renamed and the new are marked
 * (MULTI), which suits every viewer's language whatever TMDB says they were made in. Each group
 * keeps its list order, a second apart. Ids, categories, episodes and files stay as they were.
 */
export function measurementTitles(all: FakeTitles, anchor: number): Measurement {
  function measure<
    Row extends { readonly name: string; readonly adult: boolean; readonly added: number },
  >(rows: readonly Row[]) {
    const counts = { fourK: 0, week: 0, month: 0 };
    let place = 0;
    let older = 0;
    const measured = rows.map((row): Row => {
      const step = row.adult || row.name.startsWith("TEST") ? -1 : place++ % 20;
      const named = row.name.replace(/ \([^()]*\)$/, "");
      if (step === 0) {
        const tag = counts.fourK++ % 2 === 0 ? "4K" : "UHD";
        return {
          ...row,
          name: `${named} ${tag} (MULTI)`,
          added: anchor - 45 * DAY_SECONDS - older++,
        };
      }
      if (step === 1) {
        return {
          ...row,
          name: `${named} (MULTI)`,
          added: anchor - 2 * DAY_SECONDS - counts.week++,
        };
      }
      if (step === 2 || step === 3) {
        return {
          ...row,
          name: `${named} (MULTI)`,
          added: anchor - 15 * DAY_SECONDS - counts.month++,
        };
      }
      return { ...row, added: anchor - 45 * DAY_SECONDS - older++ };
    });
    return { rows: measured, counts };
  }
  const movies = measure(all.movies);
  const series = measure(all.series);
  return {
    titles: { ...all, movies: movies.rows, series: series.rows },
    anchor,
    now: { from: anchor, to: anchor + 3 * DAY_SECONDS },
    movies: movies.counts,
    series: series.counts,
  };
}

/** The natural widths and heights of `pngLogo`'s marks: tall, tiny, square, wide. */
const LOGO_SIZES = [
  [16, 240],
  [3, 2],
  [80, 80],
  [240, 24],
  [24, 120],
  [120, 60],
] as const;

/**
 * A channel's raster mark, for `logoPng`: a cross in a colour of its own on white, in one of six
 * natural sizes, as a PNG.
 */
export function pngLogo(channel: FakeChannel): Buffer {
  const [width, height] = LOGO_SIZES[channel.streamId % LOGO_SIZES.length] ?? [80, 80];
  const colour = [(channel.streamId * 53) % 256, (channel.streamId * 97) % 256, 189];
  const half = Math.max(0.5, Math.min(width, height) / 10);
  const diagonal = Math.hypot(width, height);
  const stride = width * 3 + 1;
  // Each row is led by its filter type, 0 for none.
  const rows = Buffer.alloc(stride * height, 255);
  for (let y = 0; y < height; y++) {
    rows[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const [cx, cy] = [x + 0.5, y + 0.5];
      const down = Math.abs(cx * height - cy * width) / diagonal;
      const up = Math.abs((width - cx) * height - cy * width) / diagonal;
      if (Math.min(down, up) <= half) rows.set(colour, y * stride + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const framed = Buffer.alloc(typed.length + 8);
    framed.writeUInt32BE(data.length, 0);
    typed.copy(framed, 4);
    framed.writeUInt32BE(zlibCrc32(typed), typed.length + 4);
    return framed;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  // 8 bits per channel, RGB, deflate, no interlacing.
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const REGIONS = ["UK", "NL", "BE", "DE", "FR", "US", "ES", "IT", "PL", "PT"];
const GENRES = ["Entertainment", "Sports", "News", "Kids", "Documentary", "Movies", "Music"];
/** The series `longSeries` adds: every episode plays the MP4 clip. */
function longSeries(): FakeSeries {
  const id = 70_000;
  const added = 1_790_000_001;
  return {
    id,
    name: "TEST | Long-running (EN)",
    categoryId: "601",
    adult: false,
    added,
    seasons: Array.from({ length: 20 }, (_season, season) =>
      Array.from({ length: 26 }, (_episode, place) => ({
        id: id * 100 + season * 26 + place,
        name: "",
        categoryId: "601",
        adult: false,
        rating: 0,
        added,
        container: "mkv",
        fixture: "title-h264-aac.mp4",
        info: {
          plot: `Season ${season + 1}, part ${place + 1}. ${LONG_STORY}`,
          air_date: `${2003 + season}-09-${String(1 + place).padStart(2, "0")}`,
          rating: 7.5,
          bitrate: 2400,
          video: PROBED_VIDEO,
          audio: PROBED_AUDIO,
        },
      })),
    ),
  };
}

const LONG_STORY =
  "An agent goes missing on the eve of a hearing, and the team follows bank records, an " +
  "abandoned car and a witness who won't talk across three states before the deadline. Back at " +
  "the office, an old case returns with a new suspect and an old grudge.";

/** The ffprobe facts panels send about an episode's picture and sound. */
const DISPOSITION = { default: 1, dub: 0, original: 0, comment: 0, lyrics: 0, forced: 0 };
const PROBED_VIDEO = {
  index: 0,
  codec_name: "h264",
  codec_long_name: "H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10",
  profile: "High",
  codec_type: "video",
  codec_tag_string: "[0][0][0][0]",
  codec_tag: "0x0000",
  width: 1280,
  height: 720,
  coded_width: 1280,
  coded_height: 720,
  has_b_frames: 2,
  sample_aspect_ratio: "1:1",
  display_aspect_ratio: "16:9",
  pix_fmt: "yuv420p",
  level: 31,
  color_range: "tv",
  color_space: "bt709",
  color_transfer: "bt709",
  color_primaries: "bt709",
  chroma_location: "left",
  field_order: "progressive",
  refs: 1,
  is_avc: "true",
  nal_length_size: "4",
  r_frame_rate: "24000/1001",
  avg_frame_rate: "24000/1001",
  time_base: "1/1000",
  start_pts: 0,
  start_time: "0.000000",
  bits_per_raw_sample: "8",
  disposition: DISPOSITION,
  tags: { language: "eng", BPS: "2263842", DURATION: "00:42:51.110000000" },
};
const PROBED_AUDIO = {
  index: 1,
  codec_name: "eac3",
  codec_long_name: "ATSC A/52B (AC-3, E-AC-3)",
  codec_type: "audio",
  codec_tag_string: "[0][0][0][0]",
  codec_tag: "0x0000",
  sample_fmt: "fltp",
  sample_rate: "48000",
  channels: 6,
  channel_layout: "5.1(side)",
  bits_per_sample: 0,
  r_frame_rate: "0/0",
  avg_frame_rate: "0/0",
  time_base: "1/1000",
  start_pts: 0,
  start_time: "0.000000",
  bit_rate: "640000",
  disposition: DISPOSITION,
  tags: { language: "eng", BPS: "640000", DURATION: "00:42:51.104000000" },
};

const WORDS = [
  "Earth",
  "Arena",
  "Culture",
  "North",
  "City",
  "Atlas",
  "Harbour",
  "Cinema",
  "Melody",
  "Summit",
  "River",
  "Coast",
  "Valley",
  "Metro",
  "Studio",
  "Planet",
  "Forum",
  "Local",
  "Open",
  "Prime",
  "Nova",
  "Delta",
  "Orbit",
  "Pulse",
  "Zenith",
  "Lumen",
  "Vista",
  "Echo",
  "Signal",
  "Horizon",
];
const SUFFIXES = ["", " 1", " 2", " 3", " Plus", " Max", " Xtra", " Live", " 24"];
const QUALITY = ["", " HD", " FHD", " HD", " 4K", " SD"];

/** Small seeded PRNG so catalogues are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

/** Seven MPEG-TS null packets, sent every 20 ms to keep an empty program flowing. */
const NULL_PACKETS = (() => {
  const packets = Buffer.alloc(188 * 7, 0xff);
  for (let offset = 0; offset < packets.length; offset += 188) {
    packets.set([0x47, 0x1f, 0xff, 0x10], offset);
  }
  return packets;
})();

/** A program table naming one program without tracks. */
const EMPTY_PROGRAM = Buffer.concat([
  psiPacket(0x0000, [0x00, ...u16(0xb00d), ...u16(1), 0xc1, 0x00, 0x00, ...u16(1), ...u16(0xe100)]),
  psiPacket(0x0100, [
    0x02,
    ...u16(0xb00d),
    ...u16(1),
    0xc1,
    0x00,
    0x00,
    ...u16(0xffff),
    ...u16(0xf000),
  ]),
]);

/** One transport packet carrying a PSI section, with its CRC. */
function psiPacket(pid: number, section: number[]): Buffer {
  const packet = Buffer.alloc(188, 0xff);
  packet.set([0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10, 0x00, ...section, ...u32(crc32(section))]);
  return packet;
}

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** CRC-32/MPEG-2, the checksum of every PSI section. */
function crc32(bytes: number[]): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
}
