import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { hasTitles, ownedKey } from "@mrstreamer/contracts/subscription";
import { ConnectScreen } from "../features/connect/ConnectScreen.tsx";
import { DownloadsPage } from "../features/downloads/DownloadsPage.tsx";
import { HomeScreen } from "../features/home/HomeScreen.tsx";
import { GuidePage } from "../features/live/GuidePage.tsx";
import { SearchPalette } from "../features/search/SearchPalette.tsx";
import { SettingsPage } from "../features/settings/SettingsPage.tsx";
import { TitlesPage } from "../features/titles/TitlesPage.tsx";
import { DetailsView } from "../features/titles/DetailsView.tsx";
import { TitleWatch } from "../features/titles/TitleWatch.tsx";
import { SavedSheet } from "../features/watchlist/SavedSheet.tsx";
import { WatchlistPage } from "../features/watchlist/WatchlistPage.tsx";
import { ReceiverBar, useReceiverBar } from "../features/watch/ReceiverBar.tsx";
import { WatchScreen } from "../features/watch/WatchScreen.tsx";
import { downloadsQuery } from "../lib/downloads.ts";
import { appError, describeError } from "../lib/errors.ts";
import { queries, useLastChannel, useSubscriptionPreferences } from "../lib/queries.ts";
import { cn } from "../lib/utils.ts";
import { outputs, useOutput } from "../player/output.ts";
import { player, usePlayer } from "../player/player.ts";
import { titlePlayer } from "../player/title-player.ts";
import { hasModifier } from "./platform.ts";
import { showReceiverPlayback } from "./receiver-playback.ts";
import { useFeatureEntries } from "./analytics.ts";
import { withoutTitles, useUi, type View } from "./ui-store.ts";

export function App() {
  const subscriptions = useQuery(queries.subscriptions());
  const preferences = useQuery(queries.preferences());
  const updateOffer = !!useQuery(queries.updates()).data?.offer;
  const left = useSubscriptionPreferences();

  // Restore the volume once, before anything plays.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!preferences.data || hydrated.current) return;
    hydrated.current = true;
    player.hydrate(preferences.data);
  }, [preferences.data]);

  // Live TV opens on the category the viewer left it at, once per start with subscriptions:
  // reading their preferences again later changes no list. A category is kept by one of them.
  const restored = useRef(false);
  useEffect(() => {
    if (!left) return;
    if (left.size === 0) {
      restored.current = false;
      return;
    }
    if (restored.current) return;
    restored.current = true;
    for (const [subscriptionId, { lastCategoryId }] of left) {
      if (lastCategoryId === null) continue;
      useUi.setState({
        list: { kind: "category", category: { subscriptionId, id: lastCategoryId } },
      });
      return;
    }
  }, [left]);

  // Connect shows only with no subscription saved. One whose password or link can't be read
  // stays in the lists with what it loaded, and Settings is where it is entered again.
  const connect = subscriptions.isSuccess && subscriptions.data.length === 0;
  useFeatureEntries(
    subscriptions.isSuccess && !preferences.isPending,
    connect,
    subscriptions.isSuccess && !subscriptions.data.some(hasTitles),
    updateOffer,
  );
  // Downloads stand alone without one: Connect opens them, and Add subscription goes back.
  const offline = useUi((state) => state.view === "downloads");
  // The login form replaces everything, and a receiver's controls with it: what it plays ends.
  useEffect(() => {
    if (connect) outputs.stop();
  }, [connect]);
  // A download names the subscription of its account as it is now.
  const client = useQueryClient();
  useEffect(() => {
    void client.invalidateQueries({ queryKey: downloadsQuery().queryKey });
  }, [client, subscriptions.data]);

  if (subscriptions.isPending || preferences.isPending) return null;
  if (subscriptions.isError) {
    return (
      <p className="p-10 text-sm text-destructive">
        {describeError(appError(subscriptions.error))}
      </p>
    );
  }
  if (connect) return offline ? <Offline /> : <ConnectScreen />;
  return <Shell liveOnly={!subscriptions.data.some(hasTitles)} />;
}

/**
 * The page (Home, Live TV, Movies, Series, Watchlist or Downloads), with details, Watch and a playing title
 * opening over it. The page stays laid out underneath, so leaving any of them finds it scrolled
 * where it was, and takes no input meanwhile. Search and settings are available everywhere.
 * Subscriptions with live TV only, unmapped playlists, have no Movies or Series: Home stands in
 * for them. While a receiver on the network is connected, its bar stands at the foot of every
 * page, and the pages end above.
 */
