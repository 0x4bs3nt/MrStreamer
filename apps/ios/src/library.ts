import type { LiveChannel } from "@mrstreamer/contracts/library";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { isAdultCategory } from "@mrstreamer/core/adult";
import { normalizeCatalogue } from "@mrstreamer/core/catalogue/normalize";
import { liveChannels } from "@mrstreamer/core/catalogue/variants";
import type { LiveCatalogue } from "@mrstreamer/core/provider";
import { matchRanges, searchWords } from "@mrstreamer/core/text";

// The live catalogues of every saved subscription as the app's screens show them, together, by
// the shared rules the desktop app uses: names cleaned, a channel's qualities joined into one
// channel, categories grouped by country. Each subscription's catalogue is worked out on its own;
// then, as the desktop's library combines them, categories that show under the same name in the
// same country are one, holding each subscription's channels in the order the subscriptions were
// added. A channel is never joined across subscriptions: the same channel from two providers is
// two rows, each marked `ambiguous` and named for its subscription. Channels for adults are left
// out, as the desktop app leaves them out until Settings shows them; iOS has no such setting yet.

/** A channel with the subscription it plays from. */
export interface Channel extends LiveChannel {
  /** `ownedKey` of the channel: what lists, the player and recent channels name it by. */
  readonly key: string;
}

/** A category, in its group, with the channels it lists in the providers' order. */
export interface Shelf {
  readonly id: string;
  readonly title: string;
  readonly channels: readonly Channel[];
}

/** A country or region's categories, or a category that stands alone. */
export interface Region {
  readonly name: string;
  readonly shelves: readonly Shelf[];
  /** Each of its categories' channels once, in the providers' order. */
  readonly channels: readonly Channel[];
}

export interface Library {
  readonly regions: readonly Region[];
  /** By channel key, and by the `ownedKey` of each of its streams. */
  readonly byKey: ReadonlyMap<string, Channel>;
  /**
   * Where each channel shows first, by key: "Netherlands · News". A channel another
   * subscription lists under the same name adds its subscription: "Netherlands · News · Home".
   */
  readonly placeOf: ReadonlyMap<string, string>;
}

/** One subscription's live catalogue, with the name lists give it. */
export interface LiveSource {
  readonly subscriptionId: string;
  readonly label: string;
  readonly catalogue: LiveCatalogue;
}

/** One subscription's channels and categories, without those for adults. */
function member({ subscriptionId, catalogue }: LiveSource) {
  const { categories, streams } = normalizeCatalogue(catalogue);
  const adultCategories = new Set(
    catalogue.categories.filter((each) => isAdultCategory(each.name)).map((each) => each.id),
  );
  const adultStreams = new Set(
    catalogue.channels
      .filter((each) => each.adult || each.categoryIds.some((id) => adultCategories.has(id)))
      .map((each) => each.id),
  );
  /** By the provider's channel id and the id of each of its streams. */
  const byId = new Map<string, Channel>();
  const channels: Channel[] = [];
  for (const listed of liveChannels(streams).channels) {
    if (listed.variants.some((variant) => adultStreams.has(variant.id))) continue;
    const channel = { ...listed, subscriptionId, key: ownedKey({ subscriptionId, id: listed.id }) };
    channels.push(channel);
    byId.set(channel.id, channel);
    for (const variant of channel.variants) byId.set(variant.id, channel);
  }
  // A channel shows in each of its streams' categories once, where its first stream there is.
  const inCategory = new Map<string, Channel[]>();
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
  return {
    subscriptionId,
    channels,
    byId,
    categories: categories.flatMap((category) => {
      const listed = inCategory.get(category.id);
      return listed?.length ? [{ ...category, channels: listed }] : [];
    }),
  };
}

