// @vitest-environment happy-dom
// At the end of a downloaded episode, the copy of the very next episode of its series plays after
// the saved delay, as online: cancellable, held while Settings is open, off when autoplay is off,
// and at once with Next. It opens only once main kept this copy's progress and main's list, read
// again, still has it on this computer: a save main refused keeps this copy, says so and leaves
// Next to try again. A next episode with no copy, one still downloading and the series' last
// episode say so instead; a copy queued before series were kept ends as before. None of it asks a
// provider, the viewing record or a receiver.
import { ipc } from "./support.ts";
import { runs } from "./title-engine-stand-in.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CopySession, Download, DownloadList } from "@mrstreamer/contracts/downloads";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { TitleWatch } from "../../src/renderer/src/features/titles/TitleWatch.tsx";
import { useFlash } from "../../src/renderer/src/features/watch/flash-state.ts";
import { watchOffline } from "../../src/renderer/src/lib/downloads.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

vi.mock(
  "../../src/renderer/src/player/title-engine.ts",
  () => import("./title-engine-stand-in.ts"),
);

/** A downloaded episode of the Dutch "Harbour Lights", complete unless `over` says otherwise. */
function copy(id: string, season: number, number: number, over: Partial<Download> = {}): Download {
  return {
    id,
    title: { kind: "episode", id: `file-${id}`, seriesId: "nl", season, episode: number },
    subscription: null,
    name: "Harbour Lights",
    episodeName: `Part ${number}`,
    year: 2024,
    duration: 2700,
    originalLanguage: "en",
    posterUrl: null,
    wideUrl: null,
    size: 1_000_000,
    status: { kind: "complete" },
    progress: null,
    series: "harbour",
    ...over,
  };
}

const pilot = copy("pilot", 1, 2);
const tide = copy("tide", 1, 3, { episodeName: "Low Tide" });
const water = copy("water", 2, 1, { episodeName: "Open Water" });

/** Main's list with `items`, of which the series lists two seasons of three episodes. */
const listOf = (...items: Download[]): DownloadList => ({
  items,
  series: {
    harbour: {
      seasons: [
        { number: 1, episodes: [1, 2, 3] },
        { number: 2, episodes: [1, 2, 3] },
      ],
      sourceOrder: false,
    },
  },
  bytes: 0,
  free: null,
  ended: 0,
});

let container: HTMLDivElement;
let unmount = () => {};

beforeEach(async () => {
  vi.useFakeTimers();
  ipc.reset();
  runs.length = 0;
  ipc.always("downloads.recordProgress", null);
  useUi.setState(useUi.getInitialState(), true);
  container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TitleWatch)),
    ),
  );
  unmount = () => act(() => root.unmount());
});

afterEach(() => {
  titlePlayer.close();
  unmount();
  vi.useRealTimers();
});

/** The session main opens for `download`, with `over` changing it. */
const session = (download: Download, over: Partial<CopySession> = {}): CopySession => ({
  sessionId: `session-${download.id}`,
  copy: download.id,
  url: `http://127.0.0.1/title/${download.id}.mp4`,
  duration: 2700,
  audio: [],
  subtitles: [],
  progress: download.progress,
  ...over,
});

/** Opens `download` from the Downloads page and starts its run, as main answers. */
async function watch(download: Download, over: Partial<CopySession> = {}): Promise<void> {
  const answer = ipc.hold("playback.openCopy", (args) => args.copy === download.id);
  await act(async () => watchOffline(download));
  await act(async () => answer.resolve(session(download, over)));
  await act(async () => runs.at(-1)?.start());
}

/** Plays `download` to its end. */
async function watchToEnd(download: Download): Promise<void> {
  await watch(download);
  await act(async () => runs.at(-1)?.end());
}

/** The copies playback was asked to open, in order. */
const opened = () => ipc.argsOf("playback.openCopy").map((args) => args.copy);

const text = () => container.textContent ?? "";

function press(label: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find(
    (each) => each.textContent === label || each.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`No ${label} button in "${text()}"`);
  return act(async () => button.click());
}

const wait = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

