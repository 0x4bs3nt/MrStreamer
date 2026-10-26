import { nativePlayer } from "./native-player.ts";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

// Titles in files AVPlayer can't open play through a format session: the native module reads the
// file and gives the player a loopback playlist. What the viewer and the provider would see is
// what's checked: what the player is given, when the provider is asked again, and what a failure
// says. The native player and the native module are stand-ins.

const given: Array<{ uri: string; contentType?: string } | null> = [];
const fakePlayer = nativePlayer((source) => {
  given.push(source);
});

vi.mock("expo-file-system", () => import("./native-files.ts"));
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

const { onPlaybackFailure, play, playbackState, recheckPlayback, retry, stop } =
  await import("../src/playback.ts");

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
  for (const each of sessions) {
    each.opened.resolve({ kind: "closed" });
    each.closed.resolve();
  }
  await settle();
  sessions.length = 0;
  given.length = 0;
  fakePlayer.currentTime = 0;
});

describe("a file AVPlayer can't open", () => {
  it.each(["catalogue change", "final admission"])(
    "refuses a revoked source during format preparation: %s",
    async (trigger) => {
      let permitted = true;
      void play(
        movie("restricted"),
        {
          kind: "file",
          originalLanguage: null,
          open: async () => ({
            url: "http://panel/restricted.mkv",
            container: "mkv",
            admit: () => {
              if (!permitted) throw new Error("This source is no longer permitted.");
            },
          }),
        },
        options,
      );
      await settle();
      expect(sessions).toHaveLength(1);
      permitted = false;
      if (trigger === "catalogue change") {
        recheckPlayback();
        expect(playbackState.get().phase.kind).toBe("failed");
      }
      sessions[0]!.opened.resolve({
        kind: "session",
        playlist: "http://127.0.0.1:1/restricted/main.m3u8",
      });
      await settle();
      expect(playbackState.get().phase.kind).toBe("failed");
      expect(given.filter((source) => source !== null)).toEqual([]);
      expect(sessions[0]!.closeAsked).toBe(true);
      sessions[0]!.closed.resolve();
      await stop();
    },
  );

  it("plays from where it stopped through the session, without seeking again", async () => {
    void play(
      movie("a"),
      {
        kind: "file",
        originalLanguage: null,
        open: async () => ({ url: "http://panel/a.mkv", container: "mkv" }),
      },
      {
        ...options,
        from: 300,
      },
    );
    await settle();
    expect(sessions).toMatchObject([{ url: "http://panel/a.mkv", start: 300 }]);
    sessions[0]!.opened.resolve({ kind: "session", playlist: "http://127.0.0.1:1/t/main.m3u8" });
    await settle();
    expect(given.at(-1)).toEqual({ uri: "http://127.0.0.1:1/t/main.m3u8", contentType: "hls" });
    fakePlayer.ready();
    expect(fakePlayer.currentTime).toBe(0);
  });

  it("asks the provider nothing more until the session it let go of has closed", async () => {
    void play(
      movie("a"),
      {
        kind: "file",
        originalLanguage: null,
        open: async () => ({ url: "http://panel/a.mkv", container: "mkv" }),
      },
      options,
    );
    await settle();
    sessions[0]!.opened.resolve({ kind: "session", playlist: "http://127.0.0.1:1/a/main.m3u8" });
    await settle();
    stop();
    expect(sessions[0]!.closeAsked).toBe(true);
    expect(playbackState.get().closing).toEqual(["sub"]);
    const opened = vi.fn(async () => ({ url: "http://panel/b.mp4", container: "mp4" }));
    void play(movie("b"), { kind: "file", originalLanguage: null, open: opened }, options);
    await settle();
    expect(opened).not.toHaveBeenCalled();
    sessions[0]!.closed.resolve();
    await settle();
    expect(opened).toHaveBeenCalledOnce();
    expect(playbackState.get().closing).toEqual([]);
  });

  it("says Stop settled only once the session's request ended", async () => {
    void play(
      movie("a"),
      {
        kind: "file",
        originalLanguage: null,
        open: async () => ({ url: "http://panel/a.mkv", container: "mkv" }),
      },
      options,
    );
    await settle();
    sessions[0]!.opened.resolve({ kind: "session", playlist: "http://127.0.0.1:1/a/main.m3u8" });
    await settle();
    let settled = false;
    void stop().then(() => (settled = true));
    await settle();
    expect(sessions[0]!.closeAsked).toBe(true);
    expect(settled).toBe(false);
    sessions[0]!.closed.resolve();
    await settle();
    expect(settled).toBe(true);
  });

  it("closes a session that opens after the viewer moved on, and never plays it", async () => {
    void play(
      movie("a"),
      {
        kind: "file",
        originalLanguage: null,
        open: async () => ({ url: "http://panel/a.mkv", container: "mkv" }),
      },
      options,
    );
    await settle();
    const next = vi.fn(async () => ({ url: "http://panel/b.mp4", container: "mp4" }));
    void play(movie("b"), { kind: "file", originalLanguage: null, open: next }, options);
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
    void play(
      movie("a"),
      {
        kind: "file",
        originalLanguage: null,
        open: async () => ({ url: "http://panel/a.mkv", container: "mkv" }),
      },
      options,
    );
    await settle();
    sessions[0]!.opened.resolve({ kind: "session", playlist: "http://127.0.0.1:1/a/main.m3u8" });
    await settle();
    sessions[0]!.failure = { kind: "status", status: 509 };
    fakePlayer.failure();
    expect(playbackState.get().phase).toMatchObject({
      kind: "failed",
      error: "The provider refused this title. Another device may be using your connection.",
    });

    void play(
      movie("b"),
      {
        kind: "file",
        originalLanguage: null,
        open: async () => ({ url: "http://panel/b.mkv", container: "mkv" }),
      },
      options,
    );
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
      void play(
        movie("a"),
        {
          kind: "file",
          originalLanguage: null,
          open: async () => ({ url: "http://panel/a.mkv", container: "mkv" }),
        },
        options,
      );
      await settle();
      sessions[0]!.opened.resolve({ kind: "session", playlist: "http://127.0.0.1:1/a/main.m3u8" });
      await settle();
      fakePlayer.state(true);
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
      expect(fakePlayer.detachObservedAsync).toHaveBeenCalledWith(fakePlayer.identity().attemptId);
      // The player's own error, as it lets go, changes nothing.
      fakePlayer.failure();
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
      void play(
        movie("b"),
        {
          kind: "file",
          originalLanguage: null,
          open: async () => ({ url: "http://panel/b.mkv", container: "mkv" }),
        },
        options,
      );
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
    void play(
      movie("a"),
      {
        kind: "file",
        originalLanguage: null,
        open: async () => ({ url: "http://panel/a.mkv", container: "mkv" }),
      },
      options,
    );
    await settle();
    sessions[0]!.opened.resolve({ kind: "direct" });
    await settle();
    expect(given).toEqual([]);
    sessions[0]!.closed.resolve();
    await settle();
    expect(given.at(-1)).toEqual({ uri: "http://panel/a.mkv", contentType: "auto" });
  });
});

