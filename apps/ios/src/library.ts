import { isAdultCategory } from "@mrstreamer/core/adult";
import { normalizeCatalogue } from "@mrstreamer/core/catalogue/normalize";
import { liveChannels, type ListedChannel } from "@mrstreamer/core/catalogue/variants";
import type { LiveCatalogue } from "@mrstreamer/core/provider";
import { matchRanges, searchWords } from "@mrstreamer/core/text";

// The live catalogue as the app's screens show it, built by the shared rules the desktop app
// uses: names cleaned, a channel's qualities joined into one channel, categories grouped by
// country. Channels for adults are left out, as the desktop app leaves them out until Settings
// shows them; iOS has no such setting yet.

/** A category, in its group, with the channels it lists in the provider's order. */
export interface Shelf {
  readonly id: string;
  readonly title: string;
  readonly channels: readonly ListedChannel[];
}

/** A country or region's categories, or a category that stands alone. */
export interface Region {
  readonly name: string;
  readonly shelves: readonly Shelf[];
  /** Each of its categories' channels once, in the provider's order. */
  readonly channels: readonly ListedChannel[];
}

export interface Library {
  readonly regions: readonly Region[];
  /** By channel id, and by the id of each of its streams. */
  readonly byId: ReadonlyMap<string, ListedChannel>;
  /** Where each channel shows first: "Netherlands · News". */
  readonly placeOf: ReadonlyMap<string, string>;
}

export function buildLibrary(catalogue: LiveCatalogue): Library {
  const { categories, streams } = normalizeCatalogue(catalogue);
  const adultCategories = new Set(
    catalogue.categories.filter((each) => isAdultCategory(each.name)).map((each) => each.id),
  );
  const adultStreams = new Set(
    catalogue.channels
      .filter((each) => each.adult || each.categoryIds.some((id) => adultCategories.has(id)))
      .map((each) => each.id),
  );
  const byId = new Map<string, ListedChannel>();
  for (const channel of liveChannels(streams).channels) {
    if (channel.variants.some((variant) => adultStreams.has(variant.id))) continue;
    byId.set(channel.id, channel);
    for (const variant of channel.variants) byId.set(variant.id, channel);
  }

  // A channel shows in each of its streams' categories once, where its first stream there is.
  const inCategory = new Map<string, ListedChannel[]>();
  const placed = new Set<string>();
  for (const stream of streams) {
    const channel = byId.get(stream.id);
    if (!channel) continue;
    for (const categoryId of stream.categoryIds) {
      const key = `${categoryId}\n${channel.id}`;
      if (placed.has(key)) continue;
      placed.add(key);
      const listed = inCategory.get(categoryId);
      if (listed) listed.push(channel);
      else inCategory.set(categoryId, [channel]);
    }
  }

  const regions = new Map<string, Shelf[]>();
  for (const category of categories) {
    const channels = inCategory.get(category.id);
    if (!channels?.length) continue;
    const name = category.group ?? category.title;
    const shelf = { id: category.id, title: category.title, channels };
    const shelves = regions.get(name);
    if (shelves) shelves.push(shelf);
    else regions.set(name, [shelf]);
  }

  const placeOf = new Map<string, string>();
  const listed = [...regions].map(([name, shelves]): Region => {
    const seen = new Set<string>();
    const channels: ListedChannel[] = [];
    for (const shelf of shelves) {
      for (const channel of shelf.channels) {
        if (seen.has(channel.id)) continue;
        seen.add(channel.id);
        channels.push(channel);
        if (!placeOf.has(channel.id)) {
          placeOf.set(channel.id, shelf.title === name ? name : `${name} · ${shelf.title}`);
        }
      }
    }
    return { name, shelves, channels };
  });
  return { regions: listed, byId, placeOf };
}

/** Channels whose names hold every word of `query`, in the catalogue's order. */
export function searchChannels(library: Library, query: string): readonly ListedChannel[] {
  const words = searchWords(query);
  if (words.length === 0) return [];
  const found = new Set<ListedChannel>();
  for (const region of library.regions) {
    for (const channel of region.channels) {
      if (matchRanges(channel.title, words).length > 0) found.add(channel);
    }
  }
  return [...found];
}
