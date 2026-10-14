// Official API contracts: subdl.com/api-doc and opensubtitles.stoplight.io/docs/opensubtitles-api.
// Search sends TMDB identity or title/year and requested languages. Keys, tokens and download addresses
// stay here. Searching never asks for a download, and failed credentials are never retried.
import { createInflateRaw } from "node:zlib";
import type {
  DownloadedSubtitle,
  SubtitleCredentials,
  SubtitleService,
  SubtitleServiceFailure,
} from "@mrstreamer/contracts/online-subtitles";
import { subtitleTextFile, SUBTITLE_TEXT_LIMIT } from "@mrstreamer/core/subtitles/text-file";
import { type } from "arktype";
import { Unzip, type UnzipDecoder, type UnzipFile } from "fflate";
import { lazy } from "@mrstreamer/contracts/lazy";

export type SubtitleQuery = {
  readonly tmdbId?: number;
  readonly title?: string;
  readonly year?: number;
  readonly languages: readonly string[];
} & (
  | { readonly kind: "movie" }
  | {
      readonly kind: "episode";
      readonly season: number;
      readonly episode: number;
    }
);

/** This server reference is main-only. The session owner replaces it with an opaque result id. */
export type SubtitleCandidate = {
  readonly language: string;
  readonly release: string;
  readonly hearingImpaired: boolean;
  readonly downloads: number | null;
} & (
  | { readonly service: "subdl"; readonly url: string }
  | {
      readonly service: "opensubtitles";
      readonly fileId: number;
    }
);

export class SubtitleRequestFailure extends Error {
  readonly reason: SubtitleServiceFailure;
  constructor(reason: SubtitleServiceFailure) {
    super(`Subtitle service: ${reason}.`);
    this.reason = reason;
  }
}

