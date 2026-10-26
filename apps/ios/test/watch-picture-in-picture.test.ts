import { createRoot, window } from "./dom.ts";
import { nativePlayer } from "./native-player.ts";
import * as React from "react";
import type { DownloadList } from "@mrstreamer/contracts/downloads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalogue } from "../src/account.ts";
import type { Playing } from "../src/playback.ts";

// Returns from Picture in Picture as Watch answers them, and Watch's Downloads and Settings, which
// keep what plays going. The real Watch layer, top bar routes and playback run with React DOM on
// a happy-dom window, as details-screen.test.ts does. The native VideoView is a stand-in for the
// patched one: every return it asks about carries a number, and Watch's answers reach it later,
// as Expo runs a view's async functions on the main queue. It tells AVKit the answer for the
// number still waiting; another return, Picture in Picture stopping and the view going each tell
// AVKit no for the one waiting. Asked to start Picture in Picture, it starts when the test says
// the iPhone can. The Swift itself is not run here. The star of a channel playing saves to the
// real viewing record, over the files stand-in (native-files.ts), with the channels Live shows
// set by each test.

/** One stand-in VideoView, as the test drives it. */
interface NativeView {
  readonly id: number;
  /** AVKit asks to return to the app; the number the event carried. */
  restore(): number;
  start(): void;
  /** Picture in Picture ended, after a return or closed. */
  stopped(): void;
}
type Answer = { view: number; request: number; restored: boolean };

const native = vi.hoisted(() => ({
  downloads: { items: [], series: {}, bytes: 0, free: null, ended: 0 } as DownloadList,
  made: 0,
  /** The VideoViews on screen, newest last. */
  views: [] as NativeView[],
  /** Watch's answers on their way to the native view. */
  calls: [] as Array<() => void>,
  /** What Watch answered, as it called. */
  sent: [] as Answer[],
  /** What each view told AVKit. */
  told: [] as Answer[],
  /** Whether Watch answered while its restore handler still ran. */
  answeredInHandler: false,
  /** The player's listeners, to fail what plays. */
  port: null as ReturnType<typeof nativePlayer> | null,
  /** Whether the iPhone has Picture in Picture, and whether asking for it starts it. */
  pictureInPicture: { supported: false, starts: true },
  /** Set, the native answer to starting Picture in Picture waits until the test calls it. */
  held: null as (() => void) | null,
  /** What the player was told: "play", "pause" or "replace", in order. */
  player: [] as string[],
  /** Where the top bar's routes went. */
  pushed: [] as string[],
  /** Navigation's state, from the root, and the path on show. */
  root: { index: 0, routes: [] as object[] },
  pathname: "/live",
  /** The channels Live shows. */
  catalogue: { kind: "loading" } as Catalogue,
  /** The system alerts shown, by title and message. */
  alerts: [] as string[][],
  sheets: [] as Array<{
    options: readonly string[];
    message?: string;
    pick: (index: number) => void;
  }>,
}));

