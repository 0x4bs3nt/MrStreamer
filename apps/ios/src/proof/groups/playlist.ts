import { playlistCatalogue } from "@mrstreamer/core/playlist/catalogue";
import { m3uReader, type PlaylistEntry } from "@mrstreamer/core/playlist/m3u";
import { plain, type ProofCase } from "../cases.ts";

const PLAYLIST = [
  '#EXTM3U x-tvg-url="https://guide.test/a.xml.gz"',
  '#EXTINF:-1 tvg-id="Alpha.test@HD" tvg-logo="https://logos.test/a.png" group-title="NL | NEWS" http-user-agent="Player/1.0",Alpha News FHD',
  "#EXTVLCOPT:http-referrer=https://alpha.test/",
  "https://alpha.test/live/index.m3u8",
  "#EXTGRP:BE | VLAANDEREN",
  "#EXTINF:-1 tvg-chno=7,Beta HD",
  "http://beta.test:8080/stream.ts",
  "#EXTINF:-1,Delta",
  "https://delta.test/manifest.mpd",
].join("\r\n");

/** A playlist read in pieces, as it arrives from the network. */
function readPlaylist(size: number): PlaylistEntry[] {
  const reader = m3uReader();
  const entries: PlaylistEntry[] = [];
  for (let at = 0; at < PLAYLIST.length; at += size) {
    entries.push(...reader.push(PLAYLIST.slice(at, at + size)));
  }
  entries.push(...reader.end());
  return entries;
}

export const cases: readonly ProofCase[] = [
  {
    name: "core: m3u in chunks",
    compare: "same",
    run: async () => {
      const whole = readPlaylist(PLAYLIST.length);
      const chunked = readPlaylist(7);
      return {
        sameInChunks: JSON.stringify(whole) === JSON.stringify(chunked),
        entries: plain(whole),
      };
    },
  },
  {
    name: "core: playlist catalogue",
    compare: "same",
    run: () => {
      const { categories, channels } = playlistCatalogue(readPlaylist(64));
      return plain({ categories, channels });
    },
  },
];
