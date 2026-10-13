// Stream sessions and the loopback proxy that serves them to the UI.
//
// The UI never sees provider URLs: they carry the login. It gets a 127.0.0.1 URL with a random
// token instead. Only one session is open at a time, live or on demand, so switching always
// releases the previous provider connection first. Many subscriptions allow a single connection.
//
// Live: the proxy reads the start of each MPEG-TS stream to learn its codecs. A stream the UI's
// player decodes passes through untouched; otherwise ffmpeg converts only the tracks it cannot
// decode. A channel with several streams, one per quality, can be given more than one to try, as
// Auto is: when the provider doesn't deliver one, the proxy asks for the next, after the request
// before is over, and never after a refusal, which is the account's. Streams that failed in the
// last two minutes go last, so reconnecting doesn't wait for one again. An HLS stream, as
// playlists list them, passes through playlist by playlist and segment by segment, its addresses
// replaced by the proxy's (see ../playback/hls.ts).
//
// Movies and episodes (see ../playback/title.ts): the proxy serves the provider's file to ffprobe
// and ffmpeg over loopback, answering byte ranges, one upstream request at a time. Each request
// from the player runs ffmpeg from a position with the chosen tracks, and replaces the run before.
// With subtitles on, the player also asks for their feed, and the picture doesn't wait for it:
// packet state from before the position, as far back as the subtitles on screen there depend
// on, then what the run reads. Independent text goes on while that past is recovered.
// The proxy keeps what each run reads of a track
// (see ../playback/subtitle-history.ts) and reads the rest from the file itself, only the track's
// packets (see ../playback/matroska.ts), when playback spares the provider and no more than a
// bounded amount (see ../playback/upstream.ts). What can't be had that way leaves the subtitles
// unavailable for the position, never the picture. All it keeps is of one file: when an answer
// shows the provider put another behind the address, it starts afresh
// (see ../playback/source-identity.ts).
//
// A receiver on the local network, a TV the viewer sends playback to, has no player of ours. A
// session opened for one is the same single session, served a second way: as HLS on an address of
// this computer on that network, which exists only while the session does and answers only that
// session's playlists and segments, under a token of its own. A channel's MPEG-TS goes through
// ffmpeg into segments; a channel's HLS has its playlists pointed at that address; a movie gets a
// complete playlist and its segments made as the receiver asks for them (see
// ../playback/receiver.ts). Everything ffmpeg and ffprobe read and report stays on loopback.
//
// A downloaded copy plays the way a title does, from a file on this computer in place of the
// provider's (see ../playback/file-source.ts): the same probe, runs, tracks and subtitles, with no
// subscription, provider or catalogue asked. Its session is of no subscription and closes nothing
// a receiver plays.
//
// PlaybackCoordination owns admission and lends a provider connection to Downloads only while
// nothing of that subscription plays. Every open of a provider's stream takes it back first,
// in its turn, and goes on only once the download's request is over and its file closed:
// playback comes first, and the provider never sees the download and the stream at once. An open
// whose download doesn't let go in time fails, to be asked again. Another subscription's download
// goes on.
//
// Each session is a scope within the service's. Closing it, by stopping, switching or quitting,
// aborts its upstream requests, which ends their ffmpeg processes; the proxy closes with the
// service.
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable, Transform } from "node:stream";
import type { CopySession } from "@mrstreamer/contracts/downloads";
import type { RawTitleRef, TitleRef } from "@mrstreamer/contracts/ondemand";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import type {
  AudioTrack,
  ChannelTracks,
  Codec,
  LivePlaying,
  StreamFailure,
  StreamFormat,
  StreamSession,
  SubtitleTrack,
  TitleSession,
} from "@mrstreamer/contracts/playback";
import { audioTracks, languageCode, subtitleTracks } from "@mrstreamer/core/ondemand/tracks";
import { Diagnostics } from "@mrstreamer/core/diagnostics";
import { PlaybackCoordination } from "./playback-coordination.ts";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import type { Provider } from "@mrstreamer/core/provider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import { VerifiedFiles } from "../platform/verified-files.ts";
import { SavedSubtitles, subtitlesOfCopy, type SubtitleFile } from "../platform/saved-subtitles.ts";
import { fileRequest } from "../playback/file-source.ts";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { createCleanStart } from "../playback/clean-start.ts";
import { ffmpegArguments, planConversion, type Conversion } from "../playback/convert.ts";
import { createInspector, type Inspection, type StreamLayout } from "../playback/inspect.ts";
import { CAPTION_PID, createCaptionCopy } from "../playback/caption-stream.ts";
import {
  hlsAddresses,
  isMultivariant,
  PLAYLIST_START,
  rewritePlaylist,
  startsPlaylist,
} from "../playback/hls.ts";
import { isPrivateAddress } from "../playback/lan.ts";
import { mp4Keyframes } from "../playback/mp4-index.ts";
import { createAudioChoice } from "../playback/program-table.ts";
import {
  convertPlan,
  copyPlan,
  listedSegments,
  livePlaylist,
  liveSegmentArguments,
  masterPlaylist,
  pictureSpan,
  runCuts,
  SEGMENT_S,
  segmentSpan,
  subtitleSegment,
  titlePlaylist,
  type LiveSegments,
  type SegmentPlan,
} from "../playback/receiver.ts";
import {
  SEGMENT_LIMITS,
  segmentStore,
  type SegmentLimits,
  type SegmentStore,
} from "../playback/segment-store.ts";
import { captionsInPicture, captionsInTrack } from "@mrstreamer/core/subtitles/captions";
import { freshStart } from "@mrstreamer/core/subtitles/decoder";
import { dvbClears } from "@mrstreamer/core/subtitles/dvb";
import type { SubtitleFeedLine, SubtitlesUnavailable } from "@mrstreamer/core/subtitles/feed";
import { pgsSegments } from "@mrstreamer/core/subtitles/pgs";
import { pesReader, type PesPacket } from "@mrstreamer/core/subtitles/transport";
import { webvttReader, type Cue } from "@mrstreamer/core/subtitles/webvtt";
import { t } from "@mrstreamer/core/i18n";
import { fileWindows, type FileWindows } from "../playback/file-windows.ts";
import { blocks, readLayout, selected, type Layout, type ReadFile } from "../playback/matroska.ts";
import {
  sourceIdentity,
  type FileProof,
  type Held,
  type SourceIdentity,
} from "../playback/source-identity.ts";
import {
  nextScan,
  replayFor,
  subtitleHistory,
  type Need,
  type SubtitleEntry,
  type SubtitleHistory,
  type TrackIndex,
} from "../playback/subtitle-history.ts";
import {
  firstPacketTime,
  PROBE_ARGUMENTS,
  readProbe,
  receiverPlan,
  selectedPlan,
  subtitleOutput,
  titlePlan,
  type SubtitleOutput,
  type TitleProbe,
  type TitleRun,
} from "../playback/title.ts";
import {
  rateMeter,
  UPSTREAM_LIMITS,
  upstreamSlot,
  type Progress,
  type UpstreamLimits,
  type UpstreamSlot,
} from "../playback/upstream.ts";
import { Subscriptions, type Source } from "./subscription.ts";

/** How long the provider gets to start answering before the stream counts as failed. */
const CONNECT_TIMEOUT_MS = 15_000;
/** Waits before retrying a refused stream. Providers can take a moment to free the slot of a stream we just closed. */
const REFUSED_RETRY_DELAYS_MS = [500, 1500];
/**
 * The same for a movie's file, which ffmpeg reads in several ranges one after the other: a seek
 * closes one request and opens the next at once, so the first retry comes sooner.
 */
const FILE_RETRY_DELAYS_MS = [150, 400, 1000, 2000];
/** Video codecs whose streams start on a keyframe; see ../playback/clean-start.ts. */
const CLEAN_START_CODECS: ReadonlySet<Codec> = new Set(["h264", "hevc", "hevc-10bit"]);
/** The longest HLS playlist the proxy reads; live ones are a few kilobytes. */
const PLAYLIST_LIMIT = 4 * 1024 * 1024;
/** How much of a stream the proxy reads, at most, before deciding how to deliver it. */
const INSPECT_LIMIT = { bytes: 2 * 1024 * 1024, ms: 2500 };
/** How long ffprobe may take to read what a movie's file holds. */
const PROBE_TIMEOUT_MS = 30_000;
/** How long a run may take to show where its picture starts, before it counts as failed. */
const RUN_START_TIMEOUT_MS = 30_000;
/** Probes kept for files opened again, such as when resuming. */
const PROBES_KEPT = 32;
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
/**
 * The readings one position may take. Each reaches further back, the thirteenth from the start of
 * the file at the latest, so more than these means what they read doesn't stay read.
 */
const SCANS_LIMIT = 16;
/** What reading a subtitle track's past may take, for one position. */
interface RecoveryLimits {
  /** Bytes of the provider's file, and requests for them. */
  readonly bytes: number;
  readonly requests: number;
  /** Milliseconds, waiting for turns at the provider included. */
  readonly ms: number;
  /** Bytes of the file kept in memory, of the track's packets taken from one stretch, and of the track's subtitles. */
  readonly kept: number;
  readonly selected: number;
  readonly history: number;
  /**
   * How much of the file one request asks for: what arrives in about `WINDOW_S`, so it is soon
   * over when playback wants the provider back, within these bounds.
   */
  readonly windowLeast: number;
  readonly windowMost: number;
}

const RECOVERY_LIMITS: RecoveryLimits = {
  bytes: 8 * 1024 * 1024,
  requests: 256,
  ms: 30_000,
  kept: 8 * 1024 * 1024,
  selected: 4 * 1024 * 1024,
  history: 4 * 1024 * 1024,
  windowLeast: 16 * 1024,
  windowMost: 256 * 1024,
};
/** See `RecoveryLimits.windowLeast`; and the window before anything was measured. */
const WINDOW_S = 0.05;
const WINDOW_FIRST = 64 * 1024;
/** The same for playback's requests meanwhile: about a second's worth. */
const PART_BYTES = { least: 512 * 1024, most: 4 * 1024 * 1024, first: 1024 * 1024 } as const;
/**
 * How long ffmpeg may leave what it was sent before playback counts as resting: it reads in
 * bursts, a few milliseconds apart, while the player wants more, and not at all once the player
 * has enough buffered or is paused.
 */
const REST_MS = 300;
/** How long the proxy waits for what an ffmpeg that has ended sent it over loopback. */
const REPORT_WAIT_MS = 2000;
/** How much of what a run reads of its subtitle track is kept for a feed that becomes ready. */
const LIVE_BYTES = 2 * 1024 * 1024;
/** How much of a feed may wait for a player that doesn't read it. */
const FEED_WAITING_BYTES = 2 * 1024 * 1024;
/** How long a channel's stream that failed goes after its others when Auto tries them again. */
const FAILED_STREAM_MS = 2 * 60_000;
/**
 * What a receiver may ask the address on the local network for: a session's playlists, and the
 * segments, subtitles and HLS addresses those name. Nothing else has a path there.
 */
const RECEIVER_ROUTE =
  /^\/r\/([\w-]+)\/(?:(master|video|subs|live)\.m3u8|v(\d{1,6})\.ts|s(\d{1,6})\.vtt|l(\d{1,9})\.ts|h((?:subs-)?[0-9a-z]{1,12}))$/;
/** What reading where a movie's keyframes are may take of the provider, before any of it plays. */
const INDEX_LIMITS = { bytes: 24 * 1024 * 1024, requests: 96, ms: 20_000 } as const;
/** A run for a receiver that hasn't asked for anything this long ends, as a long pause does here. */
const RECEIVER_IDLE_MS = 5 * 60_000;
/** How long a receiver's request for a segment's subtitles waits for the run to have read them. */
const CUES_WAIT_MS = 15_000;
/**
 * How long a receiver's request for a segment waits for it to be made. A provider or an ffmpeg
 * that takes longer has stopped: the request ends, and so does the run.
 */
const SEGMENT_WAIT_MS = 30_000;
/** The lines of a channel's playlist for a receiver, and how many it needs before it is given out. */
const LIVE_LIST = { kept: 6, least: 2 } as const;
/** How long a receiver's request for a channel's playlist waits for its first segments. */
const LIVE_START_MS = 20_000;
/** The most one segment of a channel may hold; a few megabytes is usual. */
const LIVE_SEGMENT_BYTES = 48 * 1024 * 1024;

interface SessionBase {
  readonly id: string;
  readonly token: string;
  /** What the UI's player decodes. */
  readonly decoders: ReadonlySet<Codec>;
  /** Requests the upstream addresses through the provider, which never sends the login unencrypted. */
  readonly request: Provider["request"];
  /** Aborts every upstream request of this session when its scope closes. */
  readonly closed: AbortController;
  readonly scope: Scope.Closeable;
  /** The request currently being served. A new request for the same session replaces it. */
  active: AbortController | null;
  failure: StreamFailure | null;
  /** Where a receiver plays the session from, when one does. */
  readonly lan: Lan | null;
}

/** A session's address on the local network, for the receiver that plays it. */
interface Lan {
  /** "http://192.168.1.20:49152" */
  readonly origin: string;
  /** How often the receiver asked for something of the session: none means it can't reach here. */
  requests: number;
  /** Tells whoever opened the session that its stream can't go on; see `ReceiverTarget.failed`. */
  readonly failed: (failure: StreamFailure) => void;
}

/** A receiver on the local network that plays a session, in place of the UI's player. */
export interface ReceiverTarget {
  /** This computer's address on the network the receiver is on. */
  readonly address: string;
  /** What the receiver decodes; the proxy converts the rest. */
  readonly decoders: readonly Codec[];
  /** Hears that the session closed, whoever closed it. */
  readonly closed?: () => void;
  /**
   * Hears that the stream can't go on though the session is open: the provider stopped sending
   * a title's file, or put another file behind its address. What the receiver asks for next
   * fails; opening the title again reads it afresh.
   */
  readonly failed?: (failure: StreamFailure) => void;
}

/** A channel's stream as a receiver plays it. */
export interface ReceiverStream {
  readonly sessionId: string;
  readonly channel: OwnedId;
  /** An HLS playlist on this computer's address on the local network. Carries no login. */
  readonly url: string;
}

/** A movie or episode opened for a receiver: what its file holds, before anything plays. */
export interface ReceiverTitle {
  readonly sessionId: string;
  readonly title: TitleRef;
  /** Seconds. */
  readonly duration: number;
  readonly audio: readonly AudioTrack[];
  readonly subtitles: readonly SubtitleTrack[];
  /**
   * Seconds between the start of the title and its first picture, where a receiver's clock
   * starts: added to a position the receiver names, it gives seconds into the title.
   */
  readonly offset: number;
}

/** What a receiver plays of a channel, besides what the session holds for the UI's player. */
interface LiveReceiver {
  readonly token: string;
  /** MPEG-TS: the segments ffmpeg made lately, by number. */
  readonly made: Map<number, Buffer>;
  /** The playlist's lines; `fresh` where the provider's stream started again. */
  list: { readonly index: number; readonly length: number; readonly fresh: boolean }[];
  /** The ffmpeg whose segments count, by the id in their address, and its first segment. */
  run: string | null;
  first: number;
  /** The stream is over: the provider ended it, or it failed. */
  over: boolean;
  /** Heard when the playlist grew or the stream ended. */
  readonly changed: Set<() => void>;
}

/** What a receiver plays of a movie or episode. */
interface TitleReceiver {
  /** Where its segments start; its picture copied, or converted once copying can't keep to them. */
  plan: SegmentPlan;
  /** Where the plan's starts come from, for the diagnostics. */
  readonly index: "cues" | "samples" | "none";
  /** What the receiver was last sent: the tracks chosen, under a token of their own. */
  load: TitleLoad | null;
}

/** One load of a title on a receiver: a playlist for the chosen tracks, and its segments. */
interface TitleLoad {
  readonly token: string;
  readonly audio: number | null;
  /** A text subtitle track, or null. */
  readonly subtitle: number | null;
  readonly store: SegmentStore;
  /** Aborts when another load takes its place, or the session closes. */
  readonly closed: AbortController;
  run: ReceiverRun | null;
  /** Ends the run when the receiver asks for nothing for a long time. */
  idle: ReturnType<typeof setTimeout> | undefined;
  /** Heard when a segment arrived, a run ended, or subtitles were read. */
  readonly changed: Set<() => void>;
}

/** One ffmpeg making a title's segments in order, from one of them on. */
interface ReceiverRun {
  readonly id: string;
  /** Its first segment, and how many it makes that end where the playlist says. */
  readonly from: number;
  readonly count: number;
  /** The segment being taken from it, or the next to come. */
  next: number;
  ended: boolean;
  readonly signal: AbortSignal;
  /** Ends it: the receiver went elsewhere, or paused for long. */
  stop(): void;
  /** The text subtitles it has read, on the file's clock. */
  readonly cues: SubtitleEntry[];
  /** What the track holds from before the run's start, or null when that can't be had. */
  readonly before: Promise<Before | null>;
  /** Told once its first segment is whole: the provider is no longer the run's alone. */
  settled?: () => void;
}

interface LiveSession extends SessionBase {
  readonly kind: "live";
  readonly channel: OwnedId;
  /**
   * The channel's streams to try, in order, with their upstream addresses and the headers each
   * wants on every request, such as a playlist's User-Agent.
   */
  readonly variants: readonly {
    readonly id: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  }[];
  /** Which stream plays, and those that failed before it: see `Playback.playing`. */
  delivered: LivePlaying;
  readonly format: StreamFormat;
  /** HLS: the upstream addresses its playlists named, by the id in their proxy address. */
  readonly hls: ReturnType<typeof hlsAddresses> | null;
  /** HLS: the proxy address that stands for an id, for whoever plays the session. */
  readonly proxied: (id: string) => string;
  /** What a receiver plays of it, when one does. */
  readonly receiver: LiveReceiver | null;
  /** Re-encode the picture even when the player could decode it; see `open`. */
  readonly repair: boolean;
  /** The sound track chosen by PID, or null for the channel's first. */
  readonly audio: number | null;
  /** Without a chosen track, the language whose sound plays when the channel has it. */
  readonly audioLanguage: string | null;
  /** The tracks the stream carries, once it has been inspected. */
  layout: StreamLayout | null;
  /** The sound track the stream plays, by PID, once the delivery is planned. */
  playing: number | null;
  /** The caption channels found in the pictures so far, 1 and 3. */
  captions: readonly number[];
}

/**
 * Main-only handle. Closing or replacing the exact file cancels subtitle work. A provider's file
 * names its title, which the catalogue says is still listed; a copy is its own file.
 */
export type SubtitlePlayback = {
  readonly file: SubtitleFile;
  readonly signal: AbortSignal;
  readonly standing: Effect.Effect<boolean, Failed>;
  /** What proves which bytes play, while the file's answers say; null for a copy's. */
  readonly proof: () => FileProof | null;
} & ({ readonly kind: "provider"; readonly title: TitleRef } | { readonly kind: "copy" });

/** A downloaded copy, as playback opens it: one exact file on this computer. */
export interface LocalCopy {
  readonly id: string;
  /** Never leaves the main process. */
  readonly path: string;
  readonly container: string;
  /** The provider's ids of the file it was made from, which its saved subtitles are kept under. */
  readonly title: RawTitleRef;
  /** How far it was watched here, as kept when it was asked for. */
  readonly progress: CopySession["progress"];
}

/** Durable track-fact identity, supplied only after resolving a current listed file. */
interface Verified {
  readonly account: string;
  readonly sourceStamp: string;
  readonly fileKey: string;
  readonly listingKey: string;
}

