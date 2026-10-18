// A stream as a receiver on the network plays it: HLS, with MPEG-TS segments the proxy holds in
// memory a few at a time. A receiver has no player of ours, so it gets a playlist it can read by
// itself and asks for the segments; the proxy makes them as they are asked for.
//
// A movie or episode gets a complete playlist, with the length the file says, so the receiver
// shows the title's own clock and can skip anywhere. Its segments have to start where the playlist
// says, to the frame. A picture the receiver decodes is copied, which only allows a segment to
// start on a keyframe the file's index names: ffmpeg starts a run there, and cuts where the next
// ones are. A file without such an index, or with a picture the receiver doesn't decode, has its
// picture converted, with a keyframe made at each start instead. Every time here is a picture's
// presentation time on the file's clock, as ffprobe and the file's index give them.
//
// A channel has no length: ffmpeg cuts what the provider sends every two seconds or so, and says
// how long each piece turned out.
import type { SubtitleEntry } from "./subtitle-history.ts";
import { AAC_STEREO_ARGUMENTS, H264_IMAGE_ARGUMENTS } from "./conversion-settings.ts";

/** How long a segment of a movie is, about: the first index entry this long after the last start. */
export const SEGMENT_S = 4;
/**
 * The longest a copied segment may be. An index that leaves longer gaps would have the proxy hold
 * more of the file in memory than it may, so such a file's picture is converted instead.
 */
const SEGMENT_MOST_S = 20;
/** A last segment shorter than this joins the one before it. */
const LAST_LEAST_S = 1;
/** Segments a playlist lists at most: a title of 44 hours at four seconds each. */
const SEGMENTS_MOST = 40_000;
/**
 * How far past its keyframe a run's seek aims, at most: ffmpeg starts at the index entry at or
 * before where it seeks, so the aim only has to stay before the entry after it.
 */
const SEEK_PAST_S = 0.02;
/**
 * What ffmpeg takes off a seek in a file whose pictures are stored out of order, unless its reader
 * seeks by presentation time, as the one for MP4 does: three twenty-thirds of a second.
 */
const REORDER_SEEK_S = 3 / 23;
/**
 * A picture counts as at a cut when it is this close before it: timestamps round to the file's
 * tick. Less than a frame apart at any frame rate, so no earlier keyframe is taken for it.
 */
const COPY_CUT_S = 0.004;
/**
 * The same for a converted picture, whose only keyframes are the ones made at the cuts: the first
 * frame at or after each, so up to a frame late.
 */
const CONVERT_CUT_S = 0.5;
/** Where a title's first picture sits on a receiver's MPEG-TS clock, in seconds. */
const TS_START_S = 10;
/** Split times one run is given at most, which keeps its command line within every system's limit. */
const RUN_SEGMENTS = 1200;

/** Where the segments of a movie or episode start. */
export interface SegmentPlan {
  /** Whether the picture is copied, starting on indexed keyframes, or converted. */
  readonly video: "copy" | "convert";
  /**
   * Each segment's first picture, in seconds on the file's clock. The first is the file's first
   * picture.
   */
  readonly starts: readonly number[];
  /** Where the last segment ends: the file's clock at the end of the title. */
  readonly end: number;
  /**
   * Copied: for each start, the index entry after it, which is how far a seek to it may aim. Null
   * where the index holds none.
   */
  readonly next: readonly (number | null)[];
}

/**
 * Where a copied picture's segments start: the file's first picture, then the first index entry
 * `SEGMENT_S` or more after each start. `keyframes` are the index's entries for the picture,
 * presentation times on the file's clock. Null when they can't be used: none between the first
 * picture and the end, out of order, or so far apart that a segment would be too long.
 */
export function copyPlan(
  keyframes: readonly number[],
  first: number,
  end: number,
): SegmentPlan | null {
  if (!(end > first)) return null;
  const starts = [first];
  const next: (number | null)[] = [];
  let before = Number.NEGATIVE_INFINITY;
  /** The entry after the last start, once passed. */
  let after: number | null = null;
  for (const time of keyframes) {
    if (!Number.isFinite(time) || time < before) return null;
    before = time;
    const last = starts.at(-1)!;
    if (time <= last + COPY_CUT_S) continue;
    after ??= time;
    if (time < last + SEGMENT_S || time > end - LAST_LEAST_S) continue;
    if (time - last > SEGMENT_MOST_S || starts.length >= SEGMENTS_MOST) return null;
    next.push(after);
    after = null;
    starts.push(time);
  }
  next.push(after);
  if (end - starts.at(-1)! > SEGMENT_MOST_S) return null;
  return { video: "copy", starts, end, next };
}

