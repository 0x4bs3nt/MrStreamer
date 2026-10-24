import { AppFailure } from "@mrstreamer/contracts/errors";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

// Leaving Watch and letting go of a title, as playback promises its owners: Close pauses what
// plays and saves where it got to, unless Picture in Picture or AirPlay already shows it; Stop
// ends it and saves. Saves of how far a title got go one at a time, in the order asked, and
// Close and Stop resolve once theirs ended, saying whether it was kept. The native player is a
// stand-in that reports what the app told it; the AVPlayer itself is not run here.

const listeners = new Map<string, (payload: never) => void>();
const fakePlayer = {
  muted: true,
  timeUpdateEventInterval: 0,
  staysActiveInBackground: false,
  currentTime: 0,
  duration: 600,
  addListener: (event: string, listener: (payload: never) => void) => {
    listeners.set(event, listener);
  },
  replaceAsync: vi.fn(async () => undefined),
  play: vi.fn(),
  pause: vi.fn(),
};
const emit = (event: string, payload: unknown) => listeners.get(event)?.(payload as never);
vi.mock("expo-video", () => ({ createVideoPlayer: () => fakePlayer }));

const {
  closeWatch,
  onProgressRefused,
  openWatch,
  pictureInPicture,
  play,
  playbackState,
  setMuted,
  stop,
  togglePause,
} = await import("../src/playback.ts");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const movie = (id: string, live = false) => ({
  id,
  subscriptionId: "sub",
  title: id,
  place: "",
  live,
  next: false,
  versions: false,
});
const open = async () => ({ url: `file:${Math.random()}`, container: "mp4" });
const settle = () => new Promise((done) => setTimeout(done, 0));

/** Each save a title's owner was asked for, in order, with its answer to give. */
let saves: Array<{ id: string; position: number; answer: ReturnType<typeof deferred<void>> }> = [];
/** Saves how far `id` got, as its owner would. */
const saverOf = (id: string) => (position: number) => {
  const answer = deferred<void>();
  saves.push({ id, position, answer });
  return answer.promise;
};
const progress = saverOf("m1");
/** The player reports it plays, or stopped playing. */
const playing = (isPlaying = true) => emit("playingChange", { isPlaying });

/** A movie playing in Watch at `position` seconds; what the player was told so far is cleared. */
async function watching(position = 120) {
  await play(movie("m1"), open, { watch: true, login: [], progress });
  playing();
  fakePlayer.currentTime = position;
  fakePlayer.pause.mockClear();
  fakePlayer.play.mockClear();
}

beforeEach(async () => {
  void stop();
  pictureInPicture(false);
  emit("isExternalPlaybackActiveChange", { isExternalPlaybackActive: false });
  // Answers every save the last test left waiting, and those each asked for after it.
  let answered = -1;
  while (answered !== saves.length) {
    answered = saves.length;
    for (const save of saves) save.answer.resolve();
    await settle();
  }
  saves = [];
  fakePlayer.pause.mockClear();
  fakePlayer.play.mockClear();
  fakePlayer.currentTime = 0;
});

