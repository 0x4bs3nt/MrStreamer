import type { SettingsSection, SettingsControl } from "../features/settings/catalogue.ts";
import { create } from "zustand";
import type { LiveDiscovery, LiveFilters } from "@mrstreamer/contracts/live-browse";
import type { TitleKind } from "@mrstreamer/contracts/ondemand";
import { ownedId, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import type { WatchlistEntry } from "@mrstreamer/contracts/watchlist";
import { call } from "../lib/ipc.ts";
import { currentPreferences, readPreferences } from "../lib/preferences.ts";
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
type SettingsTab = SettingsSection | "licences";

/**
 * A subscription Settings > Subscriptions opens on, and what of it shows: its details, the form
 * that edits it, or the field that asks for its password or link again.
 */
export interface SubscriptionTarget {
  readonly id: string;
  readonly show: "details" | "edit" | "secret";
}

/** A list of channels the guide and Watch's channel list show, one of the viewer's among them. */
export type ChannelList = (
  LiveDiscovery | { readonly kind: "favourites" } | { readonly kind: "recent" }
) & { readonly filters?: LiveFilters };

/** A movie or series whose details are on screen: one of its versions. */
export interface DetailsTarget extends OwnedId {
  readonly kind: TitleKind;
  /** The opener asked for this version, as the 4K tab does, even if the title shows it first. */
  readonly asked?: boolean;
}

/**
 * Where a title's details stood as a related title opened from them: the season picked there,
 * null for the one being watched, how far the sheet was scrolled, and the related title opened,
 * by its `Title.key`, which Back gives the keyboard back to.
 */
export interface DetailsPlace {
  readonly season: number | null;
  readonly scroll: number;
  readonly related: string;
}

/** Details a related title led away from, with where they stood. */
interface DetailsStep {
  readonly target: DetailsTarget;
  readonly place: DetailsPlace;
}

/**
 * How many details Back returns through. Opening a related title beyond that lets the earliest
 * go: a viewer seldom retraces more, and the trail stays a few small records.
 */
export const DETAILS_TRAIL = 8;

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
  /**
   * The details related titles led away from to these, the latest last, which Back returns
   * through: at most `DETAILS_TRAIL`, for this session only, and none without details.
   */
  readonly trail: readonly DetailsStep[];
  /** Where Back found the details on screen, for them to show as they open, once. */
  readonly place: DetailsPlace | null;
  /**
   * Rises as details open, as a related title opens over them and as Back returns to some: each
   * visit gets a sheet of its own, the same title's again too, so what Back restores applies as
   * that sheet opens, and only then.
   */
  readonly visit: number;
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
  readonly settingsTarget: SettingsControl | null;
  /** Settings opens on Online subtitles, once, rather than at its top. */
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
  trail: [],
  place: null,
  visit: 0,
  savedEntry: null,
  channelsOpen: false,
  searchOpen: false,
  searchFrom: "",
  settings: null,
  subscription: null,
  settingsTarget: null,
  onlineSubtitles: false,
  list: { kind: "all" },
  updateDialog: null,
}));

// Settings over a title holds the countdown to its next episode, so nothing starts behind it.
useUi.subscribe((state) => titlePlayer.holdNext(state.settings !== null));

/**
 * Rises as the viewer goes somewhere: to other details or none, or into Settings, a playing title,
 * Watch or search over them, however each was opened. A Back still waiting for the lists gives
 * way to it (`backDetails`), even when the viewer has come back by the time they answer.
 */
let navigation = 0;
useUi.subscribe((state, previous) => {
  if (
    state.details !== previous.details ||
    state.trail !== previous.trail ||
    (state.settings !== null && previous.settings === null) ||
    (state.playingTitle && !previous.playingTitle) ||
    (state.watching && !previous.watching) ||
    (state.searchOpen && !previous.searchOpen)
  )
    navigation += 1;
});

/** A catalogue accepted meanwhile makes a Back's earlier visibility answer obsolete. */
export function invalidateDetailsCatalogue(): void {
  navigation += 1;
}

/** No details on screen, nor a way back through any. */
const NO_DETAILS = { details: null, trail: [], place: null } as const;

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
    ...NO_DETAILS,
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
    ...NO_DETAILS,
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
  useUi.setState({
    settings: "subtitles",
    settingsTarget: "online-subtitles",
    onlineSubtitles: true,
    searchOpen: false,
  });
}

/** Opens Watch over the current page. */
export function openWatch(): void {
  useUi.setState({ watching: true, searchOpen: false, settings: null });
}

