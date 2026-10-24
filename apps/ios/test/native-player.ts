import type {
  ObservedDetachResult,
  ObservedFailure,
  ObservedItemIdentity,
  ObservedOpenResult,
  ObservedTrackSelection,
  ObservedTrackSnapshot,
  PlaybackObservation,
  VideoSourceObject,
} from "expo-video";
import { vi } from "vitest";

type Body<T> = T extends PlaybackObservation
  ? Omit<T, "version" | "sequence" | "attemptId" | "itemId">
  : never;
type Observation = Body<PlaybackObservation>;

/** Native port stand-in, not an AVFoundation model. Tests control delivery and acknowledgements. */
export function nativePlayer(
  source: (source: VideoSourceObject & { uri: string }) => void | Promise<void> = () => {},
) {
  const listeners = new Map<string, (payload: never) => void>();
  let sequence = 0;
  let identity: ObservedItemIdentity = { attemptId: 0, itemId: 0 };
  const emit = (event: string, payload: unknown) => listeners.get(event)?.(payload as never);
  const port = {
    mrStreamerPlaybackContract: 1,
    muted: true,
    timeUpdateEventInterval: 0,
    staysActiveInBackground: false,
    currentTime: 0,
    duration: 600,
    identity: () => identity,
    listeners,
    emit,
    observation: (
      event: Observation,
      stamp: Partial<ObservedItemIdentity & { sequence: number }> = {},
    ) => {
      emit("playbackObservation", {
        version: 1,
        sequence: ++sequence,
        ...identity,
        ...event,
        ...stamp,
      });
    },
    ready: () => port.observation({ kind: "ready", durationSeconds: port.duration }),
    state: (playing: boolean) =>
      port.observation({
        kind: "state",
        timeControl: playing ? "playing" : "paused",
        mediaTimeSeconds: port.currentTime,
        bufferEmpty: false,
        likelyToKeepUp: true,
      }),
    failure: (failure: ObservedFailure = { kind: "unknown", evidence: null }) =>
      port.observation({ kind: "failure", terminal: true, failure }),
    replaceObservedAsync: vi.fn(
      async (
        input: VideoSourceObject & { uri: string },
        attemptId: number,
      ): Promise<ObservedOpenResult> => {
        identity = { attemptId, itemId: identity.itemId + 1 };
        await source(input);
        port.observation({ kind: "attached" });
        return { kind: "attached", ...identity };
      },
    ),
    detachObservedAsync: vi.fn(async (attemptId: number): Promise<ObservedDetachResult> => ({
      kind: "detached",
      attemptId,
      itemId: identity.attemptId === attemptId ? identity.itemId : null,
      localItemExcluded: true,
      appWorkDrained: true,
      providerDisconnect: "unobservable",
    })),
    tracks: null as ObservedTrackSnapshot | null,
    getObservedTracksAsync: vi.fn(
      async (expected: ObservedItemIdentity): Promise<ObservedTrackSnapshot | { kind: "stale" }> =>
        port.tracks ?? {
          ...expected,
          revision: 1,
          audio: { state: "ready", options: [] },
          subtitles: { state: "ready", options: [] },
          subtitleOffAllowed: true,
          selectedAudioId: null,
          selectedSubtitleId: null,
        },
    ),
    selectObservedTrackAsync: vi.fn(
      async (
        _expected: ObservedItemIdentity,
        _revision: number,
        _choice: ObservedTrackSelection,
      ): Promise<{ kind: "requested" | "stale" | "unavailable" }> => ({ kind: "requested" }),
    ),
    addListener: (event: string, listener: (payload: never) => void) => {
      listeners.set(event, listener);
      return { remove: () => listeners.delete(event) };
    },
    // Any retained legacy admission path is a public behavior failure.
    replaceAsync: vi.fn(async (_source: VideoSourceObject | null): Promise<void> => {
      throw new Error("Legacy replacement used.");
    }),
    play: vi.fn(),
    pause: vi.fn(),
    seekBy: vi.fn(),
  };
  return port;
}