describe("Close", () => {
  it("pauses what plays, saves where it got to and goes back to the tabs at once", async () => {
    await watching(120);
    const closing = closeWatch();
    expect(fakePlayer.pause).toHaveBeenCalledOnce();
    expect(playbackState.get()).toMatchObject({ watch: false, aside: false });
    await settle();
    expect(saves.map((save) => save.position)).toEqual([120]);
    saves[0]!.answer.resolve();
    await expect(closing).resolves.toEqual({ saved: true });
  });

  it("pauses a title still connecting as soon as it starts, and doesn't play it later", async () => {
    const source = deferred<{ url: string; container: string }>();
    const starting = play(movie("m1"), () => source.promise, { watch: true, login: [], progress });
    fakePlayer.pause.mockClear();
    void closeWatch();
    source.resolve({ url: "file:m1", container: "mp4" });
    await starting;
    expect(fakePlayer.pause).not.toHaveBeenCalled();
    playing();
    expect(fakePlayer.pause).toHaveBeenCalledOnce();
    playing(false);
    expect(playbackState.get()).toMatchObject({ phase: { kind: "paused" }, watch: false });
    expect(fakePlayer.play).toHaveBeenCalledOnce();
  });

  it("leaves a paused title paused, where it was saved", async () => {
    await watching(120);
    togglePause();
    playing(false);
    fakePlayer.pause.mockClear();
    void closeWatch();
    expect(fakePlayer.pause).not.toHaveBeenCalled();
    expect(fakePlayer.play).not.toHaveBeenCalled();
    expect(playbackState.get()).toMatchObject({ phase: { kind: "paused" }, watch: false });
  });

  it("pauses a channel too, which has nothing to save", async () => {
    await play(movie("c1", true), open, { watch: true, login: [] });
    playing();
    fakePlayer.pause.mockClear();
    void closeWatch();
    expect(fakePlayer.pause).toHaveBeenCalledOnce();
    await settle();
    expect(saves).toEqual([]);
  });

  it("lets AirPlay play on as muted as it was", async () => {
    await watching(120);
    emit("isExternalPlaybackActiveChange", { isExternalPlaybackActive: true });
    setMuted(true);
    void closeWatch();
    expect(fakePlayer.pause).not.toHaveBeenCalled();
    expect(fakePlayer.muted).toBe(true);
    expect(playbackState.get()).toMatchObject({ phase: { kind: "playing" }, muted: true });
  });

  it("lets Picture in Picture play on, with its sound", async () => {
    await watching(120);
    pictureInPicture(true);
    void closeWatch();
    expect(fakePlayer.pause).not.toHaveBeenCalled();
    expect(fakePlayer.muted).toBe(false);
    expect(playbackState.get()).toMatchObject({ phase: { kind: "playing" }, pip: true });
  });

  it("lets AirPlay play on, with its sound", async () => {
    await watching(120);
    emit("isExternalPlaybackActiveChange", { isExternalPlaybackActive: true });
    void closeWatch();
    expect(fakePlayer.pause).not.toHaveBeenCalled();
    expect(fakePlayer.muted).toBe(false);
    expect(playbackState.get()).toMatchObject({ phase: { kind: "playing" }, muted: false });
  });

  it("says when its save was refused", async () => {
    await watching(120);
    const closing = closeWatch();
    await settle();
    saves[0]!.answer.reject(new AppFailure({ kind: "no-subscription" }));
    await expect(closing).resolves.toEqual({
      saved: false,
      error: { kind: "no-subscription" },
    });
  });
});

describe("after Close", () => {
  it("plays again with its sound from the accessory", async () => {
    await watching(120);
    void closeWatch();
    playing(false);
    expect(playbackState.get()).toMatchObject({ phase: { kind: "paused" }, muted: true });
    togglePause();
    expect(fakePlayer.play).toHaveBeenCalledOnce();
    expect(fakePlayer.muted).toBe(false);
    playing();
    expect(playbackState.get()).toMatchObject({ phase: { kind: "playing" }, muted: false });
  });

  it("starts a new Home preview without sound, after a title or a channel", async () => {
    for (const live of [false, true]) {
      await play(movie(live ? "c1" : "m1", live), open, { watch: true, login: [], progress });
      playing();
      void closeWatch();
      playing(false);
      await play(movie("c2", true), open, { watch: false, login: [] });
      expect(fakePlayer.muted).toBe(true);
      expect(playbackState.get()).toMatchObject({ phase: { kind: "loading" }, muted: true });
    }
  });

  it("keeps a mute chosen in Watch through Close and Play", async () => {
    await watching(120);
    setMuted(true);
    void closeWatch();
    playing(false);
    togglePause();
    expect(fakePlayer.play).toHaveBeenCalledOnce();
    expect(fakePlayer.muted).toBe(true);
    expect(playbackState.get()).toMatchObject({ muted: true });
  });

  it("keeps a mute chosen on Home after Close when Play is pressed", async () => {
    await watching(120);
    void closeWatch();
    playing(false);
    setMuted(false);
    setMuted(true);
    togglePause();
    expect(fakePlayer.muted).toBe(true);
  });

  // The accessory shows what the player last reported: pressed before the player reports Close's
  // pause, it still shows Pause, and pressing it pauses, without sound. Once the pause is
  // reported, Play plays with the sound Close silenced.
  it("pauses for a press before the player reports Close's pause, and plays with sound after", async () => {
    await watching(120);
    void closeWatch();
    togglePause();
    expect(fakePlayer.play).not.toHaveBeenCalled();
    expect(fakePlayer.muted).toBe(true);
    playing(false);
    togglePause();
    expect(fakePlayer.play).toHaveBeenCalledOnce();
    expect(fakePlayer.muted).toBe(false);
  });

  it("gives a title Stop ended no sound back, and the next Home preview none", async () => {
    await watching(120);
    void closeWatch();
    playing(false);
    void stop();
    await play(movie("c2", true), open, { watch: false, login: [] });
    playing();
    playing(false);
    togglePause();
    expect(fakePlayer.muted).toBe(true);
  });

  it("shows Watch again paused, with its sound, until the viewer plays it", async () => {
    await watching(120);
    void closeWatch();
    playing(false);
    openWatch();
    expect(fakePlayer.play).not.toHaveBeenCalled();
    expect(fakePlayer.muted).toBe(false);
    expect(playbackState.get()).toMatchObject({ phase: { kind: "paused" }, watch: true });
  });

  it("saves nothing of the next title for a pause the player reports after it began", async () => {
    await watching(120);
    void closeWatch();
    await play(movie("m2"), open, { watch: true, login: [], progress: saverOf("m2") });
    fakePlayer.currentTime = 0;
    playing(false);
    for (const save of saves) save.answer.resolve();
    await settle();
    expect(saves.map(({ id, position }) => `${id}@${position}`)).toEqual(["m1@120", "m1@120"]);
  });
});

