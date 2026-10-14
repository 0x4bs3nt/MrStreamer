import { type } from "arktype";
import { BuildProperties } from "./properties.ts";
import { WireSummaryCounts, SummaryRecord } from "./summary.ts";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";

export const ProfileOrigin = lazy(() => type("'fresh' | 'upgrading' | 'unknown'"));
export type ProfileOrigin = Infer<typeof ProfileOrigin>;

export { BuildProperties } from "./properties.ts";

const Properties = lazy(() =>
  BuildProperties()
    .merge({
      profile_origin: ProfileOrigin(),
      $process_person_profile: "false",
      $geoip_disable: "true",
    })
    .onUndeclaredKey("delete"),
);

const Envelope = lazy(() =>
  type({
    uuid: "string.uuid",
    distinct_id: "string.uuid",
    timestamp: "string.date.iso",
  }).onUndeclaredKey("delete"),
);

export const CaptureEvent = lazy(() =>
  Envelope()
    .merge({
      event: "'installation_observed'",
      properties: Properties(),
    })
    .onUndeclaredKey("delete")
    .or(
      Envelope()
        .merge({
          event: "'app_active_day'",
          properties: Properties()
            .merge({ activity_date: /^\d{4}-\d{2}-\d{2}$/ })
            .onUndeclaredKey("delete"),
        })
        .onUndeclaredKey("delete"),
    )
    .or(
      Envelope()
        .merge({
          event: "'app_summary_day'",
          properties: Properties()
            .merge({
              summary_date: /^\d{4}-\d{2}-\d{2}$/,
              counts: WireSummaryCounts(),
            })
            .onUndeclaredKey("delete"),
        })
        .onUndeclaredKey("delete"),
    ),
);
export type CaptureEvent = Infer<typeof CaptureEvent>;

export const AnalyticsRecord = lazy(() =>
  type({
    format: "1",
    enabled: "boolean",
    installationId: "string.uuid | null",
    profileOrigin: ProfileOrigin(),
    firstSeen: "boolean",
    lastDay: type(/^\d{4}-\d{2}-\d{2}$/).or("null"),
    "summary?": SummaryRecord(),
    pending: type({ event: CaptureEvent(), attempts: "0 <= number.integer <= 3" })
      .onUndeclaredKey("delete")
      .array()
      .atMostLength(8),
  }).onUndeclaredKey("delete"),
);
export type AnalyticsRecord = Infer<typeof AnalyticsRecord>;
