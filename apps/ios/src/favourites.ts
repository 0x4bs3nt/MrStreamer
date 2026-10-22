import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import type { Viewing } from "@mrstreamer/contracts/viewing";
import { useMemo } from "react";
import { Alert } from "react-native";
import {
  currentCatalogue,
  members,
  useCatalogue,
  useRoster,
  type Catalogue,
  type Member,
} from "./account.ts";
import { appError, describeError } from "./errors.ts";
import type { Channel } from "./library.ts";
import { currentViewing, setFavourite, useViewing } from "./viewing.ts";

// The favourites as Live, Home and Watch show them: the viewing record's favourites
// (viewing.ts), every provider's in one order, read by the channels Live shows now. A favourite
// opens only as a channel its own provider lists now and while that provider signs in: one of a
// provider that needs its password, whose lists haven't come or no longer list it, isn't made
// into a row, and is counted by provider with why. It keeps its place in the record, and a new
// order moves only the rows around it (`FavouriteOrder`), and only while those rows still show
// as they did (`sameFavourites`). A star changes the record alone: nothing plays, stops or starts
// again. It stars the channel its own provider lists now under the streams of the one pressed,
// so a list that changed since, as behind Try again, stars no stream that is gone.

/** A favourite that opens: its channel now, and the entry of the record it shows. */
export interface Favourite {
  readonly channel: Channel;
  /** As the record names it, which an order sends back. */
  readonly saved: OwnedId;
}

/** Why a provider's favourites don't show. */
export type Unavailable =
  /** Its channels haven't come yet. */
  | "loading"
  /** Its channels didn't load, and none of them showed before. */
  | "failed"
  /** It needs its password again. */
  | "needs-secret"
  /** Its channels show, and don't list these. */
  | "not-listed";

/** One provider's favourites that don't show, and why. */
export interface Hidden {
  readonly subscriptionId: string;
  readonly label: string;
  readonly why: Unavailable;
  /**
   * How many channels they are, when each is one the lists show. A saved stream no list shows
   * can be one of several of a channel, or of one still shown, so then it says none.
   */
  readonly count: number | null;
}

export interface FavouriteList {
  /** Every favourite as the record gives them, in order: what a new order is made from. */
  readonly original: readonly OwnedId[];
  /** Those that open, in order. */
  readonly shown: readonly Favourite[];
  /** The rest, by provider, in the providers' order. */
  readonly hidden: readonly Hidden[];
}

/**
 * The favourites of `viewing`, by the channels `catalogue` shows and how `members` stand. Null
 * while the record hasn't been read.
 */
export function favouriteList(
  viewing: Viewing | null,
  catalogue: Catalogue,
  members: readonly Member[],
): FavouriteList | null {
  if (!viewing) return null;
  const library = catalogue.kind === "ready" ? catalogue.library : null;
  const byId = new Map(members.map((member) => [member.entry.id, member]));
  const shown: Favourite[] = [];
  const seen = new Set<string>();
  const hidden = new Map<string, { why: Unavailable; channels: Set<string>; streams: boolean }>();
  for (const saved of viewing.favourites) {
    const { subscriptionId } = saved;
    const member = byId.get(subscriptionId);
    // The record names only saved subscriptions; one the roster dropped meanwhile shows nothing.
    if (!member) continue;
    const channel = library?.byKey.get(ownedKey(saved));
    if (channel && !member.needsSecret) {
      // The record read by older channels can name one channel twice for a moment.
      if (seen.has(channel.key)) continue;
      seen.add(channel.key);
      shown.push({ channel, saved });
      continue;
    }
    // Its channels show: the library has its part, a reload or failure keeping the last.
    const listed = library?.labels.has(subscriptionId) ?? false;
    const why: Unavailable = member.needsSecret
      ? "needs-secret"
      : listed
        ? "not-listed"
        : member.live.kind === "failed"
          ? "failed"
          : "loading";
    const known = hidden.get(subscriptionId) ?? { why, channels: new Set(), streams: false };
    if (channel) known.channels.add(channel.key);
    else known.streams = true;
    hidden.set(subscriptionId, known);
  }
  return {
    original: viewing.favourites,
    shown,
    hidden: members.flatMap(({ entry, label }) => {
      const found = hidden.get(entry.id);
      if (!found) return [];
      const count = found.streams ? null : found.channels.size;
      return [{ subscriptionId: entry.id, label, why: found.why, count }];
    }),
  };
}