/** Whose file a title session plays: a provider's, through its subscription, or a copy's. */
type TitleOrigin =
  | { readonly kind: "provider"; readonly title: TitleRef; readonly verified: Verified | null }
  | { readonly kind: "copy"; readonly copy: string; readonly file: SubtitleFile };

interface TitleSessionState extends SessionBase {
  readonly subtitleFileChanged: AbortController;
  readonly kind: "title";
  readonly origin: TitleOrigin;
  readonly upstreamUrl: string;
  /** Resolved headers of this exact file, shared by probing, playback and receivers. */
  readonly headers: Headers;
  /** Probe reuse belongs to this file and saved source, including its request headers. */
  readonly probeKey: string;
  /** What the file holds, as ffprobe read it when the title opened. */
  probe: TitleProbe | null;
  /**
   * Which of the files behind the address ffprobe read; see `SourceIdentity.generation`. A
   * receiver's playlist is of that file, and its load ends once an answer is of another.
   */
  probed: number;
  /** The upstream request serving ffprobe or ffmpeg. A new one replaces it. */
  source: AbortController | null;
  /** Last prefix byte dropped by serveSource, including the last byte before playback. */
  readForwardAt: number | null;
  /** Last reading-ahead notice, so even consecutive source requests send at most one per 3 s. */
  readAheadNotifiedAt: number | null;
  /** Whose turn it is at the provider: one request at a time, playback first. */
  readonly slot: UpstreamSlot;
  /** How fast the file arrives. */
  readonly meter: ReturnType<typeof rateMeter>;
  /** What the provider's answers say of the file, and whether it is still the same one. */
  readonly identity: SourceIdentity;
  /** What the session keeps of that file for its subtitles. Another file gets a new one. */
  kept: FileKept;
  /** The run whose picture hasn't reached the player yet, and the one that hasn't ended. */
  starting: AbortController | null;
  running: AbortController | null;
  /** How many feeds are reading the file for what came before their position. */
  recovering: number;
  /** How many of ffmpeg's requests for the file are being taken, rather than left waiting. */
  reading: number;
  /** What the player last said of its buffer. */
  progress: Progress | null;
  /** Where each ffmpeg's reports go, by the id in their address. */
  readonly reports: Map<string, Reports>;
  /** The player's subtitle feed, which gets what the run reads of its track. */
  feed: Feed | null;
  /** What the run has read of its subtitle track. */
  live: Live | null;
  /** What a receiver plays of it, when one does. */
  receiver: TitleReceiver | null;
}

type Session = LiveSession | TitleSessionState;

/**
 * What a session knows and keeps of the provider's file, for as long as it stays the same file.
 * When the provider puts another behind the address the session starts a new one, so whoever
 * still holds this one can tell that what it read was of a file that is gone.
 */
interface FileKept {
  /** The parts of the file read for a subtitle track's past. */
  readonly windows: FileWindows;
  /** What has been read of the subtitle track the player shows, by its id. */
  readonly histories: Map<number, SubtitleHistory>;
  /** What the file's descriptions say, once read; Matroska only. */
  layout: Layout | null;
  /**
   * How many of the provider's servers had answered for the file when this was last read for, or
   * when the file's first answer that says what it holds came (see `observe`). Zero before it.
   */
  servers: number;
}

/** What an ffmpeg sends the proxy besides the picture. */
interface Reports {
  /** Takes the subtitles as they arrive. */
  readonly subtitles?: (request: IncomingMessage) => void;
  /** A run's first video packet, which says where its picture starts. */
  readonly start?: TextRelay;
}

/** What a run has read of its subtitle track, for the feeds that join it. */
interface Live {
  readonly track: number;
  /**
   * The run brings every entry of the track after this time on the file's clock: a little after
   * its position. A feed for an earlier position isn't this run's.
   */
  readonly since: number;
  /** Every entry after this time is in `entries`: `since`, until the oldest had to go. */
  from: number;
  entries: SubtitleEntry[];
  bytes: number;
}

/** One reading of a subtitle track's past: when it is over, and what it took of the provider. */
interface Attempt {
  /** The player left, the session closed, or the reading ran out of time. */
  readonly signal: AbortSignal;
  readonly spent: Spent;
  /**
   * The stretch being stepped through is more of the file than the reading has left to take, so
   * each request asks for the least: a block's header and what little follows it.
   */
  narrow: boolean;
}

interface Spent {
  bytes: number;
  requests: number;
}

/** A subtitle track's past couldn't be had for a position; `kind` says why. */
class Unavailable extends Error {
  readonly kind: SubtitlesUnavailable;
  constructor(kind: SubtitlesUnavailable) {
    super(kind);
    this.kind = kind;
  }
}

/** The subtitles the player is reading: one track, from one position on. */
interface Feed {
  readonly track: number;
  /**
   * What the run reads of the track after this time on the file's clock goes to the player. Up
   * to it, the history did. Packet feeds wait at Infinity until recovery has that past; text
   * feeds receive the run's independent lines while recovery is under way.
   */
  after: number;
  /** Sends live output from `origin`, skipping exact text this feed still remembers sending. */
  send(entry: SubtitleEntry, origin: number): void;
  /** Ends the feed: the player asked for another. */
  close(): void;
  /** The provider put another file behind the address: what the feed sent is of one that is gone. */
  changed(): void;
}

/** What the player asked a feed for. */
interface FeedRequest {
  readonly track: number;
  /** The teletext page or caption channel, for a track that holds several. */
  readonly page: number | null;
  /** The decoder the player was told for the track's packets; none for text. */
  readonly codec: string;
  /** Seconds into the title. */
  readonly start: number;
}

/** What a track holds before a position that the player needs to start there. */
interface Before {
  readonly entries: readonly SubtitleEntry[];
  /** Up to this time on the file's clock; the run brings what comes after. */
  readonly upTo: number;
  /** The file's clock at the start of the title. */
  readonly origin: number;
}

export interface PlaybackDeps {
  readonly userAgent: string;
  /** The ffmpeg executable that converts streams, or null when this build has none. */
  readonly ffmpeg: string | null;
  /** The ffprobe that reads what movie files hold, or null when this build has none. */
  readonly ffprobe?: string | null;
  /** What reading a subtitle track's past may take, when not the usual amounts. */
  readonly recovery?: Partial<RecoveryLimits>;
  /** How long a local copied-picture start waits without read-forward progress, in ms. */
  readonly runStartMs?: number;
  /** When that reading gets the provider, when not as usual. */
  readonly upstream?: Partial<UpstreamLimits>;
  /**
   * For a receiver's title, when not as usual: how long a run goes on with nothing asked of it,
   * how long a request waits for a segment and for a segment's subtitles, in ms, and how much of
   * the title waits in memory.
   */
  readonly receiver?: {
    readonly idleMs?: number;
    readonly segmentMs?: number;
    readonly cuesMs?: number;
    readonly segments?: Partial<SegmentLimits>;
  };
}

/**
 * What an open is asked under, so that work begun before the viewer moved on opens nothing.
 * `turn` is the one `Playback.begin` gave when the viewer asked: an open whose turn is no longer
 * the latest fails with `superseded` when its own turn at the provider comes, before anything
 * closes, and again once the provider answered it, when what it opened closes. `revision` is the
 * login an address was made under (`SavedSubscription.revision`): one made under a login that
 * changed since isn't opened, nor one whose login changed while its file was read.
 */
export interface Asked {
  readonly turn?: number | undefined;
  readonly revision?: number | undefined;
  /** Main-only headers returned with this exact provider file. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly listingKey?: string | undefined;
}

export class Playback extends Context.Service<
  Playback,
  {
    measurement(
      sessionId: string,
    ): Effect.Effect<{ kind: "live" | "vod"; closed: AbortSignal } | null>;
    /**
     * Begins what the viewer asked to play or stop next, whichever subscription it is of, and
     * names it: a number later asks outgrow. One stream plays at a time across every
     * subscription, so whatever was asked before and hasn't opened yet gives way.
     */
    readonly begin: Effect.Effect<number>;
    /** Whether the viewer asked for something else since `turn` began. */
    passed(turn: number): Effect.Effect<boolean>;
    /**
     * Opens a stream for a channel, at the provider of the subscription it names. Closes any open
     * stream first, of whichever subscription, so no provider ever sees a second connection; a
     * channel of a subscription that isn't saved fails with `no-subscription` before anything
     * closes, and so does one whose login changed while its stream was looked up. `variants` are
     * the channel's streams to try in turn, the channel's id alone when absent. `decoders` lists
     * what the UI's player decodes; the proxy converts the rest. `repair` re-encodes the picture
     * too, for a broadcast the player failed to decode: ffmpeg conceals damage that stops the
     * player.
     *
     * `preview` says nobody chose to watch it, as a page's muted preview. It closes nothing a
     * receiver plays: the open fails while a receiver's session is open, and that is looked at
     * when the open takes its turn, so a receiver that began after it was asked for keeps its
     * stream too.
     */
    open(
      channel: OwnedId,
      decoders: readonly Codec[],
      options?: {
        readonly variants?: readonly string[];
        readonly repair?: boolean;
        readonly audio?: number | null;
        readonly audioLanguage?: string | null;
        readonly preview?: boolean;
        readonly turn?: number | undefined;
      },
    ): Effect.Effect<StreamSession, Failed>;
    /**
     * Opens a movie or episode from its provider file, through the subscription the title names:
     * closes any open stream, reads which tracks the file holds and hands the UI an address to
     * play it from any position. Fails with a `stream` error when the provider refuses the file
     * or it can't play here.
     */
    openTitle(
      title: TitleRef,
      upstreamUrl: string,
      decoders: readonly Codec[],
      asked?: Asked,
    ): Effect.Effect<TitleSession, Failed>;
    /**
     * Opens a downloaded copy from this computer, as `openTitle` opens a provider's file: what
     * plays here closes first, and a receiver's session plays on. Asks no subscription.
     */
    openCopy(
      copy: LocalCopy,
      decoders: readonly Codec[],
      turn?: number,
    ): Effect.Effect<CopySession, Failed>;
    /** Closes what plays a copy, as before it is deleted. */
    closeCopy(copyId: string): Effect.Effect<void>;
    /** The current local title only, with no provider address or request headers. */
    subtitleContext(sessionId: string): Effect.Effect<SubtitlePlayback | null, Failed>;
    /**
     * Ids of title sessions the provider answered with another file than the one they opened, as
     * playback's own reads find out. What was saved for the old file is already forgotten then.
     */
    readonly fileReplaced: Stream.Stream<string>;
    /** Title session ids whose source is advancing through bytes before the asked position. */
    readonly readingAhead: Stream.Stream<string>;
    /**
     * Ids of channel sessions whose `tracks` changed since their stream started: a caption channel
     * was found in its pictures. Never of a closed session, nor for a stream the player has asked
     * for again since.
     */
    readonly tracksChanged: Stream.Stream<string>;
    /** Closes a stream and its provider connection. Unknown or already closed ids are ignored. */
    close(sessionId: string): Effect.Effect<void>;
    /** Closes every open stream, for example when the window closes. */
    readonly closeAll: Effect.Effect<void>;
    /**
     * Closes what plays from one subscription, for when it goes, once any open under way has had
     * its turn. A stream of another subscription plays on.
     */
    closeOf(subscriptionId: string): Effect.Effect<void>;
    /** Why the session's last upstream request failed, or null. */
    failure(sessionId: string): Effect.Effect<StreamFailure | null>;
    /**
     * A channel's sound and subtitle tracks, from its program table; null until its stream has
     * started, and for movies and episodes.
     */
    tracks(sessionId: string): Effect.Effect<ChannelTracks | null>;
    /** Which of a channel's streams the session plays; null for movies and episodes. */
    playing(sessionId: string): Effect.Effect<LivePlaying | null>;
    /**
     * Opens a channel for a receiver on the local network, as `open` does for the UI's player:
     * any open stream closes first. The provider's stream starts at once, so the receiver finds
     * segments when it asks. Fails with `output` when this computer can't serve `receiver`'s
     * address.
     */
    openReceiver(
      channel: OwnedId,
      receiver: ReceiverTarget,
      options?: {
        readonly variants?: readonly string[];
        readonly audio?: number | null;
        readonly audioLanguage?: string | null;
        readonly turn?: number | undefined;
      },
    ): Effect.Effect<ReceiverStream, Failed>;
    /**
     * Opens a movie or episode for a receiver: closes any open stream, reads which tracks the
     * file holds and where its picture has keyframes. Nothing plays until `loadReceiverTitle`.
     * Fails with a `stream` error when the file can't be made into a stream a receiver plays.
     */
    openReceiverTitle(
      title: TitleRef,
      upstreamUrl: string,
      receiver: ReceiverTarget,
      asked?: Asked,
    ): Effect.Effect<ReceiverTitle, Failed>;
    /**
     * The address a receiver plays an open title from with these tracks: a playlist of the whole
     * title, under a token of its own, which replaces the one before. `subtitles` says whether it
     * carries the text subtitles asked for; other kinds don't reach a receiver. Null for a
     * session that isn't a receiver's title.
     */
    loadReceiverTitle(
      sessionId: string,
      tracks: { readonly audio: number | null; readonly subtitle: number | null },
    ): Effect.Effect<{ readonly url: string; readonly subtitles: boolean } | null>;
    /** How often the receiver has asked for something of the session; null when it has none. */
    receiverRequests(sessionId: string): Effect.Effect<number | null>;
  }
>()("mrstreamer/Playback") {
  static readonly layer = (deps: PlaybackDeps) => Layer.effect(Playback, make(deps));
}