vi.mock("../src/downloads.ts", () => ({ useDownloads: () => native.downloads }));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-video", async () => {
  const { Component } = await import("react");
  type Props = {
    onPictureInPictureStart?: () => void;
    onPictureInPictureStop?: () => void;
    onPictureInPictureRestore?: (event: { nativeEvent: { request: number } }) => void;
  };
  class VideoView extends Component<Props> implements NativeView {
    readonly id = ++native.made;
    private requests = 0;
    private waiting: number | null = null;
    override componentDidMount() {
      native.views.push(this);
    }
    override componentWillUnmount() {
      native.views.splice(native.views.indexOf(this), 1);
      this.cancel();
    }
    restore() {
      this.cancel();
      const request = ++this.requests;
      this.waiting = request;
      const before = native.calls.length;
      this.props.onPictureInPictureRestore?.({ nativeEvent: { request } });
      if (native.calls.length > before) native.answeredInHandler = true;
      return request;
    }
    start() {
      this.props.onPictureInPictureStart?.();
    }
    stopped() {
      this.cancel();
      this.props.onPictureInPictureStop?.();
    }
    async finishPictureInPictureRestore(request: number, restored: boolean) {
      native.sent.push({ view: this.id, request, restored });
      native.calls.push(() => {
        if (this.waiting === request) this.tell(restored);
      });
    }
    async startPictureInPicture() {
      if (native.held !== null) await new Promise<void>((answer) => (native.held = answer));
      if (native.pictureInPicture.starts) this.start();
    }
    async stopPictureInPicture() {}
    private cancel() {
      if (this.waiting !== null) this.tell(false);
    }
    private tell(restored: boolean) {
      native.told.push({ view: this.id, request: this.waiting ?? 0, restored });
      this.waiting = null;
    }
    override render() {
      return null;
    }
  }
  return {
    VideoView,
    VideoAirPlayButton: () => null,
    isPictureInPictureSupported: () => native.pictureInPicture.supported,
    createVideoPlayer: () => {
      const port = nativePlayer(() => {
        native.player.push("replace");
      });
      port.duration = 0;
      port.play.mockImplementation(() => {
        native.player.push("play");
      });
      port.pause.mockImplementation(() => {
        native.player.push("pause");
      });
      native.port = port;
      return port;
    },
  };
});
vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
  ActionSheetIOS: {
    showActionSheetWithOptions: (
      options: { options: readonly string[]; message?: string },
      pick: (index: number) => void,
    ) => {
      native.sheets.push({ ...options, pick });
    },
  },
  Alert: { alert: (title: string, message: string) => void native.alerts.push([title, message]) },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("expo-screen-orientation", () => ({
  OrientationLock: { LANDSCAPE: 1 },
  lockAsync: async () => undefined,
  unlockAsync: async () => undefined,
}));
vi.mock("expo-router", () => ({
  router: {
    push: (href: string) => void native.pushed.push(href),
    dismiss: (count: number) => void native.pushed.push(`dismiss ${count}`),
  },
  useRootNavigationState: () => native.root,
  usePathname: () => native.pathname,
}));
vi.mock("../src/glass.tsx", async () => {
  const { createElement } = await import("react");
  type Props = { testID?: string; onPress: () => void };
  return {
    Glass: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
    IconButton: ({ testID, onPress }: Props) =>
      createElement("button", { "data-testid": testID, onClick: onPress }),
  };
});
vi.mock("../src/ui.tsx", () => ({ colors: { text: "#FFFFFF", dim: "#8E8E93" } }));
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("../src/account.ts", () => ({
  useCatalogue: () => native.catalogue,
  currentCatalogue: () => native.catalogue,
  useRoster: () => ({ kind: "ready", members: [] }),
  // The star stars a channel only of a provider still saved.
  members: () => [{ entry: { id: "a" } }],
}));

const { closeWatch, openWatch, play, playbackState, player, retry, stop, togglePause } =
  await import("../src/playback.ts");
const { WatchLayer } = await import("../src/watch.tsx");

const movie = (id: string): Playing => ({
  id,
  subscriptionId: "a",
  title: "A movie",
  place: "",
  live: false,
  next: false,
  versions: false,
});
const open = async () => ({ url: "file:fixture", container: "mp4" });
const inWatch = { watch: true, login: [] } as const;
const { act } = React;

/** The player fails, as AVPlayer reports. */
const failure = () => native.port?.failure();
/** Watch's answers reach the native view, in the order Watch sent them. */
function deliver() {
  while (native.calls.length) native.calls.shift()?.();
}
function shown(): NativeView {
  const view = native.views.at(-1);
  if (!view) throw new Error("No VideoView on screen");
  return view;
}

/** The tabs with Live selected, alone or under Search. */
const tabsOnLive = {
  name: "(tabs)",
  state: { index: 1, routes: [{ name: "(home)" }, { name: "live" }] },
};
const onLive = { index: 0, routes: [tabsOnLive] };
/** No provider saved: Connect, and offline Downloads over it, where copies play. */
const offline = { index: 1, routes: [{ name: "connect" }, { name: "offline" }] };

