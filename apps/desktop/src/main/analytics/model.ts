import { type } from "arktype";
import {
  analyticsActions,
  analyticsFailures,
  analyticsFeatures,
  analyticsSettings,
  PlaybackDiagnostic,
} from "@mrstreamer/contracts/analytics";
import { BuildProperties } from "./properties.ts";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";

export const ProfileOrigin = lazy(() => type("'fresh' | 'upgrading' | 'unknown'"));
export type ProfileOrigin = Infer<typeof ProfileOrigin>;

export { BuildProperties } from "./properties.ts";

/** One playback run can't outlast a month; a longer value is a clock or ownership defect. */
export const WATCH_SECONDS_LIMIT = 31 * 86_400;

const Common = lazy(() =>
  BuildProperties()
    .merge({
      profile_origin: ProfileOrigin(),
      $process_person_profile: "false",
      $geoip_disable: "true",
    })
    .onUndeclaredKey("delete"),
);
type CommonProperties = Infer<typeof Common>;

const StreamType = lazy(() => type("'live' | 'vod'"));
const ErrorType = lazy(() => type.enumerated(...analyticsFailures));
/** A failed outcome alone carries an error type. */
const Outcome = lazy(() =>
  Common()
    .merge({ outcome: "'success' | 'interrupted'" })
    .onUndeclaredKey("delete")
    .or(Common().merge({ outcome: "'failed'", error_type: ErrorType() }).onUndeclaredKey("delete")),
);

/** Every capture: one fixed name with its own fixed property set. Unknown keys are deleted. */
function event<const Name extends string, Properties extends object>(
  name: type.Any<Name>,
  properties: type.Any<Properties>,
) {
  return type({
    uuid: "string.uuid",
    distinct_id: "string.uuid",
    timestamp: "string.date.iso",
    event: name,
    properties,
  }).onUndeclaredKey("delete");
}

const QueuedLegacyEvent = lazy(() =>
  event(type.unit("installation_observed"), Common())
    .or(
      event(
        type.unit("app_active_day"),
        Common()
          .merge({ activity_date: /^\d{4}-\d{2}-\d{2}$/ })
          .onUndeclaredKey("delete"),
      ),
    )
    .or(
      event(
        type.unit("stream_started"),
        Common().merge({ stream_type: StreamType() }).onUndeclaredKey("delete"),
      ),
    )
    .or(
      event(
        type.unit("stream_stopped"),
        Common()
          .merge({
            stream_type: StreamType(),
            watch_duration_seconds: type.number
              .atLeast(0)
              .atMost(WATCH_SECONDS_LIMIT)
              .divisibleBy(1),
          })
          .onUndeclaredKey("delete"),
      ),
    )
    .or(
      event(
        type.unit("stream_error"),
        Common()
          .merge({ stream_type: StreamType(), error_type: ErrorType() })
          .merge(PlaybackDiagnostic())
          .onUndeclaredKey("delete"),
      ),
    )
    .or(event(type.enumerated(...analyticsActions), Common()))
    .or(
      event(
        type.unit("settings_changed"),
        Common()
          .merge({ setting_key: type.enumerated(...analyticsSettings) })
          .onUndeclaredKey("delete"),
      ),
    )
    .or(
      event(
        type.unit("feature_opened"),
        Common()
          .merge({ feature: type.enumerated(...analyticsFeatures) })
          .onUndeclaredKey("delete"),
      ),
    )
    .or(event(type.enumerated("download_ended", "update_check_ended"), Outcome()))
    .or(
      event(
        type.unit("renderer_exited"),
        Common().merge({ reason: "'crashed' | 'killed' | 'other'" }).onUndeclaredKey("delete"),
      ),
    ),
);
type QueuedLegacyEvent = Infer<typeof QueuedLegacyEvent>;

/** Sparse, fixed keys. The renderer never provides a counter map. */
export const usageKeys = [
  ...analyticsActions.map((key) => `action_${key}` as const),
  ...analyticsFeatures.map((key) => `feature_${key}` as const),
  ...analyticsSettings.map((key) => `setting_${key}` as const),
];
export type UsageKey = (typeof usageKeys)[number];
export const WINDOW_MS = 5 * 60_000;
export const SUMMARY_TTL_MS = 7 * 86_400_000;
export const OUTBOX_BYTES = 128 * 1024;
const Counters = lazy(() =>
  type({
    "[string]": "number.integer >= 1",
  }).narrow((counts) =>
    Object.entries(counts).every(
      ([key, count]) => usageKeys.some((allowed) => key === allowed) && Number.isSafeInteger(count),
    ),
  ),
);

