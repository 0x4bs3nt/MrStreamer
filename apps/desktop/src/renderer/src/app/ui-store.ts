import { create } from "zustand";
import type { TitleKind } from "@mrstreamer/contracts/ondemand";
import { sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import type { WatchlistEntry } from "@mrstreamer/contracts/watchlist";
import { titlePlayer } from "../player/title-player.ts";

/** The page under everything else. Watch, details and playing a title open over it. */
export type View = "home" | "live" | "movies" | "series" | "watchlist" | "downloads";

/**
 * Whether a page stays when every subscription has live TV only, as playlists do: Home, Live TV,
 * Watchlist, and Downloads, whose copies need no subscription at all.
 */
export function withoutTitles(view: View): boolean {
  return view === "home" || view === "live" || view === "watchlist" || view === "downloads";
}

/** The tabs of the Settings page, and the licences About opens. */
export type SettingsTab = "general" | "home" | "subscriptions" | "about" | "licences";

/**
 * A subscription Settings > Subscriptions opens on, and what of it shows: its details, the form
 * that edits it, or the field that asks for its password or link again.
 */
export interface SubscriptionTarget {
  readonly id: string;
  readonly show: "details" | "edit" | "secret";
}

/** A list of channels the guide and Watch's channel list show. */
export type ChannelList =
  | { readonly kind: "favourites" }
  | { readonly kind: "recent" }
  | { readonly kind: "all" }
  | { readonly kind: "category"; readonly category: OwnedId };

/** A movie or series whose details are on screen: one of its versions. */
export interface DetailsTarget extends OwnedId {
  readonly kind: TitleKind;
  /** The opener asked for this version, as the 4K tab does, even if the title shows it first. */
  readonly asked?: boolean;
}

/** The update dialog on screen: the panel under the top bar's Update, or the restart question. */
type UpdateDialog = "panel" | "restart";

interface UiState {
  /**
   * Rises when the subscriptions start over, with the first one saved or the last one removed,
   * so work started before gives way.
   */
  readonly account: number;
  readonly view: View;
  /** Watch covers the page with a live channel. Closing it returns to the page as it was. */
  readonly watching: boolean;
  /** A movie or episode plays over everything, until the viewer leaves it. */
  readonly playingTitle: boolean;
  /** A movie's or series' details, over the page they were opened from. */
  readonly details: DetailsTarget | null;
  /** A saved title the lists don't have, in its own short sheet over the page. */
  readonly savedEntry: WatchlistEntry | null;
  /** Watch's channel list is open over the picture. */
  readonly channelsOpen: boolean;
  readonly searchOpen: boolean;
  /** What search starts with when it opens: what Movies or Series searches for, while shown. */
  readonly searchFrom: string;
  /** The Settings tab on screen, over the current view; null while Settings is closed. */
  readonly settings: SettingsTab | null;
  /** What Settings > Subscriptions opens on, once; null leaves its list as it is. */
  readonly subscription: SubscriptionTarget | null;
  /** Settings > General opens on Online subtitles, once, rather than at its top. */
  readonly onlineSubtitles: boolean;
  /** The list the guide and Watch's channel list show. */
  readonly list: ChannelList;
  readonly updateDialog: UpdateDialog | null;
}

/** Navigation and overlay state for the window. */
export const useUi = create<UiState>(() => ({
  account: 0,
  view: "home",
  watching: false,
  playingTitle: false,
  details: null,
  savedEntry: null,
  channelsOpen: false,
  searchOpen: false,
  searchFrom: "",
  settings: null,
  subscription: null,
  onlineSubtitles: false,
  list: { kind: "all" },
  updateDialog: null,
}));

// Settings over a title holds the countdown to its next episode, so nothing starts behind it.
useUi.subscribe((state) => titlePlayer.holdNext(state.settings !== null));

/**
 * Leaves the title, saving how far it got, back to its details or the page. One that plays on a
 * receiver plays on there, with its controls a click away at the foot of every page.
 */
export function leaveTitle(): void {
  if (!titlePlayer.onReceiver()) titlePlayer.close();
  useUi.setState({ playingTitle: false });
}

/** Shows a page, closing Watch, details and Settings over it. */
export function openView(view: View): void {
  useUi.setState({
    view,
    watching: false,
    channelsOpen: false,
    settings: null,
    details: null,
    savedEntry: null,
  });
}

/**
 * Home with nothing open over it, for the first subscription or none: a list, details or a title
 * open before belonged to what went. The title closes too, with what it had pending, such as the
 * countdown to its next episode.
 */
export function resetForAccount(): void {
  titlePlayer.close();
  useUi.setState((state) => ({
    account: state.account + 1,
    view: "home",
    watching: false,
    playingTitle: false,
    details: null,
    savedEntry: null,
    channelsOpen: false,
    searchOpen: false,
    list: { kind: "all" },
  }));
}

/**
 * Opens Settings on one subscription's row, as from a message that it needs its password again:
 * what plays underneath goes on, and every other subscription's content stays in the lists.
 */
export function openSubscription(id: string, show: SubscriptionTarget["show"]): void {
  useUi.setState({ settings: "subscriptions", subscription: { id, show }, searchOpen: false });
}

/** Opens Settings on Online subtitles, as from a title's CC panel: the title goes on underneath. */
export function openOnlineSubtitleSettings(): void {
  useUi.setState({ settings: "general", onlineSubtitles: true, searchOpen: false });
}

/** Opens Watch over the current page. */
export function openWatch(): void {
  useUi.setState({ watching: true, searchOpen: false, settings: null });
}

/** Closes Watch, back to the page it opened over. */
export function closeWatch(): void {
  useUi.setState({ watching: false, channelsOpen: false });
}

/** Shows a movie's or series' details over the page. */
export function openDetails(target: DetailsTarget): void {
  useUi.setState({
    details: target,
    savedEntry: null,
    searchOpen: false,
    settings: null,
    watching: false,
  });
}

/** Shows a saved title the lists don't have, over the page: what was kept of it, and Remove. */
export function openSavedEntry(entry: WatchlistEntry): void {
  useUi.setState({ savedEntry: entry, details: null, searchOpen: false, settings: null });
}

/** Whether two lists are the same. */
export function sameList(a: ChannelList, b: ChannelList): boolean {
  return (
    a.kind === b.kind &&
    (a.kind !== "category" || (b.kind === "category" && sameOwned(a.category, b.category)))
  );
}