function make(deps: PlaybackDeps) {
  return Effect.gen(function* () {
    const subscriptions = yield* Subscriptions;
    const coordination = yield* PlaybackCoordination;
    const diagnostics = yield* Diagnostics;
    // The app provides storage; standalone playback ports can run without a database.
    const verifiedFiles = Option.getOrNull(yield* Effect.serviceOption(VerifiedFiles));
    const savedSubtitles = Option.getOrNull(yield* Effect.serviceOption(SavedSubtitles));
    const replaced = yield* PubSub.unbounded<string>();
    const readingAhead = yield* PubSub.unbounded<string>();
    const tracksChanged = yield* PubSub.unbounded<string>();
    const scope = yield* Effect.scope;
    const sessions = new Map<string, Session>();
    /** The subscription whose provider a session reads from; none for a copy's. */
    const subscriptionOf = (session: Session): string | null =>
      session.kind === "live"
        ? session.channel.subscriptionId
        : session.origin.kind === "provider"
          ? session.origin.title.subscriptionId
          : null;
    /** A session is open: what plays, and so `busy`, changed. */
    const register = (session: Session) => {
      sessions.set(session.id, session);
      coordination.opened(session.id, subscriptionOf(session));
    };
    /** When channel streams failed, by upstream address, for `FAILED_STREAM_MS`. */
    const failedAt = new Map<string, number>();
    /**
     * Fails unless `source` is still saved with the login it had: what was looked up under a
     * login that changed, or for a subscription that went, plays nothing.
     */
    const whileSaved = (source: Source) =>
      Effect.flatMap(subscriptions.stands(source), (stands) =>
        stands ? Effect.void : Effect.fail(new Failed({ error: { kind: "no-subscription" } })),
      );
    const { port } = yield* Effect.acquireRelease(
      Effect.promise(() => listen((request, response) => void serve(request, response))),
      ({ server }) =>
        Effect.sync(() => {
          server.closeAllConnections();
          server.close();
        }),
    );

    const closeAll = Effect.suspend(() =>
      Effect.forEach([...sessions.values()], (session) => Scope.close(session.scope, Exit.void)),
    ).pipe(Effect.asVoid);

    // Sessions close before the proxy does.
    yield* Effect.addFinalizer(() => closeAll);

    const base = `http://127.0.0.1:${port}`;
    /**
     * Probes by address, so reopening a title doesn't read its file again, until an answer shows
     * the provider put another file there. Oldest first.
     */
    const probes = new Map<string, TitleProbe>();
    const limits: RecoveryLimits = { ...RECOVERY_LIMITS, ...deps.recovery };

    /** What a session keeps of a file it has read nothing of yet. */
    const fileKept = (): FileKept => ({
      windows: fileWindows(limits.kept),
      histories: new Map(),
      layout: null,
      servers: 0,
    });

    async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Cache-Control", "no-store");
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "Access-Control-Allow-Headers": "Range" }).end();
        return;
      }
      const url = new URL(request.url ?? "/", base);
      // /hls/<token>/<ffmpeg>/<number>.ts and /hls/<token>/<ffmpeg>/list: what an ffmpeg makes
      // for a receiver.
      const made = /^\/hls\/([\w-]+)\/([\w-]+)\/(?:(\d{1,9})\.ts|(list))$/.exec(url.pathname);
      if (made) {
        const maker = [...sessions.values()].find((each) => each.token === made[1]);
        if (!maker || request.method !== "POST") {
          response.writeHead(410).end();
          return;
        }
        const index = made[3] === undefined ? null : Number(made[3]);
        // A title's segment is told to come only once there is room for it.
        if (maker.kind === "title" && index !== null) {
          void receiveSegment(maker, made[2]!, index, request, response);
          return;
        }
        if (request.headers.expect) response.writeContinue();
        if (maker.kind === "live") receiveLive(maker, made[2]!, index, request, response);
        else response.writeHead(410).end();
        return;
      }
      if (request.headers.expect) response.writeContinue();
      // /stream/<token>.ts, /stream/<token>.m3u8 and its /stream/<token>/<address id>,
      // /source/<token>, /title/<token>.mp4, /report/<token>/<ffmpeg>/<what>
      const route =
        /^\/(stream|source|title|report)\/([\w-]+)(?:\.\w+)?(?:\/([\w-]+))?(?:\/(subtitles|start))?$/.exec(
          url.pathname,
        );
      const session = route && [...sessions.values()].find((each) => each.token === route[2]);
      const method = route ? (route[1] === "report" ? "PUT" : "GET") : null;
      if (!route || !session || request.method !== method) {
        response.writeHead(410).end();
        return;
      }
      if (session.kind === "live") {
        if (route[1] !== "stream") response.writeHead(410).end();
        else if (session.hls) {
          await serveHls(session, session.hls, route[3] ?? null, url, request, response);
        } else await serveLive(session, response);
        return;
      }
      switch (route[1]) {
        case "source":
          return serveSource(session, request, response);
        case "title":
          if (url.searchParams.get("only") === "subtitles") {
            return serveSubtitles(session, url, response);
          }
          if (url.searchParams.get("only") === "progress") {
            // How much the player has buffered, which says whether playback can spare the provider.
            session.progress = {
              buffered: Math.max(0, Number(url.searchParams.get("buffered")) || 0),
              paused: url.searchParams.get("paused") === "1",
              at: performance.now(),
            };
            session.slot.look();
            response.writeHead(204).end();
            return;
          }
          // A new run starts clean: what went wrong before was dealt with, or happens again.
          session.failure = null;
          return serveTitle(session, url, response);
        case "report":
          return receiveReport(session, route[3] ?? "", route[4] ?? "", request, response);
        default:
          response.writeHead(410).end();
      }
    }

    async function serveLive(session: LiveSession, response: ServerResponse): Promise<void> {
      const started = performance.now();
      /** Notes how the stream reached the player, or why it didn't. */
      const report = (
        delivery: "direct" | "converted" | "repaired" | "none",
        outcome: "ok" | StreamFailure["kind"],
      ) =>
        diagnostics.record({
          op: "stream",
          ms: Math.round(performance.now() - started),
          delivery,
          outcome,
        });

      session.active?.abort();
      const active = new AbortController();
      session.active = active;
      response.on("close", () => active.abort());
      const signal = AbortSignal.any([session.closed.signal, active.signal]);

      const opened = await openVariant(session, signal, (failure) => report("none", failure.kind));
      if (signal.aborted) {
        if (opened.ok) void opened.reader.cancel().catch(() => {});
        response.destroy();
        return;
      }
      if (!opened.ok) {
        session.failure = opened.failure;
        response.writeHead("status" in opened.failure ? opened.failure.status : 502).end();
        return;
      }
      const { contentType, reader, start } = opened;
      const { layout } = start;
      session.layout = layout;
      session.captions = [];
      const video = layout?.video;
      const cleaned =
        video && video.codec !== "unknown" && CLEAN_START_CODECS.has(video.codec)
          ? cleanStart(replay(start, reader), createCleanStart(video.pid, video.codec))
          : replay(start, reader);
      // The track asked for, else the sound in the viewer's language, else the channel's first.
      const chosen =
        layout?.audio.find((track) => track.pid === session.audio) ??
        (session.audioLanguage
          ? layout?.audio.find((track) => languageCode(track.language) === session.audioLanguage)
          : undefined);
      session.playing = (chosen ?? layout?.audio[0])?.pid ?? null;
      const conversion = layout
        ? planConversion(layout, session.decoders, {
            repair: session.repair,
            audio: chosen?.pid ?? null,
          })
        : null;
      // The player plays the first sound track its table lists; ffmpeg keeps only the chosen one.
      const chosenFirst =
        layout && chosen && chosen !== layout.audio[0] && !conversion
          ? filtered(cleaned, createAudioChoice(layout.programPid, chosen.pid))
          : cleaned;
      // Captions inside the pictures get a stream of their own, after any conversion. They can
      // start at any time, so whoever lists the tracks hears of each channel found. A stream
      // the player asked for again, or closed, has no say any more: the captions are the new one's.
      const captionCopy = () =>
        createCaptionCopy((channels) => {
          if (signal.aborted) return;
          session.captions = channels;
          PubSub.publishUnsafe(tracksChanged, session.id);
        });
      const chunks = conversion ? chosenFirst : filtered(chosenFirst, captionCopy());
      const delivery = !conversion ? "direct" : session.repair ? "repaired" : "converted";
      const body = Readable.from(chunks);
      body.on("error", (cause) => {
        if (!signal.aborted) {
          session.failure = { kind: "network", detail: String(cause) };
          report(delivery, "network");
        }
        response.destroy();
      });

      if (!conversion) {
        response.writeHead(200, { "Content-Type": contentType ?? "video/mp2t" });
        body.pipe(response);
        report("direct", "ok");
        return;
      }
      if (!deps.ffmpeg) {
        session.failure = { kind: "unsupported", detail: describeLayout(start.layout) };
        body.destroy();
        response.writeHead(415).end();
        report("none", "unsupported");
        return;
      }
      convert(deps.ffmpeg, conversion, body, response, session, signal, captionCopy(), (outcome) =>
        report(delivery, outcome),
      );
    }

    /**
     * Connects to the session's streams in turn until one sends something, and reads its start.
     * A stream's request is over before the next one's begins, so the provider sees one at a
     * time. A refusal ends the turn: it is the account's, such as another device on the
     * connection, so another stream would be refused too. `failed` hears each failed stream.
     */
    async function openVariant(
      session: LiveSession,
      signal: AbortSignal,
      failed: (failure: StreamFailure) => void,
    ): Promise<
      | {
          readonly ok: true;
          readonly contentType: string | null;
          readonly reader: ReadableStreamDefaultReader<Uint8Array>;
          readonly start: StreamStart;
        }
      | { readonly ok: false; readonly failure: StreamFailure }
    > {
      const noStream: StreamFailure = {
        kind: "network",
        detail: t("The provider sent no stream."),
      };
      let failure: StreamFailure = noStream;
      // A session that played a stream keeps it: a player asking again, as hls.js does for a
      // playlist, gets that stream or none.
      const kept = session.delivered.variantId;
      const variants = kept ? session.variants.filter(({ id }) => id === kept) : session.variants;
      for (const variant of variants) {
        const upstream = await connect(session, variant.url, variant.headers, signal);
        const body = upstream.ok ? upstream.response.body : null;
        if (signal.aborted) {
          void body?.cancel().catch(() => {});
          return { ok: false, failure };
        }
        if (upstream.ok && body) {
          const reader = body.getReader();
          const start = await inspectStart(reader, session.decoders);
          // A stream that ends before sending anything has nothing to play.
          if (signal.aborted || start.head.length > 0 || start.pending) {
            session.delivered = { ...session.delivered, variantId: variant.id };
            failedAt.delete(variant.url);
            const contentType = upstream.response.headers.get("content-type");
            return { ok: true, contentType, reader, start };
          }
          void reader.cancel().catch(() => {});
        }
        failure = upstream.ok ? noStream : upstream.failure;
        failed(failure);
        if (!kept) {
          session.delivered = {
            ...session.delivered,
            failed: [...session.delivered.failed, { variantId: variant.id, failure }],
          };
        }
        if (failure.kind === "refused") break;
        failedAt.set(variant.url, Date.now());
      }
      return { ok: false, failure };
    }

    /**
     * An HLS stream: the playlist the channel names (`id` null), or an address one of its
     * playlists named. Playlists go to the player with their addresses pointed here; the rest
     * passes through as it arrives. Each request the player makes is one upstream request, without
     * retries, which hls.js makes itself; closing the session aborts every one of them. The
     * channel's playlist tries its streams in turn, as `openVariant` does.
     */
    async function serveHls(
      session: LiveSession,
      addresses: ReturnType<typeof hlsAddresses>,
      id: string | null,
      url: URL,
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<void> {
      // Subtitle playlists and their children share the bounded address registry, but carry a
      // separate proxy route marker. Their HTTP status must never become the video's failure.
      const subtitle = id?.startsWith("subs-") ?? false;
      const started = performance.now();
      const report = (outcome: "ok" | StreamFailure["kind"]) =>
        diagnostics.record({
          op: "stream",
          ms: Math.round(performance.now() - started),
          delivery: outcome === "ok" ? "direct" : "none",
          outcome,
        });
      const noStream: StreamFailure = {
        kind: "network",
        detail: t("The provider sent no stream."),
      };
      const ended = new AbortController();
      response.on("close", () => ended.abort());
      const signal = AbortSignal.any([session.closed.signal, ended.signal]);
      const range: Record<string, string> = request.headers.range
        ? { Range: request.headers.range }
        : {};
      // With what the player adds: delivery directives (_HLS_msn) to a low-latency playlist.
      const requestFor = (address: string, headers: Readonly<Record<string, string>>) => {
        const upstreamUrl = new URL(address);
        for (const [name, value] of url.searchParams) upstreamUrl.searchParams.set(name, value);
        return connect(session, upstreamUrl.href, { ...headers, ...range }, signal, []);
      };

      try {
        if (id !== null) {
          const address = addresses.addressOf(subtitle ? id.slice(5) : id);
          if (!address) {
            response.writeHead(410).end();
            return;
          }
          const variant =
            session.variants.find((each) => each.id === session.delivered.variantId) ??
            session.variants[0];
          const upstream = await requestFor(address, variant?.headers ?? {});
          const opened = upstream.ok ? await readStart(upstream.response, address) : null;
          if (signal.aborted) {
            void opened?.reader.cancel().catch(() => {});
            response.destroy();
          } else if (!opened) {
            const failure = upstream.ok ? noStream : upstream.failure;
            if (!subtitle) session.failure = failure;
            response.writeHead("status" in failure ? failure.status : 502).end();
          } else if (opened.playlist) {
            await sendPlaylist(session, addresses, opened, response, subtitle);
          } else {
            await passOn(opened, response);
          }
          return;
        }

        const kept = session.delivered.variantId;
        const variants = kept
          ? session.variants.filter((each) => each.id === kept)
          : session.variants;
        let failure: StreamFailure = noStream;
        for (const variant of variants) {
          const upstream = await requestFor(variant.url, variant.headers);
          const opened = upstream.ok ? await readStart(upstream.response, variant.url) : null;
          if (signal.aborted) {
            void opened?.reader.cancel().catch(() => {});
            response.destroy();
            return;
          }
          if (opened?.playlist) {
            session.delivered = { ...session.delivered, variantId: variant.id };
            failedAt.delete(variant.url);
            await sendPlaylist(session, addresses, opened, response);
            // Once per session: the player reloads a live playlist every few seconds.
            if (!kept) report("ok");
            return;
          }
          void opened?.reader.cancel().catch(() => {});
          failure = !upstream.ok
            ? upstream.failure
            : opened
              ? {
                  kind: "unsupported",
                  detail: t("The channel's address doesn't answer with an HLS playlist."),
                }
              : noStream;
          report(failure.kind);
          if (!kept) {
            session.delivered = {
              ...session.delivered,
              failed: [...session.delivered.failed, { variantId: variant.id, failure }],
            };
          }
          if (failure.kind === "refused") break;
          failedAt.set(variant.url, Date.now());
        }
        session.failure = failure;
        response.writeHead("status" in failure ? failure.status : 502).end();
      } catch (cause) {
        if (!signal.aborted && !subtitle) {
          session.failure = {
            kind: "network",
            detail: cause instanceof Error ? cause.message : String(cause),
          };
        }
        response.destroy();
      }
    }

    /** Sends a playlist on, whole, with its addresses pointed at the proxy. */
    async function sendPlaylist(
      session: LiveSession,
      addresses: ReturnType<typeof hlsAddresses>,
      opened: Started,
      response: ServerResponse,
      subtitle = false,
    ): Promise<void> {
      const parts = [...opened.parts];
      let size = parts.reduce((sum, part) => sum + part.byteLength, 0);
      for (let next = await opened.reader.read(); !next.done; next = await opened.reader.read()) {
        size += next.value.byteLength;
        if (size > PLAYLIST_LIMIT) throw new Error("The playlist is too long.");
        parts.push(next.value);
      }
      const text = Buffer.concat(parts).toString("utf8");
      // A multivariant playlist's variants and renditions stay for the session.
      const pin = isMultivariant(text);
      const subtitleUrls = new Set(
        text.split(/\r?\n/).flatMap((line) => {
          if (!line.startsWith("#EXT-X-MEDIA:") || !/[,:]TYPE=SUBTITLES(?:,|$)/.test(line))
            return [];
          const uri = /URI="([^"]*)"/.exec(line)?.[1];
          const url = uri ? URL.parse(uri, opened.url) : null;
          return url ? [url.href] : [];
        }),
      );
      const playlist = rewritePlaylist(text, opened.url, (target) => {
        const marker = subtitle || subtitleUrls.has(target) ? "subs-" : "";
        return session.proxied(`${marker}${addresses.idOf(target, pin)}`);
      });
      if (!subtitle) session.failure = null;
      response.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      response.end(playlist);
    }

    /** Passes a segment, key or other file on as it arrives, at the player's pace. */
    async function passOn(opened: Started, response: ServerResponse): Promise<void> {
      const { answer } = opened;
      const passed: Record<string, string> = {};
      // fetch unpacks a compressed answer, so its length no longer holds.
      const unpacked = answer.headers.has("content-encoding");
      for (const name of ["content-type", "content-length", "content-range"]) {
        const value = answer.headers.get(name);
        if (value !== null && !(unpacked && name === "content-length")) passed[name] = value;
      }
      response.writeHead(answer.status, passed);
      for (const part of opened.parts) response.write(part);
      for (let next = await opened.reader.read(); !next.done; next = await opened.reader.read()) {
        if (!response.write(next.value)) await drained(response);
      }
      response.end();
    }

    /** Pipes the stream through ffmpeg. A conversion that fails counts as an unsupported stream. */
    function convert(
      ffmpeg: string,
      conversion: Conversion,
      body: Readable,
      response: ServerResponse,
      session: LiveSession,
      signal: AbortSignal,
      output: { push(chunk: Uint8Array): Uint8Array },
      report: (outcome: "ok" | "unsupported") => void,
    ): void {
      const child = spawn(ffmpeg, ffmpegArguments(conversion), { stdio: ["pipe", "pipe", "pipe"] });
      let errors = "";
      child.stderr.on("data", (chunk: Buffer) => {
        errors = (errors + chunk.toString()).slice(-2000);
      });
      const stop = () => child.kill("SIGKILL");
      signal.addEventListener("abort", stop, { once: true });
      child.on("error", (cause) => {
        if (!signal.aborted) {
          session.failure = { kind: "unsupported", detail: String(cause) };
          report("unsupported");
        }
        response.destroy();
      });
      // "close" comes after ffmpeg's output has been read, so a stream that ends normally reaches
      // the player whole; only a failed conversion cuts the response.
      child.on("close", (code) => {
        signal.removeEventListener("abort", stop);
        body.destroy();
        if (code === 0 || signal.aborted) return;
        if (!session.failure) {
          const detail = errors.trim().split("\n").at(-1) ?? `ffmpeg exited with ${code}`;
          session.failure = {
            kind: "unsupported",
            detail: `${t("The stream could not be converted.")} ${detail}`,
          };
          report("unsupported");
        }
        response.destroy();
      });
      // ffmpeg stops reading when it fails or is killed; that write error is not the stream's.
      child.stdin.on("error", () => {});
      body.pipe(child.stdin);
      response.writeHead(200, { "Content-Type": "video/mp2t" });
      child.stdout
        .pipe(
          new Transform({
            transform(chunk: Buffer, _encoding, done) {
              done(null, output.push(chunk));
            },
          }),
        )
        .pipe(response);
      report("ok");
    }

    /**
     * Notes what an upstream answer says of the session's file. Once it is another file than the
     * session knew, nothing kept of the old one stays: not its parts, its subtitles or its index,
     * nor what ffprobe read of it for the next time the title opens, and a feed that gave the
     * player the old file's subtitles says they are gone. The window hears which session it was
     * (`fileReplaced`), for what it still shows of that file's saved subtitles. Playback goes on
     * with what the provider sends, as it always did. Null when the answer doesn't say what it holds.
     */
    function observe(session: TitleSessionState, answer: Response, ranged: boolean): Held | null {
      const held = session.identity.observe(answer, ranged);
      if (held?.other) {
        session.subtitleFileChanged.abort();
        const { origin } = session;
        const verified = origin.kind === "provider" ? origin.verified : null;
        if (savedSubtitles && origin.kind === "provider" && verified) {
          Effect.runSync(
            savedSubtitles
              .forget({
                account: verified.account,
                sourceStamp: verified.sourceStamp,
                listingKey: verified.listingKey,
                kind: origin.title.kind,
                id: origin.title.id,
              })
              .pipe(Effect.ignore),
          );
        }
        session.kept = fileKept();
        session.live = null;
        probes.delete(session.probeKey);
        if (origin.kind === "provider" && verified && verifiedFiles) {
          Effect.runSync(
            verifiedFiles
              .forget(verified.account, origin.title, verified.fileKey)
              .pipe(Effect.ignore),
          );
        }
        session.feed?.changed();
        PubSub.publishUnsafe(replaced, session.id);
      }
      // Nothing is kept of a file before its first answer that says what it holds, nor from one
      // of a replaced file (see `serveSource`): what runs and recovery keep from here on is of the
      // servers heard so far, so a run's subtitles count as kept from them too.
      if (session.kept.servers === 0) session.kept.servers = session.identity.servers;
      // A receiver holds a playlist of the file as it was read when the title opened: its length,
      // its tracks and where its segments start. Of another file none of that holds, whether the
      // answers tell it by its size or, at the same size, by the mark of the server that sent
      // it. What the receiver was sent ends there rather than go on as a mixture of the two, and
      // so does a load made of the session after that. Opening the title again reads the new file.
      const receiver = session.receiver;
      if (receiver?.load && session.identity.generation !== session.probed) {
        const failure: StreamFailure = {
          kind: "network",
          detail: t("The provider put another file behind this title while it played."),
        };
        session.failure = failure;
        const { load } = receiver;
        receiver.load = null;
        load.closed.abort();
        session.lan?.failed(failure);
      }
      return held;
    }

    /** How much of the file one of playback's requests asks for while recovery takes turns: about a second's worth. */
    function partBytes(session: TitleSessionState): number {
      const rate = session.meter.rate;
      return rate === null
        ? PART_BYTES.first
        : Math.max(PART_BYTES.least, Math.min(PART_BYTES.most, Math.round(rate)));
    }

    /**
     * The provider's file for ffprobe and ffmpeg, the byte range they ask for. One upstream
     * request at a time: a new one, such as a seek, ends the one before. ffmpeg asks for the file
     * from a position to its end, and the provider is asked the same, so the answer passes
     * through as it comes. If the provider instead answers with a known whole file from zero,
     * discard the bytes before the asked position and answer with that range. A position at or
     * past its known end gets 416. A nonzero request ends without bytes if a 200 has no known
     * size or an answer names another start and isn't the whole file from zero. A 206 whose
     * headers don't establish its range still passes through, as before. While prefix bytes
     * advance, their last-drop time keeps local startup alive and readingAhead notices keep the
     * renderer waiting. When dropping ends or stalls, the local picture has 30 seconds from the
     * last dropped byte. Receivers keep their 30-second segment deadline: a far segment can
     * time out, and a retry can read from zero again.
     *
     * While a subtitle track's past is being read (see `subtitlesBefore`), that reading needs
     * turns at the provider. A provider that answers ranges is then asked for the file a part at
     * a time: ffmpeg's answer stays the one it was promised, the same length from the same
     * position, and each part has to be exactly the bytes that follow, of a file of the same
     * size, or the answer ends there and ffmpeg asks again. A provider that knows no ranges keeps
     * its one answer, and the reading does without.
     */
    async function serveSource(
      session: TitleSessionState,
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<void> {
      session.source?.abort();
      const mine = new AbortController();
      session.source = mine;
      response.on("close", () => mine.abort());
      const signal = AbortSignal.any([session.closed.signal, mine.signal]);
      const { identity, slot } = session;
      // ffmpeg asks for a file from a position to its end. Any other range passes as it is.
      const asked = request.headers.range;
      const open = asked === undefined ? "0" : /^bytes=(\d+)-$/.exec(asked)?.[1];
      /** The next byte ffmpeg gets; null when the answer isn't known to hold the bytes asked for. */
      let position = open === undefined ? null : Number(open);
      /** The size of the file ffmpeg's answer was promised from; null before its headers went. */
      let total: number | null = null;
      let answered = false;
      /** Asked in parts and answered otherwise: the rest passes through as it comes. */
      let plain = false;

      /** ffmpeg hasn't taken what it was sent for a while: playback can spare the provider. */
      let resting = false;
      const rest = (on: boolean) => {
        if (resting === on) return;
        resting = on;
        session.reading += on ? -1 : 1;
        if (on) slot.look();
      };
      /**
       * Waits until ffmpeg takes more: true. With `spare`, false instead once it has left what
       * it was sent for long enough and recovery wants the provider. A request that takes this
       * one's place ends the wait too: an ffmpeg that skips may open its next request before it
       * closes this one, which it has stopped reading.
       */
      const taken = (spare: boolean) =>
        new Promise<boolean>((resolve) => {
          const settle = (went: boolean) => {
            clearTimeout(timer);
            stop();
            response.off("drain", resumed);
            response.off("close", resumed);
            signal.removeEventListener("abort", resumed);
            rest(false);
            resolve(went);
          };
          const resumed = () => settle(true);
          const look = () => {
            if (resting && spare && slot.wanted(false)) settle(false);
          };
          const timer = setTimeout(() => {
            rest(true);
            look();
          }, REST_MS);
          const stop = slot.onWanting(look);
          response.on("drain", resumed);
          response.on("close", resumed);
          signal.addEventListener("abort", resumed, { once: true });
          if (signal.aborted) resumed();
        });

      session.reading++;
      try {
        for (let fresh = true; ; fresh = false) {
          const size: number | null = answered ? total : identity.size;
          // In parts while a subtitle track's past is being read, so that reading gets turns. A
          // run that is starting reads as it always did; recovery has no turns then anyway.
          let end =
            !plain &&
            position !== null &&
            size !== null &&
            position < size &&
            identity.ranges === true &&
            session.recovering > 0 &&
            session.starting === null
              ? Math.min(size, position + partBytes(session))
              : null;
          const range =
            position === null
              ? asked
              : end !== null
                ? `bytes=${position}-${end - 1}`
                : asked !== undefined || position > 0
                  ? `bytes=${position}-`
                  : undefined;
          const lease = await slot.play(signal, fresh);
          if (!lease) {
            response.destroy();
            return;
          }
          let body: ReadableStreamDefaultReader<Uint8Array> | null = null;
          /** How this request ended: its body did, or it was ended to give recovery a turn. */
          let outcome: "ended" | "spared" | null = null;
          try {
            const found = await connect(
              session,
              session.upstreamUrl,
              range === undefined ? {} : { Range: range },
              signal,
              FILE_RETRY_DELAYS_MS,
            );
            if (signal.aborted) {
              if (found.ok) void found.response.body?.cancel().catch(() => {});
              response.destroy();
              return;
            }
            if (!found.ok) {
              // A range past the end is ffmpeg looking around, not the provider refusing.
              if (!("status" in found.failure) || found.failure.status !== 416) {
                session.failure = found.failure;
              }
              if ("status" in found.failure && !answered) {
                response.writeHead(found.failure.status).end();
              } else response.destroy();
              return;
            }
            const upstream = found.response;
            body = upstream.body?.getReader() ?? null;
            const held = observe(session, upstream, range !== undefined);
            // An answer that doesn't say what it holds, as a whole file without its length, can't
            // be told from another file, and one from a server that still has a replaced file is
            // of that file. What runs read from either stays with what they began keeping, apart
            // from the session's file, whose next answers start what it keeps anew.
            if (held === null || held.stale) session.kept = fileKept();
            // A whole-file provider ignores Range. Read its one answer forward to the asked
            // position; it still cannot be ended early and resumed for recovery's turns.
            const whole =
              position !== null && position > 0 && upstream.status === 200 && held?.start === 0;
            let discard = whole ? (position ?? 0) : 0;
            if (position !== null && position > 0) {
              if (
                (upstream.status === 200 && !whole) ||
                (held !== null && held.start !== position && !whole)
              ) {
                response.destroy();
                return;
              }
              if (held !== null && position >= held.size) {
                response.writeHead(416, { "Content-Range": `bytes */${held.size}` }).end();
                return;
              }
            }
            if (whole) end = null;
            const follows =
              held !== null &&
              upstream.status === 206 &&
              held.start === position &&
              !held.other &&
              !held.stale;
            if (answered && (!follows || held.size !== total)) {
              // Not the bytes that follow what ffmpeg has: it asks again, and gets what there is.
              response.destroy();
              return;
            }
            if (!answered && end !== null && (!follows || held.size !== size)) {
              // A part was asked of a file that isn't the one known: as the provider answers.
              plain = true;
              continue;
            }
            // The provider answers again, so ffmpeg has the range it asked for again: a break
            // before this no longer cuts the run short.
            session.failure = null;
            if (!answered) {
              answered = true;
              const forwarded: Record<string, string> = { "Accept-Ranges": "bytes" };
              const type = upstream.headers.get("content-type");
              if (type) forwarded["content-type"] = type;
              if (whole && held !== null && position !== null) {
                total = held.size;
                forwarded["content-length"] = String(total - position);
                forwarded["content-range"] = `bytes ${position}-${total - 1}/${total}`;
                response.writeHead(206, forwarded);
              } else if (end !== null && position !== null && size !== null) {
                // What the provider answers when asked for the file from here to its end.
                total = size;
                forwarded["content-length"] = String(size - position);
                if (asked !== undefined) {
                  forwarded["content-range"] = `bytes ${position}-${size - 1}/${size}`;
                }
                response.writeHead(asked === undefined ? 200 : 206, forwarded);
              } else {
                for (const name of ["content-length", "content-range"]) {
                  const value = upstream.headers.get(name);
                  if (value) forwarded[name] = value;
                }
                response.writeHead(upstream.status, forwarded);
                total = held?.size ?? null;
                // Requests other than an open range keep the provider's answer as it is.
                if (held?.start !== position) position = null;
              }
            }
            if (!body) {
              response.end();
              return;
            }
            /** Whether the request can be ended early and the file asked for again from there. */
            const resumable = position !== null && total !== null && identity.ranges === true;
            const began = performance.now();
            let got = 0;
            for (;;) {
              const { done, value } = await body.read();
              if (done) {
                outcome = "ended";
                break;
              }
              got += value.length;
              const skipped = Math.min(discard, value.length);
              discard -= skipped;
              if (signal.aborted) return;
              if (skipped > 0) {
                const now = performance.now();
                session.readForwardAt = now;
                if (now - (session.readAheadNotifiedAt ?? -Infinity) >= 3000) {
                  session.readAheadNotifiedAt = now;
                  PubSub.publishUnsafe(readingAhead, session.id);
                }
              }
              const bytes = value.subarray(skipped);
              if (bytes.length === 0) continue;
              if (position !== null) position += bytes.length;
              const more = response.write(bytes);
              // A part is read to its end at once, and ffmpeg takes it from memory.
              if (end !== null) continue;
              // ffmpeg takes the file as it comes, or has all it takes for now: either way
              // recovery may get the provider, when playback can spare it.
              const went = more || (await taken(resumable));
              if (signal.aborted) return;
              if (!went || (resumable && slot.wanted(true))) {
                outcome = "spared";
                break;
              }
            }
            if (end !== null) session.meter.add(got, performance.now() - began);
          } catch {
            // The provider broke off; ffmpeg may still end its run as if the file had.
            if (!signal.aborted) {
              session.failure ??= { kind: "network", detail: t("The provider's file broke off.") };
            }
            response.destroy();
            return;
          } finally {
            if (outcome !== "ended") {
              await body?.cancel().catch(() => {});
              await gone();
            }
            lease.release();
          }
          if (signal.aborted) return;
          if (
            outcome === "ended" &&
            (end === null || position === null || position >= (total ?? 0))
          ) {
            response.end();
            return;
          }
          // More of the file once ffmpeg has taken what it was sent.
          if (response.writableNeedDrain) await taken(false);
          if (signal.aborted) return;
        }
      } finally {
        if (!resting) session.reading--;
        slot.look();
      }
    }

    /** What `kept` holds of a subtitle track. One track's at a time: the one the player shows. */
    function historyOf(kept: FileKept, track: number): SubtitleHistory {
      const known = kept.histories.get(track);
      if (known) return known;
      kept.histories.clear();
      const history = subtitleHistory(limits.history);
      kept.histories.set(track, history);
      return history;
    }

    /**
     * Plays a movie or episode from `start` with the chosen tracks, as fragmented MP4. A header
     * tells the player where the picture starts (`x-start`, title seconds). The picture doesn't
     * wait for subtitles: what the run reads of its subtitle track is kept, and goes to the
     * player's feed once that has what came before (see `serveSubtitles`). Until the picture has
     * reached the player, nothing but the run reads the provider's file.
     */
    async function serveTitle(
      session: TitleSessionState,
      url: URL,
      response: ServerResponse,
    ): Promise<void> {
      const started = performance.now();
      session.active?.abort();
      const active = new AbortController();
      session.active = active;
      response.on("close", () => active.abort());
      const signal = AbortSignal.any([session.closed.signal, active.signal]);
      const run: TitleRun = {
        start: Math.max(0, Number(url.searchParams.get("start")) || 0),
        audio: optionalNumber(url.searchParams.get("audio")),
        subtitle: optionalNumber(url.searchParams.get("subtitle")),
        convertSound: url.searchParams.get("sound") === "convert",
      };
      const probe = session.probe;
      if (!probe || !deps.ffmpeg) {
        session.failure = {
          kind: "unsupported",
          detail: t("This build has no ffmpeg to play movies and episodes."),
        };
        response.writeHead(415).end();
        return;
      }
      session.starting = active;
      session.running = active;
      // What the player said of its buffer was of the run before.
      session.progress = null;
      // ffmpeg asks for the file in a moment: recovery's request is over by then.
      session.slot.clear();
      /** The run's picture reached the player, or never will: recovery may read again. */
      const settled = () => {
        if (session.starting !== active) return;
        session.starting = null;
        session.slot.look();
      };
      // The run reads the file as the session knows it now, and keeps what it reads with it.
      const kept = session.kept;
      const generation = session.identity.generation;
      const id = randomBytes(9).toString("base64url");
      const reportUrl = (what: string) => `${base}/report/${session.token}/${id}/${what}`;
      const plan = titlePlan(probe, run, session.decoders, {
        source: `${base}/source/${session.token}`,
        subtitles: reportUrl("subtitles"),
        start: reportUrl("start"),
      });
      const report = (outcome: "ok" | StreamFailure["kind"]) =>
        diagnostics.record({
          op: "title",
          ms: Math.round(performance.now() - started),
          video: plan.video,
          audio: plan.audio,
          outcome,
        });

      const child = spawn(deps.ffmpeg, plan.args, { stdio: ["ignore", "pipe", "pipe"] });
      let errors = "";
      child.stderr.on("data", (chunk: Buffer) => {
        errors = (errors + chunk.toString()).slice(-2000);
      });
      const stop = () => {
        child.kill("SIGKILL");
        // A player that holds back reading leaves the picture waiting in the pipe, and nobody
        // reads it now: the pipe closes with the run.
        child.stdout.destroy();
        settled();
      };
      signal.addEventListener("abort", stop, { once: true });
      // Held until the picture's start is known; ffmpeg pauses when too much waits.
      const held: Buffer[] = [];
      let heldBytes = 0;
      const hold = (chunk: Buffer) => {
        held.push(chunk);
        heldBytes += chunk.length;
        if (heldBytes > 32 * 1024 * 1024) child.stdout.pause();
      };
      child.stdout.on("data", hold);
      let outputEnded = false;
      child.stdout.once("end", () => {
        outputEnded = true;
      });
      const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
      // The process is gone before its last output has been read, which a paused player may
      // leave waiting.
      const ended = new Promise<number | null>((resolve) => {
        child.on("exit", resolve);
        child.on("error", () => resolve(null));
      });
      child.on("error", (cause) => {
        errors = String(cause);
      });

      const start = textRelay();
      const reading =
        plan.subtitle && run.subtitle !== null ? historyOf(kept, run.subtitle).reading() : null;
      /** What the run reads of its track, for a feed that becomes ready while it runs. */
      const since = readsItsOwn(probe, run.subtitle, run.start)
        ? Number.NEGATIVE_INFINITY
        : probe.origin + run.start + interleave(probe);
      const live: Live | null =
        run.subtitle === null
          ? null
          : { track: run.subtitle, since, from: since, entries: [], bytes: 0 };
      session.live = live;
      const subtitles =
        plan.subtitle && reading && live
          ? subtitleSink(plan.subtitle, (entry) => {
              // What it reads now is of another file than it started in.
              if (session.identity.generation !== generation) return;
              reading.add(entry);
              // A run stops when the viewer skips or leaves, at any moment: what it has read
              // counts up to a little before the last subtitle that arrived.
              reading.reach(entry.from - interleave(probe));
              live.entries.push(entry);
              live.bytes += sizeOf(entry);
              // The oldest go first, and what is left is whole only from after them.
              while (live.bytes > LIVE_BYTES && live.entries.length > 1) {
                const gone = live.entries.shift()!;
                live.bytes -= sizeOf(gone);
                live.from = Math.max(live.from, gone.from);
              }
              const feed = session.feed;
              // An accepted report can finish after its run was replaced. Keep its history,
              // but leave delivery to the current run so late lines aren't marked as sent.
              if (
                session.live === live &&
                feed?.track === live.track &&
                live.since <= feed.after &&
                entry.from > feed.after
              ) {
                feed.send(entry, probe.origin);
              }
            })
          : null;
      session.reports.set(id, { start, ...(subtitles ? { subtitles: subtitles.receive } : {}) });
      // ffmpeg can be gone before the proxy has heard what it sent, as after a run of a file's
      // last seconds: that arrives in a moment.
      const heard = ended.then((code) =>
        code === 0
          ? arrives(Promise.all([plan.video === "copy" ? start.ended : null, subtitles?.arrived]))
          : null,
      );
      void ended.then(async (code) => {
        await heard;
        const whole = (await subtitles?.whole()) === true;
        // ffmpeg exits cleanly after its input broke off too; the source knows better.
        reading?.end(whole && code === 0 && !signal.aborted && !session.failure);
        session.reports.delete(id);
        if (session.running === active) session.running = null;
        settled();
      });

      // Converted video starts exactly at `start`; copied video at the keyframe before it,
      // which ffmpeg's report names.
      // ffmpeg sends the report's line as soon as it has the packet, and ends the report only
      // with the run, so the proxy reads it as it arrives.
      const pictureStart =
        plan.video === "copy"
          ? await new Promise<number | null>((resolve) => {
              const timeout = deps.runStartMs ?? RUN_START_TIMEOUT_MS;
              let advanced = performance.now();
              let finished = false;
              let timer: ReturnType<typeof setTimeout>;
              const settle = (time: number | null) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                unsubscribe();
                signal.removeEventListener("abort", left);
                resolve(time);
              };
              const left = () => settle(null);
              const expired = () => {
                // Dropping the prefix is useful startup work. Once it ends, the picture has
                // the same full deadline; a stalled drop has only time since its last byte.
                advanced = Math.max(advanced, session.readForwardAt ?? 0);
                const remaining = advanced + timeout - performance.now();
                if (remaining > 0) timer = setTimeout(expired, remaining);
                else settle(null);
              };
              timer = setTimeout(expired, timeout);
              const unsubscribe = start.subscribe(
                () => {
                  const time = firstPacketTime(start.text());
                  if (time !== null) settle(time);
                },
                () => settle(firstPacketTime(start.text())),
              );
              signal.addEventListener("abort", left, { once: true });
              if (signal.aborted) left();
              void Promise.all([exited, heard]).then(() => settle(firstPacketTime(start.text())));
            })
          : probe.origin + run.start;
      if (signal.aborted) {
        stop();
        response.destroy();
        return;
      }
      if (pictureStart === null || (held.length === 0 && child.exitCode !== null)) {
        stop();
        const failure: StreamFailure = session.failure ?? {
          kind: "unsupported",
          detail: `${t("The file could not be played.")} ${lastLine(errors, child.exitCode, child.signalCode, pictureStart)}`,
        };
        session.failure = failure;
        report(failure.kind);
        response.writeHead("status" in failure ? failure.status : 415).end();
        return;
      }
      // From the start of the file the run reads every subtitle; from a position, those from a
      // little after where ffmpeg reads on from. That is the keyframe its picture starts at, or
      // the position itself when that keyframe comes after it, as in a transport stream.
      reading?.begin(
        run.start === 0
          ? Number.NEGATIVE_INFINITY
          : Math.min(pictureStart, probe.origin + run.start) + interleave(probe),
      );

      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Access-Control-Expose-Headers": "x-start",
        "x-start": String(Math.max(0, pictureStart - probe.origin)),
      });
      child.stdout.pause();
      child.stdout.off("data", hold);
      for (const chunk of held) response.write(chunk);
      // A short file can be done before the player is connected. Otherwise the response ends
      // with ffmpeg below: a run that broke off must not end like the title.
      if (!outputEnded) child.stdout.pipe(response, { end: false });
      report("ok");
      settled();
      void exited.then((code) => {
        signal.removeEventListener("abort", stop);
        // ffmpeg exits cleanly after its input broke off too; the source knows better.
        if (code === 0 && !signal.aborted && !session.failure) {
          response.end();
          return;
        }
        if (!signal.aborted && !session.failure) {
          session.failure = {
            kind: "unsupported",
            detail: `${t("The file could not be played.")} ${lastLine(errors, code, child.signalCode)}`,
          };
        }
        response.destroy();
      });
    }

    /**
     * A subtitle track from `start` on, for the player: a JSON line each, with times in title
     * seconds (see `@mrstreamer/core/subtitles/feed`). The picture doesn't wait for it. Packet
     * tracks send what precedes the position, as far back as what is on screen there depends
     * on, then `ready`, then what the run from there reads, for as long as the player listens.
     * Independent text from the run goes on at once while its past is being recovered. Packet
     * decoders wait for `ready`, since their changes may depend on that past.
     *
     * Finding the first part takes reading the file, which only gets the provider when playback
     * spares it, and only so much of it (see `subtitlesBefore`). When it can't be found, the feed
     * says `unavailable` and playback goes on: the session's failure is the picture's alone.
     * The track is `ready` again from the first thing the run reads of it that stands on its
     * own. `x-codec` names the decoder for packets; text has none.
     */
    function serveSubtitles(session: TitleSessionState, url: URL, response: ServerResponse): void {
      const started = performance.now();
      // One feed at a time: the one before would read the file for a position nobody waits for.
      session.feed?.close();
      const left = new AbortController();
      response.on("close", () => left.abort());
      const track = optionalNumber(url.searchParams.get("subtitle"));
      const probe = session.probe;
      const output = probe && track !== null ? subtitleOutput(probe, track) : null;
      if (track === null || !probe || !output) {
        response.writeHead(410).end();
        return;
      }
      const codec = codecOf(output);
      const page = optionalNumber(url.searchParams.get("page"));
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Access-Control-Expose-Headers": "x-codec",
        "x-codec": codec,
      });
      response.flushHeaders();

      const write = (line: SubtitleFeedLine) => {
        // A player that doesn't read its feed gets no more of it than this waiting.
        if (response.writableLength > FEED_WAITING_BYTES) return feed.close();
        response.write(`${JSON.stringify(line)}\n`);
      };
      const starts = output.kind === "packets" ? freshStart(output.codec, page) : null;
      /** Why the feed has nothing to show for its position, once it hasn't. */
      let unavailable: SubtitlesUnavailable | null = null;
      const send: Feed["send"] = (entry, origin) => {
        if (unavailable !== null) {
          // After a position it has nothing for, a track shows from the first thing that stands
          // on its own: a packet that starts it afresh, or, for lines of text and for packets
          // that never start afresh, the next one, as a run alone shows them.
          if (starts && "data" in entry && !starts(entry.data)) return;
          unavailable = null;
          write({ ready: true, at: entry.at - origin });
        }
        write(
          "data" in entry
            ? { at: entry.at - origin, data: Buffer.from(entry.data).toString("base64") }
            : { at: entry.at - origin, until: entry.until - origin, text: entry.text },
        );
      };
      /**
       * Hands the feed what a run from its position has read of the track after `after`, and
       * whatever such a run reads from now on. A run that no longer holds everything from there
       * on leaves a gap, and the feed has only what comes after it.
       */
      const join = (after: number, origin: number) => {
        const live = session.live;
        const mine = live?.track === track && live.since <= after ? live : null;
        // Text may join an old, trimmed run before its replacement starts. Keep its requested
        // position so the replacement can deliver the missing lines too.
        feed.after = mine && !earlyText ? Math.max(after, mine.from) : after;
        for (const entry of mine?.entries ?? [])
          if (entry.from > feed.after) feed.send(entry, origin);
      };
      // This feed may outlive several runs. Remember its live text, rather than the last
      // run's buffer, so even an intervening cancelled run cannot replay a sent line.
      const sent: Extract<SubtitleEntry, { readonly text: string }>[] = [];
      let sentBytes = 0;
      const feed: Feed = {
        track,
        after: Number.POSITIVE_INFINITY,
        send: (entry, origin) => {
          if ("text" in entry) {
            if (
              sent.some(
                (known) =>
                  known.from === entry.from &&
                  known.at === entry.at &&
                  known.until === entry.until &&
                  known.text === entry.text,
              )
            )
              return;
            sent.push(entry);
            sentBytes += sizeOf(entry);
            while (sentBytes > LIVE_BYTES && sent.length > 1) {
              sentBytes -= sizeOf(sent.shift()!);
            }
          }
          send(entry, origin);
        },
        close: () => {
          left.abort();
          sent.length = 0;
          sentBytes = 0;
          response.destroy();
        },
        changed: () => {
          // What the player has of the track is of a file that is gone, and so is the run's.
          left.abort();
          feed.after = Number.POSITIVE_INFINITY;
          sent.length = 0;
          sentBytes = 0;
          unavailable = "changed";
          write({ unavailable: "changed" });
        },
      };
      session.feed = feed;
      // The feed ends with the session, though the player hasn't left it.
      const end = () => response.destroy();
      session.closed.signal.addEventListener("abort", end, { once: true });
      response.on("close", () => {
        session.closed.signal.removeEventListener("abort", end);
        if (session.feed === feed) session.feed = null;
      });

      const spent: Spent = { bytes: 0, requests: 0 };
      const record = (outcome: "ok" | SubtitlesUnavailable) =>
        diagnostics.record({
          op: "subtitles",
          ms: Math.round(performance.now() - started),
          bytes: spent.bytes,
          requests: spent.requests,
          kept: session.kept.windows.most,
          heldMs: Math.round(session.slot.counts.recoveryMs),
          waitedMs: Math.round(session.slot.counts.longestWaitMs),
          revoked: session.slot.counts.revoked,
          outcome,
        });
      const attempt: Attempt = {
        signal: AbortSignal.any([
          session.closed.signal,
          left.signal,
          AbortSignal.timeout(limits.ms),
        ]),
        spent,
        narrow: false,
      };
      const wanted: FeedRequest = {
        track,
        page,
        codec,
        start: Math.max(0, Number(url.searchParams.get("start")) || 0),
      };
      // Text lines stand alone: a run's upcoming lines need none of the earlier ones. Join now
      // and keep recovering the past for lines that began before the position, however long
      // they last. Joining again when recovery ends would send the run's lines twice.
      const earlyText = output.kind === "cues" && !readsItsOwn(probe, track, wanted.start);
      if (earlyText) join(probe.origin + wanted.start + interleave(probe), probe.origin);
      session.recovering++;
      void subtitlesBefore(session, probe, wanted, attempt)
        .then(
          (before) => {
            if (left.signal.aborted || session.closed.signal.aborted) return;
            const live = session.live;
            if (live?.track === track && live.since <= before.upTo && live.from > before.upTo) {
              // The run kept less than came between the position and now.
              unavailable = "limit";
              record(unavailable);
              write({ unavailable });
              if (!earlyText) join(before.upTo, before.origin);
              return;
            }
            for (const entry of before.entries) send(entry, before.origin);
            if (!earlyText) join(before.upTo, before.origin);
            write({ ready: true });
            record("ok");
          },
          (cause: unknown) => {
            if (left.signal.aborted || session.closed.signal.aborted) return;
            unavailable =
              cause instanceof Unavailable
                ? cause.kind
                : attempt.signal.aborted
                  ? "limit"
                  : "unreadable";
            record(unavailable);
            write({ unavailable });
            // What the run reads from here on still comes: see `send`.
            if (!earlyText) {
              join(probe.origin + wanted.start + interleave(probe), probe.origin);
            }
          },
        )
        .finally(() => {
          session.recovering--;
        });
    }

    /**
     * What a decoder needs of a subtitle track before a run from `wanted.start`: the entries the
     * history holds from the last fresh start, or the start of the file, up to where the run
     * brings its own. Whatever of them the history doesn't hold yet is read from the file, as
     * little of it as will do (see `select`), within what one reading may take of the provider.
     * Throws `Unavailable` when they can't be had, as when the provider puts another file in its
     * place meanwhile: the feed says so, and the next one reads that file.
     */
    async function subtitlesBefore(
      session: TitleSessionState,
      probe: TitleProbe,
      wanted: FeedRequest,
      attempt: Attempt,
    ): Promise<Before> {
      const { origin } = probe;
      const track = probe.subtitles.find((each) => each.id === wanted.track);
      const output = subtitleOutput(probe, wanted.track);
      if (!track || !output) throw new Unavailable("unreadable");
      if (readsItsOwn(probe, wanted.track, wanted.start)) {
        return { entries: [], upTo: Number.NEGATIVE_INFINITY, origin };
      }
      // Captions sit in the picture, and other files aren't stepped through here.
      if (probe.container !== "matroska" || track.codec === null) {
        throw new Unavailable("unreadable");
      }
      const at = origin + wanted.start;
      const starts = output.kind === "packets" ? freshStart(output.codec, wanted.page) : null;
      const need: Need = {
        at,
        upTo: at + interleave(probe),
        text: output.kind === "cues",
        fresh: starts && ((entry) => "data" in entry && starts(entry.data)),
      };
      // What is kept is used again only for a file the provider's answers vouch for: every one
      // marked, and none from a server that hadn't answered when it was kept. A file known by
      // its size alone, or to a server heard for the first time, is read anew.
      const { identity } = session;
      if (!identity.steady || session.kept.servers !== identity.servers) session.kept = fileKept();
      try {
        return await subtitlesBeforeIn(session, session.kept, probe, track, need, attempt);
      } finally {
        session.kept.servers = identity.servers;
      }
    }

    /** `subtitlesBefore` of the file as `kept` holds it; throws once that is another file. */
    async function subtitlesBeforeIn(
      session: TitleSessionState,
      kept: FileKept,
      probe: TitleProbe,
      track: TitleProbe["subtitles"][number],
      need: Need,
      attempt: Attempt,
    ): Promise<Before> {
      const still = () => {
        attempt.signal.throwIfAborted();
        if (session.kept !== kept) throw new Unavailable("changed");
      };
      const history = historyOf(kept, track.id);
      const ready = replayFor(history, need);
      if (ready) return { entries: ready, upTo: need.upTo, origin: probe.origin };
      // A provider that knows no byte ranges can't send the parts the steps below ask for: only
      // what the runs kept of its file serves, and nothing is asked of it.
      if (session.identity.ranges === false) throw new Unavailable("unreadable");
      const read = fileReader(session, kept, attempt);
      kept.layout ??= await readLayout(read);
      still();
      const layout = kept.layout;
      // ffmpeg numbers its streams by the tracks it reads, in the file's order.
      const entry = layout?.tracks[track.id];
      if (!layout || !entry?.subtitles) throw new Unavailable("unreadable");
      // After another file took the place of the one ffprobe read, the track has to be the same
      // kind still before its number means anything.
      if (session.identity.generation !== session.probed) {
        const codec = await codecOfTrack(selected(layout, entry.entry, []), attempt.signal);
        if (codec !== track.codec) throw new Unavailable("changed");
      }
      const listed = layout.cues.flatMap((cue) => (cue.track === entry.number ? [cue.time] : []));
      const index: TrackIndex | null = listed.length === 0 ? null : { times: listed };
      /** The file has been stepped through from its start to the position. */
      let whole = false;
      for (let tries = 0; ; tries++) {
        const entries = replayFor(history, need);
        if (entries) return { entries, upTo: need.upTo, origin: probe.origin };
        if (whole || tries >= SCANS_LIMIT) throw new Unavailable("limit");
        const stretch = nextScan(history, need, index, tries);
        await select(
          session,
          probe,
          layout,
          { ...entry, id: track.id, history },
          stretch,
          read,
          attempt,
        );
        still();
        whole = stretch.from === null;
      }
    }

    /**
     * Reads the session's file for a subtitle track's past: from memory, else from the provider,
     * a window at a time, when playback spares it a turn. A window is about what arrives in a
     * twentieth of a second, so a request is soon over when playback wants the provider back, and
     * what the steps through the file ask for next is mostly in it already. Each request counts
     * against what the attempt may take. Null when a part can't be had.
     */
    function fileReader(
      session: TitleSessionState,
      kept: FileKept,
      attempt: Attempt,
      most: { readonly bytes: number; readonly requests: number } = limits,
    ): ReadFile {
      return async (start, length) => {
        const size = session.identity.size;
        const known = kept.windows.read(start, length, size);
        if (known) return known;
        if (size !== null && start >= size) return Buffer.alloc(0);
        const rate = session.meter.rate;
        const window = attempt.narrow
          ? limits.windowLeast
          : Math.max(
              limits.windowLeast,
              Math.min(
                limits.windowMost,
                rate === null ? WINDOW_FIRST : Math.round(rate * WINDOW_S),
              ),
            );
        const end = Math.min(size ?? Number.POSITIVE_INFINITY, start + Math.max(window, length));
        const parts: Uint8Array[] = [];
        for (let position = start; position < end;) {
          const { spent } = attempt;
          if (spent.requests >= most.requests || spent.bytes + end - position > most.bytes) {
            throw new Unavailable("limit");
          }
          const lease = await session.slot.recover(attempt.signal);
          if (!lease) attempt.signal.throwIfAborted();
          if (!lease) return null;
          const signal = AbortSignal.any([attempt.signal, lease.revoked]);
          let body: ReadableStreamDefaultReader<Uint8Array> | null = null;
          spent.requests++;
          const began = performance.now();
          let got = 0;
          try {
            const found = await connect(
              session,
              session.upstreamUrl,
              { Range: `bytes=${position}-${end - 1}` },
              signal,
              FILE_RETRY_DELAYS_MS,
            );
            if (!found.ok) {
              // A turn that was taken away comes again; anything else is the provider's answer.
              if (lease.revoked.aborted && !attempt.signal.aborted) continue;
              attempt.signal.throwIfAborted();
              throw new Unavailable("network");
            }
            const held = observe(session, found.response, true);
            if (session.kept !== kept || held?.stale) {
              void found.response.body?.cancel().catch(() => {});
              throw new Unavailable("changed");
            }
            if (found.response.status !== 206 || held?.start !== position || !found.response.body) {
              void found.response.body?.cancel().catch(() => {});
              throw new Unavailable("unreadable");
            }
            body = found.response.body.getReader();
            for (;;) {
              const { done, value } = await body.read();
              if (done) break;
              parts.push(value);
              got += value.length;
              position += value.length;
              spent.bytes += value.length;
            }
            session.meter.add(got, performance.now() - began);
            if (got === 0) break;
          } catch (cause) {
            if (cause instanceof Unavailable) throw cause;
            // Taken away in the middle: what arrived counts, and the rest is asked for again.
            if (lease.revoked.aborted && !attempt.signal.aborted) continue;
            attempt.signal.throwIfAborted();
            throw new Unavailable("network");
          } finally {
            if (lease.revoked.aborted) {
              await body?.cancel().catch(() => {});
              await gone();
            }
            lease.release();
          }
        }
        const data = Buffer.concat(parts);
        kept.windows.keep(start, data);
        return data.subarray(0, length);
      };
    }

    /**
     * Reads a subtitle track from `stretch.from` to `stretch.to` on the file's clock, from the
     * start of the file when `from` is null, into the track's history. It steps through the
     * file's blocks from the cluster its index lists last before the stretch, takes the track's
     * packets, and has ffmpeg read them from a file of their own, as a run sends them. A packet
     * may sit a little off its own time, so the steps start and end that much wider. Throws
     * `Unavailable` when it couldn't, or when the file became another meanwhile.
     */
    async function select(
      session: TitleSessionState,
      probe: TitleProbe,
      layout: Layout,
      track: {
        readonly id: number;
        readonly number: number;
        readonly entry: Uint8Array;
        readonly history: SubtitleHistory;
      },
      stretch: { readonly from: number | null; readonly to: number },
      read: ReadFile,
      attempt: Attempt,
    ): Promise<void> {
      const apart = interleave(probe);
      const from = stretch.from === null ? null : stretch.from - apart;
      // The index says where to start; without an entry before the stretch, the file's start does.
      const cue = from === null ? undefined : layout.cues.findLast((each) => each.time <= from);
      const packets: { readonly clusterTime: number; readonly element: Uint8Array }[] = [];
      let bytes = 0;
      /** The times of the first block stepped over, and the latest of another track's. */
      let first: number | null = null;
      let reached = Number.NEGATIVE_INFINITY;
      let toEnd = true;
      const start = cue ?? { cluster: layout.firstCluster };
      // Where the index says the stretch ends, which says how much of the file it is. Read whole
      // that is soonest over; when it is more than the reading has left, only around each block's
      // header.
      const after = layout.cues.find((each) => each.time >= stretch.to + apart)?.cluster;
      const span = (after ?? session.identity.size ?? Number.POSITIVE_INFINITY) - start.cluster;
      attempt.narrow = attempt.spent.bytes + span > limits.bytes;
      try {
        for await (const step of blocks(read, layout, track.number, start)) {
          first ??= step.time;
          if (step.packet) {
            packets.push(step);
            bytes += step.element.length;
            if (bytes > limits.selected) throw new Unavailable("limit");
            continue;
          }
          reached = Math.max(reached, step.time);
          if (step.time >= stretch.to + apart) {
            toEnd = false;
            break;
          }
        }
      } catch (cause) {
        if (cause instanceof Unavailable) throw cause;
        attempt.signal.throwIfAborted();
        throw new Unavailable("unreadable");
      }
      if (cue !== undefined && first === null) throw new Unavailable("unreadable");
      const entries = await converted(session, probe, layout, track, packets, attempt.signal);
      const reading = track.history.reading(stretch.to);
      // Whole from a little after the first block: a packet before it may sit ahead of that.
      reading.begin(cue === undefined || first === null ? Number.NEGATIVE_INFINITY : first + apart);
      for (const entry of entries) reading.add(entry);
      if (!toEnd) reading.reach(reached - apart);
      reading.end(toEnd);
    }

    /**
     * The subtitles in `packets`, a track's packets as the file stores them: ffmpeg reads them
     * from a file of their own on its input and sends them as a run does, so they come the same
     * whatever the track's coding. Nothing of the provider's is read for it.
     */
    async function converted(
      session: TitleSessionState,
      probe: TitleProbe,
      layout: Layout,
      track: { readonly id: number; readonly entry: Uint8Array },
      packets: readonly { readonly clusterTime: number; readonly element: Uint8Array }[],
      signal: AbortSignal,
    ): Promise<readonly SubtitleEntry[]> {
      if (packets.length === 0) return [];
      const id = randomBytes(9).toString("base64url");
      const plan = selectedPlan(probe, track.id, `${base}/report/${session.token}/${id}/subtitles`);
      if (!deps.ffmpeg || !plan) throw new Unavailable("unreadable");
      const entries: SubtitleEntry[] = [];
      const subtitles = subtitleSink(plan.subtitle, (entry) => entries.push(entry));
      session.reports.set(id, { subtitles: subtitles.receive });
      const child = spawn(deps.ffmpeg, plan.args, { stdio: ["pipe", "ignore", "ignore"] });
      const stop = () => child.kill("SIGKILL");
      signal.addEventListener("abort", stop, { once: true });
      const exited = new Promise<number | null>((resolve) => {
        child.on("close", resolve);
        child.on("error", () => resolve(null));
      });
      // ffmpeg may be gone before it has taken its input.
      child.stdin.on("error", () => {});
      child.stdin.end(selected(layout, track.entry, packets));
      const code = await exited;
      // ffmpeg can be gone before the proxy has heard what it sent: that arrives in a moment.
      if (code === 0) await arrives(subtitles.arrived);
      const whole = await subtitles.whole();
      signal.removeEventListener("abort", stop);
      session.reports.delete(id);
      signal.throwIfAborted();
      if (code !== 0 || !whole) throw new Unavailable("unreadable");
      return entries;
    }

    /**
     * ffmpeg's name for the coding of the one track in `file`, a Matroska file as `selected`
     * writes them, or null when ffprobe can't say.
     */
    async function codecOfTrack(file: Buffer, signal: AbortSignal): Promise<string | null> {
      const ffprobe = deps.ffprobe;
      if (!ffprobe) return null;
      const output = await new Promise<string | null>((resolve) => {
        const child = execFile(
          ffprobe,
          ["-v", "error", "-print_format", "json", "-show_streams", "-i", "pipe:0"],
          { timeout: PROBE_TIMEOUT_MS, signal },
          (error, stdout) => resolve(error ? null : stdout),
        );
        child.stdin?.on("error", () => {});
        child.stdin?.end(file);
      });
      try {
        const probe = output === null ? null : readProbe(JSON.parse(output));
        return probe?.subtitles[0]?.codec ?? null;
      } catch {
        return null;
      }
    }

    /**
     * What a receiver asks this computer's address on the local network for. Only the session's
     * own playlists, segments and subtitles answer, under the token of what the receiver was last
     * sent, and only to an address of a local network. The token is what lets a receiver in; the
     * address only narrows who may try.
     */
    async function serveReceiver(
      session: Session,
      lan: Lan,
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<void> {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Cache-Control", "no-store");
      if (!isPrivateAddress(request.socket.remoteAddress ?? "")) {
        response.writeHead(403).end();
        return;
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "Access-Control-Allow-Headers": "Range" }).end();
        return;
      }
      // A path with ".." in it is resolved before it is matched, so it names nothing here.
      const url = new URL(request.url ?? "/", lan.origin);
      const route = RECEIVER_ROUTE.exec(url.pathname);
      const token =
        session.kind === "live" ? session.receiver?.token : session.receiver?.load?.token;
      if (!route || route[1] !== token || (request.method !== "GET" && request.method !== "HEAD")) {
        response.writeHead(410).end();
        return;
      }
      lan.requests++;
      const [, , playlist, , , made, address] = route;
      if (session.kind === "title") {
        const receiver = session.receiver;
        if (receiver?.load)
          await serveReceiverTitle(session, receiver, receiver.load, route, response);
        else response.writeHead(410).end();
        return;
      }
      const receiver = session.receiver;
      if (receiver && session.hls && (playlist === "live" || address !== undefined)) {
        await serveHls(session, session.hls, address ?? null, url, request, response);
      } else if (receiver && !session.hls && playlist === "live") {
        await sendLivePlaylist(session, receiver, response);
      } else {
        const segment = made === undefined ? undefined : receiver?.made.get(Number(made));
        if (!segment) response.writeHead(404).end();
        else {
          response.writeHead(200, {
            "Content-Type": "video/mp2t",
            "Content-Length": segment.length,
          });
          response.end(segment);
        }
      }
    }

    /**
     * A channel's playlist for a receiver: the segments made lately. The first one waits until
     * there are enough to start playing from, or the stream turns out not to come.
     */
    async function sendLivePlaylist(
      session: LiveSession,
      receiver: LiveReceiver,
      response: ServerResponse,
    ): Promise<void> {
      const left = new AbortController();
      response.on("close", () => left.abort());
      await until(
        receiver.changed,
        () => receiver.list.length >= LIVE_LIST.least || receiver.over,
        AbortSignal.any([session.closed.signal, left.signal, AbortSignal.timeout(LIVE_START_MS)]),
      );
      if (response.destroyed) return;
      if (receiver.list.length === 0) {
        const failure = session.failure;
        response.writeHead(failure && "status" in failure ? failure.status : 502).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      // A stream that is over says so, and the receiver stops asking.
      response.end(livePlaylist(receiver.list) + (receiver.over ? "#EXT-X-ENDLIST\n" : ""));
    }

    /**
     * Reads a channel's MPEG-TS from the provider for a receiver and has ffmpeg cut it into
     * segments, which come back here one by one (see `receiveLive`). The picture and the chosen
     * sound are copied when the receiver decodes them. One request to the provider, as for the
     * UI's player; it starts when the session opens, so the receiver finds segments when it asks.
     */
    async function runLive(session: LiveSession, receiver: LiveReceiver): Promise<void> {
      const started = performance.now();
      const report = (
        delivery: "direct" | "converted" | "none",
        outcome: "ok" | StreamFailure["kind"],
      ) =>
        diagnostics.record({
          op: "stream",
          ms: Math.round(performance.now() - started),
          delivery,
          outcome,
        });
      const active = new AbortController();
      session.active = active;
      const signal = AbortSignal.any([session.closed.signal, active.signal]);
      const over = (failure: StreamFailure) => {
        if (signal.aborted) return;
        session.failure ??= failure;
        receiver.over = true;
        tell(receiver.changed);
      };

      const opened = await openVariant(session, signal, (failure) => report("none", failure.kind));
      if (signal.aborted) {
        if (opened.ok) void opened.reader.cancel().catch(() => {});
        return;
      }
      if (!opened.ok) return over(opened.failure);
      const { reader, start } = opened;
      const { layout } = start;
      const ffmpeg = deps.ffmpeg;
      if (!layout || !ffmpeg) {
        void reader.cancel().catch(() => {});
        report("none", "unsupported");
        return over({
          kind: "unsupported",
          detail: ffmpeg
            ? t("A receiver plays channels sent as MPEG-TS or HLS, and this one is neither.")
            : t("This build has no ffmpeg to make a receiver's stream."),
        });
      }
      session.layout = layout;
      const video = layout.video;
      const cleaned =
        video && video.codec !== "unknown" && CLEAN_START_CODECS.has(video.codec)
          ? cleanStart(replay(start, reader), createCleanStart(video.pid, video.codec))
          : replay(start, reader);
      // The track asked for, else the sound in the viewer's language, else the channel's first.
      const chosen =
        layout.audio.find((track) => track.pid === session.audio) ??
        (session.audioLanguage
          ? layout.audio.find((track) => languageCode(track.language) === session.audioLanguage)
          : undefined) ??
        layout.audio[0];
      session.playing = chosen?.pid ?? null;
      const decodes = (codec: Codec | "unknown") =>
        codec !== "unknown" && session.decoders.has(codec);
      const segments: LiveSegments = {
        video: !video ? "none" : decodes(video.codec) ? "copy" : "h264",
        audio: !chosen ? "none" : decodes(chosen.codec) ? "copy" : "aac",
        pids: { video: video?.pid ?? null, audio: chosen?.pid ?? null },
      };
      const delivery =
        segments.video === "h264" || segments.audio === "aac" ? "converted" : "direct";

      const id = randomBytes(9).toString("base64url");
      receiver.run = id;
      receiver.first = (receiver.list.at(-1)?.index ?? -1) + 1;
      const made = `${base}/hls/${session.token}/${id}`;
      const child = spawn(
        ffmpeg,
        liveSegmentArguments(segments, receiver.first, `${made}/%d.ts`, `${made}/list`),
        { stdio: ["pipe", "ignore", "pipe"] },
      );
      let errors = "";
      child.stderr.on("data", (chunk: Buffer) => {
        errors = (errors + chunk.toString()).slice(-2000);
      });
      const stop = () => child.kill("SIGKILL");
      signal.addEventListener("abort", stop, { once: true });
      const body = Readable.from(cleaned);
      body.on("error", (cause) => {
        if (!signal.aborted) session.failure ??= { kind: "network", detail: String(cause) };
        child.stdin.end();
      });
      // ffmpeg stops reading when it fails or is killed; that write error is not the stream's.
      child.stdin.on("error", () => {});
      body.pipe(child.stdin);
      child.on("error", (cause) => over({ kind: "unsupported", detail: String(cause) }));
      child.on("close", (code) => {
        signal.removeEventListener("abort", stop);
        body.destroy();
        if (signal.aborted) return;
        const failure: StreamFailure =
          session.failure ??
          (code === 0
            ? { kind: "network", detail: t("The provider's stream ended.") }
            : {
                kind: "unsupported",
                detail: `${t("The stream could not be made into one a receiver plays.")} ${lastLine(errors, code, child.signalCode)}`,
              });
        report(delivery, failure.kind);
        over(failure);
      });
      report(delivery, "ok");
    }

    /**
     * What the ffmpeg of a channel's receiver stream sends back: a segment (`index`), kept until
     * the playlist has moved past it, or its list of the segments that are whole, which puts
     * them in the playlist.
     */
    function receiveLive(
      session: LiveSession,
      run: string,
      index: number | null,
      request: IncomingMessage,
      response: ServerResponse,
    ): void {
      const receiver = session.receiver;
      if (!receiver || receiver.run !== run) {
        request.resume();
        response.writeHead(410).end();
        return;
      }
      request.on("error", () => {});
      if (index !== null) {
        const parts: Buffer[] = [];
        let size = 0;
        request.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > LIVE_SEGMENT_BYTES) request.destroy();
          else parts.push(chunk);
        });
        request.on("end", () => {
          if (receiver.run === run) receiver.made.set(index, Buffer.concat(parts));
          response.writeHead(204).end();
        });
        return;
      }
      // The list comes anew with each segment: what it names that the playlist hasn't yet goes in.
      let text = "";
      request.setEncoding("utf8");
      request.on("data", (part: string) => {
        if (text.length < 64 * 1024) text += part;
      });
      request.on("end", () => {
        response.writeHead(204).end();
        if (receiver.run !== run) return;
        for (const listed of listedSegments(text)) {
          const newest = receiver.list.at(-1)?.index ?? -1;
          if (listed.index <= newest || !receiver.made.has(listed.index)) continue;
          // The first of an ffmpeg that isn't the session's first: the provider's stream started
          // again, and its clock did too.
          const fresh = receiver.list.length > 0 && listed.index === receiver.first;
          receiver.list = [...receiver.list, { ...listed, fresh }].slice(-LIVE_LIST.kept);
          // One behind the playlist stays, for a receiver that asks for it a moment late.
          const oldest = receiver.list[0]!.index - 1;
          for (const kept of receiver.made.keys()) if (kept < oldest) receiver.made.delete(kept);
        }
        tell(receiver.changed);
      });
    }

    /**
     * Where the segments of the session's title start for a receiver: on the keyframes the file's
     * index names when the receiver decodes the picture and the index can be read and used, and
     * every few seconds with the picture converted otherwise. Reading the index takes a few
     * requests of the provider and a bounded amount, before anything plays. Null when the file
     * has no picture or doesn't say how long it is: it gets no playlist then.
     */
    async function planSegments(
      session: TitleSessionState,
      probe: TitleProbe,
    ): Promise<Pick<TitleReceiver, "plan" | "index"> | null> {
      const video = probe.video;
      const end = endOf(probe);
      if (!video || end === null) return null;
      const converted = () => {
        const plan = convertPlan(video.start, end);
        return plan && { plan, index: "none" as const };
      };
      if (video.codec === null || !session.decoders.has(video.codec)) return converted();
      const attempt: Attempt = {
        signal: AbortSignal.any([session.closed.signal, AbortSignal.timeout(INDEX_LIMITS.ms)]),
        spent: { bytes: 0, requests: 0 },
        narrow: false,
      };
      const read = fileReader(session, session.kept, attempt, INDEX_LIMITS);
      let keyframes: number[] | null = null;
      let index: TitleReceiver["index"] = "none";
      try {
        if (probe.container === "matroska") {
          const layout = (session.kept.layout ??= await readLayout(read));
          // ffmpeg numbers its streams by the tracks it reads, in the file's order.
          const track = layout?.tracks[video.id]?.number;
          keyframes =
            layout && track !== undefined
              ? layout.cues.flatMap((cue) => (cue.track === track ? [cue.time] : []))
              : null;
          index = "cues";
        } else if (probe.container === "mp4") {
          // A cached probe hasn't read this session's source. Learn its size through the same
          // bounded reader; the index then reuses the header's kept window.
          if (session.identity.size === null) await read(0, 16);
          if (session.identity.size !== null) {
            const times = await mp4Keyframes(read, session.identity.size, video.id);
            keyframes = times && times.map((time) => video.start + time);
            index = "samples";
          }
        }
      } catch {
        // The provider didn't give the index, or it is more than may be read.
        keyframes = null;
      }
      const plan = keyframes && keyframes.length > 0 ? copyPlan(keyframes, video.start, end) : null;
      return plan ? { plan, index } : converted();
    }

    /** A receiver's request for something of a title: a playlist, a segment or a segment's subtitles. */
    async function serveReceiverTitle(
      session: TitleSessionState,
      receiver: TitleReceiver,
      load: TitleLoad,
      route: RegExpExecArray,
      response: ServerResponse,
    ): Promise<void> {
      const [, , playlist, video, cues] = route;
      const probe = session.probe;
      if (!probe) {
        response.writeHead(410).end();
        return;
      }
      // A receiver that asks is still there: the run may go on, and does while a request waits.
      const idle = () => {
        clearTimeout(load.idle);
        load.idle = setTimeout(
          () => (load.store.awaited().length > 0 ? idle() : load.run?.stop()),
          deps.receiver?.idleMs ?? RECEIVER_IDLE_MS,
        );
      };
      idle();
      const { plan } = receiver;
      const text = (body: string) => {
        response.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        response.end(body);
      };
      if (playlist === "master") {
        const size = session.identity.size;
        const track = subtitleTracks(probe.subtitles).find((each) => each.id === load.subtitle);
        text(
          masterPlaylist(
            size !== null ? (size * 8) / (plan.end - plan.starts[0]!) : 8_000_000,
            track ? { name: track.label, language: languageCode(track.language) } : null,
          ),
        );
      } else if (playlist === "video") text(titlePlaylist(plan, (index) => `v${index}.ts`));
      else if (playlist === "subs" && load.subtitle !== null) {
        text(titlePlaylist(plan, (index) => `s${index}.vtt`));
      } else if (video !== undefined && Number(video) < plan.starts.length) {
        await sendSegment(session, receiver, load, Number(video), response);
      } else if (
        cues !== undefined &&
        load.subtitle !== null &&
        Number(cues) < plan.starts.length
      ) {
        await sendCues(receiver, load, Number(cues), response);
      } else response.writeHead(404).end();
    }

    /**
     * A segment of a title for a receiver, once it is made. Where the receiver asks is where it
     * is: a run that isn't about to make the segment gives way to one that starts with it, so a
     * skip anywhere in the title costs one new request to the provider, as for the UI's player.
     */
    async function sendSegment(
      session: TitleSessionState,
      receiver: TitleReceiver,
      load: TitleLoad,
      index: number,
      response: ServerResponse,
    ): Promise<void> {
      const left = new AbortController();
      response.on("close", () => left.abort());
      const run = load.run;
      // The one being taken from ffmpeg now, or the next: anything further is sooner had afresh.
      const coming =
        run !== null &&
        !run.ended &&
        !run.signal.aborted &&
        index >= run.next &&
        index <= run.next + 1 &&
        index < run.from + run.count;
      if (!load.store.has(index) && !coming) startRun(session, receiver, load, index);
      const late = AbortSignal.timeout(deps.receiver?.segmentMs ?? SEGMENT_WAIT_MS);
      const segment = await load.store.take(
        index,
        AbortSignal.any([load.closed.signal, left.signal, late]),
      );
      noteAhead(session, load);
      if (!segment && late.aborted && !left.signal.aborted && !load.closed.signal.aborted) {
        // The provider, or the ffmpeg reading it, has stopped. The run ends, which frees the
        // provider, and whoever opened the session hears; asking again starts a new one.
        const failure: StreamFailure = (session.failure ??= {
          kind: "network",
          detail: t("The provider did not send the file in time."),
        });
        load.run?.stop();
        load.store.fail();
        session.lan?.failed(failure);
        if (!response.destroyed) response.writeHead(504).end();
        return;
      }
      if (response.destroyed) return;
      if (!segment) {
        const failure = session.failure;
        response.writeHead(failure && "status" in failure ? failure.status : 503).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": segment.length });
      response.end(segment);
    }

    /**
     * Tells the session how much of the title waits for the receiver, which says when a reading
     * of a subtitle track's past may have the provider: while ffmpeg is held, playback spares it.
     */
    function noteAhead(session: TitleSessionState, load: TitleLoad): void {
      const run = load.run;
      session.progress = {
        buffered: load.store.ahead * SEGMENT_S,
        paused: run !== null && !run.ended && !load.store.room(run.next),
        at: performance.now(),
      };
      session.slot.look();
    }

    /**
     * Starts the ffmpeg that makes a title's segments from segment `from` on, in place of the one
     * before. `mismatch` when it takes the place of a copied run whose segment didn't start where
     * the file's index said.
     */
    function startRun(
      session: TitleSessionState,
      receiver: TitleReceiver,
      load: TitleLoad,
      from: number,
      mismatch = false,
    ): void {
      const probe = session.probe;
      const ffmpeg = deps.ffmpeg;
      if (!probe || !ffmpeg) return;
      const started = performance.now();
      load.run?.stop();
      // Requests that wait for a segment this run doesn't bring first get none.
      for (const index of load.store.awaited()) {
        if (index < from || index > from + 1) load.store.fail(index);
      }
      const { plan } = receiver;
      const abort = new AbortController();
      const signal = AbortSignal.any([load.closed.signal, abort.signal]);
      const id = randomBytes(9).toString("base64url");
      const reportUrl = (what: string) => `${base}/report/${session.token}/${id}/${what}`;
      const cuts = runCuts(
        plan,
        from,
        probe.origin,
        // ffmpeg's reader for MP4 seeks by presentation time; see `runCuts`.
        probe.video?.reordered === true && probe.container !== "mp4",
      );
      const planned = receiverPlan(
        probe,
        {
          audio: load.audio,
          subtitle: load.subtitle,
          convert: plan.video === "convert",
          cuts,
          from,
          first: plan.starts[0]!,
        },
        session.decoders,
        {
          source: `${base}/source/${session.token}`,
          // ffmpeg starts sending the next segment without waiting for an answer to the last,
          // and would read the whole file ahead of the receiver. With a name in the address it
          // asks first, "Expect: 100-continue", as it does to learn how a server wants a login,
          // and waits for the answer; the proxy wants none and answers when there is room.
          segments: `http://ffmpeg@127.0.0.1:${port}/hls/${session.token}/${id}/%d.ts`,
          subtitles: reportUrl("subtitles"),
        },
      );
      let reported = false;
      const report = (outcome: "ok" | StreamFailure["kind"]) => {
        if (reported) return;
        reported = true;
        diagnostics.record({
          op: "receiver",
          ms: Math.round(performance.now() - started),
          video: planned.video,
          audio: planned.audio,
          index: mismatch ? "mismatch" : planned.video === "copy" ? receiver.index : "none",
          outcome,
        });
      };

      // A new run starts clean: what went wrong before was dealt with, or happens again.
      session.failure = null;
      session.starting = abort;
      session.running = abort;
      session.progress = null;
      // ffmpeg asks for the file in a moment: recovery's request is over by then.
      session.slot.clear();
      /** The run's first segment reached the store, or never will: recovery may read again. */
      const settled = () => {
        if (session.starting !== abort) return;
        session.starting = null;
        session.slot.look();
      };

      const child = spawn(ffmpeg, planned.args, { stdio: ["ignore", "ignore", "pipe"] });
      let errors = "";
      child.stderr.on("data", (chunk: Buffer) => {
        errors = (errors + chunk.toString()).slice(-2000);
      });
      const stop = () => {
        child.kill("SIGKILL");
        settled();
      };
      signal.addEventListener("abort", stop, { once: true });
      const exited = new Promise<number | null>((resolve) => {
        child.on("close", resolve);
        child.on("error", (cause) => {
          errors = String(cause);
          resolve(null);
        });
      });

      const expected = plan.starts[from]!;
      const cues: SubtitleEntry[] = [];
      // What the run reads of its subtitle track is kept with the session's file, as a run of the
      // UI's player keeps it, so a later position finds it read.
      const kept = session.kept;
      const generation = session.identity.generation;
      const reading =
        planned.subtitle && load.subtitle !== null
          ? historyOf(kept, load.subtitle).reading()
          : null;
      const subtitles =
        planned.subtitle && reading
          ? subtitleSink(planned.subtitle, (entry) => {
              // What it reads now is of another file than it started in.
              if (session.identity.generation !== generation) return;
              reading.add(entry);
              reading.reach(entry.from - interleave(probe));
              cues.push(entry);
              tell(load.changed);
            })
          : null;
      reading?.begin(from === 0 ? Number.NEGATIVE_INFINITY : expected + interleave(probe));
      if (subtitles) session.reports.set(id, { subtitles: subtitles.receive });

      const run: ReceiverRun = {
        id,
        from,
        count: cuts.count,
        next: from,
        ended: false,
        signal,
        stop: () => abort.abort(),
        cues,
        // From the start of the file a run reads every line itself.
        before:
          load.subtitle === null || from === 0
            ? Promise.resolve(null)
            : cuesBefore(session, probe, load, load.subtitle, expected - probe.origin, signal),
      };
      load.run = run;

      void exited.then(async (code) => {
        signal.removeEventListener("abort", stop);
        const whole = (await subtitles?.whole()) === true;
        // ffmpeg exits cleanly after its input broke off too; the source knows better.
        reading?.end(whole && code === 0 && !signal.aborted && !session.failure);
        session.reports.delete(id);
        run.ended = true;
        if (session.running === abort) session.running = null;
        settled();
        if (signal.aborted) return;
        if (code !== 0 || session.failure) {
          session.failure ??= {
            kind: "unsupported",
            detail: `${t("The file could not be played.")} ${lastLine(errors, code, child.signalCode)}`,
          };
          report(session.failure.kind);
          // Nothing more comes of this run, and the next would fail the same way.
          load.store.fail();
        } else {
          // It read the file to its end: a segment still waited for isn't in it.
          for (const index of load.store.awaited()) if (index >= run.next) load.store.fail(index);
        }
        tell(load.changed);
      });
      run.settled = () => {
        report("ok");
        settled();
      };
    }

    /**
     * A segment a title's ffmpeg sends back. ffmpeg asks before it sends one (see `startRun`),
     * and is told to go on only when the receiver is near that segment, which holds ffmpeg, and
     * through it the provider's connection, while the receiver has enough. What follows a run's
     * last cut isn't a segment of the playlist: the run ends there.
     *
     * The receiver has the playlist already, so every segment has to hold what that says: its
     * pictures' times are read from the segment itself, the first where the segment starts and
     * none at or after where the next does. A copied one that doesn't means the file's index
     * named a keyframe that isn't there, or left the segment too long to keep: the title's
     * picture is converted from then on, with keyframes made at the same starts. A converted one
     * that doesn't can't be put right, and fails the stream.
     */
    async function receiveSegment(
      session: TitleSessionState,
      id: string,
      index: number,
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<void> {
      const receiver = session.receiver;
      const load = receiver?.load;
      const run = load?.run;
      const refuse = () => {
        request.resume();
        if (!response.headersSent) response.writeHead(410).end();
      };
      if (!receiver || !load || !run || run.id !== id) return refuse();
      if (index >= run.from + run.count) {
        run.stop();
        return refuse();
      }
      /** The segment isn't what the playlist says: converted from here on, if it was copied. */
      const wrong = () => {
        run.stop();
        if (receiver.plan.video === "copy") {
          receiver.plan = { ...receiver.plan, video: "convert" };
          startRun(session, receiver, load, index, true);
        } else {
          session.failure ??= {
            kind: "unsupported",
            detail: t("The file's picture can't be cut where a receiver's playlist needs it."),
          };
          load.store.fail();
        }
        refuse();
      };
      request.on("error", () => {});
      run.next = index;
      // ffmpeg asked before sending: it waits here, having read no more of the provider's file
      // than this segment took.
      await load.store.whenRoom(index, run.signal);
      if (run.signal.aborted) return refuse();
      if (request.headers.expect) response.writeContinue();
      const parts: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of request as AsyncIterable<Buffer>) {
          if (run.signal.aborted) return refuse();
          size += chunk.length;
          if (size > load.store.limits.segment) return wrong();
          parts.push(chunk);
        }
      } catch {
        return refuse();
      }
      if (run.signal.aborted) return refuse();
      const segment = Buffer.concat(parts);
      const listed = segmentSpan(receiver.plan, index);
      const shows = pictureSpan(segment);
      if (
        shows === null ||
        Math.abs(shows.first - listed.start) > listed.within ||
        (listed.end !== null && shows.last >= listed.end + listed.within)
      ) {
        return wrong();
      }
      load.store.put(index, segment);
      run.next = index + 1;
      run.settled?.();
      noteAhead(session, load);
      tell(load.changed);
      response.writeHead(204).end();
    }

    /**
     * What a text subtitle track holds from before `start` seconds into the title that a run
     * from there doesn't bring: the line on screen at the position, above all. It is read as for
     * the UI's player (see `subtitlesBefore`), when playback spares the provider. Null when it
     * can't be had, which the diagnostics note: the track then shows from its next line.
     */
    async function cuesBefore(
      session: TitleSessionState,
      probe: TitleProbe,
      load: TitleLoad,
      track: number,
      start: number,
      signal: AbortSignal,
    ): Promise<Before | null> {
      const started = performance.now();
      const spent: Spent = { bytes: 0, requests: 0 };
      const attempt: Attempt = {
        signal: AbortSignal.any([signal, AbortSignal.timeout(limits.ms)]),
        spent,
        narrow: false,
      };
      const record = (outcome: "ok" | SubtitlesUnavailable) =>
        diagnostics.record({
          op: "subtitles",
          ms: Math.round(performance.now() - started),
          bytes: spent.bytes,
          requests: spent.requests,
          kept: session.kept.windows.most,
          heldMs: Math.round(session.slot.counts.recoveryMs),
          waitedMs: Math.round(session.slot.counts.longestWaitMs),
          revoked: session.slot.counts.revoked,
          outcome,
        });
      // What the receiver has waiting counts for two seconds, as what a player says does.
      const noting = setInterval(() => noteAhead(session, load), 500);
      session.recovering++;
      try {
        const before = await subtitlesBefore(
          session,
          probe,
          { track, page: null, codec: "", start: Math.max(0, start) },
          attempt,
        );
        if (!signal.aborted) record("ok");
        return before;
      } catch (cause) {
        if (!signal.aborted) {
          record(
            cause instanceof Unavailable
              ? cause.kind
              : attempt.signal.aborted
                ? "limit"
                : "unreadable",
          );
        }
        return null;
      } finally {
        clearInterval(noting);
        session.recovering--;
        tell(load.changed);
      }
    }

    /**
     * A segment's text subtitles for a receiver: every line on screen at some time in it, the one
     * that began before it included. They are known once a run that began at or before the
     * segment has read past its end. A receiver that asks sooner waits, a while at most, and gets
     * a segment without lines rather than none: the picture never waits for subtitles.
     */
    async function sendCues(
      receiver: TitleReceiver,
      load: TitleLoad,
      index: number,
      response: ServerResponse,
    ): Promise<void> {
      const left = new AbortController();
      response.on("close", () => left.abort());
      const signal = AbortSignal.any([
        load.closed.signal,
        left.signal,
        AbortSignal.timeout(deps.receiver?.cuesMs ?? CUES_WAIT_MS),
      ]);
      const reader = () => {
        const run = load.run;
        return run && run.from <= index && (run.next > index + 1 || run.ended) ? run : null;
      };
      await until(load.changed, () => reader() !== null, signal);
      const run = reader();
      // What came before the run's start is still being read, or the wait is already over: the
      // segment goes without it then.
      const before = run ? await unlessAborted(run.before, signal) : null;
      if (response.destroyed) return;
      const { plan } = receiver;
      const entries = run
        ? [
            ...(before?.entries ?? []),
            ...run.cues.filter((cue) => !before || cue.from > before.upTo),
          ]
        : [];
      response.writeHead(200, { "Content-Type": "text/vtt; charset=utf-8" });
      response.end(
        subtitleSegment(
          entries,
          plan.starts[index]!,
          plan.starts[index + 1] ?? plan.end,
          plan.starts[0]!,
        ),
      );
    }

    /** What ffmpeg sends back: a run's or a selection's subtitles, or where a picture starts. */
    function receiveReport(
      session: TitleSessionState,
      id: string,
      what: string,
      request: IncomingMessage,
      response: ServerResponse,
    ): void {
      const reports = session.reports.get(id);
      const received = () => response.writeHead(204).end();
      if (what === "start" && reports?.start) {
        const relay = reports.start;
        request.setEncoding("utf8");
        request.on("data", (text: string) => relay.write(text));
        request.on("error", () => relay.end());
        request.on("end", () => {
          relay.end();
          received();
        });
        return;
      }
      const take = what === "subtitles" ? reports?.subtitles : undefined;
      if (!take) {
        response.writeHead(410).end();
        return;
      }
      take(request);
      request.on("end", received);
    }

    /**
     * Reads what the session's file holds with ffprobe, through the session's source, unless it
     * is known from when the title was open before. What was read is known for the next time
     * only when the file stayed the same one meanwhile.
     */
    async function probeTitle(session: TitleSessionState): Promise<TitleProbe> {
      const known = probes.get(session.probeKey);
      if (known) return known;
      const ffprobe = deps.ffprobe;
      if (!ffprobe) {
        throw new Failed({
          error: {
            kind: "stream",
            failure: {
              kind: "unsupported",
              detail: t("This build has no ffprobe to read movies."),
            },
          },
        });
      }
      const generation = session.identity.generation;
      const output = await new Promise<string | null>((resolve) => {
        const child = execFile(
          ffprobe,
          [...PROBE_ARGUMENTS, `${base}/source/${session.token}`],
          { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
          (error, stdout) => {
            session.closed.signal.removeEventListener("abort", stop);
            resolve(error ? null : stdout);
          },
        );
        const stop = () => void child.kill("SIGKILL");
        session.closed.signal.addEventListener("abort", stop, { once: true });
      });
      let json: unknown = null;
      try {
        json = output === null ? null : JSON.parse(output);
      } catch {
        // Not JSON: the file couldn't be read, handled below.
      }
      const probe = json === null ? null : readProbe(json);
      if (!probe || (!probe.video && probe.audio.length === 0)) {
        throw new Failed({
          error: {
            kind: "stream",
            failure: session.failure ?? {
              kind: "unsupported",
              detail: t("The file has no picture or sound Mr. Streamer can read."),
            },
          },
        });
      }
      if (session.identity.generation === generation) {
        probes.set(session.probeKey, probe);
        if (probes.size > PROBES_KEPT) probes.delete(probes.keys().next().value ?? "");
      }
      return probe;
    }

    /**
     * Requests `url` through the session's provider, retrying briefly when it refuses: it can take
     * a moment to free the connection of a request we just closed.
     */
    async function connect(
      session: Session,
      url: string,
      headers: Readonly<Record<string, string>>,
      signal: AbortSignal,
      retryDelays: readonly number[] = REFUSED_RETRY_DELAYS_MS,
    ): Promise<{ ok: true; response: Response } | { ok: false; failure: StreamFailure }> {
      for (let attempt = 0; ; attempt++) {
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), CONNECT_TIMEOUT_MS);
        let response: Response;
        try {
          const requested = new Headers({ "User-Agent": deps.userAgent });
          if (session.kind === "title")
            session.headers.forEach((value, name) => requested.set(name, value));
          new Headers(headers).forEach((value, name) => requested.set(name, value));
          response = await session.request(url, {
            headers: requested,
            signal: AbortSignal.any([signal, timeout.signal]),
          });
        } catch (cause) {
          return {
            ok: false,
            failure: {
              kind: "network",
              detail: timeout.signal.aborted
                ? t("The provider did not answer in time.")
                : cause instanceof Error
                  ? cause.message
                  : String(cause),
            },
          };
        } finally {
          clearTimeout(timer);
        }

        if (response.ok) return { ok: true, response };
        await response.body?.cancel();
        const failure = classify(response.status);
        const delay = retryDelays[attempt];
        if (failure.kind !== "refused" || delay === undefined || signal.aborted)
          return { ok: false, failure };
        // The wait ends with whoever asked: a turn at the provider that was taken away is given
        // back at once.
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, delay);
          signal.addEventListener("abort", done, { once: true });
        });
        if (signal.aborted) return { ok: false, failure };
      }
    }

    /**
     * The session's address on the local network: `receiver`'s address of this computer, on a
     * free port, for as long as `sessionScope` lasts. Fails with `no-network` when this computer
     * has that address no longer.
     */
    const serveLan = (receiver: ReceiverTarget, sessionScope: Scope.Closeable, id: string) =>
      Effect.gen(function* () {
        const listening = yield* Effect.tryPromise({
          try: () =>
            listen((request, response) => {
              const session = sessions.get(id);
              if (session?.lan) void serveReceiver(session, session.lan, request, response);
              else response.writeHead(410).end();
            }, receiver.address),
          catch: () => new Failed({ error: { kind: "output", failure: { kind: "no-network" } } }),
        });
        yield* Scope.addFinalizer(
          sessionScope,
          Effect.sync(() => {
            listening.server.closeAllConnections();
            listening.server.close();
          }),
        );
        return {
          origin: `http://${receiver.address}:${listening.port}`,
          requests: 0,
          failed: (failure) => receiver.failed?.(failure),
        } satisfies Lan;
      });

    /** A session's scope and what ends with it; `receiver` hears of its end. */
    const sessionScope = (id: string, receiver: ReceiverTarget | null) =>
      Effect.gen(function* () {
        const closed = new AbortController();
        const forked = yield* Scope.fork(scope);
        yield* Scope.addFinalizer(
          forked,
          Effect.sync(() => {
            closed.abort();
            sessions.delete(id);
            coordination.closed(id);
            receiver?.closed?.();
          }),
        );
        const lan = receiver
          ? yield* serveLan(receiver, forked, id).pipe(
              Effect.tapError(() => Scope.close(forked, Exit.void)),
            )
          : null;
        return { closed, scope: forked, lan };
      });

    /**
     * Opens a channel's session after closing any other, for the UI's player or `receiver`,
     * unless the viewer asked for something else while its streams were looked up.
     */
    const liveSession = (
      channel: OwnedId,
      decoders: readonly Codec[],
      options: {
        readonly variants?: readonly string[];
        readonly repair?: boolean;
        readonly audio?: number | null;
        readonly audioLanguage?: string | null;
        readonly turn?: number | undefined;
      },
      receiver: ReceiverTarget | null,
    ) =>
      Effect.gen(function* () {
        const source = yield* subscriptions.sourceOf(channel.subscriptionId);
        yield* closeAll;

        const now = Date.now();
        for (const [url, at] of failedAt) if (now - at > FAILED_STREAM_MS) failedAt.delete(url);
        // Streams that failed lately go last, in the order they came. The player picks its
        // engine by the format before the stream starts, so those of another format than the
        // first's stay out.
        const listed = yield* Effect.forEach(
          options.variants?.length ? options.variants : [channel.id],
          (id) =>
            Effect.tryPromise({
              try: (signal) => source.provider.liveStream(id, signal),
              catch: failedWith,
            }).pipe(Effect.map((stream) => ({ id, ...stream }))),
        );
        // Looked up under the login it had: with another by now, they are no longer its streams.
        yield* whileSaved(source);
        yield* coordination.whileAsked(options.turn);
        const streams = listed.toSorted(
          (a, b) => Number(failedAt.has(a.url)) - Number(failedAt.has(b.url)),
        );
        const format = streams[0]?.format ?? "mpegts";
        const variants = streams.flatMap(({ id, url, format: other, headers }) =>
          other === format ? [{ id, url, headers: headers ?? {} }] : [],
        );
        const id = randomUUID();
        const { closed, scope: forked, lan } = yield* sessionScope(id, receiver);
        const token = randomBytes(18).toString("base64url");
        const live: LiveReceiver | null = lan
          ? {
              token: randomBytes(18).toString("base64url"),
              made: new Map(),
              list: [],
              run: null,
              first: 0,
              over: false,
              changed: new Set(),
            }
          : null;
        const session: LiveSession = {
          kind: "live",
          id,
          token,
          channel,
          variants,
          delivered: { variantId: null, failed: [] },
          request: source.provider.request,
          format,
          hls: format === "hls" ? hlsAddresses() : null,
          proxied:
            lan && live
              ? (address) => `${lan.origin}/r/${live.token}/h${address}`
              : (address) => `${base}/stream/${token}/${address}`,
          receiver: live,
          lan,
          decoders: new Set(decoders),
          repair: options.repair ?? false,
          audio: options.audio ?? null,
          audioLanguage: options.audioLanguage ?? null,
          layout: null,
          playing: null,
          captions: [],
          closed,
          scope: forked,
          active: null,
          failure: null,
        };
        register(session);
        return session;
      });

    /**
     * A title session of `origin`'s file, read through `request`, and what its file holds as
     * ffprobe read it. Whatever has to close first has closed. A file that can't be read closes the
     * session again and fails.
     */
    const fileSession = (
      id: string,
      origin: TitleOrigin,
      file: {
        readonly url: string;
        readonly headers: Headers;
        readonly request: Provider["request"];
        readonly probeKey: string;
      },
      decoders: readonly Codec[],
      receiver: ReceiverTarget | null,
    ) =>
      Effect.gen(function* () {
        const { closed, scope: forked, lan } = yield* sessionScope(id, receiver);
        const session: TitleSessionState = {
          kind: "title",
          subtitleFileChanged: new AbortController(),
          id,
          token: randomBytes(18).toString("base64url"),
          origin,
          upstreamUrl: file.url,
          headers: file.headers,
          probeKey: file.probeKey,
          request: file.request,
          decoders: new Set(decoders),
          closed,
          scope: forked,
          lan,
          active: null,
          failure: null,
          probe: null,
          probed: 0,
          source: null,
          readForwardAt: null,
          readAheadNotifiedAt: null,
          slot: upstreamSlot(
            {
              starting: () => session.starting !== null,
              attached: () => session.running !== null,
              reading: () => session.reading > 0,
              progress: () => session.progress,
            },
            { ...UPSTREAM_LIMITS, ...deps.upstream },
          ),
          meter: rateMeter(),
          identity: sourceIdentity(),
          kept: fileKept(),
          starting: null,
          running: null,
          recovering: 0,
          reading: 0,
          progress: null,
          reports: new Map(),
          feed: null,
          live: null,
          receiver: null,
        };
        register(session);
        const probe = yield* Effect.tryPromise({
          try: () => probeTitle(session),
          catch: (cause) => (cause instanceof Failed ? cause : failedWith(cause)),
        }).pipe(Effect.tapError(() => Scope.close(forked, Exit.void)));
        session.probe = probe;
        session.probed = session.identity.generation;
        return { session, probe };
      });

    /**
     * Opens a title's session after closing any other and reads what its file holds, for the
     * UI's player or `receiver`. `standing` fails, and closes the session, once the viewer asked
     * for something else or the subscription's login changed: the file was read meanwhile, and
     * whatever else the open waits for goes the same way.
     */
    const titleSession = (
      title: TitleRef,
      upstreamUrl: string,
      decoders: readonly Codec[],
      receiver: ReceiverTarget | null,
      asked: Asked,
    ) =>
      Effect.gen(function* () {
        const source = yield* subscriptions.sourceOf(title.subscriptionId);
        // The address holds the login it was made under: under another, it is nobody's file.
        if (asked.revision !== undefined && asked.revision !== source.revision) {
          return yield* new Failed({ error: { kind: "no-subscription" } });
        }
        yield* closeAll;
        const headers = new Headers(asked.headers);
        const id = randomUUID();
        // Only this session's successful write can be forgotten by its replacement. Address-derived
        // probe keys stay in memory, including on cached-probe opens.
        const fileKey = id;
        const verified: Verified | null = asked.listingKey
          ? {
              account: source.key,
              sourceStamp: source.fileRevision,
              listingKey: asked.listingKey,
              fileKey,
            }
          : null;
        const { session, probe } = yield* fileSession(
          id,
          { kind: "provider", title, verified },
          {
            url: upstreamUrl,
            headers,
            request: source.provider.request,
            probeKey: createHash("sha256")
              .update(
                JSON.stringify([
                  source.id,
                  source.revision,
                  title.kind,
                  title.id,
                  upstreamUrl,
                  [...headers],
                ]),
              )
              .digest("hex"),
          },
          decoders,
          receiver,
        );
        const standing = Effect.andThen(
          coordination.whileAsked(asked.turn),
          whileSaved(source),
        ).pipe(Effect.tapError(() => Scope.close(session.scope, Exit.void)));
        yield* standing;
        if (verifiedFiles && verified && probes.get(session.probeKey) === probe) {
          const { account, sourceStamp, listingKey } = verified;
          yield* verifiedFiles
            .remember(account, sourceStamp, {
              kind: title.kind,
              id: title.id,
              ...(title.kind === "episode" ? { seriesId: title.seriesId } : {}),
              fileKey,
              listingKey,
              audio: audioTracks(probe.audio).map((track) => track.language),
              subtitles: subtitleTracks(probe.subtitles).map((track) => track.language),
            })
            .pipe(Effect.ignore);
        }
        return { session, probe, standing };
      });

    return {
      subtitleContext: (sessionId: string) =>
        Effect.gen(function* () {
          const session = sessions.get(sessionId);
          if (
            !session ||
            session.kind !== "title" ||
            session.lan ||
            session.closed.signal.aborted ||
            session.identity.generation !== session.probed
          )
            return null;
          const { origin } = session;
          const open = () =>
            sessions.get(sessionId) === session &&
            !session.closed.signal.aborted &&
            !session.subtitleFileChanged.signal.aborted &&
            session.identity.generation === session.probed;
          const signal = AbortSignal.any([
            session.closed.signal,
            session.subtitleFileChanged.signal,
          ]);
          // A copy's saved subtitles are its own, for as long as it plays.
          if (origin.kind === "copy") {
            return {
              kind: "copy",
              file: origin.file,
              standing: Effect.sync(open),
              signal,
              proof: () => null,
            } satisfies SubtitlePlayback;
          }
          const { title, verified } = origin;
          if (!verified) return null;
          const file: SubtitleFile = {
            account: verified.account,
            sourceStamp: verified.sourceStamp,
            listingKey: verified.listingKey,
            kind: title.kind,
            id: title.id,
          };
          const standing = Effect.gen(function* () {
            if (!open()) return false;
            const source = yield* subscriptions.sourceOf(title.subscriptionId);
            return source.key === file.account && source.fileRevision === file.sourceStamp;
          });
          if (!(yield* standing)) return null;
          return {
            kind: "provider",
            title,
            file,
            standing,
            signal,
            proof: () => (open() ? session.identity.proof : null),
          } satisfies SubtitlePlayback;
        }),

      openCopy: (copy: LocalCopy, decoders: readonly Codec[], turn?: number) =>
        coordination.inTurn(
          turn,
          Effect.gen(function* () {
            // What plays here goes; a receiver plays on, and a copy plays here only.
            yield* Effect.forEach(
              [...sessions.values()].filter((session) => session.lan === null),
              (session) => Scope.close(session.scope, Exit.void),
              { discard: true },
            );
            const { session, probe } = yield* fileSession(
              randomUUID(),
              { kind: "copy", copy: copy.id, file: subtitlesOfCopy(copy.id, copy.title) },
              {
                url: `copy:${copy.id}`,
                headers: new Headers(),
                request: fileRequest(copy.path, copy.container),
                probeKey: createHash("sha256")
                  .update(JSON.stringify(["copy", copy.id, copy.path]))
                  .digest("hex"),
              },
              decoders,
              null,
            );
            return {
              sessionId: session.id,
              copy: copy.id,
              url: `${base}/title/${session.token}.mp4`,
              duration: probe.duration,
              audio: audioTracks(probe.audio),
              subtitles: subtitleTracks(probe.subtitles),
              progress: copy.progress,
            } satisfies CopySession;
          }),
        ),

      closeCopy: (copyId: string) =>
        Effect.suspend(() =>
          Effect.forEach(
            [...sessions.values()].filter(
              (session) =>
                session.kind === "title" &&
                session.origin.kind === "copy" &&
                session.origin.copy === copyId,
            ),
            (session) => Scope.close(session.scope, Exit.void),
            { discard: true },
          ),
        ),

      fileReplaced: Stream.fromPubSub(replaced),
      readingAhead: Stream.fromPubSub(readingAhead),
      tracksChanged: Stream.fromPubSub(tracksChanged),

      begin: coordination.begin,

      passed: coordination.passed,

      open: (
        channel: OwnedId,
        decoders: readonly Codec[],
        options: {
          readonly variants?: readonly string[];
          readonly repair?: boolean;
          readonly audio?: number | null;
          readonly audioLanguage?: string | null;
          readonly preview?: boolean;
          readonly turn?: number | undefined;
        } = {},
      ) =>
        coordination.inTurn(
          options.turn,
          Effect.gen(function* () {
            // Looked at in the open's own turn, before anything closes: no receiver's open can
            // come between this and the session it would close.
            if (options.preview && [...sessions.values()].some((each) => each.lan !== null)) {
              return yield* new Failed({
                error: { kind: "unexpected", detail: t("A receiver has playback.") },
              });
            }
            yield* coordination.reclaim(channel.subscriptionId);
            const session = yield* liveSession(channel, decoders, options, null);
            const extension = session.format === "mpegts" ? "ts" : "m3u8";
            return {
              sessionId: session.id,
              channel,
              url: `${base}/stream/${session.token}.${extension}`,
              format: session.format,
            };
          }),
        ),

      openTitle: (
        title: TitleRef,
        upstreamUrl: string,
        decoders: readonly Codec[],
        asked: Asked = {},
      ) =>
        coordination.inTurn(
          asked.turn,
          Effect.gen(function* () {
            yield* coordination.reclaim(title.subscriptionId);
            const { session, probe } = yield* titleSession(
              title,
              upstreamUrl,
              decoders,
              null,
              asked,
            );
            return {
              sessionId: session.id,
              title,
              url: `${base}/title/${session.token}.mp4`,
              duration: probe.duration,
              audio: audioTracks(probe.audio),
              subtitles: subtitleTracks(probe.subtitles),
            } satisfies TitleSession;
          }),
        ),

      openReceiver: (
        channel: OwnedId,
        receiver: ReceiverTarget,
        options: {
          readonly variants?: readonly string[];
          readonly audio?: number | null;
          readonly audioLanguage?: string | null;
          readonly turn?: number | undefined;
        } = {},
      ) =>
        coordination.inTurn(
          options.turn,
          Effect.gen(function* () {
            yield* coordination.reclaim(channel.subscriptionId);
            const session = yield* liveSession(channel, receiver.decoders, options, receiver);
            // The provider's stream starts now, so the receiver finds segments when it asks.
            if (session.receiver && !session.hls) void runLive(session, session.receiver);
            return {
              sessionId: session.id,
              channel,
              url: `${session.lan?.origin}/r/${session.receiver?.token}/live.m3u8`,
            };
          }),
        ),

      openReceiverTitle: (
        title: TitleRef,
        upstreamUrl: string,
        receiver: ReceiverTarget,
        asked: Asked = {},
      ) =>
        coordination.inTurn(
          asked.turn,
          Effect.gen(function* () {
            yield* coordination.reclaim(title.subscriptionId);
            const { session, probe, standing } = yield* titleSession(
              title,
              upstreamUrl,
              receiver.decoders,
              receiver,
              asked,
            );
            const planned = deps.ffmpeg
              ? yield* Effect.promise(() => planSegments(session, probe).catch(() => null))
              : null;
            // Where its picture has keyframes was read from the provider too.
            yield* standing;
            const end = endOf(probe);
            if (!planned || end === null) {
              yield* Scope.close(session.scope, Exit.void);
              return yield* new Failed({
                error: {
                  kind: "stream",
                  failure: {
                    kind: "unsupported",
                    detail: deps.ffmpeg
                      ? t(
                          "The file has no picture, or doesn't say how long it is, so a receiver can't play it.",
                        )
                      : t("This build has no ffmpeg to make a receiver's stream."),
                  },
                },
              });
            }
            session.receiver = { ...planned, load: null };
            return {
              sessionId: session.id,
              title,
              duration: end - probe.origin,
              audio: audioTracks(probe.audio),
              subtitles: subtitleTracks(probe.subtitles),
              offset: planned.plan.starts[0]! - probe.origin,
            };
          }),
        ),

      loadReceiverTitle: (
        sessionId: string,
        tracks: { readonly audio: number | null; readonly subtitle: number | null },
      ) =>
        Effect.sync(() => {
          const session = sessions.get(sessionId);
          if (session?.kind !== "title" || !session.receiver || !session.lan) return null;
          const before = session.receiver.load;
          before?.closed.abort();
          // Only text reaches a receiver: the others are drawn by the UI's player.
          const subtitle =
            session.probe?.subtitles.find(
              (track) => track.id === tracks.subtitle && track.format === "text",
            )?.id ?? null;
          const closed = new AbortController();
          const load: TitleLoad = {
            token: randomBytes(18).toString("base64url"),
            audio: tracks.audio,
            subtitle,
            store: segmentStore({ ...SEGMENT_LIMITS, ...deps.receiver?.segments }),
            closed,
            run: null,
            idle: undefined,
            changed: new Set(),
          };
          const end = () => closed.abort();
          session.closed.signal.addEventListener("abort", end, { once: true });
          closed.signal.addEventListener(
            "abort",
            () => {
              session.closed.signal.removeEventListener("abort", end);
              clearTimeout(load.idle);
              load.store.fail();
              tell(load.changed);
            },
            { once: true },
          );
          session.receiver.load = load;
          return {
            url: `${session.lan.origin}/r/${load.token}/master.m3u8`,
            subtitles: subtitle !== null,
          };
        }),

      receiverRequests: (sessionId: string) =>
        Effect.sync(() => sessions.get(sessionId)?.lan?.requests ?? null),

      close: (sessionId: string) =>
        Effect.suspend(() => {
          const session = sessions.get(sessionId);
          return session ? Scope.close(session.scope, Exit.void) : Effect.void;
        }),

      closeAll,

      closeOf: (subscriptionId: string) =>
        coordination.exclusive(
          Effect.suspend(() =>
            Effect.forEach(
              [...sessions.values()].filter(
                (session) => subscriptionOf(session) === subscriptionId,
              ),
              (session) => Scope.close(session.scope, Exit.void),
              { discard: true },
            ),
          ),
        ),

      measurement: (sessionId: string) =>
        Effect.sync(() => {
          const session = sessions.get(sessionId);
          return session && session.lan === null
            ? {
                kind: session.kind === "live" ? ("live" as const) : ("vod" as const),
                closed: session.closed.signal,
              }
            : null;
        }),
      failure: (sessionId: string) => Effect.sync(() => sessions.get(sessionId)?.failure ?? null),

      tracks: (sessionId: string) =>
        Effect.sync(() => {
          const session = sessions.get(sessionId);
          return session?.kind === "live" && session.layout
            ? channelTracks(session.layout, session.captions, session.playing)
            : null;
        }),

      playing: (sessionId: string) =>
        Effect.sync(() => {
          const session = sessions.get(sessionId);
          return session?.kind === "live" ? session.delivered : null;
        }),
    };
  });
}

