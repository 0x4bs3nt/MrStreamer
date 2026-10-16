import type { LiveCatalogue, ProviderChannel } from "@mrstreamer/core/provider";
import { describe, expect, it } from "vitest";
import { buildLibrary } from "../src/library.ts";

// Live with several subscriptions: each catalogue keeps its own channels, named by subscription
// and id, categories of one name in one country are one, and a channel two providers list under
// the same name says which subscription each row is from.

const channel = (id: string, name: string, categoryIds: string[]): ProviderChannel => ({
  id,
  name,
  number: null,
  logoUrl: null,
  categoryIds,
  guideId: null,
  catchupDays: null,
});

const home: LiveCatalogue = {
  categories: [
    { id: "1", name: "NL | News" },
    { id: "2", name: "NL | Sport" },
  ],
  channels: [
    channel("10", "NL | NOS Journaal", ["1"]),
    channel("11", "NL | Ziggo Sport", ["2"]),
    channel("12", "Loose", []),
  ],
};
// The second panel numbers its channels as the first does.
const cabin: LiveCatalogue = {
  categories: [
    { id: "1", name: "NL | News" },
    { id: "3", name: "NL | Kids" },
  ],
  channels: [
    channel("10", "NL | RTL Nieuws", ["1"]),
    channel("11", "NL | NOS Journaal", ["1"]),
    channel("13", "NL | Zappelin", ["3"]),
  ],
};

const library = buildLibrary([
  { subscriptionId: "a", label: "Home", catalogue: home },
  { subscriptionId: "b", label: "Cabin", catalogue: cabin },
]);

describe("channels of several subscriptions", () => {
  it("joins categories of one name in one country, in the order the subscriptions were added", () => {
    expect(
      library.regions.map((region) => [
        region.name,
        region.shelves.map((shelf) => [shelf.title, shelf.channels.map((each) => each.key)]),
      ]),
    ).toEqual([
      [
        "Netherlands",
        [
          ["News", ["a:10", "b:10", "b:11"]],
          ["Sport", ["a:11"]],
          ["Kids", ["b:13"]],
        ],
      ],
      ["Other channels", []],
    ]);
  });

  it("finds each by its own subscription though the ids match", () => {
    expect(library.byKey.get("a:10")?.title).toBe("NOS Journaal");
    expect(library.byKey.get("b:10")?.title).toBe("RTL Nieuws");
    expect(library.byKey.get("b:10")?.subscriptionId).toBe("b");
  });

  it("names the subscription only where two channels read the same", () => {
    expect(library.byKey.get("a:10")?.ambiguous).toBe(true);
    expect(library.byKey.get("b:11")?.ambiguous).toBe(true);
    expect(library.byKey.get("b:10")?.ambiguous).toBeUndefined();
    expect(library.placeOf.get("a:10")).toBe("Netherlands · News · Home");
    expect(library.placeOf.get("b:11")).toBe("Netherlands · News · Cabin");
    expect(library.placeOf.get("b:10")).toBe("Netherlands · News");
  });

  it("shows channels outside the listed categories last", () => {
    const others = library.regions.at(-1);
    expect(others?.channels.map((each) => each.key)).toEqual(["a:12"]);
    expect(library.placeOf.get("a:12")).toBe("Other channels");
  });
});

describe("channels in no category", () => {
  it("join a provider's own region of that name rather than make a second one", () => {
    const own: LiveCatalogue = {
      categories: [
        { id: "1", name: "News" },
        { id: "2", name: "Other channels" },
      ],
      channels: [
        channel("1", "Alpha", ["1"]),
        channel("2", "Bravo", ["2"]),
        channel("3", "Charlie", []),
      ],
    };
    const joined = buildLibrary([
      { subscriptionId: "a", label: "Home", catalogue: own },
      {
        subscriptionId: "b",
        label: "Cabin",
        catalogue: { categories: [], channels: [channel("9", "Delta", [])] },
      },
    ]);
    const names = joined.regions.map((region) => region.name);
    expect(names).toEqual(["News", "Other channels"]);
    expect(joined.regions[1]?.channels.map((each) => each.key)).toEqual(["a:2", "a:3", "b:9"]);
  });
});