/** Closes Watch, back to the page it opened over. */
export function closeWatch(): void {
  useUi.setState({ watching: false, channelsOpen: false });
}

/**
 * Shows a movie's or series' details over the page, as from a poster, search or a playing title.
 * Back leads from them to the page, as Close does.
 */
export function openDetails(target: DetailsTarget): void {
  useUi.setState(({ visit }) => ({
    details: target,
    trail: [],
    place: null,
    visit: visit + 1,
    savedEntry: null,
    searchOpen: false,
    settings: null,
    watching: false,
  }));
}

/**
 * Shows a related title's details over the details on screen, which Back returns to as they
 * stood (`here`). Past `DETAILS_TRAIL`, the earliest of them goes.
 */
export function openRelated(target: DetailsTarget, here: DetailsPlace): void {
  const { details, trail, visit } = useUi.getState();
  if (!details) return openDetails(target);
  useUi.setState({
    details: target,
    trail: [...trail, { target: details, place: here }].slice(-DETAILS_TRAIL),
    place: null,
    visit: visit + 1,
  });
}

/**
 * Back over details: to the details the ones on screen were opened from as a related title, as
 * they stood, or to the page once there are none. The lists are asked first, as they stand now:
 * details of a title they keep from the viewer, as one they have since marked for adults while
 * Settings hides those, are passed over and forgotten, and never show. Going anywhere meanwhile
 * wins over the answer (`navigation`): another Back, Close, other details, Settings, a playing
 * title or search, also left again before the lists answer, and the way back stays as it was.
 */
export async function backDetails(): Promise<void> {
  for (;;) {
    const mine = ++navigation;
    const { details, trail } = useUi.getState();
    const step = trail.at(-1);
    if (!details || !step) return closeDetails();
    const shown = await stillShown(step.target);
    if (mine !== navigation) return;
    if (!shown) {
      useUi.setState({ trail: trail.slice(0, -1) });
      continue;
    }
    useUi.setState(({ visit }) => ({
      details: step.target,
      trail: trail.slice(0, -1),
      place: step.place,
      visit: visit + 1,
    }));
    return;
  }
}

/**
 * Whether the lists, as they stand now, let `target`'s title show: not when they mark it for
 * adults while Settings hides those. A title they no longer list shows what its details have of
 * it, as before. When the lists or the preferences can't be read, it doesn't show.
 */
async function stillShown(target: DetailsTarget): Promise<boolean> {
  try {
    const [title] = await call("ondemand.titles", {
      kind: target.kind,
      versions: [ownedId(target)],
    });
    if (!title?.adult) return true;
    return (currentPreferences() ?? (await readPreferences())).adultTitles === true;
  } catch {
    return false;
  }
}

/** Closes the details, and the way back through them, to the page they were opened over. */
export function closeDetails(): void {
  useUi.setState(NO_DETAILS);
}

/**
 * What a removed subscription listed leaves the window: details of it close, with the way back
 * through them, Back passes over its titles, and a saved title's sheet goes when it was saved
 * from it.
 */
export function leaveSubscription(id: string): void {
  useUi.setState(({ details, trail, savedEntry }) => ({
    ...(details?.subscriptionId === id
      ? NO_DETAILS
      : { trail: trail.filter((step) => step.target.subscriptionId !== id) }),
    savedEntry: savedEntry?.sources.includes(id) ? null : savedEntry,
  }));
}

/**
 * Closes a title's details, with the way back through them, and a saved title's sheet, as when
 * Settings hides titles for adults: what shows may be one. A title the lists mark for adults only
 * later is passed over by Back (`backDetails`).
 */
export function closeTitleSheets(): void {
  useUi.setState({ ...NO_DETAILS, savedEntry: null });
}

/** Shows a saved title the lists don't have, over the page: what was kept of it, and Remove. */
export function openSavedEntry(entry: WatchlistEntry): void {
  useUi.setState({ savedEntry: entry, ...NO_DETAILS, searchOpen: false, settings: null });
}

/** Whether two lists are the same. */
export function sameList(a: ChannelList, b: ChannelList): boolean {
  return (
    a.kind === b.kind &&
    (a.kind !== "category" || (b.kind === "category" && sameOwned(a.category, b.category))) &&
    (a.kind !== "topic" || (b.kind === "topic" && a.topic === b.topic)) &&
    (a.kind !== "custom" || (b.kind === "custom" && a.id === b.id))
  );
}