/** What the player is told of how a subtitle track comes: the decoder for packets, none for text. */
function codecOf(output: SubtitleOutput): string {
  return output.kind === "packets" ? output.codec : "";
}

/**
 * Whether a run from `start` reads everything subtitle track `id` has on screen there itself:
 * from the start of the file it reads every subtitle, and in an MP4's text track ffmpeg starts at
 * the track's own line before the position.
 */
function readsItsOwn(probe: TitleProbe, id: number | null, start: number): boolean {
  const track = probe.subtitles.find((each) => each.id === id);
  return start === 0 || (probe.container === "mp4" && track?.format === "text");
}

/**
 * The file's clock at the end of the title, or null when the file doesn't say how long it is. A
 * Matroska file counts its length from the start of its clock, wherever its first picture sits;
 * the others count theirs from their start time.
 */
function endOf(probe: TitleProbe): number | null {
  if (probe.duration === null) return null;
  const end = probe.container === "matroska" ? probe.duration : probe.origin + probe.duration;
  return end > probe.origin ? end : null;
}

/** How many bytes an entry holds. */
function sizeOf(entry: SubtitleEntry): number {
  return "data" in entry ? entry.data.length : entry.text.length;
}

/** How far a subtitle packet of `probe`'s file may sit from the picture of its time, in seconds. */
function interleave(probe: TitleProbe): number {
  return probe.container === "other" ? INTERLEAVE_S.broadcast : INTERLEAVE_S.ordered;
}

