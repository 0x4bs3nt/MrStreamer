import type { RemotePlaybackObservers, RemotePlaybackObserver } from "../analytics/observers.ts";
import { streamFailure, appFailure } from "../analytics/operations.ts";
// Where playback goes: this computer, or a receiver on the local network, a TV the viewer sends
// it to with Google Cast or AirPlay.
//
// The playback service stays the one owner of every stream. This service decides who plays it:
// it holds the receiver the viewer chose, opens sessions for it there, has the receiver's adapter
// load them (see ../receivers/adapter.ts), and keeps what the receiver last confirmed. The UI's
// controls act on that and show it; the receiver's own clock is the title's clock while it plays.
//
// Looking for receivers and connecting to one change nothing that plays. Only playing something
// on a connected receiver closes what was open here, through the playback service, so the
// provider sees one connection throughout. Going back closes the receiver's session first.
//
// One receiver at a time. Connecting to one the app lists lets go of the one before, with what it
// played. The system's own list decides nothing until the viewer picks in it: a receiver that
// plays goes on while the list is open, and stays when it closes with nothing else picked. A list
// counts from when it is asked for, also while it still waits for the place it opens at: going
// back to this computer, another receiver, another account or another list ends it there, and
// none opens. Whoever asks for a list may name it, and take that one down again by its name.
//
// Every load has a generation, counted here. A command names its generation and is dropped once
// another load took its place. What a receiver says of an earlier load is dropped too, so a late
// answer can't move the clock of what plays now, or end an episode that is no longer the one
// playing. What plays names the subscription it is from, and so does the progress saved of it:
// the viewing record keeps it for that subscription, or not at all once that one went.
//
// How far a title got on a receiver is saved here, from what the receiver confirmed: each minute
// while it plays, and when it pauses, is skipped in, ends, stops or is lost. The UI saves that for
// what plays on this computer; a receiver plays on with the window closed, when there is no UI.
//
// A receiver plays from an address of this computer, so the app has to stay open: quitting ends
// what the receiver plays.
import type {
  Output as OutputState,
  OutputFailure,
  OutputStatus,
  Receiver,
  RemoteCommand,
  RemoteItem,
  RemoteMedia,
  RemotePlayingTitle,
  RemoteTitle,
} from "@mrstreamer/contracts/output";
import type { AnalyticsFailure } from "@mrstreamer/contracts/analytics";
import { randomUUID } from "node:crypto";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import type { StreamFailure } from "@mrstreamer/contracts/playback";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { Failed } from "@mrstreamer/core/failure";
import { ViewingRecord } from "@mrstreamer/core/viewing/service";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { lanAddresses } from "../playback/lan.ts";
import {
  ReceiverFailed,
  type AdapterEvent,
  type Connection,
  type ReceiverAdapter,
  type ReceiverMedia,
  type ScreenRect,
  type TransportStatus,
} from "../receivers/adapter.ts";
import { PlaybackCoordination } from "./playback-coordination.ts";
import { Playback, type Asked, type ReceiverTarget } from "./playback.ts";

/**
 * How long a receiver gets to ask this computer for what it was sent. One that never does can't
 * reach here: a firewall, or it is on another network.
 */
const FETCH_MS = 10_000;
/** Whose pictures a receiver is given to show: TMDB's, which anyone may fetch. */
const ARTWORK_HOST = "image.tmdb.org";
/** How often a title's progress is saved while a receiver plays it. */
const CHECKPOINT_MS = 60_000;
/**
 * Why a wait at the system's list ends when the list only opened again. Unlike going back to
 * this computer, that takes nothing back: a receiver picked in the list before still counts.
 */
const REOPENED = "reopened";
/**
 * Why it ends when the list was taken down from here, with the window it opened from or the
 * account it was asked under. That is as if the viewer closed it without picking.
 */
const CLOSED = "closed";

export interface OutputDeps {
  readonly observePlayback?: RemotePlaybackObservers;
  /** The ways this build reaches receivers: Google Cast, AirPlay, both or none. */
  readonly adapters: readonly ReceiverAdapter[];
  /** This computer's addresses on the local network, likeliest first, when not the system's. */
  readonly addresses?: () => readonly string[];
  /** How long a receiver gets to ask for what it was sent, in ms, when not the usual. */
  readonly fetchMs?: number;
  /** How often a playing title's progress is saved, in ms, when not the usual. */
  readonly checkpointMs?: number;
}

/**
 * Where the system's list opens, once that is known: a place on screen, or null when there is
 * none left. `signal` ends the wait for it.
 */
