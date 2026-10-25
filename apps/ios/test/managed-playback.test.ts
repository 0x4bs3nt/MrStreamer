import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ObservedDetachResult,
  ObservedOpenResult,
  ObservedTrackSnapshot,
  PlaybackObservation,
} from "expo-video";
import { nativePlayer } from "./native-player.ts";

const port = nativePlayer();
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-video", () => ({ createVideoPlayer: () => port }));
let owner: typeof import("../src/playback.ts");
const item = (id: string, subscriptionId: string | null = "sub") => ({
  id,
  subscriptionId,
  title: id,
  place: "",
  live: false,
  next: false,
  versions: false,
});
const options = { watch: true, login: [] };
const source = async () => ({ url: "file:clear.mp4", container: "mp4" });
const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const receipt = (attemptId: number, itemId: number | null): ObservedDetachResult => ({
  kind: "detached",
  attemptId,
  itemId,
  localItemExcluded: true,
  appWorkDrained: true,
  providerDisconnect: "unobservable",
});
let stop: (() => void) | undefined;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  port.listeners.clear();
  port.tracks = null;
  port.currentTime = 0;
  port.detachObservedAsync.mockImplementation(async (id) => receipt(id, id));
  port.replaceObservedAsync.mockImplementation(async (_source, attemptId) => ({
    kind: "attached",
    attemptId,
    itemId: attemptId,
  }));
  port.getObservedTracksAsync.mockResolvedValue({ kind: "stale" });
  port.mrStreamerPlaybackContract = 1;
  owner = await import("../src/playback.ts");
  stop = undefined;
});
afterEach(async () => {
  stop?.();
  void owner.stop();
  await tick();
  vi.useRealTimers();
});

async function start(id = "a", subscriptionId: string | null = "sub") {
  await owner.play(
    item(id, subscriptionId),
    { kind: "file", originalLanguage: null, open: source },
    options,
  );
  return {
    attemptId: port.replaceObservedAsync.mock.calls.at(-1)![1],
    itemId: port.replaceObservedAsync.mock.calls.at(-1)![1],
  };
}
function event(
  identity: { attemptId: number; itemId: number },
  kind: "playing" | "paused" = "playing",
  sequence = 1,
) {
  port.emit("playbackObservation", {
    version: 1,
    sequence,
    ...identity,
    kind: "state",
    timeControl: kind,
    mediaTimeSeconds: 12,
    bufferEmpty: false,
    likelyToKeepUp: true,
  });
}

/** Deliver the real item's initial paused fact while holding only its admission reply. */
async function knownPausedBeforeReply() {
  const admission = deferred<ObservedOpenResult>();
  stop = () => admission.resolve({ kind: "attached", attemptId: 1, itemId: 1 });
  port.replaceObservedAsync.mockImplementationOnce(async () => {
    port.emit("playbackObservation", {
      version: 1,
      sequence: 1,
      kind: "attached",
      attemptId: 1,
      itemId: 1,
    });
    event({ attemptId: 1, itemId: 1 }, "paused", 2);
    return admission.promise;
  });
  const outcome = vi.fn();
  const playing = owner.play(
    item("a"),
    { kind: "file", originalLanguage: null, open: source },
    { ...options, outcome },
  );
  await tick();
  return { admission, playing, outcome };
}

