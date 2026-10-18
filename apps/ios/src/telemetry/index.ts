import { type } from "arktype";
import type { AnalyticsSettings } from "@mrstreamer/contracts/analytics";
import Constants from "expo-constants";
import { AppState, Platform } from "react-native";
import { readJson, writeJson } from "../files.ts";
import { onPlaybackFailure, playbackClock, playbackState, type Playback } from "../playback.ts";
import { useStore } from "../store.ts";
import { Analytics, type PlaybackView } from "./analytics.ts";
import { IosBuild, type IosAction, type IosFeature } from "./model.ts";
import { analyticsTransport } from "./transport.ts";

// The app's statistics: one owner (analytics.ts), started once at launch, fed fixed
// observations by the app's own state (its activity, the player and the screen on show). The
// viewer's choice is read and changed here; nothing else reaches the owner's identity or events.

let owner: Analytics | null = null;

function analytics(): Analytics {
  owner ??= new Analytics({
    store: {
      load: () => readJson("analytics.json"),
      save: (record) => writeJson("analytics.json", record),
    },
    transport: analyticsTransport({
      development: __DEV__,
      releaseBuild: process.env.EXPO_PUBLIC_MR_STREAMER_ANALYTICS_RELEASE_BUILD,
      host: process.env.EXPO_PUBLIC_MR_STREAMER_ANALYTICS_HOST,
      projectToken: process.env.EXPO_PUBLIC_MR_STREAMER_ANALYTICS_PROJECT_TOKEN,
      localEndpoint: process.env.EXPO_PUBLIC_MR_STREAMER_ANALYTICS_LOCAL_ENDPOINT,
    }),
    build: build(),
    monotonic: () => performance.now(),
    uuid: randomUuid,
  });
  return owner;
}

let started = false;

/** Follows the app's activity and the player from launch. Calling it again changes nothing. */
export function startTelemetry(): void {
  if (started) return;
  started = true;
  const statistics = analytics();
  statistics.setForeground(AppState.currentState === "active");
  AppState.addEventListener("change", (state) => statistics.setForeground(state === "active"));
  onPlaybackFailure((failure) => statistics.notePlaybackFailure(failure));
  let shown = playbackState.get();
  statistics.notePlayback(viewOf(shown));
  playbackState.subscribe(() => {
    const now = playbackState.get();
    // Watch opening from the tabs, not coming back to it from Picture in Picture.
    if (now.watch && !shown.watch && !shown.pip) statistics.noteFeature("player");
    shown = now;
    statistics.notePlayback(viewOf(now));
  });
  playbackClock.subscribe(() => statistics.notePlaybackClock());
}

/** Whether statistics are on, for the Settings control. */
export function useStatistics(): AnalyticsSettings {
  return useStore(analytics().settings);
}

/** The viewer's statistics choice, saved at once. */
export function setStatistics(enabled: boolean): AnalyticsSettings {
  return analytics().configure(enabled);
}

export function noteAction(action: IosAction): void {
  analytics().noteAction(action);
}

let feature: { readonly path: string; readonly feature: IosFeature | null } | null = null;
let searching = false;

/**
 * Navigation reports the screen on show. Another of the app's screens counts once; moving
 * within one doesn't, except details, which count for each title opened. Leaving Search ends
 * its search.
 */
export function onTelemetryScreen(path: string): void {
  const now = featureOf(path);
  if (now !== "search") searching = false;
  const counts =
    now !== null && path !== feature?.path && (now !== feature?.feature || now === "details");
  feature = { path, feature: now };
  if (counts) analytics().noteFeature(now);
}

/**
 * Search's text changed. The first nonempty text counts once, until the text is cleared or the
 * viewer leaves Search. The text itself stays here.
 */
export function onSearchText(text: string): void {
  const typed = text.trim() !== "";
  if (typed && !searching) analytics().noteAction("search_used");
  searching = typed;
}

function featureOf(path: string): IosFeature | null {
  if (path === "/") return "home";
  const [first, second] = path.split("/").slice(1);
  // Downloads and Settings open on whichever tab asked for them: /live/settings is Settings.
  if (second === "settings" || second === "downloads") return second;
  if (second === "provider") return null;
  switch (first) {
    case "live":
      return "live_tv";
    case "films":
    case "series":
      return second === "title" ? "details" : first === "films" ? "movies" : "series";
    case "search":
    case "settings":
    case "downloads":
      return first;
    default:
      return null;
  }
}

function viewOf({ phase, watch, pip, external, muted }: Playback): PlaybackView {
  return {
    run: phase.kind === "idle" ? null : phase.item,
    kind: phase.kind !== "idle" && !phase.item.live ? "vod" : "live",
    playing: phase.kind === "playing",
    watched: watch || pip || external || !muted,
    background: pip || external,
  };
}

/** The build as app.json and the installed binary name it, and iOS's major version. */
function build(): IosBuild {
  const major = Number.parseInt(String(Platform.Version), 10);
  const found = IosBuild()({
    app_version: Constants.expoConfig?.version ?? "unknown",
    app_build: Constants.platform?.ios?.buildNumber ?? "unknown",
    os: "ios",
    ...(Number.isInteger(major) ? { os_major: major } : {}),
  });
  return found instanceof type.errors
    ? { app_version: "unknown", app_build: "unknown", os: "ios" }
    : found;
}

/**
 * A random version 4 UUID. Hermes has no `crypto.randomUUID`; its `Math.random` stands in where
 * `getRandomValues` is missing too. These identify an installation and an event, nothing more.
 */
function randomUuid(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
