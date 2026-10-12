import { type } from "arktype";

export const ProfileOrigin = type("'fresh' | 'upgrading' | 'unknown'");
export type ProfileOrigin = typeof ProfileOrigin.infer;

export const BuildProperties = type({
  app_version: /^(?:\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?|unknown)$/,
  build_channel: "'stable' | 'nightly' | 'unknown'",
  update_channel: "'stable' | 'nightly' | 'none'",
  os: "'macos' | 'windows' | 'linux' | 'unknown'",
  arch: "'x64' | 'arm64' | 'ia32' | 'unknown'",
  distribution: "'direct' | 'store'",
}).onUndeclaredKey("delete");
export type BuildProperties = typeof BuildProperties.infer;

const Properties = BuildProperties.merge({
  profile_origin: ProfileOrigin,
  $process_person_profile: "false",
  $geoip_disable: "true",
}).onUndeclaredKey("delete");

const Envelope = type({
  uuid: "string.uuid",
  distinct_id: "string.uuid",
  timestamp: "string.date.iso",
}).onUndeclaredKey("delete");

export const CaptureEvent = Envelope.merge({
  event: "'installation_observed'",
  properties: Properties,
})
  .onUndeclaredKey("delete")
  .or(
    Envelope.merge({
      event: "'app_active_day'",
      properties: Properties.merge({ activity_date: /^\d{4}-\d{2}-\d{2}$/ }).onUndeclaredKey(
        "delete",
      ),
    }).onUndeclaredKey("delete"),
  );
export type CaptureEvent = typeof CaptureEvent.infer;

export const AnalyticsRecord = type({
  format: "1",
  enabled: "boolean",
  installationId: "string.uuid | null",
  profileOrigin: ProfileOrigin,
  firstSeen: "boolean",
  lastDay: type(/^\d{4}-\d{2}-\d{2}$/).or("null"),
  pending: type({ event: CaptureEvent, attempts: "0 <= number.integer <= 3" })
    .onUndeclaredKey("delete")
    .array()
    .atMostLength(8),
}).onUndeclaredKey("delete");
export type AnalyticsRecord = typeof AnalyticsRecord.infer;
