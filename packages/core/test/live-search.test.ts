import { describe, expect, it } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { normalizeCatalogue } from "../src/catalogue/normalize.ts";
import {
  automaticSearchCopy,
  groupLiveSearch,
  indexLiveSearch,
  matchingSearchGroups,
} from "../src/catalogue/search.ts";
import { liveChannels, streamsToPlay } from "../src/catalogue/variants.ts";
import type { LiveCatalogue } from "../src/provider.ts";

/** Exercise the public catalogue producer, not identities guessed by a renderer. */
function listed(
  subscriptionId: string,
  categories: readonly string[],
  entries: readonly {
    name: string;
    category: number;
    guide?: string | null;
    categories?: readonly number[];
  }[],
): readonly LiveChannel[] {
  const raw: LiveCatalogue = {
    categories: categories.map((name, index) => ({ id: String(index), name })),
    channels: entries.map((entry, index) => ({
      id: String(index + 1),
      name: entry.name,
      number: index + 1,
      logoUrl: null,
      categoryIds: (entry.categories ?? [entry.category]).map(String),
      guideId: entry.guide ?? null,
      catchupDays: null,
    })),
  };
  return liveChannels(normalizeCatalogue(raw).streams).channels.map((channel) => ({
    subscriptionId,
    ...channel,
  }));
}
const vrt = (subscriptionId: string) =>
  listed(
    subscriptionId,
    ["BE | VLAANDEREN", "BE | GENERAL"],
    [
      { name: "BE | VRT 1 FHD", category: 0, guide: "VRT1.be" },
      { name: "BE | VRT 1 HD", category: 0, guide: "VRT1.be" },
      { name: "BE | VRT 1 SD", category: 1, guide: "VRT1.be" },
      { name: "BE | VRT CANVAS FHD", category: 0, guide: "VRTCanvas.be" },
      { name: "BE | VRT CANVAS HD", category: 1, guide: "VRTCanvas.be" },
    ],
  );