/**
 * Resolves once a request that was cut short has left this machine. Its connection closes at the
 * end of the turn it was cut in; a request made in that same turn on a connection kept from
 * before would reach the provider first, and meet the one before still open.
 */
function gone(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Resolves once what an ffmpeg that has ended `sent` over loopback is here, or has had its time. */
function arrives(sent: Promise<unknown>): Promise<unknown> {
  const { promise: late, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, REPORT_WAIT_MS);
  return Promise.race([sent, late]).finally(() => clearTimeout(timer));
}

/** Resolves once a response takes more, or its reader has left. */
function drained(response: ServerResponse): Promise<void> {
  return new Promise((resume) => {
    const resumed = () => {
      response.off("drain", resumed);
      response.off("close", resumed);
      resume();
    };
    response.on("drain", resumed);
    response.on("close", resumed);
  });
}

/**
 * Reads the subtitles one ffmpeg sends, as `output` says they come, and hands each to `entry` in
 * the order ffmpeg read them, with their times on the file's clock.
 */
function subtitleSink(output: SubtitleOutput, entry: (entry: SubtitleEntry) => void) {
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

function optionalNumber(value: string | null): number | null {
  if (value === null || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

/** ffmpeg's last error line, or how it ended when it said nothing. */
function lastLine(
  errors: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  start: number | null = null,
): string {
  const line = errors.trim().split("\n").at(-1);
  if (line) return line;
  return `ffmpeg ended with ${signal ?? code ?? "no exit"}${start === null ? ", before the picture started" : ""}.`;
}

/**
 * Text that arrives in pieces from one side and is read, from its start, by another that may
 * come later: ffmpeg's reports and cues, read by the proxy and the player.
 */
interface TextRelay {
  write(text: string): void;
  end(): void;
  /** Everything written so far. */
  text(): string;
  /** Resolves once the writer is done. */
  readonly ended: Promise<void>;
  /** Hears what was written so far, then each later piece, then the end. Returns an unsubscribe. */
  subscribe(onText: (text: string) => void, onEnd: () => void): () => void;
}

function textRelay(): TextRelay {
  let buffer = "";
  let done = false;
  const listeners = new Set<{ onText: (text: string) => void; onEnd: () => void }>();
  const { promise: ended, resolve } = Promise.withResolvers<void>();
  return {
    write(text) {
      if (done) return;
      buffer += text;
      for (const listener of listeners) listener.onText(text);
    },
    end() {
      if (done) return;
      done = true;
      resolve();
      for (const listener of listeners) listener.onEnd();
      listeners.clear();
    },
    text: () => buffer,
    ended,
    subscribe(onText, onEnd) {
      if (buffer) onText(buffer);
      if (done) {
        onEnd();
        return () => {};
      }
      const listener = { onText, onEnd };
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** What `promise` resolves with, or null once `signal` aborts, whichever comes first. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const aborted = () => resolve(null);
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then((value) => {
      signal.removeEventListener("abort", aborted);
      resolve(value);
    });
  });
}

/** Tells everyone waiting on `changed` to look again. */
function tell(changed: ReadonlySet<() => void>): void {
  for (const look of [...changed]) look();
}

/** Resolves once `ready()` holds, looked at whenever `changed` is told, or once `signal` aborts. */
function until(changed: Set<() => void>, ready: () => boolean, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const look = () => {
      if (!signal.aborted && !ready()) return;
      changed.delete(look);
      signal.removeEventListener("abort", look);
      resolve();
    };
    changed.add(look);
    signal.addEventListener("abort", look, { once: true });
    look();
  });
}

/**
 * Starts the proxy on a free port: loopback's, or `host`'s for a receiver on the local network. A
 * request may take as long as it likes to arrive: ffmpeg's reports are requests that last as long
 * as its run, and Node would end one after five minutes.
 */
function listen(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
  host = "127.0.0.1",
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const http = createServer({ requestTimeout: 0 }, handle);
    // A request that asks before it sends, "Expect: 100-continue", is told to by its handler.
    http.on("checkContinue", handle);
    http.once("error", reject);
    http.listen(0, host, () => {
      const address = http.address();
      if (address && typeof address === "object") resolve({ server: http, port: address.port });
      else reject(new Error("Stream proxy has no TCP address."));
    });
  });
}

