import type { LiveCatalogue, ProviderChannel } from "@mrstreamer/core/provider";
import { describe, expect, it } from "vitest";
import { buildLibrary } from "../src/library.ts";

// What Live can show of a provider's channel list: every channel it may show is in some region,
// whatever categories the provider lists, and channels for adults stay out. A second provider's
// "Other channels" joining a region of that name is in live-together.test.ts.

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
