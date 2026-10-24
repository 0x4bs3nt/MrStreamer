import { describe, expect, it } from "vitest";
import { collectionSort } from "@mrstreamer/core/ondemand/collections";
import type { CollectionId } from "@mrstreamer/contracts/ondemand";
import { browseFixture } from "./title-browse-fixture.ts";
import { browseCollection, DEFAULT_BROWSE } from "../src/title-browse.ts";

describe.each(["movie", "series"] as const)("%s collection browsing", (kind) => {
  it("uses public collection defaults, all supported orders and stable catalogue ties", () => {
    const { made } = browseFixture(kind);
    for (const id of [
      "all",
      "4k",
      "new-week",
      "recent",
      "top-rated",
      "genre:Comedy",
      "service:8",
      "like:a:en-hd",
    ] satisfies CollectionId[]) {
      expect(browseCollection(made, id, DEFAULT_BROWSE).titles).toEqual(
        made.list(id, collectionSort(id)),
      );
      for (const sort of ["added", "popular", "rating", "title"] as const) {
        expect(browseCollection(made, id, { sort, filters: {} }).titles).toEqual(
          made.list(id, sort),
        );
      }
    }
    expect(
      browseCollection(made, "all", { sort: "title", filters: {} }).titles.map((title) => title.id),
    ).toEqual(["en-hd", "en-4k", "tie", "unknown"]);
    expect(
      browseCollection(made, "all", DEFAULT_BROWSE)
        .titles.slice(-2)
        .map((t) => t.id),
    ).toEqual(["unknown", "tie"]);
  });

  it("counts one title once, combines hints on one version and returns that exact version", () => {
    const { made } = browseFixture(kind);
    const all = browseCollection(made, "all", DEFAULT_BROWSE);
    expect(all.total).toBe(4);
    expect(all.qualities).toEqual([
      { value: "4k", count: 2 },
      { value: "hd", count: 1 },
      { value: "unknown", count: 2 },
    ]);
    expect(all.languages).toEqual([
      { value: "en", count: 2 },
      { value: "nl", count: 1 },
      { value: "unknown", count: 2 },
    ]);
    const english4k = browseCollection(made, "all", { filters: { quality: "4k", language: "en" } });
    expect(english4k.titles.map((title) => title.id)).toEqual(["en-4k"]);
    expect(english4k.qualities).toContainEqual({ value: "hd", count: 1 });
    expect(english4k.languages).toContainEqual({ value: "nl", count: 1 });
    const dutch4k = browseCollection(made, "all", { filters: { quality: "4k", language: "nl" } });
    expect(dutch4k.titles.map((title) => title.id)).toEqual(["nl-4k"]);
    expect(dutch4k.titles[0]?.versions).toHaveLength(2);
    expect(browseCollection(made, "all", DEFAULT_BROWSE).titles).toEqual(all.titles);
  });

  it("keeps unknown declarations truthful and never borrows a non-4K language version", () => {
    const { made } = browseFixture(kind);
    const unknown = browseCollection(made, "all", {
      filters: { quality: "unknown", language: "unknown" },
    });
    expect(unknown.titles.map((title) => title.id)).toEqual(["unknown", "tie"]);
    const english = browseCollection(made, "4k", { filters: { language: "en" } });
    expect(english.titles.map((title) => title.id)).toEqual(["en-4k"]);
    expect(english.languages).toContainEqual({ value: "nl", count: 1 });
  });
});
