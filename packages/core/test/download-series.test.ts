// Downloaded episodes of a series on this computer: how the Downloads page groups and orders them,
// and which copy the offline player plays after another, from main's list alone.
import type { Download, DownloadList, DownloadSeries } from "@mrstreamer/contracts/downloads";
import { describe, expect, it } from "vitest";
import { copyShelf, nextCopy } from "../src/downloads/series.ts";

/** Two seasons of three episodes, then two specials, as an Xtream panel lists them. */
const harbour: DownloadSeries = {
  seasons: [
    { number: 1, episodes: [1, 2, 3] },
    { number: 2, episodes: [1, 2, 3] },
    { number: 0, episodes: [1, 2] },
  ],
  sourceOrder: false,
};

/** An episode's download of the series `series`, complete unless `over` says otherwise. */
function episode(
  id: string,
  season: number,
  number: number,
  over: Partial<Download> = {},
  series: string | null = "harbour",
): Download {
  return {
    id,
    title: { kind: "episode", id: `file-${id}`, seriesId: "77", season, episode: number },
    subscription: { id: "sub", name: "Northwind" },
    name: "Harbour Lights",
    episodeName: null,
    year: 2024,
    duration: 2700,
    originalLanguage: "en",
    posterUrl: null,
    wideUrl: null,
    size: 1_000_000,
    status: { kind: "complete" },
    progress: null,
    series,
    ...over,
  };
}

const movie: Download = {
  ...episode("arrival", 1, 1, {}, null),
  title: { kind: "movie", id: "m1" },
  name: "Arrival",
};

const list = (
  items: readonly Download[],
  series: DownloadList["series"] = { harbour },
): DownloadList => ({ items, series, bytes: 0, free: null, ended: 0 });

const transferring = {
  kind: "transferring",
  received: 10,
  size: 100,
  rate: null,
  restarted: false,
} as const;

