import { beforeEach, describe, expect, it, vi } from "vitest";

// Titles in files AVPlayer can't open play through a format session: the native module reads the
// file and gives the player a loopback playlist. What the viewer and the provider would see is
// what's checked: what the player is given, when the provider is asked again, and what a failure
// says. The native player and the native module are stand-ins.

const given: Array<{ uri: string; contentType?: string } | null> = [];
const listeners = new Map<string, (payload: never) => void>();
const fakePlayer = {
  muted: true,
  timeUpdateEventInterval: 0,
  currentTime: 0,
  duration: 600,
  addListener: (event: string, listener: (payload: never) => void) => {
    listeners.set(event, listener);
  },
  replaceAsync: vi.fn(async (source: { uri: string; contentType?: string } | null) => {
    given.push(source);
  }),
  play: vi.fn(),
  pause: vi.fn(),
};
const emit = (event: string, payload: unknown) => listeners.get(event)?.(payload as never);
vi.mock("expo-video", () => ({ createVideoPlayer: () => fakePlayer }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

type Opened =
  | { kind: "session"; playlist: string }
  | { kind: "direct" }
  | { kind: "closed" }
  | { kind: "failed"; failure: { kind: "status"; status: number } };

/** The native module's sessions, by the order they were made. */
const sessions: Array<{
  id: string;
  url: string;
  start: number;
  opened: ReturnType<typeof deferred<Opened>>;
  closed: ReturnType<typeof deferred<void>>;
  closeAsked: boolean;
  failure: { kind: "status"; status: number } | null;
}> = [];
const session = (id: string) => sessions.find((each) => each.id === id)!;
type NativeFailure = { kind: "unsupported"; detail: string } | { kind: "status"; status: number };
const stoppedServing = new Set<(event: { id: string; failure: NativeFailure }) => void>();
/** The native module saying session `id` stopped serving, as only it knows. */
const sessionFails = (id: string, failure: NativeFailure) => {
  for (const listener of stoppedServing) listener({ id, failure });
};
Object.assign(globalThis, {
  expo: {
    modules: {
      TitleFormats: {
        create: (id: string, url: string, _headers: unknown, start: number) =>
          sessions.push({
            id,
            url,
            start,
            opened: deferred<Opened>(),
            closed: deferred<void>(),
            closeAsked: false,
            failure: null,
          }),
        open: (id: string) => session(id).opened.promise,
        close: (id: string) => {
          session(id).closeAsked = true;
        },
        closed: (id: string) => session(id).closed.promise,
        failure: (id: string) => session(id).failure,
        trace: () => [],
        addListener: (
          _event: "onFailure",
          listener: (event: { id: string; failure: NativeFailure }) => void,
        ) => {
          stoppedServing.add(listener);
          return { remove: () => stoppedServing.delete(listener) };
        },
      },
    },
  },
});

const { onPlaybackFailure, play, playbackState, retry, stop } = await import("../src/playback.ts");

const movie = (id: string, subscriptionId: string | null = "sub") => ({
  id,
  subscriptionId,
  title: id,
  place: "",
  live: false,
  next: false,
  versions: false,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const options = { watch: true, login: ["user", "pass"] };

beforeEach(async () => {
  stop();
  for (const each of sessions) each.closed.resolve();
  await settle();
  sessions.length = 0;
  given.length = 0;
  fakePlayer.currentTime = 0;
});

describe("a file AVPlayer can't open", () => {
  it("plays from where it stopped through the session, without seeking again", async () => {
    void play(movie("a"), async () => ({ url: "http://panel/a.mkv", container: "mkv" }), {
      ...options,
      from: 300,
    });
    await settle();
    expect(sessions).toMatchObject([{ url: "http://panel/a.mkv", start: 300 }]);
    session("1").opened.resolve({ kind: "session", playlist: "http://127.0.0.1:1/t/main.m3u8" });
    await settle();
    expect(given.at(-1)).toEqual({ uri: "http://127.0.0.1:1/t/main.m3u8", contentType: "hls" });
    emit("statusChange", { status: "readyToPlay" });
    expect(fakePlayer.currentTime).toBe(0);
  });

  it("asks the provider nothing more until the session it let go of has closed", async () => {
    void play(movie("a"), async () => ({ url: "http://panel/a.mkv", container: "mkv" }), options);
    await settle();
    sessions[0]!.opened.resolve({ kind: "session", playlist: "http://127.0.0.1:1/a/main.m3u8" });
    await settle();
    stop();
    expect(sessions[0]!.closeAsked).toBe(true);
    expect(playbackState.get().closing).toEqual(["sub"]);
    const opened = vi.fn(async () => ({ url: "http://panel/b.mp4", container: "mp4" }));
    void play(movie("b"), opened, options);
    await settle();
    expect(opened).not.toHaveBeenCalled();
    sessions[0]!.closed.resolve();
    await settle();
    expect(opened).toHaveBeenCalledOnce();
    expect(playbackState.get().closing).toEqual([]);
  });

  it("closes a session that opens after the viewer moved on, and never plays it", async () => {
    void play(movie("a"), async () => ({ url: "http://panel/a.mkv", container: "mkv" }), options);
    await settle();
    const next = vi.fn(async () => ({ url: "http://panel/b.mp4", container: "mp4" }));
    void play(movie("b"), next, options);
    expect(sessions[0]!.closeAsked).toBe(true);
    sessions[0]!.opened.resolve({ kind: "session", playlist: "http://127.0.0.1:1/a/main.m3u8" });
    await settle();
    expect(next).not.toHaveBeenCalled();
    sessions[0]!.closed.resolve();
    await settle();
    expect(next).toHaveBeenCalledOnce();
    expect(given.filter((source) => source?.uri.includes("/a/"))).toEqual([]);
  });

  it("says why the provider stopped sending it, by the status it answered", async () => {
    void play(movie("a"), async () => ({ url: "http://panel/a.mkv", container: "mkv" }), options);
    await settle();
    sessions[0]!.opened.resolve({ kind: "session", playlist: "http://127.0.0.1:1/a/main.m3u8" });
    await settle();
    sessions[0]!.failure = { kind: "status", status: 509 };
    emit("statusChange", {
      status: "error",
      error: { message: "The network connection was lost." },
    });
    expect(playbackState.get().phase).toMatchObject({
      kind: "failed",
      error: "The provider refused this title. Another device may be using your connection.",
    });

    void play(movie("b"), async () => ({ url: "http://panel/b.mkv", container: "mkv" }), options);
    await settle();
    sessions[0]!.closed.resolve();
    await settle();
    sessions[1]!.opened.resolve({ kind: "failed", failure: { kind: "status", status: 404 } });
    await settle();
    expect(playbackState.get().phase).toMatchObject({
      kind: "failed",
      error: "The provider has no file for this title right now.",
    });
  });

  describe("when the session stops serving while the player only waits", () => {
    const gap = "The chosen sound has a gap here that can't be played.";
    const opening = async () => {
      void play(movie("a"), async () => ({ url: "http://panel/a.mkv", container: "mkv" }), options);
      await settle();
      sessions[0]!.opened.resolve({ kind: "session", playlist: "http://127.0.0.1:1/a/main.m3u8" });
      await settle();
      emit("playingChange", { isPlaying: true });
      fakePlayer.currentTime = 3.878;
    };

    it("fails at once with the session's reason, once, and Try again goes on from there", async () => {
      const reported = vi.fn();
      onPlaybackFailure(reported);
      await opening();
      sessionFails(sessions[0]!.id, { kind: "unsupported", detail: gap });
      await settle();
      expect(playbackState.get().phase).toMatchObject({
        kind: "failed",
        error: `Mr. Streamer can't play this file. ${gap}`,
      });
      expect(sessions[0]!.closeAsked).toBe(true);
      expect(given.at(-1)).toBeNull();
      // The player's own error, as it lets go, changes nothing.
      emit("statusChange", { status: "error", error: { message: "Cannot Open" } });
      expect(playbackState.get().phase).toMatchObject({
        error: `Mr. Streamer can't play this file. ${gap}`,
      });
      expect(reported).toHaveBeenCalledOnce();
      onPlaybackFailure(null);

      sessions[0]!.closed.resolve();
      retry();
      await settle();
      expect(sessions[1]).toMatchObject({ url: "http://panel/a.mkv", start: 3.878 });
    });

    it("says nothing of a session it let go of, to the next title or after stopping", async () => {
      await opening();
      void play(movie("b"), async () => ({ url: "http://panel/b.mkv", container: "mkv" }), options);
      sessionFails(sessions[0]!.id, { kind: "unsupported", detail: gap });
      sessions[0]!.closed.resolve();
      await settle();
      sessions[1]!.opened.resolve({ kind: "session", playlist: "http://127.0.0.1:1/b/main.m3u8" });
      await settle();
      expect(playbackState.get().phase).toMatchObject({ kind: "loading" });

      stop();
      sessionFails(sessions[1]!.id, { kind: "status", status: 509 });
      await settle();
      expect(playbackState.get().phase).toEqual({ kind: "idle" });
    });
  });

  it("plays a file that turns out to be MP4 directly, once the session's request ended", async () => {
    void play(movie("a"), async () => ({ url: "http://panel/a.mkv", container: "mkv" }), options);
    await settle();
    sessions[0]!.opened.resolve({ kind: "direct" });
    await settle();
    expect(given).toEqual([null]);
    sessions[0]!.closed.resolve();
    await settle();
    expect(given.at(-1)).toEqual({ uri: "http://panel/a.mkv", contentType: "auto" });
  });
});

it("plays MP4, AVI and other files, and live channels, directly as before", async () => {
  await play(movie("a"), async () => ({ url: "http://panel/a.mp4", container: "mp4" }), options);
  await play(movie("e"), async () => ({ url: "http://panel/e.avi", container: "avi" }), options);
  await play(
    { ...movie("c"), live: true },
    async () => ({ url: "http://panel/c.ts", container: "ts" }),
    options,
  );
  await play(
    { ...movie("d"), live: true },
    async () => ({ url: "http://panel/d.m3u8", container: "m3u8" }),
    options,
  );
  expect(sessions).toEqual([]);
  expect(given.filter(Boolean)).toEqual([
    { uri: "http://panel/a.mp4", contentType: "auto" },
    { uri: "http://panel/e.avi", contentType: "auto" },
    { uri: "http://panel/c.ts", contentType: "auto" },
    { uri: "http://panel/d.m3u8", contentType: "hls" },
  ]);
});