describe("managed playback ownership", () => {
  it("uses one listener and positive increasing attempts before lookup, never legacy admission", async () => {
    // The compatibility port admits legacy writes so old-product controls fail on assertions.
    port.replaceAsync.mockResolvedValue();
    const seen: number[] = [];
    const open = async () => {
      seen.push(port.replaceObservedAsync.mock.calls.length);
      expect(port.listeners.has("playbackObservation")).toBe(true);
      return source();
    };
    await owner.play(item("a"), { kind: "file", originalLanguage: null, open: open }, options);
    await owner.play(item("b"), { kind: "file", originalLanguage: null, open: open }, options);
    expect(seen).toEqual([0, 1]);
    expect(port.replaceObservedAsync.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    expect([...port.listeners.keys()]).toEqual([
      "playbackObservation",
      "isExternalPlaybackActiveChange",
    ]);
    expect(port.replaceAsync).not.toHaveBeenCalled();
  });

  it("holds direct provider ownership before idle and prevents lookup until exact acknowledgement", async () => {
    const a = await start();
    const ack = deferred<ObservedDetachResult>();
    port.detachObservedAsync.mockReturnValueOnce(ack.promise);
    const reader = owner.playbackReader(owner.playingItem(owner.playbackState.get().phase)!)!;
    let closed = false;
    void reader.closed.then(() => {
      closed = true;
    });
    void owner.stop();
    expect(owner.playbackState.get()).toMatchObject({ phase: { kind: "idle" }, closing: ["sub"] });
    const lookup = vi.fn(source);
    const next = owner.play(
      item("b"),
      { kind: "file", originalLanguage: null, open: lookup },
      options,
    );
    await tick();
    expect(lookup).not.toHaveBeenCalled();
    expect(closed).toBe(false);
    ack.resolve(receipt(a.attemptId, a.itemId));
    await next;
    expect(lookup).toHaveBeenCalledOnce();
    expect(closed).toBe(true);
  });

  it("times out a new selection without claiming closure or playing after a late acknowledgement", async () => {
    vi.useFakeTimers();
    const a = await start();
    const ack = deferred<ObservedDetachResult>();
    port.detachObservedAsync.mockReturnValueOnce(ack.promise);
    const lookup = vi.fn(source);
    const next = owner.play(
      item("b"),
      { kind: "file", originalLanguage: null, open: lookup },
      options,
    );
    await vi.advanceTimersByTimeAsync(3000);
    await next;
    expect(owner.playbackState.get().phase.kind).toBe("failed");
    expect(owner.playbackState.get().closing).toEqual(["sub"]);
    ack.resolve(receipt(a.attemptId, a.itemId));
    await tick();
    expect(lookup).not.toHaveBeenCalled();
    expect(owner.playbackState.get().phase.kind).toBe("failed");
    expect(port.replaceObservedAsync).toHaveBeenCalledOnce();
  });

  it.each(["obsolete", "rejected", "wrong-item"] as const)(
    "keeps %s closure blocked",
    async (answer) => {
      const a = await start();
      if (answer === "rejected")
        port.detachObservedAsync.mockRejectedValueOnce(new Error("private raw cause"));
      else
        port.detachObservedAsync.mockResolvedValueOnce(
          answer === "obsolete"
            ? { kind: "obsolete", attemptId: a.attemptId }
            : receipt(a.attemptId, 99),
        );
      const stopped = owner.stop();
      await tick();
      await expect(stopped).resolves.toEqual({ saved: true });
      const lookup = vi.fn(source);
      await owner.play(item("b"), { kind: "file", originalLanguage: null, open: lookup }, options);
      expect(lookup).not.toHaveBeenCalled();
      expect(owner.playbackState.get().closing).toContain("sub");
      expect(JSON.stringify(owner.playbackState.get())).not.toContain("private raw cause");
    },
  );

  it("binds a local copy reader to the resource captured before Stop and a new play", async () => {
    const a = await start("copy:1", null);
    const playing = owner.playingItem(owner.playbackState.get().phase)!;
    const reader = owner.playbackReader(playing)!;
    expect(owner.playbackReader({ ...playing })).toBeNull();
    const ack = deferred<ObservedDetachResult>();
    port.detachObservedAsync.mockReturnValueOnce(ack.promise);
    void owner.stop();
    let closed = false;
    void reader.closed.then(() => {
      closed = true;
    });
    const next = owner.play(
      item("copy:2", null),
      { kind: "file", originalLanguage: null, open: source },
      options,
    );
    await tick();
    expect(owner.playbackState.get().closing).toEqual([]);
    expect(closed).toBe(false);
    ack.resolve(receipt(a.attemptId, a.itemId));
    await next;
    expect(closed).toBe(true);
    expect(owner.playbackReader(playing)).toBeNull();
  });

  it("rapid A-B-C and a late source cannot attach or acknowledge early drain", async () => {
    const lookupA = deferred<Awaited<ReturnType<typeof source>>>();
    const a = owner.play(
      item("a"),
      { kind: "file", originalLanguage: null, open: () => lookupA.promise },
      options,
    );
    await tick();
    const bLookup = vi.fn(source);
    const b = owner.play(
      item("b"),
      { kind: "file", originalLanguage: null, open: bLookup },
      options,
    );
    const cLookup = vi.fn(source);
    const c = owner.play(
      item("c"),
      { kind: "file", originalLanguage: null, open: cLookup },
      options,
    );
    await tick();
    expect(bLookup).not.toHaveBeenCalled();
    expect(cLookup).not.toHaveBeenCalled();
    lookupA.resolve(await source());
    await Promise.all([a, b, c]);
    expect(bLookup).not.toHaveBeenCalled();
    expect(cLookup).toHaveBeenCalledOnce();
    expect(port.replaceObservedAsync.mock.calls.map((call) => call[1])).toEqual([3]);
  });

  it("filters old identity, item and sequence across ready, state, time, ended, tracks and failure", async () => {
    const a = await start();
    const ended = vi.fn();
    await owner.play(
      item("b"),
      { kind: "file", originalLanguage: null, open: source },
      { ...options, ended },
    );
    const b = { attemptId: 2, itemId: 2 };
    event(b, "playing", 10);
    const cases = [
      { kind: "ready", durationSeconds: 9 },
      {
        kind: "state",
        timeControl: "paused",
        mediaTimeSeconds: 999,
        bufferEmpty: true,
        likelyToKeepUp: false,
      },
      { kind: "ended" },
      { kind: "failure", terminal: true, failure: { kind: "unsupported", evidence: null } },
      { kind: "media-services-reset" },
      { kind: "tracks", tracks: { ...b, revision: 100 } },
    ];
    for (const body of cases)
      for (const stamp of [a, { ...b, itemId: 99 }, { ...b, sequence: 9 }]) {
        port.emit("playbackObservation", { version: 1, sequence: 20, ...stamp, ...body });
      }
    port.emit("statusChange", { status: "error", error: { message: "legacy raw" } });
    port.emit("playingChange", { isPlaying: false });
    port.emit("timeUpdate", { currentTime: 999 });
    expect(owner.playbackState.get().phase.kind).toBe("playing");
    expect(owner.playbackClock.get()).toBe(12);
    expect(ended).not.toHaveBeenCalled();
  });

  it("Close retains readers and its pause until the viewer asks to play", async () => {
    const a = await start();
    event(a);
    void owner.closeWatch();
    event(a, "paused", 2);
    event(a, "playing", 3);
    event(a, "playing", 4);
    expect(owner.playbackState.get().phase.kind).toBe("paused");
    expect(port.detachObservedAsync).not.toHaveBeenCalled();
    expect(port.play).toHaveBeenCalledOnce();
    owner.togglePause();
    event(a, "playing", 5);
    expect(owner.playbackState.get().phase.kind).toBe("playing");
  });

  it("native Play after in-app Pause accepts later ordered state without another pause", async () => {
    const a = await start();
    event(a);
    owner.togglePause();
    event(a, "paused", 2);
    expect(owner.playbackState.get().phase.kind).toBe("paused");
    port.pause.mockClear();
    event(a, "playing", 3);
    expect(port.pause).not.toHaveBeenCalled();
    expect(owner.playbackState.get().phase.kind).toBe("playing");
    expect(port.detachObservedAsync).not.toHaveBeenCalled();
  });

  it("returning to Watch clears a connecting stream's Close pause", async () => {
    const lookup = deferred<Awaited<ReturnType<typeof source>>>();
    stop = () => lookup.resolve({ url: "file:clear.mp4", container: "mp4" });
    const playing = owner.play(
      item("a"),
      { kind: "file", originalLanguage: null, open: () => lookup.promise },
      options,
    );
    await tick();
    void owner.closeWatch();
    owner.openWatch();
    lookup.resolve(await source());
    await playing;
    port.pause.mockClear();
    event({ attemptId: 1, itemId: 1 });
    expect(port.pause).not.toHaveBeenCalled();
    expect(owner.playbackState.get()).toMatchObject({ watch: true, phase: { kind: "playing" } });
  });

  it("returning to Watch preserves the viewer's explicit Pause during loading", async () => {
    const lookup = deferred<Awaited<ReturnType<typeof source>>>();
    stop = () => lookup.resolve({ url: "file:clear.mp4", container: "mp4" });
    const playing = owner.play(
      item("a"),
      { kind: "file", originalLanguage: null, open: () => lookup.promise },
      options,
    );
    await tick();
    owner.togglePause();
    void owner.closeWatch();
    owner.openWatch();
    lookup.resolve(await source());
    await playing;
    port.pause.mockClear();
    event({ attemptId: 1, itemId: 1 });
    expect(port.pause).toHaveBeenCalledOnce();
    event({ attemptId: 1, itemId: 1 }, "paused", 2);
    expect(owner.playbackState.get()).toMatchObject({ watch: true, phase: { kind: "paused" } });
    owner.pictureInPicture(true);
    port.pause.mockClear();
    event({ attemptId: 1, itemId: 1 }, "playing", 3);
    expect(port.pause).not.toHaveBeenCalled();
    expect(owner.playbackState.get().phase.kind).toBe("playing");
  });

  it("loading Pause waits for paused acknowledgement and never treats waiting as acknowledgement", async () => {
    const lookup = deferred<Awaited<ReturnType<typeof source>>>();
    stop = () => lookup.resolve({ url: "file:clear.mp4", container: "mp4" });
    const playing = owner.play(
      item("a"),
      { kind: "file", originalLanguage: null, open: () => lookup.promise },
      options,
    );
    owner.togglePause();
    lookup.resolve(await source());
    await playing;
    port.observation(
      {
        kind: "state",
        timeControl: "waiting",
        mediaTimeSeconds: 0,
        bufferEmpty: true,
        likelyToKeepUp: false,
      },
      { attemptId: 1, itemId: 1, sequence: 1 },
    );
    expect(owner.playbackState.get().phase.kind).toBe("loading");
    port.pause.mockClear();
    event({ attemptId: 1, itemId: 1 }, "playing", 2);
    expect(port.pause).toHaveBeenCalledOnce();
    event({ attemptId: 1, itemId: 1 }, "paused", 3);
    expect(owner.playbackState.get().phase.kind).toBe("paused");
    port.observation(
      {
        kind: "state",
        timeControl: "waiting",
        mediaTimeSeconds: 0,
        bufferEmpty: true,
        likelyToKeepUp: false,
      },
      { attemptId: 1, itemId: 1, sequence: 4 },
    );
    expect(owner.playbackState.get().phase.kind).toBe("paused");
    port.pause.mockClear();
    event({ attemptId: 1, itemId: 1 }, "playing", 5);
    expect(port.pause).not.toHaveBeenCalled();
    expect(owner.playbackState.get().phase.kind).toBe("playing");
  });

  it.each(["before-ack", "after-ack"] as const)(
    "loading Pause survives Settings/Downloads aside and return %s",
    async (returnAt) => {
      const lookup = deferred<Awaited<ReturnType<typeof source>>>();
      stop = () => lookup.resolve({ url: "file:clear.mp4", container: "mp4" });
      const playing = owner.play(
        item("a"),
        { kind: "file", originalLanguage: null, open: () => lookup.promise },
        options,
      );
      owner.togglePause();
      owner.setAside();
      lookup.resolve(await source());
      await playing;
      event({ attemptId: 1, itemId: 1 });
      if (returnAt === "before-ack") owner.openWatch();
      event({ attemptId: 1, itemId: 1 }, "paused", 2);
      port.play.mockClear();
      if (returnAt === "after-ack") owner.openWatch();
      expect(port.play).not.toHaveBeenCalled();
      expect(owner.playbackState.get()).toMatchObject({ watch: true, phase: { kind: "paused" } });
    },
  );

  it("unsetAside clears the away pause of a loading local copy", async () => {
    const lookup = deferred<Awaited<ReturnType<typeof source>>>();
    stop = () => lookup.resolve({ url: "file:copy.mp4", container: "mp4" });
    const playing = owner.play(
      item("copy:1", null),
      { kind: "file", originalLanguage: null, open: () => lookup.promise },
      options,
    );
    owner.setAside();
    owner.unsetAside();
    lookup.resolve(await source());
    await playing;
    port.pause.mockClear();
    event({ attemptId: 1, itemId: 1 });
    expect(port.pause).not.toHaveBeenCalled();
    expect(owner.playbackState.get()).toMatchObject({ watch: true, phase: { kind: "playing" } });
  });

  it("unsetAside keeps a paused local copy paused and accepts its later native Play", async () => {
    const a = await start("copy:1", null);
    event(a);
    owner.setAside();
    event(a, "paused", 2);
    port.play.mockClear();
    owner.unsetAside();
    expect(port.play).not.toHaveBeenCalled();
    expect(owner.playbackState.get()).toMatchObject({ watch: true, phase: { kind: "paused" } });
    port.pause.mockClear();
    owner.pictureInPicture(true);
    event(a, "playing", 3);
    expect(port.pause).not.toHaveBeenCalled();
    expect(owner.playbackState.get().phase.kind).toBe("playing");
  });

  it("unsetAside preserves a viewer loading Pause of a local copy", async () => {
    const lookup = deferred<Awaited<ReturnType<typeof source>>>();
    stop = () => lookup.resolve({ url: "file:copy.mp4", container: "mp4" });
    const playing = owner.play(
      item("copy:1", null),
      { kind: "file", originalLanguage: null, open: () => lookup.promise },
      options,
    );
    owner.togglePause();
    owner.setAside();
    owner.unsetAside();
    lookup.resolve(await source());
    await playing;
    port.pause.mockClear();
    event({ attemptId: 1, itemId: 1 });
    expect(port.pause).toHaveBeenCalledOnce();
    event({ attemptId: 1, itemId: 1 }, "paused", 2);
    expect(owner.playbackState.get()).toMatchObject({ watch: true, phase: { kind: "paused" } });
  });

  it("an early paused acknowledgement holds initial Play until the admission promise settles", async () => {
    const admission = deferred<ObservedOpenResult>();
    stop = () => admission.resolve({ kind: "attached", attemptId: 1, itemId: 1 });
    port.replaceObservedAsync.mockImplementationOnce(async () => {
      port.emit("playbackObservation", {
        version: 1,
        sequence: 1,
        kind: "attached",
        attemptId: 1,
        itemId: 1,
      });
      event({ attemptId: 1, itemId: 1 }, "paused", 2);
      return admission.promise;
    });
    const outcome = vi.fn();
    const playing = owner.play(
      item("a"),
      { kind: "file", originalLanguage: null, open: source },
      { ...options, outcome },
    );
    owner.togglePause();
    await tick();
    expect(owner.playbackState.get().phase.kind).toBe("paused");
    expect(outcome).not.toHaveBeenCalled();
    admission.resolve({ kind: "attached", attemptId: 1, itemId: 1 });
    await playing;
    expect(port.play).not.toHaveBeenCalled();
    expect(owner.playbackState.get().phase.kind).toBe("paused");
    owner.pictureInPicture(true);
    port.pause.mockClear();
    event({ attemptId: 1, itemId: 1 }, "playing", 3);
    expect(port.pause).not.toHaveBeenCalled();
    expect(owner.playbackState.get().phase.kind).toBe("playing");
    expect(outcome).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("a paused sample before the loading Pause request cannot consume the later request", async () => {
    const admission = deferred<ObservedOpenResult>();
    stop = () => admission.resolve({ kind: "attached", attemptId: 1, itemId: 1 });
    port.replaceObservedAsync.mockImplementationOnce(async () => {
      port.emit("playbackObservation", {
        version: 1,
        sequence: 1,
        kind: "attached",
        attemptId: 1,
        itemId: 1,
      });
      event({ attemptId: 1, itemId: 1 }, "paused", 2);
      return admission.promise;
    });
    const playing = owner.play(
      item("a"),
      { kind: "file", originalLanguage: null, open: source },
      options,
    );
    await tick();
    expect(owner.playbackState.get().phase.kind).toBe("loading");
    owner.togglePause();
    admission.resolve({ kind: "attached", attemptId: 1, itemId: 1 });
    await playing;
    expect(port.play).not.toHaveBeenCalled();
    event({ attemptId: 1, itemId: 1 }, "paused", 3);
    expect(owner.playbackState.get().phase.kind).toBe("paused");
    port.pause.mockClear();
    event({ attemptId: 1, itemId: 1 }, "playing", 4);
    expect(port.pause).not.toHaveBeenCalled();
    expect(owner.playbackState.get().phase.kind).toBe("playing");
  });

  it.each(["before-reply", "after-reply"] as const)(
    "known paused item exposes app Play without a fresh acknowledgement %s",
    async (playAt) => {
      const held = await knownPausedBeforeReply();
      expect(owner.playbackState.get().phase.kind).toBe("loading");
      owner.togglePause();
      expect(owner.playbackState.get().phase.kind).toBe("paused");
      expect(port.play).not.toHaveBeenCalled();
      expect(held.outcome).not.toHaveBeenCalled();

      if (playAt === "after-reply") {
        held.admission.resolve({ kind: "attached", attemptId: 1, itemId: 1 });
        await held.playing;
        expect(port.play).not.toHaveBeenCalled();
      }
      owner.togglePause();
      expect(port.play).toHaveBeenCalledOnce();
      port.pause.mockClear();
      event({ attemptId: 1, itemId: 1 }, "playing", 3);
      held.admission.resolve({ kind: "attached", attemptId: 1, itemId: 1 });
      await held.playing;
      expect(port.play).toHaveBeenCalledOnce();
      expect(port.pause).not.toHaveBeenCalled();
      expect(owner.playbackState.get().phase.kind).toBe("playing");
      expect(held.outcome).toHaveBeenCalledExactlyOnceWith(true);
    },
  );

  it("a known paused fact exposes Play without consuming the newer Pause fence", async () => {
    const held = await knownPausedBeforeReply();
    owner.togglePause();
    expect(owner.playbackState.get().phase.kind).toBe("paused");
    port.observation(
      {
        kind: "state",
        timeControl: "waiting",
        mediaTimeSeconds: 12,
        bufferEmpty: true,
        likelyToKeepUp: false,
      },
      { attemptId: 1, itemId: 1, sequence: 3 },
    );
    port.pause.mockClear();
    event({ attemptId: 1, itemId: 1 }, "playing", 4);
    expect(port.pause).toHaveBeenCalledOnce();
    expect(owner.playbackState.get().phase.kind).toBe("paused");
    expect(held.outcome).not.toHaveBeenCalled();
    event({ attemptId: 1, itemId: 1 }, "paused", 5);
    owner.pictureInPicture(true);
    port.pause.mockClear();
    event({ attemptId: 1, itemId: 1 }, "playing", 6);
    held.admission.resolve({ kind: "attached", attemptId: 1, itemId: 1 });
    await held.playing;
    expect(port.pause).not.toHaveBeenCalled();
    expect(port.play).not.toHaveBeenCalled();
    expect(owner.playbackState.get().phase.kind).toBe("playing");
    expect(held.outcome).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("Pause rechecks a reentrant waiting fact before presenting known paused", async () => {
    const held = await knownPausedBeforeReply();
    port.pause.mockImplementationOnce(() => {
      port.observation(
        {
          kind: "state",
          timeControl: "waiting",
          mediaTimeSeconds: 12,
          bufferEmpty: true,
          likelyToKeepUp: false,
        },
        { attemptId: 1, itemId: 1, sequence: 3 },
      );
    });
    owner.togglePause();
    expect(owner.playbackState.get().phase.kind).toBe("loading");
    event({ attemptId: 1, itemId: 1 }, "paused", 4);
    owner.togglePause();
    port.pause.mockClear();
    event({ attemptId: 1, itemId: 1 }, "playing", 5);
    held.admission.resolve({ kind: "attached", attemptId: 1, itemId: 1 });
    await held.playing;
    expect(port.play).toHaveBeenCalledOnce();
    expect(port.pause).not.toHaveBeenCalled();
    expect(owner.playbackState.get().phase.kind).toBe("playing");
  });

  it("Pause cannot present an old resource's paused fact after a reentrant replacement", async () => {
    const held = await knownPausedBeforeReply();
    port.pause.mockImplementationOnce(() => {
      void owner.play(item("b"), { kind: "file", originalLanguage: null, open: source }, options);
    });
    owner.togglePause();
    expect(owner.playbackState.get().phase).toMatchObject({ kind: "loading", item: { id: "b" } });
    held.admission.resolve({ kind: "attached", attemptId: 1, itemId: 1 });
    await held.playing;
    await tick();
    expect(owner.playbackState.get().phase).toMatchObject({ kind: "loading", item: { id: "b" } });
    event({ attemptId: 2, itemId: 2 });
    expect(owner.playbackState.get().phase).toMatchObject({ kind: "playing", item: { id: "b" } });
  });

  it("an accepted paused sample cannot acknowledge a newer Pause from a clock subscriber", async () => {
    const held = await knownPausedBeforeReply();
    const unsubscribe = owner.playbackClock.subscribe(() => {
      unsubscribe();
      owner.togglePause();
    });
    const cleanup = stop;
    stop = () => {
      unsubscribe();
      cleanup?.();
    };
    port.observation(
      {
        kind: "state",
        timeControl: "paused",
        mediaTimeSeconds: 13,
        bufferEmpty: false,
        likelyToKeepUp: true,
      },
      { attemptId: 1, itemId: 1, sequence: 3 },
    );
    expect(owner.playbackState.get().phase.kind).toBe("paused");
    port.pause.mockClear();
    event({ attemptId: 1, itemId: 1 }, "playing", 4);
    expect(port.pause).toHaveBeenCalledOnce();
    expect(owner.playbackState.get().phase.kind).toBe("paused");
    event({ attemptId: 1, itemId: 1 }, "paused", 5);
    owner.togglePause();
    port.pause.mockClear();
    event({ attemptId: 1, itemId: 1 }, "playing", 6);
    held.admission.resolve({ kind: "attached", attemptId: 1, itemId: 1 });
    await held.playing;
    expect(port.play).toHaveBeenCalledOnce();
    expect(port.pause).not.toHaveBeenCalled();
    expect(owner.playbackState.get().phase.kind).toBe("playing");
  });

  it("reset fails once and requires an explicit Retry", async () => {
    const a = await start();
    const failed = vi.fn();
    owner.onPlaybackFailure(failed);
    port.observation({ kind: "media-services-reset" }, a);
    port.observation(
      { kind: "failure", terminal: true, failure: { kind: "unknown", evidence: null } },
      a,
    );
    await tick();
    expect(failed).toHaveBeenCalledOnce();
    expect(owner.playbackState.get().phase.kind).toBe("failed");
    expect(port.replaceObservedAsync).toHaveBeenCalledOnce();
    owner.retry();
    await tick();
    expect(port.replaceObservedAsync).toHaveBeenCalledTimes(2);
  });

  it("deduplicates pre-item terminal event/result and detaches failed admission", async () => {
    const failure = {
      kind: "unknown",
      evidence: {
        kind: "system",
        origin: "asset",
        code: { domain: "coremedia", code: 404 },
        underlying: [],
      },
    } as const;
    const failed = vi.fn();
    owner.onPlaybackFailure(failed);
    port.replaceObservedAsync.mockImplementationOnce(
      async (_source, attemptId): Promise<ObservedOpenResult> => {
        port.emit("playbackObservation", {
          version: 1,
          sequence: 1,
          attemptId,
          itemId: null,
          kind: "failure",
          terminal: true,
          failure,
        } satisfies PlaybackObservation);
        return { kind: "failed", attemptId, itemId: null, failure };
      },
    );
    await start();
    await tick();
    expect(failed).toHaveBeenCalledExactlyOnceWith("app");
    expect(port.detachObservedAsync).toHaveBeenCalledWith(1);
    expect(owner.playbackState.get().phase).toMatchObject({
      kind: "failed",
      error: "The player stopped. Try again.",
    });
  });

  it("cancelled admission also requires detach before later lookup", async () => {
    port.replaceObservedAsync.mockResolvedValueOnce({ kind: "cancelled", attemptId: 1 });
    const ack = deferred<ObservedDetachResult>();
    port.detachObservedAsync.mockReturnValueOnce(ack.promise);
    await start();
    const lookup = vi.fn(source);
    const next = owner.play(
      item("b"),
      { kind: "file", originalLanguage: null, open: lookup },
      options,
    );
    await tick();
    expect(lookup).not.toHaveBeenCalled();
    ack.resolve(receipt(1, null));
    await next;
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("bounds the initial not-drained bootstrap on the same player and attempt", async () => {
    port.replaceObservedAsync.mockRejectedValueOnce(
      Object.assign(new Error("raw"), { code: "ERR_OBSERVED_NOT_DRAINED" }),
    );
    await start();
    expect(port.replaceObservedAsync.mock.calls.map((call) => call[1])).toEqual([1, 1]);
    expect(port.replaceAsync).not.toHaveBeenCalled();
    await owner.stop();
    port.replaceObservedAsync.mockRejectedValueOnce(
      Object.assign(new Error("raw"), { code: "ERR_OBSERVED_NOT_DRAINED" }),
    );
    await start("b");
    expect(port.replaceObservedAsync.mock.calls.map((call) => call[1])).toEqual([1, 1, 2]);
  });

  it("refuses unavailable contract and keeps raw bridge causes out of React", async () => {
    port.replaceAsync.mockResolvedValue();
    port.mrStreamerPlaybackContract = 0;
    const lookup = vi.fn(source);
    await owner.play(item("a"), { kind: "file", originalLanguage: null, open: lookup }, options);
    expect(lookup).not.toHaveBeenCalled();
    expect(port.replaceAsync).not.toHaveBeenCalled();
    expect(owner.playbackState.get().phase).toMatchObject({
      kind: "failed",
      error: "The player stopped. Try again.",
    });
    port.mrStreamerPlaybackContract = 1;
    port.replaceObservedAsync.mockRejectedValue(new Error("https://private.invalid/password"));
    await start("b");
    expect(JSON.stringify(owner.playbackState.get())).not.toContain("private.invalid");
  });
});

it("preserves a constructed but unattached item's failure and deduplicates its result", async () => {
  const reported = vi.fn();
  owner.onPlaybackFailure(reported);
  const failure = {
    kind: "network",
    evidence: {
      kind: "system",
      origin: "asset",
      code: { domain: "url", code: -1009 },
      underlying: [],
    },
  } as const;
  port.replaceObservedAsync.mockImplementationOnce(async (_source, attemptId) => {
    port.emit("playbackObservation", {
      version: 1,
      sequence: 1,
      attemptId,
      itemId: 81,
      kind: "failure",
      terminal: true,
      failure,
    });
    return { kind: "failed", attemptId, itemId: 81, failure };
  });
  port.detachObservedAsync.mockResolvedValueOnce(receipt(1, 81));
  await owner.play(item("a"), { kind: "file", originalLanguage: null, open: source }, options);
  await tick();
  expect(reported).toHaveBeenCalledExactlyOnceWith("network");
  expect(owner.playbackState.get().phase).toMatchObject({
    kind: "failed",
    error: "The connection to the provider failed.",
  });
  expect(owner.playbackState.get().closing).toEqual([]);
});

it("does not repeat an old detach or let its event change the replacement", async () => {
  const a = await start();
  const ack = deferred<ObservedDetachResult>();
  port.detachObservedAsync.mockReturnValueOnce(ack.promise);
  void owner.stop();
  void owner.stop();
  const next = owner.play(
    item("b"),
    { kind: "file", originalLanguage: null, open: source },
    options,
  );
  await tick();
  expect(port.detachObservedAsync).toHaveBeenCalledExactlyOnceWith(a.attemptId);
  ack.resolve(receipt(a.attemptId, a.itemId));
  await next;
  event({ attemptId: 2, itemId: 2 });
  port.emit("playbackObservation", {
    version: 1,
    sequence: 999,
    ...a,
    kind: "detached",
    receipt: receipt(a.attemptId, a.itemId),
  });
  expect(owner.playbackState.get().phase).toMatchObject({ kind: "playing", item: { id: "b" } });
});

it.each(["replace", "drop", "replace-and-restore"] as const)(
  "a bound source change cancels lookup even for %s",
  async (change) => {
    const { xtreamProvider } = await import("@mrstreamer/core/xtream");
    const sources = await import("../src/sources.ts");
    const provider = xtreamProvider(
      { server: "http://fixture.invalid", username: "fixture", password: "fixture" },
      { userAgent: "MrStreamer fixture" },
    );
    const original = { revision: 1, provider, login: [] };
    sources.setSource("sub", original);
    const lookup = deferred<Awaited<ReturnType<typeof source>>>();
    const playing = owner.play(
      item("a"),
      { kind: "file", originalLanguage: null, open: () => lookup.promise },
      options,
    );
    await tick();
    if (change === "drop") sources.dropSource("sub");
    else sources.setSource("sub", { revision: 2, provider, login: [] });
    if (change === "replace-and-restore") sources.setSource("sub", original);
    expect(owner.playbackState.get().phase.kind).toBe("idle");
    expect(owner.playbackState.get().closing).toEqual(["sub"]);
    lookup.resolve(await source());
    await playing;
    await tick();
    expect(port.replaceObservedAsync).not.toHaveBeenCalled();
    expect(owner.playbackState.get().closing).toEqual([]);
  },
);

it("queries fresh facts for current ready and track observations without choosing defaults", async () => {
  const identity = await start();
  port.getObservedTracksAsync.mockClear();
  port.emit("playbackObservation", {
    version: 1,
    sequence: 1,
    ...identity,
    kind: "ready",
    durationSeconds: 600,
  });
  await tick();
  expect(port.getObservedTracksAsync).toHaveBeenCalledOnce();
  const tracks = {
    ...identity,
    revision: 1,
    audio: { state: "ready", options: [] },
    subtitles: { state: "ready", options: [] },
    subtitleOffAllowed: true,
    selectedAudioId: null,
    selectedSubtitleId: null,
  } as const;
  port.emit("playbackObservation", {
    version: 1,
    sequence: 2,
    ...identity,
    kind: "tracks",
    tracks,
  });
  await tick();
  expect(port.getObservedTracksAsync).toHaveBeenCalledTimes(2);
  expect(port.selectObservedTrackAsync).not.toHaveBeenCalled();
});

it("an initially absent source can restore during reclaim before lookup binds it", async () => {
  const { xtreamProvider } = await import("@mrstreamer/core/xtream");
  const sources = await import("../src/sources.ts");
  const provider = xtreamProvider(
    { server: "http://fixture.invalid", username: "fixture", password: "fixture" },
    { userAgent: "MrStreamer fixture" },
  );
  const reclaim = deferred<void>();
  stop = () => reclaim.resolve();
  owner.onAdmission({ acquire: () => reclaim.promise, release: () => undefined });
  const lookup = vi.fn(async () => {
    expect(sources.sourceOf("sub").provider).toBe(provider);
    return source();
  });
  const playing = owner.play(
    item("a"),
    { kind: "file", originalLanguage: null, open: lookup },
    options,
  );
  await tick();
  sources.setSource("sub", { revision: 1, provider, login: [] });
  expect(owner.playbackState.get()).toMatchObject({ watch: true, phase: { kind: "loading" } });
  expect(lookup).not.toHaveBeenCalled();
  reclaim.resolve();
  await playing;
  expect(lookup).toHaveBeenCalledOnce();
  expect(port.replaceObservedAsync).toHaveBeenCalledOnce();
});

it.each(["lookup", "format"] as const)(
  "late-bound source login is redacted from %s failures and Retry",
  async (failureAt) => {
    const { xtreamProvider } = await import("@mrstreamer/core/xtream");
    const { AppFailure } = await import("@mrstreamer/contracts/errors");
    const sources = await import("../src/sources.ts");
    const login = ["r79-fixture-user", "r79-fixture-secret"];
    const detail = `live/${login[0]}/${login[1]}/1.ts`;
    const provider = xtreamProvider(
      { server: "http://fixture.invalid", username: login[0]!, password: login[1]! },
      { userAgent: "MrStreamer fixture" },
    );
    const reclaim = deferred<void>();
    stop = () => reclaim.resolve();
    owner.onAdmission({ acquire: () => reclaim.promise, release: () => undefined });
    const lookup = vi.fn(async () => {
      if (failureAt === "format") {
        throw new AppFailure({ kind: "stream", failure: { kind: "unsupported", detail } });
      }
      throw new Error(detail);
    });
    const playing = owner.play(
      item("late-login"),
      { kind: "file", originalLanguage: null, open: lookup },
      options,
    );
    await tick();
    sources.setSource("sub", { revision: 1, provider, login });
    reclaim.resolve();
    await playing;
    expect(owner.playbackState.get().phase.kind).toBe("failed");
    expect(login.some((part) => JSON.stringify(owner.playbackState.get()).includes(part))).toBe(
      false,
    );
    owner.retry();
    await tick();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(owner.playbackState.get().phase.kind).toBe("failed");
    expect(login.some((part) => JSON.stringify(owner.playbackState.get()).includes(part))).toBe(
      false,
    );
  },
);

it("an obsolete pre-reader reclaim does not hold another provider's selection", async () => {
  const first = deferred<void>();
  stop = () => first.resolve();
  const reclaim = vi.fn((id: string) => (id === "s1" ? first.promise : Promise.resolve()));
  owner.onAdmission({ acquire: (id) => reclaim(id), release: () => undefined });
  const oldLookup = vi.fn(source);
  const old = owner.play(
    item("a", "s1"),
    { kind: "file", originalLanguage: null, open: oldLookup },
    options,
  );
  await tick();
  expect(reclaim).toHaveBeenCalledExactlyOnceWith("s1");
  const newLookup = vi.fn(source);
  const next = owner.play(
    item("b", "s2"),
    { kind: "file", originalLanguage: null, open: newLookup },
    options,
  );
  await tick();
  expect(newLookup).toHaveBeenCalledOnce();
  expect(reclaim.mock.calls.map(([id]) => id)).toEqual(["s1", "s2"]);
  await next;
  first.resolve();
  await old;
  expect(oldLookup).not.toHaveBeenCalled();
  expect(port.replaceObservedAsync.mock.calls.map((call) => call[1])).toEqual([2]);
});

it.each(["resolve", "reject"] as const)(
  "a replacement still waits for its own same-provider reclaim when the old one later %s",
  async (ending) => {
    const first = deferred<void>();
    const second = deferred<void>();
    stop = () => {
      first.resolve();
      second.resolve();
    };
    const reclaim = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    owner.onAdmission({ acquire: (id) => reclaim(id), release: () => undefined });
    const oldLookup = vi.fn(source);
    const old = owner.play(
      item("a"),
      { kind: "file", originalLanguage: null, open: oldLookup },
      options,
    );
    await tick();
    const newLookup = vi.fn(source);
    const next = owner.play(
      item("b"),
      { kind: "file", originalLanguage: null, open: newLookup },
      options,
    );
    await tick();
    expect(reclaim).toHaveBeenCalledTimes(2);
    expect(newLookup).not.toHaveBeenCalled();
    if (ending === "resolve") first.resolve();
    else first.reject(new Error("obsolete reclaim refused"));
    await old;
    await tick();
    expect(newLookup).not.toHaveBeenCalled();
    second.resolve();
    await next;
    expect(newLookup).toHaveBeenCalledOnce();
    expect(oldLookup).not.toHaveBeenCalled();
  },
);

it.each(["close", "aside", "pip-start", "pip-stop"] as const)(
  "Watch context %s retires deferred viewer requests",
  async (change) => {
    await start();
    const request = owner.request();
    expect(request.stands()).toBe(true);
    if (change === "close") void owner.closeWatch();
    else if (change === "aside") owner.setAside();
    else owner.pictureInPicture(change === "pip-start");
    expect(request.stands()).toBe(false);
  },
);

/** A native snapshot of one directly opened provider file. */
function fileTracks(attemptId: number, revision = 1): ObservedTrackSnapshot {
  return {
    attemptId,
    itemId: attemptId,
    revision,
    audio: {
      state: "ready",
      options: [
        {
          attemptId,
          itemId: attemptId,
          revision,
          id: "0",
          group: "audio",
          language: "en",
          label: "English",
          isDefault: true,
          isPlayable: true,
        },
      ],
    },
    subtitles: { state: "absent", options: [] },
    subtitleOffAllowed: false,
    selectedAudioId: "0",
    selectedSubtitleId: null,
  };
}

describe("original provider-file observation", () => {
  it("resends changed settled revisions, keeps facts through unknown and omits unplayable options", async () => {
    const observed = vi.fn();
    await owner.play(
      item("provider-file"),
      {
        kind: "file",
        originalLanguage: null,
        open: async () => ({ ...(await source()), observed }),
      },
      options,
    );
    const id = port.replaceObservedAsync.mock.calls.at(-1)![1];
    const first = fileTracks(id);
    port.emit("playbackObservation", {
      version: 1,
      sequence: 1,
      ...first,
      kind: "tracks",
      tracks: first,
    });
    await tick();
    expect(observed).toHaveBeenLastCalledWith({ audio: ["en"], subtitles: [] });
    const unknown = {
      ...fileTracks(id, 2),
      subtitles: { state: "unavailable" as const, options: [] },
    };
    port.emit("playbackObservation", {
      version: 1,
      sequence: 2,
      ...unknown,
      kind: "tracks",
      tracks: unknown,
    });
    await tick();
    expect(observed).toHaveBeenCalledOnce();
    const ready = {
      ...fileTracks(id, 3),
      subtitles: {
        state: "ready" as const,
        options: [true, false].map((isPlayable, at) => ({
          attemptId: id,
          itemId: id,
          revision: 3,
          id: String(at),
          group: "subtitles" as const,
          language: isPlayable ? "nl" : "de",
          label: "Subtitles",
          isPlayable,
          isDefault: false,
          forcedOnly: false,
        })),
      },
    };
    port.emit("playbackObservation", {
      version: 1,
      sequence: 3,
      ...ready,
      kind: "tracks",
      tracks: ready,
    });
    await tick();
    expect(observed.mock.calls.map(([facts]) => facts)).toEqual([
      { audio: ["en"], subtitles: [] },
      { audio: ["en"], subtitles: ["nl"] },
    ]);
    const same = {
      ...ready,
      revision: 4,
      subtitles: {
        ...ready.subtitles,
        options: ready.subtitles.options.map((track) => ({ ...track, revision: 4 })),
      },
      audio: {
        ...ready.audio,
        options: ready.audio.options.map((track) => ({ ...track, revision: 4 })),
      },
    };
    port.emit("playbackObservation", {
      version: 1,
      sequence: 4,
      ...same,
      kind: "tracks",
      tracks: same,
    });
    await tick();
    expect(observed).toHaveBeenCalledTimes(2);
    const excessive = {
      ...fileTracks(id, 5),
      audio: {
        state: "ready" as const,
        options: Array.from({ length: 33 }, (_, at) => ({
          ...first.audio.options[0]!,
          revision: 5,
          id: String(at),
        })),
      },
    };
    port.emit("playbackObservation", {
      version: 1,
      sequence: 5,
      ...excessive,
      kind: "tracks",
      tracks: excessive,
    });
    await tick();
    expect(observed).toHaveBeenCalledTimes(2);
  });

  it.each(["copy", "live"] as const)(
    "never establishes provider-file facts for %s, even if its opener supplies a sink",
    async (kind) => {
      const observed = vi.fn();
      const open = async () => ({ ...(await source()), observed });
      const playing = { ...item(kind, kind === "copy" ? null : "sub"), live: kind === "live" };
      await owner.play(
        playing,
        kind === "live"
          ? { kind: "live", candidates: [{ variantId: "stream", open }], explicit: false }
          : { kind: "file", originalLanguage: null, open },
        options,
      );
      const id = port.replaceObservedAsync.mock.calls.at(-1)![1];
      const tracks = fileTracks(id);
      port.emit("playbackObservation", {
        version: 1,
        sequence: 1,
        ...tracks,
        kind: "tracks",
        tracks,
      });
      await tick();
      expect(observed).not.toHaveBeenCalled();
    },
  );
});

it("a source replacement retires a manual audio request before its late acknowledgement or readback can remember", async () => {
  const { xtreamProvider } = await import("@mrstreamer/core/xtream");
  const sources = await import("../src/sources.ts");
  const preferences = await import("../src/media-preferences.ts");
  preferences.updateMediaPreferences("audio", { kind: "follow-title" });
  preferences.updateMediaPreferences("titleLanguage", "en");
  preferences.updateMediaPreferences("subtitles", { kind: "off" });
  const provider = xtreamProvider(
    { server: "http://fixture.invalid", username: "fixture", password: "fixture" },
    { userAgent: "MrStreamer fixture" },
  );
  sources.setSource("sub", { revision: 1, provider, login: [] });
  const identity = await start();
  const base = fileTracks(identity.attemptId);
  const tracks = {
    ...base,
    audio: {
      ...base.audio,
      options: [
        ...base.audio.options,
        { ...base.audio.options[0]!, id: "1", language: "de", label: "German", isDefault: false },
      ],
    },
  };
  port.getObservedTracksAsync.mockResolvedValue(tracks);
  const row = (await owner.trackChoices("audio")).find((each) => each.label === "German");
  if (!row) throw new Error("No German row");
  const ack = deferred<{ kind: "requested" }>();
  stop = () => ack.resolve({ kind: "requested" });
  port.selectObservedTrackAsync.mockImplementationOnce(async () => ack.promise);
  const choosing = row.choose();
  await tick();
  sources.setSource("sub", { revision: 2, provider, login: [] });
  ack.resolve({ kind: "requested" });
  await choosing;
  port.emit("playbackObservation", {
    version: 1,
    sequence: 20,
    ...identity,
    kind: "tracks",
    tracks: { ...tracks, selectedAudioId: "1" },
  });
  await tick();
  expect(preferences.getMediaPreferences().audio).toEqual({ kind: "follow-title" });
  expect(owner.playbackState.get().phase.kind).toBe("idle");
});
