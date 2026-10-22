import type { LiveCatalogue, ProviderChannel } from "@mrstreamer/core/provider";
import { describe, expect, it } from "vitest";
import { buildLibrary, searchPlaces } from "../src/library.ts";

// What Live can show of a provider's channel list: every channel it may show is in some region,
// whatever categories the provider lists, and channels for adults stay out. A second provider's
// "Other channels" joining a region of that name is in live-together.test.ts. Live's discovery
// finds countries and categories by name; its screens are in live-discovery.test.ts.

const channel = (
  id: string,
  name: string,
  categoryIds: string[],
  adult = false,
): ProviderChannel => ({
  id,
  name,
  number: null,
  logoUrl: null,
  categoryIds,
  guideId: null,
  adult,
  catchupDays: null,
});

/** One subscription's channels, as Live builds them. */
const only = (catalogue: LiveCatalogue) =>
  buildLibrary([{ subscriptionId: "a", label: "Home", catalogue }]);

const shown = (regions: ReturnType<typeof buildLibrary>["regions"]) =>
  regions.map((region) => [region.name, region.channels.map((each) => each.title)]);

describe("the channels Live shows", () => {
  it("shows every channel when the provider lists no categories", () => {
    const library = only({
      categories: [],
      channels: [channel("1", "Alpha", ["10"]), channel("2", "Bravo", [])],
    });
    expect(shown(library.regions)).toEqual([["All channels", ["Alpha", "Bravo"]]]);
  });

  it("shows channels outside the listed categories after them, once", () => {
    const library = only({
      categories: [{ id: "10", name: "News" }],
      channels: [
        channel("1", "Alpha", ["10"]),
        channel("2", "Bravo", ["99"]),
        channel("3", "Charlie", []),
        channel("4", "Delta", ["10", "99"]),
      ],
    });
    expect(shown(library.regions)).toEqual([
      ["News", ["Alpha", "Delta"]],
      ["Other channels", ["Bravo", "Charlie"]],
    ]);
    expect(library.placeOf.get("a:2")).toBe("Other channels");
  });

  it("leaves channels for adults out, and nothing to show when that is all there is", () => {
    const library = only({
      categories: [],
      channels: [channel("1", "Late", [], true)],
    });
    expect(library.regions).toEqual([]);
  });
});

describe("finding countries and categories", () => {
  const library = buildLibrary([
    {
      subscriptionId: "a",
      label: "Home",
      catalogue: {
        categories: [
          { id: "1", name: "NL | News" },
          { id: "2", name: "EN | World News" },
          { id: "3", name: "News Extra" },
          { id: "4", name: "EN | Kids" },
        ],
        channels: [
          channel("1", "NOS", ["1"]),
          channel("2", "BBC World", ["2"]),
          channel("3", "Extra", ["3"]),
          channel("4", "Cartoons", ["4"]),
        ],
      },
    },
  ]);
  const found = (query: string) =>
    searchPlaces(library, query).map((place) =>
      place.kind === "country"
        ? `country ${place.region.name}`
        : `category ${place.shelf.title} in ${place.region.name}`,
    );

  it("finds a group by its name, whether a country or a language, before categories", () => {
    const [english] = library.regions.filter((region) => region.shelves.length === 2);
    expect(found(english!.name.slice(0, 3))[0]).toBe(`country ${english!.name}`);
  });

  it("finds categories of every group, each with its own, and needs every word", () => {
    const news = found("news");
    expect(news.filter((each) => each.startsWith("category"))).toHaveLength(3);
    expect(found("world news")).toEqual([`category World News in ${library.regions[1]!.name}`]);
    expect(found("news kids")).toEqual([]);
    expect(found("  ")).toEqual([]);
  });

  it("finds a category that stands alone once, as the category", () => {
    expect(found("extra")).toEqual(["category News Extra in News Extra"]);
  });

  it("finds an Other channels holding more than its category as the country too", () => {
    // Home lists a category of that name and channels in none; Cabin has channels in none too.
    const merged = buildLibrary([
      {
        subscriptionId: "a",
        label: "Home",
        catalogue: {
          categories: [
            { id: "1", name: "News" },
            { id: "9", name: "Other channels" },
          ],
          channels: [
            channel("1", "NOS", ["1"]),
            channel("2", "Alpha", ["9"]),
            channel("3", "Bravo", []),
          ],
        },
      },
      {
        subscriptionId: "b",
        label: "Cabin",
        catalogue: {
          categories: [{ id: "1", name: "Kids" }],
          channels: [channel("1", "Zappelin", ["1"]), channel("9", "Charlie", [])],
        },
      },
    ]);
    const places = searchPlaces(merged, "other channels");
    const keys = (channels: readonly { readonly key: string }[]) => channels.map(({ key }) => key);
    expect(
      places.map((place) =>
        place.kind === "country"
          ? ["country", keys(place.region.channels)]
          : ["category", keys(place.shelf.channels)],
      ),
    ).toEqual([
      ["country", ["a:2", "a:3", "b:9"]],
      ["category", ["a:2"]],
    ]);
  });
});
