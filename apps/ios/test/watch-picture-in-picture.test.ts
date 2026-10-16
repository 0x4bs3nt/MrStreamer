import * as React from "react";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Playing } from "../src/playback.ts";

// Returns from Picture in Picture as Watch answers them. The real Watch layer and playback run
// with React DOM on a happy-dom window, as details-screen.test.ts does. The native VideoView is a
// stand-in for the patched one: every return it asks about carries a number, and Watch's answers
// reach it later, as Expo runs a view's async functions on the main queue. It tells AVKit the
// answer for the number still waiting; another return, Picture in Picture stopping and the view
// going each tell AVKit no for the one waiting. The Swift itself is not run here.

const REACT_DOM = "react-dom/client";
const window = new Window();
Object.assign(globalThis, { window, document: window.document });
type Root = { render(node: unknown): void; unmount(): void };
const { createRoot } = (await import(REACT_DOM)) as { createRoot(container: object): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  listeners: new Map<string, (event: object) => void>(),
}));

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
    async startPictureInPicture() {}
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
    isPictureInPictureSupported: () => false,
    createVideoPlayer: () => ({
      muted: true,
      timeUpdateEventInterval: 0,
      currentTime: 0,
      duration: 0,
      addListener: (name: string, listener: (event: object) => void) =>
        native.listeners.set(name, listener),
      replaceAsync: async () => undefined,
      play: () => undefined,
      pause: () => undefined,
    }),
  };
});
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  type Props = { children?: React.ReactNode; testID?: string; onPress?: () => void };
  const box = ({ children, testID }: Props) =>
    createElement("div", { "data-testid": testID }, children);
  return {
    View: box,
    Text: ({ children }: Props) => createElement("span", null, children),
    Pressable: ({ children, testID, onPress }: Props) =>
      createElement("button", { "data-testid": testID, onClick: onPress }, children),
    StatusBar: () => null,
    StyleSheet: { create: <T>(styles: T) => styles, absoluteFill: {} },
    Keyboard: { dismiss: () => undefined },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    ActionSheetIOS: { showActionSheetWithOptions: () => undefined },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("expo-screen-orientation", () => ({
  OrientationLock: { LANDSCAPE: 1 },
  lockAsync: async () => undefined,
  unlockAsync: async () => undefined,
}));
vi.mock("../src/glass.tsx", async () => {
  const { createElement } = await import("react");
  return {
    Glass: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
    IconButton: () => null,
  };
});
vi.mock("../src/ui.tsx", () => ({ colors: { text: "#FFFFFF", dim: "#8E8E93" } }));

const { play, playbackState, retry, stop } = await import("../src/playback.ts");
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
const open = async () => ({ url: "file:fixture", hls: false });
const inWatch = { watch: true, login: [] } as const;
const { act } = React;

/** The player fails, as AVPlayer reports. */
const failure = () => native.listeners.get("statusChange")?.({ status: "error" });
/** Watch's answers reach the native view, in the order Watch sent them. */
function deliver() {
  while (native.calls.length) native.calls.shift()?.();
}
function shown(): NativeView {
  const view = native.views.at(-1);
  if (!view) throw new Error("No VideoView on screen");
  return view;
}

let unmount = () => {};
beforeEach(() => {
  stop();
  Object.assign(native, { views: [], calls: [], sent: [], told: [], answeredInHandler: false });
});
afterEach(() => unmount());

/** Watch plays `item`, then moves it to Picture in Picture as the native view reports. */
async function inPictureInPicture(item: Playing) {
  const root = createRoot(window.document.createElement("div"));
  act(() => root.render(React.createElement(WatchLayer)));
  unmount = () => act(() => root.unmount());
  await act(() => play(item, open, inWatch));
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
      void play(movie("2"), open, inWatch);
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
      void play(movie("1"), open, inWatch);
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
