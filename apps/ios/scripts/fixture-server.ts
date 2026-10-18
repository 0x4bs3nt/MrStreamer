// A synthetic subscription for the iOS app on the simulator. The desktop tests' fake Xtream panel
// (apps/desktop/test/fake-provider.ts) answers the API, with its messy catalogue of thousands of
// channels, its logins and its failures. In front of it this server adds what the panel lacks and
// real panels have: each live channel as HLS (`/live/<user>/<pass>/<id>.m3u8`), which AVPlayer
// plays where it can't play the panel's MPEG-TS.
//
//   node scripts/fixture-server.ts [port] [control port]
//
// The app connects to http://127.0.0.1:<port> as "fixture" / "fixture-pass", or as the
// FIXTURE_USERNAME / FIXTURE_PASSWORD given, such as the canaries scripts/log-scan.ts looks for.
// FIXTURE_SECOND=1 makes it another provider beside the first, on other ports: the fake panel's
// `second`, numbering channels, movies and series as the first does, some of the first's movies
// under ids of its own. Its requests are logged to requests-<port>.jsonl, and it says where it runs in server-<port>.json.
// Every channel is a live loop: the TEST channels loop their recording from
// apps/desktop/test/fixtures, codecs as they are, so the ones AVPlayer can't decode fail as they
// would; every other channel loops a 720p H.264 + AAC test picture made here with ffmpeg, light
// for even ids and dark for odd ones. Each request is logged without the login, to
// .local/ios-fixture/requests.jsonl.
//
// Movies and episodes are the panel's (FIXTURE_TITLES, about 120 by default, sizes the lists),
// with their files served here, byte ranges and all, since the panel's own redirect names a port
// the simulator can't reach. The TEST titles stream their clips from apps/desktop/test/fixtures
// as they are (MKV, AVI, MPEG-TS, MOV and MP4), so what AVPlayer can't open fails as it would;
// every other title streams a ten-minute H.264 + AAC feature made here, long enough to resume.
// A fake TMDB (apps/desktop/test/fake-tmdb.ts) answers under /tmdb/3. It answers TMDB's API only:
// the app builds its pictures' addresses on image.tmdb.org whatever API it is given, and the
// panel's posters are on image.example, so neither comes from here.
//
// FIXTURE_PROFILE=measure serves the movies and series for measuring the Movies and Series tabs
// (`measurementTitles` in the fake panel): known titles in 4K and UHD, and known ones added two
// and fifteen days before FIXTURE_ANCHOR, epoch seconds, the fake panel's TITLES_ADDED unless
// given, so New holds them while the app's clock reads up to three days after it. The lists keep
// their ids and sizes. What it declares, with a hash of the titles, is in server.json and at the
// control port's /profile. FIXTURE_LOGOS=png lists channel logos as PNG marks (`pngLogo`) at this
// server's address, which passes them on from the panel and logs them, in place of the SVG
// addresses the panel lists at its own port without serving them.
//
// The control port listens on the workbench only and is never tunnelled to the Mac:
//   POST /fail-catalogue?status=503    channel and category lists answer that; status=none restores
//   POST /fail-live?id=<id>&count=<n>  the next n playlists of that channel answer 503
//   GET  /requests?since=<epoch ms>    the logged requests
//   GET  /live                         channels asked for in the last six seconds
//   GET  /titles                       movie and episode files asked for in the last six seconds
//   POST /fail-titles?status=503       the next title file requests answer that; status=none restores
//   POST /fail-title-lists?status=503  movie and series lists, their categories and details answer
//                                      that; status=login refuses the login for the two lists, as
//                                      panels do; status=none restores
//   GET  /profile                      what FIXTURE_PROFILE=measure declares, when it is on
//   POST /delay-details?ms=8000        movie and series details answer that much later; ms=0 restores
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createServer,
  request as forward,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import {
  measurementTitles,
  pngLogo,
  startFakeProvider,
  TITLES_ADDED,
  type FakeChannel,
} from "../../desktop/test/fake-provider.ts";
import { startFakeTmdb } from "../../desktop/test/fake-tmdb.ts";

