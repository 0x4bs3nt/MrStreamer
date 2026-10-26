// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { browseResult } from "./browse-support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement, useState, type ComponentProps } from "react";
import { bareView, queryView } from "./mount.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { SubtitleFormat, SubtitleTrack } from "@mrstreamer/contracts/playback";
import { LiveMore, type LiveMenu } from "../../src/renderer/src/features/watch/LiveMore.tsx";
import { TrackMenus } from "../../src/renderer/src/features/watch/TrackMenus.tsx";
import { setSubtitleDelay, subtitleDelay } from "../../src/renderer/src/player/subtitles.ts";

import { closeWatch, openWatch, useUi } from "../../src/renderer/src/app/ui-store.ts";
import { player } from "../../src/renderer/src/player/player.ts";
import { WatchScreen } from "../../src/renderer/src/features/watch/WatchScreen.tsx";

let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  act(() => {
    closeWatch();
    player.reset();
  });
  vi.restoreAllMocks();
  vi.useRealTimers();
});
/**
 * Moves the fake clock on 30 ms, past the player's short timers and the animation frame in which
 * a menu takes focus. Called after the act that rendered, so that frame is already asked for.
 */
const settle = () => act(() => vi.advanceTimersByTimeAsync(30));
const channel: LiveChannel = {
  subscriptionId: SUBSCRIPTION,
  id: "one",
  name: "One",
  title: "One",
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  catchupDays: null,
  variants: [{ id: "one", name: "One", tags: [], quality: null }],
};

it("keeps mouse actions, page focus and discovery tied to More as tracks and outputs change", async () => {
  ipc.reset();
  const calls: (number | string)[] = [];
  let removeSound = () => {};
  function Controls() {
    const [menu, setMenu] = useState<LiveMenu>(null);
    const [soundAvailable, setSoundAvailable] = useState(true);
    removeSound = () => setSoundAvailable(false);
    const sound: ComponentProps<typeof LiveMore>["sound"] = soundAvailable
      ? {
          audio: [
            { id: 1, label: "English", language: "en", default: true },
            { id: 2, label: "Dutch", language: "nl", default: false },
          ],
          audioId: 2,
          onAudio: (id) => calls.push(id),
          onDone: () => setMenu(null),
        }
      : null;
    return createElement(LiveMore, {
      menu,
      onMenu: setMenu,
      previous: channel,
      onSwitch: (direction) => calls.push(direction),
      onPrevious: () => calls.push("previous"),
      sound,
      quality: null,
    });
  }
  const mounted = bareView();
  unmount = mounted.unmount;
  await mounted.render(createElement(Controls));
  await settle();
  function button(name: string) {
    const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (each) => each.getAttribute("aria-label") === name || each.textContent === name,
    );
    if (!found) throw new Error(`Missing ${name}`);
    return found;
  }
  async function click(name: string) {
    await act(async () => {
      button(name).dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    await settle();
  }
  async function key(name: string) {
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
      );
    });
    await settle();
  }
  await click("More");
  expect(button("Channel up").hasAttribute("aria-pressed")).toBe(false);
  expect(button("Channel up").textContent).toContain("Up");
  expect(button("Back to One").hasAttribute("aria-pressed")).toBe(false);
  expect(document.querySelector('[role="separator"]')).not.toBeNull();
  expect(button("Sound").getAttribute("aria-description")).toBe("Dutch");
  // The subtitles' timing and look are under CC, so More has no page for them.
  expect(document.body.textContent).not.toContain("Playback");
  await click("Channel up");
  expect(calls).toEqual([-1]);
  expect(button("More").getAttribute("aria-expanded")).toBe("false");
  await click("More");
  await click("Back to One");
  expect(calls).toEqual([-1, "previous"]);
  await click("More");
  await click("Sound");
  await click("English");
  expect(calls).toEqual([-1, "previous", 1]);
  expect(button("More").getAttribute("aria-expanded")).toBe("false");

  await click("More");
  button("Sound").focus();
  await key("ArrowRight");
  expect(document.activeElement?.textContent).toBe("Dutch");
  await key("Backspace");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Sound");
  await key("Enter");
  expect(document.activeElement?.textContent).toBe("Dutch");
  await act(async () => {
    removeSound();
  });
  await settle();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Channel up");
  expect(document.body.textContent).not.toContain("Dutch");
  await key("Escape");
  expect(button("More").getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(button("More"));

  const local = {
    offers: ["cast" as const],
    airplayRoutes: false,
    receivers: [],
    scanning: false,
    output: { kind: "local" as const },
  };
  await act(async () => {
    ipc.emit("output.changed", local);
  });
  await settle();
  await click("More");
  await click("Play on");
  expect(ipc.argsOf("output.scan")).toEqual([{ on: true }]);
  // A receiver refresh does not restart discovery or close the page.
  await act(async () => {
    ipc.emit("output.changed", { ...local, offers: ["cast"], scanning: true });
  });
  await settle();
  expect(ipc.argsOf("output.scan")).toEqual([{ on: true }]);
  await click("Back to More");
  expect(ipc.argsOf("output.scan")).toEqual([{ on: true }, { on: false }]);
  await click("Play on");
  await act(async () => {
    ipc.emit("output.changed", { ...local, offers: [] });
  });
  await settle();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Channel up");
  expect(ipc.argsOf("output.scan").at(-1)).toEqual({ on: false });
});

