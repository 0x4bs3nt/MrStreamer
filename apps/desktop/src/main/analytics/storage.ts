import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import { writeJsonFile } from "../platform/json-file.ts";
import { AnalyticsRecord, type ProfileOrigin } from "./model.ts";

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
      try {
        const record = AnalyticsRecord()(JSON.parse(text));
        if (
          record instanceof type.errors ||
          record.firstSeen !== (record.installationId !== null) ||
          (record.firstSeen && record.lastDay === null) ||
          (!record.firstSeen && (record.lastDay !== null || record.pending.length !== 0)) ||
          (!record.enabled && record.pending.length !== 0) ||
          record.pending.some((item) => item.event.distinct_id !== record.installationId)
        )
          throw new Error();
        return record;
      } catch {
        throw new Error("Analytics state unavailable.");
      }
    },
    save(record: AnalyticsRecord): Promise<void> {
      return writeJsonFile(path, record);
    },
  };
}
