import { normalizeCatalogue } from "@mrstreamer/core/catalogue/normalize";
import { groupLiveSearch } from "@mrstreamer/core/catalogue/search";
import type { LiveCatalogue } from "@mrstreamer/core/provider";
import { plain, type ProofCase } from "../cases.ts";

/** Category and channel names written the ways providers write them. */
const CATALOGUE: LiveCatalogue = {
  categories: ["NL | NEDERLAND", "BE | VLAANDEREN", "UK | SPORTS", "XXX | ADULT"].map(
    (name, index) => ({ id: String(index), name }),
  ),
  channels: [
    ["NL | NPO 1 FHD", 0],
    ["BE | VRT 1 FHD (VLAANDEREN)", 1],
    ["UK: SKY SPORTS MAIN EVENT HD", 2],
    ["NL | NPO 1 HD", 0],
  ].map(([name, category], index) => ({
    id: `c${index}`,
    name: String(name),
    number: index + 1,
    logoUrl: null,
    categoryIds: [String(category)],
    guideId: null,
    catchupDays: null,
  })),
};

export const cases: readonly ProofCase[] = [
  {
    name: "core: live catalogue names and search groups",
    compare: "same",
    run: () => {
      const normalized = normalizeCatalogue(CATALOGUE);
      return plain({
        categories: normalized.categories.map((c) => [c.group, c.title]),
        streams: normalized.streams.map((s) => [s.title, s.tags]),
        search: groupLiveSearch([]).length,
      });
    },
  },
];