describe("a refused save", () => {
  it("is told once until a save is kept again", async () => {
    const told = vi.fn();
    onProgressRefused(told);
    onTestFinished(() => onProgressRefused(null));
    await watching(120);
    void closeWatch();
    playing(false);
    await settle();
    saves[0]!.answer.reject(new Error("disk full"));
    await settle();
    saves[1]!.answer.reject(new Error("disk full"));
    await settle();
    expect(told).toHaveBeenCalledOnce();
    togglePause();
    playing();
    playing(false);
    await settle();
    saves[2]!.answer.resolve();
    await settle();
    const stopping = stop();
    await settle();
    saves[3]!.answer.reject(new Error("disk full"));
    await expect(stopping).resolves.toMatchObject({ saved: false });
    expect(told).toHaveBeenCalledTimes(2);
  });
});

describe("saving how far a title got", () => {
  it("asks for each save once the one before it ended, so a late one can't land last", async () => {
    await watching(120);
    togglePause();
    playing(false);
    fakePlayer.currentTime = 150;
    togglePause();
    playing();
    fakePlayer.currentTime = 200;
    const stopping = stop();
    await settle();
    expect(saves.map((save) => save.position)).toEqual([120]);
    saves[0]!.answer.resolve();
    await settle();
    expect(saves.map((save) => save.position)).toEqual([120, 200]);
    let settled = false;
    void stopping.then(() => (settled = true));
    await settle();
    expect(settled).toBe(false);
    saves[1]!.answer.resolve();
    await expect(stopping).resolves.toEqual({ saved: true });
  });

  it("keeps saving after a refusal, and says how the latest went", async () => {
    await watching(120);
    togglePause();
    playing(false);
    await settle();
    saves[0]!.answer.reject(new Error("disk full"));
    await settle();
    fakePlayer.currentTime = 130;
    const stopping = stop();
    await settle();
    expect(saves.map((save) => save.position)).toEqual([120, 130]);
    saves[1]!.answer.resolve();
    await expect(stopping).resolves.toEqual({ saved: true });
  });

  it("keeps a new play's saves after the old one's last", async () => {
    await watching(120);
    await play(movie("m2"), open, { watch: true, login: [], progress });
    playing();
    fakePlayer.currentTime = 30;
    void stop();
    await settle();
    expect(saves.map((save) => save.position)).toEqual([120]);
    saves[0]!.answer.resolve();
    await settle();
    expect(saves.map((save) => save.position)).toEqual([120, 30]);
  });
});