export function buildLibrary(sources: readonly LiveSource[]): Library {
  const members = sources.map(member);
  const labels = new Map(sources.map((each) => [each.subscriptionId, each.label]));

  // A name two subscriptions list marks every channel shown under it.
  const listedBy = new Map<string, string | null>();
  for (const { subscriptionId, channels } of members) {
    for (const { title } of channels) {
      const owner = listedBy.get(title);
      if (owner === undefined) listedBy.set(title, subscriptionId);
      else if (owner !== subscriptionId) listedBy.set(title, null);
    }
  }
  const shown = new Map<Channel, Channel>();
  const byKey = new Map<string, Channel>();
  for (const { subscriptionId, channels, byId } of members) {
    for (const channel of channels) {
      shown.set(
        channel,
        listedBy.get(channel.title) === null ? { ...channel, ambiguous: true } : channel,
      );
    }
    for (const [id, channel] of byId) {
      byKey.set(ownedKey({ subscriptionId, id }), shown.get(channel) ?? channel);
    }
  }

  // Categories of several subscriptions under one name in one country are one shelf.
  const regions = new Map<
    string,
    Map<string, { id: string; title: string; channels: Channel[]; keys: Set<string> }>
  >();
  for (const { subscriptionId, categories } of members) {
    for (const category of categories) {
      const name = category.group ?? category.title;
      let shelves = regions.get(name);
      if (!shelves) regions.set(name, (shelves = new Map()));
      const listed = category.channels.map((channel) => shown.get(channel) ?? channel);
      const known = shelves.get(category.title);
      if (!known) {
        shelves.set(category.title, {
          id: ownedKey({ subscriptionId, id: category.id }),
          title: category.title,
          channels: listed,
          keys: new Set(listed.map((channel) => channel.key)),
        });
        continue;
      }
      // A channel may be in several of its provider's categories that show under one name.
      for (const channel of listed) {
        if (known.keys.has(channel.key)) continue;
        known.keys.add(channel.key);
        known.channels.push(channel);
      }
    }
  }

  const placeOf = new Map<string, string>();
  const listed = [...regions].map(([name, joined]): Region => {
    const shelves = [...joined.values()].map(({ id, title, channels }) => ({
      id,
      title,
      channels,
    }));
    const seen = new Set<string>();
    const channels: Channel[] = [];
    for (const shelf of shelves) {
      for (const channel of shelf.channels) {
        if (seen.has(channel.key)) continue;
        seen.add(channel.key);
        channels.push(channel);
        if (placeOf.has(channel.key)) continue;
        const place = shelf.title === name ? name : `${name} · ${shelf.title}`;
        const label = channel.ambiguous ? labels.get(channel.subscriptionId) : undefined;
        placeOf.set(channel.key, label ? `${place} · ${label}` : place);
      }
    }
    return { name, shelves, channels };
  });

  // Channels in no category their provider lists, as a panel that lists no categories leaves
  // every channel, come last on their own, as the desktop's Live shows every channel without a
  // category.
  const others = listed.length > 0 ? "Other channels" : "All channels";
  const unplaced: Channel[] = [];
  for (const { channels } of members) {
    for (const each of channels) {
      const channel = shown.get(each) ?? each;
      if (placeOf.has(channel.key)) continue;
      const label = channel.ambiguous ? labels.get(channel.subscriptionId) : undefined;
      placeOf.set(channel.key, label ? `${others} · ${label}` : others);
      unplaced.push(channel);
    }
  }
  // A region is named once: a provider's own "Other channels" takes them in, so Live's country
  // menu, which goes by name, never holds two of one name.
  const named = listed.findIndex((region) => region.name === others);
  const region = listed[named];
  if (unplaced.length > 0 && region) {
    listed[named] = { ...region, channels: [...region.channels, ...unplaced] };
  } else if (unplaced.length > 0) {
    listed.push({ name: others, shelves: [], channels: unplaced });
  }
  return { regions: listed, byKey, placeOf };
}

/** Channels whose names hold every word of `query`, in the catalogue's order. */
export function searchChannels(library: Library, query: string): readonly Channel[] {
  const words = searchWords(query);
  if (words.length === 0) return [];
  const found = new Set<Channel>();
  for (const region of library.regions) {
    for (const channel of region.channels) {
      if (matchRanges(channel.title, words).length > 0) found.add(channel);
    }
  }
  return [...found];
}