function Shell({ liveOnly }: { liveOnly: boolean }) {
  const view = useUi((state) => (liveOnly && !withoutTitles(state.view) ? "home" : state.view));
  const watching = useUi((state) => state.watching);
  const playingTitle = useUi((state) => state.playingTitle);
  const details = useUi((state) => state.details);
  const savedEntry = useUi((state) => state.savedEntry);
  const settingsOpen = useUi((state) => state.settings !== null);
  const covered = watching || playingTitle;
  useReceiverBar();
  const client = useQueryClient();
  // A receiver that plays as the window opens gets its controls back, unless the pages have gone
  // by the time the lists say what it plays.
  useEffect(() => {
    const leaving = new AbortController();
    void showReceiverPlayback(client, leaving.signal).catch(() => {});
    return () => leaving.abort();
  }, [client]);
  // Watch and a playing title play sound, at the viewer's volume; the page underneath goes back to
  // a muted preview. One place decides, so a channel picked over a playing title, which opens Watch
  // before the title has gone, keeps its sound.
  useEffect(() => player.setAudible(covered), [covered]);
  usePreview(covered, view);
  // The login form replaces everything: nothing may keep playing, or holding the connection,
  // behind it. What a receiver played has ended by now (see App), and is forgotten here.
  useEffect(
    () => () => {
      titlePlayer.close();
      player.makeWay();
    },
    [],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!hasModifier(event)) return;
      if (event.key === "k") useUi.setState((state) => ({ searchOpen: !state.searchOpen }));
      else if (event.key === ",") useUi.setState({ settings: "general", searchOpen: false });
      else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pageActive = !covered && !details && !savedEntry;
  return (
    <>
      <div
        className={cn("h-[calc(100%-var(--receiver-bar,0px))]", covered && "invisible")}
        inert={!pageActive || settingsOpen ? true : undefined}
      >
        {view === "home" ? (
          <HomeScreen active={pageActive} />
        ) : view === "live" ? (
          <GuidePage active={pageActive} />
        ) : view === "watchlist" ? (
          <WatchlistPage active={pageActive} />
        ) : view === "downloads" ? (
          <DownloadsPage />
        ) : (
          // Its own page per kind, so one never shows the other's lists while its own load.
          <TitlesPage
            key={view}
            kind={view === "movies" ? "movie" : "series"}
            active={pageActive}
          />
        )}
      </div>
      {/* Closed under Settings, whose Escape would otherwise reach the sheet's focus first. */}
      {details && !covered && !settingsOpen && (
        <DetailsView key={`${details.kind}:${ownedKey(details)}`} target={details} />
      )}
      {savedEntry && !covered && !settingsOpen && (
        <SavedSheet key={ownedKey(savedEntry)} entry={savedEntry} />
      )}
      {!covered && <ReceiverBar />}
      {watching && <WatchScreen />}
      {playingTitle && <TitleWatch />}
      <SearchPalette />
      <SettingsPage />
    </>
  );
}

/**
 * Downloads with no subscription saved: the page alone, and a copy playing over it. Nothing else
 * plays, so a copy is all the sound there is.
 */
function Offline() {
  const playingTitle = useUi((state) => state.playingTitle);
  useEffect(() => player.setAudible(playingTitle), [playingTitle]);
  useEffect(() => () => titlePlayer.close(), []);
  return (
    <>
      <div className={cn("h-full", playingTitle && "invisible")} inert={playingTitle || undefined}>
        <DownloadsPage standalone />
      </div>
      {playingTitle && <TitleWatch />}
    </>
  );
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/**
 * Pages that show the last channel's muted preview. Movies, Series and the Watchlist show artwork
 * instead.
 */
const PREVIEWS: Record<View, boolean> = {
  home: true,
  live: true,
  movies: false,
  series: false,
  watchlist: false,
  downloads: false,
};

/**
 * Keeps the last channel playing, muted, behind Home and the guide. Movies, Series and the
 * Watchlist stop it, and coming back starts it again, muted. A minimised or hidden window stops
 * a muted preview too, and showing it again starts the preview again. A preview that failed, as
 * when another device holds the connection, stays failed. Watch and a playing title are left
 * alone. Nothing previews while a receiver is connected, which the provider's one connection is
 * for; back here, it starts again.
 */
function usePreview(covered: boolean, view: View): void {
  const visible = useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "visible",
  );
  const playing = usePlayer((state) => state.channel);
  const audible = usePlayer((state) => state.audible);
  const failed = usePlayer((state) => state.phase.kind === "failed");
  const last = useLastChannel();
  const channel = playing ?? last;
  // Channels for adults show only in Live TV, while Settings shows them, so none plays behind
  // Home, nor behind the guide once they are turned off.
  const adults = useQuery(queries.preferences()).data?.adultTitles ?? false;
  const previews = PREVIEWS[view] && !(channel?.adult && (view === "home" || !adults));
  const here = useOutput((state) => state.status.output.kind === "local");
  useEffect(() => {
    if (covered || !here) return;
    if (!previews) {
      player.setAudible(false);
      if (!failed) player.suspend();
      return;
    }
    if (!visible) {
      if (!audible && !failed) player.suspend();
    } else if (channel) player.preview(channel);
  }, [covered, previews, visible, audible, failed, channel, here]);
}