const USERNAME = process.env.FIXTURE_USERNAME ?? "fixture";
const PASSWORD = process.env.FIXTURE_PASSWORD ?? "fixture-pass";
const CHANNELS = 6000;
/** Segments a live playlist lists, the newest last. */
const WINDOW = 5;
/** A channel counts as playing while it was asked for this recently. */
const PLAYING_MS = 6_000;

const port = Number(process.argv[2] ?? 8791);
const controlPort = Number(process.argv[3] ?? 8792);
const root = join(import.meta.dirname, "../../..");
const out = join(root, ".local/ios-fixture");
const fixtures = join(root, "apps/desktop/test/fixtures");
mkdirSync(out, { recursive: true });
const second = process.env.FIXTURE_SECOND === "1";
const pngLogos = process.env.FIXTURE_LOGOS === "png";
const log = join(out, second ? `requests-${port}.jsonl` : "requests.jsonl");

/** A looped recording, cut into segments of the durations its playlist gives. */
interface Media {
  readonly dir: string;
  readonly segments: readonly { readonly file: string; readonly seconds: number }[];
}

/** Cuts `input` into HLS segments in `dir` with ffmpeg, once; `args` say how. */
function media(name: string, args: readonly string[]): Media {
  const dir = join(out, "media", name);
  const playlist = join(dir, "index.m3u8");
  if (!existsSync(playlist)) {
    mkdirSync(dir, { recursive: true });
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      ...args,
      "-f",
      "hls",
      "-hls_time",
      "2",
      "-hls_playlist_type",
      "vod",
      "-hls_segment_filename",
      join(dir, "%03d.ts"),
      playlist,
    ]);
  }
  const lines = readFileSync(playlist, "utf8").split("\n");
  const segments = lines.flatMap((line, index) => {
    const seconds = /^#EXTINF:([\d.]+)/.exec(line)?.[1];
    const file = lines[index + 1]?.trim();
    return seconds && file ? [{ file, seconds: Number(seconds) }] : [];
  });
  return { dir, segments };
}

/** A minute of test picture with its clock, inset on a light or a dark field, and a tone. */
function picture(name: string, field: string): Media {
  return media(name, [
    ...["-f", "lavfi", "-i", `color=c=${field}:s=1280x720:r=30:d=60`],
    ...["-f", "lavfi", "-i", "testsrc=s=480x270:r=30:d=60"],
    ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=60"],
    ...["-filter_complex", "[0][1]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]"],
    ...["-map", "[v]", "-map", "2"],
    ...["-c:v", "libx264", "-profile:v", "high", "-g", "60", "-sc_threshold", "0", "-b:v", "1500k"],
    ...["-c:a", "aac", "-b:a", "128k"],
  ]);
}

const light = picture("light", "0xF2F2F2");
const dark = picture("dark", "0x050505");
const recordings = new Map<string, Media>();
/** A TEST channel's recording, its streams copied as they are. */
function recording(file: string): Media {
  let found = recordings.get(file);
  if (!found) {
    found = media(file.replace(/\W/g, "-"), ["-i", join(fixtures, file), "-c", "copy"]);
    recordings.set(file, found);
  }
  return found;
}

const provider = await startFakeProvider({
  channels: CHANNELS,
  titles: Number(process.env.FIXTURE_TITLES ?? 120),
  username: USERNAME,
  password: PASSWORD,
  second,
  ...(pngLogos ? { logoPng: pngLogo } : {}),
});
/** What the measurement profile declares about the titles it serves, when it is on. */
const profile =
  process.env.FIXTURE_PROFILE === "measure"
    ? (() => {
        const anchor = Number(process.env.FIXTURE_ANCHOR ?? TITLES_ADDED);
        // Epoch seconds: an anchor in milliseconds would date every title far in the future.
        if (!Number.isInteger(anchor) || anchor <= 0 || anchor >= 1e11) {
          throw new Error("FIXTURE_ANCHOR is a moment in epoch seconds");
        }
        const { titles, ...declared } = measurementTitles(provider.titles, anchor);
        provider.serveTitles(() => titles);
        const sha256 = createHash("sha256").update(JSON.stringify(titles)).digest("hex");
        return { name: "measure", ...declared, sha256 };
      })()
    : null;