describe("the copy after another", () => {
  it("is the next episode's copy, across a season", () => {
    const items = [episode("a", 1, 2), episode("b", 1, 3), episode("c", 2, 1)];
    expect(nextCopy(list(items), "a")).toEqual({
      kind: "copy",
      copy: items[1],
      season: 1,
      episode: 3,
    });
    expect(nextCopy(list(items), "b")).toEqual({
      kind: "copy",
      copy: items[2],
      season: 2,
      episode: 1,
    });
  });

  it("stops at an episode with no copy, though a later one is downloaded", () => {
    const items = [episode("a", 1, 3), episode("later", 2, 2)];
    expect(nextCopy(list(items), "a")).toEqual({ kind: "missing", season: 2, episode: 1 });
  });

  it.each([
    ["queued", { kind: "queued" }],
    ["waiting", { kind: "waiting" }],
    ["paused", { kind: "paused", received: 10, size: 100 }],
    ["transferring", transferring],
    [
      "failed",
      {
        kind: "failed",
        failure: { kind: "stream", failure: { kind: "unavailable", status: 404 } },
      },
    ],
  ] as const)("stops at the next episode while its download is %s", (_name, status) => {
    const next = episode("b", 1, 2, { status });
    const items = [episode("a", 1, 1), next, episode("later", 1, 3)];
    expect(nextCopy(list(items), "a")).toEqual({
      kind: "unfinished",
      copy: next,
      season: 1,
      episode: 2,
    });
  });

  it("stops at a next copy whose file is gone, and plays a complete file of it over another unfinished", () => {
    const gone = [episode("a", 1, 1), episode("b", 1, 2, { status: { kind: "missing" } })];
    expect(nextCopy(list(gone), "a")).toEqual({ kind: "missing", season: 1, episode: 2 });

    const files = [
      episode("a", 1, 1),
      episode("older", 1, 2, { status: { kind: "queued" } }),
      episode("b", 1, 2),
    ];
    expect(nextCopy(list(files), "a")).toMatchObject({ kind: "copy", copy: files[2] });
  });

  it("ends after the series' last numbered episode, and specials lead only to specials", () => {
    const items = [episode("last", 2, 3), episode("s1", 0, 1), episode("s2", 0, 2)];
    expect(nextCopy(list(items), "last")).toEqual({ kind: "end" });
    expect(nextCopy(list(items), "s1")).toMatchObject({ kind: "copy", copy: items[2] });
    expect(nextCopy(list(items), "s2")).toEqual({ kind: "end" });
  });

  it("follows a mapped playlist's source order, interleaved seasons and specials in place", () => {
    const playlist: DownloadSeries = {
      seasons: [
        { number: 1, episodes: [1] },
        { number: 0, episodes: [1] },
        { number: 2, episodes: [1] },
        { number: 1, episodes: [2] },
      ],
      sourceOrder: true,
    };
    const items = [episode("a", 1, 1), episode("s", 0, 1), episode("b", 2, 1), episode("c", 1, 2)];
    const of = (id: string) => nextCopy(list(items, { harbour: playlist }), id);
    expect(of("a")).toEqual({ kind: "copy", copy: items[1], season: 0, episode: 1 });
    expect(of("s")).toEqual({ kind: "copy", copy: items[2], season: 2, episode: 1 });
    expect(of("b")).toEqual({ kind: "copy", copy: items[3], season: 1, episode: 2 });
    expect(of("c")).toEqual({ kind: "end" });
  });

  it("goes by the series' listing in the list, which a later download read", () => {
    const items = [episode("a", 2, 3), episode("b", 2, 4)];
    const longer = { ...harbour, seasons: [{ number: 2, episodes: [1, 2, 3, 4] }] };
    expect(nextCopy(list(items), "a")).toEqual({ kind: "end" });
    expect(nextCopy(list(items, { harbour: longer }), "a")).toMatchObject({
      kind: "copy",
      copy: items[1],
    });
  });

  it("offers nothing for a movie, a copy without a series, or an episode its series doesn't list", () => {
    const legacy = episode("legacy", 1, 1, {}, null);
    const unlisted = episode("unlisted", 3, 1);
    const items = [movie, legacy, unlisted, episode("b", 1, 2)];
    expect(nextCopy(list(items), "arrival")).toBeUndefined();
    expect(nextCopy(list(items), "legacy")).toBeUndefined();
    expect(nextCopy(list(items), "unlisted")).toBeUndefined();
    expect(nextCopy(list(items), "gone")).toBeUndefined();
  });

  it("never takes a copy of another series, version or account for the next episode", () => {
    const items = [
      episode("a", 1, 1),
      episode("other-version", 1, 2, {}, "harbour-en"),
      episode("same-name-elsewhere", 1, 2, { subscription: null }, "harbour-other-account"),
      episode("legacy", 1, 2, {}, null),
    ];
    const series = { harbour, "harbour-en": harbour, "harbour-other-account": harbour };
    expect(nextCopy(list(items, series), "a")).toEqual({ kind: "missing", season: 1, episode: 2 });
  });
});