it("plays MP4, AVI and other files, and live channels, directly as before", async () => {
  await play(
    movie("a"),
    {
      kind: "file",
      originalLanguage: null,
      open: async () => ({ url: "http://panel/a.mp4", container: "mp4" }),
    },
    options,
  );
  await play(
    movie("e"),
    {
      kind: "file",
      originalLanguage: null,
      open: async () => ({ url: "http://panel/e.avi", container: "avi" }),
    },
    options,
  );
  await play(
    { ...movie("c"), live: true },
    {
      kind: "live",
      candidates: [
        { variantId: "stream", open: async () => ({ url: "http://panel/c.ts", container: "ts" }) },
      ],
      explicit: false,
    },
    options,
  );
  await play(
    { ...movie("d"), live: true },
    {
      kind: "live",
      candidates: [
        {
          variantId: "stream",
          open: async () => ({ url: "http://panel/d.m3u8", container: "m3u8" }),
        },
      ],
      explicit: false,
    },
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

it("keeps a local copy's reader handle pending through both native detach and format close", async () => {
  const app = await import("../src/playback.ts");
  void play(
    movie("copy:local", null),
    {
      kind: "file",
      originalLanguage: null,
      open: async () => ({ url: "file:copy.mkv", container: "mkv" }),
    },
    options,
  );
  await settle();
  sessions[0]!.opened.resolve({ kind: "session", playlist: "http://127.0.0.1:1/copy/main.m3u8" });
  await settle();
  const exact = app.playingItem(playbackState.get().phase)!;
  const reader = app.playbackReader(exact)!;
  let closed = false;
  void reader.closed.then(() => {
    closed = true;
  });
  const pending = deferred<Awaited<ReturnType<typeof fakePlayer.detachObservedAsync>>>();
  fakePlayer.detachObservedAsync.mockReturnValueOnce(pending.promise);
  const stopping = stop();
  await settle();
  sessions[0]!.closed.resolve();
  await settle();
  expect(closed).toBe(false);
  const identity = fakePlayer.identity();
  pending.resolve({
    kind: "detached",
    ...identity,
    localItemExcluded: true,
    appWorkDrained: true,
    providerDisconnect: "unobservable",
  });
  await stopping;
  expect(closed).toBe(true);
});

it.each(["session", "direct"] as const)(
  "uses the actual %s format outcome to gate original-file facts",
  async (kind) => {
    const observed = vi.fn();
    const opening = play(
      movie("provider"),
      {
        kind: "file",
        originalLanguage: null,
        open: async () => ({ url: "http://panel/provider.mkv", container: "mkv", observed }),
      },
      options,
    );
    await settle();
    const reader = sessions.at(-1);
    if (!reader) throw new Error("No format reader");
    reader.opened.resolve(
      kind === "session"
        ? { kind: "session", playlist: "file:rendition.m3u8" }
        : { kind: "direct" },
    );
    await settle();
    if (kind === "direct") {
      expect(observed).not.toHaveBeenCalled();
      reader.closed.resolve();
    }
    await opening;
    const identity = fakePlayer.identity();
    const tracks = {
      ...identity,
      revision: 1,
      audio: {
        state: "ready" as const,
        options: [
          {
            ...identity,
            revision: 1,
            id: "0",
            group: "audio" as const,
            label: "English",
            language: "en",
            isDefault: true,
            isPlayable: true,
          },
        ],
      },
      subtitles: { state: "absent" as const, options: [] },
      selectedAudioId: "0",
      selectedSubtitleId: null,
      subtitleOffAllowed: false,
    };
    fakePlayer.tracks = tracks;
    fakePlayer.observation({ kind: "tracks", tracks });
    await settle();
    if (kind === "session") expect(observed).not.toHaveBeenCalled();
    else {
      expect(observed).toHaveBeenCalledOnce();
      expect(observed).toHaveBeenCalledWith({ audio: ["en"], subtitles: [] });
    }
    reader.closed.resolve();
    if (kind === "session") {
      const later = {
        ...tracks,
        revision: 2,
        audio: {
          ...tracks.audio,
          options: tracks.audio.options.map((track) => ({ ...track, revision: 2 })),
        },
      };
      fakePlayer.tracks = later;
      fakePlayer.observation({ kind: "tracks", tracks: later });
      await settle();
      expect(observed).not.toHaveBeenCalled();
    }
    await stop();
  },
);

it("waits for both format closure and native detach before the first Live candidate and its fallback", async () => {
  const { onAdmission } = await import("../src/playback.ts");
  const order: string[] = [];
  onAdmission({
    acquire: async () => {
      order.push("acquire");
    },
    release: () => {
      order.push("release");
    },
  });
  void play(
    movie("file"),
    {
      kind: "file",
      originalLanguage: null,
      open: async () => ({ url: "http://panel/file.mkv", container: "mkv" }),
    },
    options,
  );
  await settle();
  const format = sessions[0]!;
  format.opened.resolve({ kind: "session", playlist: "http://127.0.0.1:1/file/main.m3u8" });
  await settle();
  const stamp = fakePlayer.identity();
  const drain = deferred<Awaited<ReturnType<typeof fakePlayer.detachObservedAsync>>>();
  const receipt: Awaited<ReturnType<typeof fakePlayer.detachObservedAsync>> = {
    kind: "detached",
    ...stamp,
    localItemExcluded: true,
    appWorkDrained: true,
    providerDisconnect: "unobservable",
  };
  onTestFinished(async () => {
    drain.resolve(receipt);
    format.closed.resolve();
    await stop();
    onAdmission(null);
  });
  fakePlayer.detachObservedAsync.mockReturnValueOnce(drain.promise);
  const candidate = (id: string) => ({
    variantId: id,
    open: async () => {
      order.push(`lookup:${id}`);
      return { url: `http://panel/${id}.m3u8`, container: "m3u8" };
    },
  });
  const live = play(
    { ...movie("live"), live: true },
    {
      kind: "live",
      explicit: false,
      candidates: [candidate("first"), candidate("fallback")],
    },
    options,
  );
  await settle();
  expect(order).toEqual(["acquire"]);
  format.closed.resolve();
  await settle();
  expect(order).toEqual(["acquire"]);
  drain.resolve(receipt);
  await live;
  expect(order).toEqual(["acquire", "release", "acquire", "lookup:first"]);
  fakePlayer.failure({ kind: "missing", evidence: null });
  await settle();
  expect(order).toEqual([
    "acquire",
    "release",
    "acquire",
    "lookup:first",
    "release",
    "acquire",
    "lookup:fallback",
  ]);
  await stop();
  onAdmission(null);
});