it("counts down to the next episode's copy and opens it once this copy's progress is saved", async () => {
  ipc.always("downloads.list", listOf(tide, pilot));
  await watchToEnd(pilot);

  expect(text()).toContain("Finished S1 E2 · Offline");
  expect(text()).toContain("S1 E3 · Low Tide");
  expect(text()).toContain("45 min · Plays in 10");
  const saved = ipc.hold("downloads.recordProgress");
  await wait(10_000);
  // The save asked for before opening is still under way: nothing opens yet.
  expect(opened()).toEqual(["pilot"]);
  expect(ipc.argsOf("downloads.recordProgress").at(-1)).toEqual({
    id: "pilot",
    position: 2700,
    duration: 2700,
  });

  const before = ipc.methods().length;
  await act(async () => saved.resolve(null));
  await wait(0);
  expect(opened()).toEqual(["pilot", "tide"]);
  // Main's list is read once more after the save answered, then the next copy opens.
  const after = ipc.methods().slice(before);
  expect(after.indexOf("downloads.list")).toBeGreaterThanOrEqual(0);
  expect(after.indexOf("downloads.list")).toBeLessThan(after.indexOf("playback.openCopy"));
  expect(ipc.argsOf("playback.close")).toEqual([{ sessionId: "session-pilot" }]);
});

it("stops on this copy when the list read before opening finds the next copy's file gone", async () => {
  ipc.always("downloads.list", listOf(tide, pilot));
  await watchToEnd(pilot);
  expect(text()).toContain("Plays in 10");

  ipc.always("downloads.list", listOf({ ...tide, status: { kind: "missing" } }, pilot));
  await wait(10_000);
  await wait(15_000);

  expect(opened()).toEqual(["pilot"]);
  expect(text()).toContain("S1 E3 isn't on this computer");
  expect(text()).toContain("Download it to go on.");
  expect(titlePlayer.state()).toMatchObject({
    now: { kind: "copy", copy: "pilot" },
    phase: { kind: "ended" },
    countdown: null,
  });
  expect(ipc.argsOf("playback.close")).toEqual([]);
});

it("decides on the list read before opening, though main told of other changes meanwhile", async () => {
  ipc.always("downloads.list", listOf(tide, pilot));
  await watchToEnd(pilot);
  const read = ipc.hold("downloads.list");
  await wait(10_000);
  // Another download's progress, as main tells several times a second, without a look at files.
  await act(async () => ipc.emit("downloads.changed", listOf(tide, pilot)));
  await wait(0);
  expect(opened()).toEqual(["pilot"]);

  await act(async () => read.resolve(listOf({ ...tide, status: { kind: "missing" } }, pilot)));
  await wait(0);
  expect(opened()).toEqual(["pilot"]);
  expect(text()).toContain("S1 E3 isn't on this computer");
});

it("stays on the end once cancelled, this copy's progress kept, and Next episode plays it", async () => {
  ipc.always("downloads.list", listOf(tide, pilot));
  await watchToEnd(pilot);

  await press("Cancel");
  await wait(15_000);
  expect(opened()).toEqual(["pilot"]);
  expect(text()).not.toContain("Plays in");
  expect(ipc.argsOf("downloads.recordProgress")).toEqual([
    { id: "pilot", position: 2700, duration: 2700 },
  ]);

  await press("Next episode");
  await wait(0);
  expect(opened()).toEqual(["pilot", "tide"]);
});

it("crosses into the next season, the speed going on with it", async () => {
  ipc.always("downloads.list", listOf(water, tide));
  await watch(tide);
  await act(async () => titlePlayer.setSpeed(1.5));
  await act(async () => runs.at(-1)?.end());

  expect(text()).toContain("Finished S1 E3 · Offline · Season 2 is next");
  expect(text()).toContain("S2 E1 · Open Water");
  await press("Play now");
  await wait(0);
  expect(opened()).toEqual(["tide", "water"]);
  expect(titlePlayer.state().speed).toBe(1.5);
});

