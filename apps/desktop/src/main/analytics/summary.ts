import { type } from "arktype";
import { BuildProperties, sameProperties } from "./properties.ts";

const Count = type("0 <= number.integer <= 1000000");

const FeatureCounts = type({
  home: Count,
  live_tv: Count,
  movies: Count,
  series: Count,
  watchlist: Count,
  downloads: Count,
  search: Count,
  settings: Count,
  player: Count,
  details: Count,
}).onUndeclaredKey("delete");

const FailureCounts = type({
  network: Count,
  credentials: Count,
  unsupported: Count,
  disk: Count,
  unavailable: Count,
  app: Count,
}).onUndeclaredKey("delete");

const OperationCounts = type({
  started: Count,
  success: Count,
  failed: Count,
  interrupted: Count,
  failures: FailureCounts,
}).onUndeclaredKey("delete");

const LegacyCounts = type({
  features: FeatureCounts,
  playback_open: OperationCounts,
  download_transfer: OperationCounts,
  update_check: OperationCounts,
  renderer: type({ starts: Count, crashed: Count, killed: Count, other: Count }).onUndeclaredKey(
    "delete",
  ),
  saturated: "boolean",
}).onUndeclaredKey("delete");
const PlaybackCounts = type({
  "starts?": Count,
  "errors?": Count,
  "failures?": FailureCounts.partial().onUndeclaredKey("delete"),
  "watch_minutes?": "0 <= number.integer <= 1440",
}).onUndeclaredKey("delete");
const ActionCounts = type({
  "channel_changed?": Count,
  "playlist_added?": Count,
  "playlist_removed?": Count,
  "playlist_refreshed?": Count,
  "epg_opened?": Count,
  "search_used?": Count,
  "favourite_added?": Count,
  "update_seen?": Count,
  "update_dismissed?": Count,
}).onUndeclaredKey("delete");
const SettingCounts = type({
  "interface_language?": Count,
  "audio_language?": Count,
  "subtitle_language?": Count,
  "title_language?": Count,
  "live_quality?": Count,
  "autoplay_next?": Count,
  "subtitle_look?": Count,
  "home_rows?": Count,
  "update_channel?": Count,
}).onUndeclaredKey("delete");
/** Pending envelopes keep legacy absence unchanged under their original event UUID. */
export const WireSummaryCounts = LegacyCounts.merge({
  "playback?": type({ "live?": PlaybackCounts, "vod?": PlaybackCounts }).onUndeclaredKey("delete"),
  "actions?": ActionCounts,
  "settings?": SettingCounts,
}).onUndeclaredKey("delete");
function playbackCounts(kept?: typeof PlaybackCounts.infer) {
  return {
    starts: kept?.starts ?? 0,
    errors: kept?.errors ?? 0,
    watch_minutes: kept?.watch_minutes ?? 0,
    failures: {
      network: kept?.failures?.network ?? 0,
      credentials: kept?.failures?.credentials ?? 0,
      unsupported: kept?.failures?.unsupported ?? 0,
      disk: kept?.failures?.disk ?? 0,
      unavailable: kept?.failures?.unavailable ?? 0,
      app: kept?.failures?.app ?? 0,
    },
  };
}
/** Validate every known old/new count first, then fill missing fixed keys only. */
export const SummaryCounts = WireSummaryCounts.pipe((kept) => ({
  ...kept,
  playback: { live: playbackCounts(kept.playback?.live), vod: playbackCounts(kept.playback?.vod) },
  actions: {
    channel_changed: kept.actions?.channel_changed ?? 0,
    playlist_added: kept.actions?.playlist_added ?? 0,
    playlist_removed: kept.actions?.playlist_removed ?? 0,
    playlist_refreshed: kept.actions?.playlist_refreshed ?? 0,
    epg_opened: kept.actions?.epg_opened ?? 0,
    search_used: kept.actions?.search_used ?? 0,
    favourite_added: kept.actions?.favourite_added ?? 0,
    update_seen: kept.actions?.update_seen ?? 0,
    update_dismissed: kept.actions?.update_dismissed ?? 0,
  },
  settings: {
    interface_language: kept.settings?.interface_language ?? 0,
    audio_language: kept.settings?.audio_language ?? 0,
    subtitle_language: kept.settings?.subtitle_language ?? 0,
    title_language: kept.settings?.title_language ?? 0,
    live_quality: kept.settings?.live_quality ?? 0,
    autoplay_next: kept.settings?.autoplay_next ?? 0,
    subtitle_look: kept.settings?.subtitle_look ?? 0,
    home_rows: kept.settings?.home_rows ?? 0,
    update_channel: kept.settings?.update_channel ?? 0,
  },
}));
export type SummaryCounts = typeof SummaryCounts.infer;
export type SummaryOperation = "playback_open" | "download_transfer" | "update_check";
export type SummaryFailure = keyof typeof FailureCounts.infer;
export type SummaryOutcome = "success" | "failed" | "interrupted";