const UsageEvent = lazy(() =>
  event(
    type.unit("usage_window"),
    Common()
      .merge({
        window_start: "string.date.iso",
        window_end: "string.date.iso",
        counts: Counters(),
      })
      .onUndeclaredKey("delete"),
  ),
);
const StreamSummary = lazy(() =>
  event(
    type.unit("stream_summary"),
    Common()
      .merge({
        stream_type: StreamType(),
        started_at: "string.date.iso",
        started_update_channel: "'stable' | 'nightly' | 'none'",
        watch_duration_seconds: type.number.atLeast(0).atMost(WATCH_SECONDS_LIMIT).divisibleBy(1),
        end_reason: "'ended' | 'interrupted'",
      })
      .onUndeclaredKey("delete"),
  ),
);
export type StreamSummary = Infer<typeof StreamSummary>;
export const SummaryEvent = lazy(() => UsageEvent().or(StreamSummary()));
export type SummaryEvent = Infer<typeof SummaryEvent>;

export const SummaryBlock = lazy(() =>
  type({
    version: "1",
    installationId: "string.uuid",
    pending: type({
      event: SummaryEvent(),
      attempts: "0 <= number.integer <= 3",
      failures: "0 <= number.integer <= 2147483647",
      nextAttemptAt: "string.date.iso",
    })
      .onUndeclaredKey("delete")
      .array()
      .atMostLength(OUTBOX_LIMIT),
    usage: UsageEvent().or("null"),
    unfinished: type({
      event: StreamSummary().narrow((event) => event.properties.end_reason === "interrupted"),
      watchMs: type.number.atLeast(0).atMost(WATCH_SECONDS_LIMIT * 1000),
    })
      .onUndeclaredKey("delete")
      .or("null"),
  }).onUndeclaredKey("delete"),
);
export type SummaryBlock = Infer<typeof SummaryBlock>;

/** Foreground observations, independent of the once-per-day activity ledger. */
const VersionIdentity = lazy(() => BuildProperties().pick("app_version", "build_channel"));
const VersionObservation = lazy(() =>
  event(
    type.unit("app_version_observed"),
    Common()
      .merge({ observation_kind: "'new_profile' | 'unknown_history'" })
      .onUndeclaredKey("delete")
      .or(
        Common()
          .merge({
            observation_kind: "'transition'",
            previous_app_version: VersionIdentity()
              .get("app_version")
              .narrow((version) => version !== "unknown"),
            previous_build_channel: VersionIdentity().get("build_channel"),
          })
          .onUndeclaredKey("delete"),
      ),
  ),
);
export type VersionObservation = Infer<typeof VersionObservation>;

/** Additive state. Legacy pending keeps only names understood by the .15 loader. */
export const LifecycleBlock = lazy(() =>
  type({
    version: "1",
    installationId: "string.uuid",
    baseline: VersionIdentity().or("null"),
    pending: type({
      event: VersionObservation(),
      attempts: "0 <= number.integer <= 3",
      failures: "0 <= number.integer <= 2147483647",
      nextAttemptAt: "string.date.iso",
    })
      .onUndeclaredKey("delete")
      .array()
      .atMostLength(OUTBOX_LIMIT),
    legacyRetries: type({
      uuid: "string.uuid",
      failures: "0 <= number.integer <= 2147483647",
      nextAttemptAt: "string.date.iso",
    })
      .onUndeclaredKey("delete")
      .array()
      .atMostLength(OUTBOX_LIMIT),
  }).onUndeclaredKey("delete"),
);
export type LifecycleBlock = Infer<typeof LifecycleBlock>;

/** Complete load/send union, including retired .15 producers. */
export const CaptureEvent = lazy(() =>
  QueuedLegacyEvent().or(SummaryEvent()).or(VersionObservation()),
);
export type CaptureEvent = Infer<typeof CaptureEvent>;
export type CaptureName = CaptureEvent["event"];

/** The capture a name selects. One schema can serve several names, so this isn't `Extract`. */
export type CaptureOf<Name extends CaptureName> = CaptureEvent & { event: Name };

/** An event's own properties, by name, before the common build dimensions are added. */
export type EventProperties<Name extends CaptureName> =
  CaptureOf<Name>["properties"] extends infer Properties
    ? Properties extends unknown
      ? Omit<Properties, keyof CommonProperties>
      : never
    : never;

/** Bounded so a long offline period or a runaway producer can't grow the file. */
export const OUTBOX_LIMIT = 64;

export const LegacyRecord = lazy(() =>
  type({
    format: "2",
    enabled: "boolean",
    installationId: "string.uuid | null",
    profileOrigin: ProfileOrigin(),
    firstSeen: "boolean",
    lastDay: type(/^\d{4}-\d{2}-\d{2}$/).or("null"),
    pending: type({ event: QueuedLegacyEvent(), attempts: "0 <= number.integer <= 3" })
      .onUndeclaredKey("delete")
      .array()
      .atMostLength(OUTBOX_LIMIT),
  }).onUndeclaredKey("delete"),
);
export const AnalyticsRecord = lazy(() =>
  LegacyRecord().merge({ "summaries?": SummaryBlock(), "lifecycle?": LifecycleBlock() }),
);
export type AnalyticsRecord = Infer<typeof AnalyticsRecord>;
export type DirectName = Exclude<
  QueuedLegacyEvent["event"],
  | (typeof analyticsActions)[number]
  | "stream_started"
  | "stream_stopped"
  | "feature_opened"
  | "settings_changed"
>;