/** Where a converted picture's segments start: every `SEGMENT_S` from the file's first picture. */
export function convertPlan(first: number, end: number): SegmentPlan | null {
  if (!(end > first) || (end - first) / SEGMENT_S > SEGMENTS_MOST) return null;
  const starts: number[] = [];
  for (let start = first; start < end - LAST_LEAST_S || starts.length === 0; start += SEGMENT_S) {
    starts.push(start);
  }
  return { video: "convert", starts, end, next: starts.map(() => null) };
}

/** How long segment `index` lasts, in seconds. */
function segmentLength(plan: SegmentPlan, index: number): number {
  return (plan.starts[index + 1] ?? plan.end) - plan.starts[index]!;
}

/** How ffmpeg starts and cuts a run of a plan's segments. */
export interface RunCuts {
  /**
   * Where the run seeks to, in seconds into the title as `-ss` counts them, from the file's
   * start time; null for a run from the start of the file, which doesn't seek.
   */
  readonly seek: number | null;
  /** Where its segments end, counted from its first picture: ffmpeg's `-segment_times`. */
  readonly times: readonly number[];
  /** How close before a cut a keyframe counts as at it: ffmpeg's `-segment_time_delta`. */
  readonly delta: number;
  /** For a converted picture: where to make keyframes, on the file's clock. */
  readonly keyframes: readonly number[];
  /** How many segments the run makes that end where the plan says: the one after them doesn't. */
  readonly count: number;
}

/**
 * A run that starts with segment `from`. `origin` is the file's start time, which `-ss` counts
 * from. `reordered` when the file stores its pictures out of order and its reader doesn't seek by
 * presentation time, so ffmpeg aims a seek earlier by itself.
 */
export function runCuts(
  plan: SegmentPlan,
  from: number,
  origin: number,
  reordered: boolean,
): RunCuts {
  const start = plan.starts[from]!;
  const ends = plan.starts.slice(from + 1, from + 1 + RUN_SEGMENTS);
  const times = ends.map((time) => time - start);
  // Every segment up to the last cut ends where the plan says. The one after ends with the
  // file, which is right only for the plan's last segment.
  const whole = from + ends.length === plan.starts.length - 1;
  const count = ends.length + (whole ? 1 : 0);
  if (plan.video === "convert") {
    return {
      seek: from === 0 ? null : start - origin,
      times,
      delta: CONVERT_CUT_S,
      keyframes: ends,
      count,
    };
  }
  const next = plan.next[from] ?? null;
  const past = next === null ? SEEK_PAST_S : Math.min(SEEK_PAST_S, (next - start) / 2);
  return {
    seek: from === 0 ? null : start + past - origin + (reordered ? REORDER_SEEK_S : 0),
    times,
    delta: COPY_CUT_S,
    keyframes: [],
    count,
  };
}

/**
 * ffmpeg's output arguments that cut a run into MPEG-TS segments and send each to `url`, which
 * holds `%d` for the segment's number, counted from `from`. The segments share one clock:
 * `first`, the file's first picture, sits at `TS_START_S` on it, whichever run made them. Program
 * tables come before every picture, so each segment plays by itself.
 */
export function segmentArguments(
  cuts: Pick<RunCuts, "times" | "delta">,
  from: number,
  first: number,
  url: string,
): string[] {
  return [
    ...["-output_ts_offset", (TS_START_S - first).toFixed(6)],
    ...["-f", "segment", "-segment_format", "mpegts", "-individual_header_trailer", "0"],
    ...["-segment_format_options", "mpegts_copyts=1:mpegts_flags=+pat_pmt_at_frames"],
    ...(cuts.times.length > 0
      ? ["-segment_times", cuts.times.map((time) => time.toFixed(6)).join(",")]
      : // No cut: one segment to the end of the file.
        ["-segment_time", "86400"]),
    ...["-segment_time_delta", cuts.delta.toFixed(6)],
    ...["-segment_start_number", String(from), url],
  ];
}

/**
 * Where segment `index` of `plan` has to start and end on the segments' clock, in seconds, and
 * how far a segment made for it may be off: a copied picture's keyframe is where the index says
 * or it isn't, a converted one's first frame is the first at or after the start. `end` is null
 * for the last segment, which ends with the file.
 */
