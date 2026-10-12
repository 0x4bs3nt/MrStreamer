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

export const SummaryCounts = type({
  features: FeatureCounts,
  playback_open: OperationCounts,
  download_transfer: OperationCounts,
  update_check: OperationCounts,
  renderer: type({ starts: Count, crashed: Count, killed: Count, other: Count }).onUndeclaredKey(
    "delete",
  ),
  saturated: "boolean",
}).onUndeclaredKey("delete");
export type SummaryCounts = typeof SummaryCounts.infer;
export type SummaryOperation = "playback_open" | "download_transfer" | "update_check";
export type SummaryFailure = keyof typeof FailureCounts.infer;
export type SummaryOutcome = "success" | "failed" | "interrupted";

/** Current and newest completed UTC day only; older unsent buckets are deliberately discarded. */
export const SummaryRecord = type({
  day: /^\d{4}-\d{2}-\d{2}$/,
  counts: SummaryCounts,
  properties: BuildProperties,
  ready: type({
    day: /^\d{4}-\d{2}-\d{2}$/,
    counts: SummaryCounts,
    properties: BuildProperties,
  }).or("null"),
  reportedDay: type(/^\d{4}-\d{2}-\d{2}$/).or("null"),
}).onUndeclaredKey("delete");
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
    return { day, properties, counts: emptySummaryCounts(), ready: null, reportedDay: null };
  if (day < kept.day) return kept;
  if (day === kept.day) {
    return sameProperties(kept.properties, properties)
      ? kept
      : { ...kept, properties, counts: emptySummaryCounts() };
  }
  return {
    day,
    properties,
    counts: emptySummaryCounts(),
    ready: { day: kept.day, counts: kept.counts, properties: kept.properties },
    reportedDay: kept.reportedDay,
  };
}

/** Saturation is explicit so dashboards can exclude clipped counts from rate calculations. */
export function incrementSummary(counts: SummaryCounts, value: number): number {
  if (value < 1_000_000) return value + 1;
  counts.saturated = true;
  return value;
}
