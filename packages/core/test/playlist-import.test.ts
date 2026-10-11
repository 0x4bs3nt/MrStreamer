import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { importPlaylist, mapPlaylistGroup, playlistGroupId } from "../src/playlist/import.ts";
import { m3uReader } from "../src/playlist/m3u.ts";

function entries(text: string) {
  const reader = m3uReader();
  return [...reader.push(`#EXTM3U\n${text}\n`), ...reader.end()];
}
const source = entries(
  `#EXTINF:-1 group-title="News",News\nhttps://example.test/live.ts\n#EXTINF:-1 group-title="Films" tmdb-id="42",Film\n#EXTVLCOPT:http-user-agent=MovieAgent\n#EXTVLCOPT:http-referrer=https://example.test/\nhttps://example.test/one.mp4`,
);
const mapping = mapPlaylistGroup(
  undefined,
  ["News", "Films"].map(playlistGroupId),
  playlistGroupId("Films"),
  "movie",
);

describe("mixed playlist imports", () => {
  it("uses inherited groups for explicit movie and series picks and keeps their version IDs on reorder", () => {
    const films =
      "#EXTGRP:Films\n#EXTINF:-1,First film\nhttps://example.test/first.mp4\n#EXTINF:-1,Second film\nhttps://example.test/second.mp4\n";
    const shows = "#EXTGRP:Shows\n#EXTINF:-1,Series S01E01\nhttps://example.test/episode.mp4\n";
    const news = '#EXTINF:-1 group-title="News",Live\nhttps://example.test/live.ts\n';
    const picked = mapPlaylistGroup(mapping, [], playlistGroupId("Shows"), "series");
    const imported = importPlaylist(entries(films + shows + news), picked);
    const reordered = importPlaylist(entries(shows + films + news), picked);
    expect(imported.status).toMatchObject({
      live: 1,
      movies: 2,
      series: 1,
      episodes: 1,
      omitted: 0,
    });
    expect(reordered.catalogue.movies.map((movie) => movie.id)).toEqual(
      imported.catalogue.movies.map((movie) => movie.id),
    );
    expect(reordered.catalogue.series).toEqual(imported.catalogue.series);
    expect(
      imported.catalogue.movies.every((movie) =>
        movie.categoryIds.includes(playlistGroupId("Films")),
      ),
    ).toBe(true);
    expect(importPlaylist(entries(films + shows + news)).status).toMatchObject({
      live: 4,
      movies: 0,
      series: 0,
    });
  });

  it("keeps old lists Live-only, and the first mapping preserves other current Live groups", () => {
    expect(importPlaylist(source).status).toMatchObject({ live: 2, movies: 0, explicit: false });
    expect(importPlaylist(source, mapping).status).toMatchObject({
      live: 1,
      movies: 1,
      explicit: true,
    });
    const unknown = entries(`#EXTINF:-1 group-title="New",New\nhttps://example.test/new.mp4`);
    expect(importPlaylist([...source, ...unknown], mapping).omissions).toEqual([
      { name: "New", groups: ["New"], reason: "unmapped" },
    ]);
  });
  it("preserves unmapped Live duplicate ids, names, guide ids and source order", () => {
    const legacy = entries(
      '#EXTINF:-1 tvg-id="news" group-title="News",News\nhttps://example.test/news.ts\n#EXTINF:-1 tvg-id="other" group-title="News",Other\nhttps://example.test/other.ts\n#EXTINF:-1 tvg-id="news" group-title="News",News\nhttps://example.test/news.ts',
    );
    expect(
      importPlaylist(legacy).live.channels.map((channel) => [
        channel.id,
        channel.name,
        channel.guideId,
      ]),
    ).toEqual([
      ["news", "News", "news"],
      ["other", "Other", "other"],
      ["news|News", "News", "news"],
    ]);
  });

  it("keeps every distinct source and header version reachable, collapses only exact entries, and survives reorder", () => {
    const versions = entries(
      `#EXTINF:-1 group-title="Films" tmdb-id="42",Film\nhttps://example.test/two.mp4\n#EXTINF:-1 group-title="Films" tmdb-id="42",Film\n#EXTVLCOPT:http-user-agent=OtherAgent\nhttps://example.test/one.mp4`,
    );
    const before = importPlaylist([...source, ...versions, ...versions], mapping);
    expect(before.catalogue.movies).toHaveLength(3);
    const after = importPlaylist([...versions.toReversed(), ...source.toReversed()], mapping);
    expect(after.catalogue.movies.map((each) => each.id).sort()).toEqual(
      before.catalogue.movies.map((each) => each.id).sort(),
    );
    expect(new Set(before.catalogue.movies.map((each) => each.id)).size).toBe(3);
    expect(JSON.stringify(before.catalogue)).not.toContain("example.test/one");
    expect(
      [...before.files.values()].find((each) => each.headers["User-Agent"] === "MovieAgent"),
    ).toMatchObject({ container: "mp4", headers: { Referer: "https://example.test/" } });
  });

  it("keeps exact movie and episode identities across a change of system language", () => {
    const importer = new URL("../src/playlist/import.ts", import.meta.url).href;
    const reader = new URL("../src/playlist/m3u.ts", import.meta.url).href;
    const playlist =
      '#EXTM3U\n#EXTINF:-1 group-title="Films" channel-id="film" tvg-chno="7" tvg-country="NL",Film\nhttps://example.test/film.mp4\n#EXTINF:-1 group-title="Shows" channel-id="show" tvg-chno="8" tvg-country="NL",Show S01E02\nhttps://example.test/episode.mp4\n';
    const script = `
      import { importPlaylist, playlistGroupId } from ${JSON.stringify(importer)};
      import { m3uReader } from ${JSON.stringify(reader)};
      const reader = m3uReader();
      const imported = importPlaylist([...reader.push(${JSON.stringify(playlist)}), ...reader.end()], {
        version: 1, groups: [
          { group: playlistGroupId("Films"), mode: "movie" },
          { group: playlistGroupId("Shows"), mode: "series" },
        ],
      });
      console.log(JSON.stringify([...imported.files.keys()]));
    `;
    const identities = (locale: string) =>
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, LC_ALL: locale, LANG: locale },
        encoding: "utf8",
      });
    expect(identities("cs_CZ.UTF-8")).toBe(identities("en_US.UTF-8"));
  });

  it("bounds displayed names while retaining each full source identity", () => {
    const name = "a-".repeat(50_000);
    const long = entries(`#EXTINF:-1 group-title="Films",${name}\nhttps://example.test/long.mp4`);
    const pending = importPlaylist(long, { version: 1, groups: [] });
    expect(pending.omissions[0]?.name).toHaveLength(512);
    expect([...pending.groups.values()][0]?.[0]?.name).toHaveLength(512);
    const imported = importPlaylist(
      [...long, ...long.map((entry) => ({ ...entry, name: `${entry.name}Different` }))],
      mapping,
    );
    expect(imported.catalogue.movies).toHaveLength(2);
    expect(new Set(imported.catalogue.movies.map(({ id }) => id)).size).toBe(2);
    expect(imported.catalogue.movies.every(({ name }) => name.length <= 512)).toBe(true);
    expect(importPlaylist(long).live.channels[0]?.name).toBe(name);
  });

  it("leaves conflicting, partially unmapped, unsupported and nameless entries out with their reasons", () => {
    const list = entries(
      `#EXTINF:-1 group-title="News;Films",Conflict\nhttps://example.test/a.mp4\n#EXTINF:-1 group-title="Films;New",Unmapped\nhttps://example.test/b.mp4\n#EXTINF:-1 group-title="Films",Unsupported\nrtmp://example.test/a\n#EXTINF:-1 group-title="Films",\nhttps://example.test/c.mp4`,
    );
    expect(importPlaylist(list, mapping).omissions.map((each) => each.reason)).toEqual([
      "conflicting-groups",
      "unmapped",
      "unsupported-address",
      "missing-name",
    ]);
  });

  it("takes replacements as new versions and accepts only explicit valid TMDB ids", () => {
    const original = importPlaylist(source, mapping).catalogue.movies[0]!;
    expect(original.tmdbId).toBe("42");
    const changed = importPlaylist(
      source.map((each) => ({
        ...each,
        url: each.url.replace("one.mp4", "rotated.mp4"),
        attributes: { ...each.attributes, "tmdb-id": "film 42" },
      })),
      mapping,
    ).catalogue.movies[0]!;
    expect(changed.id).not.toBe(original.id);
    expect(changed.tmdbId).toBeNull();
  });

  it("keeps explicit unique entry identities opaque and refuses to reuse progress identity for a changed exact source", () => {
    const list = entries(
      `#EXTINF:-1 entry-id="provider-file" group-title="Films",Film\nhttps://example.test/one.mp4`,
    );
    const original = importPlaylist([...list, ...list], mapping).catalogue.movies[0]!;
    expect(original.id).not.toContain("provider-file");
    const replacement = importPlaylist(
      list.map((entry) => ({ ...entry, userAgent: "AnotherAgent" })),
      mapping,
    ).catalogue.movies[0]!;
    expect(replacement.id).not.toBe(original.id);
    const collision = importPlaylist(
      [...list, ...list.map((entry) => ({ ...entry, url: "https://example.test/two.mp4" }))],
      mapping,
    );
    expect(new Set(collision.catalogue.movies.map((title) => title.id)).size).toBe(2);
    expect(collision.catalogue.movies[0]?.id).toBe(original.id);
  });
});

