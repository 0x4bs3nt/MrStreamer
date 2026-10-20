// Build an export from known fields, never by copying or trying to scrub a raw log. Older or
// damaged records can contain anything, so even string fields have an explicit set of values.
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { DiagnosticsPreview } from "@mrstreamer/contracts/diagnostics";
import { ipcInputs } from "@mrstreamer/contracts/ipc";
import type { Diagnostic, Outcome } from "@mrstreamer/core/diagnostics";

const LOG_BYTES = 512 * 1024;
const ENTRIES = 500;
const OUTCOMES = [
  "ok",
  "interrupted",
  "incomplete-login",
  "invalid-login",
  "account-inactive",
  "unreachable",
  "unencrypted-only",
  "provider-error",
  "no-subscription",
  "needs-secret",
  "keychain-refused",
  "channel-not-found",
  "title-not-found",
  "stream",
  "incomplete-catalogue",
  "favourites-changed",
  "mark-changed",
  "output",
  "guide",
  "invalid-input",
  "unexpected",
] as const satisfies readonly Outcome[];
const STREAM_OUTCOMES = [
  "ok",
  "refused",
  "unavailable",
  "provider-error",
  "network",
  "unsupported",
] as const;
type Rule = "number" | "nullable-number" | "method" | readonly string[];
const step = { ms: "number", outcome: OUTCOMES } as const;
/** Only these properties and values can leave the app. Unknown properties never survive. */
const FIELDS = {
  start: step,
  connect: step,
  catalogue: step,
  titles: step,
  details: step,
  guide: step,
  check: step,
  download: step,
  install: step,
  stream: {
    ms: "number",
    delivery: ["direct", "converted", "repaired", "none"],
    outcome: STREAM_OUTCOMES,
  },
  title: {
    ms: "number",
    video: ["copy", "convert", "none"],
    audio: ["copy", "convert", "none"],
    outcome: STREAM_OUTCOMES,
  },
  receiver: {
    ms: "number",
    video: ["copy", "convert", "none"],
    audio: ["copy", "convert", "none"],
    index: ["cues", "samples", "none", "mismatch"],
    outcome: STREAM_OUTCOMES,
  },
  subtitles: {
    ms: "number",
    bytes: "number",
    requests: "number",
    kept: "number",
    heldMs: "number",
    waitedMs: "number",
    revoked: "number",
    outcome: ["ok", "limit", "changed", "unreadable", "network"],
  },
  "update-source": {
    source: ["feed", "github"],
    status: "nullable-number",
    remaining: "nullable-number",
    reset: "nullable-number",
    retryAfter: "nullable-number",
  },
  call: { method: "method", outcome: OUTCOMES },
} as const satisfies Record<Diagnostic["op"], Record<string, Rule>>;

function record(line: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const known = Object.entries(FIELDS).find(([key]) => key === raw["op"]);
  if (
    !known ||
    typeof raw["at"] !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw["at"]) ||
    !Number.isFinite(Date.parse(raw["at"]))
  )
    return null;
  const [op] = known;
  const rules: Readonly<Record<string, Rule>> = known[1];
  const safe: Record<string, string | number | null> = { at: raw["at"], op };
  for (const [key, rule] of Object.entries(rules)) {
    const field = raw[key];
    if (rule === "nullable-number" && field === null) safe[key] = null;
    else if (rule === "number" || rule === "nullable-number") {
      if (
        typeof field !== "number" ||
        !Number.isFinite(field) ||
        field < 0 ||
        field > Number.MAX_SAFE_INTEGER
      )
        return null;
      safe[key] = field;
    } else if (rule === "method") {
      if (typeof field !== "string" || !Object.hasOwn(ipcInputs, field)) return null;
      safe[key] = field;
    } else {
      const allowed = rule.find((candidate) => candidate === field);
      if (allowed === undefined) return null;
      safe[key] = allowed;
    }
  }
  return JSON.stringify(safe);
}

