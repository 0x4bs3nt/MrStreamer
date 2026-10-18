// Reads the start of an MPEG-TS stream to learn which tracks it carries, before any byte reaches
// the player. The program tables name each track's format, language and, for teletext and DVB
// subtitles, their pages; for MPEG audio, HEVC and AAC the first frame header adds what the tables
// leave open: MP2 or MP3, 8 or 10-bit, the channel layout.
import type { Codec } from "@mrstreamer/contracts/playback";

const PACKET = 188;
const SYNC = 0x47;

interface Track {
  readonly pid: number;
  readonly codec: Codec | "unknown";
}

interface AudioStream extends Track {
  /** ISO 639-2 code from the program table, or null. */
  readonly language: string | null;
  /** Describes the picture for viewers who can't see it. */
  readonly description: boolean;
}

/** A teletext subtitle page, or the pictures of a DVB subtitle page. */
interface SubtitleStream {
  readonly pid: number;
  readonly format: "teletext" | "picture";
  /** Teletext: the page, 888. DVB: the composition page. */
  readonly page: number;
  readonly language: string | null;
  readonly hearingImpaired: boolean;
}

/** The tracks of the first program, in the order its table lists them. */
export interface StreamLayout {
  /** The pid of the program table, which names the tracks. */
  readonly programPid: number;
  /** The current program clock, which can move to another PID at an HLS epoch. */
  readonly pcrPid?: number;
  readonly video: Track | null;
  readonly audio: readonly AudioStream[];
  readonly subtitles: readonly SubtitleStream[];
}

/** A track whose codec needs a look at its first frame. */
type Pending = "mpeg-audio" | "hevc" | "aac";

/** The codecs a pending track can turn out to be. */
const CANDIDATES: Record<Pending, readonly Codec[]> = {
  "mpeg-audio": ["mp2", "mp3"],
  hevc: ["hevc", "hevc-10bit"],
  aac: ["aac", "aac-pce"],
};

/** The tracks so far. `open` lists what each still undetermined track may turn out to be. */
export interface Inspection {
  /** PMT identity, unchanged by packet-dependent codec refinements. */
  readonly signature: string;
  readonly layout: StreamLayout;
  readonly open: readonly (readonly Codec[])[];
}

/**
 * Feed chunks from the start of a stream. Once the program table has arrived, `push` returns the
 * tracks, and `open` lists the ones whose first frame has not shown its exact codec yet; the
 * layout assumes the variant that needs the most help for those. Null means no table yet, and
 * `notTransportStream` tells when the data is something else, such as a raw radio stream.
 */
