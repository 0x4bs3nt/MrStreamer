import type { CollectionId, CollectionSort, Title } from "@mrstreamer/contracts/ondemand";
import type { TitleFilters } from "@mrstreamer/contracts/title-filters";
import { collectionSort, type Collections } from "@mrstreamer/core/ondemand/collections";
import { filterOptions, filterTitles, type FilterFiles } from "@mrstreamer/core/ondemand/filters";

/** Collection choices live for this route's session, never in saved preferences. */
export interface BrowseChoices {
  readonly sort?: CollectionSort;
  readonly filters: TitleFilters;
}

export const DEFAULT_BROWSE: BrowseChoices = { filters: {} };

// Without file facts, core falls back to each listed version's declared tags. Provider language
// labels never become observed audio/subtitles: only the tracks playback found in a file do
// (titles.ts `filterFilesOf`), and core counts them for the one file they were found in.
const declaredFiles: FilterFiles = new Map();

/**
 * Core owns membership, stable ordering on ties and same-version filter conjunction. `files` are
 * the facts playback found in listed files, by version; without them only declared hints count.
 */
export function browseCollection(
  made: Collections,
  id: CollectionId,
  choices: BrowseChoices,
  files: FilterFiles = declaredFiles,
) {
  const titles = made.list(id, choices.sort ?? collectionSort(id));
  // A language filter in 4K must still open a 4K version, as that collection already promises.
  const eligible = (version: Title["versions"][number]) =>
    id !== "4k" || version.tags.some((tag) => tag === "4K" || tag === "UHD");
  const options = filterOptions(
    id === "4k"
      ? titles.map((title) => ({ ...title, versions: title.versions.filter(eligible) }))
      : titles,
    files,
  );
  const matching = (filters: BrowseChoices["filters"]) =>
    filterTitles(titles, filters, files, eligible);
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
    /** Languages of tracks found in a file, with how many titles have one that matches. */
    verified: options.verified.map((value) => ({
      value,
      count: matching({ ...choices.filters, verified: value }).length,
    })),
    /** Listed files whose tracks were found, not titles or episodes. */
    files: options.files,
  };
}

export type BrowsedCollection = ReturnType<typeof browseCollection>;
