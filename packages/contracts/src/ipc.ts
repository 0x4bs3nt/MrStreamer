// The typed contract between the UI and the main process.
//
// Add a method by giving it an input schema in `ipcInputs` and a result type in `IpcOutputs`.
// The main process refuses to start unless every method has a handler (see src/main/ipc.ts).
import { type } from "arktype";
import {
  analyticsFeatures,
  analyticsFailures,
  PlaybackControl,
  PlaybackDiagnostic,
} from "./analytics.ts";
import {
  OnlineSubtitlePreferences,
  SubtitleCredentialInput,
  SubtitleTiming,
  type OnlineSubtitleSettings,
  type OnlineSubtitleSearch,
  type OnlineSubtitleChoice,
  type SavedSubtitle,
} from "./online-subtitles.ts";
import { TitleFilters, type FilterOptions } from "./title-filters.ts";
import { LiveBrowseQuery, LiveDiscovery, type LiveBrowseResult } from "./live-browse.ts";
import type { Result } from "./errors.ts";
import type { DiagnosticsPreview } from "./diagnostics.ts";
import type { CopySession, Download, DownloadList } from "./downloads.ts";
import {
  GUIDE_DAY_MS,
  GUIDE_RANGE,
  MAP_FILTERS,
  type GuideChannelPage,
  type GuideSlot,
  type GuideSourceStatus,
  type GuideStatus,
  type Listing,
  type ListingMatch,
  type MapChannel,
  type MapChannelPage,
  type Programme,
  type ProgrammeMatch,
} from "./guide.ts";
import type { CatalogueStatus, Category, LiveChannel, LiveSearchGroups } from "./library.ts";
import type { ThirdPartyNotice } from "./licences.ts";
import {
  COLLECTION_SORTS,
  isCollectionId,
  ROW_TABS,
  TitleRef,
  TITLE_KINDS,
  type CollectionPage,
  type CollectionRow,
  type CollectionTile,
  type EpisodeDetails,
  type OnDemandStatus,
  type RelatedTitles,
  type HomeRecommendation,
  type Title,
  type TitleMatches,
  type TitleDetails,
  type TitleKind,
} from "./ondemand.ts";
import type { OutputStatus, RemoteMedia, RemotePlayingTitle, RemoteTitle } from "./output.ts";
import {
  CODECS,
  type ChannelTracks,
  type LivePlaying,
  type StreamFailure,
  type StreamSession,
  type TitleSession,
} from "./playback.ts";
import { LOCALES, type InterfaceLanguage } from "./language.ts";
import { Preferences, SubscriptionPreferences } from "./preferences.ts";
import type { Reminder, ReminderList } from "./reminders.ts";

import { PlaylistMode, type PlaylistGroupPage, type PlaylistOmissionPage } from "./playlist.ts";
import type { OwnedId, SubscriptionSummary } from "./subscription.ts";
import type { UpdateStatus } from "./updates.ts";
import type { EpisodeMark, SeriesViewing, TitleProgress, Viewing } from "./viewing.ts";
import type { CustomList } from "./custom-lists.ts";
import { WATCHLIST_SORTS, type WatchlistPage } from "./watchlist.ts";

/** Publication metadata is never stored in Preferences or shared with the iOS file schema. */
export interface PreferenceSnapshot {
  readonly revision: number;
  readonly preferences: Preferences;
}

// Every schema is built on its method's first call: defining them all would add to every start,
// and most methods aren't called while the app starts.
const none = () => type("undefined");
const titleKind = () => type.enumerated(...TITLE_KINDS);
const decoders = () => type.enumerated(...CODECS).array();
/** An `OwnedId`: what a provider lists, with the subscription that lists it. */
const owned = () => type({ subscriptionId: "string > 0", id: "string" });
/** A list's or a list channel's id, as the window or the main process made it up. */
const listId = () => type("string").atLeastLength(1).atMostLength(64);
/** Movies, and series whose every episode counts, by the ids of their versions: a `TitleFilter`. */
const titleFilter = () => type({ "movies?": owned().array(), "series?": owned().array() });

/**
 * Login details as typed by the user, with the name to list the subscription under, if any.
 * `server` may also hold a pasted M3U link.
 */
const loginInput = () =>
  type({
    server: "string > 0",
    username: "string",
    password: "string",
    "name?": "string",
  });
export type LoginInput = IpcInput<"subscription.add">;

/** Identifies one guide-search invocation within a renderer view. Main supplies sender/frame. */
const searchRequest = () =>
  type({
    view: type("string").atLeastLength(1).atMostLength(128),
    id: type("string").atLeastLength(1).atMostLength(128),
  });

