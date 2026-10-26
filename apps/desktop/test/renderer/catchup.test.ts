// @vitest-environment happy-dom
// Catch-up in Live TV's rest of the day: the programmes that aired today, where the provider
// keeps them, play from their start in Watch, and choosing the channel again plays it live. A
// recording that plays opens again where it got to, and stops at the programme's end.
import { browseChannels, browseResult } from "./browse-support.ts";
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Programme } from "@mrstreamer/contracts/guide";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { StreamSession } from "@mrstreamer/contracts/playback";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { GuidePage } from "../../src/renderer/src/features/live/GuidePage.tsx";
import { canRetry, failureCopy } from "../../src/renderer/src/features/watch/problems.ts";
import { queries } from "../../src/renderer/src/lib/queries.ts";
import { player } from "../../src/renderer/src/player/player.ts";

const HOUR = 60 * 60 * 1000;
const own = (id: string) => ({ subscriptionId: SUBSCRIPTION, id });

const channel = (id: string, title: string, catchupDays: number | null): LiveChannel => ({
  subscriptionId: SUBSCRIPTION,
  id,
  name: title,
  title,
  tags: [],
  number: Number(id),
  logoUrl: null,
  categoryIds: ["uk"],
  catchupDays,
  variants: [{ id, name: title, tags: [], quality: null, ...(catchupDays ? { catchupDays } : {}) }],
});

// happy-dom lays nothing out, and the list draws only the rows that fit.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.dataset["index"] === undefined ? 900 : 60;
  },
});

let unmount = () => {};
afterEach(() => {
  unmount();
  player.reset();
});

const ready = (check: () => void) =>
  vi.waitFor(
    async () => {
      await act(async () => {});
      check();
    },
    { interval: 10 },
  );