let unmount = () => {};
beforeEach(() => {
  stop();
  if (native.port) native.port.tracks = null;
  Object.assign(native, {
    views: [],
    calls: [],
    sent: [],
    told: [],
    answeredInHandler: false,
    pictureInPicture: { supported: false, starts: true },
    held: null,
    player: [],
    pushed: [],
    root: onLive,
    pathname: "/live",
    alerts: [],
    sheets: [],
    downloads: { items: [], series: {}, bytes: 0, free: null, ended: 0 },
  });
});
afterEach(() => unmount());

/** Watch plays `item`, then moves it to Picture in Picture as the native view reports. */
async function inPictureInPicture(item: Playing) {
  const root = createRoot(window.document.createElement("div"));
  act(() => root.render(React.createElement(WatchLayer)));
  unmount = () => act(() => root.unmount());
  await act(() =>
    play(
      item,
      item.live
        ? { kind: "live", candidates: [{ variantId: "stream", open: open }], explicit: false }
        : { kind: "file", originalLanguage: null, open: open },
      inWatch,
    ),
  );
  const view = shown();
  act(() => view.start());
  expect(playbackState.get()).toMatchObject({ watch: false, pip: true });
  return view;
}

describe("returning from Picture in Picture", () => {
  it("answers yes once Watch shows what it returned to, and only once", async () => {
    const view = await inPictureInPicture(movie("1"));
    let request = 0;
    act(() => {
      request = view.restore();
    });
    expect(native.answeredInHandler).toBe(false);
    expect(playbackState.get()).toMatchObject({ watch: true, pip: true, muted: false });
    deliver();
    act(() => view.stopped());
    expect(native.told).toEqual([{ view: view.id, request, restored: true }]);
    expect(playbackState.get()).toMatchObject({ watch: true, pip: false });
  });

  it("keeps an answer to a superseded return from completing the newer one", async () => {
    const view = await inPictureInPicture(movie("1"));
    let first = 0;
    let second = 0;
    // Another title plays before Watch answers the first return, so it answers no to that one.
    act(() => {
      first = view.restore();
      void play(movie("2"), { kind: "file", originalLanguage: null, open: open }, inWatch);
    });
    // AVKit asks again before that answer arrives; Watch shows the new title and answers yes.
    act(() => {
      second = view.restore();
    });
    deliver();
    expect(native.sent).toEqual([
      { view: view.id, request: first, restored: false },
      { view: view.id, request: second, restored: true },
    ]);
    expect(native.told).toEqual([
      { view: view.id, request: first, restored: false },
      { view: view.id, request: second, restored: true },
    ]);
  });

  it("answers no once when Stop comes first", async () => {
    const view = await inPictureInPicture(movie("1"));
    let request = 0;
    act(() => {
      request = view.restore();
      stop();
    });
    deliver();
    expect(native.told).toEqual([{ view: view.id, request, restored: false }]);
    expect(playbackState.get()).toMatchObject({ phase: { kind: "idle" }, watch: false });
  });

  // Choosing a title makes a new item, so playing the same title again is another play.
  it("answers no when the same title is chosen again first", async () => {
    const view = await inPictureInPicture(movie("1"));
    let request = 0;
    act(() => {
      request = view.restore();
      stop();
      void play(movie("1"), { kind: "file", originalLanguage: null, open: open }, inWatch);
    });
    deliver();
    expect(native.sent).toEqual([{ view: view.id, request, restored: false }]);
    expect(native.told).toEqual([{ view: view.id, request, restored: false }]);
  });

  // Try again plays the same chosen title in the same Watch, so the return still stands.
  it("answers yes when Try again plays the same title before the answer", async () => {
    const view = await inPictureInPicture(movie("1"));
    let request = 0;
    act(() => {
      request = view.restore();
      failure();
      retry();
    });
    deliver();
    expect(native.told).toEqual([{ view: view.id, request, restored: true }]);
  });

  it("answers the view that asked, not a newer one asking with the same number", async () => {
    const before = await inPictureInPicture(movie("1"));
    let first = 0;
    // The failure takes the view away before Watch's answer arrives.
    act(() => {
      first = before.restore();
      failure();
    });
    await act(async () => retry());
    const after = shown();
    expect(after).not.toBe(before);
    let second = 0;
    act(() => {
      second = after.restore();
    });
    expect(second).toBe(first);
    deliver();
    expect(native.told).toEqual([
      { view: before.id, request: first, restored: false },
      { view: after.id, request: second, restored: true },
    ]);
  });
});

