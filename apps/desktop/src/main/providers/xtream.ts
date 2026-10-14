// Xtream Codes compatible providers (player_api.php). Most IPTV resellers run a panel that speaks this API.
import { connect, isIP, type Socket } from "node:net";
import { type } from "arktype";
import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import type { LoginInput } from "@mrstreamer/contracts/ipc";
import type { AccountState, AccountStatus } from "@mrstreamer/contracts/subscription";
import {
  providerFetch,
  withoutAddresses,
  type LiveCatalogue,
  type OnDemandCatalogue,
  type Provider,
  type ProviderCategory,
  type ProviderChannel,
  type ProviderDetails,
  type ProviderEpisode,
  type ProviderOptions,
  type ProviderTitle,
} from "@mrstreamer/core/provider";
import { wallClock } from "@mrstreamer/core/catchup";
import { t } from "@mrstreamer/core/i18n";

export interface XtreamAccount {
  /** Normalised origin plus an optional path prefix, without a trailing slash. */
  readonly server: string;
  readonly username: string;
  readonly password: string;
}

const AUTH_TIMEOUT_MS = 15_000;
const CATALOGUE_TIMEOUT_MS = 90_000;
/** One movie's or series' details. */
const DETAILS_TIMEOUT_MS = 20_000;
/** The whole guide download. Tens of megabytes on large panels. */
const GUIDE_TIMEOUT_MS = 5 * 60_000;

/** What the user typed, as an account. */
export interface ParsedLogin {
  /** An Xtream login, or the link of a playlist without one (see ./m3u.ts). */
  readonly account:
    ({ readonly kind: "xtream" } & XtreamAccount) | { readonly kind: "m3u"; readonly link: string };
  /**
   * The address came without http:// or https://, so the account's is https: plain http only
   * with the viewer's say-so (see `httpsUnavailable`).
   */
  readonly schemeless: boolean;
}

/**
 * Turns what the user typed into an account. The server field also accepts a pasted M3U link: an
 * Xtream panel's (`.../get.php?username=...&password=...`) carries the login itself, and any other
 * playlist's, without a login in the fields either, is a playlist. An address without a scheme
 * means https.
 */