export type ListPlace = (signal: AbortSignal) => Promise<ScreenRect | null>;

/** What the receiver may show about what it plays. */
export interface Shown {
  readonly name: string;
  readonly detail?: string | null | undefined;
  readonly artworkUrl?: string | null | undefined;
}

/** What plays on the receiver, with what this service needs to follow it. */
interface Playing {
  readonly measurement: RemotePlaybackObserver | undefined;
  readonly generation: number;
  readonly sessionId: string;
  readonly item: RemoteItem;
  /** Seconds to add to a position the receiver names to get seconds into the title. */
  readonly offset: number;
  /** Ends the wait for the receiver's first request. */
  readonly watch: AbortController;
  /** A title: what its file holds, the tracks chosen, and when the viewer began this play. */
  readonly title: OpenedTitle | null;
  readonly tracks: { readonly audio: number | null; readonly subtitle: number | null };
  media: RemoteMedia;
}

/** A title opened for the receiver. */
interface OpenedTitle {
  readonly measurement: string | null;
  /** The public open turn that prepared this session, when one was supplied. */
  readonly turn: number | undefined;
  readonly info: RemoteTitle;
  /** Seconds between the start of the title and where a receiver's clock starts. */
  readonly offset: number;
  /**
   * When the viewer began this play of it, epoch ms: what its progress is saved with. A play
   * that came from this computer, or from another receiver, keeps the time it began there.
   */
  readonly since: number;
}

export class Output extends Context.Service<
  Output,
  {
    readonly status: Effect.Effect<OutputStatus>;
    readonly changes: Stream.Stream<OutputStatus>;
    /** Looks for receivers while `on`. Plays and changes nothing. */
    scan(on: boolean): Effect.Effect<void>;
    /** Connects to a receiver the status lists. What plays here goes on. */
    connect(receiverId: string): Effect.Effect<OutputStatus, Failed>;
    /**
     * Opens the system's own list of receivers at the place on screen `place` gives, and connects
     * to the one the viewer picks. Nothing changes when they pick none, or the one that plays
     * already: it plays on while the list is open, from the same address, and takes commands.
     *
     * `place` may take its time, as for a window that is still moving, and gives null once there
     * is nowhere left to open at. No list opens then, nor when the viewer went back to this
     * computer, chose another receiver, changed account or asked for another list meanwhile:
     * `place` hears of that through its signal, and the status comes back as it is.
     *
     * `request` is the asker's own name for this list, for `closePicker`.
     */
    pick(place: ListPlace, request?: string): Effect.Effect<OutputStatus, Failed>;
    /**
     * Takes the system's list down while the viewer is at it or it still waits for its place, as
     * when the window it opens from moves or goes out of sight. Nothing else changes: a receiver
     * that plays goes on, and one the viewer picked in the list just before still counts.
     *
     * With `request`, only the list asked for by that name goes, as when the view it was asked
     * from closes. One asked for since stays, whenever this arrives.
     */
    closePicker(request?: string): Effect.Effect<void>;
    /** Back to this computer: ends what the receiver plays, closes its session, lets go of it. */
    readonly disconnect: Effect.Effect<void>;
    /**
     * Plays a channel on the connected receiver, in place of what it had and of what was open
     * here. `variants` are the channel's streams to try, as for `Playback.open`.
     */
    playChannel(
      channel: OwnedId,
      options: {
        readonly measurement?: string | undefined;
        readonly variants: readonly string[];
        readonly audio?: number | null;
        readonly audioLanguage?: string | null;
        readonly shown: Shown;
        /** The turn it was asked under (`PlaybackCoordination.begin`): it plays nothing once another began. */
        readonly turn?: number | undefined;
      },
    ): Effect.Effect<RemoteMedia, Failed>;
    /**
     * Opens a movie or episode for the connected receiver from its provider file, in place of
     * what was open here, and says what it holds. Nothing plays until `playTitle`. `since` is
     * when the viewer began this play, epoch ms, which what the receiver gets to is saved with:
     * the record counts a play that moved here as the play it was, so an episode marked by hand
     * meanwhile keeps its mark. Asked under `asked`, as `Playback.openTitle` is: what gave way
     * meanwhile leaves the receiver as it is.
     */
    openTitle(
      title: TitleRef,
      upstreamUrl: string,
      since: number,
      asked?: Asked & { readonly measurement?: string | undefined },
    ): Effect.Effect<RemoteTitle, Failed>;
    /** Plays an opened title on the receiver from `position` seconds with these tracks. */
    playTitle(
      sessionId: string,
      options: {
        readonly position: number;
        readonly audio: number | null;
        readonly subtitle: number | null;
        readonly paused?: boolean | undefined;
        readonly shown: Shown;
        readonly measurement?: string | undefined;
        /** A failed request before this load has a physical observer; fixed category only. */
        readonly onPreloadFailure?: ((failure: AnalyticsFailure) => void) | undefined;
      },
    ): Effect.Effect<RemoteMedia, Failed>;
    /** Tells the receiver. Does nothing when `generation` is no longer what it plays. */
    command(generation: number, command: RemoteCommand): Effect.Effect<void, Failed>;
    setVolume(volume: {
      readonly level?: number | undefined;
      readonly muted?: boolean | undefined;
    }): Effect.Effect<void, Failed>;
    /** Whether a receiver has playback, or had it until it was lost: nothing previews here then. */
    readonly remote: Effect.Effect<boolean>;
    /**
     * The title the receiver plays, with what its file holds and the tracks chosen: what a
     * window opened meanwhile needs to show its controls. Null for a channel, or nothing.
     */
    readonly playingTitle: Effect.Effect<RemotePlayingTitle | null>;
    /**
     * A subscription is about to go: when the receiver plays something of it, saves how far its
     * title got, then ends it. What it plays of another subscription goes on.
     */
    subscriptionGone(subscriptionId: string): Effect.Effect<void>;
  }