const tmdb = await startFakeTmdb();
// One service streams the first movies and series it is told about.
tmdb.stream(
  "movie",
  provider.titles.movies.slice(12, 40).map((movie) => String(movie.id + 10_000)),
);
tmdb.stream(
  "tv",
  provider.titles.series.slice(0, 6).map((series) => series.tmdb ?? String(series.id + 10_000)),
);

/** Ten minutes of test picture with its clock and a tone, for titles to resume partway. */
const feature = join(out, "media", "feature.mp4");
if (!existsSync(feature)) {
  mkdirSync(join(out, "media"), { recursive: true });
  execFileSync("ffmpeg", [
    ...["-v", "error", "-y"],
    ...["-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=600"],
    ...["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:d=600"],
    ...["-c:v", "libx264", "-profile:v", "main", "-g", "50", "-b:v", "300k", "-pix_fmt", "yuv420p"],
    ...["-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart"],
    feature,
  ]);
}
/** What each movie's and episode's address streams: a file, or null for a missing one. */
const titleFiles = new Map<string, string | null>();
const fileOf = (name: string, fixture: string | null) =>
  fixture === null ? null : name.startsWith("TEST") ? join(fixtures, fixture) : feature;
for (const movie of provider.titles.movies) {
  titleFiles.set(`movie/${movie.id}`, fileOf(movie.name, movie.fixture));
}
for (const series of provider.titles.series) {
  for (const episode of series.seasons.flat()) {
    titleFiles.set(`series/${episode.id}`, fileOf(series.name, episode.fixture));
  }
}
/** Title file requests left to answer with a failure, and its status. */
let titleFailure: number | null = null;
/** How long movie and series details wait before the panel is asked. */
let detailsDelay = 0;
const channels = new Map(provider.catalogue.channels.map((each) => [String(each.streamId), each]));
const mediaOf = (channel: FakeChannel): Media | null =>
  channel.offline
    ? null
    : channel.fixture
      ? recording(channel.fixture)
      : channel.streamId % 2 === 0
        ? light
        : dark;

const started = Date.now();
/** Playlists of a channel left to answer with 503, by its id. */
const failing = new Map<string, number>();