const SubDLReply = lazy(() =>
  type({
    status: "boolean",
    "results?": type({ "tmdb_id?": "number | null", type: "'movie' | 'tv'" })
      .array()
      .atMostLength(100),
    "subtitles?": type({
      "language?": "string <= 64",
      "lang?": "string <= 64",
      "release_name?": "string <= 1024",
      "name?": "string <= 1024",
      url: "string <= 8192",
      "hi?": "boolean",
      "full_season?": "boolean",
      "season?": "number | null",
      "episode?": "number | null",
      "unpack_files?": type({
        language: "string <= 64",
        name: "string <= 1024",
        "release_name?": "string <= 1024",
        season: "number",
        episode: "number",
        format: "string <= 16",
        url: "string <= 8192",
        "hi?": "boolean",
      })
        .array()
        .atMostLength(1000),
    })
      .array()
      .atMostLength(100),
  }),
);
const OpenReply = lazy(() =>
  type({
    data: type({
      attributes: {
        language: "string <= 64",
        release: "string <= 1024",
        "hearing_impaired?": "boolean",
        "download_count?": "number >= 0",
        feature_details: {
          "tmdb_id?": "number | null",
          "parent_tmdb_id?": "number | null",
          "season_number?": "number | null",
          "episode_number?": "number | null",
        },
        files: type({ file_id: "number.integer > 0", file_name: "string <= 1024" })
          .array()
          .atMostLength(32),
      },
    })
      .array()
      .atMostLength(1000),
  }),
);
const OpenLogin = lazy(() =>
  type({
    token: "0 < string <= 16384",
    base_url: "'api.opensubtitles.com' | 'vip-api.opensubtitles.com'",
  }),
);
const OpenDownload = lazy(() =>
  type({
    link: "0 < string <= 8192",
    remaining: "number >= 0",
    reset_time_utc: "string <= 128",
  }),
);
const Query = lazy(() =>
  type({
    "tmdbId?": "number.integer > 0",
    "title?": "0 < string <= 512",
    "year?": "1800 <= number.integer <= 3000",
    languages: "string[] <= 10",
    kind: "'movie'",
  }).or({
    "tmdbId?": "number.integer > 0",
    "title?": "0 < string <= 512",
    "year?": "1800 <= number.integer <= 3000",
    languages: "string[] <= 10",
    kind: "'episode'",
    season: "number.integer >= 0",
    episode: "number.integer > 0",
  }),
);
const JSON_LIMIT = 2 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Stateless service ports. Call only after the session owner checks opt-in and file ownership. */
export function subtitleServiceClient(options: { userAgent: string; fetch?: typeof fetch }) {
  const request = options.fetch ?? fetch;
  const userAgent = options.userAgent;
  const api = async (
    url: string | URL,
    init: RequestInit,
    signal: AbortSignal,
    searchRedirects = false,
  ) => {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    let target = new URL(url);
    for (let redirects = 0; ; redirects++) {
      timeout.throwIfAborted();
      const response = await request(target, {
        ...init,
        signal: timeout,
        redirect: "manual",
        headers: { Accept: "application/json", "User-Agent": userAgent, ...init.headers },
      });
      const location =
        searchRedirects && REDIRECTS.has(response.status) ? response.headers.get("location") : null;
      if (location !== null) {
        await response.body?.cancel();
        const next = new URL(location, target);
        // Only the search GET can redirect. The API key stays on the original HTTPS origin.
        if (
          redirects >= 2 ||
          next.origin !== "https://api.opensubtitles.com" ||
          next.username ||
          next.password ||
          next.port
        )
          throw new SubtitleRequestFailure("unavailable");
        target = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new SubtitleRequestFailure(
          response.status === 401 || response.status === 403
            ? "credentials"
            : response.status === 402 || response.status === 406 || response.status === 429
              ? "quota"
              : "unavailable",
        );
      }
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readBody(response, JSON_LIMIT, timeout),
        ),
      ) as unknown;
    }
  };
  const subdlSearch = async (
    credentials: NonNullable<SubtitleCredentials["subdl"]>,
    input: SubtitleQuery,
    signal: AbortSignal,
  ): Promise<readonly SubtitleCandidate[]> => {
    const query = checkedQuery(input);
    const url = new URL("https://api.subdl.com/api/v1/subtitles");
    url.search = new URLSearchParams({
      api_key: credentials.apiKey,
      ...(query.tmdbId !== undefined
        ? { tmdb_id: String(query.tmdbId) }
        : { film_name: query.title! }),
      ...(query.year !== undefined ? { year: String(query.year) } : {}),
      type: query.kind === "movie" ? "movie" : "tv",
      languages: query.languages.join(",").toUpperCase(),
      subs_per_page: "30",
      hi: "1",
      unpack: "1",
      client: "custom_integration",
      ...(query.kind === "episode"
        ? {
            season_number: String(query.season),
            episode_number: String(query.episode),
          }
        : {}),
    }).toString();
    const reply = SubDLReply().assert(await api(url, {}, signal));
    if (!reply.status) throw new SubtitleRequestFailure("unavailable");
    // SubDL may broaden an unsuccessful match. Do not import another title's results.
    if (
      (query.tmdbId !== undefined && reply.results?.[0]?.tmdb_id !== query.tmdbId) ||
      reply.results?.[0]?.type !== (query.kind === "movie" ? "movie" : "tv")
    )
      return [];
    const results: SubtitleCandidate[] = [];
    for (const sub of reply.subtitles ?? []) {
      const files = sub.unpack_files?.filter(
        (file) =>
          query.kind === "episode" &&
          file.season === query.season &&
          file.episode === query.episode &&
          /^(srt|vtt)$/i.test(file.format),
      );
      if (files?.length) {
        for (const file of files)
          results.push({
            service: "subdl",
            url: downloadURL("subdl", file.url).href,
            language: requestedLanguage(file.language, query.languages),
            release: file.release_name ?? file.name,
            hearingImpaired: file.hi ?? false,
            downloads: null,
          });
      } else if (
        !sub.full_season &&
        (sub.language || sub.lang) &&
        (query.kind === "movie" || (sub.season === query.season && sub.episode === query.episode))
      ) {
        results.push({
          service: "subdl",
          url: downloadURL("subdl", sub.url).href,
          language: requestedLanguage(sub.language ?? sub.lang ?? "", query.languages),
          release: sub.release_name ?? sub.name ?? "",
          hearingImpaired: sub.hi ?? false,
          downloads: null,
        });
      }
    }
    return results.filter((sub) => query.languages.includes(sub.language)).slice(0, 100);
  };
  const openSearch = async (
    credentials: NonNullable<SubtitleCredentials["opensubtitles"]>,
    input: SubtitleQuery,
    signal: AbortSignal,
  ): Promise<readonly SubtitleCandidate[]> => {
    const query = checkedQuery(input);
    const url = new URL("https://api.opensubtitles.com/api/v1/subtitles");
    const languages = [
      ...new Set(
        query.languages.flatMap((language) =>
          language === "pt" ? ["pt-br", "pt-pt"] : [language],
        ),
      ),
    ].sort();
    url.search = new URLSearchParams({
      type: query.kind,
      languages: languages.join(","),
      ...(query.tmdbId !== undefined
        ? query.kind === "movie"
          ? { tmdb_id: String(query.tmdbId) }
          : { parent_tmdb_id: String(query.tmdbId) }
        : { query: query.title!.trim().toLowerCase() }),
      ...(query.kind === "movie"
        ? query.year !== undefined
          ? { year: String(query.year) }
          : {}
        : { season_number: String(query.season), episode_number: String(query.episode) }),
    }).toString();
    url.searchParams.sort();
    const reply = OpenReply().assert(
      await api(
        url,
        {
          headers: { "Api-Key": credentials.apiKey },
        },
        signal,
        true,
      ),
    );
    return reply.data
      .flatMap(({ attributes: sub }): SubtitleCandidate[] => {
        const title = sub.feature_details;
        if (
          !languages.includes(sub.language.toLowerCase()) ||
          (query.kind === "movie"
            ? query.tmdbId !== undefined && title.tmdb_id !== query.tmdbId
            : (query.tmdbId !== undefined && title.parent_tmdb_id !== query.tmdbId) ||
              title.season_number !== query.season ||
              title.episode_number !== query.episode)
        )
          return [];
        return sub.files.map((file) => ({
          service: "opensubtitles",
          fileId: file.file_id,
          language: sub.language,
          release:
            sub.files.length > 1
              ? `${sub.release} · ${file.file_name}`.slice(0, 1024)
              : sub.release,
          hearingImpaired: sub.hearing_impaired ?? false,
          downloads: sub.download_count ?? null,
        }));
      })
      .slice(0, 100);
  };
  const download = async (
    candidate: SubtitleCandidate,
    credentials: SubtitleCredentials,
    signal: AbortSignal,
  ): Promise<{
    subtitle: DownloadedSubtitle;
    quota: { remaining: number; resetAt: string } | null;
  }> => {
    let url: URL;
    let quota: { remaining: number; resetAt: string } | null = null;
    if (candidate.service === "subdl") {
      url = downloadURL("subdl", candidate.url);
    } else {
      const keys = credentials.opensubtitles;
      if (!keys) throw new SubtitleRequestFailure("not-configured");
      // Login and quota-consuming download are separate from search. No token on disk.
      const login = OpenLogin().assert(
        await api(
          "https://api.opensubtitles.com/api/v1/login",
          {
            method: "POST",
            headers: { "Api-Key": keys.apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({ username: keys.username, password: keys.password }),
          },
          signal,
        ),
      );
      const reply = OpenDownload().assert(
        await api(
          `https://${login.base_url}/api/v1/download`,
          {
            method: "POST",
            headers: {
              "Api-Key": keys.apiKey,
              Authorization: `Bearer ${login.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ file_id: candidate.fileId, sub_format: "srt" }),
          },
          signal,
        ),
      );
      url = downloadURL("opensubtitles", reply.link);
      quota = { remaining: reply.remaining, resetAt: reply.reset_time_utc };
    }
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    for (let redirects = 0; ; redirects++) {
      timeout.throwIfAborted();
      const response = await request(url, {
        signal: timeout,
        redirect: "manual",
        headers: { "User-Agent": userAgent },
      });
      const location = REDIRECTS.has(response.status) ? response.headers.get("location") : null;
      if (location !== null) {
        await response.body?.cancel();
        if (redirects >= 3) throw new SubtitleRequestFailure("unavailable");
        url = downloadURL(candidate.service, new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new SubtitleRequestFailure(response.status === 429 ? "quota" : "unavailable");
      }
      const data = await readBody(response, SUBTITLE_TEXT_LIMIT, timeout);
      const bytes =
        data[0] === 0x50 && data[1] === 0x4b ? await subtitleArchive(data, timeout) : data;
      let cues: ReturnType<typeof subtitleTextFile>;
      try {
        cues = subtitleTextFile(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new SubtitleRequestFailure("unsupported");
      }
      return {
        subtitle: {
          service: candidate.service,
          language: candidate.language,
          release: candidate.release,
          cues: [...cues],
        },
        quota,
      };
    }
  };
  // Fetch/schema errors can contain API keys and passwords. Never expose their messages.
  const safe = async <A>(signal: AbortSignal, run: () => Promise<A>): Promise<A> => {
    try {
      return await run();
    } catch (error) {
      signal.throwIfAborted();
      throw error instanceof SubtitleRequestFailure
        ? error
        : new SubtitleRequestFailure("unavailable");
    }
  };
  return {
    subdlSearch: (...args: Parameters<typeof subdlSearch>) =>
      safe(args[2], () => subdlSearch(...args)),
    openSearch: (...args: Parameters<typeof openSearch>) =>
      safe(args[2], () => openSearch(...args)),
    download: (...args: Parameters<typeof download>) => safe(args[2], () => download(...args)),
  };
}

function checkedQuery(input: SubtitleQuery): SubtitleQuery {
  const query = Query().assert(input);
  if (query.tmdbId === undefined && !query.title?.trim())
    throw new SubtitleRequestFailure("unsupported");
  const languages = [...new Set(query.languages.map((value) => value.trim().toLowerCase()))].sort();
  if (!languages.length || languages.some((value) => !/^[a-z]{2,3}(?:-[a-z]{2,3})?$/.test(value)))
    throw new SubtitleRequestFailure("unsupported");
  return { ...query, languages };
}

function downloadURL(service: SubtitleService, value: string): URL {
  const url = new URL(value, service === "subdl" ? "https://dl.subdl.com" : undefined);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    (service === "subdl"
      ? url.hostname !== "dl.subdl.com"
      : url.hostname !== "opensubtitles.com" && !url.hostname.endsWith(".opensubtitles.com"))
  )
    throw new SubtitleRequestFailure("unsupported");
  return url;
}

/** SubDL returns both ISO codes and English language names, depending on the file record. */
function requestedLanguage(value: string, requested: readonly string[]): string {
  const name = value.trim().toLowerCase();
  const names = new Intl.DisplayNames(["en"], { type: "language" });
  return requested.find((code) => code === name || names.of(code)?.toLowerCase() === name) ?? "";
}

async function readBody(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new SubtitleRequestFailure("unsupported");
  }
  if (!response.body) throw new SubtitleRequestFailure("unsupported");
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > limit) throw new SubtitleRequestFailure("unsupported");
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

/** ZIP stays in memory, never writes a path. Refuse ambiguous packs and stop inflated data at 10MiB. */
async function subtitleArchive(data: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const files: UnzipFile[] = [];
    const chunks: Uint8Array[] = [];
    let finished = false;
    let size = 0;
    let selected = 0;
    let complete = false;
    const end = (error?: unknown) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      for (const file of files) file.terminate();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, size));
    };
    const abort = () => end(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const unzip = new Unzip((file) => {
      files.push(file);
      if (files.length > 64) return end(new SubtitleRequestFailure("unsupported"));
      if (
        file.name.startsWith("__MACOSX/") ||
        file.name.split("/").at(-1)?.startsWith("._") ||
        !/\.(srt|vtt)$/i.test(file.name)
      )
        return;
      if (++selected > 1 || (file.originalSize ?? 0) > SUBTITLE_TEXT_LIMIT)
        return end(new SubtitleRequestFailure("unsupported"));
      file.ondata = (error, chunk, final) => {
        if (finished) return;
        if (error) return end(new SubtitleRequestFailure("unsupported"));
        size += chunk.length;
        if (size > SUBTITLE_TEXT_LIMIT) return end(new SubtitleRequestFailure("unsupported"));
        chunks.push(chunk);
        complete = final;
        if (final && parsed) end();
      };
      file.start();
    });
    unzip.register(SubtitleInflate);
    let parsed = false;
    try {
      signal.throwIfAborted();
      for (let start = 0; start < data.length && !finished; start += 65536)
        unzip.push(data.subarray(start, start + 65536), start + 65536 >= data.length);
      parsed = true;
      if (!selected) end(new SubtitleRequestFailure("unsupported"));
      else if (complete) end();
    } catch {
      end(new SubtitleRequestFailure("unsupported"));
    }
  });
}

/** Native inflation emits small chunks. The archive reader can stop a dishonest size header
 * at the actual text limit without first allocating the whole expanded file in a worker. */
class SubtitleInflate implements UnzipDecoder {
  static compression = 8;
  ondata!: UnzipDecoder["ondata"];
  private readonly stream = createInflateRaw({ chunkSize: 16384 });
  constructor() {
    this.stream.on("data", (chunk: Buffer) => this.ondata(null, Uint8Array.from(chunk), false));
    this.stream.on("end", () => this.ondata(null, new Uint8Array(), true));
    this.stream.on("error", (error: Error) =>
      this.ondata(Object.assign(error, { code: 13 as const }), new Uint8Array(), false),
    );
  }
  push(chunk: Uint8Array, final: boolean): void {
    if (this.stream.destroyed) return;
    if (final) this.stream.end(chunk);
    else this.stream.write(chunk);
  }
  terminate(): void {
    this.stream.destroy();
  }
}