/** Watch shows `item`, playing once `playing` says the player started. */
async function watching(item: Playing, opens = open, { playing = true } = {}) {
  const container = window.document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(React.createElement(WatchLayer)));
  unmount = () => act(() => root.unmount());
  await act(() =>
    play(
      item,
      item.live
        ? { kind: "live", candidates: [{ variantId: "stream", open: opens }], explicit: false }
        : { kind: "file", originalLanguage: null, open: opens },
      inWatch,
    ),
  );
  if (playing) started();
  return {
    /** Draws Watch again, as navigation's state changing does. */
    rerender: () => act(() => root.render(React.createElement(WatchLayer))),
    press: (testID: string) =>
      act(() => {
        const button = container.querySelector(`[data-testid="${testID}"]`) as {
          click(): void;
        } | null;
        if (!button) throw new Error(`No ${testID} in Watch`);
        button.click();
      }),
  };
}
/** The player reports it plays, or stopped playing. */
const started = (isPlaying = true) => act(() => native.port?.state(isPlaying));
const channel = (id: string): Playing => ({ ...movie(id), title: "A channel", live: true });

describe("Downloads and Settings from Watch", () => {
  it("opens Settings on the tab under Watch while Picture in Picture keeps it playing", async () => {
    native.pictureInPicture.supported = true;
    const watch = await watching(movie("1"));
    native.player.length = 0;
    await watch.press("watch-settings");
    expect(native.pushed).toEqual(["/live/settings"]);
    expect(playbackState.get()).toMatchObject({
      phase: { kind: "playing" },
      watch: false,
      pip: true,
      aside: false,
    });
    expect(native.player).toEqual([]);
  });

  it("pauses where Picture in Picture can't take it, and plays on from there on return", async () => {
    const watch = await watching(movie("1"));
    native.player.length = 0;
    await watch.press("watch-downloads");
    started(false);
    expect(native.pushed).toEqual(["/live/downloads"]);
    expect(playbackState.get()).toMatchObject({
      phase: { kind: "paused" },
      watch: false,
      aside: true,
    });
    act(() => openWatch());
    expect(playbackState.get()).toMatchObject({ watch: true, aside: false });
    // The same stream goes on: nothing is opened or replaced.
    expect(native.player).toEqual(["pause", "play"]);
  });

  it("sets Watch aside when Picture in Picture doesn't start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      native.pictureInPicture = { supported: true, starts: false };
      const watch = await watching(movie("1"));
      await watch.press("watch-settings");
      await act(async () => undefined);
      expect(playbackState.get()).toMatchObject({ watch: true, aside: false });
      act(() => vi.advanceTimersByTime(1000));
      expect(playbackState.get()).toMatchObject({ watch: false, aside: true });
      expect(native.player.at(-1)).toBe("pause");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Watch open when the viewer brings it back before the fallback's second", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      native.pictureInPicture.supported = true;
      const watch = await watching(movie("1"));
      await watch.press("watch-settings");
      await act(async () => undefined);
      const view = shown();
      act(() => view.restore());
      deliver();
      act(() => view.stopped());
      act(() => vi.advanceTimersByTime(1000));
      expect(playbackState.get()).toMatchObject({ watch: true, pip: false, aside: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the fallback once Watch closes or another title plays in it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      native.pictureInPicture = { supported: true, starts: false };
      const closed = await watching(movie("1"));
      await closed.press("watch-settings");
      await act(async () => undefined);
      act(() => void closeWatch());
      act(() => vi.advanceTimersByTime(1000));
      expect(playbackState.get()).toMatchObject({ watch: false, aside: false });
      unmount();

      const replaced = await watching(movie("2"));
      await replaced.press("watch-settings");
      await act(async () => undefined);
      await act(() =>
        play(movie("3"), { kind: "file", originalLanguage: null, open: open }, inWatch),
      );
      act(() => vi.advanceTimersByTime(1000));
      expect(playbackState.get()).toMatchObject({ watch: true, aside: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens on Live when Watch came back over Search on Live", async () => {
    native.pictureInPicture.supported = true;
    const watch = await watching(movie("1"));
    const view = shown();
    act(() => view.start());
    native.root = { index: 1, routes: [tabsOnLive, { name: "search" }] };
    native.pathname = "/search";
    act(() => view.restore());
    deliver();
    act(() => view.stopped());
    await watch.press("watch-settings");
    // Search closes first, so Settings goes on Live's own stack (tab-routes.test.ts).
    expect(native.pushed).toEqual(["dismiss 1", "/live/settings"]);
  });

  it("brings a channel back live rather than from where it paused", async () => {
    let opened = 0;
    const opens = async () => {
      opened++;
      return { url: "file:live", container: "m3u8" };
    };
    const watch = await watching(channel("9"), opens);
    await watch.press("watch-settings");
    started(false);
    await act(async () => openWatch());
    expect(opened).toBe(2);
    expect(playbackState.get()).toMatchObject({ phase: { kind: "loading" }, watch: true });
  });

  it("pauses a stream still connecting once it starts, and leaves a paused one paused", async () => {
    const connecting = await watching(movie("1"), open, { playing: false });
    await connecting.press("watch-settings");
    expect(playbackState.get()).toMatchObject({ phase: { kind: "loading" }, aside: true });
    native.player.length = 0;
    started();
    expect(native.player).toEqual(["pause"]);
    unmount();

    const paused = await watching(movie("2"));
    started(false);
    native.player.length = 0;
    await paused.press("watch-settings");
    act(() => openWatch());
    expect(native.player).toEqual([]);
    expect(playbackState.get()).toMatchObject({ phase: { kind: "paused" }, watch: true });
  });

  it("keeps a failure as it is, for the accessory to show and Watch to offer again", async () => {
    const watch = await watching(movie("1"));
    act(() => failure());
    await watch.press("watch-settings");
    expect(playbackState.get()).toMatchObject({ phase: { kind: "failed" }, aside: true });
    act(() => openWatch());
    expect(playbackState.get()).toMatchObject({ phase: { kind: "failed" }, watch: true });
  });
});

describe("Close", () => {
  it("says when the position it saved was refused, with Watch gone and after Stop", async () => {
    const refused = { cause: new Error("/private/var/mobile/viewing.json: disk full") };
    let refuse = true;
    const progress = async () => {
      if (refuse) throw refused.cause;
    };
    const root = createRoot(window.document.createElement("div"));
    act(() => root.render(React.createElement(WatchLayer)));
    unmount = () => act(() => root.unmount());
    await act(() =>
      play(
        movie("1"),
        { kind: "file", originalLanguage: null, open: open },
        { ...inWatch, progress },
      ),
    );
    started();
    Object.assign(player(), { currentTime: 100, duration: 600 });
    await act(async () => void (await closeWatch()));
    const told = ["Couldn't save progress", "Your latest position could not be saved."];
    expect(playbackState.get()).toMatchObject({ watch: false });
    expect(native.alerts).toEqual([told]);
    // The player reports the pause, whose save is refused too: told once for both.
    started(false);
    await act(async () => undefined);
    expect(native.alerts).toEqual([told]);
    // Kept once, then refused at Stop: told again, with nothing playing.
    refuse = false;
    act(() => togglePause());
    started();
    started(false);
    await act(async () => undefined);
    refuse = true;
    await act(async () => void (await stop()));
    expect(playbackState.get()).toMatchObject({ phase: { kind: "idle" } });
    expect(native.alerts).toEqual([told, told]);
    Object.assign(player(), { currentTime: 0, duration: 0 });
  });

  it("pauses what plays and shows the screen under Watch", async () => {
    const watch = await watching(movie("1"));
    native.player.length = 0;
    await watch.press("watch-close");
    expect(native.player).toEqual(["pause"]);
    expect(playbackState.get()).toMatchObject({ phase: { kind: "playing" }, watch: false });
    started(false);
    expect(playbackState.get()).toMatchObject({ phase: { kind: "paused" }, aside: false });
  });
});

describe("Watch with no provider saved", () => {
  beforeEach(() => {
    native.root = offline;
    native.pathname = "/offline";
  });

  it("offers Downloads, the list under it, only for Picture in Picture to take the copy", async () => {
    native.pictureInPicture.supported = true;
    const watch = await watching(movie("copy"));
    expect(() => watch.press("watch-settings")).toThrow("No watch-settings");
    native.player.length = 0;
    await watch.press("watch-downloads");
    expect(native.pushed).toEqual([]);
    expect(playbackState.get()).toMatchObject({ phase: { kind: "playing" }, pip: true });
    expect(native.player).toEqual([]);
  });

  it("opens offline Downloads when Watch is over Connect", async () => {
    native.pictureInPicture.supported = true;
    native.root = { index: 0, routes: [{ name: "connect" }] };
    native.pathname = "/connect";
    const watch = await watching(movie("copy"));
    await watch.press("watch-downloads");
    expect(native.pushed).toEqual(["/offline"]);
  });

  it("keeps Watch, its picture and its controls where nothing could bring it back", async () => {
    const watch = await watching(movie("copy"));
    expect(() => watch.press("watch-downloads")).toThrow("No watch-downloads");
    expect(() => watch.press("watch-settings")).toThrow("No watch-settings");
    expect(playbackState.get()).toMatchObject({ phase: { kind: "playing" }, watch: true });
  });

  it("stays in Watch when Picture in Picture doesn't start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      native.pictureInPicture = { supported: true, starts: false };
      const watch = await watching(movie("copy"));
      native.player.length = 0;
      await watch.press("watch-downloads");
      await act(async () => undefined);
      act(() => vi.advanceTimersByTime(1000));
      expect(playbackState.get()).toMatchObject({ watch: true, aside: false });
      expect(native.player).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Watch's Downloads and Settings, then the viewer's own choices", () => {
  /** A press whose Picture in Picture never starts, then the stream failing and Try again. */
  async function failedThenTriedAgain(watch: Awaited<ReturnType<typeof watching>>) {
    act(() => failure());
    await watch.press("watch-retry");
    await act(async () => undefined);
    started();
    native.player.length = 0;
  }

  it("doesn't set aside Try again's stream for a press before it failed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      native.pictureInPicture = { supported: true, starts: false };
      const watch = await watching(movie("1"));
      await watch.press("watch-settings");
      await act(async () => undefined);
      await failedThenTriedAgain(watch);
      act(() => vi.advanceTimersByTime(1000));
      expect(playbackState.get()).toMatchObject({
        phase: { kind: "playing" },
        watch: true,
        aside: false,
      });
      expect(native.player).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores Picture in Picture's late answer to a press before the failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      native.pictureInPicture = { supported: true, starts: false };
      native.held = () => undefined;
      const watch = await watching(movie("1"));
      await watch.press("watch-settings");
      const answer = native.held;
      await failedThenTriedAgain(watch);
      await act(async () => answer?.());
      act(() => vi.advanceTimersByTime(1000));
      expect(playbackState.get()).toMatchObject({ watch: true, aside: false });
      expect(native.player).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a Pause chosen from the accessory when Watch comes back", async () => {
    const watch = await watching(movie("1"));
    await watch.press("watch-settings");
    started(false);
    // The accessory's Play, then its Pause, as the player reports each.
    act(() => togglePause());
    started();
    act(() => togglePause());
    started(false);
    native.player.length = 0;
    act(() => openWatch());
    expect(playbackState.get()).toMatchObject({ phase: { kind: "paused" }, watch: true });
    expect(native.player).toEqual([]);
  });

  it("doesn't open a channel paused from the accessory again when Watch comes back", async () => {
    let opened = 0;
    const opens = async () => {
      opened++;
      return { url: "file:live", container: "m3u8" };
    };
    const watch = await watching(channel("9"), opens);
    await watch.press("watch-settings");
    started(false);
    act(() => togglePause());
    started();
    act(() => togglePause());
    started(false);
    await act(async () => openWatch());
    expect(opened).toBe(1);
    expect(playbackState.get()).toMatchObject({ phase: { kind: "paused" }, watch: true });
  });
});

describe("Watch set aside when the tabs go", () => {
  /** A downloaded copy: no subscription, so removing the last provider keeps it. */
  const copy = (): Playing => ({ ...movie("copy"), subscriptionId: null });
  /** The last provider removed: the root guard leaves Connect, without the tabs or accessory. */
  const providersGone = () => {
    native.root = { index: 0, routes: [{ name: "connect" }] };
    native.pathname = "/connect";
  };

  it("shows a paused copy in Watch again as it was, opening nothing", async () => {
    const watch = await watching(copy());
    await watch.press("watch-settings");
    started(false);
    native.player.length = 0;
    providersGone();
    watch.rerender();
    expect(playbackState.get()).toMatchObject({
      phase: { kind: "paused" },
      watch: true,
      aside: false,
    });
    expect(native.player).toEqual([]);
  });

  it("shows a copy played again from the accessory in Watch, still playing", async () => {
    const watch = await watching(copy());
    await watch.press("watch-settings");
    started(false);
    act(() => togglePause());
    started();
    native.player.length = 0;
    providersGone();
    watch.rerender();
    expect(playbackState.get()).toMatchObject({ phase: { kind: "playing" }, watch: true });
    expect(native.player).toEqual([]);
  });

  it("brings back nothing the removed provider streamed, which its removal stopped", async () => {
    const watch = await watching(movie("1"));
    await watch.press("watch-settings");
    act(() => void stop());
    providersGone();
    watch.rerender();
    expect(playbackState.get()).toMatchObject({ phase: { kind: "idle" }, watch: false });
  });

  it("drops a fallback waiting for Picture in Picture once the tabs go", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      native.pictureInPicture = { supported: true, starts: false };
      const watch = await watching(copy());
      await watch.press("watch-settings");
      await act(async () => undefined);
      providersGone();
      watch.rerender();
      act(() => vi.advanceTimersByTime(1000));
      expect(playbackState.get()).toMatchObject({ watch: true, aside: false });
      expect(native.player.at(-1)).not.toBe("pause");
    } finally {
      vi.useRealTimers();
    }
  });
});

const { buildLibrary } = await import("../src/library.ts");
const viewing = await import("../src/viewing.ts");

describe("the star of the channel playing", () => {
  const library = buildLibrary([
    {
      subscriptionId: "a",
      label: "Home",
      catalogue: {
        categories: [{ id: "1", name: "NL | News" }],
        channels: [
          {
            id: "9",
            name: "NL | Nieuws HD",
            number: null,
            logoUrl: null,
            categoryIds: ["1"],
            guideId: null,
            catchupDays: null,
          },
        ],
      },
    },
  ]);
  const [listed] = library.channels;
  if (!listed) throw new Error("No channel listed");
  const live: Playing = { ...channel(listed.id), id: listed.key };
  const saved = () => (viewing.currentViewing()?.favourites ?? []).map((each) => each.id);
  /** Resolves once the record shows `ids` as the favourites. */
  async function shows(ids: readonly string[]) {
    for (let waited = 0; JSON.stringify(saved()) !== JSON.stringify(ids); waited += 10) {
      if (waited > 4_000) throw new Error(`The favourites stayed ${JSON.stringify(saved())}`);
      await act(() => new Promise((done) => setTimeout(done, 10)));
    }
  }

  beforeEach(async () => {
    native.catalogue = { kind: "ready", library, failing: [] };
    viewing.setViewingOwners(["a"]);
    viewing.setViewingChannels(library.byKey);
    await viewing.eraseViewing("a");
  });

  it("stars and unstars it while it plays on, untouched", async () => {
    const watch = await watching(live);
    native.player.length = 0;
    await watch.press("watch-favourite");
    await shows(["9"]);
    await watch.press("watch-favourite");
    await shows([]);
    expect(native.player).toEqual([]);
    expect(playbackState.get()).toMatchObject({
      phase: { kind: "playing", item: live },
      watch: true,
      pip: false,
    });
  });

  it("isn't there for a movie, or a channel Live no longer shows", async () => {
    const film = await watching(movie("1"));
    expect(() => film.press("watch-favourite")).toThrow("No watch-favourite");
    unmount();
    native.catalogue = { kind: "loading" };
    const gone = await watching(live);
    expect(() => gone.press("watch-favourite")).toThrow("No watch-favourite");
  });
});

describe("Watch's asynchronous track menus", () => {
  it("queries native facts on opening and hands back the exact record", async () => {
    const watch = await watching(movie("1"));
    const port = native.port!;
    const track = {
      ...port.identity(),
      id: "0",
      revision: 1,
      group: "audio" as const,
      isPlayable: true,
      isDefault: true,
      label: "Native display name",
    };
    port.tracks = {
      ...port.identity(),
      revision: 1,
      audio: { state: "ready", options: [track] },
      subtitles: { state: "ready", options: [] },
      subtitleOffAllowed: true,
      selectedAudioId: "0",
      selectedSubtitleId: null,
    };
    port.getObservedTracksAsync.mockClear();
    port.selectObservedTrackAsync.mockClear();
    await watch.press("watch-audio");
    await act(async () => undefined);
    expect(port.getObservedTracksAsync).toHaveBeenCalledOnce();
    expect(native.sheets[0]?.options).toEqual(["✓ Native display name", "Cancel"]);
    native.sheets[0]?.pick(0);
    await act(async () => undefined);
    expect(port.selectObservedTrackAsync.mock.calls[0]?.[2].track).toBe(track);
  });

  it.each(["close", "navigation", "replacement"] as const)(
    "does not show an asynchronously opened sheet after %s",
    async (change) => {
      const watch = await watching(movie("1"));
      const port = native.port!;
      let resolve!: (snapshot: { kind: "stale" }) => void;
      port.getObservedTracksAsync.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      await watch.press("watch-audio");
      await act(async () => undefined);
      await act(async () => {
        if (change === "close") {
          await closeWatch();
          openWatch();
        } else if (change === "navigation")
          (await import("../src/playback.ts")).onScreen("/settings");
        else await play(movie("2"), { kind: "file", originalLanguage: null, open: open }, inWatch);
        resolve({ kind: "stale" });
      });
      expect(native.sheets).toEqual([]);
    },
  );

  it("refuses a held sheet choice after Close and another item", async () => {
    const watch = await watching(movie("1"));
    const port = native.port!;
    port.selectObservedTrackAsync.mockClear();
    await watch.press("watch-subtitles");
    await act(async () => undefined);
    expect(native.sheets[0]?.options).toEqual(["✓ Off", "Cancel"]);
    await act(async () => {
      await closeWatch();
      await play(movie("2"), { kind: "file", originalLanguage: null, open: open }, inWatch);
    });
    native.sheets[0]?.pick(0);
    await act(async () => undefined);
    expect(port.selectObservedTrackAsync).not.toHaveBeenCalled();
  });
});

it("does not describe a real lone subtitle as missing when Off is forbidden", async () => {
  const watch = await watching(movie("subtitle"));
  const port = native.port!;
  const track = {
    ...port.identity(),
    id: "0",
    revision: 1,
    group: "subtitles" as const,
    isPlayable: true,
    isDefault: true,
    forcedOnly: false,
    label: "Off",
  };
  port.tracks = {
    ...port.identity(),
    revision: 1,
    audio: { state: "ready", options: [] },
    subtitles: { state: "ready", options: [track] },
    subtitleOffAllowed: false,
    selectedAudioId: null,
    selectedSubtitleId: "0",
  };
  await watch.press("watch-subtitles");
  await act(async () => undefined);
  expect(native.sheets[0]?.options).toEqual(["✓ Off", "Cancel"]);
  expect(native.sheets[0]?.message).toBeUndefined();
});