const qualityChannel: LiveChannel = {
  ...channel,
  variants: [
    { id: "one", name: "One FHD", tags: ["FHD"], quality: "fhd" },
    { id: "one-hd", name: "One HD", tags: ["HD"], quality: "hd" },
  ],
};
const nextChannel: LiveChannel = {
  ...channel,
  id: "two",
  name: "Two",
  title: "Two",
  variants: [{ ...channel.variants[0]!, id: "two" }],
};
const cast = {
  offers: ["cast" as const],
  airplayRoutes: false,
  receivers: [],
  scanning: false,
  output: { kind: "local" as const },
};

async function watch() {
  ipc.reset();
  ipc.always("library.browse", browseResult([qualityChannel, nextChannel]));
  const mounted = queryView(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  unmount = mounted.unmount;
  await act(async () => {
    ipc.emit("output.changed", cast);
    openWatch();
    player.play(qualityChannel);
  });
  await mounted.render(createElement(WatchScreen));
  await settle();
  return mounted.container;
}

function named(name: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (each) => each.getAttribute("aria-label") === name || each.textContent === name,
  );
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}
async function pressKey(key: string) {
  await act(async () => {
    const target = document.activeElement ?? window;
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    // happy-dom does not perform a button's native Enter activation.
    if (key === "Enter" && !event.defaultPrevented && target instanceof HTMLButtonElement)
      target.click();
  });
  await settle();
}