export function parseLogin(input: LoginInput): ParsedLogin {
  const raw = input.server.trim();
  const schemeless = !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url: URL;
  try {
    url = new URL(schemeless ? `https://${raw}` : raw);
  } catch {
    throw new AppFailure({
      kind: "incomplete-login",
      detail: t("The server address is not a valid URL."),
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppFailure({
      kind: "incomplete-login",
      detail: t("The server address must start with http or https."),
    });
  }

  const username = input.username.trim() || url.searchParams.get("username")?.trim() || "";
  const password = input.password || url.searchParams.get("password") || "";
  // A server address alone, as the login form sends one without its login, is no playlist.
  const serverOnly = url.pathname === "/" && !url.search;
  if (!username && !password && !serverOnly) {
    return { account: { kind: "m3u", link: url.href }, schemeless };
  }
  if (!username || !password) {
    throw new AppFailure({
      kind: "incomplete-login",
      detail: t("Enter a username and password, or paste an M3U link."),
    });
  }

  const path = url.pathname
    .replace(/\/(player_api|get|xmltv|panel_api)\.php$/i, "")
    .replace(/\/+$/, "");
  return {
    account: { kind: "xtream", server: `${url.origin}${path}`, username, password },
    schemeless,
  };
}

/** What `describeNetworkError` says when the server's name doesn't resolve. */
const nameNotFound = () => t("The server name could not be found.");

/**
 * Whether a failed https login says only that the address has no Xtream API over https, so http
 * might work: no TLS there, no answer, a certificate that isn't valid, a redirect to http with
 * the login, or something other than the API. A refused login, an inactive account or a name that
 * doesn't resolve has nothing to do with https.
 */
export function httpsUnavailable(error: AppError): boolean {
  return (
    error.kind === "provider-error" ||
    (error.kind === "unreachable" && error.detail !== nameNotFound())
  );
}

/**
 * How long an https port gets to accept a connection once its name resolved. A lost first packet
 * is sent again after a second, so this allows for one. Chrome and Firefox wait as long before
 * they try http for an address typed without a scheme.
 */
const CONNECT_TIMEOUT_MS = 3_000;

/** Opens a TCP connection, as `net.connect` does. A test gives one that stays unanswered. */
export type TcpConnect = (options: { host: string; port: number }) => Socket;

/**
 * Whether the https address `server` leaves a connection unanswered. That is when its name
 * resolves and its port neither accepts nor refuses within `CONNECT_TIMEOUT_MS`, as when a
 * firewall drops the packets instead of refusing them. Fetch takes ten seconds or more to give up
 * there. The connection sends nothing and closes at once. A server that is slow to answer has
 * accepted it by then, and a name that doesn't resolve says nothing about https, so both get a
 * no. `signal` ends the attempt.
 */
export function connectionIgnored(
  server: string,
  signal: AbortSignal,
  open: TcpConnect = connect,
): Promise<boolean> {
  const url = new URL(server);
  // An IPv6 address comes in brackets.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve) => {
    const socket = open({ host, port: url.port === "" ? 443 : Number(url.port) });
    let deadline: NodeJS.Timeout | undefined;
    const finish = (ignored: boolean) => {
      clearTimeout(deadline);
      signal.removeEventListener("abort", answered);
      socket.destroy();
      resolve(ignored);
    };
    const answered = () => finish(false);
    // A name can still resolve after `signal` ended the attempt.
    const wait = () => {
      if (!socket.destroyed) deadline ??= setTimeout(finish, CONNECT_TIMEOUT_MS, true);
    };
    signal.addEventListener("abort", answered);
    // The time the name takes to resolve, or to fail to, doesn't count.
    if (isIP(host)) wait();
    else {
      socket.once("lookup", (error) => {
        if (!error) wait();
      });
    }
    socket.once("connect", answered);
    socket.on("error", answered);
  });
}

/**
 * Creates a provider for an Xtream account. Every address it requests or gives out carries the
 * login, so its requests go through `providerFetch` and its errors name the server only.
 */
