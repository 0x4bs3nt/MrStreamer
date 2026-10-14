// The made-up subscription the marketing captures show, and the public-domain footage it plays.
// docs/assets/marketing-demo-sources.json names the sources and everything shown: channels,
// programmes, titles, people and subtitles, all invented. See
// docs/contributing/marketing-artwork.md.
//
//   node apps/desktop/scripts/marketing-demo.ts --cache-dir <folder outside the repository>
//
// Run on its own, it prepares the media in the cache folder: it downloads NASA's Earth views and
// the National Park Service's Grand Canyon time-lapse, checks them against the manifest's SHA-256,
// and cuts an Earth channel loop, a Canyon Hours episode and its stills from them. Their own sound
// is left out. Needs ffmpeg and ffprobe on PATH, or MR_STREAMER_FFMPEG with ffprobe beside it.
//
// marketing-capture.ts starts the subscription with `startMarketingDemo`: the fake provider
// streaming the Earth loop, an adapter in front of it that lists only the manifest's channels and
// series and serves the episode, marks the channels the manifest gives catch-up days as keeping
// recordings, without serving one, and the fake TMDB behind a wrapper that answers with the
// manifest's names, stories and credits. Everything listens on loopback only.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import manifest from "../../../docs/assets/marketing-demo-sources.json" with { type: "json" };
import { startFakeProvider, type FakeProvider } from "../test/fake-provider.ts";
import { startFakeTmdb } from "../test/fake-tmdb.ts";

const override = process.env["MR_STREAMER_FFMPEG"];
const ffmpeg = override ?? "ffmpeg";
const ffprobe = override ? join(dirname(override), "ffprobe") : "ffprobe";

const { featured, shelf } = manifest;
const titles = [featured, ...shelf];
/** Thirty minutes, the length of every programme. */
const SLOT_MS = 30 * 60 * 1000;
/** How far into its programme every channel is when the subscription starts. */
const INTO_PROGRAMME_MS = 10 * 60 * 1000;
/** Where the lists say their pictures are. Nothing answers there: the capture fills them in. */
const ARTWORK = "https://image.example";

/** The files the subscription plays and shows, in the cache folder. */
export interface DemoMedia {
  readonly earth: string;
  readonly canyon: string;
  readonly backdrop: string;
  readonly poster: string;
  /** One still per episode, in the manifest's order. */
  readonly stills: readonly string[];
}

/** The folder given as --cache-dir, from a command's parsed options. */
export function cacheDirectory(given: string | undefined): string {
  if (!given) throw new Error("Pass --cache-dir <folder outside the repository>.");
  return resolve(given);
}

/** Downloads and cuts the media unless the cache folder already holds it. */
export async function prepareMedia(cache: string): Promise<DemoMedia> {
  mkdirSync(cache, { recursive: true });
  const media: DemoMedia = {
    earth: join(cache, "earth-loop.ts"),
    canyon: join(cache, "canyon-hours.mkv"),
    backdrop: join(cache, "canyon-backdrop.jpg"),
    poster: join(cache, "canyon-poster.jpg"),
    stills: featured.episodes.map((episode) => join(cache, `canyon-still-${episode.still}.jpg`)),
  };
  const files = [media.earth, media.canyon, media.backdrop, media.poster, ...media.stills];
  if (files.every((file) => existsSync(file))) return media;

  const earth = await download(cache, manifest.sources.earth);
  const canyon = await download(cache, manifest.sources.canyon);
  // The live channel: Earth from the space station, with silence for sound.
  run(ffmpeg, [
    ...["-ss", manifest.sources.earth.from, "-to", manifest.sources.earth.to, "-i", earth],
    ...["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"],
    ...["-map", "0:v", "-map", "1:a", "-shortest"],
    ...["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-g", "60"],
    ...["-c:a", "aac", "-b:a", "96k", "-f", "mpegts", media.earth],
  ]);
  // The episode: the canyon, two sound tracks of generated noise and two subtitle tracks.
  const subtitles = Object.entries(featured.subtitles).map(([language, lines]) => {
    const file = join(cache, `canyon-${language}.srt`);
    writeFileSync(file, subRip(lines));
    return { language, file };
  });
  const noise = (seed: number) =>
    `anoisesrc=color=brown:amplitude=0.02:sample_rate=48000:seed=${seed}`;
  run(ffmpeg, [
    ...["-ss", manifest.sources.canyon.from, "-to", manifest.sources.canyon.to, "-i", canyon],
    ...["-f", "lavfi", "-i", noise(1), "-f", "lavfi", "-i", noise(2)],
    ...subtitles.flatMap(({ file }) => ["-i", file]),
    ...["-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3", "-map", "4", "-shortest"],
    ...["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"],
    ...["-g", "30", "-keyint_min", "30", "-sc_threshold", "0"],
    ...["-c:a", "aac", "-b:a", "96k", "-ac", "2", "-c:s", "srt"],
    ...subtitles.flatMap(({ language }, index) => [
      ...[`-metadata:s:a:${index}`, `language=${language}`],
      ...[`-metadata:s:s:${index}`, `language=${language}`, `-disposition:s:${index}`, "0"],
    ]),
    ...["-disposition:a:0", "default", "-disposition:a:1", "0", media.canyon],
  ]);
  checkTracks(media.canyon, [
    "video:h264",
    ...subtitles.map(({ language }) => `audio:aac:${language}`),
    ...subtitles.map(({ language }) => `subtitle:subrip:${language}`),
  ]);
  // Stills of the same clip, at the source times the manifest lists.
  const still = (seconds: number, filter: string, file: string) =>
    run(ffmpeg, [
      ...["-ss", String(seconds), "-i", canyon, "-frames:v", "1", "-vf", filter],
      ...["-q:v", "2", file],
    ]);
  still(featured.backdrop, "scale=1280:720", media.backdrop);
  still(featured.poster, "crop=720:1080,scale=600:900", media.poster);
  for (const [index, episode] of featured.episodes.entries()) {
    still(episode.still, "scale=780:-2", media.stills[index] ?? media.backdrop);
  }
  return media;
}

