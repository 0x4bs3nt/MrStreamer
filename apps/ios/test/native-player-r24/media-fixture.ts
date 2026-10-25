// Synthetic AVFoundation media inputs. Run generation under the canonical Linux runtime lock.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function prepareMedia(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ffmpeg = (args: string[]) =>
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      cwd: directory,
      stdio: "pipe",
    });
  const hls = ["-f", "hls", "-hls_time", "1", "-hls_list_size", "0"];
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24",
    "-t",
    "6",
    "-an",
    "-c:v",
    "libx264",
    "-profile:v",
    "baseline",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "24",
    ...hls,
    "video.m3u8",
  ]);
  for (const [index, frequency] of [440, 880].entries()) {
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:sample_rate=48000`,
      "-t",
      "6",
      "-ac",
      "2",
      "-c:a",
      "aac",
      ...hls,
      `audio${index}.m3u8`,
    ]);
  }
  for (const [index, text] of [
    "Non-forced text",
    "Native forced text",
    "No language text",
  ].entries()) {
    writeFileSync(
      join(directory, `subtitle${index}.vtt`),
      `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\n00:00:00.000 --> 00:00:05.500\n${text}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(directory, `subtitle${index}.m3u8`),
      `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6.000,\nsubtitle${index}.vtt\n#EXT-X-ENDLIST\n`,
      { mode: 0o600 },
    );
  }
  const audio = [
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="English first",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="audio0.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="English default",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio1.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="No language",DEFAULT=NO,AUTOSELECT=NO,URI="audio0.m3u8"',
  ];
  const subtitles = [
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="text",NAME="Forced by label only",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="subtitle0.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="text",NAME="Texte",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,FORCED=YES,URI="subtitle1.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="text",NAME="No language",DEFAULT=NO,AUTOSELECT=NO,FORCED=NO,URI="subtitle2.m3u8"',
  ];
  const variant =
    '#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.42c00c,mp4a.40.2",RESOLUTION=320x180,AUDIO="sound",SUBTITLES="text"';
  for (const [name, tracks] of [
    ["master.m3u8", audio],
    ["reordered.m3u8", [...audio].reverse()],
  ] as const) {
    writeFileSync(
      join(directory, name),
      ["#EXTM3U", "#EXT-X-VERSION:3", ...tracks, ...subtitles, variant, "video.m3u8", ""].join(
        "\n",
      ),
      { mode: 0o600 },
    );
  }
  return { fileCount: readdirSync(directory).length };
}

export function serveMedia(directory: string, port = 0) {
  const allowed = new Set(readdirSync(directory));
  const counts = { get: 0, head: 0, playlists: 0, segments: 0 };
  const server = createServer((request, response) => {
    const name = request.url?.split("?")[0]?.slice(1) ?? "";
    if (name === "counts") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(counts));
      return;
    }
    if (request.method === "HEAD") counts.head++;
    if (request.method !== "GET" || !allowed.has(name)) {
      response.writeHead(404);
      response.end();
      return;
    }
    counts.get++;
    if (name.endsWith(".m3u8")) counts.playlists++;
    else counts.segments++;
    const mime =
      extname(name) === ".m3u8"
        ? "application/vnd.apple.mpegurl"
        : extname(name) === ".vtt"
          ? "text/vtt"
          : "video/mp2t";
    const data = readFileSync(join(directory, name));
    response.writeHead(200, {
      "content-type": mime,
      "content-length": data.length,
      "cache-control": "no-store",
    });
    response.end(data);
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address !== "string") console.log(JSON.stringify({ port: address.port }));
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, directory, port] = process.argv.slice(2);
  if (!directory || (command !== "prepare" && command !== "serve"))
    throw new Error("fixture-arguments");
  if (command === "prepare") console.log(JSON.stringify(prepareMedia(resolve(directory))));
  else {
    const server = serveMedia(resolve(directory), Number(port ?? 0));
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close());
  }
}
