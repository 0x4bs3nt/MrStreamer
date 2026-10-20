import { describe, expect, it } from "vitest";
import { categoryBrowseTopics, browseCategories, browseMetadata } from "../src/catalogue/browse.ts";
import { normalizeCatalogue } from "../src/catalogue/normalize.ts";
import { liveChannels } from "../src/catalogue/variants.ts";

describe("Live TV discovery labels", () => {
  it.each([
    ["BE | NIEUWS HD", ["news"]],
    ["UK | SPORT NEWS", ["news", "sport"]],
    ["DE | KINDER", ["kids"]],
    ["FR | CINÉMA", ["movies"]],
    ["ES | ENTRETENIMIENTO", ["entertainment"]],
    ["IT | MUSICA", ["music"]],
    ["FR | DOCUMENTAIRES", ["documentary"]],
    ["AR | أطفال", ["kids"]],
    ["BE | VLAANDEREN", ["regional"]],
    ["BE | VLAANDEREN 50FPS", ["regional"]],
    ["BE | VLAANDEREN 60 FPS", ["regional"]],
    ["BE | VLAANDEREN H.265", ["regional"]],
    ["BE | VLAANDEREN HD+", ["regional"]],
    ["World", ["other"]],
    ["International", ["other"]],
    ["World news", ["news"]],
    ["Africa", ["regional"]],
    ["Asia", ["regional"]],
    ["Nieuwsbrief", ["other"]],
    ["FR | BELGIQUE", ["regional"]],
    ["BE |", ["other"]],
    ["UK | 4K", ["other"]],
    ["BE | SPECIAL VIP", ["other"]],
    ["SPORTSMAN", ["other"]],
    ["Unknown", ["other"]],
    ["Arabic", ["other"]],
    ["Kurdish", ["other"]],
    ["EU | Europe", ["regional"]],
  ])("classifies category %s without guessing a channel's identity", (label, topics) => {
    expect(categoryBrowseTopics(label)).toEqual(topics);
  });

  it("keeps topics separate from joins, rejects contradictory filter facts and confines adults to Other", () => {
    const categories = [
      { id: "n", name: "BE - FR | NEWS" },
      { id: "s", name: "DE - DE | SPORT" },
    ];
    const channel = {
      id: "1",
      name: "BE - FR | Studio HD",
      categoryIds: ["n", "s"],
      number: 1,
      logoUrl: null,
      guideId: null,
      catchupDays: null,
    };
    const normalized = normalizeCatalogue({ categories, channels: [channel] });
    const joined = liveChannels(normalized.streams).channels[0]!;
    const streams = new Map(normalized.streams.map((stream) => [stream.id, stream]));
    const topics = browseCategories(categories);
    expect(browseMetadata(joined, topics, streams)).toEqual({
      topics: ["news", "sport"],
      country: null,
      language: null,
    });
    expect(browseMetadata({ ...joined, adult: true }, topics, streams).topics).toEqual(["other"]);
    expect(joined).not.toHaveProperty("browse");
    expect(normalized.streams[0]?.topics).toEqual(["Belgium|news", "Germany|sport"]);
  });
});