>()("mrstreamer/Output") {
  static readonly layer = (deps: OutputDeps) => Layer.effect(Output, make(deps));
}

function make(deps: OutputDeps) {
  return Effect.gen(function* () {
    const playback = yield* Playback;
    const coordination = yield* PlaybackCoordination;
    const viewing = yield* ViewingRecord;
    const updates = yield* PubSub.unbounded<OutputStatus>();
    /** Changes to what is connected and what plays run one at a time. */
    const one = (yield* Semaphore.make(1)).withPermits(1);
    const adapters = deps.adapters;
    const addresses = deps.addresses ?? lanAddresses;

    let scanning = false;
    /** The receivers each adapter found, by its kind. */
    const found = new Map<string, readonly Receiver[]>();
    /** Whether the system sees a receiver it lists itself; null without such an adapter. */
    let routes: boolean | null = adapters.some((each) => each.kind === "airplay") ? false : null;
    let output: OutputState = { kind: "local" };
    let connected: { readonly connection: Connection; readonly adapter: ReceiverAdapter } | null =
      null;
    /** A connect under way, which going back to this computer ends. */
    let connecting: AbortController | null = null;
    /**
     * The system's list, from when it is asked for until the wait at it ends: what gives it up,
     * and what its asker calls it. Going back to this computer, another receiver, another account
     * or another list ends it as each is asked, before that takes its turn.
     */
    let listing: { readonly wait: AbortController; readonly request: string | undefined } | null =
      null;
    let playing: Playing | null = null;
    let generation = 0;
    /** New receiver title requests retire an older load's pre-observer failure callback. */
    let titleLoadRequest = 0;
    /** Which of this computer's addresses the next load is served on, counted round. */
    let addressTurn = 0;
    /** Titles opened for the receiver, by session. */
    const opened = new Map<string, OpenedTitle>();

    const snapshot = (): OutputStatus => ({
      offers: adapters.map((each) => each.kind),
      airplayRoutes: routes,
      scanning,
      receivers: [...found.values()].flat(),
      output,
    });
    const publish = () => void PubSub.publishUnsafe(updates, snapshot());

    const failed = (failure: OutputFailure) => new Failed({ error: { kind: "output", failure } });
    const failureOf = (cause: unknown): OutputFailure =>
      cause instanceof ReceiverFailed
        ? cause.failure
        : { kind: "unavailable", detail: cause instanceof Error ? cause.message : String(cause) };
    /** An adapter's call as an Effect that fails with why the receiver didn't take it. */
    const told = <A>(call: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({ try: call, catch: (cause) => failed(failureOf(cause)) });

    /** Fails, before anything of the receiver's changes, once the viewer asked for something else. */
    const inTurn = coordination.whileAsked;

    /** Runs what an adapter's or the playback service's callback sets off, outside any call. */
    const later = (effect: Effect.Effect<void>) => void Effect.runFork(effect);

    /** Where the title is now, in seconds into it: the receiver's last word, moved on while it plays. */
    const positionOf = (now: Playing): number => {
      const { media } = now;
      const moved = media.state === "playing" ? (Date.now() - media.at) / 1000 : 0;
      return Math.min(media.position + Math.max(0, moved), now.title?.info.duration ?? Infinity);
    };

    /**
     * Saves how far the receiver got with the title it plays, for the subscription the title
     * names. The record refuses it once that subscription went, so it never lands under another
     * that connected since. A channel has no progress.
     */
    const checkpoint = (now: Playing | null) =>
      Effect.gen(function* () {
        const title = now?.title;
        // Nothing confirmed yet says nothing of how far it got.
        if (!now || !title || now.media.state === "loading") return;
        const position = positionOf(now);
        if (position <= 0) return;
        yield* viewing
          .recordProgress(
            randomUUID(),
            title.info.title,
            position,
            title.info.duration,
            title.since,
          )
          .pipe(Effect.ignore);
      });

    /**
     * Ends what plays on the receiver, for this service: how far its title got is saved, its
     * session closes, its waits end.
     */
    const drop = (close: boolean) =>
      Effect.gen(function* () {
        const was = playing;
        playing = null;
        was?.measurement?.stop();
        was?.watch.abort();
        yield* checkpoint(was);
        if (was && close) yield* playback.close(was.sessionId);
      });

    /** What plays now doesn't any more, and why, with the receiver still there. */
    const mediaFailed = (failure: OutputFailure, stop: boolean) =>
      Effect.gen(function* () {
        const was = playing;
        was?.measurement?.failure(appFailure({ kind: "output", failure }));
        yield* drop(true);
        if (stop && was && connected) {
          yield* Effect.promise(() => connected!.connection.stop(was.generation).catch(() => {}));
        }
        if (output.kind === "receiver") output = { ...output, media: null, failure };
        publish();
      });

    /** The receiver's own news of what it plays. */
    function hear(adapter: ReceiverAdapter, event: AdapterEvent): void {
      switch (event.type) {
        case "receivers":
          found.set(adapter.kind, event.receivers);
          return publish();
        case "routes":
          routes = event.available;
          return publish();
        case "volume":
          if (connected?.adapter !== adapter || output.kind !== "receiver") return;
          if (!connected.connection.volume) return;
          output = { ...output, volume: { level: event.level, muted: event.muted } };
          return publish();
        case "status":
          if (connected?.adapter === adapter) status(event.status);
          return;
        case "media-failed":
          if (connected?.adapter !== adapter || playing?.generation !== event.generation) return;
          return later(mediaFailed(event.failure, false));
        case "released": {
          const was = connected;
          if (was?.adapter !== adapter) return;
          // Let go of from the receiver's side: back to this computer, nothing failed.
          return later(
            one(
              Effect.gen(function* () {
                // Another receiver took its place before this got its turn: the news is old.
                if (connected !== was) return;
                yield* drop(true);
                connected = null;
                output = { kind: "local" };
                publish();
              }),
            ),
          );
        }
        case "lost": {
          const was = connected;
          if (was?.adapter !== adapter || output.kind !== "receiver") return;
          const { receiver } = output;
          playing?.measurement?.failure(appFailure({ kind: "output", failure: event.failure }));
          return later(
            one(
              Effect.gen(function* () {
                if (connected !== was) return;
                yield* drop(true);
                connected = null;
                output = { kind: "lost", receiver, failure: event.failure };
                publish();
              }),
            ),
          );
        }
      }
    }

    /** What the receiver says of a load. Only the one that plays now counts. */
    function status(said: TransportStatus): void {
      const now = playing;
      if (!now || said.generation !== now.generation || output.kind !== "receiver") return;
      if (said.state === "stopped" || (said.state === "ended" && now.item.kind === "channel")) {
        // It holds the load no more. A channel has no end: its stream stopped, and the session
        // knows why. Stopped from the receiver's side otherwise, which is nobody's failure.
        return later(
          Effect.gen(function* () {
            const stream =
              now.item.kind === "channel" ? yield* playback.failure(now.sessionId) : null;
            if (playing !== now) return;
            if (stream) now.measurement?.failure(streamFailure(stream));
            yield* drop(true);
            if (output.kind !== "receiver") return;
            output = {
              ...output,
              media: null,
              failure: stream ? { kind: "stream", failure: stream } : null,
            };
            publish();
          }),
        );
      }
      now.measurement?.state(
        said.state === "playing"
          ? "playing"
          : said.state === "paused"
            ? "paused"
            : said.state === "ended"
              ? "stopped"
              : "waiting",
      );
      const before = now.media.state;
      now.media = {
        ...now.media,
        state: said.state,
        position: now.item.kind === "title" ? Math.max(0, said.position + now.offset) : 0,
        at: said.at,
      };
      output = { ...output, media: now.media };
      publish();
      // Paused, or played to its end: how far it got is saved then, as for the UI's player.
      if (said.state !== before && (said.state === "paused" || said.state === "ended")) {
        later(checkpoint(now));
      }
    }

    for (const adapter of adapters) adapter.listen((event) => hear(adapter, event));
    // Quitting ends what the receiver plays and lets go of it, each adapter within its own bound.
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.allSettled(adapters.map((each) => each.close()))),
    );

    /** A session's part of what the playback service is told of its receiver. */
    const target = (connection: Connection): Effect.Effect<ReceiverTarget, Failed> =>
      Effect.suspend(() => {
        const candidates = connection.localAddress ? [connection.localAddress] : addresses();
        const address = candidates[addressTurn % Math.max(1, candidates.length)];
        if (!address) return Effect.fail(failed({ kind: "no-network" }));
        return Effect.succeed({
          address,
          decoders: connection.decoders,
          // Closed by something else than this service: another stream opened here, or the
          // window closed. The receiver is told to stop what it can no longer get; nothing failed.
          closed: () => {
            const now = playing;
            if (!now) return;
            later(
              Effect.gen(function* () {
                if (playing !== now) return;
                yield* drop(false);
                if (connected) {
                  const { connection } = connected;
                  yield* Effect.promise(() => connection.stop(now.generation).catch(() => {}));
                }
                if (output.kind === "receiver") output = { ...output, media: null, failure: null };
                publish();
              }),
            );
          },
          failed: (failure: StreamFailure) => {
            const now = playing;
            if (!now) return;
            later(
              Effect.suspend(() =>
                playing === now ? mediaFailed({ kind: "stream", failure }, true) : Effect.void,
              ),
            );
          },
        } satisfies ReceiverTarget);
      });

    /**
     * Has the receiver play a session that is open for it, and waits no longer than it takes the
     * load. From then on the receiver has `fetchMs` to ask this computer for it.
     */
    const load = (
      connection: Connection,
      sessionId: string,
      item: RemoteItem,
      title: OpenedTitle | null,
      tracks: Playing["tracks"],
      media: Omit<ReceiverMedia, "generation" | "metadata">,
      shown: Shown,
      measurement: string | null,
    ) =>
      Effect.gen(function* () {
        const mine = ++generation;
        const watch = new AbortController();
        const offset = title?.offset ?? 0;
        const now: Playing = {
          measurement: deps.observePlayback?.(
            item.kind === "channel" ? "live" : "vod",
            measurement,
          ),
          generation: mine,
          sessionId,
          item,
          offset,
          watch,
          title,
          tracks,
          media: {
            generation: mine,
            sessionId,
            item,
            state: "loading",
            position: title ? media.position + offset : 0,
            at: Date.now(),
            duration: title?.info.duration ?? null,
            subtitles: media.subtitles,
          },
        };
        playing = now;
        if (output.kind === "receiver") output = { ...output, media: now.media, failure: null };
        publish();
        const artwork = URL.parse(shown.artworkUrl ?? "");
        yield* told((signal) =>
          connection.load(
            {
              ...media,
              generation: mine,
              metadata: {
                title: shown.name,
                subtitle: shown.detail ?? null,
                // Only a picture anyone may fetch, never one from the provider's own server.
                artworkUrl:
                  artwork?.protocol === "https:" && artwork.hostname === ARTWORK_HOST
                    ? artwork.href
                    : null,
              },
            },
            AbortSignal.any([signal, watch.signal]),
          ),
        ).pipe(
          Effect.tapError((failure) =>
            playing === now && failure.error.kind === "output"
              ? mediaFailed(failure.error.failure, false)
              : Effect.void,
          ),
        );
        // A receiver that never asks for the stream can't reach this computer.
        const timer = setTimeout(
          () =>
            later(
              Effect.gen(function* () {
                if (playing !== now) return;
                if ((yield* playback.receiverRequests(sessionId)) !== 0) return;
                // The next try is served on this computer's next address, where it has several.
                addressTurn++;
                yield* mediaFailed({ kind: "not-fetched" }, true);
              }),
            ),
          deps.fetchMs ?? FETCH_MS,
        );
        // Only playing moves a title on: a save while paused would make it look watched later.
        const saving = setInterval(() => {
          if (playing === now && now.media.state === "playing") later(checkpoint(now));
        }, deps.checkpointMs ?? CHECKPOINT_MS);
        watch.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            clearInterval(saving);
          },
          { once: true },
        );
        return now.media;
      });

    /** The receiver that takes media now, or the failure that there is none. */
    const receiver = Effect.suspend(() =>
      connected && output.kind === "receiver"
        ? Effect.succeed(connected.connection)
        : Effect.fail(failed({ kind: "unreachable" })),
    );

    /** `connection` is the receiver from now on, with nothing sent to it yet. */
    const take = (connection: Connection, adapter: ReceiverAdapter) => {
      connected = { connection, adapter };
      addressTurn = 0;
      output = {
        kind: "receiver",
        receiver: connection.receiver,
        volume: null,
        media: null,
        failure: null,
      };
      publish();
    };

    /** Connects to `known`, a receiver `adapter` listed, in place of the one before. */
    const connectTo = (adapter: ReceiverAdapter, known: Receiver) =>
      one(
        Effect.gen(function* () {
          // One receiver at a time: the one before goes first, with what it played.
          yield* release;
          const mine = new AbortController();
          connecting = mine;
          output = { kind: "connecting", protocol: adapter.kind, receiver: known };
          publish();
          const connection = yield* told((signal) =>
            adapter.connect(
              { kind: "receiver", id: known.id },
              AbortSignal.any([signal, mine.signal]),
            ),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (connecting === mine) connecting = null;
              }),
            ),
            // Given up by the viewer, with This computer or another receiver: nothing failed.
            Effect.catchIf(
              () => mine.signal.aborted,
              () => Effect.succeed(null),
            ),
            Effect.tapError(() =>
              Effect.sync(() => {
                output = { kind: "local" };
                publish();
              }),
            ),
          );
          if (!connection) {
            output = { kind: "local" };
            publish();
            return snapshot();
          }
          take(connection, adapter);
          return snapshot();
        }),
      );

    /**
     * Opens the system's list through `adapter` at the place `place` gives and connects to what
     * the viewer picks there. The list by itself changes nothing, so the turn isn't held while it
     * waits for its place or is open: a receiver that plays goes on playing and takes what it is
     * told meanwhile. It stays, with what it plays, when the list closes with nothing picked or
     * with the same receiver. Only another receiver takes its place, once that one answered.
     */
    const pickWith = (adapter: ReceiverAdapter, place: ListPlace, request: string | undefined) =>
      Effect.gen(function* () {
        const mine = new AbortController();
        const list = { wait: mine, request };
        // One list at a time, from when it is asked for: the wait at the one before ends, and
        // nothing failed.
        listing?.wait.abort(REOPENED);
        listing = list;
        /** Until the call it is for ends, or this list is given up. */
        const until = (signal: AbortSignal) => AbortSignal.any([signal, mine.signal]);
        const waited = yield* Effect.result(
          Effect.gen(function* () {
            const anchor = yield* told((signal) => place(until(signal)));
            // Nowhere left to open at: no list opens.
            if (!anchor) return null;
            yield* one(
              Effect.sync(() => {
                // Given up before its turn came: no list opens.
                if (mine.signal.aborted) return;
                connecting = mine;
                if (connected) return;
                output = { kind: "connecting", protocol: adapter.kind, receiver: null };
                publish();
              }),
            );
            return yield* told((signal) =>
              adapter.connect({ kind: "picker", anchor }, until(signal)),
            );
          }),
        );
        return yield* one(
          Effect.gen(function* () {
            // Whether this is still the connect under way: none began since.
            const current = connecting === mine;
            if (current) connecting = null;
            if (listing === list) listing = null;
            const picked = waited._tag === "Success" ? waited.success : null;
            // Given up from here meanwhile, which fails nothing. `left` when the viewer went
            // elsewhere: back to this computer, or to a receiver the app lists.
            const given = mine.signal.aborted;
            const reason: unknown = mine.signal.reason;
            const left = given && reason !== REOPENED && reason !== CLOSED;
            if (picked && picked !== connected?.connection) {
              if (left) {
                // Nobody takes what was picked after all.
                yield* Effect.promise(() => picked.disconnect().catch(() => {}));
              } else {
                // Another receiver than the one before, which goes first with what it played.
                if (connected) {
                  output = { kind: "connecting", protocol: adapter.kind, receiver: null };
                  publish();
                  yield* release;
                }
                take(picked, adapter);
              }
            } else if (
              !picked &&
              current &&
              (!given || reason === CLOSED) &&
              output.kind === "connecting"
            ) {
              // The list closed on nothing, by the viewer or from here, and no receiver was
              // there before it opened.
              output = { kind: "local" };
              publish();
            }
            if (waited._tag === "Failure" && !given) return yield* waited.failure;
            return snapshot();
          }),
        );
      });

    /** Ends what the receiver plays and lets go of it, the session first. */
    const release = Effect.gen(function* () {
      titleLoadRequest++;
      connecting?.abort();
      yield* drop(true);
      const was = connected;
      connected = null;
      if (was) yield* Effect.promise(() => was.connection.disconnect().catch(() => {}));
    });

    return {
      status: Effect.sync(snapshot),
      changes: Stream.fromPubSub(updates),

      scan: (on: boolean) =>
        Effect.sync(() => {
          if (scanning === on) return;
          scanning = on;
          for (const adapter of adapters) adapter.scan(on);
          publish();
        }),

      connect: (receiverId: string) =>
        Effect.suspend(() => {
          const adapter = adapters.find((each) =>
            found.get(each.kind)?.some((listed) => listed.id === receiverId),
          );
          const known = [...found.values()].flat().find((each) => each.id === receiverId);
          if (!adapter || !known) return Effect.fail(failed({ kind: "unreachable" }));
          // The system's list gives way as this is asked, also one that still waits for its place.
          listing?.wait.abort();
          return connectTo(adapter, known);
        }),

      pick: (place: ListPlace, request?: string) =>
        Effect.suspend(() => {
          const adapter = adapters.find((each) => each.kind === "airplay");
          if (!adapter) {
            return Effect.fail(
              failed({
                kind: "unavailable",
                detail: "This build has no system list of receivers.",
              }),
            );
          }
          return pickWith(adapter, place, request);
        }),

      closePicker: (request?: string) =>
        Effect.sync(() => {
          // A name is for its own list alone: the one there now may have been asked for since.
          if (request === undefined || request === listing?.request) listing?.wait.abort(CLOSED);
        }),

      // A connect that waits ends first, for its receiver or for the viewer at the system's
      // list: the one for a receiver holds the turn this takes. So does a list that has yet to
      // open, which then never does.
      disconnect: Effect.andThen(
        Effect.sync(() => {
          connecting?.abort();
          listing?.wait.abort();
        }),
        one(
          Effect.gen(function* () {
            if (output.kind !== "local") {
              output = { kind: "local" };
              publish();
            }
            yield* release;
          }),
        ),
      ),

      playChannel: (
        channel: OwnedId,
        options: {
          readonly measurement?: string | undefined;
          readonly variants: readonly string[];
          readonly audio?: number | null;
          readonly audioLanguage?: string | null;
          readonly shown: Shown;
          readonly turn?: number | undefined;
        },
      ) =>
        one(
          Effect.gen(function* () {
            const connection = yield* receiver;
            yield* inTurn(options.turn);
            // What it played closes without telling it to stop: the load takes its place.
            yield* drop(true);
            opened.clear();
            const stream = yield* playback.openReceiver(channel, yield* target(connection), {
              variants: options.variants,
              audio: options.audio ?? null,
              audioLanguage: options.audioLanguage ?? null,
              turn: options.turn,
            });
            return yield* load(
              connection,
              stream.sessionId,
              { kind: "channel", channel },
              null,
              { audio: options.audio ?? null, subtitle: null },
              {
                url: stream.url,
                live: true,
                position: 0,
                paused: false,
                duration: null,
                subtitles: false,
              },
              options.shown,
              options.measurement ?? null,
            );
          }),
        ),

      openTitle: (
        title: TitleRef,
        upstreamUrl: string,
        since: number,
        asked: Asked & { readonly measurement?: string | undefined } = {},
      ) => {
        titleLoadRequest++;
        return one(
          Effect.gen(function* () {
            const connection = yield* receiver;
            yield* inTurn(asked.turn);
            yield* drop(true);
            opened.clear();
            const session = yield* playback.openReceiverTitle(
              title,
              upstreamUrl,
              yield* target(connection),
              asked,
            );
            const info: RemoteTitle = {
              sessionId: session.sessionId,
              title,
              duration: session.duration,
              audio: session.audio,
              subtitles: session.subtitles,
              shows: ["text"],
            };
            opened.set(session.sessionId, {
              info,
              offset: session.offset,
              since,
              measurement: asked.measurement ?? null,
              turn: asked.turn,
            });
            return info;
          }),
        );
      },

      playTitle: (
        sessionId: string,
        options: {
          readonly position: number;
          readonly audio: number | null;
          readonly subtitle: number | null;
          readonly paused?: boolean | undefined;
          readonly shown: Shown;
          readonly measurement?: string | undefined;
          readonly onPreloadFailure?: ((failure: AnalyticsFailure) => void) | undefined;
        },
      ) => {
        const request = ++titleLoadRequest;
        const turn = opened.get(sessionId)?.turn;
        return one(
          Effect.gen(function* () {
            const prepared = yield* Effect.gen(function* () {
              const connection = yield* receiver;
              const title = opened.get(sessionId);
              const loaded = title
                ? yield* playback.loadReceiverTitle(sessionId, {
                    audio: options.audio,
                    subtitle: options.subtitle,
                  })
                : null;
              if (!title || !loaded) {
                return yield* failed({ kind: "stream", failure: STOPPED });
              }
              // The same session with other tracks or from another position: only its load changes.
              yield* drop(false);
              return { connection, title, loaded };
            }).pipe(
              Effect.tapError((failure) =>
                Effect.gen(function* () {
                  if (
                    request !== titleLoadRequest ||
                    (turn !== undefined && (yield* coordination.passed(turn)))
                  )
                    return;
                  options.onPreloadFailure?.(appFailure(failure.error));
                }),
              ),
            );
            return yield* load(
              prepared.connection,
              sessionId,
              { kind: "title", title: prepared.title.info.title },
              prepared.title,
              {
                audio: options.audio,
                subtitle: prepared.loaded.subtitles ? options.subtitle : null,
              },
              {
                url: prepared.loaded.url,
                live: false,
                position: Math.max(0, options.position - prepared.title.offset),
                paused: options.paused === true,
                duration: prepared.title.info.duration,
                subtitles: prepared.loaded.subtitles,
              },
              options.shown,
              options.measurement ?? prepared.title.measurement,
            );
          }),
        );
      },

      command: (mine: number, command: RemoteCommand) =>
        one(
          Effect.gen(function* () {
            const now = playing;
            const connection = connected?.connection;
            if (!now || !connection || now.generation !== mine) return;
            switch (command.command) {
              case "play":
                return yield* told(() => connection.play(mine));
              case "pause":
                return yield* told(() => connection.pause(mine));
              case "seek":
                now.measurement?.state("seeking");
                // Where it was before the skip, as the UI's player saves it.
                yield* checkpoint(now);
                return yield* told(() =>
                  connection.seek(mine, Math.max(0, command.position - now.offset)),
                );
              case "subtitles":
                yield* told(() => connection.showSubtitles(mine, command.on));
                if (playing === now && output.kind === "receiver") {
                  now.media = { ...now.media, subtitles: command.on };
                  output = { ...output, media: now.media };
                  publish();
                }
                return;
              case "stop":
                yield* drop(true);
                opened.clear();
                yield* Effect.promise(() => connection.stop(mine).catch(() => {}));
                if (output.kind === "receiver") output = { ...output, media: null, failure: null };
                publish();
            }
          }),
        ),

      setVolume: (volume: {
        readonly level?: number | undefined;
        readonly muted?: boolean | undefined;
      }) =>
        Effect.suspend(() => {
          const connection = connected?.connection;
          if (!connection?.volume) return Effect.void;
          return told(() =>
            connection.setVolume({
              ...(volume.level !== undefined ? { level: volume.level } : {}),
              ...(volume.muted !== undefined ? { muted: volume.muted } : {}),
            }),
          );
        }),

      remote: Effect.sync(() => output.kind === "receiver" || output.kind === "lost"),

      playingTitle: Effect.sync(() =>
        playing?.title
          ? { title: playing.title.info, since: playing.title.since, ...playing.tracks }
          : null,
      ),

      // The receiver stays, and so does a list of receivers the viewer is at.
      subscriptionGone: (subscriptionId: string) =>
        one(
          Effect.gen(function* () {
            for (const [sessionId, title] of opened) {
              if (title.info.title.subscriptionId === subscriptionId) opened.delete(sessionId);
            }
            const was = playing;
            const { item } = was ?? {};
            const owner = item?.kind === "channel" ? item.channel : item?.title;
            if (!was || owner?.subscriptionId !== subscriptionId) return;
            yield* drop(true);
            if (connected) {
              yield* Effect.promise(() =>
                connected!.connection.stop(was.generation).catch(() => {}),
              );
            }
            if (output.kind === "receiver") output = { ...output, media: null, failure: null };
            publish();
          }),
        ),
    };
  });
}

/** The session a receiver played was closed, or isn't one it can play from. */
const STOPPED: StreamFailure = { kind: "network", detail: "The stream was closed." };