it.each([
  ["Show S01E02", { series: "Show", season: 1, episode: 2 }],
  ["Show [S01E02]", { series: "Show", season: 1, episode: 2 }],
  ["Show [1x02]", { series: "Show", season: 1, episode: 2 }],
  ["Show (S01E02)", { series: "Show", season: 1, episode: 2 }],
  ["Show (1x02)", { series: "Show", season: 1, episode: 2 }],
  ["Show {1x02}", { series: "Show", season: 1, episode: 2 }],
  ["Show {S01E02}", { series: "Show", season: 1, episode: 2 }],
  [
    "Show [Director's cut] (2019) S01E02",
    { series: "Show [Director's cut] (2019)", season: 1, episode: 2 },
  ],
  ["Show - 1x02 - Name (4K)", { series: "Show", season: 1, episode: 2 }],
  ["Show s00e01 1080p", { series: "Show", season: 0, episode: 1 }],
  ["Show 1920x1080", null],
  ["ShowS01E02", null],
  ["Show S01E02extra", null],
  ["Show S01E02E03", null],
  ["Show S01E02-E03", null],
  ["Show S01E02 & E03", null],
  ["Show 1x02-03", null],
  ["Show S01E02 S01E03", null],
  ["S01E02", null],
  ["Show S01E00", null],
])("reads only an unambiguous bounded episode token in %s", async (name, expected) => {
  const { playlistEpisode } = await import("../src/playlist/episode.ts");
  expect(playlistEpisode(name)).toEqual(expected);
});

