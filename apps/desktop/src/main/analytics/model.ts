import { type } from "arktype";
import {
  analyticsActions,
  analyticsFailures,
  analyticsFeatures,
  analyticsSettings,
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

export const CaptureEvent = lazy(() =>
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

export const AnalyticsRecord = lazy(() =>
  type({
    format: "2",
    enabled: "boolean",
    installationId: "string.uuid | null",
    profileOrigin: ProfileOrigin(),
    firstSeen: "boolean",
    lastDay: type(/^\d{4}-\d{2}-\d{2}$/).or("null"),
    pending: type({ event: CaptureEvent(), attempts: "0 <= number.integer <= 3" })
      .onUndeclaredKey("delete")
      .array()
      .atMostLength(OUTBOX_LIMIT),
  }).onUndeclaredKey("delete"),
);
export type AnalyticsRecord = Infer<typeof AnalyticsRecord>;