it.each([
  [
    "no copy of the next episode, though a later one is here",
    listOf(water, pilot),
    ["S1 E3 isn't on this computer", "Download it to go on."],
  ],
  [
    "the next episode still downloading",
    listOf(
      {
        ...tide,
        status: { kind: "transferring", received: 46, size: 100, rate: null, restarted: false },
        size: 100,
      },
      pilot,
    ),
    ["S1 E3 is still downloading", "46%"],
  ],
  [
    "the next episode's download failed",
    listOf(
      {
        ...tide,
        status: {
          kind: "failed",
          failure: { kind: "stream", failure: { kind: "unavailable", status: 404 } },
        },
      },
      pilot,
    ),
    ["S1 E3 didn't download"],
  ],
  [
    "the series' last episode",
    listOf(copy("finale", 2, 3), pilot),
    ["That was the last episode", "Harbour Lights is finished for now."],
  ],
] as const)("says why nothing plays next after %s, and plays nothing", async (_, list, says) => {
  const finale = list.items.find((item) => item.id === "finale");
  ipc.always("downloads.list", list);
  await watchToEnd(finale ?? pilot);

  await wait(15_000);
  for (const line of says) expect(text()).toContain(line);
  expect(text()).not.toContain("Plays in");
  expect(opened()).toHaveLength(1);
  expect(container.querySelector("button")).not.toBeNull();
  await press("Downloads");
  expect(useUi.getState()).toMatchObject({ playingTitle: false, view: "downloads" });
});

it("stops the countdown when main says the next copy isn't complete any more", async () => {
  ipc.always("downloads.list", listOf(tide, pilot));
  await watchToEnd(pilot);
  expect(text()).toContain("Plays in 10");

  await act(async () =>
    ipc.emit("downloads.changed", listOf({ ...tide, status: { kind: "queued" } }, pilot)),
  );
  await wait(15_000);
  expect(titlePlayer.state().countdown).toBeNull();
  expect(text()).toContain("S1 E3 is still downloading");
  expect(opened()).toEqual(["pilot"]);
});

it("saves where this copy got to before Next episode opens the next one mid-play", async () => {
  ipc.always("downloads.list", listOf(tide, pilot));
  await watch(pilot, { progress: { position: 600, duration: 2700 } });

  const saved = ipc.hold("downloads.recordProgress");
  await press("Next episode");
  await wait(0);
  expect(ipc.argsOf("downloads.recordProgress")).toEqual([
    { id: "pilot", position: 595, duration: 2700 },
  ]);
  expect(opened()).toEqual(["pilot"]);

  await act(async () => saved.resolve(null));
  await wait(0);
  expect(opened()).toEqual(["pilot", "tide"]);
});

/** What main answers a save while another copy of the app holds the database. */
const LOCKED = { kind: "unexpected", detail: "database is locked" } as const;
const REFUSED = "Couldn't save. Try again.";