export function createInspector() {
  let carry = new Uint8Array(0);
  /** Bytes seen before the packet boundaries were found. */
  let unaligned = 0;
  let aligned = false;
  let pmtPid: number | null = null;
  let table: ProgramTable | null = null;
  /** Payload collected from the first PES packet of each pending track. */
  const payloads = new Map<number, Uint8Array>();

  function inspection(): Inspection | null {
    if (!table || pmtPid === null) return null;
    const settled = (track: TableTrack) => ({
      pid: track.pid,
      codec: track.pending ? fallback(track.pending) : track.codec,
    });
    const video = table.tracks.find((track) => track.kind === "video");
    return {
      signature: table.signature,
      layout: {
        programPid: pmtPid,
        pcrPid: table.pcrPid,
        video: video ? settled(video) : null,
        audio: table.tracks
          .filter((track) => track.kind === "audio")
          .map((track) => ({
            ...settled(track),
            language: track.language,
            description: track.description,
          })),
        subtitles: table.subtitles,
      },
      open: table.tracks.flatMap((track) => (track.pending ? [CANDIDATES[track.pending]] : [])),
    };
  }

  function packet(bytes: Uint8Array): void {
    const pid = ((bytes[1]! & 0x1f) << 8) | bytes[2]!;
    const start = (bytes[1]! & 0x40) !== 0;
    const adaptation = (bytes[3]! >> 4) & 0x03;
    let offset = 4;
    if (adaptation === 2) return;
    if (adaptation === 3) offset += 1 + bytes[4]!;
    if (offset >= PACKET) return;
    const payload = bytes.subarray(offset);

    if (pid === 0 && start && pmtPid === null) pmtPid = parsePat(payload);
    else if (pid === pmtPid && start && table === null) table = parsePmt(payload);
    else if (table) {
      const track = table.tracks.find((entry) => entry.pid === pid);
      if (!track?.pending) return;
      const collected = payloads.get(pid);
      if (!collected && !start) return;
      const joined = collected ? concat(collected, payload) : payload;
      payloads.set(pid, joined);
      const codec = examine(track.pending, pesData(joined));
      if (codec) {
        track.codec = codec;
        track.pending = null;
      } else if (joined.length > (track.kind === "video" ? 1024 : 64) * 1024) {
        track.codec = fallback(track.pending);
        track.pending = null;
      }
    }
  }

  return {
    push(chunk: Uint8Array): Inspection | null {
      const data = carry.length ? concat(carry, chunk) : chunk;
      let offset = align(data);
      if (offset < 0) {
        // Too little data to find the packet boundaries yet: keep the tail for the next chunk.
        unaligned += chunk.length;
        carry = data.subarray(Math.max(0, data.length - 3 * PACKET)).slice();
        return null;
      }
      aligned = true;
      while (offset + PACKET <= data.length) {
        if (data[offset] !== SYNC) {
          const next = align(data.subarray(offset));
          if (next < 0) break;
          offset += next;
          continue;
        }
        packet(data.subarray(offset, offset + PACKET));
        offset += PACKET;
      }
      carry = data.subarray(offset).slice();
      return inspection();
    },
    /** True once enough data has passed to be sure it is not MPEG-TS, such as a radio stream. */
    get notTransportStream(): boolean {
      return !aligned && unaligned > 32 * 1024;
    },
  };
}

/** Offset of the first byte that starts three consecutive packets, or -1. */
function align(data: Uint8Array): number {
  for (let offset = 0; offset + 2 * PACKET < data.length; offset++) {
    if (
      data[offset] === SYNC &&
      data[offset + PACKET] === SYNC &&
      data[offset + 2 * PACKET] === SYNC
    ) {
      return offset;
    }
  }
  return -1;
}

/** The PMT pid of the first program in a PAT section. */
function parsePat(payload: Uint8Array): number | null {
  const section = payload.subarray(1 + payload[0]!);
  if (section[0] !== 0x00) return null;
  const length = ((section[1]! & 0x0f) << 8) | section[2]!;
  const end = Math.min(3 + length - 4, section.length);
  for (let offset = 8; offset + 4 <= end; offset += 4) {
    const program = (section[offset]! << 8) | section[offset + 1]!;
    if (program !== 0) return ((section[offset + 2]! & 0x1f) << 8) | section[offset + 3]!;
  }
  return null;
}

interface TableTrack {
  readonly streamType: number;
  readonly pid: number;
  readonly kind: "video" | "audio";
  codec: Codec | "unknown";
  pending: Pending | null;
  readonly language: string | null;
  readonly description: boolean;
}

interface ProgramTable {
  readonly signature: string;
  readonly pcrPid: number;
  readonly tracks: TableTrack[];
  readonly subtitles: readonly SubtitleStream[];
}

function parsePmt(payload: Uint8Array): ProgramTable | null {
  const section = payload.subarray(1 + payload[0]!);
  if (section[0] !== 0x02) return null;
  const length = ((section[1]! & 0x0f) << 8) | section[2]!;
  const end = Math.min(3 + length - 4, section.length);
  const programInfo = ((section[10]! & 0x0f) << 8) | section[11]!;
  const tracks: TableTrack[] = [];
  const subtitles: SubtitleStream[] = [];
  for (let offset = 12 + programInfo; offset + 5 <= end;) {
    const type = section[offset]!;
    const pid = ((section[offset + 1]! & 0x1f) << 8) | section[offset + 2]!;
    const infoLength = ((section[offset + 3]! & 0x0f) << 8) | section[offset + 4]!;
    const descriptors = section.subarray(offset + 5, offset + 5 + infoLength);
    offset += 5 + infoLength;
    const pages = type === 0x06 ? subtitlePages(pid, descriptors) : [];
    if (pages.length > 0) {
      subtitles.push(...pages);
      continue;
    }
    const entry = classify(type, descriptors);
    if (entry) tracks.push({ pid, streamType: type, ...entry, ...audioFacts(descriptors) });
  }
  const pcrPid = ((section[8]! & 0x1f) << 8) | section[9]!;
  return {
    tracks,
    subtitles,
    pcrPid,
    // Capture declared types/descriptors before frame headers refine the mutable tracks.
    signature: JSON.stringify({ tracks, subtitles, pcrPid }),
  };
}

