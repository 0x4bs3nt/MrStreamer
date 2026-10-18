// A demand-driven clear muxed MPEG-TS HLS reader. Playback supplies authenticated HTTP and owns
// cancellation. This owner resolves playlists, orders segments and exposes every new layout.
import type { StreamFailure } from "@mrstreamer/contracts/playback";
import { createInspector, type StreamLayout } from "./inspect.ts";

const PLAYLIST_BYTES = 4 * 1024 * 1024;
const PREFIX_BYTES = 2 * 1024 * 1024;
const SEGMENT_BYTES = 32 * 1024 * 1024;
const SEGMENTS = 10_000;

export class HlsInputFailure extends Error {
  readonly failure: StreamFailure;
  constructor(failure: StreamFailure) {
    super(failure.kind);
    this.failure = failure;
  }
}

export function hlsSubsetFailure(): HlsInputFailure {
  return new HlsInputFailure({
    kind: "unsupported",
    detail: "This HLS stream cannot be converted.",
    diagnostic: {
      diagnostic_stage: "inspect",
      diagnostic_reason: "hls_subset_unsupported",
      diagnostic_container: "hls",
      diagnostic_delivery: "direct",
      diagnostic_fallback: "repair",
    },
  });
}

function malformed(): never {
  throw new HlsInputFailure({
    kind: "unsupported",
    detail: "The provider sent an invalid HLS playlist.",
    diagnostic: {
      diagnostic_stage: "inspect",
      diagnostic_reason: "malformed_input",
      diagnostic_container: "hls",
    },
  });
}

/** A single authenticated resource, opened by the existing provider request owner. */
export type HlsResource = (address: string, signal: AbortSignal) => Promise<Response>;

interface Segment {
  readonly address: string;
  readonly sequence: number;
  readonly epoch: number;
  readonly duration: number;
}
interface Media {
  readonly segments: readonly Segment[];
  readonly ended: boolean;
  readonly target: number;
}

/** Each epoch must be consumed before asking for the next. PIDs belong only to its layout. */
export interface HlsTsEpoch {
  readonly layout: StreamLayout & { readonly pcrPid: number };
  /** Elapsed presentation time, carried across source clock resets. */
  readonly startS: number;
  readonly chunks: AsyncGenerator<Uint8Array>;
}
export interface HlsTsInput {
  readonly selected: string;
  readonly firstLayout: HlsTsEpoch["layout"];
  /** Inspected bytes replayed to conversion; a bounded stdin picture probe reuses these. */
  readonly prefix: readonly Uint8Array[];
  readonly epochs: AsyncGenerator<HlsTsEpoch>;
  close(): Promise<void>;
}

function attributes(line: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const match of line.matchAll(/(?:^|,)([\w-]+)=(?:"([^"]*)"|([^,]*))/g)) {
    values.set(match[1]!, match[2] ?? match[3]!);
  }
  return values;
}
function addressOf(value: string, base: string): string {
  const url = URL.parse(value, base);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
    malformed();
  return url.href;
}
async function readPart(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  ms = 15_000,
) {
  signal.throwIfAborted();
  const stop = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Reject before cancellation resolves the pending read as a clean end of body.
          reject(
            new HlsInputFailure({
              kind: "network",
              detail: "The provider did not send HLS media in time.",
            }),
          );
          stop();
        }, ms);
      }),
    ]);
    signal.throwIfAborted();
    return next;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}