/** The favourites as they stand, drawn again as the record, the channels or a provider changes. */
export function useFavourites(): FavouriteList | null {
  const viewing = useViewing();
  const catalogue = useCatalogue();
  const roster = useRoster();
  return useMemo(
    () => favouriteList(viewing, catalogue, roster.kind === "ready" ? roster.members : []),
    [viewing, catalogue, roster],
  );
}

/**
 * The keys of the channels that are favourites, as Live's rows and Watch's star read them. A
 * channel of a provider that needs its password is still one: its star takes it out.
 */
export function useFavouriteKeys(): ReadonlySet<string> {
  const viewing = useViewing();
  const catalogue = useCatalogue();
  return useMemo(() => {
    const library = catalogue.kind === "ready" ? catalogue.library : null;
    return new Set(
      (viewing?.favourites ?? []).flatMap((saved) => {
        const channel = library?.byKey.get(ownedKey(saved));
        return channel ? [channel.key] : [];
      }),
    );
  }, [viewing, catalogue]);
}

/** The favourites as they stand now, for handlers outside React. */
export function currentFavourites(): FavouriteList | null {
  return favouriteList(currentViewing(), currentCatalogue(), members());
}

/**
 * Whether `now` shows the favourites `then` did: the same record, and the same rows from it. A
 * row that went, or came, since, as when a list changes or a provider needs its password, makes
 * an order arranged from `then` one for other rows.
 */
export function sameFavourites(
  then: Pick<FavouriteList, "original" | "shown">,
  now: FavouriteList | null,
): boolean {
  const records = (list: readonly OwnedId[]) => list.map(ownedKey).join("\n");
  const rows = (list: readonly Favourite[]) =>
    list.map(({ channel, saved }) => `${channel.key} ${ownedKey(saved)}`).join("\n");
  return (
    now !== null &&
    records(now.original) === records(then.original) &&
    rows(now.shown) === rows(then.shown)
  );
}

/** A channel pressed a moment ago, as Live lists it now. */
export type Listed =
  | { readonly kind: "listed"; readonly channel: Channel }
  /** Its provider lists none of its streams. */
  | { readonly kind: "gone" }
  /** Its streams are in more than one channel now. */
  | { readonly kind: "split" }
  /** Its provider is no longer saved. */
  | { readonly kind: "removed" };

/**
 * The one channel `channel`'s own provider lists now under any of the streams it had: itself, or
 * what its streams make now. Never another provider's, and never by name.
 */
export function listedNow(
  channel: Channel,
  catalogue: Catalogue,
  saved: readonly Member[],
): Listed {
  const { subscriptionId } = channel;
  if (!saved.some((member) => member.entry.id === subscriptionId)) return { kind: "removed" };
  const library = catalogue.kind === "ready" ? catalogue.library : null;
  const found = new Map<string, Channel>();
  for (const id of new Set([channel.id, ...channel.variants.map((variant) => variant.id)])) {
    const now = library?.byKey.get(ownedKey({ subscriptionId, id }));
    if (now) found.set(now.key, now);
  }
  const [only, ...more] = found.values();
  if (!only) return { kind: "gone" };
  return more.length > 0 ? { kind: "split" } : { kind: "listed", channel: only };
}

/** Why a star changed nothing, when its channel isn't one channel Live lists now. */
const UNLISTED: Record<Exclude<Listed["kind"], "listed">, string> = {
  gone: "Its provider no longer lists it. Nothing was changed.",
  split:
    "Its provider lists it as more than one channel now. Nothing was changed: star the one you want.",
  removed: "Its provider was removed. Nothing was changed.",
};

/**
 * Stars or unstars `channel`, playing nothing, as the channel Live lists now for it, at the press
 * and at each Try again. Says so, changing nothing, when that is no one channel any more, and
 * when viewing.json won't take the change.
 */
export function starChannel(channel: Channel, favourite: boolean) {
  const title = favourite ? `Couldn't add ${channel.title}` : `Couldn't remove ${channel.title}`;
  const now = listedNow(channel, currentCatalogue(), members());
  if (now.kind !== "listed") return Alert.alert(title, UNLISTED[now.kind]);
  setFavourite(now.channel, favourite).catch((cause: unknown) =>
    Alert.alert(title, describeError(appError(cause)), [
      { text: "Cancel", style: "cancel" },
      { text: "Try again", onPress: () => starChannel(channel, favourite) },
    ]),
  );
}