it("Q and O open on usable choices, support immediate Back keys and dismiss on a channel change", async () => {
  await watch();
  await pressKey("q");
  expect(document.activeElement?.textContent).toContain("Automatic");
  expect(document.activeElement?.getAttribute("aria-pressed")).toBe("true");
  await pressKey("Backspace");
  expect(document.activeElement).toBe(named("Quality"));
  expect(named("Quality").textContent).toContain("Q");
  expect(ipc.argsOf("subscription.updatePreferences")).toEqual([]);
  await pressKey("Escape");
  expect(document.activeElement).toBe(named("More"));
  await pressKey("q");
  await pressKey("ArrowDown");
  expect(document.activeElement?.textContent).toBe("Full HD");
  await pressKey("Enter");
  expect(ipc.argsOf("subscription.updatePreferences")).toEqual([
    { subscriptionId: SUBSCRIPTION, patch: { channelVariants: { one: "one" } } },
  ]);
  expect(named("More").getAttribute("aria-expanded")).toBe("false");

  await pressKey("o");
  expect(document.activeElement?.textContent).toBe("This computer");
  await pressKey("ArrowLeft");
  expect(document.activeElement).toBe(named("Play on"));
  expect(named("Play on").textContent).toContain("This computer");
  expect(named("Play on").textContent).toContain("O");
  await pressKey("Escape");
  await pressKey("o");
  await pressKey("Backspace");
  expect(document.activeElement).toBe(named("Play on"));
  await pressKey("Escape");
  expect(ipc.argsOf("output.scan")).toEqual([
    { on: true },
    { on: false },
    { on: true },
    { on: false },
  ]);

  await act(async () => {
    named("More").click();
  });
  await settle();
  expect(named("More").getAttribute("aria-expanded")).toBe("true");
  await act(async () => {
    player.play(nextChannel);
  });
  await settle();
  expect(named("More").getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("More keeps the active receiver visible and labels its Play on destination", async () => {
  await watch();
  const receiver = { id: "tv", kind: "cast" as const, name: "Living Room TV" };
  await act(async () => {
    ipc.emit("output.changed", {
      ...cast,
      receivers: [receiver],
      output: { kind: "receiver", receiver, volume: null, media: null, failure: null },
    });
  });
  await settle();
  expect(named("More").getAttribute("aria-pressed")).toBe("true");
  expect(named("More").getAttribute("aria-description")).toBe("Playing on Living Room TV");
  await act(async () => {
    named("More").click();
  });
  await settle();
  expect(named("Play on").textContent).toContain("Living Room TV");
  expect(named("Play on").getAttribute("aria-description")).toBe("Living Room TV");
  expect(named("Play on").hasAttribute("aria-pressed")).toBe(false);
});

it("wheel over the Live picture zaps once per gesture and leaves menu, list, dialog and typing input alone", async () => {
  const container = await watch();
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const picture = () => container.querySelector("video")?.parentElement;
  const roll = async (deltaY: number, target = picture(), deltaX = 0) => {
    await act(async () => {
      target?.dispatchEvent(
        new WheelEvent("wheel", { deltaY, deltaX, bubbles: true, cancelable: true }),
      );
    });
    await settle();
  };
  const initial = ipc.argsOf("playback.open").length;
  await roll(10);
  expect(ipc.argsOf("playback.open")).toHaveLength(initial);
  await roll(70);
  await act(() => vi.advanceTimersByTimeAsync(400));
  expect(ipc.argsOf("playback.open").at(-1)?.channel.id).toBe("two");
  const once = ipc.argsOf("playback.open").length;
  for (let i = 0; i < 8; i++) {
    now += 100;
    await roll(120);
  }
  expect(ipc.argsOf("playback.open")).toHaveLength(once);
  now += 800;
  await roll(-120);
  await act(() => vi.advanceTimersByTimeAsync(400));
  expect(ipc.argsOf("playback.open").at(-1)?.channel.id).toBe("one");
  const twice = ipc.argsOf("playback.open").length;
  await act(async () => {
    named("More").click();
  });
  await settle();
  now += 800;
  await roll(120);
  expect(ipc.argsOf("playback.open")).toHaveLength(twice);
  await pressKey("Escape");
  await pressKey("Enter");
  now += 800;
  await roll(120);
  expect(useUi.getState().channelsOpen).toBe(true);
  expect(ipc.argsOf("playback.open")).toHaveLength(twice);
  await pressKey("Escape");
  await act(() => useUi.setState({ settings: "subscriptions" }));
  now += 800;
  await roll(120);
  expect(ipc.argsOf("playback.open")).toHaveLength(twice);
  await act(() => useUi.setState({ settings: null }));
  const input = document.createElement("input");
  container.append(input);
  input.focus();
  now += 800;
  await roll(120);
  expect(ipc.argsOf("playback.open")).toHaveLength(twice);
  input.remove();
  now += 800;
  await roll(120, named("More"));
  await roll(120, picture(), 200);
  expect(ipc.argsOf("playback.open")).toHaveLength(twice);
});

it("a pointer Quality open on a failed channel starts Down on the chosen quality and supports Back", async () => {
  await watch();
  await act(async () => {
    ipc.always("playback.open", {
      sessionId: "pointer-quality",
      channel: { subscriptionId: SUBSCRIPTION, id: "one" },
      url: "http://127.0.0.1/stream/one",
      format: "hls",
    });
    ipc.always("playback.failure", { kind: "unsupported", detail: "Unsupported fixture" });
    ipc.always("playback.playing", null);
    player.retry();
  });
  await settle();
  await act(async () => {
    player.element.dispatchEvent(new Event("error"));
  });
  await settle();
  await act(async () => {
    named("Quality").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
  await settle();
  expect(document.activeElement?.getAttribute("role")).toBe("dialog");
  expect(document.activeElement?.getAttribute("aria-pressed")).toBeNull();
  await pressKey("ArrowDown");
  expect(document.activeElement?.textContent).toContain("Automatic");
  expect(document.activeElement?.getAttribute("aria-pressed")).toBe("true");
  await pressKey("ArrowDown");
  expect(document.activeElement?.textContent).toBe("Full HD");
  await pressKey("Backspace");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Quality");
  expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
});

it("sets a channel's subtitle timing and look under CC, and lists them greyed while a TV plays", async () => {
  ipc.reset();
  const teletext: SubtitleTrack = {
    id: 1,
    page: 888,
    format: "text",
    language: "nl",
    label: "Nederlands · Teletext",
    forced: false,
    default: false,
  };
  const pictures: SubtitleTrack = {
    ...teletext,
    id: 2,
    page: null,
    format: "picture",
    label: "DVB",
  };
  let show = (_subtitle: SubtitleTrack | null, _shows?: readonly SubtitleFormat[] | null) => {};
  function Controls() {
    const [open, setOpen] = useState<LiveMenu>(null);
    const [subtitle, setSubtitle] = useState<SubtitleTrack | null>(null);
    const [shows, setShows] = useState<readonly SubtitleFormat[] | null>(null);
    show = (next, receiver = null) => {
      setSubtitle(next);
      setShows(receiver);
    };
    return createElement(TrackMenus, {
      showSound: false,
      audio: [],
      audioId: null,
      subtitles: [teletext, pictures],
      subtitle,
      shows,
      open: open === "subtitles" ? open : null,
      onOpenChange: setOpen,
      onAudio: () => {},
      onSubtitle: setSubtitle,
    });
  }
  const mounted = bareView();
  unmount = () => {
    mounted.unmount();
    setSubtitleDelay(player.element, 0);
  };
  await mounted.render(createElement(Controls));
  await settle();
  const named = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (each) => each.getAttribute("aria-label") === name || each.textContent === name,
    );
  const click = async (name: string) => {
    await act(async () => {
      named(name)!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    await settle();
  };

  // Off: nothing to time, and the look of what the channel could show.
  await click("Subtitles");
  expect(named("Later")).toBeUndefined();
  await click("Large");
  expect(ipc.argsOf("preferences.update").at(-1)?.subtitleLook?.size).toBe("large");
  expect(named("Large")?.getAttribute("aria-checked")).toBe("true");
  await click("Higher");
  expect(ipc.argsOf("preferences.update").at(-1)?.subtitleLook?.position).toBe("high");
  // Changing a setting leaves the menu open and the choice of track alone.
  expect(named("Off")?.getAttribute("aria-pressed")).toBe("true");
  await click("Medium");
  await click("Low");

  // Text on: a tenth earlier or later, and back.
  await act(async () => show(teletext));
  expect(named("Reset")?.disabled).toBe(true);
  await click("Later");
  await click("Later");
  expect(subtitleDelay()).toBe(0.2);
  expect(document.body.textContent).toContain("+0.2 s");
  await click("Earlier");
  expect(subtitleDelay()).toBe(0.1);
  await click("Reset");
  expect(subtitleDelay()).toBe(0);
  expect(named("Background")).toBeUndefined();
  expect(named("Shadow")).toBeDefined();

  // Pictures have no timing and no background.
  await act(async () => show(pictures));
  expect(named("Later")).toBeUndefined();
  expect(named("Shadow")).toBeUndefined();
  expect(named("Small")).toBeDefined();

  // A TV plays: the settings are this computer's, listed and not set.
  await act(async () => show(null, []));
  expect(named("Later")).toBeUndefined();
  expect(named("Small")).toBeUndefined();
  expect(named("Subtitle timing")?.disabled).toBe(true);
  expect(named("Subtitle look")?.disabled).toBe(true);
  expect(document.body.textContent).toContain("The subtitle settings apply on this computer only.");
});
