import type { LiveChannel } from "@mrstreamer/contracts/library";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { isAdultCategory } from "@mrstreamer/core/adult";
import { normalizeSteps } from "@mrstreamer/core/catalogue/normalize";
import { liveChannelSteps } from "@mrstreamer/core/catalogue/variants";
import type { LiveCatalogue } from "@mrstreamer/core/provider";
import { finish, pacer, type Steps } from "@mrstreamer/core/steps";
import { matchRanges, searchWords } from "@mrstreamer/core/text";

// The live catalogues of every saved subscription as the app's screens show them, together, by
// the shared rules the desktop app uses: names cleaned, a channel's qualities joined into one
// channel, categories grouped by country. Each subscription's catalogue is worked out on its own;
// then, as the desktop's library combines them, categories that show under the same name in the
// same country are one, holding each subscription's channels in the order the subscriptions were
// added. A channel is never joined across subscriptions: the same channel from two providers is
// two rows, each marked `ambiguous` and named for its subscription. Channels for adults are left
// out, as the desktop app leaves them out until Settings shows them; iOS has no such setting yet.
//
// Working out one subscription's part took a third of a second with 6,000 channels in a Release
// build on the iOS simulator, so the account owner keeps each part until its catalogue changes and works a new one out in
// short tasks (`inTasks`); joining the parts is `combine`. `buildLibrary` does both at once.

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

/** One subscription's channels and categories, without those for adults: its part of a library. */
export interface Part {
  readonly subscriptionId: string;
  /** In the provider's order. */
  readonly channels: readonly Channel[];
  /** By the provider's channel id and the id of each of its streams. */
  readonly byId: ReadonlyMap<string, Channel>;
  readonly categories: readonly {
    readonly id: string;
    readonly title: string;
    readonly group: string | null;
    readonly channels: readonly Channel[];
  }[];
}

/** Works out a subscription's part, pausing between slices of its channels. */
export function* partSteps({
  subscriptionId,
  catalogue,
}: Pick<LiveSource, "subscriptionId" | "catalogue">): Steps<Part> {
  const due = pacer();
  const { categories, streams } = yield* normalizeSteps(catalogue);
  const adultCategories = new Set(
    catalogue.categories.filter((each) => isAdultCategory(each.name)).map((each) => each.id),
  );
  const adultStreams = new Set(
    catalogue.channels
      .filter((each) => each.adult || each.categoryIds.some((id) => adultCategories.has(id)))
      .map((each) => each.id),
  );
  const byId = new Map<string, Channel>();
  const channels: Channel[] = [];
  for (const listed of (yield* liveChannelSteps(streams)).channels) {
    if (due()) yield;
    if (listed.variants.some((variant) => adultStreams.has(variant.id))) continue;
    const channel = { ...listed, subscriptionId, key: ownedKey({ subscriptionId, id: listed.id }) };
    channels.push(channel);
    byId.set(channel.id, channel);
    // A channel can have thousands of streams.
    for (const variant of channel.variants) {
      if (due()) yield;
      byId.set(variant.id, channel);
    }
  }
  // A channel shows in each of its streams' categories once, where its first stream there is.
  const inCategory = new Map<string, Channel[]>();
  const placed = new Set<string>();
  for (const stream of streams) {
    if (due()) yield;
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

/** Every subscription's channels at once: each part worked out, then joined. */
export function buildLibrary(sources: readonly LiveSource[]): Library {
  return combine(
    sources.map((source) => ({ label: source.label, part: finish(partSteps(source)) })),
  );
}

/** A subscription's part with the name lists give it. */
export interface Labelled {
  readonly label: string;
  readonly part: Part;
}

/** The parts of every subscription whose channels show, in the order they were added, joined. */
export function combine(parts: readonly Labelled[]): Library {
  return finish(combineSteps(parts));
}

/** `combine`, pausing between slices of the channels. */
export function* combineSteps(parts: readonly Labelled[]): Steps<Library> {
  const due = pacer();
  const members = parts.map(({ part }) => part);
  const labels = new Map(parts.map(({ label, part }) => [part.subscriptionId, label]));

  // A name two subscriptions list marks every channel shown under it.
  const listedBy = new Map<string, string | null>();
  for (const { subscriptionId, channels } of members) {
    for (const { title } of channels) {
      if (due()) yield;
      const owner = listedBy.get(title);
      if (owner === undefined) listedBy.set(title, subscriptionId);
      else if (owner !== subscriptionId) listedBy.set(title, null);
    }
  }
  const shown = new Map<Channel, Channel>();
  const byKey = new Map<string, Channel>();
  for (const { subscriptionId, channels, byId } of members) {
    for (const channel of channels) {
      if (due()) yield;
      shown.set(
        channel,
        listedBy.get(channel.title) === null ? { ...channel, ambiguous: true } : channel,
      );
    }
    for (const [id, channel] of byId) {
      if (due()) yield;
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
      if (due()) yield;
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
  const listed: Region[] = [];
  for (const [name, joined] of regions) {
    const shelves = [...joined.values()].map(({ id, title, channels }) => ({
      id,
      title,
      channels,
    }));
    const seen = new Set<string>();
    const channels: Channel[] = [];
    for (const shelf of shelves) {
      for (const channel of shelf.channels) {
        if (due()) yield;
        if (seen.has(channel.key)) continue;
        seen.add(channel.key);
        channels.push(channel);
        if (placeOf.has(channel.key)) continue;
        const place = shelf.title === name ? name : `${name} · ${shelf.title}`;
        const label = channel.ambiguous ? labels.get(channel.subscriptionId) : undefined;
        placeOf.set(channel.key, label ? `${place} · ${label}` : place);
      }
    }
    listed.push({ name, shelves, channels });
  }

  // Channels in no category their provider lists, as a panel that lists no categories leaves
  // every channel, come last on their own, as the desktop's Live shows every channel without a
  // category.
  const others = listed.length > 0 ? "Other channels" : "All channels";
  const unplaced: Channel[] = [];
  for (const { channels } of members) {
    for (const each of channels) {
      if (due()) yield;
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

/** How long one task works through steps before it lets taps through; chosen, not measured. */
const TASK_MS = 8;

/**
 * Works `steps` out a few slices per task, starting in the next one, so the JS thread handles
 * taps and paints between them. Resolves null, leaving them unfinished, once `wanted` fails.
 */
export async function inTasks<A>(steps: Steps<A>, wanted: () => boolean): Promise<A | null> {
  for (;;) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (!wanted()) return null;
    const started = Date.now();
    do {
      const next = steps.next();
      if (next.done) return next.value;
    } while (Date.now() - started < TASK_MS);
  }
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
