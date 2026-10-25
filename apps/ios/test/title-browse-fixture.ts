import { indexCatalogue, kindOf } from "@mrstreamer/core/ondemand/catalogue";
import { collections } from "@mrstreamer/core/ondemand/collections";
import type { TitleKind } from "@mrstreamer/contracts/ondemand";
import type { ProviderTitle } from "@mrstreamer/core/provider";

/** Catalogue declarations only, with no provider or media reader available to filtering. */
export function browseFixture(kind: TitleKind) {
  const row = (id: string, name: string, tmdbId: string, addedAt = 1): ProviderTitle => ({
    id,
    name,
    tmdbId,
    posterUrl: null,
    backdropUrl: null,
    adult: false,
    rating: 8,
    addedAt,
    releaseDate: null,
    categoryIds: [],
    container: kind === "movie" ? "mp4" : null,
  });
  const rows = [
    row("en-hd", "Alpha HD (EN)", "1", 4),
    row("nl-4k", "Alpha 4K (NL)", "1", 3),
    row("en-4k", "Bravo 4K (EN)", "2", 2),
    row("unknown", "Zulu", "3", 1),
    row("tie", "Charlie", "4", 1),
  ];
  const catalogue = {
    movieCategories: [],
    seriesCategories: [],
    movies: kind === "movie" ? rows : [],
    series: kind === "series" ? rows : [],
  };
  const index = indexCatalogue([{ subscriptionId: "a", catalogue }], "en");
  return {
    catalogue,
    index,
    made: collections({
      kind,
      titles: kindOf(index, kind).titles,
      language: "en",
      metadata: () => null,
      names: () => null,
      services: [],
      now: 10,
    }),
  };
}
