import { type } from "arktype";
import {
  analyticsFailures,
  type AnalyticsAction,
  type AnalyticsFeature,
} from "@mrstreamer/contracts/analytics";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";

// The iOS app's product events: the desktop's event names, properties and literals
// (docs/telemetry.md) wherever the iOS app has the same observation, under its own build
// dimensions. Nothing here names a device, a person, a provider or anything played.

/** The desktop's actions the iOS app can observe. Its other actions have no iOS feature yet. */
export const iosActions = [
  "search_used",
  "channel_changed",
  "playlist_added",
  "playlist_removed",
  "playlist_refreshed",
] as const satisfies readonly AnalyticsAction[];
export type IosAction = (typeof iosActions)[number];

/** The desktop's screens the iOS app has. It has no Watchlist screen of its own. */
export const iosFeatures = [
  "home",
  "live_tv",
  "movies",
  "series",
  "downloads",
  "search",
  "settings",
  "player",
  "details",
] as const satisfies readonly AnalyticsFeature[];
export type IosFeature = (typeof iosFeatures)[number];

/** Which build sends, and the iOS major version. No model, locale or other device detail. */
export const IosBuild = lazy(() =>
  type({
    app_version: /^(?:\d+\.\d+\.\d+|unknown)$/,
    app_build: /^(?:\d{1,9}|unknown)$/,
    os: "'ios'",
    "os_major?": "13 <= number.integer <= 99",
  }).onUndeclaredKey("delete"),
);
export type IosBuild = Infer<typeof IosBuild>;

/** One playback run can't outlast a month; a longer value is a clock or ownership defect. */
export const WATCH_SECONDS_LIMIT = 31 * 86_400;

const Common = lazy(() =>
  IosBuild()
    .merge({ $process_person_profile: "false", $geoip_disable: "true" })
    .onUndeclaredKey("delete"),
);
type CommonProperties = Infer<typeof Common>;

const Day = /^\d{4}-\d{2}-\d{2}$/;
const StreamType = lazy(() => type("'live' | 'vod'"));

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

/** Every capture: one fixed name with its own fixed property set. Unknown keys are deleted. */
export const CaptureEvent = lazy(() =>
  event(type.unit("installation_observed"), Common())
    .or(
      event(
        type.unit("app_active_day"),
        Common().merge({ activity_date: Day }).onUndeclaredKey("delete"),
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
          .merge({ stream_type: StreamType(), error_type: type.enumerated(...analyticsFailures) })
          .onUndeclaredKey("delete"),
      ),
    )
    .or(event(type.enumerated(...iosActions), Common()))
    .or(
      event(
        type.unit("feature_opened"),
        Common()
          .merge({ feature: type.enumerated(...iosFeatures) })
          .onUndeclaredKey("delete"),
      ),
    ),
);
export type CaptureEvent = Infer<typeof CaptureEvent>;
export type CaptureName = CaptureEvent["event"];
export type CaptureOf<Name extends CaptureName> = CaptureEvent & { event: Name };

/** An event's own properties, by name, before the common build dimensions are added. */
export type EventProperties<Name extends CaptureName> =
  CaptureOf<Name>["properties"] extends infer Properties
    ? Properties extends unknown
      ? Omit<Properties, keyof CommonProperties>
      : never
    : never;

/** Bounded so a long time offline or a runaway producer can't grow the file. */
export const OUTBOX_LIMIT = 64;
/** Sends per event, across launches. */
export const ATTEMPTS = 3;

/**
 * `analytics.json`. `choice` is the viewer's own statistics choice, null until they make one.
 * `unfinished` is the current run's stop as it stands, sent at the next launch if the app ends
 * before the run does: iOS ends apps in the background without telling them.
 */
export const AnalyticsRecord = lazy(() =>
  type({
    format: "1",
    choice: "'on' | 'off' | null",
    installationId: "string.uuid | null",
    lastDay: type(Day).or("null"),
    pending: type({ event: CaptureEvent(), attempts: "0 <= number.integer <= 3" })
      .onUndeclaredKey("delete")
      .array()
      .atMostLength(OUTBOX_LIMIT),
    unfinished: CaptureEvent().or("null"),
  }).onUndeclaredKey("delete"),
);
export type AnalyticsRecord = Infer<typeof AnalyticsRecord>;