/** Input schema for every IPC method. The main process validates each call before handling it. */
export const ipcInputs = {
  "subscription.list": none,
  "playlist.groups": () =>
    type({
      subscriptionId: "string > 0",
      query: "string <= 512",
      offset: "number.integer >= 0",
      limit: "0 < number.integer <= 100",
    }),
  "playlist.omissions": () =>
    type({
      subscriptionId: "string > 0",
      offset: "number.integer >= 0",
      limit: "0 < number.integer <= 100",
    }),
  "playlist.map": () =>
    type({ subscriptionId: "string > 0", group: "string <= 512", mode: PlaylistMode() }),
  "subscription.add": loginInput,
  /**
   * Changes what a saved subscription is called, and its password or playlist link when `secret`
   * is given: the one entered again after the keychain lost it, or a new one. `name` null or
   * empty takes the name away.
   */
  "subscription.update": () =>
    type({ subscriptionId: "string > 0", "name?": "string | null", "secret?": "string > 0" }),
  /**
   * Forgets the subscription's login and what was loaded with it. `eraseViewing` also deletes
   * the account's favourites, watchlist, watch history, progress and channels in the viewer's
   * lists, which otherwise stay for when it is added again.
   */
  "subscription.remove": () => type({ subscriptionId: "string > 0", "eraseViewing?": "boolean" }),
  /** Asks the provider for the account's status now: expiry and connections in use. */
  "subscription.recheck": () => type({ subscriptionId: "string > 0" }),
  /** What the viewer left a subscription at: where Live TV opens, and the picks made in it. */
  "subscription.preferences": () => type({ subscriptionId: "string > 0" }),
  "subscription.updatePreferences": () =>
    type({ subscriptionId: "string > 0", patch: SubscriptionPreferences().partial() }),
  "library.browse": LiveBrowseQuery,
  "liveBrowse.get": none,
  "liveBrowse.remember": LiveDiscovery,
  "library.status": none,
  "library.categories": none,
  /** Display-only full-catalogue joins. Unlisted owned channel keys stand alone. */
  "library.searchGroups": none,
  "library.channels": () =>
    type({
      "category?": owned(),
      "query?": "string",
      "channels?": owned().array(),
    }),
  "library.channel": () => type({ channel: owned() }),
  /** Fetches one subscription's channels again. */
  "library.refresh": () => type({ subscriptionId: "string > 0" }),
  "guide.listings": () => type({ channels: owned().array() }),
  /**
   * A channel's programmes over [from, until), at most the longest day (`GUIDE_DAY_MS`), as `GUIDE_SCHEDULE`
   * bounds them: from the start of the viewer's day, aired ones among them for catch-up.
   */
  "guide.schedule": () =>
    type({ channel: owned(), from: "number", until: "number" }).narrow(
      ({ from, until }) => until > from && until - from <= GUIDE_DAY_MS,
    ),
  /**
   * Programmes over a stretch of time, past ones the guide still keeps among them, for a page of
   * a grid's channels: `GUIDE_RANGE.channels` of them and `GUIDE_RANGE.hours` at most, a grid
   * reading one page at a time as it scrolls.
   */
  "guide.range": () =>
    type({
      channels: owned().array().atMostLength(GUIDE_RANGE.channels),
      from: "number",
      to: "number",
    }).narrow(({ from, to }) => to > from && to - from <= GUIDE_RANGE.hours * 60 * 60 * 1000),
  /** One programme of a channel, by a slot's `guide` and `start`: what the slot leaves out. */
  "guide.programme": () => type({ channel: owned(), guide: "string", start: "number" }),
  "guide.search": () => type({ query: "string", "request?": searchRequest() }),
  /** Cancels only this sender frame's named guide-search invocation. */
  "guide.cancelSearch": searchRequest,
  /**
   * Searches the programmes of one list's channels, named as `library.channels` names a list: a
   * category's channels, the given channels, or every channel. `until` ends the day searched, in
   * epoch milliseconds.
   */
  "guide.searchList": () =>
    type({
      query: "string",
      until: "number",
      "request?": searchRequest(),
      "category?": owned(),
      "channels?": owned().array(),
    }),
  "guide.status": none,
  /**
   * Asks a subscription for its guide now and downloads it. Answers with its status, also when
   * the subscription has no guide, which is no failure.
   */
  "guide.refresh": () => type({ subscriptionId: "string > 0" }),
  /** The global XMLTV sources, in the order every subscription reads them after its own guide. */
  "guide.sources": none,
  /**
   * Adds the XMLTV guide at `address` after the other sources, at once, and downloads it in the
   * background. The address can hold a key: it goes to the main process here and never comes
   * back. One already added stays where it is, with its name. `label` names it in the window
   * (`GuideSourceStatus.label`); empty or left out, it has none.
   */
  "guide.addSource": () => type({ address: "string <= 4096", "label?": "string <= 4096" }),
  /** Removes a source, with what it downloaded and the mappings made to it. */
  "guide.removeSource": () => type({ id: "string > 0" }),
  /** Moves a source one place earlier (-1) or later (1) in the order. */
  "guide.moveSource": () => type({ id: "string > 0", by: "-1 | 1" }),
  /** Downloads a source again now. */
  "guide.refreshSource": () => type({ id: "string > 0" }),
  /** Names a source in the window, or takes its name away with null or an empty one. */
  "guide.renameSource": () => type({ id: "string > 0", label: "string <= 4096 | null" }),
  /**
   * Maps one of a subscription's channels to a guide channel by its `GuideChannelRef.ref`, or
   * back to automatic with null. `revision` is the `MapChannelPage.revision` the choice was made
   * from.
   */
  "guide.map": () =>
    type({
      subscriptionId: "string > 0",
      channelId: "string > 0",
      guide: "string > 0 | null",
      revision: "string",
    }),
  /** A page of a subscription's channels, with how each gets its programmes. */
  "guide.mapChannels": () =>
    type({
      subscriptionId: "string > 0",
      filter: type.enumerated(...MAP_FILTERS),
      query: "string",
      offset: "number.integer >= 0",
      limit: "1 <= number.integer <= 200",
    }),
  /**
   * A page of the channels a subscription's guides list, its own and then each source's, to map
   * one of its channels to.
   */
  "guide.mapOptions": () =>
    type({
      subscriptionId: "string > 0",
      query: "string",
      offset: "number.integer >= 0",
      limit: "1 <= number.integer <= 200",
    }),
  "reminders.list": none,
  /**
   * A reminder for the programme the guide lists on the channel at `start`, a time still to
   * come. Main reads its title and end from the guide.
   */
  "reminders.set": () => type({ channel: owned(), start: "number.integer" }),
  /** Takes a reminder out, closing its notice. One that is gone changes nothing. */
  "reminders.cancel": () => type({ id: "string > 0" }),
  /** Takes a reminder's notice in the window down for this run; it stays listed. */
  "reminders.dismiss": () => type({ id: "string > 0" }),
  "ondemand.status": none,
  "ondemand.refresh": () => type({ subscriptionId: "string > 0" }),
  "ondemand.search": () => type({ query: "string" }),
  /** Movies or series only, for the field in their tab bar. */
  "ondemand.searchKind": () =>
    type({ kind: titleKind(), query: "string", "filters?": TitleFilters() }),
  "ondemand.filterOptions": () => type({ kind: titleKind() }),
  /** `like` names a title by one of its versions. */
  "ondemand.rows": () =>
    type({ kind: titleKind(), tab: type.enumerated(...ROW_TABS), "like?": owned() }),
  "ondemand.tiles": () => type({ kind: titleKind(), of: "'genres' | 'services'" }),
  "ondemand.collection": () =>
    type({
      kind: titleKind(),
      id: type("string").narrow(isCollectionId),
      "sort?": type.enumerated(...COLLECTION_SORTS),
      "filters?": TitleFilters(),
      offset: "number.integer >= 0",
      limit: "1 <= number.integer <= 500",
    }),
  /** The details of one version of a movie or series. */
  "ondemand.details": () => type({ kind: titleKind(), version: owned() }),
  "ondemand.related": () => type({ kind: titleKind(), version: owned() }),
  "ondemand.recommendations": () =>
    type({ seeds: type({ kind: titleKind(), version: owned() }).array().atMostLength(32) }),
  /** One season of a series version, by number, asked for when the viewer opens it. */
  "ondemand.season": () => type({ series: owned(), season: "number.integer >= 0" }),
  "ondemand.titles": () => type({ kind: titleKind(), versions: owned().array() }),
  "playback.open": () =>
    type({
      channel: owned(),
      /**
       * The channel's stream to play, by id, instead of the one chosen before or Auto's. Only it
       * is tried.
       */
      "variant?": "string",
      /**
       * Plays this stretch of the channel's past from the provider's catch-up archive instead of
       * the channel live, through the streams that keep it. It fails with `catch-up` when the
       * channel keeps none or not that far back. The stream ends where the provider's does.
       */
      "archive?": type({ start: "number.integer >= 0", end: "number.integer >= 0" }),
      decoders: decoders(),
      "repair?": "boolean",
      /** The chosen sound track id. MPEG-TS uses its PID; HLS selection happens in the engine. */
      "audio?": "number.integer >= 0",
      /** Without `audio`, the sound in this language when the channel has it: "nl". */
      "audioLanguage?": "string",
      /**
       * Nobody chose to watch this: a page's muted preview. Refused while a receiver has
       * playback, whose connection to the provider it would take.
       */
      "preview?": "boolean",
      /** Transient gameplay intent, independent of optional analytics replies. Never captured. */
      "measurement?": PlaybackControl(),
    }),
  "subtitles.settings": none,
  "subtitles.configure": () =>
    type({ preferences: OnlineSubtitlePreferences(), "credentials?": SubtitleCredentialInput() }),
  "subtitles.search": () => type({ sessionId: "string > 0", "languages?": "string[] <= 10" }),
  "subtitles.choose": () => type({ sessionId: "string > 0", resultId: "string > 0" }),
  "subtitles.saved": () => type({ sessionId: "string > 0" }),
  "subtitles.timing": () =>
    type({ sessionId: "string > 0", timing: SubtitleTiming(), "selection?": "0 < string <= 64" }),
  "subtitles.show": () => type({ sessionId: "string > 0", "selection?": "0 < string <= 64" }),
  "subtitles.hide": () => type({ sessionId: "string > 0" }),
  "subtitles.forget": () => type({ sessionId: "string > 0" }),
  "subtitles.cancel": () => type({ sessionId: "string > 0" }),
  "playback.openTitle": () =>
    type({ title: TitleRef(), decoders: decoders(), "measurement?": PlaybackControl() }),
  /** A downloaded copy by its id, from this computer: no subscription or network is asked. */
  "playback.openCopy": () =>
    type({ copy: "string > 0", decoders: decoders(), "measurement?": PlaybackControl() }),
  "playback.close": () => type({ sessionId: "string" }),
  "playback.closeAll": none,
  "playback.failure": () =>
    type({
      sessionId: "string",
      "selector?": { kind: "'hls'", requestId: "string <= 256 | null" },
    }),
  "playback.diagnostic": () => type({ sessionId: "string" }),
  "playback.tracks": () => type({ sessionId: "string" }),
  "playback.playing": () => type({ sessionId: "string" }),
  "output.status": none,
  /** Looks for receivers while `on`, as while the list of them shows. Plays and changes nothing. */
  "output.scan": () => type({ on: "boolean" }),
  /** Connects to a receiver from the status's list. What plays here goes on meanwhile. */
  "output.connect": () => type({ receiverId: "string > 0" }),
  /**
   * Opens the system's own list of receivers at `anchor`, a place in the window in CSS pixels,
   * and answers once the viewer picked one or closed it. `request` is the page's own name for
   * this list, made up for each, which `output.closePicker` takes it down by.
   */
  "output.pick": () =>
    type({
      anchor: type({ x: "number", y: "number", width: "number >= 0", height: "number >= 0" }),
      request: "string > 0",
    }),
  /**
   * Takes down the system's list asked for as `request`, open or still to open, as when the view
   * it was asked from closes. Only that list goes: one asked for since stays, and so does what
   * plays, here or on a receiver.
   */
  "output.closePicker": () => type({ request: "string > 0" }),
  /** Back to this computer: ends what the receiver plays and lets go of it. */
  "output.disconnect": none,
  "output.playChannel": () =>
    type({
      channel: owned(),
      "variant?": "string",
      "audio?": "number.integer >= 0",
      "audioLanguage?": "string",
      /** What the receiver may show about it: the channel's name. */
      name: "string",
      "measurement?": PlaybackControl(),
    }),
  /**
   * `since` is when the viewer began this play of the title, in epoch milliseconds, which its
   * progress is saved with: a play that moves to a receiver, or on to another one, is still the
   * play it was.
   */
  "output.openTitle": () =>
    type({ title: TitleRef(), since: "number", "measurement?": PlaybackControl() }),
  "output.playTitle": () =>
    type({
      sessionId: "string",
      "measurement?": PlaybackControl(),
      /** Seconds into the title to start at. */
      position: "number >= 0",
      audio: "number.integer >= 0 | null",
      subtitle: "number.integer >= 0 | null",
      /** Start held on the first picture. */
      "paused?": "boolean",
      /** What the receiver may show about it: "Escape from New York", "S2 E3 · Its name", a poster. */
      name: "string",
      "detail?": "string | null",
      "artworkUrl?": "string | null",
    }),
  "output.command": () =>
    type({ generation: "number.integer", command: "'play' | 'pause' | 'stop'" })
      .or({ generation: "number.integer", command: "'seek'", position: "number >= 0" })
      .or({ generation: "number.integer", command: "'subtitles'", on: "boolean" }),
  "output.volume": () => type({ "level?": "0 <= number <= 1", "muted?": "boolean" }),
  "output.playingTitle": none,
  "analytics.action": () =>
    type.enumerated("channel_changed", "epg_opened", "search_used", "update_seen"),
  "analytics.playbackBegin": () => type({ kind: "'live' | 'vod'", measurement: PlaybackControl() }),
  "analytics.playbackResume": () =>
    type({ kind: "'live' | 'vod'", measurement: PlaybackControl() }),
  "analytics.playbackBind": () =>
    type({ kind: "'live' | 'vod'", measurement: PlaybackControl(), sessionId: "string" }),
  "analytics.playbackState": () =>
    type({
      token: "string.uuid",
      binding: "string.uuid",
      sequence: "0 <= number.integer <= 1000000000",
      state: "'playing' | 'paused' | 'waiting' | 'seeking' | 'stopped'",
    }),
  "analytics.playbackFailure": () =>
    type({
      token: "string.uuid",
      binding: "string.uuid | null",
      failure: type.enumerated(...analyticsFailures),
      "diagnostic?": PlaybackDiagnostic(),
    }),
  "analytics.playbackEligible": () => type({ token: "string.uuid", eligible: "boolean" }),
  "analytics.playbackEnd": () => type({ token: "string.uuid" }),
  "analytics.feature": () => type.enumerated(...analyticsFeatures),
  "preferences.get": none,
  // Only the preferences' own keys: the interface language changes through `language.set` alone.
  "preferences.update": () => Preferences().partial().onUndeclaredKey("delete"),
  "language.get": none,
  "language.set": () => type({ choice: type.enumerated("system", ...LOCALES) }),
  "viewing.get": none,
  // Each change carries an id the UI makes up, so sending it again changes nothing more.
  "viewing.setFavourite": () =>
    type({ commandId: "string", channel: owned(), favourite: "boolean" }),
  /**
   * Puts the favourites in another order: `original` is the list the order was made from, whole,
   * and `order` the channels arranged. See `FavouriteOrder`.
   */
  "viewing.reorderFavourites": () =>
    type({ commandId: "string", original: owned().array(), order: owned().array() }),
  "viewing.recordWatch": () => type({ commandId: "string", channel: owned() }),
  "viewing.recordProgress": () =>
    type({
      commandId: "string",
      title: TitleRef(),
      position: "number >= 0",
      duration: "number > 0",
      /** When this play of the title began: epoch milliseconds. */
      since: "number",
    }),
  /** Every version played of these movies and series. */
  "viewing.removeFromContinue": () => type({ commandId: "string", titles: titleFilter() }),
  /**
   * Every version of the series. `since` is when the play that watched it to its end began, in
   * epoch milliseconds: one begun before the series was last marked by hand changes nothing.
   */
  "viewing.finishSeries": () =>
    type({ commandId: "string", series: owned().array(), since: "number" }),
  "viewing.progress": titleFilter,
  /** A series by one of its versions: how its episodes stand in that version's subscription. */
  "viewing.episodes": () => type({ series: owned() }),
  /** Marks an episode watched or unwatched. Opens no stream, and leaves what plays as it is. */
  "viewing.markEpisode": () =>
    type({
      commandId: "string",
      episode: {
        kind: "'episode'",
        subscriptionId: "string > 0",
        id: "string > 0",
        seriesId: "string > 0",
        season: "number.integer >= 0",
        episode: "number.integer >= 0",
      },
      watched: "boolean",
    }),
  /** Takes back the mark `revision` names, of the series a version of which is named. */
  "viewing.undoMark": () =>
    type({ commandId: "string", series: owned(), revision: "number.integer > 0" }),
  /** A page of the watchlist every saved subscription's entries make together, in `sort`. */
  "watchlist.list": () =>
    type({
      "home?": "boolean",
      sort: type.enumerated(...WATCHLIST_SORTS),
      offset: "number.integer >= 0",
      limit: "1 <= number.integer <= 500",
    }),
  /** A movie or series by one of its versions: the lists say which title that is. */
  "watchlist.saved": () => type({ kind: titleKind(), version: owned() }),
  "watchlist.save": () => type({ kind: titleKind(), version: owned() }),
  /** A saved entry by its own id, as `WatchlistEntry` names it. */
  "watchlist.remove": () => type({ entry: owned() }),
  "customLists.get": none,
  /**
   * A new list, under an id the window makes up for it: sent again, it answers the list it made.
   * With `channel`, the list holds that channel from the start.
   */
  "customLists.create": () => type({ id: listId(), name: "string", "channel?": owned() }),
  "customLists.rename": () => type({ id: listId(), name: "string" }),
  /** Every list's id, in the order the lists are to show in. */
  "customLists.order": () => type({ order: listId().array() }),
  "customLists.remove": () => type({ id: listId() }),
  /** Puts a channel, by its id or any of its streams', in a list, or takes it out. */
  "customLists.setMember": () => type({ list: listId(), channel: owned(), member: "boolean" }),
  /** Takes a channel out of a list by its member id, as for one its subscription no longer lists. */
  "customLists.removeMember": () => type({ list: listId(), member: listId() }),
  /**
   * Puts the channels `order` names, by member id, in that order where they were in a list, as
   * it showed at `revision`: see `CustomList`.
   */
  "customLists.arrange": () =>
    type({ list: listId(), revision: "number.integer >= 0", order: listId().array() }),
  "downloads.list": none,
  /** A movie or one episode, by the exact version the viewer chose, at the end of the queue. */
  "downloads.add": () => type({ title: TitleRef() }),
  /**
   * Cancels an unfinished download, or deletes a copy from this computer, with what was kept of
   * it: its file, details, artwork, progress and saved subtitles.
   */
  "downloads.remove": () => type({ id: "string > 0" }),
  /** Puts a failed download back in the queue. */
  "downloads.retry": () => type({ id: "string > 0" }),
  /**
   * Pauses an unfinished download that hasn't failed. A transfer stops: its request ends, its
   * partial file stays.
   */
  "downloads.pause": () => type({ id: "string > 0" }),
  /** Lets a paused download take its turn again. */
  "downloads.resume": () => type({ id: "string > 0" }),
  /** Pauses every unfinished download that hasn't failed. */
  "downloads.pauseAll": none,
  /** Resumes every paused download. */
  "downloads.resumeAll": none,
  /**
   * Moves a download waiting its turn, paused or not, one place earlier (-1) or later (1) among
   * those waiting. The transfer under way stays where it is.
   */
  "downloads.move": () => type({ id: "string > 0", by: "-1 | 1" }),
  /** Remembers how far a copy played here, with the copy alone. */
  "downloads.recordProgress": () =>
    type({ id: "string > 0", position: "number >= 0", duration: "number > 0" }),
  "updates.status": none,
  "updates.setChannel": () => type({ channel: "'stable' | 'nightly'" }),
  "updates.check": none,
  "updates.download": none,
  "updates.cancel": none,
  "updates.restart": none,
  "updates.dismiss": () => type({ version: "string" }),
  "updates.openStore": none,
  "updates.rateStore": none,
  "diagnostics.preview": none,
  "diagnostics.save": () => type({ id: "string" }),
  "licences.list": none,
  "licences.text": () => type({ id: "string" }),
  "window.miniPlayerAvailable": none,
  "window.setMiniPlayer": () => type({ on: "boolean" }),
} satisfies Record<keyof IpcOutputs, () => { infer: unknown }>;