/** The language and purpose a track's descriptors give it. */
function audioFacts(descriptors: Uint8Array): { language: string | null; description: boolean } {
  let language: string | null = null;
  let description = false;
  for (const [tag, body] of descriptorsOf(descriptors)) {
    // ISO 639 language, then the audio type: 3 is commentary for viewers who can't see.
    if (tag === 0x0a && body.length >= 4) {
      language = code(body.subarray(0, 3));
      description ||= body[3] === 0x03;
    }
    // DVB's supplementary audio descriptor: an editorial classification of 1 is a description.
    if (tag === 0x7f && body[0] === 0x06 && body.length >= 2) {
      description ||= ((body[1]! >> 2) & 0x1f) === 0x01;
      if (body[1]! & 0x01 && body.length >= 5) language = code(body.subarray(2, 5));
    }
  }
  return { language, description };
}

/** Teletext subtitle pages and DVB subtitle pages a private data track describes. */
function subtitlePages(pid: number, descriptors: Uint8Array): SubtitleStream[] {
  const pages: SubtitleStream[] = [];
  for (const [tag, body] of descriptorsOf(descriptors)) {
    // Teletext, or VBI teletext: language, type and magazine, page. Types 2 and 5 are subtitles,
    // 5 for viewers who are hard of hearing.
    if (tag === 0x56 || tag === 0x46) {
      for (let entry = 0; entry + 5 <= body.length; entry += 5) {
        const kind = body[entry + 3]! >> 3;
        if (kind !== 0x02 && kind !== 0x05) continue;
        const magazine = body[entry + 3]! & 0x07 || 8;
        const page = magazine * 100 + Number(body[entry + 4]!.toString(16));
        if (!Number.isInteger(page)) continue;
        pages.push({
          pid,
          format: "teletext",
          page,
          language: code(body.subarray(entry, entry + 3)),
          hearingImpaired: kind === 0x05,
        });
      }
    }
    // DVB subtitles: language, type, composition page, ancillary page. Types 0x20 to 0x24 are
    // for viewers who are hard of hearing.
    if (tag === 0x59) {
      for (let entry = 0; entry + 8 <= body.length; entry += 8) {
        const kind = body[entry + 3]!;
        pages.push({
          pid,
          format: "picture",
          page: (body[entry + 4]! << 8) | body[entry + 5]!,
          language: code(body.subarray(entry, entry + 3)),
          hearingImpaired: kind >= 0x20 && kind <= 0x24,
        });
      }
    }
  }
  return pages;
}

/** Each descriptor's tag and body. */
function* descriptorsOf(descriptors: Uint8Array): Generator<readonly [number, Uint8Array]> {
  for (let offset = 0; offset + 2 <= descriptors.length; offset += 2 + descriptors[offset + 1]!) {
    yield [
      descriptors[offset]!,
      descriptors.subarray(offset + 2, offset + 2 + descriptors[offset + 1]!),
    ];
  }
}

/** A three-letter language code, or null for one that isn't letters. */
function code(bytes: Uint8Array): string | null {
  const text = String.fromCharCode(...bytes).toLowerCase();
  return /^[a-z]{3}$/.test(text) ? text : null;
}