interface Logged {
  readonly at: number;
  readonly kind: "api" | "playlist" | "segment" | "title" | "tmdb" | "other";
  readonly channel?: string;
  readonly status: number;
  readonly path: string;
}
const requests: Logged[] = [];
function record(entry: Logged) {
  requests.push(entry);
  appendFileSync(log, `${JSON.stringify(entry)}\n`);
}
/** A live path with whatever login it carries, and any query, left out. */
const redacted = (path: string) =>
  path.replace(/\?.*$/, "").replace(/^\/(live|movie|series)\/[^/]+\/[^/]+\//, "/$1/<login>/");

/** A title's file, whole or the byte range asked for, as panels serve them. */
function serveTitle(file: string, request: IncomingMessage, response: ServerResponse) {
  const bytes = readFileSync(file);
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
  if (start >= bytes.length) {
    response.writeHead(416, { "Content-Range": `bytes */${bytes.length}` }).end();
    return 416;
  }
  const type = file.endsWith(".mp4")
    ? "video/mp4"
    : file.endsWith(".mov")
      ? "video/quicktime"
      : file.endsWith(".mkv")
        ? "video/x-matroska"
        : file.endsWith(".avi")
          ? "video/x-msvideo"
          : "video/mp2t";
  response.writeHead(range ? 206 : 200, {
    "Content-Type": type,
    "Content-Length": end - start + 1,
    "Accept-Ranges": "bytes",
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` } : {}),
  });
  response.end(request.method === "HEAD" ? undefined : bytes.subarray(start, end + 1));
  return range ? 206 : 200;
}

/**
 * The live playlist of `channel` now: the newest `WINDOW` segments of its loop, which started
 * when this server did. Segment n is the loop's n % length, and each pass of the loop after the
 * first begins with a discontinuity, as its timestamps start again.
 */
function livePlaylist(channel: string, { segments }: Media): string {
  const loop = segments.reduce((sum, each) => sum + each.seconds, 0);
  const elapsed = (Date.now() - started) / 1000;
  const passes = Math.floor(elapsed / loop);
  let within = elapsed - passes * loop;
  let index = 0;
  while (index < segments.length - 1 && within >= (segments[index]?.seconds ?? 0)) {
    within -= segments[index]?.seconds ?? 0;
    index++;
  }
  const newest = passes * segments.length + index;
  const first = Math.max(0, newest - WINDOW + 1);
  const wraps = Math.floor(first / segments.length);
  const target = Math.ceil(Math.max(...segments.map((each) => each.seconds)));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${target}`,
    `#EXT-X-MEDIA-SEQUENCE:${first}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${first % segments.length === 0 && first > 0 ? wraps - 1 : wraps}`,
  ];
  for (let n = first; n <= newest; n++) {
    const at = n % segments.length;
    if (at === 0 && n > 0) lines.push("#EXT-X-DISCONTINUITY");
    lines.push(`#EXTINF:${segments[at]?.seconds.toFixed(3)},`, `/hls/${channel}/${n}.ts`);
  }
  return `${lines.join("\n")}\n`;
}

function answer(response: ServerResponse, status: number, type: string, body: string | Buffer) {
  response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  response.end(body);
}

const panel = new URL(provider.url);
/**
 * Sends the panel's answer with its addresses moved here, so the logos it lists are asked for
 * through this server, where they are logged, at the port the simulator reaches.
 */
function sendHere(reply: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  reply.on("data", (chunk: Buffer) => chunks.push(chunk));
  reply.on("end", () => {
    const body = Buffer.concat(chunks)
      .toString("utf8")
      .replaceAll(panel.origin, `http://127.0.0.1:${port}`);
    const { "content-length": _length, "transfer-encoding": _encoding, ...headers } = reply.headers;
    response.writeHead(reply.statusCode ?? 502, headers).end(body);
  });
}
createServer((request, response) => {
  const path = request.url ?? "/";
  const url = new URL(path, "http://fixture.test");
  const live = /^\/live\/([^/]+)\/([^/]+)\/(\d+)\.m3u8$/.exec(url.pathname);
  if (live) {
    const [, user, pass, id = ""] = live;
    const channel = channels.get(id);
    const found = channel ? mediaOf(channel) : null;
    const left = failing.get(id) ?? 0;
    const status =
      decodeURIComponent(user ?? "") !== USERNAME || decodeURIComponent(pass ?? "") !== PASSWORD
        ? 401
        : !found
          ? 404
          : left > 0
            ? 503
            : 200;
    if (status === 503) failing.set(id, left - 1);
    record({ at: Date.now(), kind: "playlist", channel: id, status, path: redacted(path) });
    if (status !== 200 || !found) return answer(response, status, "text/plain", "");
    return answer(response, 200, "application/vnd.apple.mpegurl", livePlaylist(id, found));
  }
  const segment = /^\/hls\/(\d+)\/(\d+)\.ts$/.exec(url.pathname);
  if (segment) {
    const [, id = "", n = "0"] = segment;
    const channel = channels.get(id);
    const found = channel ? mediaOf(channel) : null;
    const file = found?.segments[Number(n) % found.segments.length]?.file;
    const status = found && file ? 200 : 404;
    record({ at: Date.now(), kind: "segment", channel: id, status, path });
    if (!found || !file) return answer(response, 404, "text/plain", "");
    return answer(response, 200, "video/mp2t", readFileSync(join(found.dir, file)));
  }
  const title = /^\/(movie|series)\/([^/]+)\/([^/]+)\/(\d+)\.(\w+)$/.exec(url.pathname);
  if (title) {
    const [, folder = "", user, pass, id = ""] = title;
    const file = titleFiles.get(`${folder}/${id}`);
    const status =
      decodeURIComponent(user ?? "") !== USERNAME || decodeURIComponent(pass ?? "") !== PASSWORD
        ? 401
        : titleFailure !== null
          ? titleFailure
          : !file
            ? 404
            : serveTitle(file, request, response);
    record({ at: Date.now(), kind: "title", channel: id, status, path: redacted(path) });
    if (status !== 200 && status !== 206 && status !== 416)
      answer(response, status, "text/plain", "");
    return;
  }
  const tmdbPath = /^\/tmdb(\/3\/.*)$/.exec(path);
  if (tmdbPath) {
    const target = new URL(tmdb.url);
    const upstream = forward(
      { host: target.hostname, port: target.port, method: request.method, path: tmdbPath[1] },
      (reply) => {
        record({ at: Date.now(), kind: "tmdb", status: reply.statusCode ?? 0, path: url.pathname });
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on("error", () => answer(response, 502, "text/plain", ""));
    request.pipe(upstream);
    return;
  }
  // Everything else is the panel's own: its API, logos and guide. Details can be held back.
  const action = url.searchParams.get("action");
  const wait = action === "get_vod_info" || action === "get_series_info" ? detailsDelay : 0;
  setTimeout(() => {
    const upstream = forward(
      {
        host: panel.hostname,
        port: panel.port,
        method: request.method,
        path,
        headers: { ...request.headers, host: panel.host },
      },
      (reply) => {
        record({
          at: Date.now(),
          kind: url.pathname === "/player_api.php" ? "api" : "other",
          status: reply.statusCode ?? 0,
          path: `${url.pathname}${url.searchParams.get("action") ? `?action=${url.searchParams.get("action")}` : ""}`,
        });
        if (pngLogos && action === "get_live_streams") return sendHere(reply, response);
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on("error", () => answer(response, 502, "text/plain", ""));
    request.pipe(upstream);
  }, wait);
}).listen(port, "127.0.0.1");

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://control.test");
  const json = (body: unknown) => answer(response, 200, "application/json", JSON.stringify(body));
  if (request.method === "POST" && url.pathname === "/fail-catalogue") {
    const status = url.searchParams.get("status");
    provider.failCatalogue(status && status !== "none" ? Number(status) : null);
    return json({ catalogue: status });
  }
  if (request.method === "POST" && url.pathname === "/fail-live") {
    failing.set(url.searchParams.get("id") ?? "", Number(url.searchParams.get("count") ?? 1));
    return json(Object.fromEntries(failing));
  }
  if (url.pathname === "/requests") {
    const since = Number(url.searchParams.get("since") ?? 0);
    return json(requests.filter((each) => each.at >= since));
  }
  if (request.method === "POST" && url.pathname === "/fail-titles") {
    const status = url.searchParams.get("status");
    titleFailure = status && status !== "none" ? Number(status) : null;
    return json({ titles: titleFailure });
  }
  if (request.method === "POST" && url.pathname === "/fail-title-lists") {
    const status = url.searchParams.get("status");
    const failure =
      status === "login" ? "login" : status && status !== "none" ? Number(status) : null;
    if (
      typeof failure === "number" &&
      !(Number.isInteger(failure) && failure >= 400 && failure < 600)
    )
      return answer(response, 400, "text/plain", "");
    provider.failTitles(failure);
    return json({ titleLists: failure });
  }
  if (url.pathname === "/profile" && profile) return json(profile);
  if (request.method === "POST" && url.pathname === "/delay-details") {
    detailsDelay = Number(url.searchParams.get("ms") ?? 0);
    return json({ detailsDelay });
  }
  if (url.pathname === "/titles") {
    const recent = requests.filter(
      (each) => each.kind === "title" && each.at >= Date.now() - PLAYING_MS,
    );
    return json([...new Set(recent.map((each) => each.channel))]);
  }
  if (url.pathname === "/live") {
    const recent = requests.filter(
      (each) =>
        (each.kind === "playlist" || each.kind === "segment") && each.at >= Date.now() - PLAYING_MS,
    );
    return json([...new Set(recent.map((each) => each.channel))]);
  }
  answer(response, 404, "text/plain", "");
}).listen(controlPort, "127.0.0.1");

writeFileSync(
  join(out, second ? `server-${port}.json` : "server.json"),
  JSON.stringify({ port, controlPort, started, ...(profile ? { profile } : {}) }),
);
console.log(`fake TMDB at http://127.0.0.1:${port}/tmdb/3`);
if (profile) console.log(`measurement profile ${JSON.stringify(profile)}`);
console.log(
  `fixture panel http://127.0.0.1:${port} as ${USERNAME}, ${provider.catalogue.channels.length} channels; control http://127.0.0.1:${controlPort}`,
);
