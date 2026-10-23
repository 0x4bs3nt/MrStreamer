import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import { writeJsonFile } from "../platform/json-file.ts";
import { lazy } from "@mrstreamer/contracts/lazy";
import { PlaybackDiagnostic } from "@mrstreamer/contracts/analytics";
import {
  AnalyticsRecord,
  LegacyRecord,
  SummaryBlock,
  LifecycleBlock,
  SUMMARY_TTL_MS,
  WINDOW_MS,
  OUTBOX_BYTES,
  type ProfileOrigin,
} from "./model.ts";

/** Snapshot before other app services write. Absence of analytics alone never proves freshness. */
export async function profileOrigin(dataDir: string): Promise<ProfileOrigin> {
  try {
    const files = await readdir(dataDir);
    if (files.length === 0) return "fresh";
    if (
      files.some((file) =>
        ["preferences.json", "subscription.json", "subscriptions.json", "mrstreamer.db"].includes(
          file,
        ),
      )
    )
      return "upgrading";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "fresh";
  }
  return "unknown";
}

/**
 * Format one also held daily summaries. Its queued app_summary_day events are discarded here, and
 * the record schema deletes its undeclared counts: neither is ever sent. Consent, identity, the
 * observation ledger and other queued events keep their UUIDs, timestamps and attempts.
 */
function withoutSummaries(kept: unknown): unknown {
  const legacy = FormatOne()(kept);
  if (legacy instanceof type.errors) return kept;
  return {
    ...legacy,
    format: 2,
    pending: legacy.pending.filter((item) => LegacySummary()(item) instanceof type.errors),
  };
}
const FormatOne = lazy(() => type({ format: "1", pending: "unknown[]" }));
const LegacySummary = lazy(() => type({ event: { event: "'app_summary_day'" } }));

/** Analytics state is private. Never use storage diagnostics that print a parse failure's values. */
export function analyticsStore(dataDir: string) {
  const path = join(dataDir, "analytics.json");
  return {
    async load(): Promise<AnalyticsRecord | null> {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw new Error("Analytics state unavailable.");
      }
      let record: AnalyticsRecord;
      let migrated: boolean;
      try {
        const parsed: unknown = JSON.parse(text);
        const current = withoutSummaries(parsed);
        migrated = current !== parsed;
        const checked = LegacyRecord()(withoutFutureDiagnostics(current));
        if (
          checked instanceof type.errors ||
          checked.firstSeen !== (checked.installationId !== null) ||
          (checked.firstSeen && checked.lastDay === null) ||
          (!checked.firstSeen && (checked.lastDay !== null || checked.pending.length !== 0)) ||
          (!checked.enabled && checked.pending.length !== 0) ||
          checked.pending.some((item) => item.event.distinct_id !== checked.installationId)
        )
          throw new Error();
        record = checked;
        // Optional new work cannot turn valid .15 consent into an unavailable preference.
        const optional = type({ "summaries?": "unknown" })(current);
        if (!(optional instanceof type.errors) && optional.summaries !== undefined) {
          const block = SummaryBlock()(optional.summaries);
          if (
            !(block instanceof type.errors) &&
            checked.enabled &&
            block.installationId === checked.installationId &&
            [
              ...block.pending.map((item) => item.event),
              block.usage,
              block.unfinished?.event,
            ].every(
              (event) =>
                !event ||
                (event.distinct_id === checked.installationId &&
                  (event.event !== "usage_window" ||
                    (event.timestamp === event.properties.window_start &&
                      Date.parse(event.properties.window_end) -
                        Date.parse(event.properties.window_start) ===
                        WINDOW_MS &&
                      Date.parse(event.timestamp) % WINDOW_MS === 0 &&
                      Object.keys(event.properties.counts).length > 0))),
            ) &&
            Buffer.byteLength(JSON.stringify(block)) <= OUTBOX_BYTES
          ) {
            const cutoff = Date.now() - SUMMARY_TTL_MS;
            // Age is per item. An expired peer cannot discard fresh, valid offline work.
            record = {
              ...checked,
              summaries: {
                ...block,
                pending: block.pending.filter((item) => Date.parse(item.event.timestamp) >= cutoff),
                usage:
                  block.usage && Date.parse(block.usage.timestamp) >= cutoff ? block.usage : null,
                unfinished:
                  block.unfinished && Date.parse(block.unfinished.event.timestamp) >= cutoff
                    ? block.unfinished
                    : null,
              },
            };
          }
        }
        const lifecycle = type({ "lifecycle?": "unknown" })(current);
        if (!(lifecycle instanceof type.errors) && lifecycle.lifecycle !== undefined) {
          const block = LifecycleBlock()(lifecycle.lifecycle);
          if (
            !(block instanceof type.errors) &&
            checked.enabled &&
            block.installationId === checked.installationId &&
            block.pending.every((item) => item.event.distinct_id === checked.installationId) &&
            new Set(block.pending.map((item) => item.event.uuid)).size === block.pending.length &&
            new Set(block.legacyRetries.map((item) => item.uuid)).size ===
              block.legacyRetries.length &&
            Buffer.byteLength(JSON.stringify(block)) <= OUTBOX_BYTES
          ) {
            const cutoff = Date.now() - SUMMARY_TTL_MS;
            record.lifecycle = {
              ...block,
              pending: block.pending.filter((item) => Date.parse(item.event.timestamp) >= cutoff),
              legacyRetries: block.legacyRetries.filter((retry) =>
                checked.pending.some(
                  (item) =>
                    item.event.uuid === retry.uuid &&
                    (item.event.event === "installation_observed" ||
                      item.event.event === "app_active_day"),
                ),
              ),
            };
          }
        }
      } catch {
        throw new Error("Analytics state unavailable.");
      }
      // The discarded counts leave the disk now, not at the next unrelated write.
      if (migrated) await writeJsonFile(path, record);
      return record;
    },
    save(record: AnalyticsRecord): Promise<void> {
      return writeJsonFile(path, record);
    },
  };
}

/** New optional diagnostic literals cannot invalidate otherwise valid consent or legacy work. */
function withoutFutureDiagnostics(value: unknown): unknown {
  const queue = type({
    pending: type({ event: type({ event: "string", properties: "object" }) }).array(),
  })(value);
  if (queue instanceof type.errors) return value;
  return {
    ...queue,
    pending: queue.pending.map((item) =>
      item.event.event !== "stream_error"
        ? item
        : {
            ...item,
            event: {
              ...item.event,
              properties: Object.fromEntries(
                Object.entries(item.event.properties).filter(
                  ([key, entry]) =>
                    !key.startsWith("diagnostic_") ||
                    !(PlaybackDiagnostic()({ [key]: entry }) instanceof type.errors),
                ),
              ),
            },
          },
    ),
  };
}
