import { describe, expect, it } from "vitest";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { indexCatalogue, searchPage } from "../src/ondemand/catalogue.ts";
import { filterOptions, filterTitles, type FilterFiles } from "../src/ondemand/filters.ts";
import { languageHints, suitability, versionLabels } from "../src/ondemand/languages.ts";
import type { OnDemandCatalogue, ProviderTitle } from "../src/provider.ts";

function row(id: string, name: string, tmdbId: string | null): ProviderTitle {
  return {
    id,
    name,
    tmdbId,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt: null,
    releaseDate: null,
    categoryIds: [],
    adult: false,
    container: "mp4",
  };
}

const catalogue: OnDemandCatalogue = {
  movieCategories: [],
  seriesCategories: [],
  movies: [
    row("en", "Harbour FHD (EN)", "1"),
    row("nl", "Harbour 4K (NL)", "1"),
    row("unknown", "Fog", null),
    row("sd", "Quay SD (MULTI)", null),
  ],
  series: [row("series", "Harbour HD (EN)", "2")],
};
const index = indexCatalogue([{ subscriptionId: "provider", catalogue }], "en");
const key = (id: string) => ownedKey({ subscriptionId: "provider", id });
const tracks = (audio: readonly (string | null)[], subtitles: readonly (string | null)[]) => ({
  audio,
  subtitles,
});

describe("current-kind library filters", () => {
  it("applies every ranked-search filter to one real file while retaining the title's choices", () => {
    const files: FilterFiles = new Map([
      [key("en"), [{ tags: ["FHD", "EN"], tracks: tracks(["en"], ["nl"]) }]],
      [key("nl"), [{ tags: ["4K", "NL"], tracks: tracks(["nl"], ["en"]) }]],
    ]);
    expect(
      searchPage(index, "movie", "harbour", undefined, 1, {
        filters: { quality: "4k", language: "nl", verified: { kind: "subtitles", language: "nl" } },
        files,
      }),
    ).toEqual({ titles: [], total: 0, unfiltered: 1 });
    const page = searchPage(index, "movie", "harbour", undefined, 1, {
      filters: { quality: "4k", language: "nl", verified: { kind: "audio", language: "nl" } },
      files,
    });
    expect(page).toMatchObject({
      total: 1,
      unfiltered: 1,
      titles: [{ id: "nl", subscriptionId: "provider", tags: ["NL", "4K"] }],
    });
    expect(page.titles[0]?.versions).toEqual(index.movies.titles[0]?.versions);
  });

  it("keeps original sound and multiple subtitle marks out of generic multiple-language hints", () => {
    expect(languageHints(["VO"])).toEqual(["unknown"]);
    expect(languageHints(["MULTISUB"])).toEqual(["unknown"]);
    expect(languageHints(["MULTI SUB"])).toEqual(["unknown"]);
    expect(languageHints(["MULTI AUDIO"])).toEqual(["multi"]);
    expect(suitability(["VO"], "en")).toBe(3);
    expect(suitability(["MULTISUB"], "en")).toBe(3);
    expect(versionLabels([{ tags: ["VO"] }, { tags: ["MULTISUB"] }], "en")).toEqual([
      "Original sound",
      "Several subtitle languages",
    ]);
  });
  it("requires quality, name language and verified tracks on the same real movie version", () => {
    const files: FilterFiles = new Map([
      [key("en"), [{ tags: ["FHD", "EN"], tracks: tracks(["en"], ["nl"]) }]],
      [key("nl"), [{ tags: ["4K", "NL"], tracks: tracks(["nl"], ["en"]) }]],
    ]);
    expect(
      filterTitles(
        index.movies.titles,
        { quality: "4k", language: "nl", verified: { kind: "subtitles", language: "nl" } },
        files,
      ),
    ).toEqual([]);
    const matches = filterTitles(
      index.movies.titles,
      { quality: "4k", language: "nl", verified: { kind: "audio", language: "nl" } },
      files,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ subscriptionId: "provider", id: "nl", tags: ["NL", "4K"] });
    expect(matches[0]?.versions).toEqual(index.movies.titles[0]?.versions);
    expect(index.movies.titles[0]?.id).toBe("en");
  });

  it("keeps unread files and unknown language tracks honest, without inferring audio from a name", () => {
    const files: FilterFiles = new Map([
      [key("nl"), [{ tags: ["4K", "NL"], tracks: tracks([null], []) }]],
    ]);
    expect(
      filterTitles(index.movies.titles, { verified: { kind: "audio", language: "nl" } }, files),
    ).toEqual([]);
    expect(
      filterTitles(index.movies.titles, { quality: "unknown", language: "unknown" }, files).map(
        (t) => t.id,
      ),
    ).toEqual(["unknown"]);
    expect(
      filterTitles(
        index.movies.titles,
        { quality: "4k", verified: { kind: "audio", language: "unknown" } },
        files,
      ).map((t) => t.id),
    ).toEqual(["nl"]);
    expect(
      filterTitles(
        index.movies.titles,
        { verified: { kind: "audio", language: "unknown" } },
        files,
      ).map((t) => t.id),
    ).toEqual(["nl"]);
    expect(
      filterTitles(
        index.movies.titles,
        { verified: { kind: "subtitles", language: "unknown" } },
        files,
      ),
    ).toEqual([]);
    expect(filterOptions(index.movies.titles, files).verified).toEqual([
      { kind: "audio", language: "unknown" },
    ]);
  });

  it("does not combine one episode's hints with another episode's tracks", () => {
    const files: FilterFiles = new Map([
      [
        key("series"),
        [{ tags: ["4K", "NL"] }, { tags: ["FHD", "EN"], tracks: tracks(["nl"], ["nl"]) }],
      ],
    ]);
    expect(
      filterTitles(
        index.series.titles,
        { quality: "4k", verified: { kind: "audio", language: "nl" } },
        files,
      ),
    ).toEqual([]);
    expect(
      filterTitles(
        index.series.titles,
        { quality: "full-hd", verified: { kind: "audio", language: "nl" } },
        files,
      ).map((t) => t.id),
    ).toEqual(["series"]);
  });

  it("offers only current-kind hints and keeps verified words hidden until a file has facts", () => {
    expect(filterOptions(index.movies.titles, new Map())).toMatchObject({
      qualities: ["4k", "full-hd", "sd", "unknown"],
      languages: ["en", "multi", "nl", "unknown"],
      verified: [],
      files: 0,
    });
    const files: FilterFiles = new Map([
      [key("en"), [{ tags: ["FHD", "EN"], tracks: tracks(["en"], ["nl", null]) }]],
    ]);
    expect(filterOptions(index.movies.titles, files)).toMatchObject({
      files: 1,
      verified: expect.arrayContaining([
        { kind: "audio", language: "en" },
        { kind: "subtitles", language: "nl" },
        { kind: "subtitles", language: "unknown" },
      ]),
    });
    expect(filterOptions(index.series.titles, files)).toEqual({
      qualities: ["hd"],
      languages: ["en"],
      verified: [],
      files: 0,
    });
  });
});
