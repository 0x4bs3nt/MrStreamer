// A fake playlist host for tests, as a public collection publishes one: an M3U link without a
// login, whose channels are HLS streams. Everything it serves is generated; see
// scripts/hls-fixtures.ts and scripts/subtitle-fixtures.ts.
//
// - "TEST | Two sounds and subtitles" plays test/fixtures/hls: sixteen seconds with an English and
//   a Spanish sound rendition, the Spanish one named only "spa", and English and German WebVTT
//   subtitles, the English ones marked as the stream's default, and French ones without a line.
// - "TEST | Captions in the picture" declares nothing: its four seconds carry "HELLO CAPTIONS"
//   as closed captions, from 1 to 3 s.
// - "TEST | One sound" is a stream without anything to choose.
// - With `catchup`, "TEST | Catch-up" too: Flussonic's catch-up for two days. Its recordings,
//   `/catchup/index-<start>-<seconds>.m3u8`, are four parts of the clip of "TEST | One sound",
//   `part-0.mpegts` to `part-3.mpegts`, in a playlist that names no end, as one still being
//   recorded does.
//
// Every stream ends, so a line shows at the same second each time. The playlist's first line
// names a guide only once `nameGuide` says so, as a publisher adds one later; the guide then
// covers the first channel, and with `catchup` the catch-up channel too, in half hours.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { fixture } from "./fake-provider.ts";

/** The channels the playlist lists, by the id each has in the app. */
export const PLAYLIST_CHANNELS = {
  tracks: { id: "tracks.test", name: "TEST | Two sounds and subtitles" },
  captions: { id: "captions.test", name: "TEST | Captions in the picture" },
  plain: { id: "plain.test", name: "TEST | One sound" },
  /** Listed with `catchup` only. */
  catchup: { id: "catchup.test", name: "TEST | Catch-up" },
} as const;

const TYPES: Readonly<Record<string, string>> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".mpegts": "video/mp2t",
  ".vtt": "text/vtt",
};

export interface FakePlaylist {
  /** The link to connect with. It carries a token, as a private playlist's does. */
  readonly link: string;
  readonly origin: string;
  /** The path of every request so far, in order, without its query. */
  requests(): readonly string[];
  /** Has the playlist's first line name the guide from now on, or stop naming one. */
  nameGuide(named: boolean): void;
  close(): Promise<void>;
}

export async function startFakePlaylist(
  options: { readonly catchup?: boolean } = {},
): Promise<FakePlaylist> {
  const asked: string[] = [];
  let guideNamed = false;
  const hls = (file: string) =>
    readFileSync(join(import.meta.dirname, "fixtures/hls", file.replaceAll("/", "")));

  /** Four three-second parts of a recording, in a playlist that names no end yet. */
  const recording = () =>
    [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:3",
      "#EXT-X-MEDIA-SEQUENCE:0",
      ...[0, 1, 2, 3].flatMap((part) => [
        ...(part > 0 ? ["#EXT-X-DISCONTINUITY"] : []),
        "#EXTINF:3.000,",
        `part-${part}.mpegts`,
      ]),
      "",
    ].join("\n");

  /** One clip as a whole stream: a playlist of a single segment that ends. */
  const single = (seconds: number) =>
    [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      `#EXT-X-TARGETDURATION:${seconds}`,
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      `#EXTINF:${seconds.toFixed(3)},`,
      "clip.mpegts",
      "#EXT-X-ENDLIST",
      "",
    ].join("\n");

  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://host");
    asked.push(pathname);
    const [, folder = "", file = ""] = /^\/([^/]*)\/?(.*)$/.exec(pathname) ?? [];
    let body: string | Buffer | null = null;
    try {
      if (pathname === "/playlist.m3u") body = playlist();
      else if (pathname === "/guide.xml") body = guide(Date.now(), options.catchup ?? false);
      else if (folder === "tracks") body = hls(file);
      else if (file === "index.m3u8") body = folder === "captions" ? single(4) : single(3);
      else if (folder === "captions" && file === "clip.mpegts")
        body = fixture("h264-subtitles.mpegts");
      else if (folder === "plain" && file === "clip.mpegts") body = fixture("h264-aac.mpegts");
      else if (folder === "catchup" && /^index-\d+-\d+\.m3u8$/.test(file)) body = recording();
      else if (folder === "catchup" && /^(clip|part-\d)\.mpegts$/.test(file))
        body = fixture("h264-aac.mpegts");
    } catch {
      // A file the stream doesn't have.
    }
    if (body === null) return response.writeHead(404).end();
    response
      .writeHead(200, { "Content-Type": TYPES[extname(pathname)] ?? "application/octet-stream" })
      .end(body);
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const playlist = () =>
    [
      guideNamed ? `#EXTM3U x-tvg-url="${origin}/guide.xml"` : "#EXTM3U",
      `#EXTINF:-1 tvg-id="${PLAYLIST_CHANNELS.tracks.id}" group-title="Test",${PLAYLIST_CHANNELS.tracks.name}`,
      `${origin}/tracks/master.m3u8`,
      `#EXTINF:-1 tvg-id="${PLAYLIST_CHANNELS.captions.id}" group-title="Test",${PLAYLIST_CHANNELS.captions.name}`,
      `${origin}/captions/index.m3u8`,
      `#EXTINF:-1 tvg-id="${PLAYLIST_CHANNELS.plain.id}" group-title="Test",${PLAYLIST_CHANNELS.plain.name}`,
      `${origin}/plain/index.m3u8`,
      ...(options.catchup
        ? [
            `#EXTINF:-1 tvg-id="${PLAYLIST_CHANNELS.catchup.id}" catchup="flussonic" catchup-days="2" group-title="Test",${PLAYLIST_CHANNELS.catchup.name}`,
            `${origin}/catchup/index.m3u8`,
          ]
        : []),
      "",
    ].join("\n");

  return {
    link: `${origin}/playlist.m3u?token=t0k3n`,
    origin,
    requests: () => asked,
    nameGuide(named) {
      guideNamed = named;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((closed) => server.close(closed));
    },
  };
}

/** The first channel's programme on now, "Test card", and the one after, in XMLTV. */
function guide(now: number, catchup: boolean): string {
  const time = (at: number) =>
    `${new Date(at).toISOString().replace(/[-:T]/g, "").slice(0, 14)} +0000`;
  const hour = 60 * 60 * 1000;
  const programme = (
    from: number,
    to: number,
    title: string,
    channel: string = PLAYLIST_CHANNELS.tracks.id,
  ) =>
    `<programme start="${time(from)}" stop="${time(to)}" channel="${channel}"><title>${title}</title></programme>`;
  // Half hours on the catch-up channel, "Archive 0" on now, from an hour before to two after.
  const half = hour / 2;
  const slot = Math.floor(now / half) * half;
  const archive = catchup
    ? [-2, -1, 0, 1, 2, 3].map((at) =>
        programme(
          slot + at * half,
          slot + (at + 1) * half,
          `Archive ${at}`,
          PLAYLIST_CHANNELS.catchup.id,
        ),
      )
    : [];
  return `<?xml version="1.0"?><tv>${programme(now - hour, now + hour, "Test card")}${programme(now + hour, now + 2 * hour, "Closedown")}${archive.join("")}</tv>`;
}
