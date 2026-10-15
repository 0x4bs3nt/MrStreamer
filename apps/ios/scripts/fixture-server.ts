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
// Every channel is a live loop: the TEST channels loop their recording from
// apps/desktop/test/fixtures, codecs as they are, so the ones AVPlayer can't decode fail as they
// would; every other channel loops a 720p H.264 + AAC test picture made here with ffmpeg, light
// for even ids and dark for odd ones. Each request is logged without the login, to
// .local/ios-fixture/requests.jsonl.
//
// The control port listens on the workbench only and is never tunnelled to the Mac:
//   POST /fail-catalogue?status=503    channel and category lists answer that; status=none restores
//   POST /fail-live?id=<id>&count=<n>  the next n playlists of that channel answer 503
//   GET  /requests?since=<epoch ms>    the logged requests
//   GET  /live                         channels asked for in the last six seconds
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as forward, type ServerResponse } from "node:http";
import { join } from "node:path";
import { startFakeProvider, type FakeChannel } from "../../desktop/test/fake-provider.ts";

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
const log = join(out, "requests.jsonl");

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
  username: USERNAME,
  password: PASSWORD,
});
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
  readonly kind: "api" | "playlist" | "segment" | "other";
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
  path.replace(/\?.*$/, "").replace(/^\/live\/[^/]+\/[^/]+\//, "/live/<login>/");

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
  // Everything else is the panel's own: its API, logos and guide.
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
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    },
  );
  upstream.on("error", () => answer(response, 502, "text/plain", ""));
  request.pipe(upstream);
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
  if (url.pathname === "/live") {
    const recent = requests.filter(
      (each) => each.kind !== "api" && each.at >= Date.now() - PLAYING_MS,
    );
    return json([...new Set(recent.map((each) => each.channel))]);
  }
  answer(response, 404, "text/plain", "");
}).listen(controlPort, "127.0.0.1");

writeFileSync(join(out, "server.json"), JSON.stringify({ port, controlPort, started }));
console.log(
  `fixture panel http://127.0.0.1:${port} as ${USERNAME}, ${provider.catalogue.channels.length} channels; control http://127.0.0.1:${controlPort}`,
);