describe("the copies on this computer", () => {
  it("keeps a copy without a series alone and puts a series where its newest copy is", () => {
    const legacy = episode("legacy", 1, 1, {}, null);
    const items = [episode("b", 1, 2), legacy, episode("a", 1, 1), movie];
    expect(
      copyShelf(list(items)).map((item) => (item.kind === "copy" ? item.copy.id : item.key)),
    ).toEqual(["harbour", "legacy", "arrival"]);
  });

  it("shows a series' only copy on this computer as that copy, its queued episodes aside", () => {
    const items = [episode("queued", 1, 2, { status: { kind: "queued" } }), episode("a", 1, 1)];
    expect(copyShelf(list(items))).toEqual([{ kind: "copy", copy: items[1] }]);
  });

  it("orders a series' copies by its seasons and shows what is missing between them", () => {
    const items = [
      episode("s2e3", 2, 3),
      episode("s1e2", 1, 2),
      episode("s2e1", 2, 1, { status: { kind: "missing" } }),
      episode("queued", 1, 3, { status: { kind: "queued" } }),
    ];
    const [shelf] = copyShelf(list(items));
    expect(shelf).toMatchObject({ kind: "series", copies: [items[0], items[1], items[2]] });
    expect(shelf?.kind === "series" && shelf.seasons).toMatchObject([
      {
        number: 1,
        entries: [
          { kind: "copy", copy: items[1] },
          { kind: "gap", episodes: [3] },
        ],
      },
      {
        number: 2,
        entries: [
          { kind: "copy", copy: items[2] },
          { kind: "gap", episodes: [2] },
          { kind: "copy", copy: items[0] },
        ],
      },
    ]);
  });

  it("keeps specials apart, and puts copies of episodes it no longer lists last", () => {
    const items = [
      episode("special", 0, 2),
      episode("s1e1", 1, 1),
      episode("s1e2", 1, 2),
      episode("gone-s4", 4, 1),
      episode("gone-s3", 3, 5),
    ];
    const [shelf] = copyShelf(list(items));
    expect(
      shelf?.kind === "series" &&
        shelf.seasons.map((season) => [
          season.number,
          season.entries.map((entry) => (entry.kind === "copy" ? entry.copy.id : entry.episodes)),
        ]),
    ).toEqual([
      [1, ["s1e1", "s1e2"]],
      [0, ["special"]],
      [3, ["gone-s3"]],
      [4, ["gone-s4"]],
    ]);
  });

  it("shows a mapped playlist's interleaved seasons in its order", () => {
    const playlist: DownloadSeries = {
      seasons: [
        { number: 1, episodes: [1, 2] },
        { number: 2, episodes: [1] },
        { number: 1, episodes: [3] },
      ],
      sourceOrder: true,
    };
    const items = [episode("c", 1, 3), episode("a", 1, 1)];
    const [shelf] = copyShelf(list(items, { harbour: playlist }));
    expect(shelf?.kind === "series" && shelf.seasons).toMatchObject([
      {
        number: 1,
        entries: [
          { kind: "copy", copy: items[1] },
          { kind: "gap", episodes: [2] },
        ],
      },
      { number: 2, entries: [{ kind: "gap", episodes: [1] }] },
      { number: 1, entries: [{ kind: "copy", copy: items[0] }] },
    ]);
  });

  it("names each run apart from the others, the same while copies before it or in it come and go", () => {
    const keys = (items: readonly Download[], series = harbour) => {
      const [shelf] = copyShelf(list(items, { harbour: series }));
      return shelf?.kind === "series" ? shelf.seasons.map((season) => season.key) : [];
    };
    const later = [episode("s2e2", 2, 2), episode("s2e3", 2, 3), episode("gone-s3", 3, 5)];
    const [second, unlisted] = keys(later);
    const withEarlier = keys([...later, episode("s1e1", 1, 1)]);
    expect(withEarlier).toEqual([expect.any(String), second, unlisted]);
    expect(new Set(withEarlier).size).toBe(3);
    // The first copy of season 2 goes: its run is still the same one.
    expect(keys([later[1]!, later[2]!, episode("s1e1", 1, 1)])).toEqual(withEarlier);

    const playlist: DownloadSeries = {
      seasons: [
        { number: 1, episodes: [1, 2] },
        { number: 2, episodes: [1] },
        { number: 1, episodes: [3, 4] },
      ],
      sourceOrder: true,
    };
    const items = [episode("a", 1, 1), episode("b", 2, 1), episode("c", 1, 3), episode("d", 1, 4)];
    const [first, between, again] = keys(items, playlist);
    expect(new Set([first, between, again]).size).toBe(3);
    // Season 1's first stretch goes: its later one keeps its own name, not the gone one's.
    expect(keys(items.slice(1), playlist)).toEqual([between, again]);
  });

  it("groups by series key alone: the same name of another version stays apart", () => {
    const items = [
      episode("nl", 1, 1),
      episode("en", 1, 1, {}, "harbour-en"),
      episode("nl2", 1, 2),
      episode("en2", 1, 2, {}, "harbour-en"),
    ];
    const shelf = copyShelf(list(items, { harbour, "harbour-en": harbour }));
    expect(shelf.map((item) => item.kind === "series" && item.key)).toEqual([
      "harbour",
      "harbour-en",
    ]);
  });
});
