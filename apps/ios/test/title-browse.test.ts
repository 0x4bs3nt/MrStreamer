import { describe, expect, it } from "vitest";
import { kindOf } from "@mrstreamer/core/ondemand/catalogue";
import { collectionSort } from "@mrstreamer/core/ondemand/collections";
import type { FilterFile } from "@mrstreamer/core/ondemand/filters";
import type { CollectionId } from "@mrstreamer/contracts/ondemand";
import { ownedKey } from "@mrstreamer/contracts/subscription";
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

  it("counts found tracks for the one file they were found in, beside its declared hints", () => {
    const { made, index } = browseFixture(kind);
    const found = (id: string, audio: string): [string, readonly FilterFile[]] => {
      const key = ownedKey({ subscriptionId: "a", id });
      const tags = kindOf(index, kind)
        .byId.get(key)
        ?.versions.find((each) => each.id === id)?.tags;
      return [key, [{ tags: tags ?? [], tracks: { audio: [audio], subtitles: ["nl"] } }]];
    };
    // English sound was found in the Dutch 4K version only.
    const files = new Map([found("nl-4k", "en")]);
    const englishSound = { kind: "audio", language: "en" } as const;
    const heard = browseCollection(made, "all", { filters: { verified: englishSound } }, files);
    expect(heard.titles.map((title) => title.id)).toEqual(["nl-4k"]);
    expect(heard.files).toBe(1);
    expect(heard.verified).toEqual([
      { value: englishSound, count: 1 },
      { value: { kind: "subtitles", language: "nl" }, count: 1 },
    ]);
    const both = { verified: englishSound, language: "en" };
    expect(browseCollection(made, "all", { filters: both }, files).titles).toEqual([]);
    expect(
      browseCollection(
        made,
        "all",
        { filters: { verified: englishSound, quality: "4k" } },
        files,
      ).titles.map((title) => title.id),
    ).toEqual(["nl-4k"]);
    expect(
      browseCollection(made, "4k", { filters: { verified: englishSound } }, files).titles.map(
        (title) => title.id,
      ),
    ).toEqual(["nl-4k"]);
    // Found in the HD version, they don't count where only 4K versions may open.
    const hd = new Map([found("en-hd", "en")]);
    const fourK = browseCollection(made, "4k", { filters: { verified: englishSound } }, hd);
    expect(fourK.titles).toEqual([]);
    expect(fourK.verified).toEqual([]);
    expect(fourK.files).toBe(0);
    const declared = browseCollection(made, "all", DEFAULT_BROWSE);
    expect(declared.verified).toEqual([]);
    expect(declared.files).toBe(0);
  });
});
