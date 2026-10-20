import type { IncomingMessage } from "node:http";
import { captionsInPicture, captionsInTrack } from "@mrstreamer/core/subtitles/captions";
import { dvbClears } from "@mrstreamer/core/subtitles/dvb";
import type { SubtitlesUnavailable } from "@mrstreamer/core/subtitles/feed";
import { pgsSegments } from "@mrstreamer/core/subtitles/pgs";
import { pesReader, type PesPacket } from "@mrstreamer/core/subtitles/transport";
import { webvttReader, type Cue } from "@mrstreamer/core/subtitles/webvtt";
import type { SubtitleEntry } from "./subtitle-history.ts";
import type { SubtitleOutput, TitleProbe } from "./title.ts";

/**
 * How far a subtitle packet may sit in a file from the picture of its own time, in seconds. A
 * file stores its packets in the order of their times, near enough: a reading counts as whole
 * from this long after its first picture to this long before its last, and a run brings the
 * subtitles itself from this long after its position. Matroska and MP4 files keep to a few
 * hundredths of a second. A transport stream sends each picture ahead of its time, by as much as
 * its encoder's buffer, and subtitles when they are due, so those come that much after the
 * pictures of their time.
 */
const INTERLEAVE_S = { ordered: 1, broadcast: 2.5 } as const;
/** One reading of a subtitle track's past: when it is over, and what it took of the provider. */
export interface Attempt {
  /** The player left, the session closed, or the reading ran out of time. */
  readonly signal: AbortSignal;
  readonly spent: Spent;
  /**
   * The stretch being stepped through is more of the file than the reading has left to take, so
   * each request asks for the least: a block's header and what little follows it.
   */
  narrow: boolean;
}

export interface Spent {
  bytes: number;
  requests: number;
}

/** A subtitle track's past couldn't be had for a position; `kind` says why. */
export class Unavailable extends Error {
  readonly kind: SubtitlesUnavailable;
  constructor(kind: SubtitlesUnavailable) {
    super(kind);
    this.kind = kind;
  }
}
/** What the player asked a feed for. */
export interface FeedRequest {
  readonly track: number;
  /** The teletext page or caption channel, for a track that holds several. */
  readonly page: number | null;
  /** The decoder the player was told for the track's packets; none for text. */
  readonly codec: string;
  /** Seconds into the title. */
  readonly start: number;
}

/** What a track holds before a position that the player needs to start there. */
export interface Before {
  readonly entries: readonly SubtitleEntry[];
  /** Up to this time on the file's clock; the run brings what comes after. */
  readonly upTo: number;
  /** The file's clock at the start of the title. */
  readonly origin: number;
}
/**
 * The file's clock at the end of the title, or null when the file doesn't say how long it is. A
 * Matroska file counts its length from the start of its clock, wherever its first picture sits;
 * the others count theirs from their start time.
 */
export function endOf(probe: TitleProbe): number | null {
  if (probe.duration === null) return null;
  const end = probe.container === "matroska" ? probe.duration : probe.origin + probe.duration;
  return end > probe.origin ? end : null;
}
/** How far a subtitle packet of `probe`'s file may sit from the picture of its time, in seconds. */
export function interleave(probe: TitleProbe): number {
  return probe.container === "other" ? INTERLEAVE_S.broadcast : INTERLEAVE_S.ordered;
}
/**
 * Reads the subtitles one ffmpeg sends, as `output` says they come, and hands each to `entry` in
 * the order ffmpeg read them, with their times on the file's clock.
 */
export function subtitleSink(output: SubtitleOutput, entry: (entry: SubtitleEntry) => void) {
  let receiving: Promise<boolean> | null = null;
  const { promise: arrived, resolve: arrive } = Promise.withResolvers<void>();

  function read(request: IncomingMessage): void {
    if (output.kind === "cues") {
      const reader = webvttReader();
      const add = (cues: readonly Cue[]) => {
        for (const cue of cues) {
          entry({ from: cue.start, at: cue.start, until: cue.end, text: cue.text });
        }
      };
      request.setEncoding("utf8");
      request.on("data", (text: string) => add(reader.push(text)));
      request.on("end", () => add(reader.end()));
      return;
    }
    if (output.container === "sup") {
      const segments = pgsSegments();
      request.on("data", (chunk: Buffer) => {
        for (const { at, set } of segments.push(chunk)) entry({ from: at, at, data: set });
      });
      return;
    }
    const reader = pesReader();
    /** The last picture of a converted DVD track: the empty page after it is its end. */
    let picture: number | null = null;
    const forward = (packets: readonly PesPacket[]) => {
      for (const packet of packets) {
        if (packet.pts === null) continue;
        const at = packet.pts / 90_000;
        const data =
          output.captions === null
            ? packet.payload
            : output.captions === "track"
              ? captionsInTrack(packet.payload)
              : captionsInPicture(packet.payload, output.captions);
        // Most pictures carry no caption, only padding, which a decoder passes over.
        if (
          !data.some((byte, index) => (output.captions ? index % 3 > 0 && (byte & 0x7f) > 0 : true))
        ) {
          continue;
        }
        const ends = output.paired && picture !== null && dvbClears(data);
        entry({ from: ends && picture !== null ? picture : at, at, data });
        if (!ends) picture = at;
      }
    };
    request.on("data", (chunk: Buffer) => forward(reader.push(chunk)));
    // The last packet is whole only when ffmpeg ended the stream itself.
    request.on("end", () => forward(reader.end()));
  }

  return {
    /** Takes the request ffmpeg sends them in. */
    receive(request: IncomingMessage): void {
      receiving = new Promise((resolve) => {
        let whole = false;
        request.on("error", () => {});
        request.on("end", () => {
          whole = true;
        });
        request.on("close", () => resolve(whole));
        read(request);
      });
      arrive();
    },
    /** Resolves once the request has come. */
    arrived,
    /**
     * Resolves once everything ffmpeg sent has been read: true when it ended the stream itself,
     * having written all it read of the file, false when it was cut off or never sent any.
     */
    whole: (): Promise<boolean> => receiving ?? Promise.resolve(false),
  };
}