/** Reads a bounded tail even if a damaged or replaced log is much larger than the app writes. */
async function lines(path: string): Promise<readonly string[]> {
  let file;
  try {
    file = await open(path, "r");
  } catch {
    return [];
  }
  try {
    const size = (await file.stat()).size;
    const start = Math.max(0, size - LOG_BYTES);
    const buffer = Buffer.alloc(Math.min(size, LOG_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const complete = start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
    return complete
      .split("\n")
      .flatMap((line) => {
        const safe = record(line);
        return safe === null ? [] : [safe];
      })
      .slice(-ENTRIES);
  } catch {
    return [];
  } finally {
    await file.close();
  }
}

export interface DiagnosticsContext {
  readonly version: string;
  readonly commit: string;
  readonly channel: "stable" | "nightly";
  readonly platform: string;
  readonly arch: string;
  readonly distribution: DiagnosticsPreview["distribution"];
  readonly subscriptions: DiagnosticsPreview["subscriptions"];
  readonly acceleratedVideoDecodeDisabled: boolean;
  readonly checked: { readonly at: number; readonly failure: string | null } | null;
}

/** Holds one immutable preview, so Save writes precisely the file the viewer could inspect. */
export function diagnosticsExporter(dataDir: string, context: () => Promise<DiagnosticsContext>) {
  let latest: Pick<DiagnosticsPreview, "id" | "text"> | null = null;
  return {
    async preview(): Promise<DiagnosticsPreview> {
      const build = await context();
      const recent = (await lines(join(dataDir, "diagnostics.1.log")))
        .concat(await lines(join(dataDir, "diagnostics.log")))
        .slice(-ENTRIES);
      const version = /^\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/.test(build.version)
        ? build.version
        : "unknown";
      const commit = /^[a-f0-9]{7,40}$/.test(build.commit) ? build.commit : "unknown";
      const platform = ["darwin", "win32", "linux"].includes(build.platform)
        ? build.platform
        : "unknown";
      const arch = ["arm64", "x64", "ia32"].includes(build.arch) ? build.arch : "unknown";
      const failure = ["offline", "busy", "http", "invalid"].find(
        (kind) => kind === build.checked?.failure,
      );
      const checked =
        build.checked &&
        Number.isFinite(build.checked.at) &&
        build.checked.at >= 0 &&
        build.checked.at <= 8.64e15
          ? `${new Date(build.checked.at).toISOString()} · ${failure ?? "ok"}`
          : "none";
      const preview: DiagnosticsPreview = {
        id: randomUUID(),
        version,
        commit,
        channel: build.channel,
        platform: `${platform} ${arch}`,
        distribution: build.distribution,
        subscriptions: build.subscriptions,
        entries: recent.length,
        failures: recent.filter((line) => {
          const value: unknown = JSON.parse(line);
          return (
            typeof value === "object" &&
            value !== null &&
            "outcome" in value &&
            value.outcome !== "ok" &&
            value.outcome !== "interrupted" &&
            value.outcome !== "changed"
          );
        }).length,
        acceleratedVideoDecodeDisabled: build.acceleratedVideoDecodeDisabled,
        checked,
        text: [
          `Mr. Streamer ${version} · ${build.channel} · commit ${commit}`,
          `${platform} ${arch} · ${distributionLabel(build.distribution)}`,
          `Subscriptions: ${build.subscriptions.xtream} Xtream, ${build.subscriptions.m3u} M3U`,
          `Accelerated video decode disabled: ${build.acceleratedVideoDecodeDisabled}`,
          `Last update check: ${checked}`,
          "Addresses, logins, channel and title names, and filesystem paths are omitted.",
          "",
          `Recent diagnostics: ${recent.length} entries, at most ${ENTRIES}`,
          ...recent,
          "",
        ].join("\n"),
      };
      latest = { id: preview.id, text: preview.text };
      return preview;
    },
    /** A replaced preview cannot silently save a different file. */
    textOf(id: string): string | null {
      return latest?.id === id ? latest.text : null;
    },
  };
}

export type DiagnosticsExporter = ReturnType<typeof diagnosticsExporter>;

/** Technical export labels name the updater without changing analytics packaging vocabulary. */
function distributionLabel(distribution: DiagnosticsPreview["distribution"]): string {
  switch (distribution) {
    case "direct":
      return "Direct install";
    case "store":
      return "Microsoft Store";
    case "pacman":
      return "AUR (pacman)";
  }
}
