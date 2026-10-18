// Decides whether a stream can reach the player as it is, and how ffmpeg converts it otherwise.
// Only the tracks the player cannot decode change: a stream with MP2 sound keeps its H.264
// picture byte for byte and gets its sound re-encoded as AAC.
import type { Codec } from "@mrstreamer/contracts/playback";
import type { StreamLayout } from "./inspect.ts";
import { AAC_STEREO_ARGUMENTS, H264_IMAGE_ARGUMENTS } from "./conversion-settings.ts";

export interface Conversion {
  readonly video: "copy" | "h264" | "none";
  readonly audio: "copy" | "aac" | "none";
  /**
   * The tracks kept, by PID, and kept under the same PIDs, so the player finds the subtitles
   * where the program table said and no two tracks share one.
   */
  readonly pids: {
    readonly video: number | null;
    readonly audio: number | null;
    readonly subtitles: readonly number[];
  };
}

/**
 * What to convert so the player decodes the picture and the chosen sound track, or null when it
 * already does. The player plays one sound track, so the others do not matter. `repair`
 * re-encodes the picture as well. `audio` chooses a sound track by PID; the first otherwise.
 */
export function planConversion(
  layout: StreamLayout,
  decoders: ReadonlySet<Codec>,
  options: { readonly repair?: boolean; readonly audio?: number | null } = {},
): Conversion | null {
  const { video } = layout;
  const audio = layout.audio.find((track) => track.pid === options.audio) ?? layout.audio[0];
  // Repairing re-encodes a picture the player could decode but not survive.
  const videoOk =
    !video || (!options.repair && video.codec !== "unknown" && decoders.has(video.codec));
  const audioOk = !audio || (audio.codec !== "unknown" && decoders.has(audio.codec));
  if (videoOk && audioOk) return null;
  return {
    video: !video ? "none" : videoOk ? "copy" : "h264",
    audio: !audio ? "none" : audioOk ? "copy" : "aac",
    pids: {
      video: video?.pid ?? null,
      audio: audio?.pid ?? null,
      subtitles: [...new Set(layout.subtitles.map((track) => track.pid))],
    },
  };
}

/** ffmpeg arguments that read MPEG-TS on stdin and write the converted MPEG-TS to stdout. */
export function ffmpegArguments(conversion: Conversion): string[] {
  const args = [
    ...["-hide_banner", "-loglevel", "error", "-nostdin"],
    // ffmpeg reads 5 s of a stream before its first output by default; 1.5 s is enough to learn
    // the tracks the program table already announced.
    ...["-probesize", "1000000", "-analyzeduration", "1500000"],
    // Damaged broadcasts send frames without timestamps; ffmpeg fills in what it can.
    ...["-fflags", "+genpts"],
    ...["-f", "mpegts", "-i", "pipe:0"],
  ];
  const { pids } = conversion;
  const kept = [
    ...(conversion.video !== "none" ? [{ map: "0:v:0", pid: pids.video }] : []),
    ...(conversion.audio !== "none" ? [{ map: "0:a:0", pid: pids.audio }] : []),
    // Teletext and DVB subtitles pass as they are.
    ...pids.subtitles.map((pid) => ({ map: "", pid })),
  ];
  kept.forEach(({ map, pid }, index) => {
    args.push("-map", pid === null ? map : `0:i:${pid}${map ? "" : "?"}`);
    if (pid !== null) args.push("-streamid", `${index}:${pid}`);
  });
  if (pids.subtitles.length > 0) args.push("-c:s", "copy");
  if (conversion.video === "copy") args.push("-c:v", "copy");
  if (conversion.video === "h264") {
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-crf",
      "21",
      "-g",
      "50",
      ...H264_IMAGE_ARGUMENTS,
    );
  }
  if (conversion.audio === "copy") args.push("-c:a", "copy");
  if (conversion.audio === "aac") args.push(...AAC_STEREO_ARGUMENTS);
  args.push("-f", "mpegts", "-muxdelay", "0", "-muxpreload", "0", "pipe:1");
  return args;
}