/** Live TV listing `channels`, with the rest of the first one's day open, as `programmes`. */
async function scheduleOf(channels: readonly LiveChannel[], programmes: readonly Programme[]) {
  ipc.reset();
  useUi.setState({ view: "live", list: { kind: "all" }, watching: false, searchOpen: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queries.categories().queryKey, [
    {
      ...own("uk"),
      members: [own("uk")],
      name: "UK | NEWS",
      group: null,
      title: "News",
      channelCount: channels.length,
    },
  ]);
  client.setQueryData(browseChannels(null).queryKey, browseResult(channels));
  client.setQueryData(browseChannels(own("uk")).queryKey, browseResult(channels));
  ipc.always("library.searchGroups", []);
  client.setQueryData(
    ["library", "status"],
    [
      {
        subscriptionId: SUBSCRIPTION,
        channelCount: 1,
        fetchedAt: 1,
        failure: null,
        failedAt: null,
      },
    ],
  );
  client.setQueryData(queries.viewing().queryKey, {
    favourites: [],
    recent: [],
    continueWatching: [],
    marked: [],
    sequence: 1,
  });
  ipc.always("guide.schedule", programmes);
  const view = queryView(client);
  const { container } = view;
  await view.render(createElement(GuidePage, { active: true }));
  unmount = view.unmount;
  await ready(() =>
    expect(container.querySelectorAll("[data-index]"), container.textContent ?? "").toHaveLength(1),
  );
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  const titles = () =>
    [...container.querySelectorAll("[data-index] button")].flatMap(
      (line) => line.querySelector("span + span > span")?.textContent ?? [],
    );
  await ready(() => expect(titles()).toContain("Afternoon"));
  return {
    /** The programmes of the open day, top to bottom. */
    titles,
    /** Clicks the line of the programme called `title`. */
    click: (title: string) =>
      act(async () =>
        [...container.querySelectorAll<HTMLButtonElement>("[data-index] button")]
          .find((line) => line.querySelector("span + span > span")?.textContent === title)
          ?.click(),
      ),
  };
}

const at = (start: number, title: string): Programme => ({
  start,
  stop: start + HOUR,
  title,
  description: null,
});

describe("catch-up in the rest of the day", () => {
  const now = Date.now();
  const day = [
    // Three days ago: beyond the two the channel keeps.
    at(now - 72 * HOUR, "Long ago"),
    at(now - 2.5 * HOUR, "Breakfast"),
    at(now - 1.5 * HOUR, "Lunch"),
    at(now - 0.5 * HOUR, "Afternoon"),
    at(now + 0.5 * HOUR, "Evening"),
  ];

  it("lists what aired that the channel keeps, and plays it from its start in Watch", async () => {
    const een = channel("1", "Één", 2);
    const page = await scheduleOf([een], day);
    expect(page.titles()).toEqual(["Breakfast", "Lunch", "Afternoon", "Evening"]);

    await page.click("Lunch");
    await ready(() => expect(ipc.argsOf("playback.open")).toHaveLength(1));
    expect(ipc.argsOf("playback.open")[0]).toMatchObject({
      channel: own("1"),
      archive: { start: now - 1.5 * HOUR, end: now - 0.5 * HOUR },
    });
    expect(useUi.getState().watching).toBe(true);
    expect(player.state()).toMatchObject({ channel: { id: "1" }, archive: { title: "Lunch" } });

    // Back to Watch on the channel, as from Home's preview, keeps the recording's stream.
    player.watch(een);
    await act(async () => {});
    expect(ipc.argsOf("playback.open")).toHaveLength(1);
    expect(player.state().archive?.title).toBe("Lunch");

    // Choosing the channel plays it live again.
    player.play(een);
    await ready(() => expect(ipc.argsOf("playback.open")).toHaveLength(2));
    expect(ipc.argsOf("playback.open")[1]).not.toHaveProperty("archive");
    expect(player.state().archive).toBeNull();
  });

  it("lists nothing that aired on a channel without catch-up", async () => {
    const page = await scheduleOf([channel("2", "VTM", null)], day);
    expect(page.titles()).toEqual(["Afternoon", "Evening"]);
  });

  it("says how far back catch-up goes when the provider no longer keeps the programme", async () => {
    const een = channel("1", "Één", 2);
    const page = await scheduleOf([een], day);
    ipc.refuse("playback.open", { kind: "catch-up", reason: "outside", days: 2 });
    await page.click("Breakfast");
    await ready(() => expect(player.state().phase.kind).toBe("failed"));
    const phase = player.state().phase;
    if (phase.kind !== "failed") throw new Error("The programme didn't fail.");
    expect(failureCopy(phase, een, { chosen: null, source: null, tried: null })).toEqual({
      title: "Can't open this channel",
      body: "Catch-up on this channel goes back 2 days.",
    });
    // Trying again can't bring it back.
    expect(canRetry(phase.problem)).toBe(false);
    expect(ipc.argsOf("playback.open")).toHaveLength(1);
  });
});

describe("a recording that plays", () => {
  const een = channel("1", "Één", 2);
  // Half a minute past, as a guide can start a programme; the provider's recording starts on the
  // minute before, as Xtream's do.
  const start = Date.UTC(2026, 9, 13, 12, 0, 30);
  const minute = start - 30_000;
  const video = player.element;
  /** What the main process answers for a recording that starts at `from` and ends at `end`. */
  const session = (from: number, end: number): StreamSession => ({
    sessionId: "recording",
    channel: own("1"),
    url: "http://127.0.0.1/recording.m3u8",
    format: "hls",
    archive: { start: from, end },
  });
  /** Plays `programme` and lets its clock run to `seconds`, a fraction of a millisecond in. */
  const playing = async (programme: Programme, seconds: number) => {
    ipc.always("playback.open", session(minute, programme.stop));
    player.playArchive(een, programme);
    await vi.advanceTimersByTimeAsync(0);
    video.currentTime = seconds;
    await vi.advanceTimersByTimeAsync(1000);
    expect(player.state().phase.kind).toBe("playing");
  };

  beforeEach(() => {
    vi.useFakeTimers();
    ipc.reset();
    player.reset();
    video.currentTime = 0;
    player.setAudible(true);
    ipc.always("playback.failure", { kind: "network", detail: "The connection dropped." });
    ipc.always("playback.playing", { variantId: "1", failed: [] });
  });
  afterEach(() => {
    player.reset();
    vi.useRealTimers();
  });

  it("opens again where it got to, in whole milliseconds from where the provider's starts", async () => {
    const lunch = at(start, "Lunch");
    await playing(lunch, 0.876543);
    expect(ipc.argsOf("playback.open")[0]?.archive).toEqual({ start, end: lunch.stop });

    // The stream breaks, and the reconnect asks for the recording from where it got to.
    video.dispatchEvent(new Event("error"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(ipc.argsOf("playback.open")).toHaveLength(2);
    expect(ipc.argsOf("playback.open")[1]?.archive).toEqual({
      start: minute + 877,
      end: lunch.stop,
    });
    video.currentTime = 1.5;
    await vi.advanceTimersByTimeAsync(1000);
    expect(player.state().phase.kind).toBe("playing");

    // So does another quality. The provider's recording started on the minute again, and what
    // played of it since counts from there.
    player.reopen();
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.argsOf("playback.open")[2]?.archive).toEqual({
      start: minute + 623,
      end: lunch.stop,
    });
    expect(player.state().phase.kind).not.toBe("failed");
  });

  it("stops at the programme's end, though the stream plays on, and closes it", async () => {
    // Three seconds of programme.
    const short = { ...at(minute, "Short"), stop: minute + 3000 };
    await playing(short, 0.5);
    for (let second = 1; second <= 6; second++) {
      video.currentTime = 0.5 + second;
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(player.state()).toMatchObject({ phase: { kind: "idle" }, stopped: true });
    expect(player.state().archive?.title).toBe("Short");
    expect(ipc.argsOf("playback.close")).toEqual([{ sessionId: "recording" }]);
    expect(ipc.argsOf("playback.open")).toHaveLength(1);
  });
});