it("keeps original series order across seasons and every exact version selectable", async () => {
  const { indexCatalogue } = await import("../src/ondemand/catalogue.ts");
  const { seriesDetails, seriesEpisodeOrder, nextEpisode } =
    await import("../src/ondemand/details.ts");
  const { continuation, nextUnwatched, episodeStates } = await import("../src/viewing/episodes.ts");
  const list = entries(
    `#EXTINF:-1 group-title="Shows",Show S02E03\nhttps://example.test/a.mp4\n#EXTINF:-1 group-title="Shows",Show S01E02\nhttps://example.test/b.mp4\n#EXTINF:-1 group-title="Shows",Show S02E01\nhttps://example.test/c.mp4\n#EXTINF:-1 group-title="Shows",Show S02E03 4K\n#EXTVLCOPT:http-user-agent=AlternateAgent\nhttps://example.test/a.mp4`,
  );
  const imported = importPlaylist(list, {
    version: 1,
    groups: [{ group: playlistGroupId("Shows"), mode: "series" }],
  });
  expect(imported.status).toMatchObject({ series: 1, episodes: 4, omitted: 0 });
  const title = indexCatalogue([{ subscriptionId: "s", catalogue: imported.catalogue }], "en")
    .series.titles[0]!;
  const shown = seriesDetails(title, imported.details.get(title.id)!, null, "en");
  const order = seriesEpisodeOrder(shown);
  expect(order.map((each) => `${each.season}:${each.number}`)).toEqual(["2:3", "1:2", "2:1"]);
  const first = order[0]!;
  const alternate = first.versions![1]!;
  expect(first.versions).toHaveLength(2);
  expect(imported.files.get(alternate.id)?.headers).toEqual({ "User-Agent": "AlternateAgent" });
  const played = {
    title: {
      kind: "episode" as const,
      id: alternate.id,
      seriesId: title.id,
      season: 2,
      episode: 3,
    },
    position: 500,
    duration: 1000,
    finished: false,
    at: 1,
    since: 1,
  };
  expect(continuation(shown, [played], [])?.episode.id).toBe(alternate.id);
  const playedFirst = {
    ...played,
    title: { ...played.title, id: first.id },
    position: 1000,
    at: 0,
  };
  expect(continuation(shown, [playedFirst, played], [])?.resume?.position).toBe(500);
  expect(nextUnwatched(shown, { id: alternate.id, season: 2, episode: 3 }, [], [])?.id).toBe(
    order[1]?.id,
  );
  expect(nextEpisode(shown, { id: alternate.id, season: 2, episode: 3 })?.id).toBe(order[1]?.id);
  const old = { ...played, title: { ...played.title, id: "obsolete-file" } };
  expect(continuation(shown, [old], [])?.resume).toBeUndefined();
  expect(episodeStates([old], [])(first).kind).toBe("unwatched");
  expect(nextEpisode(shown, old.title)).toBeUndefined();
  expect(nextUnwatched(shown, old.title, [], [])).toBeUndefined();
});