/** What each IPC method resolves to when it succeeds. */
export interface IpcOutputs {
  /** Every saved subscription, in the order they were added. */
  "subscription.list": readonly SubscriptionSummary[];
  "playlist.groups": PlaylistGroupPage;
  "playlist.omissions": PlaylistOmissionPage;
  "playlist.map": SubscriptionSummary;
  /**
   * Checks the login with the provider and saves it beside the others. What plays goes on. A
   * login of an account that is saved already gives that subscription its password or link anew.
   */
  "subscription.add": SubscriptionSummary;
  /** A new password or link is checked with the provider before it is saved. */
  "subscription.update": SubscriptionSummary;
  /** What plays from the subscription stops first; the others are left as they are. */
  "subscription.remove": null;
  "subscription.recheck": SubscriptionSummary;
  "subscription.preferences": SubscriptionPreferences;
  "subscription.updatePreferences": SubscriptionPreferences;
  /** Each saved subscription's catalogue, in the subscriptions' order. */
  "library.browse": LiveBrowseResult;
  "liveBrowse.get": LiveDiscovery;
  "liveBrowse.remember": LiveDiscovery;
  "library.status": readonly CatalogueStatus[];
  /** The categories of every subscription, those that show as one joined. */
  "library.categories": readonly Category[];
  /**
   * All channels in a category, the best matches for a query across every catalogue, or the given
   * channels in that order. Without any of them, every channel: each subscription's in its own
   * order, the subscriptions in theirs.
   */
  "library.channels": readonly LiveChannel[];
  "library.searchGroups": LiveSearchGroups;
  "library.channel": LiveChannel;
  "library.refresh": CatalogueStatus;
  /** Now and next per channel, by its `ownedKey`, for the channels the guide covers. */
  "guide.listings": Readonly<Record<string, Listing>>;
  /** The channel's programmes over the stretch asked for, as `GUIDE_SCHEDULE` says, in time order. */
  "guide.schedule": readonly Programme[];
  /**
   * Per channel asked for, by its `ownedKey`, the programmes that overlap the stretch, in time
   * order, without descriptions. Channels without guide data are left out.
   */
  "guide.range": Readonly<Record<string, readonly GuideSlot[]>>;
  /**
   * The programme of the slot's guide channel that starts at `start`, with its description; null
   * when the channel no longer names that guide channel, or it has none starting then, as after
   * the guide was replaced.
   */
  "guide.programme": Programme | null;
  /** Programmes on now or later whose title matches, on now first. */
  "guide.search": readonly ProgrammeMatch[];
  "guide.cancelSearch": null;
  /**
   * Per channel of the list, by its `ownedKey`, whether the programme on now matches and the first
   * later one that does. Every channel of the list is searched, so none is cut off; those without
   * a match are left out.
   */
  "guide.searchList": Readonly<Record<string, ListingMatch>>;
  /** Each saved subscription's guide, in the subscriptions' order. */
  "guide.status": readonly GuideStatus[];
  "guide.refresh": GuideStatus;
  "guide.sources": readonly GuideSourceStatus[];
  /** The source as it was added, its download under way. Fails with `address` for no http(s) one. */
  "guide.addSource": GuideSourceStatus;
  "guide.removeSource": null;
  "guide.moveSource": null;
  /** Once the download is done: the source's status, which says why when it failed. */
  "guide.refreshSource": GuideSourceStatus;
  "guide.renameSource": GuideSourceStatus;
  /** The channel as it is mapped now, or null when the provider no longer lists it. */
  "guide.map": MapChannel | null;
  /**
   * The channels the lists show, in their order: those without programmes, those mapped by hand,
   * with any the provider no longer lists last, or all; cut down to `query` by name or number.
   */
  "guide.mapChannels": MapChannelPage;
  /** Guide channels by name, those `query` finds in a name or an id. No programmes among them. */
  "guide.mapOptions": GuideChannelPage;
  /** Every reminder kept, with how each stands. Fails while they can't be read (`reminder`). */
  "reminders.list": ReminderList;
  /**
   * Stored, as the guide lists its programme now. One already set for that channel at that start
   * answers as it is. Fails with `reminder` when the programme started or isn't in the guide.
   */
  "reminders.set": Reminder;
  "reminders.cancel": null;
  "reminders.dismiss": null;
  "ondemand.status": OnDemandStatus;
  /** Fetches one subscription's movie and series lists again. */
  "ondemand.refresh": OnDemandStatus;
  /** Movies and series whose name matches, best first, without titles for adults. */
  "ondemand.search": { readonly movies: readonly Title[]; readonly series: readonly Title[] };
  "ondemand.searchKind": TitleMatches;
  "ondemand.filterOptions": FilterOptions;
  /** A title's details, asked for when the viewer opens it: the provider's and TMDB's. */
  "ondemand.details": TitleDetails;
  "ondemand.related": RelatedTitles;
  "ondemand.recommendations": readonly HomeRecommendation[];
  /**
   * The season's episodes as the provider lists them, in its order, with TMDB's name, story,
   * still, date, rating and credits where it has them. Asks TMDB about that season alone.
   */
  "ondemand.season": readonly EpisodeDetails[];
  /**
   * Movies or series by any of their versions, from the lists alone, in the order asked; versions
   * the lists don't have are left out. Asks the provider nothing.
   */
  "ondemand.titles": readonly Title[];
  /** A tab's rows; For you starts with titles like `like`, one watched lately. */
  "ondemand.rows": readonly CollectionRow[];
  /** Genres or streaming services as tiles, most stocked first. */
  "ondemand.tiles": readonly CollectionTile[];
  /** One page of a collection. */
  "ondemand.collection": CollectionPage;
  /** Opens a stream for a channel and closes any stream that was open before. */
  "playback.open": StreamSession;
  /** Online subtitle preferences and which services have saved accounts, never the secrets. */
  "subtitles.settings": OnlineSubtitleSettings;
  "subtitles.configure": OnlineSubtitleSettings;
  /** Asks the enabled services for the title a local session plays. Downloads nothing. */
  "subtitles.search": OnlineSubtitleSearch;
  /** Downloads a search result, or reuses its cached copy, and saves it for that exact file. */
  "subtitles.choose": OnlineSubtitleChoice;
  /** What is saved for the session's exact file, read from this computer only. */
  "subtitles.saved": SavedSubtitle | null;
  "subtitles.timing": SavedSubtitle;
  /**
   * The viewer chose a saved result of the session's exact file: the selected one, or a cached one
   * named by its `selection`. It is the file's selected result again and shows when the file opens.
   */
  "subtitles.show": null;
  /** The viewer chose Off or a file track. The selected result keeps its cues and timing, not shown. */
  "subtitles.hide": null;
  "subtitles.forget": null;
  /** Aborts the session's pending search and download. */
  "subtitles.cancel": null;
  /** Opens a movie or episode, and closes any stream that was open before. */
  "playback.openTitle": TitleSession;
  /**
   * Opens a downloaded copy from this computer, and closes what played here before. A receiver
   * plays on: a copy plays here only.
   */
  "playback.openCopy": CopySession;
  "playback.close": null;
  /** Closes every stream, including a title still reading its file before its session is known. */
  "playback.closeAll": null;
  /** Why a session's upstream request failed, or null if it has not failed. */
  "playback.failure": StreamFailure | null;
  "playback.diagnostic": PlaybackDiagnostic | null;
  /** A playing channel's sound and subtitle tracks; null until its stream has started. */
  "playback.tracks": ChannelTracks | null;
  /** Which of a channel's streams its session plays, and those that failed first. */
  "playback.playing": LivePlaying | null;
  /** Where playback goes, and the receivers found. */
  "output.status": OutputStatus;
  "output.scan": null;
  /** Resolves once the receiver takes media, or failed. */
  "output.connect": OutputStatus;
  /** Resolves with a receiver connected, or with nothing changed when the viewer picked none. */
  "output.pick": OutputStatus;
  /** Resolves at once. The list's own `output.pick` answers with the status, and nothing failed. */
  "output.closePicker": null;
  /** Resolves once the receiver is let go of. */
  "output.disconnect": null;
  /** Plays a channel on the receiver in place of what it had, and closes any stream open here. */
  "output.playChannel": RemoteMedia;
  /** Opens a movie or episode for the receiver, and closes any stream open here. Nothing plays yet. */
  "output.openTitle": RemoteTitle;
  /** Plays an opened title on the receiver from a position with these tracks. */
  "output.playTitle": RemoteMedia;
  /** Does nothing when `generation` is no longer what the receiver plays. */
  "output.command": null;
  "output.volume": null;
  /**
   * The title the receiver plays, with what its file holds and the tracks chosen, for a window
   * opened while it plays. Null for a channel, or when it plays nothing.
   */
  "output.playingTitle": RemotePlayingTitle | null;
  "analytics.action": null;
  "analytics.playbackBegin": string | null;
  "analytics.playbackResume": string | null;
  "analytics.playbackBind": string | null;
  "analytics.playbackState": null;
  "analytics.playbackFailure": null;
  "analytics.playbackEligible": null;
  "analytics.playbackEnd": null;
  "analytics.feature": null;
  "preferences.get": PreferenceSnapshot;
  "preferences.update": PreferenceSnapshot;
  /** The interface language in effect, and how it was chosen. */
  "language.get": InterfaceLanguage;
  /**
   * Saves the interface language and shows the app's own text in it at once, menus and dialogs
   * included. Title, sound and subtitle languages stay as they are.
   */
  "language.set": InterfaceLanguage;
  /** Favourites, recently watched channels and Continue watching of every saved subscription. */
  "viewing.get": Viewing;
  /** Adds a channel to the favourites, or takes it out. */
  "viewing.setFavourite": Viewing;
  /**
   * Saves the favourites in a new order, which Home, Live TV and Watch then show. Fails with
   * `favourites-changed`, saving nothing, when they are no longer the list the order was made
   * from. Adds and removes no favourite.
   */
  "viewing.reorderFavourites": Viewing;
  /** Remembers a channel as watched, and as the last one. */
  "viewing.recordWatch": Viewing;
  /** Remembers how far a movie or episode played. */
  "viewing.recordProgress": Viewing;
  /** Takes movies and series out of Continue watching until a play begun afterwards. */
  "viewing.removeFromContinue": Viewing;
  /**
   * Records that a series' last episode was watched: every version played leaves Continue
   * watching, as a removal does, until a play begun afterwards.
   */
  "viewing.finishSeries": Viewing;
  /** How far the given movies, or every episode of a series, got. */
  "viewing.progress": readonly TitleProgress[];
  /**
   * How far the episodes of a series got in one subscription, across the versions it lists, and
   * the episodes marked by hand there. The main process says which versions are the series'.
   */
  "viewing.episodes": SeriesViewing;
  /**
   * Answers once the mark is stored, with the mark as it stands, which Undo names by its
   * revision. Null when it was taken back since, as for a command sent again after its Undo.
   * A failure stores nothing, and the same call can be made again.
   */
  "viewing.markEpisode": EpisodeMark | null;
  /**
   * Puts the episode, and where the series goes on, back as they were before the mark. Fails
   * with `mark-changed`, changing nothing, once the series was marked again, played or taken out
   * of Continue watching since.
   */
  "viewing.undoMark": null;
  /** The saved titles, with what the lists have of each now. Empty without a subscription. */
  "watchlist.list": WatchlistPage;
  /** The entry the movie or series is saved as, whichever of its versions is named, or null. */
  "watchlist.saved": OwnedId | null;
  /**
   * Saves a movie or a whole series for every subscription that lists it now, all at once or
   * not at all, and answers its entry once it is stored. One already saved stays as it was, with
   * the time it was saved then.
   */
  "watchlist.save": OwnedId;
  /**
   * Takes an entry out, with what every subscription saved of it, also one no provider lists
   * any more. One already gone changes nothing.
   */
  "watchlist.remove": null;
  /** The viewer's channel lists, in their order, as the viewer may see them now. */
  "customLists.get": readonly CustomList[];
  /**
   * Answers the lists once the new one is stored. Fails with `list-name-taken` when another is
   * called the same, apart from case and accents, and with `no-list` for an id whose list was
   * deleted since it was made.
   */
  "customLists.create": readonly CustomList[];
  /** Answers the lists once stored. Fails with `no-list` and `list-name-taken`. */
  "customLists.rename": readonly CustomList[];
  /** Fails with `list-changed`, saving nothing, unless it names every list there is, once. */
  "customLists.order": readonly CustomList[];
  /** Deletes a list with every channel it holds. One already gone changes nothing. */
  "customLists.remove": readonly CustomList[];
  /** Adding a channel a list holds, or taking out one it doesn't, changes nothing. */
  "customLists.setMember": readonly CustomList[];
  "customLists.removeMember": readonly CustomList[];
  /**
   * Fails with `list-changed`, saving nothing, when the list changed since `revision`, or
   * doesn't show one of the channels named: the window reads the lists again.
   */
  "customLists.arrange": readonly CustomList[];
  "downloads.list": DownloadList;
  /**
   * Queued, with the title's details and artwork kept on this computer. One already downloaded or
   * in the queue answers as it is.
   */
  "downloads.add": Download;
  "downloads.remove": null;
  "downloads.retry": null;
  /**
   * Once the pause is written down; for a transfer, also once its request ended, its partial file
   * closed and where it stopped is kept. Fails, changing nothing, when the pause can't be written
   * down. A transfer stopped before where it got to could be written down fails too, its pause kept
   * on disk: the list says it failed, with Retry, until the next start.
   */
  "downloads.pause": null;
  "downloads.resume": null;
  "downloads.pauseAll": null;
  "downloads.resumeAll": null;
  /** Once the new order is written down; fails, changing nothing, when it can't be. */
  "downloads.move": null;
  "downloads.recordProgress": null;
  "updates.status": UpdateStatus;
  /** Chooses Stable or Nightly and checks what it offers; installs and removes nothing. */
  "updates.setChannel": UpdateStatus;
  "updates.check": UpdateStatus;
  /** Downloads the update the last check found. Resolves when it is ready or failed. */
  "updates.download": UpdateStatus;
  /** Stops a download in progress. */
  "updates.cancel": null;
  /** Quits and installs the downloaded update. Only after the user confirmed the restart. */
  "updates.restart": null;
  /** Closes the notice for a version; Settings keeps offering it. */
  "updates.dismiss": UpdateStatus;
  /** Opens the app's page in the Microsoft Store, for a copy the Store updates. */
  "updates.openStore": null;
  /** Opens this product's review dialog, only for a copy installed from the Microsoft Store. */
  "updates.rateStore": null;
  /** Builds a bounded local preview. No data is uploaded. */
  "diagnostics.preview": DiagnosticsPreview;
  /** Saves that exact preview after a system Save dialog. False when the viewer cancels. */
  "diagnostics.save": boolean;
  /** Third-party components the app ships, with their licences, by name. */
  "licences.list": readonly ThirdPartyNotice[];
  /** The full notice of one component from `licences.list`, as plain text. */
  "licences.text": string;
  /** Whether the window can float over others as a mini player; Wayland keeps no window on top. */
  "window.miniPlayerAvailable": boolean;
  /**
   * Shrinks the window to a small picture that stays on top of other windows, or puts it back
   * where and as it was. Resolves once the window has moved.
   */
  "window.setMiniPlayer": null;
}

