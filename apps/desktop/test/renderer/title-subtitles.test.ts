// @vitest-environment happy-dom
// CC on a playing movie: the lines due where the picture is show on the layer over it, stacked
// while they overlap, and move at once when G or H shifts them. Off takes the subtitles off and
// keeps them off, though the run that was showing them goes on sending. And a run with subtitles
// asks for the picture at once. Independent text shows while history loads; packets wait for
// ready. Failed history keeps known text unless its file changed, and the loading deadline
// leaves text and its feed active. Loading and unavailable are said, over the picture and in the
// CC panel alike, only while no line the run has is due at the position as G and H time it.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pesReader } from "@mrstreamer/core/subtitles/transport";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubtitleTrack } from "@mrstreamer/contracts/playback";
import { TitleWatch } from "../../src/renderer/src/features/titles/TitleWatch.tsx";
import { nudgeSubtitles } from "../../src/renderer/src/features/watch/SubtitleSettings.tsx";
import { player } from "../../src/renderer/src/player/player.ts";
import { subtitleLayer } from "../../src/renderer/src/player/subtitles.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

const english: SubtitleTrack = {
  id: 3,
  page: null,
  format: "text",
  language: "en",
  label: "English",
  forced: false,
  default: false,
};
const dutch: SubtitleTrack = { ...english, id: 4, language: "nl", label: "Nederlands" };
const teletext: SubtitleTrack = { ...english, format: "teletext", page: 888 };
const transport = pesReader();
const packets = transport.push(
  readFileSync(join(import.meta.dirname, "../fixtures/h264-subtitles.mpegts")),
);
const page = packets.find((packet) => packet.pid === 0x300)!.payload;
const packetLine = `${JSON.stringify({ at: 0, data: Buffer.from(page).toString("base64") })}\n`;

/** A line of the subtitle feed: text from `start` seconds for a minute, or until `end`. */
const line = (start: number, text: string, end = start + 60) =>
  `${JSON.stringify({ at: start, until: end, text })}\n`;

/**
 * Serves runs of the title, with subtitles the test sends while the run plays, until it ends the
 * feed. The feed is ready at once unless the test holds it back.
 */
function serveRuns(ready = true, codec: string | null = null) {
  let send: (text: string) => void = () => {};
  let end = () => {};
  /** The pictures asked for, by their query. */
  const pictures: string[] = [];
  const requests: { readonly subtitles: boolean; readonly signal: AbortSignal | null }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    requests.push({
      subtitles: new URL(url).searchParams.get("only") === "subtitles",
      signal: init?.signal ?? null,
    });
    if (new URL(url).searchParams.get("only") === "subtitles") {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            send = (text) => controller.enqueue(new TextEncoder().encode(text));
            end = () => controller.close();
            if (ready) send('{"ready":true}\n');
          },
        }),
        { headers: codec ? { "x-codec": codec } : {} },
      );
    }
    // The picture never comes, which these tests don't need.
    pictures.push(new URL(url).search);
    return new Response(new ReadableStream());
  });
  return { send: (text: string) => send(text), end: () => end(), pictures, requests };
}

/** Opens the movie at `from` seconds, with the given subtitle tracks to choose. */
async function opened(
  from: number,
  tracks: readonly SubtitleTrack[] = [english, dutch],
): Promise<void> {
  ipc.reset();
  const answer = ipc.hold("playback.openTitle");
  void titlePlayer.open(
    {
      kind: "provider",
      title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "1" },
      name: "Night Harbour",
      detail: null,
      artworkUrl: null,
      originalLanguage: null,
    },
    from,
  );
  answer.resolve({
    sessionId: "s1",
    title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "1" },
    url: "http://127.0.0.1/title/s1.mp4",
    duration: 600,
    audio: [],
    subtitles: tracks,
  });
  await settle();
  // No picture comes here, so nothing moves the element's clock: it is put where the run starts.
  player.element.currentTime = from;
}

/** Puts the picture at `position` seconds, as a skip within what is loaded does. */
function skipTo(position: number): void {
  player.element.currentTime = position;
  player.element.dispatchEvent(new Event("seeked"));
}