export function segmentSpan(
  plan: SegmentPlan,
  index: number,
): { start: number; end: number | null; within: number } {
  const on = (time: number) => TS_START_S + time - plan.starts[0]!;
  const next = plan.starts[index + 1];
  return {
    start: on(plan.starts[index]!),
    end: next === undefined ? null : on(next),
    within: plan.video === "copy" ? COPY_CUT_S : CONVERT_CUT_S,
  };
}

/**
 * When the pictures in an MPEG-TS segment show, in seconds on the segments' clock: `first` is the
 * first one stored, the segment's keyframe, and `last` the latest of them all. Pictures stored
 * out of the order they show in make the two differ from the first and last stored. Null when the
 * segment holds no picture.
 */
export function pictureSpan(segment: Uint8Array): { first: number; last: number } | null {
  let pid: number | null = null;
  let first: number | null = null;
  let last = Number.NEGATIVE_INFINITY;
  for (let at = 0; at + 188 <= segment.length; at += 188) {
    // Only the packets that start a picture carry its time.
    if (segment[at] !== 0x47 || (segment[at + 1]! & 0x40) === 0) continue;
    const packet = ((segment[at + 1]! & 0x1f) << 8) | segment[at + 2]!;
    if (pid !== null && packet !== pid) continue;
    const adaptation = (segment[at + 3]! >> 4) & 0x3;
    if ((adaptation & 0x1) === 0) continue;
    const payload = at + 4 + (adaptation === 3 ? 1 + segment[at + 4]! : 0);
    if (payload + 14 > at + 188) continue;
    const startCode =
      segment[payload] === 0 && segment[payload + 1] === 0 && segment[payload + 2] === 1;
    const stream = segment[payload + 3]!;
    // Video streams, and only a packet that carries a presentation time.
    if (!startCode || stream < 0xe0 || stream > 0xef || (segment[payload + 7]! & 0x80) === 0) {
      continue;
    }
    const shows =
      ((segment[payload + 9]! & 0x0e) * 2 ** 29 +
        segment[payload + 10]! * 2 ** 22 +
        (segment[payload + 11]! & 0xfe) * 2 ** 14 +
        segment[payload + 12]! * 2 ** 7 +
        (segment[payload + 13]! >> 1)) /
      90_000;
    pid = packet;
    first ??= shows;
    last = Math.max(last, shows);
  }
  return first === null ? null : { first, last };
}

/** What a channel's stream for a receiver keeps of the provider's, and what converts. */
export interface LiveSegments {
  readonly video: "copy" | "h264" | "none";
  readonly audio: "copy" | "aac" | "none";
  /** The tracks kept, by PID. */
  readonly pids: { readonly video: number | null; readonly audio: number | null };
}

/** How long a segment of a channel is, about: ffmpeg cuts at the first keyframe after it. */
const LIVE_SEGMENT_S = 2;
/** How many segments each of ffmpeg's lists names: more than one new one never comes at once. */
const LIVE_LISTED = 4;

/**
 * ffmpeg arguments that read a channel's MPEG-TS on stdin and send it on as segments: each to
 * `url`, which holds `%d` for its number, counted from `from`, and to `list`, each time one is
 * whole, a playlist of the last few with how long each turned out.
 */
export function liveSegmentArguments(
  segments: LiveSegments,
  from: number,
  url: string,
  list: string,
): string[] {
  const args = [
    ...["-hide_banner", "-loglevel", "error", "-nostdin"],
    ...["-probesize", "1000000", "-analyzeduration", "1500000", "-fflags", "+genpts"],
    ...["-f", "mpegts", "-i", "pipe:0"],
  ];
  const { pids } = segments;
  if (segments.video !== "none")
    args.push("-map", pids.video === null ? "0:v:0" : `0:i:${pids.video}`);
  if (segments.audio !== "none")
    args.push("-map", pids.audio === null ? "0:a:0" : `0:i:${pids.audio}`);
  if (segments.video === "copy") args.push("-c:v", "copy");
  if (segments.video === "h264") {
    args.push(
      ...["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-crf", "21"],
      // A keyframe every 50 frames, as for the app's own player: a segment ends at one.
      ...["-g", "50"],
      ...H264_IMAGE_ARGUMENTS,
    );
  }
  if (segments.audio === "copy") args.push("-c:a", "copy");
  if (segments.audio === "aac") args.push(...AAC_STEREO_ARGUMENTS);
  args.push(
    ...["-f", "segment", "-segment_format", "mpegts", "-individual_header_trailer", "0"],
    ...["-segment_format_options", "mpegts_flags=+pat_pmt_at_frames"],
    ...["-segment_time", String(LIVE_SEGMENT_S), "-segment_start_number", String(from)],
    ...["-segment_list", list, "-segment_list_type", "m3u8", "-segment_list_flags", "+live"],
    ...["-segment_list_size", String(LIVE_LISTED)],
    url,
  );
  return args;
}

