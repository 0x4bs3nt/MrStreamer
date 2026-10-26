// @vitest-environment happy-dom
// A press on the Position scrubber leaves the keys with the player: Space still pauses and Escape
// still leaves, whether the pointer let go before or after the frame in which the thumb is
// focused, and whether or not the press moved the title. It takes focus from nothing else, and a
// thumb the keyboard reached keeps its focus and its arrow keys. A finger is the same, tapping or
// dragging.
//
// happy-dom lays nothing out and its events are untrusted, so the test says where the scrubber
// is and sends the pointer events to the control that would capture them. A finger's events are
// sent in the order a browser sends them: each pointer event, then its touch event. Focus by Tab
// is `focus()` here. Trusted input, and a real touchscreen, are the native check's.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { runs } from "./title-engine-stand-in.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { TitleWatch } from "../../src/renderer/src/features/titles/TitleWatch.tsx";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

vi.mock(
  "../../src/renderer/src/player/title-engine.ts",
  () => import("./title-engine-stand-in.ts"),
);

/** The scrubber's width here: one pixel a second of the ten-minute movie. */
const WIDTH = 600;

/**
 * Long enough for a frame, in which the thumb is focused, and for the player to follow, on the
 * fake clock every test runs on.
 */
const settle = () => act(() => vi.advanceTimersByTimeAsync(20));

let container: HTMLDivElement;
let unmount = () => {};

/** Opens the ten-minute movie `id` and lets its picture start. */
async function open(id: string): Promise<void> {
  const answer = ipc.hold("playback.openTitle");
  await act(async () => {
    void titlePlayer.open(
      {
        kind: "provider",
        title: { kind: "movie", subscriptionId: SUBSCRIPTION, id },
        name: "Night Harbour",
        detail: null,
        artworkUrl: null,
        originalLanguage: null,
      },
      0,
    );
  });
  answer.resolve({
    sessionId: id,
    title: { kind: "movie", subscriptionId: SUBSCRIPTION, id },
    url: `http://127.0.0.1/title/${id}.mp4`,
    duration: WIDTH,
    audio: [],
    subtitles: [],
  });
  await settle();
  await started();
}

/** Lets the newest run's picture start, as after a skip. */
async function started(): Promise<void> {
  runs.at(-1)!.start();
  await settle();
}

/** Shows the title's view with the movie playing, as the window does once it was opened. */
async function watching(): Promise<void> {
  ipc.reset();
  runs.length = 0;
  await open("1");
  useUi.setState({ playingTitle: true });
  const mounted = queryView(new QueryClient());
  container = mounted.container;
  unmount = mounted.unmount;
  await mounted.render(createElement(TitleWatch));
}

const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const thumb = () => container.querySelector<HTMLInputElement>('input[aria-label="Position"]');

/** The scrubber's control, which takes the pointer, laid out from the window's left edge. */
function control(): HTMLElement {
  const element = thumb()!.parentElement!.parentElement!.parentElement!;
  element.getBoundingClientRect = () => new DOMRect(0, 0, WIDTH, 24);
  return element;
}

const pointer = (
  type: "pointerdown" | "pointermove" | "pointerup",
  second: number,
  pointerType: "mouse" | "touch" = "mouse",
) =>
  control().dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      pointerId: 1,
      pointerType,
      clientX: second,
      clientY: 12,
    }),
  );

/** The touch event a finger at `second` sends after its pointer event, to where it came down. */
const touch = (type: "touchstart" | "touchmove" | "touchend", second: number) =>
  control().dispatchEvent(
    new TouchEvent(type, {
      bubbles: true,
      changedTouches: [
        new Touch({ identifier: 0, target: control(), clientX: second, clientY: 12 }),
      ],
    }),
  );

/** Presses the scrubber at `second` and lets go within the same frame. */
const click = (second: number) =>
  act(async () => {
    pointer("pointerdown", second);
    pointer("pointerup", second);
  });

