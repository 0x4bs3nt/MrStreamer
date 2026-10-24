import type { CollectionId, CollectionSort, Title } from "@mrstreamer/contracts/ondemand";
import type { TitleFilters } from "@mrstreamer/contracts/title-filters";
import { collectionSort, type Collections } from "@mrstreamer/core/ondemand/collections";
import { filterOptions, filterTitles, type FilterFiles } from "@mrstreamer/core/ondemand/filters";

/** Collection choices live for this route's session, never in saved preferences. */
export interface BrowseChoices {
  readonly sort?: CollectionSort;
  readonly filters: Pick<TitleFilters, "quality" | "language">;
}

export const DEFAULT_BROWSE: BrowseChoices = { filters: {} };

// iOS has no validated exact-file track-facts owner yet. Core falls back to each listed
// version's declared tags. Provider language labels never become observed audio/subtitles.
const declaredFiles: FilterFiles = new Map();

/** Core owns membership, stable ordering on ties and same-version filter conjunction. */
export function browseCollection(made: Collections, id: CollectionId, choices: BrowseChoices) {
  const titles = made.list(id, choices.sort ?? collectionSort(id));
  // A language filter in 4K must still open a 4K version, as that collection already promises.
  const eligible = (version: Title["versions"][number]) =>
    id !== "4k" || version.tags.some((tag) => tag === "4K" || tag === "UHD");
  const options = filterOptions(
    id === "4k"
      ? titles.map((title) => ({ ...title, versions: title.versions.filter(eligible) }))
      : titles,
    declaredFiles,
  );
  const matching = (filters: BrowseChoices["filters"]) =>
    filterTitles(titles, filters, declaredFiles, eligible);
  return {
    titles: matching(choices.filters),
    total: titles.length,
    sort: choices.sort ?? collectionSort(id),
    qualities: options.qualities.map((value) => ({
      value,
      count: matching({ ...choices.filters, quality: value }).length,
    })),
    languages: options.languages.map((value) => ({
      value,
      count: matching({ ...choices.filters, language: value }).length,
    })),
  };
}

export type BrowsedCollection = ReturnType<typeof browseCollection>;