/** The segments ffmpeg's list names, oldest first: each one's number and how long it is. */
export function listedSegments(list: string): { index: number; length: number }[] {
  return [...list.matchAll(/^#EXTINF:(\d+(?:\.\d+)?),[^\n]*\n[^\n]*?(\d+)\.ts\s*$/gm)].flatMap(
    ([, length, index]) =>
      Number(length) > 0 ? [{ index: Number(index), length: Number(length) }] : [],
  );
}

/** The playlist a receiver opens for a title: its one stream, and its text subtitles if any. */
export function masterPlaylist(
  bandwidth: number,
  subtitles: { readonly name: string; readonly language: string | null } | null,
): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  if (subtitles) {
    const language = subtitles.language ? `,LANGUAGE="${quoted(subtitles.language)}"` : "";
    lines.push(
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${quoted(subtitles.name)}"${language},` +
        `DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="subs.m3u8"`,
    );
  }
  lines.push(
    `#EXT-X-STREAM-INF:BANDWIDTH=${Math.max(1, Math.round(bandwidth))}${subtitles ? ',SUBTITLES="subs"' : ""}`,
    "video.m3u8",
  );
  return `${lines.join("\n")}\n`;
}

/** What goes inside a playlist's quotes: the format has no way to write one. */
function quoted(text: string): string {
  return text.replace(/["\r\n]/g, " ").trim();
}

/** A title's whole playlist: every segment of `plan` with its length, named by `name`. */
export function titlePlaylist(plan: SegmentPlan, name: (index: number) => string): string {
  const lengths = plan.starts.map((_start, index) => segmentLength(plan, index));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...lengths))}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];
  lengths.forEach((length, index) => lines.push(`#EXTINF:${length.toFixed(3)},`, name(index)));
  lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

/** A channel's playlist: the segments made lately, `first` the number of the oldest. */
export function livePlaylist(
  segments: readonly { readonly index: number; readonly length: number; readonly fresh: boolean }[],
): string {
  const longest = Math.max(LIVE_SEGMENT_S, ...segments.map((each) => each.length));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${Math.ceil(longest)}`,
    `#EXT-X-MEDIA-SEQUENCE:${segments[0]?.index ?? 0}`,
  ];
  for (const segment of segments) {
    // The provider's stream started again there: its clock did too.
    if (segment.fresh) lines.push("#EXT-X-DISCONTINUITY");
    lines.push(`#EXTINF:${segment.length.toFixed(3)},`, `l${segment.index}.ts`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The text subtitles of one segment as a receiver reads them: every line of `entries` that shows
 * at some time between `from` and `to`, with its own times, so a line that runs across a cut is
 * in both segments. Times count from the file's first picture, `first`, which the header ties to
 * the segments' clock.
 */
export function subtitleSegment(
  entries: readonly SubtitleEntry[],
  from: number,
  to: number,
  first: number,
): string {
  const lines = ["WEBVTT", `X-TIMESTAMP-MAP=MPEGTS:${TS_START_S * 90_000},LOCAL:00:00:00.000`, ""];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!("text" in entry) || entry.until <= from || entry.at >= to) continue;
    const start = Math.max(0, entry.at - first);
    const end = entry.until - first;
    if (!(end > start)) continue;
    // What came before a position and what the run read can hold the same line.
    const key = `${start.toFixed(3)} ${end.toFixed(3)} ${entry.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`${cueTime(start)} --> ${cueTime(end)}`, entry.text.replace(/\n{2,}/g, "\n"), "");
  }
  return lines.join("\n");
}

/** "01:02:03.500" */
function cueTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const part = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${part(Math.floor(ms / 3_600_000))}:${part(Math.floor(ms / 60_000) % 60)}:${part(Math.floor(ms / 1000) % 60)}.${part(ms % 1000, 3)}`;
}