describe("a save main refuses", () => {
  it("keeps the copy playing when Next mid-play can't save it, and Next tries again", async () => {
    ipc.always("downloads.list", listOf(tide, pilot));
    await watch(pilot, { progress: { position: 600, duration: 2700 } });
    ipc.refuse("downloads.recordProgress", LOCKED);
    const reads = ipc.argsOf("downloads.list").length;

    await press("Next episode");
    await wait(0);
    expect(ipc.argsOf("downloads.recordProgress")).toEqual([
      { id: "pilot", position: 595, duration: 2700 },
    ]);
    expect(text()).toContain(REFUSED);
    // Nothing is looked up or opened on a save main refused, and the copy plays on.
    expect(ipc.argsOf("downloads.list")).toHaveLength(reads);
    expect(opened()).toEqual(["pilot"]);
    expect(titlePlayer.state()).toMatchObject({
      now: { kind: "copy", copy: "pilot" },
      phase: { kind: "playing" },
    });
    await wait(15_000);
    expect(opened()).toEqual(["pilot"]);

    ipc.always("downloads.recordProgress", null);
    await press("Next episode");
    await wait(0);
    expect(opened()).toEqual(["pilot", "tide"]);
  });

  it("stops the countdown on a save main refused, goes on to nothing by itself, and Next tries again", async () => {
    ipc.always("downloads.list", listOf(tide, pilot));
    await watchToEnd(pilot);
    expect(text()).toContain("Plays in 10");
    ipc.refuse("downloads.recordProgress", LOCKED);
    const reads = ipc.argsOf("downloads.list").length;

    await wait(10_000);
    expect(text()).toContain(REFUSED);
    expect(ipc.argsOf("downloads.list")).toHaveLength(reads);
    expect(titlePlayer.state()).toMatchObject({
      now: { kind: "copy", copy: "pilot" },
      phase: { kind: "ended" },
      countdown: null,
    });
    // Neither time nor Settings opened and closed starts it again.
    await act(async () => useUi.setState({ settings: "playback" }));
    await wait(15_000);
    await act(async () => useUi.setState({ settings: null }));
    await wait(15_000);
    expect(opened()).toEqual(["pilot"]);
    expect(text()).toContain("S1 E3 · Low Tide");

    // Refused again, it says so again and stays.
    await press("Next episode");
    await wait(0);
    expect(opened()).toEqual(["pilot"]);
    expect(text()).toContain(REFUSED);

    ipc.always("downloads.recordProgress", null);
    await press("Next episode");
    await wait(0);
    expect(opened()).toEqual(["pilot", "tide"]);
    expect(ipc.argsOf("downloads.recordProgress").at(-2)).toEqual({
      id: "pilot",
      position: 2700,
      duration: 2700,
    });
  });

  it.each([
    ["Cancel is pressed", () => press("Cancel")],
    [
      "the viewer leaves",
      () =>
        act(async () => {
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        }),
    ],
  ])("opens nothing and says nothing once %s while the save is under way", async (_, interrupt) => {
    ipc.always("downloads.list", listOf(tide, pilot));
    await watchToEnd(pilot);
    const refused = ipc.hold("downloads.recordProgress");
    const kept = ipc.hold("downloads.recordProgress");
    await wait(10_000);
    expect(ipc.argsOf("downloads.recordProgress")).toHaveLength(2);

    await interrupt();
    await act(async () => refused.reject(LOCKED));
    await act(async () => kept.resolve(null));
    await wait(15_000);
    expect(opened()).toEqual(["pilot"]);
    // Said nowhere: the note is the player's, whichever view shows it.
    expect(useFlash.getState().text).not.toBe(REFUSED);
  });

  it("goes by the save of the latest press, whichever answers first", async () => {
    ipc.always("downloads.list", listOf(tide, pilot));
    await watch(pilot, { progress: { position: 600, duration: 2700 } });
    const first = ipc.hold("downloads.recordProgress");
    const second = ipc.hold("downloads.recordProgress");
    await press("Next episode");
    await press("Next episode");

    await act(async () => second.resolve(null));
    await wait(0);
    expect(opened()).toEqual(["pilot", "tide"]);
    await act(async () => first.reject(LOCKED));
    await wait(0);
    expect(opened()).toEqual(["pilot", "tide"]);
    expect(useFlash.getState().text).not.toBe(REFUSED);
  });
});

it("ends a copy queued before series were kept as before, with nothing next", async () => {
  const legacy = { ...pilot, series: null };
  ipc.always("downloads.list", listOf(tide, legacy));
  await watchToEnd(legacy);

  await wait(15_000);
  expect(text()).toContain("Finished");
  expect(text()).toContain("Play again");
  expect(text()).not.toContain("Low Tide");
  expect(titlePlayer.state()).toMatchObject({ nextCopy: undefined, countdown: null });
  expect(opened()).toEqual(["pilot"]);
});

it("asks no provider, record or receiver, and picks the saved languages in the next copy", async () => {
  ipc.prefer({ audioLanguage: "fr", subtitleLanguage: "nl", nextEpisodeDelaySeconds: 0 });
  ipc.always("downloads.list", listOf(tide, pilot));
  const next = ipc.hold("playback.openCopy", (args) => args.copy === "tide");
  await watchToEnd(pilot);
  await wait(0);
  await act(async () =>
    next.resolve(
      session(tide, {
        audio: [
          { id: 1, language: "en", label: "English", default: true },
          { id: 2, language: "fr", label: "Français", default: false },
        ],
        subtitles: [
          {
            id: 3,
            page: null,
            format: "text",
            language: "nl",
            label: "Nederlands",
            forced: false,
            default: false,
          },
        ],
      }),
    ),
  );

  expect(opened()).toEqual(["pilot", "tide"]);
  expect(titlePlayer.state()).toMatchObject({
    now: { kind: "copy", copy: "tide" },
    audioId: 2,
    subtitle: { id: 3 },
  });
  // Nothing goes to the provider, the record, a receiver or an online subtitle service: the
  // window bar's own status reads are local.
  const reaching = ipc
    .methods()
    .filter(
      (method) =>
        /^(viewing|output)\./.test(method) ||
        (method.startsWith("ondemand.") && method !== "ondemand.status") ||
        ["playback.openTitle", "subtitles.search", "subtitles.choose"].includes(method),
    );
  expect(reaching).toEqual([]);
});
