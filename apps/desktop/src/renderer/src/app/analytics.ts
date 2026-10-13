import { useEffect, useRef } from "react";
import type { AnalyticsFeature } from "@mrstreamer/contracts/analytics";
import { call } from "../lib/ipc.ts";
import { useUi, withoutTitles } from "./ui-store.ts";

/** Count page changes and closed-to-open overlays. The bridge receives one fixed literal only. */
export function useFeatureEntries(
  ready: boolean,
  connect: boolean,
  liveOnly: boolean,
  offeredUpdate = false,
): void {
  const view = useUi((state) => state.view);
  const player = useUi((state) => state.watching || state.playingTitle);
  const details = useUi((state) => state.details !== null || state.savedEntry !== null);
  const search = useUi((state) => state.searchOpen);
  const settings = useUi((state) => state.settings !== null);
  const updatePanel = useUi((state) => state.updateDialog === "panel");
  const priorPanel = useRef(false);
  useEffect(() => {
    if (ready && updatePanel && offeredUpdate && !priorPanel.current)
      void call("analytics.action", "update_seen").catch(() => {});
    priorPanel.current = updatePanel && offeredUpdate;
  }, [ready, updatePanel, offeredUpdate]);
  useEffect(() => {
    if (!search) searchEpisodes.global = false;
    if (view !== "live" || player || details || settings || search) searchEpisodes.live = false;
    if (view !== "movies" || player || details || settings || search) searchEpisodes.movies = false;
    if (view !== "series" || player || details || settings || search) searchEpisodes.series = false;
  }, [view, player, details, search, settings]);
  const previous = useRef<Set<AnalyticsFeature>>(new Set());
  useEffect(() => {
    const active = new Set<AnalyticsFeature>();
    if (ready) {
      if (!connect || view === "downloads") {
        const page = liveOnly && !withoutTitles(view) ? "home" : view;
        active.add(page === "live" ? "live_tv" : page);
        if (player) active.add("player");
        if (!connect) {
          if (details && !player) active.add("details");
          if (search) active.add("search");
          if (settings) active.add("settings");
        }
      }
    }
    for (const feature of active) {
      if (!previous.current.has(feature)) void call("analytics.feature", feature).catch(() => {});
    }
    previous.current = active;
  }, [ready, connect, liveOnly, view, player, details, search, settings]);
}

const searchEpisodes = { global: false, live: false, movies: false, series: false };
/** The query remains in this renderer. Only an episode's first nonempty search sends a literal. */
export function useSearchUsage(
  surface: keyof typeof searchEpisodes,
  query: string,
  active: boolean,
): void {
  const visible = useUi(
    (state) =>
      !state.settings &&
      !state.updateDialog &&
      (surface === "global" ? state.searchOpen : !state.searchOpen),
  );
  useEffect(() => {
    if (!active || !visible || query.trim() === "") {
      searchEpisodes[surface] = false;
      return;
    }
    if (!searchEpisodes[surface]) {
      searchEpisodes[surface] = true;
      void call("analytics.action", "search_used").catch(() => {});
    }
  }, [surface, query, active, visible]);
}
