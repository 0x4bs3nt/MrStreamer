import { describe, expect, it } from "vitest";
import { playlistCatalogue } from "../src/playlist/catalogue.ts";
import { adultIn } from "../src/adult.ts";
import { m3uReader, type PlaylistEntry } from "../src/playlist/m3u.ts";

// Made-up channels, written the ways playlists in the wild write them.
const PLAYLIST = [
  '﻿#EXTM3U x-tvg-url="https://guide.test/a.xml.gz,https://guide.test/b.xml"',
  '#EXTINF:-1 tvg-id="Alpha.test@HD" tvg-logo="https://logos.test/alpha.png" group-title="News;General" http-user-agent="Player/1.0 (X11, Linux)",Alpha News, Evening (720p) [Geo-blocked]',
  "#EXTVLCOPT:http-referrer=https://alpha.test/",
  "https://alpha.test/live/index.m3u8",
  `#EXTINF:-1 tvg-id='Beta.test' tvg-chno=7 group-title="Kid's",Beta`,
  "#EXTGRP:Ignored when group-title names one",
  "http://beta.test:8080/stream",
  "#EXTINF:0,Gamma",
  "#EXTGRP:Music",
  "#KODIPROP:inputstream.adaptive.manifest_type=hls",
  "https://gamma.test/play.php?id=3&output=m3u8",
  '#EXTINF:-1 tvg-id="Alpha.test@HD",Alpha News Backup',
  "https://backup.test/alpha.m3u8",
  '#EXTINF:-1 tvg-id="Delta.test",Delta',
  "https://delta.test/manifest.mpd",
  '#EXTINF:-1 tvg-id="Echo.test",Echo',
  "rtmp://echo.test/live",
  "https://orphan.test/no-extinf.ts",
].join("\r\n");

/** Reads `text` in pieces of `size` characters, as it would arrive from the network. */
function read(text: string, size: number) {
  const reader = m3uReader();
  const entries: PlaylistEntry[] = [];
  for (let at = 0; at < text.length; at += size) {
    entries.push(...reader.push(text.slice(at, at + size)));
  }
  entries.push(...reader.end());
  return { entries, playlist: reader.playlist, guideUrl: reader.guideUrl };
}

describe("playlists", () => {
  it("inherits documented EXTGRP blocks across entries and resets them explicitly", () => {
    // Kodi's begin/reset semantics, with fictional channels and reserved addresses.
    // Provenance: docs/user/category-compatibility.md.
    const text = [
      "#EXTM3U",
      "#EXTGRP:News;General",
      "#EXTINF:-1,First",
      "https://fixture.test/first.ts",
      "#EXTINF:-1,Second",
      "https://fixture.test/second.ts",
      "#EXTGRP:",
      "#EXTINF:-1,Ungrouped",
      "https://fixture.test/ungrouped.ts",
      "#EXTINF:-1,Adult",
      "#EXTGRP:XXX;General",
      "https://fixture.test/adult.ts",
      "#EXTINF:-1,Inherited adult",
      "https://fixture.test/inherited.ts",
      '#EXTINF:-1 group-title="Kids",Explicit',
      "https://fixture.test/explicit.ts",
      "#EXTINF:-1,After explicit",
      "https://fixture.test/after.ts",
      "#EXTGRP:News",
      '#EXTINF:-1 group-title="",Explicit empty',
      "https://fixture.test/empty.ts",
      "#EXTINF:-1,After empty",
      "https://fixture.test/after-empty.ts",
    ].join("\n");
    const whole = read(text, text.length);
    for (const size of [1, 7, 64]) expect(read(text, size)).toEqual(whole);
    const catalogue = playlistCatalogue(whole.entries);
    expect(catalogue.channels.map((channel) => channel.categoryIds)).toEqual([
      ["News", "General"],
      ["News", "General"],
      [],
      ["XXX", "General"],
      ["XXX", "General"],
      ["Kids"],
      [],
      [],
      [],
    ]);
    expect(catalogue.channels.map((channel) => channel.id)).toEqual(
      whole.entries.map((entry) => entry.name),
    );
    expect(
      catalogue.channels.filter(adultIn(catalogue.categories)).map((channel) => channel.id),
    ).toEqual(["Adult", "Inherited adult"]);
  });

  it("reads the same entries whatever pieces the text arrives in", () => {
    const whole = read(PLAYLIST, PLAYLIST.length);
    for (const size of [1, 7, 64]) expect(read(PLAYLIST, size)).toEqual(whole);

    expect(whole.playlist).toBe(true);
    expect(whole.guideUrl).toBe("https://guide.test/a.xml.gz");
    expect(whole.entries.map((entry) => entry.name)).toEqual([
      "Alpha News, Evening (720p) [Geo-blocked]",
      "Beta",
      "Gamma",
      "Alpha News Backup",
      "Delta",
      "Echo",
    ]);
    expect(whole.entries[0]).toMatchObject({
      url: "https://alpha.test/live/index.m3u8",
      userAgent: "Player/1.0 (X11, Linux)",
      referrer: "https://alpha.test/",
    });
  });

  it("lists channels as the playlist names them, without what can't play", () => {
    const { categories, channels, streams } = playlistCatalogue(read(PLAYLIST, 64).entries);

    expect(categories.map((category) => category.name)).toEqual([
      "News",
      "General",
      "Kid's",
      "Music",
    ]);
    expect(channels).toEqual([
      {
        id: "Alpha.test@HD",
        name: "Alpha News, Evening (720p) [Geo-blocked]",
        number: null,
        logoUrl: "https://logos.test/alpha.png",
        categoryIds: ["News", "General"],
        guideId: "Alpha.test@HD",
        catchupDays: null,
      },
      {
        id: "Beta.test",
        name: "Beta",
        number: 7,
        logoUrl: null,
        categoryIds: ["Kid's"],
        guideId: "Beta.test",
        catchupDays: null,
      },
      {
        id: "Gamma",
        name: "Gamma",
        number: null,
        logoUrl: null,
        categoryIds: ["Music"],
        guideId: null,
        catchupDays: null,
      },
      // A second channel under one tvg-id stays a channel of its own.
      expect.objectContaining({ id: "Alpha.test@HD|Alpha News Backup", guideId: "Alpha.test@HD" }),
    ]);
    expect(streams.get("Alpha.test@HD")).toEqual({
      url: "https://alpha.test/live/index.m3u8",
      format: "hls",
      headers: { "User-Agent": "Player/1.0 (X11, Linux)", Referer: "https://alpha.test/" },
    });
    expect(streams.get("Beta.test")).toMatchObject({ format: "mpegts", headers: {} });
    expect(streams.get("Gamma")?.format).toBe("hls");
  });

  it("tells a page that isn't a playlist from one", () => {
    expect(read("<!doctype html><title>Panel</title>", 8).playlist).toBe(false);
    expect(read('{"user_info":{"auth":0}}', 8).playlist).toBe(false);
    expect(read("#EXTINF:-1,Bare\nhttps://bare.test/a.ts\n", 8)).toMatchObject({
      playlist: true,
      guideUrl: null,
      entries: [{ name: "Bare", url: "https://bare.test/a.ts" }],
    });
  });
});
