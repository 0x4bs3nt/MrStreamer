import { useEffect, useRef } from "react";
import type { AnalyticsFeature } from "@mrstreamer/contracts/analytics";
import { call } from "../lib/ipc.ts";
import { useUi, withoutTitles } from "./ui-store.ts";

/** Count page changes and closed-to-open overlays. The bridge receives one fixed literal only. */
export function useFeatureEntries(ready: boolean, connect: boolean, liveOnly: boolean): void {
  const view = useUi((state) => state.view);
  const player = useUi((state) => state.watching || state.playingTitle);
  const details = useUi((state) => state.details !== null || state.savedEntry !== null);
  const search = useUi((state) => state.searchOpen);
  const settings = useUi((state) => state.settings !== null);
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
