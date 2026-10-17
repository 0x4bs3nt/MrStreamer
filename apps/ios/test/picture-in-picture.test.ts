import { beforeEach, describe, expect, it, vi } from "vitest";

// Where Picture in Picture leaves the viewer, as Watch reports its native events to playback:
// brought back to the app, Watch shows the player again with its sound; closed, the tabs stay and
// Home's preview is silent. The native player is a stand-in, and screens read playback's state
// as React would, at the moment they ask.

const fakePlayer = {
  muted: true,
  timeUpdateEventInterval: 0,
  addListener: () => undefined,
  replaceAsync: async () => undefined,
  play: () => undefined,
  pause: () => undefined,
};
vi.mock("expo-video", () => ({ createVideoPlayer: () => fakePlayer }));
vi.mock("../src/store.ts", async (original) => ({
  ...(await original<typeof import("../src/store.ts")>()),
  useStore: <S>(source: { get(): S }) => source.get(),
}));

const {
  pictureInPicture,
  play,
  player,
  playingItem,
  restoreFromPictureInPicture,
  stop,
  usePlayback,
} = await import("../src/playback.ts");

const item = {
  id: "a:1",
  subscriptionId: "a",
  title: "A movie",
  place: "",
  live: false,
  next: false,
  versions: false,
};
const open = async () => ({ url: "file:a:1", container: "mp4" });

/** Plays a movie in Watch, then moves it to Picture in Picture as the native view reports. */
async function intoPictureInPicture() {
  await play(item, open, { watch: true, login: [] });
  pictureInPicture(true);
  expect(usePlayback()).toMatchObject({ watch: false, pip: true });
}

beforeEach(() => stop());

describe("leaving Picture in Picture", () => {
  it("opens Watch again with sound when the viewer brings it back", async () => {
    await intoPictureInPicture();
    expect(restoreFromPictureInPicture()).toBe(item);
    pictureInPicture(false);
    expect(usePlayback()).toMatchObject({ watch: true, pip: false, muted: false });
    expect(player().muted).toBe(false);
  });

  it("opens nothing when the viewer stopped it before it came back", async () => {
    await intoPictureInPicture();
    stop();
    expect(restoreFromPictureInPicture()).toBeNull();
    pictureInPicture(false);
    expect(usePlayback()).toMatchObject({ phase: { kind: "idle" }, watch: false, pip: false });
  });

  // Watch answers the return only while what it returned to still plays. A movie and a channel
  // of one subscription can share a key, so a newer play of the same key is not it.
  it("tells what it returned to from a newer play of the same key", async () => {
    await intoPictureInPicture();
    const returned = restoreFromPictureInPicture();
    expect(playingItem(usePlayback().phase)).toBe(returned);
    await play({ ...item, live: true }, open, { watch: true, login: [] });
    expect(playingItem(usePlayback().phase)).not.toBe(returned);
  });

  it("stays on the tabs, silent, when the viewer closes it", async () => {
    await intoPictureInPicture();
    pictureInPicture(false);
    expect(usePlayback()).toMatchObject({ watch: false, pip: false, muted: true });
    expect(player().muted).toBe(true);
  });
});