/** What the viewer reads over the picture, top to bottom; "" is a place a line left empty. */
function shown(): string[] {
  return [...subtitleLayer.querySelectorAll<HTMLElement>("[data-subtitle-text] > div")]
    .map((row) => (row.style.visibility === "hidden" ? "" : row.textContent))
    .reverse();
}

/** Lets the feed, the player and React catch up, on the fake clock every test runs on. */
const settle = () => vi.advanceTimersByTimeAsync(20);

let unmount = () => {};
let view = document.createElement("div");

/** Shows the playing title's view, and reads the note it shows where a changed speed does. */
async function watching(): Promise<() => string | null> {
  const mounted = queryView(new QueryClient());
  view = mounted.container;
  await mounted.render(createElement(TitleWatch));
  unmount = mounted.unmount;
  return () => view.querySelector('[role="status"]')?.textContent ?? null;
}

/** Opens CC, and reads the chosen track's row: its name and the word beside it. */
async function chosenInPanel(): Promise<string | null> {
  const panel = () => view.querySelector('aside[aria-label="Subtitle choices"]');
  if (!panel()) {
    await act(async () => view.querySelector<HTMLElement>('[aria-label="Subtitles"]')!.click());
  }
  return panel()?.querySelector('[aria-pressed="true"]')?.textContent ?? null;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => titlePlayer.close());
  unmount();
  unmount = () => {};
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("subtitles on a playing movie", () => {
  it("stay off once turned off, while the run goes on", async () => {
    const runs = serveRuns();
    await opened(0);

    titlePlayer.setSubtitle(english);
    await settle();
    runs.send(line(0, "We sail at first light."));
    await settle();
    expect(shown()).toEqual(["We sail at first light."]);

    // Off is instant: the line goes with the click, not with its end.
    titlePlayer.setSubtitle(null);
    expect(shown()).toEqual([]);
    runs.send(line(1, "The tide waits for no one."));
    await settle();
    expect(shown()).toEqual([]);
  });

  it("give way at once to another track", async () => {
    const runs = serveRuns();
    await opened(0);

    titlePlayer.setSubtitle(english);
    await settle();
    runs.send(line(0, "We sail at first light."));
    await settle();
    expect(shown()).toEqual(["We sail at first light."]);

    // The English line doesn't wait on screen for the Dutch run to bring its own.
    titlePlayer.setSubtitle(dutch);
    expect(shown()).toEqual([]);
    await settle();
    runs.send(line(0, "We varen bij het eerste licht."));
    await settle();
    expect(shown()).toEqual(["We varen bij het eerste licht."]);
  });

  it("show the lines due where the picture is, each staying where it first showed", async () => {
    const runs = serveRuns();
    await opened(0);

    titlePlayer.setSubtitle(english);
    await settle();
    runs.send(
      line(10, "Who goes there?", 14) +
        line(12, "Only the night watch.\nAnd the fog.", 16) +
        line(14.5, "Then pass.", 18),
    );
    await settle();
    expect(shown()).toEqual([]);

    skipTo(11);
    expect(shown()).toEqual(["Who goes there?"]);
    // A second speaker joins above the first, on two lines.
    skipTo(13);
    expect(shown()).toEqual(["Only the night watch.\nAnd the fog.", "Who goes there?"]);
    // The first line ends: the second stays where it is being read, over an empty place.
    skipTo(14.2);
    expect(shown()).toEqual(["Only the night watch.\nAnd the fog.", ""]);
    // The third takes that place.
    skipTo(15);
    expect(shown()).toEqual(["Only the night watch.\nAnd the fog.", "Then pass."]);
    skipTo(17);
    expect(shown()).toEqual(["Then pass."]);
    // A line ends at its end time, and a skip back shows what was due then.
    skipTo(18);
    expect(shown()).toEqual([]);
    skipTo(11);
    expect(shown()).toEqual(["Who goes there?"]);
  });

  it("move at once when G or H shifts them", async () => {
    const runs = serveRuns();
    await opened(0);
    const note = await watching();

    await act(async () => titlePlayer.setSubtitle(english));
    await act(settle);
    runs.send(line(10, "Who goes there?", 14));
    await act(settle);
    skipTo(10.05);
    expect(shown()).toEqual(["Who goes there?"]);

    // H: a tenth of a second later, which is after where the picture stands.
    await act(async () => nudgeSubtitles(english, 1));
    expect(shown()).toEqual([]);
    expect(note()).toBe("Subtitles 0.1 s later");
    // G takes it back, and once more: earlier, the line has ended at 13.9 s.
    await act(async () => nudgeSubtitles(english, -1));
    expect(shown()).toEqual(["Who goes there?"]);
    skipTo(13.95);
    expect(shown()).toEqual(["Who goes there?"]);
    await act(async () => nudgeSubtitles(english, -1));
    expect(shown()).toEqual([]);
    expect(note()).toBe("Subtitles 0.1 s earlier");
  });

  it.each([
    {
      kind: "text",
      codec: null,
      track: english,
      sent: line(0, "We sail at first light."),
      expected: ["We sail at first light."],
      // The line on screen is what the file has there: neither the wait nor its end is said.
      notes: [null, null],
    },
    {
      kind: "packets",
      codec: "teletext",
      track: teletext,
      sent: packetLine,
      expected: [],
      notes: ["Subtitles loading", "Subtitles unavailable"],
    },
  ])(
    "ends the loading wait for $kind while preserving its feed policy",
    async ({ codec, track, sent, expected, notes }) => {
      const runs = serveRuns(false, codec);
      await opened(0, [track, dutch]);
      const note = await watching();
      await act(async () => titlePlayer.setSubtitle(track));
      runs.send(sent);
      await act(async () => vi.advanceTimersByTimeAsync(50));
      expect(note()).toBe(notes[0]);
      expect(shown()).toEqual(expected);
      await act(async () => vi.advanceTimersByTimeAsync(35_000));
      expect(note()).toBe(notes[1]);
      expect(shown()).toEqual(expected);
      expect(runs.pictures).toContain("?start=0.000&subtitle=3");
      expect(runs.requests.filter((request) => request.subtitles).at(-1)?.signal?.aborted).toBe(
        codec !== null,
      );
      expect(runs.requests.filter((request) => !request.subtitles).at(-1)?.signal?.aborted).toBe(
        false,
      );
      if (codec === null) {
        runs.send(line(0, "The tide waits for no one."));
        await act(async () => vi.advanceTimersByTimeAsync(50));
        expect(shown()).toEqual(["The tide waits for no one.", "We sail at first light."]);
        runs.send('{"ready":true}\n');
        await act(async () => vi.advanceTimersByTimeAsync(50));
        expect(note()).toBeNull();
      }
    },
  );

  it("holds packet output until ready", async () => {
    const runs = serveRuns(false, "teletext");
    await opened(0, [teletext, dutch]);
    await act(async () => titlePlayer.setSubtitle(teletext));
    await act(settle);
    runs.send(packetLine);
    await act(settle);
    expect(shown()).toEqual([]);
    runs.send('{"ready":true}\n');
    await act(settle);
    expect(shown()).toEqual(["TELETEKST 888"]);
  });

  it.each(["ready", "off"])("cancels the loading deadline once the track is %s", async (state) => {
    const runs = serveRuns(false);
    await opened(0);
    const note = await watching();
    await act(async () => titlePlayer.setSubtitle(english));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    if (state === "ready") {
      runs.send('{"ready":true}\n' + line(0, "We sail at first light."));
      await act(async () => vi.advanceTimersByTimeAsync(50));
    } else {
      await act(async () => titlePlayer.setSubtitle(null));
    }
    await act(async () => vi.advanceTimersByTimeAsync(25_100));
    expect(note()).toBeNull();
    expect(shown()).toEqual(state === "ready" ? ["We sail at first light."] : []);
    expect(runs.requests.filter((request) => request.subtitles).at(-1)?.signal?.aborted).toBe(
      state === "off",
    );
  });

  it("gives a replacement track its own loading deadline", async () => {
    const runs = serveRuns(false);
    await opened(0);
    const note = await watching();
    await act(async () => titlePlayer.setSubtitle(english));
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    await act(async () => titlePlayer.setSubtitle(dutch));
    await act(async () => vi.advanceTimersByTimeAsync(16_000));
    expect(note()).toBe("Subtitles loading");
    const tracks = runs.requests.filter((request) => request.subtitles);
    expect(tracks.at(-2)?.signal?.aborted).toBe(true);
    expect(tracks.at(-1)?.signal?.aborted).toBe(false);
    runs.send('{"ready":true}\n' + line(0, "We varen bij het eerste licht."));
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(note()).toBeNull();
    expect(shown()).toEqual(["We varen bij het eerste licht."]);
  });

  it("load beside the picture, and show what was on screen once the feed has it", async () => {
    const runs = serveRuns(false);
    await opened(137);
    const note = await watching();

    await act(async () => titlePlayer.setSubtitle(english));
    await act(settle);
    // The feed is still finding what the file holds before 137 s: the picture is asked for all
    // the same, and nothing covers the position yet.
    expect(note()).toBe("Subtitles loading");
    expect(await chosenInPanel()).toBe("EnglishLoading");
    // Independent text shows at once while recovery is still loading, and is not called loading.
    runs.send(line(121, "We sail at first light."));
    await act(settle);
    expect(runs.pictures).toContain("?start=137.000&subtitle=3");
    expect(shown()).toEqual(["We sail at first light."]);
    expect(note()).toBeNull();
    expect(await chosenInPanel()).toBe("English");

    // The word that everything before the position is there.
    runs.send('{"ready":true}\n');
    await act(settle);
    expect(shown()).toEqual(["We sail at first light."]);
    expect(note()).toBeNull();
  });

  it.each(["limit", "unreadable", "network", "changed"])(
    "handles %s while text is already showing",
    async (reason) => {
      const runs = serveRuns(false);
      await opened(137);
      const note = await watching();
      await act(async () => titlePlayer.setSubtitle(english));
      await act(settle);
      runs.send(line(137, "The tide waits for no one."));
      await act(settle);
      expect(shown()).toEqual(["The tide waits for no one."]);
      runs.send(`${JSON.stringify({ unavailable: reason })}\n`);
      await act(settle);
      // Only a replaced file takes the line, and with it what stood for the position.
      const changed = reason === "changed";
      expect(shown()).toEqual(changed ? [] : ["The tide waits for no one."]);
      expect(note()).toBe(changed ? "Subtitles unavailable" : null);
      expect(await chosenInPanel()).toBe(changed ? "EnglishUnavailable" : "English");
    },
  );

  it("say loading wherever no line is due while recovery runs, after a skip too", async () => {
    const runs = serveRuns(false);
    await opened(137);
    const note = await watching();
    await act(async () => titlePlayer.setSubtitle(english));
    await act(settle);
    // A line further on: none of it stands for 137 s, where an earlier one may still show.
    runs.send(line(150, "Who goes there?", 154));
    await act(settle);
    expect(shown()).toEqual([]);
    expect(note()).toBe("Subtitles loading");
    await act(async () => skipTo(150));
    expect(shown()).toEqual(["Who goes there?"]);
    expect(note()).toBeNull();
    // After the line nothing shows, and nothing yet says the file has nothing there.
    await act(async () => skipTo(160));
    expect(shown()).toEqual([]);
    expect(note()).toBe("Subtitles loading");
    // Once everything before the start is there, a pause between lines is the file's own.
    runs.send('{"ready":true}\n');
    await act(settle);
    expect(note()).toBeNull();
    await act(async () => skipTo(140));
    expect(note()).toBeNull();
  });

  it("say unavailable once the feed ends and its last line is over", async () => {
    const runs = serveRuns();
    await opened(0);
    const note = await watching();
    await act(async () => titlePlayer.setSubtitle(english));
    await act(settle);
    runs.send(line(0, "We sail at first light.", 4));
    await act(settle);
    await act(async () => runs.end());
    await act(settle);
    // The line still shows: nothing to say yet.
    expect(shown()).toEqual(["We sail at first light."]);
    expect(note()).toBeNull();
    expect(await chosenInPanel()).toBe("English");
    // Past it no more will come.
    await act(async () => skipTo(5));
    expect(shown()).toEqual([]);
    expect(note()).toBe("Subtitles unavailable");
    expect(await chosenInPanel()).toBe("EnglishUnavailable");

    // Enter and Space on the note's cross are the cross's own: neither plays the title again.
    const close = view.querySelector<HTMLButtonElement>('[aria-label="Close message"]')!;
    close.focus();
    const asked = ipc.argsOf("playback.openTitle").length;
    for (const name of ["Enter", " "]) {
      const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
      await act(async () => close.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }
    await act(async () => close.click());
    expect(note()).toBeNull();
    expect(ipc.argsOf("playback.openTitle")).toHaveLength(asked);
  });

  it("follow G and H while paused: a line they bring to the position isn't loading", async () => {
    const runs = serveRuns(false);
    await opened(9.95);
    const note = await watching();
    await act(async () => titlePlayer.setSubtitle(english));
    await act(settle);
    runs.send(line(10, "Who goes there?", 14));
    await act(settle);
    expect(player.element.paused).toBe(true);
    expect(note()).toBe("Subtitles loading");

    // G: earlier, the line is due where the picture stands.
    await act(async () => nudgeSubtitles(english, -1));
    expect(shown()).toEqual(["Who goes there?"]);
    // Once the word on the timing has gone, nothing stands in for it.
    await act(async () => vi.advanceTimersByTimeAsync(1600));
    expect(note()).toBeNull();
    expect(await chosenInPanel()).toBe("English");
    // H takes it away again, and with it what stood for the position.
    await act(async () => nudgeSubtitles(english, 1));
    expect(shown()).toEqual([]);
    await act(async () => vi.advanceTimersByTimeAsync(1600));
    expect(note()).toBe("Subtitles loading");
    expect(await chosenInPanel()).toBe("EnglishLoading");
  });

  it("say unavailable at the end of the wait only where no line covers the picture", async () => {
    const runs = serveRuns(false);
    await opened(0);
    const note = await watching();
    await act(async () => titlePlayer.setSubtitle(english));
    runs.send(line(5, "We sail at first light.", 9));
    await act(async () => vi.advanceTimersByTimeAsync(35_050));
    expect(note()).toBe("Subtitles unavailable");
    expect(await chosenInPanel()).toBe("EnglishUnavailable");
    // The feed goes on after the wait: the line it brought shows, and nothing says otherwise.
    await act(async () => skipTo(5));
    expect(shown()).toEqual(["We sail at first light."]);
    expect(note()).toBeNull();
    expect(await chosenInPanel()).toBe("English");
    // Once it ends, nothing stands for the position again.
    await act(async () => skipTo(9));
    expect(shown()).toEqual([]);
    expect(note()).toBe("Subtitles unavailable");
  });

  it("start a replacement track with nothing to show as loading", async () => {
    const runs = serveRuns(false);
    await opened(0);
    const note = await watching();
    await act(async () => titlePlayer.setSubtitle(english));
    await act(settle);
    runs.send(line(0, "We sail at first light."));
    await act(settle);
    expect(note()).toBeNull();
    // The English line goes with its track; the Dutch one has nothing yet.
    await act(async () => titlePlayer.setSubtitle(dutch));
    await act(settle);
    expect(shown()).toEqual([]);
    expect(note()).toBe("Subtitles loading");
    runs.send(line(0, "We varen bij het eerste licht."));
    await act(settle);
    expect(note()).toBeNull();
  });

  it("say when what was on screen can't be had, and show again from what comes next", async () => {
    const runs = serveRuns(false);
    await opened(137);
    const note = await watching();

    await act(async () => titlePlayer.setSubtitle(english));
    await act(settle);
    // Ready with a line of the file, and then the provider puts another file in its place.
    runs.send(line(121, "We sail at first light."));
    runs.send('{"ready":true}\n');
    await act(settle);
    expect(shown()).toEqual(["We sail at first light."]);
    runs.send('{"unavailable":"changed"}\n');
    await act(settle);
    expect(note()).toBe("Subtitles unavailable");
    expect(shown()).toEqual([]);

    // The next line the run reads stands on its own, and shows once the picture gets there.
    runs.send('{"ready":true,"at":141}\n');
    runs.send(line(141, "The tide waits for no one."));
    await act(settle);
    expect(shown()).toEqual([]);
    skipTo(141);
    expect(shown()).toEqual(["The tide waits for no one."]);

    // Off takes the note with the subtitles.
    await act(async () => titlePlayer.setSubtitle(null));
    expect(note()).toBeNull();
  });
});