describe("display-only Live TV search groups", () => {
  it("folds two providers and their duplicate category rows while retaining every canonical stream and favourite choice", () => {
    const blue = vrt("blue");
    const green = vrt("green");
    expect(blue).toHaveLength(4);
    const before = structuredClone([...blue, ...green]);
    const groups = groupLiveSearch([...blue, ...green, blue[0]!]);
    expect(groups).toHaveLength(2);
    expect(
      groups.map((group) => [group.copies[0]!.title, group.copies.length, group.streams]),
    ).toEqual([
      ["VRT 1", 4, 6],
      ["VRT Canvas", 4, 4],
    ]);
    expect([...blue, ...green]).toEqual(before);
    const first = groups[0]!;
    expect(automaticSearchCopy(first, new Set(), [{ id: "green" }, { id: "blue" }])).toBe(green[0]);
    expect(
      automaticSearchCopy(first, new Set([ownedKey(blue[1]!)]), [{ id: "green" }, { id: "blue" }]),
    ).toBe(blue[1]);
    const actual = automaticSearchCopy(first, new Set([ownedKey(blue[0]!)]), [
      { id: "green" },
      { id: "blue" },
    ]);
    expect(
      streamsToPlay(actual, { liveQuality: "hd", channelVariants: { "1": "2" } }).map(
        (stream) => stream.id,
      ),
    ).toEqual(["2"]);
    for (const copy of first.copies)
      for (const variant of copy.variants)
        expect(streamsToPlay(copy, { liveQuality: "fhd" }, variant.id)).toEqual([variant]);
  });

  it.each([
    ["unknown region", ["General"], "VRT 1", ["General"], "VRT 1"],
    ["another country", ["BE | GENERAL"], "BE | VRT 1", ["NL | GENERAL"], "NL | VRT 1"],
    ["another language", ["BE | GENERAL"], "BE | VRT 1", ["BE - FR | GENERAL"], "BE - FR | VRT 1"],
    ["another topic", ["BE | VLAANDEREN"], "BE | VRT 1", ["BE | SPORTS"], "BE | VRT 1"],
    ["regional feed", ["BE | GENERAL"], "BE | VRT 1", ["BE | GENERAL"], "BE | VRT 1 Limburg"],
    ["catch-up category", ["BE | GENERAL"], "BE | VRT 1", ["BE | CATCHUP"], "BE | VRT 1 (CATCHUP)"],
  ] as const)("keeps %s separate", (_, categoriesA, nameA, categoriesB, nameB) => {
    expect(
      groupLiveSearch([
        ...listed("a", categoriesA, [{ name: nameA, category: 0 }]),
        ...listed("b", categoriesB, [{ name: nameB, category: 0 }]),
      ]),
    ).toHaveLength(2);
  });

  it("joins matching explicit regions and topics without a guide, and fails closed without metadata", () => {
    const channels = [
      ...listed("a", ["BE | GENERAL"], [{ name: "BE | VRT 1 FHD", category: 0 }]),
      ...listed("b", ["BE | GENERAL HD"], [{ name: "BE | VRT 1 HD", category: 0 }]),
    ];
    expect(groupLiveSearch(channels)).toHaveLength(1);
    expect(
      groupLiveSearch(channels.map(({ searchIdentity: _identity, ...channel }) => channel)),
    ).toHaveLength(2);
  });

  it("a trusted guide supplies missing region and topic, but does not override country or guide conflicts", () => {
    const a = listed("a", ["General"], [{ name: "VRT 1", category: 0, guide: "VRT1.be" }]);
    const b = listed(
      "b",
      ["BE | SPORTS"],
      [{ name: "BE | VRT 1", category: 0, guide: "vrt 1 BE" }],
    );
    expect(groupLiveSearch([...a, ...b])).toHaveLength(1);
    const otherGuide = listed(
      "c",
      ["BE | SPORTS"],
      [{ name: "BE | VRT 1", category: 0, guide: "OtherFeed.be" }],
    );
    const unknownGuide = listed("d", ["BE | SPORTS"], [{ name: "BE | VRT 1", category: 0 }]);
    expect(groupLiveSearch([...b, ...unknownGuide, ...otherGuide])).toHaveLength(3);
    const otherCountry = listed(
      "c",
      ["NL | SPORTS"],
      [{ name: "NL | VRT 1", category: 0, guide: "VRT1.be" }],
    );
    expect(groupLiveSearch([...b, ...otherCountry])).toHaveLength(2);
  });

  it("catalogue validation rejects reused guide labels and conflicting category metadata", () => {
    const bad = listed(
      "a",
      ["General", "Sports"],
      [
        { name: "VRT 1", category: 0, guide: "Shared.be" },
        { name: "VRT Canvas", category: 1, guide: "Shared.be" },
      ],
    );
    expect(bad.map((channel) => channel.searchIdentity?.guideId)).toEqual([null, null]);
    const conflict = listed(
      "b",
      ["BE | GENERAL", "NL | GENERAL"],
      [{ name: "VRT 1", category: 0, categories: [0, 1], guide: "VRT1.be" }],
    );
    expect(conflict[0]!.searchIdentity).toBeUndefined();
    expect(groupLiveSearch([...bad, ...conflict])).toHaveLength(3);
  });

  it("agrees on a common category topic without letting a broad category copy bridge different topics", () => {
    const both = listed(
      "a",
      ["BE | VLAANDEREN", "BE | SPORTS"],
      [{ name: "BE | VRT 1", category: 0, categories: [0, 1] }],
    );
    const flemish = listed("b", ["BE | VLAANDEREN"], [{ name: "BE | VRT 1", category: 0 }]);
    const sport = listed("c", ["BE | SPORTS"], [{ name: "BE | VRT 1", category: 0 }]);
    expect(groupLiveSearch([...flemish, ...both])).toHaveLength(1);
    expect(
      groupLiveSearch([...flemish, ...both, ...sport]).map((group) => group.copies.length),
    ).toEqual([2, 1]);
  });

  it("keeps trusted regional guide feeds apart even when their titles and country agree", () => {
    const east = listed(
      "a",
      ["BE | GENERAL"],
      [{ name: "BE | VRT 1 HD", category: 0, guide: "VRT1.be@EastHD" }],
    );
    const west = listed(
      "b",
      ["BE | GENERAL"],
      [{ name: "BE | VRT 1 HD", category: 0, guide: "VRT1.be@WestHD" }],
    );
    expect(groupLiveSearch([...east, ...west])).toHaveLength(2);
  });

  it("programme or quality matches retain other real copies from an index without changing result order", () => {
    const all = [...vrt("blue"), ...vrt("green")];
    const index = indexLiveSearch(all);
    const groups = matchingSearchGroups(index, [all[7]!, all[5]!]);
    expect(groups.map((group) => group.copies[0]!.title)).toEqual(["VRT Canvas", "VRT 1"]);
    expect(groups.map((group) => group.streams)).toEqual([4, 6]);
  });
});
