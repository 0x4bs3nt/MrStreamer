import type { PlaybackDiagnostic } from "@mrstreamer/contracts/analytics";
import type { Codec, StreamFailure } from "@mrstreamer/contracts/playback";
import { languageCode } from "@mrstreamer/core/ondemand/tracks";
import { createCleanStart } from "./clean-start.ts";
import { createInspector, type Inspection, type StreamLayout } from "./inspect.ts";

export type Opened =
  | {
      readonly ok: true;
      readonly contentType: string | null;
      readonly reader: ReadableStreamDefaultReader<Uint8Array>;
      readonly start: StreamStart;
    }
  | { readonly ok: false; readonly failure: StreamFailure };

/** Video codecs whose streams start on a keyframe; see ../playback/clean-start.ts. */
export const CLEAN_START_CODECS: ReadonlySet<Codec> = new Set(["h264", "hevc", "hevc-10bit"]);
/** How much of a stream the proxy reads, at most, before deciding how to deliver it. */
export const INSPECT_LIMIT = { bytes: 2 * 1024 * 1024, ms: 2500 };
/** The requested input PID, else the remembered language, else the channel's first sound. */
export function liveAudio(
  layout: StreamLayout | null,
  pid: number | null,
  language: string | null,
) {
  return (
    layout?.audio.find((track) => track.pid === pid) ??
    (language
      ? layout?.audio.find((track) => languageCode(track.language) === language)
      : undefined) ??
    layout?.audio[0]
  );
}
type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

export interface StreamStart {
  /** The tracks, or null when the data is not MPEG-TS. */
  readonly layout: StreamLayout | null;
  readonly diagnostic: PlaybackDiagnostic;
  /** What was read while inspecting; the player still needs it. */
  readonly head: readonly Uint8Array[];
  /** A read still in flight when time ran out. */
  readonly pending: Promise<ReadResult> | null;
}

/**
 * Reads until the stream's codecs settle how to deliver it, or the inspection limit is reached.
 * A track can stay undetermined when every codec it may turn out to be gets the same treatment.
 */
export async function inspectStart(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoders: ReadonlySet<Codec>,
): Promise<StreamStart> {
  const inspector = createInspector();
  const head: Uint8Array[] = [];
  let size = 0;
  let latest: Inspection | null = null;
  let pending: Promise<ReadResult> | null = null;
  const facts = (): PlaybackDiagnostic => {
    const unresolved = latest?.open.flat() ?? [];
    return {
      // Inspection's conservative codec guesses must never be reported as observed codecs.
      ...(unresolved.length > 0
        ? { diagnostic_video_codec: "unknown" as const, diagnostic_audio_codec: "unknown" as const }
        : {}),
      ...(!latest || unresolved.length > 0
        ? { diagnostic_reason: "inspection_undetermined" as const }
        : {}),
    };
  };
  const deadline = Date.now() + INSPECT_LIMIT.ms;
  while (size < INSPECT_LIMIT.bytes) {
    pending ??= reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
    });
    const result = await Promise.race([pending, expired]).catch(() => null);
    clearTimeout(timer);
    if (result === null) break;
    pending = null;
    if (result.done) break;
    head.push(result.value);
    size += result.value.length;
    latest = inspector.push(result.value) ?? latest;
    const settled = latest?.open.every((candidates) => {
      const decoded = candidates.filter((codec) => decoders.has(codec)).length;
      return decoded === 0 || decoded === candidates.length;
    });
    if (latest && settled)
      return { layout: latest.layout, diagnostic: facts(), head, pending: null };
    if (inspector.notTransportStream)
      return { layout: null, diagnostic: facts(), head, pending: null };
  }
  return { layout: latest?.layout ?? null, diagnostic: facts(), head, pending };
}

/** The inspected start of the stream followed by the rest of it. */
export async function* replay(
  start: StreamStart,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  try {
    yield* start.head;
    if (start.pending) {
      const result = await start.pending;
      if (result.done) return;
      yield result.value;
    }
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** The stream from its first decodable picture on. */
export function cleanStart(
  chunks: AsyncGenerator<Uint8Array>,
  filter: ReturnType<typeof createCleanStart>,
): AsyncGenerator<Uint8Array> {
  return filtered(chunks, filter);
}

/** The stream through a filter that takes chunks and returns whole packets. */
export async function* filtered(
  chunks: AsyncGenerator<Uint8Array>,
  filter: { push(chunk: Uint8Array): Uint8Array },
): AsyncGenerator<Uint8Array> {
  for await (const chunk of chunks) {
    const out = filter.push(chunk);
    if (out.length > 0) yield out;
  }
}