it("follows source order through specials for next, continuation and finish", async () => {
  const { indexCatalogue } = await import("../src/ondemand/catalogue.ts");
  const { seriesDetails, seriesEpisodeOrder, nextEpisode } =
    await import("../src/ondemand/details.ts");
  const { continuation, nextUnwatched, finishes } = await import("../src/viewing/episodes.ts");
  const imported = importPlaylist(
    entries(
      ["Show S02E03", "Show S00E01", "Show S01E02"]
        .map((name, at) => `#EXTINF:-1 group-title="Shows",${name}\nhttps://example.test/${at}.mp4`)
        .join("\n"),
    ),
    { version: 1, groups: [{ group: playlistGroupId("Shows"), mode: "series" }] },
  );
  const title = indexCatalogue([{ subscriptionId: "s", catalogue: imported.catalogue }], "en")
    .series.titles[0]!;
  const shown = seriesDetails(title, imported.details.get(title.id)!, null, "en");
  const order = seriesEpisodeOrder(shown);
  const plays = order.map((episode, at) => ({
    title: {
      kind: "episode" as const,
      id: episode.id,
      seriesId: title.id,
      season: episode.season,
      episode: episode.number,
    },
    position: 1000,
    duration: 1000,
    finished: true,
    at: at + 1,
    since: at + 1,
  }));
  expect(nextEpisode(shown, plays[0]!.title)?.id).toBe(order[1]!.id);
  expect(nextUnwatched(shown, plays[1]!.title, plays.slice(0, 2), [])?.id).toBe(order[2]!.id);
  expect(continuation(shown, plays.slice(0, 2), [])?.episode.id).toBe(order[2]!.id);
  expect(finishes(shown, { ...plays[2]!.title, since: 3 }, plays.slice(0, 2), [])).toBe(true);
  expect(finishes(shown, { ...plays[2]!.title, id: "obsolete", since: 3 }, plays, [])).toBe(false);
});