type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

interface StreamStart {
  /** The tracks, or null when the data is not MPEG-TS. */
  readonly layout: StreamLayout | null;
  /** What was read while inspecting; the player still needs it. */
  readonly head: readonly Uint8Array[];
  /** A read still in flight when time ran out. */
  readonly pending: Promise<ReadResult> | null;
}

/**
 * Reads until the stream's codecs settle how to deliver it, or the inspection limit is reached.
 * A track can stay undetermined when every codec it may turn out to be gets the same treatment.
 */
async function inspectStart(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoders: ReadonlySet<Codec>,
): Promise<StreamStart> {
  const inspector = createInspector();
  const head: Uint8Array[] = [];
  let size = 0;
  let latest: Inspection | null = null;
  let pending: Promise<ReadResult> | null = null;
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
    if (latest && settled) return { layout: latest.layout, head, pending: null };
    if (inspector.notTransportStream) return { layout: null, head, pending: null };
  }
  return { layout: latest?.layout ?? null, head, pending };
}

/** The inspected start of the stream followed by the rest of it. */
async function* replay(
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
function cleanStart(
  chunks: AsyncGenerator<Uint8Array>,
  filter: ReturnType<typeof createCleanStart>,
): AsyncGenerator<Uint8Array> {
  return filtered(chunks, filter);
}

/** The stream through a filter that takes chunks and returns whole packets. */
async function* filtered(
  chunks: AsyncGenerator<Uint8Array>,
  filter: { push(chunk: Uint8Array): Uint8Array },
): AsyncGenerator<Uint8Array> {
  for await (const chunk of chunks) {
    const out = filter.push(chunk);
    if (out.length > 0) yield out;
  }
}

/** The tracks a channel's program table names, and its captions, as the UI lists them. */
function channelTracks(
  layout: StreamLayout,
  captions: readonly number[],
  playing: number | null,
): ChannelTracks {
  return {
    playing,
    audio: audioTracks(
      layout.audio.map((track, index) => ({
        id: track.pid,
        language: track.language,
        name: null,
        default: index === 0,
        channels: null,
        description: track.description,
      })),
    ),
    subtitles: subtitleTracks([
      ...layout.subtitles.map((track) => ({
        id: track.pid,
        page: track.page,
        format: track.format,
        language: track.language,
        name: null,
        default: false,
        forced: false,
        hearingImpaired: track.hearingImpaired,
      })),
      ...captions.map((channel) => ({
        id: CAPTION_PID,
        page: channel,
        format: "captions" as const,
        language: null,
        name: null,
        default: false,
        forced: false,
        hearingImpaired: false,
      })),
    ]),
  };
}

/** "HEVC 10-bit video and MP2 sound", for a stream this build cannot convert. */
function describeLayout(layout: StreamLayout | null): string {
  const video = layout?.video?.codec;
  const audio = layout?.audio[0]?.codec;
  if (video && audio)
    return t("This stream carries {video} video and {audio} sound.", { video, audio });
  if (video) return t("This stream carries {video} video.", { video });
  if (audio) return t("This stream carries {audio} sound.", { audio });
  return t("This stream carries an unknown format.");
}

/** What a provider's HTTP status says of why a file or stream didn't come. */
export function classify(status: number): StreamFailure {
  if (status === 401 || status === 403 || status === 429 || status === 458 || status === 509) {
    return { kind: "refused", status };
  }
  if (status === 404 || status === 410) return { kind: "unavailable", status };
  return { kind: "provider-error", status };
}

/** An HLS response, read until its first bytes say whether it is a playlist. */
interface Started {
  readonly answer: Response;
  /** Where its relative addresses start from: where it came from after redirects. */
  readonly url: string;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  /** What was read so far. */
  readonly parts: readonly Uint8Array[];
  readonly playlist: boolean;
}

/** The start of `answer`, requested at `address`, or null without a body. */
async function readStart(answer: Response, address: string): Promise<Started | null> {
  if (!answer.body) return null;
  const reader = answer.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  // The first bytes can arrive a few at a time.
  for (let next = await reader.read(); !next.done;) {
    parts.push(next.value);
    size += next.value.byteLength;
    if (size >= PLAYLIST_START) break;
    next = await reader.read();
  }
  return {
    answer,
    url: answer.url || address,
    reader,
    parts,
    playlist: startsPlaylist(Buffer.concat(parts)),
  };
}