/** Downloads a source into the cache unless it is there, and checks it against the manifest. */
async function download(
  cache: string,
  source: { readonly url: string; readonly file: string; readonly sha256: string },
): Promise<string> {
  const path = join(cache, source.file);
  if (!existsSync(path)) {
    console.log(`Downloading ${source.url}`);
    const response = await fetch(source.url);
    if (!response.ok || !response.body) {
      throw new Error(`${source.url} answered HTTP ${response.status}.`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(`${path}.part`));
    renameSync(`${path}.part`, path);
  }
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  const found = hash.digest("hex");
  if (found !== source.sha256) {
    throw new Error(`${path} has SHA-256 ${found}, and the manifest says ${source.sha256}.`);
  }
  return path;
}

function run(tool: string, args: readonly string[]): void {
  execFileSync(tool, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
}

/** Fails unless ffprobe finds exactly these tracks, as "audio:aac:eng", in this order. */
function checkTracks(file: string, expected: readonly string[]): void {
  const probed = JSON.parse(
    execFileSync(
      ffprobe,
      [
        ...["-v", "error", "-of", "json"],
        ...["-show_entries", "stream=codec_type,codec_name:stream_tags=language", file],
      ],
      { encoding: "utf8" },
    ),
  ) as { streams: { codec_type: string; codec_name: string; tags?: { language?: string } }[] };
  const found = probed.streams.map((stream) =>
    stream.codec_type === "video"
      ? `video:${stream.codec_name}`
      : `${stream.codec_type}:${stream.codec_name}:${stream.tags?.language ?? ""}`,
  );
  if (found.join(" ") !== expected.join(" ")) {
    throw new Error(`${file} holds ${found.join(" ")}, not ${expected.join(" ")}.`);
  }
}

function subRip(
  lines: readonly { readonly from: number; readonly to: number; readonly text: string }[],
): string {
  const time = (seconds: number) =>
    `00:00:${String(Math.floor(seconds)).padStart(2, "0")},${String(Math.round((seconds % 1) * 1000)).padStart(3, "0")}`;
  return lines
    .map((line, index) => `${index + 1}\n${time(line.from)} --> ${time(line.to)}\n${line.text}\n`)
    .join("\n");
}

export interface MarketingDemo {
  /** The subscription to log in to: the fake provider, at the adapter's address. */
  readonly provider: FakeProvider;
  /** For MR_STREAMER_TMDB_API. */
  readonly tmdbApi: string;
  /** The picture for an image address the lists or TMDB's stand-in hand out; null for any other. */
  artwork(address: string): { readonly contentType: string; readonly body: Buffer } | null;
  close(): Promise<void>;
}

/** Starts the subscription and TMDB's stand-in on loopback ports of their own. */
export async function startMarketingDemo(media: DemoMedia): Promise<MarketingDemo> {
  const started = Date.now();
  const provider = await startFakeProvider({
    channels: manifest.provider.channels,
    // Every channel plays the Earth loop, at its own pace, until the app lets go of it.
    streams: (_channel, out, signal) => {
      const loop = spawn(
        ffmpeg,
        [
          ...["-hide_banner", "-loglevel", "error", "-re", "-stream_loop", "-1"],
          ...["-i", media.earth, "-c", "copy", "-f", "mpegts", "pipe:1"],
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      loop.stdout.pipe(out);
      signal.addEventListener("abort", () => loop.kill("SIGKILL"), { once: true });
    },
  });
  const tmdb = await startFakeTmdb();

  /** The same request, sent on to the fake provider. */
  const forward = (url: URL) => fetch(new URL(url.pathname + url.search, provider.url));
  /** The rows the provider lists for a request, for the adapter to pick from. */
  const listed = async <Row>(url: URL) => (await (await forward(url)).json()) as Row[];

  async function api(url: URL): Promise<unknown> {
    switch (url.searchParams.get("action")) {
      // The account, as the provider knows it.
      case null:
        return (await forward(url)).json();
      case "get_live_categories":
        return manifest.categories.map(categoryRow);
      case "get_live_streams": {
        const rows = await listed<{ stream_id: number }>(url);
        return manifest.channels.flatMap((channel) => {
          const row = rows.find((each) => each.stream_id === channel.streamId);
          if (!row) return [];
          return {
            ...row,
            num: channel.number,
            name: channel.name,
            category_id: channel.categoryId,
            category_ids: [Number(channel.categoryId)],
            stream_icon: channel.logo ? `${ARTWORK}/logo-${channel.streamId}.svg` : "",
            epg_channel_id: guideId(channel),
            // The guide grid's catch-up sign and Play from start. Nothing answers a recording.
            tv_archive: channel.catchupDays ? 1 : 0,
            tv_archive_duration: channel.catchupDays ? String(channel.catchupDays) : 0,
          };
        });
      }
      case "get_series_categories":
        return [categoryRow(manifest.seriesCategory)];
      case "get_series": {
        const rows = await listed<{ series_id: number }>(url);
        return titles.flatMap((title) => {
          const row = rows.find((each) => each.series_id === title.providerId);
          if (!row) return [];
          return {
            ...row,
            name: `${title.name} (EN)`,
            cover: `${ARTWORK}/poster-${title.providerId}.jpg`,
            backdrop_path: [`${ARTWORK}/backdrop-${title.providerId}.jpg`],
            rating: String(title.rating),
            category_id: manifest.seriesCategory.id,
            category_ids: [Number(manifest.seriesCategory.id)],
            tmdb: String(title.tmdbId),
          };
        });
      }
      case "get_series_info":
        return url.searchParams.get("series_id") === String(featured.providerId)
          ? featuredInfo()
          : (await forward(url)).json();
      // No movies: the captures show a series.
      default:
        return [];
    }
  }

  const adapter = await listen((request, response) => {
    const url = new URL(request.url ?? "/", "http://adapter");
    if (url.pathname === "/player_api.php") return api(url).then((body) => json(response, body));
    if (url.pathname === "/xmltv.php") {
      response.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
      return void response.end(guide(started));
    }
    // A channel's stream comes from the fake provider, which counts it as its one connection.
    if (url.pathname.startsWith("/live/")) {
      const upstream = httpRequest(new URL(url.pathname, provider.url), (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      });
      upstream.on("error", () => response.destroy());
      response.on("close", () => upstream.destroy());
      return void upstream.end();
    }
    if (url.pathname.startsWith("/series/")) return sendFile(media.canyon, request, response);
    response.writeHead(404).end();
  });

  const wrapper = await listen(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://tmdb");
    const answer = await fetch(new URL(url.pathname + url.search, tmdb.url));
    json(response, about(url, await answer.json()), answer.status);
  });

  return {
    provider: { ...provider, url: address(adapter) },
    tmdbApi: `${address(wrapper)}/3`,
    artwork(address) {
      const url = new URL(address);
      if (url.hostname !== "image.example" && url.hostname !== "image.tmdb.org") return null;
      const [, kind, id] = /\/(poster|backdrop|still|portrait|logo)-(\d+)\.\w+$/.exec(
        url.pathname,
      ) ?? [null, null, null];
      const number = Number(id);
      const jpeg = (file: string) => ({ contentType: "image/jpeg", body: readFileSync(file) });
      const svg = (text: string) => ({ contentType: "image/svg+xml", body: Buffer.from(text) });
      if (kind === "still") {
        const index = featured.episodes.findIndex((episode) => episode.providerId === number);
        const file = media.stills[index];
        return file ? jpeg(file) : null;
      }
      if (kind === "portrait") {
        const person = featured.cast[number];
        return person ? svg(portrait(person.colour)) : null;
      }
      if (kind === "logo") {
        const channel = manifest.channels.find((each) => each.streamId === number);
        return channel?.logo ? svg(logo(channel.logo, channel.name)) : null;
      }
      if (number === featured.providerId) {
        return jpeg(kind === "poster" ? media.poster : media.backdrop);
      }
      const title = shelf.find((each) => each.providerId === number);
      if (!title || !kind) return null;
      return svg(cover(title.colours, kind === "poster" ? [600, 900] : [1280, 720], number));
    },
    async close() {
      await Promise.all([closeServer(adapter), closeServer(wrapper)]);
      await Promise.all([provider.close(), tmdb.close()]);
    },
  };
}

/** The featured series' details, as a panel sends them: its seasons, episodes and their files. */
function featuredInfo(): unknown {
  const seasons = [...new Set(featured.episodes.map((episode) => episode.season))];
  return {
    seasons: seasons.map((season) => ({
      season_number: season,
      name: `Season ${season}`,
      cover: "",
    })),
    info: {
      name: `${featured.name} (EN)`,
      plot: featured.overview,
      episode_run_time: String(featured.runtime),
      cover: `${ARTWORK}/poster-${featured.providerId}.jpg`,
      backdrop_path: [`${ARTWORK}/backdrop-${featured.providerId}.jpg`],
    },
    episodes: Object.fromEntries(
      seasons.map((season) => [
        String(season),
        featured.episodes
          .filter((episode) => episode.season === season)
          .map((episode) => ({
            id: String(episode.providerId),
            episode_num: episode.number,
            season,
            title: `${featured.name} - S${pad(season)}E${pad(episode.number)} - ${episode.name}`,
            container_extension: "mkv",
            info: {
              duration_secs: featured.runtime * 60,
              movie_image: `${ARTWORK}/still-${episode.providerId}.jpg`,
              plot: episode.overview,
              air_date: episode.airDate,
            },
          })),
      ]),
    ),
  };
}

/** What TMDB's stand-in answered, with the manifest's words for the titles it names. */
function about(url: URL, body: unknown): unknown {
  const season = /^\/3\/tv\/(\d+)\/season\/(\d+)$/.exec(url.pathname);
  if (season && Number(season[1]) === featured.tmdbId) {
    return {
      season_number: Number(season[2]),
      episodes: featured.episodes
        .filter((episode) => episode.season === Number(season[2]))
        .map((episode) => ({
          episode_number: episode.number,
          season_number: episode.season,
          name: episode.name,
          overview: episode.overview,
          still_path: `/still-${episode.providerId}.jpg`,
          air_date: episode.airDate,
          runtime: featured.runtime,
          vote_average: episode.rating,
          vote_count: 40,
          crew: [{ name: featured.creator, job: "Director" }],
          guest_stars: [{ name: episode.guest, character: null, profile_path: null }],
        })),
    };
  }
  const id = Number(/^\/3\/tv\/(\d+)$/.exec(url.pathname)?.[1]);
  const title = titles.find((each) => each.tmdbId === id);
  if (!title || typeof body !== "object" || body === null) return body;
  const opened = url.searchParams.get("append_to_response") === "credits";
  return {
    ...body,
    name: title.name,
    original_name: title.name,
    original_language: "en",
    genres: [{ id: title.genre }],
    vote_average: title.rating,
    backdrop_path: `/backdrop-${title.providerId}.jpg`,
    ...(opened ? { poster_path: `/poster-${title.providerId}.jpg` } : {}),
    ...(opened && title === featured
      ? {
          overview: featured.overview,
          episode_run_time: [featured.runtime],
          created_by: [{ name: featured.creator }],
          credits: {
            cast: featured.cast.map((person, index) => ({
              name: person.name,
              character: person.character,
              profile_path: `/portrait-${index}.jpg`,
            })),
            crew: [],
          },
        }
      : {}),
  };
}

function guideId(channel: { readonly streamId: number }): string {
  return `channel${channel.streamId}.demo`;
}

/**
 * An XMLTV guide for the manifest's channels: half-hour programmes from two hours before `started`
 * to a day after it, every channel ten minutes into the first programme the manifest lists for it.
 */
function guide(started: number): string {
  const first = started - INTO_PROGRAMME_MS;
  const parts = ['<?xml version="1.0" encoding="utf-8" ?><tv generator-info-name="marketing">'];
  for (const channel of manifest.channels) {
    parts.push(
      `<channel id="${guideId(channel)}"><display-name>${guideId(channel)}</display-name></channel>`,
    );
  }
  for (const channel of manifest.channels) {
    const { programmes } = channel;
    for (let slot = -4; slot < 48; slot++) {
      const start = first + slot * SLOT_MS;
      const title = programmes.at(slot % programmes.length) ?? "";
      parts.push(
        `<programme start="${xmltvTime(start)}" stop="${xmltvTime(start + SLOT_MS)}" channel="${guideId(channel)}">` +
          `<title lang="en">${title}</title></programme>`,
      );
    }
  }
  parts.push("</tv>");
  return parts.join("\n");
}

/** "20261004183000 +0000" */
function xmltvTime(time: number): string {
  return `${new Date(time).toISOString().slice(0, 19).replace(/[-T:]/g, "")} +0000`;
}

function pad(number: number): string {
  return String(number).padStart(2, "0");
}

function categoryRow(category: { readonly id: string; readonly name: string }) {
  return { category_id: category.id, category_name: category.name, parent_id: 0 };
}

/**
 * A title's artwork: two colours, a low sun and two ridges, placed by `seed` so no two look alike.
 * No words: the app writes the name.
 */
function cover(
  colours: readonly string[],
  [width, height]: readonly [number, number],
  seed: number,
): string {
  const [top = "#222", bottom = "#000"] = colours;
  const sun = { x: 0.24 + ((seed * 37) % 53) / 100, y: 0.22 + ((seed * 53) % 23) / 100 };
  const ridge = (y: number, dip: number) =>
    `M0 ${height * y}Q${width * (0.2 + sun.x / 3)} ${height * (y - dip)} ${width * 0.55} ${height * y}T${width} ${height * (y - dip / 2)}V${height}H0Z`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>` +
    `<rect width="${width}" height="${height}" fill="url(#sky)"/>` +
    `<circle cx="${width * sun.x}" cy="${height * sun.y}" r="${Math.min(width, height) * (0.08 + (seed % 4) / 50)}" fill="#fff" opacity=".7"/>` +
    `<path d="${ridge(0.6 + (seed % 3) / 40, 0.09)}" fill="#000" opacity=".3"/>` +
    `<path d="${ridge(0.78, 0.05 + (seed % 5) / 100)}" fill="#000" opacity=".45"/></svg>`
  );
}

/** A person's picture: a plain figure on their colour. Nobody real. */
function portrait(colour: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">` +
    `<rect width="200" height="200" fill="${colour}"/>` +
    `<circle cx="100" cy="82" r="34" fill="#fff" opacity=".55"/>` +
    `<path d="M32 200c0-42 30-66 68-66s68 24 68 66z" fill="#fff" opacity=".4"/></svg>`
  );
}

/** A channel's logo: its first letter on a disc of its colour. */
function logo(colour: string, name: string): string {
  const letter = name.replace(/^[A-Z]{2} \| /, "").charAt(0);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 64" width="96" height="64">` +
    `<circle cx="48" cy="32" r="26" fill="${colour}"/>` +
    `<circle cx="48" cy="32" r="26" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="3"/>` +
    `<text x="48" y="43" text-anchor="middle" font-family="sans-serif" font-size="30" font-weight="700" fill="#fff">${letter}</text></svg>`
  );
}

/** A file, whole or the byte range asked for, as a panel serves a movie or an episode. */
function sendFile(path: string, request: IncomingMessage, response: ServerResponse): void {
  const { size } = statSync(path);
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size) {
    return void response.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
  }
  response.writeHead(range ? 206 : 200, {
    "Content-Type": "video/x-matroska",
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
  });
  createReadStream(path, { start, end }).pipe(response);
}

/** A server on a loopback port of its own; a handler that fails answers 502. */
async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
): Promise<Server> {
  const server = createServer((request, response) => {
    Promise.resolve()
      .then(() => handler(request, response))
      .catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(502);
        response.end(String(error));
      });
  });
  await new Promise<void>((done, failed) => {
    server.once("error", failed);
    server.listen(0, "127.0.0.1", done);
  });
  return server;
}

function address(server: Server): string {
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("The server has no address.");
  return `http://127.0.0.1:${bound.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((done) => {
    server.closeAllConnections();
    server.close(() => done());
  });
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { "cache-dir": { type: "string" } } });
  const media = await prepareMedia(cacheDirectory(values["cache-dir"]));
  console.log(`Ready: ${Object.values(media).flat().join(", ")}`);
}