export type IpcMethod = keyof IpcOutputs;
/** An HLS cause belongs only to this opaque local proxy path. Null selects no HTTP cause. */
export type PlaybackFailureSelector = NonNullable<IpcInput<"playback.failure">["selector"]>;

export type IpcInput<M extends IpcMethod> = ReturnType<(typeof ipcInputs)[M]>["infer"];
export type IpcOutput<M extends IpcMethod> = IpcOutputs[M];

/** Methods without input can be called with no argument. */
export type IpcArgs<M extends IpcMethod> =
  undefined extends IpcInput<M> ? [input?: IpcInput<M>] : [input: IpcInput<M>];

/** Events the main process pushes to the UI. */
export interface IpcEvents {
  /** Committed private preferences, ordered within this main-process lifetime only. */
  "preferences.changed": PreferenceSnapshot;
  /** A save could not read back composed state. Keep the last snapshot stale until a read succeeds. */
  "preferences.stale": null;
  "analytics.reset": null;
  /** A subscription's catalogue refresh finished, or failed and kept the previous channels. */
  "library.updated": CatalogueStatus;
  /**
   * A new programme guide is loaded or the one loaded was dropped, a subscription's guide or
   * mappings changed, or a download failed.
   */
  "guide.updated": null;
  /** A reminder was set, cancelled or told, its programme changed, or its notice did. */
  "reminders.changed": null;
  /** The movie and series lists were fetched again, or the fetch failed and kept them. */
  "ondemand.updated": OnDemandStatus;
  /**
   * Only TMDB's progress moved: the lists are as they were, and nothing needs reading again. It
   * carries just that part of the status, so a late one can't bring back lists a newer status
   * dropped.
   */
  "ondemand.progress": OnDemandStatus["metadata"];
  /** TMDB's details of a title version arrived after its details were given without them. */
  "ondemand.detailsChanged": OwnedId & { readonly kind: TitleKind };
  /** The queue or the copies changed, or a transfer moved on: at most a few times a second. */
  "downloads.changed": DownloadList;
  /** Favourites, watched channels, progress or marks changed, up to `sequence`. */
  "viewing.changed": { readonly sequence: number };
  /** A title was saved to the watchlist or taken out of it. */
  "watchlist.changed": null;
  /** A channel list was made, renamed, moved or deleted, or its channels changed. */
  "customLists.changed": null;
  /** The update moved on, for example a download's progress. */
  "updates.changed": UpdateStatus;
  /**
   * The provider answered an open title session with another file than the one it opened. What
   * was saved for the old file is gone, and that session has no saved or online subtitles left.
   */
  "playback.fileReplaced": { readonly sessionId: string };
  /** The source advanced through bytes before the asked position, at most once per 3 s. */
  "playback.readingAhead": { readonly sessionId: string };
  /**
   * An open channel session's `playback.tracks` changed since its stream started: a caption
   * channel was found in its pictures. Read them again to know which.
   */
  "playback.tracksChanged": { readonly sessionId: string };
  /** Where playback goes changed, or what the receiver plays did, or the receivers found. */
  "output.changed": OutputStatus;
  /**
   * Whether the window fills the screen, where the system hides its window controls. Sent when
   * that changes, and once the page loads.
   */
  "window.fullScreen": boolean;
}
export type IpcEvent = keyof IpcEvents;

/** The API the preload script exposes as `window.mrStreamer`. */
export interface BridgeApi {
  invoke<M extends IpcMethod>(method: M, ...args: IpcArgs<M>): Promise<Result<IpcOutput<M>>>;
  on<E extends IpcEvent>(event: E, listener: (payload: IpcEvents[E]) => void): () => void;
}