export function xtreamProvider(account: XtreamAccount, options: ProviderOptions): Provider {
  const fetchImpl = providerFetch(options.fetch ?? fetch, [account.username, account.password]);
  const credentials = new URLSearchParams({
    username: account.username,
    password: account.password,
  });

  /** Reads an API answer with `read`, turning network and HTTP failures into typed errors. */
  async function request<A>(
    params: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    read: (response: Response) => Promise<A>,
  ): Promise<A> {
    const url = `${account.server}/player_api.php?${credentials}${params}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { "User-Agent": options.userAgent, Accept: "application/json" },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (response.status === 401 || response.status === 403) {
        throw new AppFailure({ kind: "invalid-login" });
      }
      if (!response.ok) throw new AppFailure({ kind: "provider-error", status: response.status });
      return await read(response);
    } catch (cause) {
      if (cause instanceof AppFailure || signal?.aborted) throw cause;
      if (cause instanceof SyntaxError) throw notAnApi(account.server);
      throw new AppFailure({
        kind: "unreachable",
        server: account.server,
        detail: describeNetworkError(cause),
      });
    }
  }

  const getJson = (params: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> =>
    request(params, timeoutMs, signal, async (response) => JSON.parse(await response.text()));

  /**
   * The panel's time zone, which its timeshift addresses tell the time in: what the login's answer
   * says, asked once, or null when it names none. A failed ask is asked again next time.
   */
  let timeZone: Promise<string | null> | null = null;
  const serverTimeZone = (signal?: AbortSignal): Promise<string | null> =>
    (timeZone ??= getJson("", AUTH_TIMEOUT_MS, signal).then(
      (body) => {
        const parsed = AuthResponse(body);
        return parsed instanceof type.errors ? null : parsed.timeZone;
      },
      (cause: unknown) => {
        timeZone = null;
        throw cause;
      },
    ));

  /**
   * A long list, parsed in one go: only the catalogue worker reads these, off the main thread,
   * where one parse is several times faster than reading row by row. A refused login is an
   * error, never an empty list that could replace the lists the app has.
   */
  const getRows = <A>(
    params: string,
    signal: AbortSignal | undefined,
    map: (raw: unknown) => A[],
  ) =>
    request(params, CATALOGUE_TIMEOUT_MS, signal, async (response) => {
      const body: unknown = JSON.parse(await response.text());
      if (isRejectedLogin(body)) throw new AppFailure({ kind: "invalid-login" });
      return rows(body).flatMap(map);
    });

  return {
    async authenticate(signal) {
      const body = AuthResponse(await getJson("", AUTH_TIMEOUT_MS, signal));
      if (body instanceof type.errors || !body.user_info || !isTruthy(body.user_info.auth)) {
        throw new AppFailure({ kind: "invalid-login" });
      }
      timeZone = Promise.resolve(body.timeZone);
      const account = accountStatus(body.user_info);
      if (
        account.state === "expired" ||
        account.state === "banned" ||
        account.state === "disabled"
      ) {
        throw new AppFailure({
          kind: "account-inactive",
          state: account.state,
          expiresAt: account.expiresAt,
        });
      }
      return account;
    },

    async liveCatalogue(signal): Promise<LiveCatalogue> {
      const [categories, streams] = await Promise.all([
        getJson("&action=get_live_categories", CATALOGUE_TIMEOUT_MS, signal),
        getJson("&action=get_live_streams", CATALOGUE_TIMEOUT_MS, signal),
      ]);
      if (isRejectedLogin(categories) || isRejectedLogin(streams)) {
        throw new AppFailure({ kind: "invalid-login" });
      }
      return {
        categories: rows(categories).flatMap(toCategory),
        channels: rows(streams).flatMap(toChannel),
      };
    },

    async liveGuide(signal) {
      const timeout = AbortSignal.timeout(GUIDE_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetchImpl(`${account.server}/xmltv.php?${credentials}`, {
          headers: { "User-Agent": options.userAgent, Accept: "application/xml" },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (cause) {
        if (signal?.aborted) throw cause;
        throw new AppFailure({
          kind: "unreachable",
          server: account.server,
          detail: describeNetworkError(cause),
        });
      }
      if (response.status === 401 || response.status === 403) {
        throw new AppFailure({ kind: "invalid-login" });
      }
      if (!response.ok || !response.body) {
        throw new AppFailure({ kind: "provider-error", status: response.status });
      }
      return { kind: "document", body: response.body };
    },

    async onDemandCatalogue(signal): Promise<OnDemandCatalogue> {
      const [movieCategories, seriesCategories, movies, series] = await Promise.all([
        getJson("&action=get_vod_categories", CATALOGUE_TIMEOUT_MS, signal),
        getJson("&action=get_series_categories", CATALOGUE_TIMEOUT_MS, signal),
        getRows("&action=get_vod_streams", signal, toMovie),
        getRows("&action=get_series", signal, toSeries),
      ]);
      if (isRejectedLogin(movieCategories) || isRejectedLogin(seriesCategories)) {
        throw new AppFailure({ kind: "invalid-login" });
      }
      return {
        movieCategories: rows(movieCategories).flatMap(toCategory),
        movies,
        seriesCategories: rows(seriesCategories).flatMap(toCategory),
        series,
      };
    },

    async movieDetails(id, signal) {
      const body = titleSchemas().MovieInfo(
        await getJson(
          `&action=get_vod_info&vod_id=${encodeURIComponent(id)}`,
          DETAILS_TIMEOUT_MS,
          signal,
        ),
      );
      if (body instanceof type.errors) throw notAnApi(account.server);
      const info = body.info;
      return {
        ...detailsOf(info),
        duration: seconds(info?.duration_secs) ?? clockSeconds(info?.duration),
        posterUrl: url(info?.cover_big) ?? url(info?.movie_image),
        seasons: [],
        episodes: [],
        container: body.movie_data?.container_extension?.trim() || null,
      };
    },

    async seriesDetails(id, signal) {
      const body = titleSchemas().SeriesInfo(
        await getJson(
          `&action=get_series_info&series_id=${encodeURIComponent(id)}`,
          DETAILS_TIMEOUT_MS,
          signal,
        ),
      );
      if (body instanceof type.errors) throw notAnApi(account.server);
      const info = body.info;
      const episodes = Array.isArray(body.episodes)
        ? body.episodes.flat()
        : Object.values(body.episodes ?? {}).flat();
      return {
        ...detailsOf(info),
        duration: minutes(info?.episode_run_time),
        posterUrl: url(info?.cover),
        seasons: (body.seasons ?? []).flatMap((season) => {
          const number = toInteger(season.season_number);
          if (number === null) return [];
          return [
            {
              number,
              name: season.name?.trim() || null,
              posterUrl: url(season.cover_big) ?? url(season.cover),
            },
          ];
        }),
        episodes: episodes.flatMap(toEpisode),
        container: null,
      };
    },

    request: fetchImpl,

    async titleFile(kind, id, container) {
      const user = encodeURIComponent(account.username);
      const pass = encodeURIComponent(account.password);
      const folder = kind === "movie" ? "movie" : "series";
      return {
        url: `${account.server}/${folder}/${user}/${pass}/${encodeURIComponent(id)}.${encodeURIComponent(container)}`,
        container,
      };
    },

    async liveStream(channelId) {
      const user = encodeURIComponent(account.username);
      const pass = encodeURIComponent(account.password);
      return {
        url: `${account.server}/live/${user}/${pass}/${encodeURIComponent(channelId)}.ts`,
        format: "mpegts",
      };
    },

    /**
     * The panel's timeshift address: `/timeshift/user/pass/<minutes>/<YYYY-MM-DD:HH-MM>/<id>.ts`,
     * the start on the panel's own clock (`server_info.timezone`), else in UTC. Panels start on a
     * whole minute, so the recording starts on the minute before the window's start, which it
     * says, and runs on to the window's end.
     */
    async archiveStream(channelId, window, signal) {
      const user = encodeURIComponent(account.username);
      const pass = encodeURIComponent(account.password);
      const start = window.start - (window.start % 60_000);
      const minutes = Math.ceil((window.end - start) / 60_000);
      const at = wallClock(start, await serverTimeZone(signal));
      const time = `${at.year}-${at.month}-${at.day}:${at.hour}-${at.minute}`;
      return {
        url: `${account.server}/timeshift/${user}/${pass}/${minutes}/${time}/${encodeURIComponent(channelId)}.ts`,
        format: "mpegts",
        start,
      };
    },
  };
}

// Panels disagree on types: numbers arrive as strings, empty strings stand in for null, and
// fields go missing. The schemas accept all of that and the mappers below normalise it.
const idLike = type("string | number");
const loose = type("string | number | null");

const UserInfo = type({
  "auth?": "number | string | boolean | null",
  "status?": "string | null",
  "exp_date?": loose,
  "max_connections?": loose,
  "active_cons?": loose,
});

const AuthResponse = type({
  "user_info?": UserInfo.or("unknown[]"),
  "server_info?": type({ "timezone?": "string | null" }).or("unknown[] | null"),
}).pipe((body) => ({
  user_info: Array.isArray(body.user_info) ? undefined : body.user_info,
  /** The panel's IANA time zone, "Europe/Amsterdam", or null when it names none. */
  timeZone:
    (body.server_info && !Array.isArray(body.server_info) && body.server_info.timezone?.trim()) ||
    null,
}));

const CategoryRow = type({ category_id: idLike, "category_name?": "string | null" });

const StreamRow = type({
  stream_id: idLike,
  "name?": "string | null",
  "num?": loose,
  "stream_icon?": "string | null",
  "category_id?": loose,
  "category_ids?": "(string | number)[] | null",
  "epg_channel_id?": "string | null",
  "is_adult?": "number | string | boolean | null",
  "tv_archive?": "number | string | boolean | null",
  "tv_archive_duration?": loose,
});

/**
 * The movie and series schemas, built on first use: the catalogue worker needs them for the lists,
 * the main process only once a title's details open, never while it starts.
 */
function defineTitleSchemas() {
  const MovieRow = type({
    stream_id: idLike,
    "name?": "string | null",
    "stream_icon?": "string | null",
    "rating?": loose,
    "added?": loose,
    "category_id?": loose,
    "category_ids?": "(string | number)[] | null",
    "container_extension?": "string | null",
    "is_adult?": "number | string | boolean | null",
    "tmdb?": loose,
  });

  const SeriesRow = type({
    series_id: idLike,
    "name?": "string | null",
    "cover?": "string | null",
    "backdrop_path?": "string[] | string | null",
    "rating?": loose,
    "last_modified?": loose,
    "releaseDate?": "string | null",
    "release_date?": "string | null",
    "category_id?": loose,
    "category_ids?": "(string | number)[] | null",
    "is_adult?": "number | string | boolean | null",
    "tmdb?": loose,
  });

  const Info = type({
    "name?": "string | null",
    "o_name?": "string | null",
    "cover?": "string | null",
    "cover_big?": "string | null",
    "movie_image?": "string | null",
    "plot?": "string | null",
    "description?": "string | null",
    "genre?": "string | null",
    "cast?": "string | null",
    "actors?": "string | null",
    "director?": "string | null",
    "releasedate?": "string | null",
    "releaseDate?": "string | null",
    "release_date?": "string | null",
    "backdrop_path?": "(string | null)[] | string | null",
    "duration_secs?": loose,
    "duration?": loose,
    "episode_run_time?": loose,
  });
  // Panels send `info: []` or `null` for a title they know nothing more about.
  const InfoOrNothing = Info.or("unknown[] | null").pipe((info) =>
    Array.isArray(info) || info === null ? undefined : info,
  );

  const MovieInfo = type({
    "info?": InfoOrNothing,
    "movie_data?": type({ "container_extension?": "string | null" })
      .or("unknown[] | null")
      .pipe((data) => (Array.isArray(data) || data === null ? undefined : data)),
  });

  const EpisodeRow = type({
    id: idLike,
    "episode_num?": loose,
    "season?": loose,
    "title?": "string | null",
    "container_extension?": "string | null",
    "added?": loose,
    "info?": type({
      "movie_image?": "string | null",
      "plot?": "string | null",
      "duration_secs?": loose,
      "duration?": loose,
      "air_date?": "string | null",
      "releasedate?": "string | null",
    })
      .or("unknown[] | null")
      .pipe((info) => (Array.isArray(info) || info === null ? undefined : info)),
  });

  const SeriesInfo = type({
    "info?": InfoOrNothing,
    "seasons?": type({
      "season_number?": loose,
      "name?": "string | null",
      "cover?": "string | null",
      "cover_big?": "string | null",
    })
      .array()
      .or("null"),
    // An object keyed by season number, or on some panels an array of seasons.
    "episodes?": type({ "[string]": "unknown[]" }).or("unknown[][]").or("null"),
  });

  return { MovieRow, SeriesRow, Info, MovieInfo, EpisodeRow, SeriesInfo };
}
let definedTitleSchemas: ReturnType<typeof defineTitleSchemas> | null = null;
const titleSchemas = () => (definedTitleSchemas ??= defineTitleSchemas());
type Info = ReturnType<typeof titleSchemas>["Info"]["infer"];

function toMovie(raw: unknown): ProviderTitle[] {
  const row = titleSchemas().MovieRow(raw);
  if (row instanceof type.errors) return [];
  const id = String(row.stream_id);
  return [
    {
      id,
      name: row.name?.trim() || `Movie ${id}`,
      posterUrl: url(row.stream_icon),
      backdropUrl: null,
      rating: rating(row.rating),
      addedAt: epochSeconds(row.added),
      releaseDate: null,
      categoryIds: categoryIdsOf(row),
      adult: isTruthy(row.is_adult),
      container: row.container_extension?.trim() || "mp4",
      tmdbId: tmdbIdOf(row.tmdb),
    },
  ];
}

/** A TMDB id: digits, and not the 0 some panels write for none. */
function tmdbIdOf(value: string | number | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) && Number(text) > 0 ? text : null;
}

function toSeries(raw: unknown): ProviderTitle[] {
  const row = titleSchemas().SeriesRow(raw);
  if (row instanceof type.errors) return [];
  const id = String(row.series_id);
  return [
    {
      id,
      name: row.name?.trim() || `Series ${id}`,
      posterUrl: url(row.cover),
      backdropUrl: url(firstOf(row.backdrop_path)),
      rating: rating(row.rating),
      addedAt: epochSeconds(row.last_modified),
      releaseDate: row.releaseDate?.trim() || row.release_date?.trim() || null,
      categoryIds: categoryIdsOf(row),
      adult: isTruthy(row.is_adult),
      container: null,
      tmdbId: tmdbIdOf(row.tmdb),
    },
  ];
}

function toEpisode(raw: unknown): ProviderEpisode[] {
  const row = titleSchemas().EpisodeRow(raw);
  if (row instanceof type.errors) return [];
  const season = toInteger(row.season);
  const number = toInteger(row.episode_num);
  if (season === null || number === null) return [];
  const id = String(row.id);
  return [
    {
      id,
      season,
      number,
      name: row.title?.trim() || `Episode ${number}`,
      plot: row.info?.plot?.trim() || null,
      duration: seconds(row.info?.duration_secs) ?? clockSeconds(row.info?.duration),
      stillUrl: url(row.info?.movie_image),
      airDate: row.info?.air_date?.trim() || row.info?.releasedate?.trim() || null,
      addedAt: epochSeconds(row.added),
      container: row.container_extension?.trim() || "mp4",
    },
  ];
}

/** The fields movies and series share in their details. */
function detailsOf(
  info: Info | undefined,
): Omit<ProviderDetails, "duration" | "posterUrl" | "seasons" | "episodes" | "container"> {
  return {
    originalName: info?.o_name?.trim() || null,
    plot: info?.plot?.trim() || info?.description?.trim() || null,
    genres: list(info?.genre, /\s*[,/|]\s*/),
    cast: list(info?.cast || info?.actors, /\s*,\s*/),
    directors: list(info?.director, /\s*,\s*/),
    releaseDate:
      info?.releasedate?.trim() || info?.releaseDate?.trim() || info?.release_date?.trim() || null,
    backdropUrl: url(firstOf(info?.backdrop_path)),
  };
}

function categoryIdsOf(row: {
  readonly category_id?: string | number | null | undefined;
  readonly category_ids?: readonly (string | number)[] | null | undefined;
}): string[] {
  const ids = row.category_ids?.length ? row.category_ids : [row.category_id];
  // Array membership is authoritative. Keep raw IDs, including leading zeros, for saved picks.
  return [...new Set(ids.flatMap((id) => (id != null && id !== "" ? [String(id)] : [])))];
}

/** An http(s) address, or null for empty strings and anything else panels send. */
function url(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function firstOf(value: readonly (string | null)[] | string | null | undefined): string | null {
  return (typeof value === "string" ? value : value?.find((each) => each !== null)) ?? null;
}

function list(value: string | null | undefined, separator: RegExp): string[] {
  return (value ?? "")
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** A rating out of 10; panels send "0" or "" when they have none. */
function rating(value: string | number | null | undefined): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 && number <= 10 ? number : null;
}

function epochSeconds(value: string | number | null | undefined): number | null {
  const number = toInteger(value);
  return number && number > 0 ? number * 1000 : null;
}

function seconds(value: string | number | null | undefined): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function minutes(value: string | number | null | undefined): number | null {
  const number = seconds(value);
  return number === null ? null : number * 60;
}

/** "01:39:11" or "39:11" in seconds. A bare number says nothing of its unit, so it counts as none. */
function clockSeconds(value: string | number | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(":").map(Number);
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return null;
  const total = parts.reduce((sum, part) => sum * 60 + part, 0);
  return total > 0 ? total : null;
}

function notAnApi(server: string): AppFailure {
  return new AppFailure({
    kind: "unreachable",
    server,
    detail: t("The server answered, but not like an Xtream API."),
  });
}

function toCategory(raw: unknown): ProviderCategory[] {
  const row = CategoryRow(raw);
  if (row instanceof type.errors) return [];
  const id = String(row.category_id);
  return [{ id, name: row.category_name?.trim() || `Category ${id}` }];
}

function toChannel(raw: unknown): ProviderChannel[] {
  const row = StreamRow(raw);
  if (row instanceof type.errors) return [];
  const id = String(row.stream_id);
  const archiveDays = toInteger(row.tv_archive_duration);
  return [
    {
      id,
      name: row.name?.trim() || `Channel ${id}`,
      number: toInteger(row.num),
      logoUrl: row.stream_icon && /^https?:\/\//i.test(row.stream_icon) ? row.stream_icon : null,
      categoryIds: categoryIdsOf(row),
      guideId: row.epg_channel_id?.trim() || null,
      adult: isTruthy(row.is_adult),
      // Catch-up where the panel keeps an archive of it, for as many days as it says.
      catchupDays: isTruthy(row.tv_archive) ? Math.max(0, archiveDays ?? 0) || null : null,
    },
  ];
}

function accountStatus(info: typeof UserInfo.infer): AccountStatus {
  const expiry = toInteger(info.exp_date);
  return {
    state: accountState(info.status),
    expiresAt: expiry ? new Date(expiry * 1000).toISOString() : null,
    maxConnections: toInteger(info.max_connections),
    activeConnections: toInteger(info.active_cons),
  };
}

function accountState(status: string | null | undefined): AccountState {
  switch (status?.trim().toLowerCase()) {
    case "active":
      return "active";
    case "expired":
      return "expired";
    case "banned":
      return "banned";
    case "disabled":
      return "disabled";
    default:
      return "unknown";
  }
}

/** Some panels answer catalogue actions with a login failure instead of an HTTP error. */
function isRejectedLogin(body: unknown): boolean {
  const parsed = AuthResponse(body);
  return (
    !(parsed instanceof type.errors) &&
    parsed.user_info !== undefined &&
    !isTruthy(parsed.user_info.auth)
  );
}

function rows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  // A few panels return an object keyed by index instead of an array.
  if (body && typeof body === "object" && !("user_info" in body)) return Object.values(body);
  return [];
}

function isTruthy(value: string | number | boolean | null | undefined): boolean {
  return value === true || value === 1 || value === "1";
}

function toInteger(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) ? number : null;
}

/** Why a request to a provider failed, in a sentence that names no address beyond its origin. */
export function describeNetworkError(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === "TimeoutError")
    return t("The server did not answer in time.");
  // fetch wraps the socket error: TypeError("fetch failed", { cause: Error { code } }).
  const inner = cause instanceof Error && cause.cause instanceof Error ? cause.cause : null;
  const code = inner && "code" in inner ? inner.code : null;
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return nameNotFound();
    case "ECONNREFUSED":
      return t("The server refused the connection.");
    case "ECONNRESET":
      return t("The connection was reset.");
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return t("The server did not answer in time.");
    // An https address on a server that speaks only http.
    case "ERR_SSL_WRONG_VERSION_NUMBER":
    case "ERR_SSL_PACKET_LENGTH_TOO_LONG":
      return t("The server doesn't offer an encrypted connection at this address.");
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
    case "CERT_HAS_EXPIRED":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return t("The server's certificate isn't valid for this address.");
    default:
      return withoutAddresses(
        inner?.message ?? (cause instanceof Error ? cause.message : String(cause)),
      );
  }
}