it("groups ordinary bracketed tokens with plain episodes without changing exact file identities or source order", async () => {
  const { indexCatalogue } = await import("../src/ondemand/catalogue.ts");
  const { seriesDetails, seriesEpisodeOrder } = await import("../src/ondemand/details.ts");
  const names = [
    "Show (2019) [S02E03]",
    "Show (2019) S00E01",
    "Show (2019) (1x02)",
    "Show (2019) {S02E01}",
    "Show (2019) S02E03",
  ];
  const source = entries(
    names
      .map(
        (name) =>
          `#EXTINF:-1 entry-id="exact" group-title="Shows",${name}\nhttps://example.test/same.mp4`,
      )
      .join("\n"),
  );
  const mapping = {
    version: 1 as const,
    groups: [{ group: playlistGroupId("Shows"), mode: "series" as const }],
  };
  const imported = importPlaylist(source, mapping);
  expect(imported.omissions).toEqual([]);
  expect(imported.catalogue.series).toHaveLength(1);
  const title = indexCatalogue([{ subscriptionId: "s", catalogue: imported.catalogue }], "en")
    .series.titles[0]!;
  expect(title.name).toBe("Show (2019)");
  const shown = seriesDetails(title, imported.details.get(title.id)!, null, "en");
  const order = seriesEpisodeOrder(shown);
  expect(order.map((episode) => `${episode.season}:${episode.number}`)).toEqual([
    "2:3",
    "0:1",
    "1:2",
    "2:1",
  ]);
  expect(order[0]!.versions).toHaveLength(2);
  expect(new Set(imported.files.keys()).size).toBe(names.length);
  const originalFirst = [...imported.files.keys()][0]!;
  const separate = source.flatMap((entry) => [...importPlaylist([entry], mapping).files.keys()]);
  expect([...imported.files.keys()].sort()).toEqual(separate.sort());
  expect([...importPlaylist(source.toReversed(), mapping).files.keys()].sort()).toEqual(
    separate.sort(),
  );
  // Changing only a raw label still changes that exact file, even when its series name agrees.
  const renamed = importPlaylist(
    source.map((entry) => ({ ...entry, name: entry.name.replace("[S02E03]", "S02E03") })),
    mapping,
  );
  expect(renamed.files.has(originalFirst)).toBe(false);
});

it("imports long series names without losing the full source identity or episode order", () => {
  const name = "Harbour" + ".".repeat(50000) + " Specials";
  const source = entries(
    [2, 3]
      .flatMap((number) => [
        `#EXTINF:-1 group-title="Shows",${name} S01E0${number}`,
        `https://example.test/episode-${number}.mkv`,
      ])
      .join("\n"),
  );
  const imported = importPlaylist(source, {
    version: 1,
    groups: [{ group: playlistGroupId("Shows"), mode: "series" }],
  });
  expect(imported.omissions).toEqual([]);
  expect(imported.catalogue.series).toHaveLength(1);
  const title = imported.catalogue.series[0]!;
  expect(title.name.length).toBeLessThanOrEqual(512);
  expect(imported.details.get(title.id)?.episodes.map((episode) => episode.number)).toEqual([2, 3]);
  expect(new Set(imported.details.get(title.id)?.episodes.map((episode) => episode.id)).size).toBe(
    2,
  );
});

it("bounds and strips links from a mapped Live entry's fallback name", () => {
  const imported = importPlaylist(
    entries(
      '#EXTINF:-1 group-title="News" tvg-name="see https://example.test/private",\nhttps://example.test/live.ts',
    ),
    { version: 1, groups: [{ group: playlistGroupId("News"), mode: "live" }] },
  );
  expect(imported.live.channels).toHaveLength(1);
  expect(imported.live.channels[0]!.name).not.toContain("https://");
  expect(imported.live.channels[0]!.id).not.toContain("https://");
  expect(imported.live.channels[0]!.name.length).toBeLessThanOrEqual(512);
});