/** What a PMT entry is, from its stream type and descriptors. Subtitles and data are skipped. */
function classify(
  type: number,
  descriptors: Uint8Array,
): { kind: "video" | "audio"; codec: Codec | "unknown"; pending: Pending | null } | null {
  switch (type) {
    case 0x01:
    case 0x02:
      return { kind: "video", codec: "mpeg2", pending: null };
    case 0x1b:
      return { kind: "video", codec: "h264", pending: null };
    case 0x24:
      return { kind: "video", codec: "unknown", pending: "hevc" };
    case 0x10:
    case 0xea:
      return { kind: "video", codec: "unknown", pending: null };
    case 0x03:
    case 0x04:
      return { kind: "audio", codec: "unknown", pending: "mpeg-audio" };
    case 0x0f:
      return { kind: "audio", codec: "unknown", pending: "aac" };
    case 0x11:
      return { kind: "audio", codec: "aac-latm", pending: null };
    case 0x81:
      return { kind: "audio", codec: "ac3", pending: null };
    case 0x87:
      return { kind: "audio", codec: "eac3", pending: null };
    case 0x82:
    case 0x85:
    case 0x8a:
      return { kind: "audio", codec: "dts", pending: null };
    case 0x06: {
      const codec = privateCodec(descriptors);
      return codec ? { kind: "audio", codec, pending: null } : null;
    }
    default:
      return null;
  }
}

/** DVB carries AC-3, E-AC-3, DTS and Opus as private data, named by a descriptor. */
function privateCodec(descriptors: Uint8Array): Codec | null {
  for (let offset = 0; offset + 2 <= descriptors.length; offset += 2 + descriptors[offset + 1]!) {
    const tag = descriptors[offset]!;
    if (tag === 0x6a) return "ac3";
    if (tag === 0x7a) return "eac3";
    if (tag === 0x7b) return "dts";
    if (tag === 0x05) {
      const id = String.fromCharCode(...descriptors.subarray(offset + 2, offset + 6));
      if (id === "AC-3") return "ac3";
      if (id === "EAC3") return "eac3";
      if (id.startsWith("DTS")) return "dts";
      if (id === "Opus") return "opus";
    }
  }
  return null;
}

/** The elementary stream bytes of a PES packet, or empty when its header is incomplete. */
function pesData(pes: Uint8Array): Uint8Array {
  if (pes.length < 9 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return new Uint8Array(0);
  return pes.subarray(9 + pes[8]!);
}

/** The codec a first frame reveals, or null when the data does not show it yet. */
function examine(pending: Pending, data: Uint8Array): Codec | null {
  switch (pending) {
    case "mpeg-audio":
      for (let i = 0; i + 1 < data.length; i++) {
        if (data[i] === 0xff && (data[i + 1]! & 0xe0) === 0xe0) {
          const layer = (data[i + 1]! >> 1) & 0x03;
          if (layer === 1) return "mp3";
          if (layer !== 0) return "mp2";
        }
      }
      return null;
    case "aac":
      for (let i = 0; i + 3 < data.length; i++) {
        if (data[i] === 0xff && (data[i + 1]! & 0xf6) === 0xf0) {
          // An ADTS channel configuration of 0 leaves the layout to an in-band element that
          // browsers do not read.
          const channels = ((data[i + 2]! & 0x01) << 2) | (data[i + 3]! >> 6);
          return channels === 0 ? "aac-pce" : "aac";
        }
      }
      return null;
    case "hevc":
      for (const nal of nalUnits(data)) {
        if (((nal[0]! >> 1) & 0x3f) === 33 && nal.length > 3) {
          const profile = nal[3]! & 0x1f;
          return profile === 1 || profile === 3 ? "hevc" : "hevc-10bit";
        }
      }
      return null;
  }
}

/** When a track's first frame never shows up, assume the variant that needs the most help. */
function fallback(pending: Pending): Codec {
  switch (pending) {
    case "mpeg-audio":
      return "mp2";
    case "aac":
      return "aac";
    case "hevc":
      return "hevc-10bit";
  }
}

/** NAL units in Annex B data, each starting at its header byte. */
function* nalUnits(data: Uint8Array): Generator<Uint8Array> {
  let start = -1;
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) yield data.subarray(start, i);
      start = i + 3;
      i += 2;
    }
  }
  if (start >= 0 && start < data.length) yield data.subarray(start);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  return joined;
}
