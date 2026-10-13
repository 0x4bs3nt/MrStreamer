// @vitest-environment happy-dom
// The mini player goes with the view it shrank: leaving Watch, or opening Settings, which has no
// room in it, puts the window back, and only where the platform keeps a window on top. A window
// that was full screen is back once it fills the screen again.
import { fullScreen, ipc } from "./support.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The app's modules with the main process answering that windows can stay on top. Loaded as the
 * file is collected, so their transform is not timed as the first test.
 */
async function loaded() {
  const answer = ipc.hold("window.miniPlayerAvailable");
  const [{ miniPlayer }, { closeWatch, openWatch, useUi }] = await Promise.all([
    import("../../src/renderer/src/app/mini-player.ts"),
    import("../../src/renderer/src/app/ui-store.ts"),
  ]);
  answer.resolve(true);
  await settle();
  return { miniPlayer, closeWatch, openWatch, useUi };
}

const app = await loaded();

/** The window positions asked of the main process so far. */
const asked = () => ipc.argsOf("window.setMiniPlayer");

beforeEach(() => {
  ipc.reset();
  fullScreen.reset();
});

afterEach(() => {
  vi.useRealTimers();
  ipc.emit("window.fullScreen", false);
});

describe("the mini player", () => {
  it("puts the window back when Watch closes or Settings opens", async () => {
    const { miniPlayer, closeWatch, openWatch, useUi } = app;
    openWatch();
    ipc.hold("window.setMiniPlayer").resolve(null);
    await miniPlayer.enter();
    closeWatch();
    await settle();
    expect(asked()).toEqual([{ on: true }, { on: false }]);

    openWatch();
    ipc.hold("window.setMiniPlayer").resolve(null);
    await miniPlayer.enter();
    useUi.setState({ settings: "general" });
    await settle();
    expect(asked()).toEqual([{ on: true }, { on: false }, { on: true }, { on: false }]);
  });

  it("puts the window back again when it shrank on its way back, and waits for that way back", async () => {
    const { miniPlayer, openWatch } = app;
    openWatch();
    ipc.hold("window.setMiniPlayer").resolve(null);
    await miniPlayer.enter();

    // P three times, faster than the main process moves the window: out, in again, and out.
    const first = ipc.hold("window.setMiniPlayer");
    void miniPlayer.toggle();
    ipc.hold("window.setMiniPlayer").resolve(null);
    await miniPlayer.toggle();
    const second = ipc.hold("window.setMiniPlayer");
    void miniPlayer.toggle();
    expect(asked()).toEqual([{ on: true }, { on: false }, { on: true }, { on: false }]);

    // The first way back ends while the second is under way, so the window isn't back yet.
    first.resolve(null);
    await settle();
    let back = false;
    void miniPlayer.leave().then(() => (back = true));
    await settle();
    expect(back).toBe(false);

    second.resolve(null);
    await settle();
    expect(back).toBe(true);
  });

  it("asks for full screen again on the way back that stays, not on one it shrank on", async () => {
    const { miniPlayer, openWatch } = app;
    openWatch();
    fullScreen.on = true;
    ipc.hold("window.setMiniPlayer").resolve(null);
    await miniPlayer.enter();

    // P twice, faster than the main process moves the window: out, and in again.
    const first = ipc.hold("window.setMiniPlayer");
    void miniPlayer.toggle();
    ipc.hold("window.setMiniPlayer").resolve(null);
    await miniPlayer.toggle();
    first.resolve(null);
    await settle();
    // The window is the mini player, which never fills the screen.
    expect(fullScreen.requests).toBe(0);

    ipc.hold("window.setMiniPlayer").resolve(null);
    const back = miniPlayer.toggle();
    await settle();
    expect(fullScreen.requests).toBe(1);
    ipc.emit("window.fullScreen", true);
    await back;
  });

  it.each([
    { how: "the page has full screen", granted: true },
    { how: "the page has yet to hear of its request", granted: false },
  ])(
    "shrinks a window on its way back into full screen only once it is there: $how",
    async ({ granted }) => {
      const { miniPlayer, closeWatch, openWatch } = app;
      openWatch();
      fullScreen.on = true;
      ipc.hold("window.setMiniPlayer").resolve(null);
      await miniPlayer.enter();

      // Out again: the window is back at its size, and on its way into full screen.
      ipc.hold("window.setMiniPlayer").resolve(null);
      const request = fullScreen.hold("request");
      void miniPlayer.toggle();
      await settle();
      if (granted) request.grant();
      await settle();
      expect(fullScreen.on).toBe(granted);

      // P meanwhile waits. The main process would shrink the window on its way.
      ipc.hold("window.setMiniPlayer").resolve(null);
      const shrunk = miniPlayer.toggle();
      request.grant();
      await settle();
      expect(fullScreen.on).toBe(true);
      expect(asked()).toEqual([{ on: true }, { on: false }]);

      ipc.emit("window.fullScreen", true);
      await shrunk;
      expect(fullScreen.on).toBe(false);
      expect(asked()).toEqual([{ on: true }, { on: false }, { on: true }]);

      ipc.hold("window.setMiniPlayer").resolve(null);
      closeWatch();
      await settle();
    },
  );

  it.each([
    { how: "once the window fills the screen again", says: true, answered: true },
    { how: "after two seconds without the window's word", says: false, answered: true },
    { how: "after two seconds when its request gets no answer", says: false, answered: false },
  ])("is back from a mini player that was full screen $how", async ({ says, answered }) => {
    const { miniPlayer, openWatch } = app;
    openWatch();
    fullScreen.on = true;
    ipc.hold("window.setMiniPlayer").resolve(null);
    await miniPlayer.enter();

    vi.useFakeTimers();
    ipc.hold("window.setMiniPlayer").resolve(null);
    if (!answered) fullScreen.hold("request");
    let back = false;
    void miniPlayer.leave().then(() => (back = true));
    // The page has full screen at once when granted; the window is still on its way there.
    await vi.advanceTimersByTimeAsync(1999);
    expect(fullScreen.requests).toBe(1);
    expect(back).toBe(false);

    if (says) ipc.emit("window.fullScreen", true);
    await vi.advanceTimersByTimeAsync(says ? 0 : 1);
    expect(back).toBe(true);
  });
});