/** A key pressed wherever focus is, as the keyboard sends it. */
const key = (name: string) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
    );
  });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => titlePlayer.close());
  unmount();
  unmount = () => {};
  container.remove();
  useUi.setState({ playingTitle: false });
  vi.useRealTimers();
});

describe("the title player's keys after a press on the scrubber", () => {
  it("pause, resume and leave after a click let go before the thumb was focused", async () => {
    await watching();
    await click(240);
    await settle();
    await started();
    expect(thumb()!.value).toBe("240");

    await key(" ");
    expect(button("Play")).not.toBeNull();
    await key(" ");
    expect(button("Pause")).not.toBeNull();

    await key("Escape");
    expect(useUi.getState().playingTitle).toBe(false);
    expect(container.textContent).toBe("");
  });

  it("pause after a held press that moved nothing", async () => {
    await watching();
    await act(async () => void pointer("pointerdown", 0));
    await settle();
    await act(async () => void pointer("pointerup", 0));

    await key(" ");
    expect(button("Play")).not.toBeNull();
  });
});

describe("Escape with the subtitles panel open", () => {
  it("closes the panel and keeps the title, and leaves the title the next time", async () => {
    await watching();
    await act(async () => button("Subtitles")!.click());
    await settle();
    expect(container.querySelector('[aria-label="Close subtitles"]')).not.toBeNull();

    // Focus is wherever a pointer left it: the page, not the panel.
    await act(async () => (document.activeElement as HTMLElement | null)?.blur());
    await key("Escape");
    await settle();
    expect(container.querySelector('[aria-label="Close subtitles"]')).toBeNull();
    expect(useUi.getState().playingTitle).toBe(true);

    await key("Escape");
    expect(useUi.getState().playingTitle).toBe(false);
  });
});

describe("the title player's keys after a finger on the scrubber", () => {
  it("pause after a tap let go before the next frame", async () => {
    await watching();
    await act(async () => {
      pointer("pointerdown", 240, "touch");
      touch("touchstart", 240);
      pointer("pointerup", 240, "touch");
      touch("touchend", 240);
    });
    await settle();
    await started();
    expect(thumb()!.value).toBe("240");

    await key(" ");
    expect(button("Play")).not.toBeNull();
  });

  it("pause after a drag, which moved the title to where the finger left", async () => {
    await watching();
    await act(async () => {
      pointer("pointerdown", 100, "touch");
      touch("touchstart", 100);
    });
    await settle();
    await act(async () => {
      pointer("pointermove", 240, "touch");
      touch("touchmove", 240);
      pointer("pointerup", 240, "touch");
      touch("touchend", 240);
    });
    await settle();
    await started();
    expect(thumb()!.value).toBe("240");

    await key(" ");
    expect(button("Play")).not.toBeNull();
  });
});

describe("focus around the scrubber", () => {
  it("stays on a thumb the keyboard reached, whose arrows move the title", async () => {
    await watching();
    await act(async () => thumb()!.focus());
    await key("ArrowRight");
    await key("ArrowRight");
    await settle();

    expect(thumb()!.value).toBe("2");
    expect(document.activeElement).toBe(thumb());
  });

  it("stays where it went during a held press, and on the thumb when Tab comes back", async () => {
    await watching();
    await act(async () => void pointer("pointerdown", 240));
    await settle();
    const pause = button("Pause")!;
    await act(async () => pause.focus());
    await act(async () => void pointer("pointerup", 240));
    expect(document.activeElement).toBe(pause);

    await started();
    await act(async () => thumb()!.focus());
    await settle();
    expect(document.activeElement).toBe(thumb());
  });

  it("stays on the thumb after a click whose scrubber left before it was focused", async () => {
    await watching();
    await click(240);
    // The next movie opens within that frame: no length yet, so no scrubber.
    await open("2");

    await act(async () => thumb()!.focus());
    await settle();
    expect(document.activeElement).toBe(thumb());
  });
});