async function playlist(answer: Response, signal: AbortSignal): Promise<string> {
  const reader = answer.body?.getReader();
  if (!reader) malformed();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await readPart(reader, signal);
      if (next.done) break;
      size += next.value.length;
      if (size > PLAYLIST_BYTES) malformed();
      parts.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(parts).toString("utf8").trimStart();
  if (!text.startsWith("#EXTM3U")) malformed();
  return text;
}
function media(text: string, base: string): Media {
  // These inputs keep their direct paths. A clear METHOD=NONE reset needs no key request.
  if (/^#EXT-X-(?:SESSION-KEY|MAP|BYTERANGE|PART|PRELOAD-HINT|SKIP)(?::|$)/m.test(text))
    throw hlsSubsetFailure();
  if (
    text
      .split(/\r?\n/)
      .some(
        (line) =>
          line.startsWith("#EXT-X-KEY:") && attributes(line.slice(11)).get("METHOD") !== "NONE",
      )
  )
    throw hlsSubsetFailure();
  let sequence = 0;
  let epoch = 0;
  let target = 6;
  let duration: number | null = null;
  const segments: Segment[] = [];
  for (const line of text.split(/\r?\n/).map((line) => line.trim())) {
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) sequence = Number(line.split(":")[1]);
    else if (line.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE:")) epoch = Number(line.split(":")[1]);
    else if (line === "#EXT-X-DISCONTINUITY") epoch++;
    else if (line.startsWith("#EXT-X-TARGETDURATION:")) target = Number(line.split(":")[1]);
    else if (line.startsWith("#EXTINF:")) duration = Number(line.slice(8).split(",")[0]);
    else if (line && !line.startsWith("#")) {
      if (
        duration === null ||
        !Number.isFinite(duration) ||
        duration <= 0 ||
        duration > 120 ||
        !Number.isSafeInteger(sequence) ||
        sequence < 0 ||
        !Number.isSafeInteger(epoch) ||
        epoch < 0 ||
        segments.length >= SEGMENTS
      )
        malformed();
      segments.push({ address: addressOf(line, base), sequence: sequence++, epoch, duration });
      duration = null;
    }
  }
  if (!segments.length || !Number.isFinite(target) || target <= 0 || target > 120) malformed();
  return { segments, target, ended: /^#EXT-X-ENDLIST\s*$/m.test(text) };
}

/** Resolve one media rendition and inspect its first segment without starting a second reader. */
export async function openHlsTsInput(
  root: string,
  open: HlsResource,
  signal: AbortSignal,
  archive: boolean,
  preferred: string | null,
): Promise<HlsTsInput> {
  const closed = new AbortController();
  const lifetime = AbortSignal.any([signal, closed.signal]);
  let held: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const close = async () => {
    closed.abort();
    await held?.cancel().catch(() => {});
  };
  try {
    let selected = root;
    const rootAnswer = await open(selected, lifetime);
    selected = rootAnswer.url || selected;
    let text = await playlist(rootAnswer, lifetime);
    if (/^#EXT-X-STREAM-INF:/m.test(text)) {
      const lines = text.split(/\r?\n/).map((line) => line.trim());
      const renditions = lines
        .filter((line) => line.startsWith("#EXT-X-MEDIA:"))
        .map((line) => attributes(line.slice(13)));
      const variants = lines.flatMap((line, index) => {
        if (!line.startsWith("#EXT-X-STREAM-INF:")) return [];
        const attrs = attributes(line.slice(18));
        const uri = lines[index + 1];
        if (!uri || uri.startsWith("#")) malformed();
        const height = Number(attrs.get("RESOLUTION")?.split("x")[1]) || 0;
        return [
          {
            address: addressOf(uri, selected),
            attrs,
            height,
            bandwidth: Number(attrs.get("BANDWIDTH")) || Infinity,
          },
        ];
      });
      const eligible = variants.filter((v) => v.height <= 1080);
      const chosen =
        eligible.find((v) => v.address === preferred) ??
        eligible.toSorted(
          (a, b) =>
            b.height - a.height || a.bandwidth - b.bandwidth || a.address.localeCompare(b.address),
        )[0];
      if (!chosen) throw hlsSubsetFailure();
      if (
        renditions.some(
          (r) =>
            r.get("TYPE") === "AUDIO" &&
            r.has("URI") &&
            r.get("GROUP-ID") === chosen.attrs.get("AUDIO"),
        )
      )
        throw hlsSubsetFailure();
      if (/^#EXT-X-SESSION-KEY:/m.test(text)) throw hlsSubsetFailure();
      selected = chosen.address;
      const mediaAnswer = await open(selected, lifetime);
      selected = mediaAnswer.url || selected;
      text = await playlist(mediaAnswer, lifetime);
      if (/^#EXT-X-STREAM-INF:/m.test(text)) malformed();
    }
    let list = media(text, selected);
    let nextSequence =
      archive || list.ended
        ? list.segments[0]!.sequence
        : list.segments[Math.max(0, list.segments.length - 3)]!.sequence;
    let elapsed = 0;
    let done = false;
    let lastRefresh = performance.now();
    let stagnant = 0;
    const nextSegment = async (): Promise<Segment | null> => {
      for (;;) {
        lifetime.throwIfAborted();
        const next = list.segments.find((segment) => segment.sequence >= nextSequence);
        if (next) {
          if (next.sequence !== nextSequence) {
            // Reconnect live playback at the current window, but never skip archive media.
            if (!archive && !list.ended)
              throw new HlsInputFailure({
                kind: "network",
                detail: "The HLS playlist moved past the next segment.",
              });
            malformed();
          }
          nextSequence++;
          stagnant = 0;
          return next;
        }
        if (list.ended) return null;
        const delay = Math.max(
          0,
          lastRefresh + Math.max(250, list.target * 500) - performance.now(),
        );
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            lifetime.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, delay);
          lifetime.addEventListener("abort", finish, { once: true });
        });
        lifetime.throwIfAborted();
        list = media(await playlist(await open(selected, lifetime), lifetime), selected);
        lastRefresh = performance.now();
        if (++stagnant > 6)
          throw new HlsInputFailure({
            kind: "network",
            detail: "The HLS playlist stopped advancing.",
          });
      }
    };
    const inspect = async (segment: Segment, initial = false) => {
      const answer = await open(segment.address, lifetime);
      const reader = answer.body?.getReader();
      if (!reader) malformed();
      held = reader;
      const inspector = createInspector();
      const head: Uint8Array[] = [];
      let size = 0;
      let layout: StreamLayout | null = null;
      let signature: string | null = null;
      let settled = false;
      const deadline = performance.now() + 2500;
      while (size < PREFIX_BYTES) {
        lifetime.throwIfAborted();
        const next = await readPart(reader, lifetime, Math.max(1, deadline - performance.now()));
        if (next.done) break;
        head.push(next.value);
        size += next.value.length;
        const found = inspector.push(next.value);
        layout = found?.layout ?? layout;
        signature = found?.signature ?? signature;
        settled = found?.open.length === 0;
        if (found && (!initial || settled) && size >= 32 * 1024) break;
        if (inspector.notTransportStream) break;
      }
      if (
        !layout ||
        !signature ||
        layout.pcrPid === undefined ||
        (!layout.video && !layout.audio.length)
      )
        throw hlsSubsetFailure();
      if (initial && !settled)
        throw new HlsInputFailure({
          kind: "unsupported",
          detail: "The HLS tracks could not be determined.",
          diagnostic: {
            diagnostic_stage: "inspect",
            diagnostic_reason: "inspection_undetermined",
            diagnostic_container: "hls",
          },
        });
      return {
        segment,
        reader,
        head,
        layout: { ...layout, pcrPid: layout.pcrPid },
        signature,
        size,
      };
    };
    let pending = await inspect((await nextSegment())!, true);
    const firstLayout = pending.layout;
    async function* epochs(): AsyncGenerator<HlsTsEpoch> {
      try {
        while (!done) {
          const first = pending;
          const signature = first.signature;
          let consumed = false;
          const chunks = (async function* () {
            for (;;) {
              const current = pending;
              let size = current.size;
              try {
                yield* current.head;
                for (;;) {
                  lifetime.throwIfAborted();
                  const next = await readPart(current.reader, lifetime);
                  if (next.done) break;
                  size += next.value.length;
                  if (size > SEGMENT_BYTES) malformed();
                  yield next.value;
                }
              } finally {
                await current.reader.cancel().catch(() => {});
                if (held === current.reader) held = null;
              }
              elapsed += current.segment.duration;
              const segment = await nextSegment();
              if (!segment) {
                done = true;
                consumed = true;
                return;
              }
              pending = await inspect(segment);
              if (
                segment.epoch !== first.segment.epoch ||
                pending.layout.programPid !== first.layout.programPid ||
                pending.signature !== signature
              ) {
                consumed = true;
                return;
              }
            }
          })();
          yield { layout: first.layout, startS: elapsed, chunks };
          if (!consumed) {
            await chunks.return();
            return;
          }
        }
      } finally {
        await close();
      }
    }
    return { selected, firstLayout, prefix: pending.head, epochs: epochs(), close };
  } catch (cause) {
    await close();
    throw cause;
  }
}
