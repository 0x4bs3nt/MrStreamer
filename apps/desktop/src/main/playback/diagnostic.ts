import { diagnosticCodecs, type PlaybackDiagnostic } from "@mrstreamer/contracts/analytics";
import type { StreamLayout } from "./inspect.ts";
import type { Conversion } from "./convert.ts";
import type { TitlePlan, TitleProbe } from "./title.ts";

/** Facts from the selected program table and conversion plan, never their raw descriptions. */
export function liveDiagnostic(
  layout: StreamLayout | null,
  conversion: Conversion | null,
  repair: boolean,
  audio: number | null,
): PlaybackDiagnostic {
  const sound = layout?.audio.find((track) => track.pid === audio) ?? layout?.audio[0];
  return {
    ...diagnosticCodecs(layout?.video?.codec ?? null, sound?.codec ?? null),
    diagnostic_container: layout ? "mpegts" : "unknown",
    diagnostic_delivery: conversion ? "converted" : "direct",
    diagnostic_fallback: repair ? "repair" : "none",
  };
}

/** File facts and the selected tracks, without codec names not in the shared allowlist. */
export function titleDiagnostic(
  probe: TitleProbe | null,
  plan: Pick<TitlePlan, "video" | "audio"> | null,
  audio: number | null,
): PlaybackDiagnostic {
  const sound = probe?.audio.find((track) => track.id === audio) ?? probe?.audio[0];
  const video = probe?.video?.name;
  // These source codecs always convert. They are not browser capability literals.
  const software = video === "vp8" || video === "vp9" || video === "av1" ? video : null;
  return {
    ...diagnosticCodecs(probe?.video?.codec ?? null, sound?.codec ?? null),
    ...(software ? { diagnostic_video_codec: software } : {}),
    diagnostic_container: probe?.container ?? "unknown",
    diagnostic_delivery: !plan
      ? "unknown"
      : plan.video === "convert" || plan.audio === "convert"
        ? "converted"
        : "direct",
  };
}

/** ffmpeg's last error line, or how it ended when it said nothing. */
export function lastLine(
  errors: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  start?: number | null,
): string {
  const line = errors.trim().split("\n").at(-1);
  if (line) return line;
  return `ffmpeg ended with ${signal ?? code ?? "no exit"}${start === null ? ", before the picture started" : ""}.`;
}