const WatchMilliseconds = type({
  "live?": "0 <= number <= 86400000",
  "vod?": "0 <= number <= 86400000",
})
  .onUndeclaredKey("delete")
  .narrow((kept) => (kept.live ?? 0) + (kept.vod ?? 0) <= 86_400_000)
  .pipe((kept) => ({ live: kept.live ?? 0, vod: kept.vod ?? 0 }));
const Bucket = type({
  day: /^\d{4}-\d{2}-\d{2}$/,
  counts: SummaryCounts,
  properties: BuildProperties,
  "watch_ms?": WatchMilliseconds,
})
  .onUndeclaredKey("delete")
  .pipe((kept) => ({
    ...kept,
    watch_ms: kept.watch_ms ?? { live: 0, vod: 0 },
  }));

/** Current and newest completed UTC day only; older unsent buckets are deliberately discarded. */
export const SummaryRecord = type({
  day: /^\d{4}-\d{2}-\d{2}$/,
  counts: SummaryCounts,
  properties: BuildProperties,
  "watch_ms?": WatchMilliseconds,
  ready: Bucket.or("null"),
  reportedDay: type(/^\d{4}-\d{2}-\d{2}$/).or("null"),
})
  .onUndeclaredKey("delete")
  .pipe((kept) => ({
    ...kept,
    watch_ms: kept.watch_ms ?? { live: 0, vod: 0 },
  }));
export type SummaryRecord = typeof SummaryRecord.infer;

function operationCounts(): typeof OperationCounts.infer {
  return {
    started: 0,
    success: 0,
    failed: 0,
    interrupted: 0,
    failures: { network: 0, credentials: 0, unsupported: 0, disk: 0, unavailable: 0, app: 0 },
  };
}

export function emptySummaryCounts(): SummaryCounts {
  return {
    features: {
      home: 0,
      live_tv: 0,
      movies: 0,
      series: 0,
      watchlist: 0,
      downloads: 0,
      search: 0,
      settings: 0,
      player: 0,
      details: 0,
    },
    playback_open: operationCounts(),
    download_transfer: operationCounts(),
    update_check: operationCounts(),
    renderer: { starts: 0, crashed: 0, killed: 0, other: 0 },
    playback: { live: playbackCounts(), vod: playbackCounts() },
    actions: {
      channel_changed: 0,
      playlist_added: 0,
      playlist_removed: 0,
      playlist_refreshed: 0,
      epg_opened: 0,
      search_used: 0,
      favourite_added: 0,
      update_seen: 0,
      update_dismissed: 0,
    },
    settings: {
      interface_language: 0,
      audio_language: 0,
      subtitle_language: 0,
      title_language: 0,
      live_quality: 0,
      autoplay_next: 0,
      subtitle_look: 0,
      home_rows: 0,
      update_channel: 0,
    },
    saturated: false,
  };
}

/** Rollback drops notes. A dimension change resets only the current day, never relabels counts. */
export function summaryOnDay(
  kept: SummaryRecord | undefined,
  day: string,
  properties: BuildProperties,
): SummaryRecord {
  if (!kept)
    return {
      day,
      properties,
      counts: emptySummaryCounts(),
      watch_ms: { live: 0, vod: 0 },
      ready: null,
      reportedDay: null,
    };
  if (day < kept.day) return kept;
  if (day === kept.day) {
    return sameProperties(kept.properties, properties)
      ? kept
      : { ...kept, properties, counts: emptySummaryCounts(), watch_ms: { live: 0, vod: 0 } };
  }
  return {
    day,
    properties,
    counts: emptySummaryCounts(),
    watch_ms: { live: 0, vod: 0 },
    ready: {
      day: kept.day,
      counts: completedCounts(kept),
      properties: kept.properties,
      watch_ms: kept.watch_ms,
    },
    reportedDay: kept.reportedDay,
  };
}

/** Saturation is explicit so dashboards can exclude clipped counts from rate calculations. */
export function incrementSummary(counts: SummaryCounts, value: number): number {
  if (value < 1_000_000) return value + 1;
  counts.saturated = true;
  return value;
}

function completedCounts(bucket: SummaryRecord): SummaryCounts {
  const counts = structuredClone(bucket.counts);
  for (const kind of ["live", "vod"] as const)
    counts.playback[kind].watch_minutes = Math.floor((bucket.watch_ms[kind] + 30_000) / 60_000);
  return counts;
}
