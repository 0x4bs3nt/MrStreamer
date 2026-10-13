// @vitest-environment happy-dom
// At the end of an episode the next one in its series plays after a ten-second countdown, which
// the viewer can cancel, skip with Play now or N, or turn off in Settings. It waits while Settings
// is open. One next episode opens, only once the countdown ends and the episode before has closed;
// leaving, another title or a new account plays nothing. A next episode that fails says it didn't start, and the last
// episode records that its series is finished once every other one is watched. The next one is
// the next the viewer hasn't watched: one played or marked watched is passed over, as the record
// stands when it counts, and nothing opens on an answer of the record's that is old or missing,
// or once the viewer took the next episode back while the record was asked.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Episode, SeriesDetails, TitleRef } from "@mrstreamer/contracts/ondemand";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import type { EpisodeMark, SeriesViewing, TitleProgress } from "@mrstreamer/contracts/viewing";
import { resetForAccount, useUi } from "../../src/renderer/src/app/ui-store.ts";
import { TitleWatch } from "../../src/renderer/src/features/titles/TitleWatch.tsx";
import { movieNow, playTitle } from "../../src/renderer/src/lib/titles.ts";
import type { TitleRun } from "../../src/renderer/src/player/title-engine.ts";
import { episodeNow, titlePlayer } from "../../src/renderer/src/player/title-player.ts";

/** Runs as the title engine promises them, without a real stream: the test starts and ends each. */
const runs = vi.hoisted(() => [] as { start(): void; end(): void }[]);

vi.mock("../../src/renderer/src/player/title-engine.ts", () => ({
  titleEngine(video: HTMLVideoElement, run: TitleRun) {
    const { promise: started, resolve } = Promise.withResolvers<void>();
    let ended = () => {};
    runs.push({
      start() {
        void video.play();
        resolve();
      },
      end: () => ended(),
    });
    return {
      started,
      onFailure() {},
      onEnded(listener: () => void) {
        ended = listener;
      },
      position: () => run.start,
      seekWithin: () => false,
      onSubtitles() {},
      hideSubtitles() {},
      info: () => ({
        width: null,
        height: null,
        fps: null,
        videoCodec: null,
        audioCodec: null,
        audioChannels: null,
      }),
      destroy() {},
    };
  },
}));

function episode(id: string, season: number, number: number, title: string): Episode {
  return {
    subscriptionId: SUBSCRIPTION,
    id,
    seriesId: "nl",
    season,
    number,
    title,
    plot: null,
    duration: 2700,
    stillUrl: null,
    airDate: null,
  };
}

const pilotHouse = episode("e13", 1, 3, "The Pilot House");
const lowTide = episode("e21", 2, 1, "Low Tide");
const openWater = episode("e22", 2, 2, "Open Water");

/** The Dutch version of a series that also comes in English: S1 E3, S2 E1, and S2 E2, its last. */
const series: SeriesDetails = {
  kind: "series",
  title: {
    kind: "series",
    key: "series:nl",
    subscriptionId: SUBSCRIPTION,
    id: "nl",
    name: "Harbour Lights (NL)",
    title: "Harbour Lights",
    originalTitle: null,
    originalLanguage: "en",
    tags: ["NL"],
    year: 2024,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt: null,
    adult: false,
    tmdbId: "90000",
    genres: [],
    versions: [
      { subscriptionId: SUBSCRIPTION, id: "nl", tags: ["NL"] },
      { subscriptionId: SUBSCRIPTION, id: "en", tags: ["EN"] },
    ],
  },
  originalTitle: null,
  plot: null,
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: null,
  backdropUrl: null,
  seasons: [
    { number: 1, name: "Season 1", posterUrl: null, episodes: [pilotHouse] },
    { number: 2, name: "Season 2", posterUrl: null, episodes: [lowTide, openWater] },
  ],
};

let container: HTMLDivElement;
let unmount = () => {};

beforeEach(async () => {
  vi.useFakeTimers();
  ipc.reset();
  runs.length = 0;
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

/**
 * Plays `played` from its beginning, as session `sessionId`, to its end, doing `meanwhile` while
 * it plays.
 */
async function playToEnd(
  played: Episode,
  sessionId: string,
  meanwhile: () => Promise<void> = async () => {},
): Promise<void> {
  const answer = ipc.hold("playback.openTitle");
  const now = episodeNow(series, played);
  await act(async () => playTitle(now, 0));
  await act(async () =>
    answer.resolve({
      sessionId,
      title: now.title,
      url: `http://127.0.0.1/title/${sessionId}.mp4`,
      duration: 2700,
      audio: [],
      subtitles: [],
    }),
  );
  await act(async () => runs.at(-1)?.start());
  await meanwhile();
  await act(async () => runs.at(-1)?.end());
}

/** The episodes and movies playback was asked to open, by id. */
const opened = () =>
  ipc.argsOf("playback.openTitle").map((args) => (args as { title: TitleRef }).title.id);

const text = () => container.textContent ?? "";

function press(label: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find(
    (each) => each.textContent === label || each.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`No ${label} button in "${text()}"`);
  return act(async () => button.click());
}

function key(name: string): Promise<void> {
  return act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

const wait = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

/** The file of an episode of `seriesId`, watched to its end. */
const finished = (season: number, episode: number, seriesId = "nl"): TitleProgress => ({
  title: {
    kind: "episode",
    subscriptionId: SUBSCRIPTION,
    id: `${seriesId}-${season}-${episode}`,
    seriesId,
    season,
    episode,
  },
  position: 2700,
  duration: 2700,
  finished: true,
  at: 5,
  since: 5,
});

const watched = (season: number, episode: number): EpisodeMark => ({
  season,
  episode,
  watched: true,
  at: 5,
  revision: season * 10 + episode,
});

/** How the series' episodes stand in the record, with these played or marked. */
const standing = (...entries: (TitleProgress | EpisodeMark)[]): SeriesViewing => ({
  progress: entries.flatMap((each) => ("title" in each ? [each] : [])),
  marks: entries.flatMap((each) => ("title" in each ? [] : [each])),
  undoable: null,
});

/** The record once the viewer marked these episodes watched. */
const marked = (...marks: EpisodeMark[]) => ipc.always("viewing.episodes", standing(...marks));

const stored = { favourites: [], recent: [], continueWatching: [], marked: [], sequence: 1 };

describe("the end of an episode", () => {
  it("counts down once a second, then plays the next episode of its version after closing this one", async () => {
    await playToEnd(pilotHouse, "s1");

    expect(text()).toContain("Finished S1 E3 · Season 2 is next");
    expect(text()).toContain("S2 E1 · Low Tide");
    expect(text()).toContain("45 min · Plays in 10");
    await wait(1000);
    expect(text()).toContain("Plays in 9");
    await wait(8000);
    expect(text()).toContain("Plays in 1");
    expect(opened()).toEqual(["e13"]);

    await wait(1000);
    expect(opened()).toEqual(["e13", "e21"]);
    expect(ipc.argsOf("playback.openTitle").at(-1)).toMatchObject({
      title: {
        kind: "episode",
        subscriptionId: SUBSCRIPTION,
        id: "e21",
        seriesId: "nl",
        season: 2,
        episode: 1,
      },
    });
    const playback = ipc
      .methods()
      .filter((method) => method === "playback.close" || method === "playback.openTitle");
    expect(playback).toEqual(["playback.openTitle", "playback.close", "playback.openTitle"]);
    expect(ipc.argsOf("playback.close")).toEqual([{ sessionId: "s1" }]);
  });

  it("plays it at once with Play now or N, and only once", async () => {
    await playToEnd(pilotHouse, "s1");

    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((each) => each.textContent === "Play now")
        ?.click();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true }));
    });
    await wait(15_000);

    expect(opened()).toEqual(["e13", "e21"]);
  });

  it("stays on the end with Next episode once cancelled, and Episodes opens the series", async () => {
    await playToEnd(pilotHouse, "s1");

    await press("Cancel");
    await wait(15_000);
    expect(opened()).toEqual(["e13"]);
    expect(text()).not.toContain("Plays in");
    expect(text()).toContain("45 min");

    await press("Episodes");
    expect(useUi.getState()).toMatchObject({
      playingTitle: false,
      details: { kind: "series", subscriptionId: SUBSCRIPTION, id: "nl" },
    });
    expect(ipc.argsOf("playback.close")).toEqual([{ sessionId: "s1" }]);
  });

  it("offers the next episode without a countdown when it is turned off, and N plays it", async () => {
    // Read as the episode opens, then again at its end, after the viewer turned it off.
    ipc.hold("preferences.get").resolve(defaultPreferences);
    ipc.hold("preferences.get").resolve({ ...defaultPreferences, autoplayNext: false });
    await playToEnd(pilotHouse, "s1");

    await wait(15_000);
    expect(text()).not.toContain("Plays in");
    expect(text()).toContain("Next episode");
    expect(opened()).toEqual(["e13"]);

    await key("n");
    expect(opened()).toEqual(["e13", "e21"]);
  });

  it("waits while Settings is open over it, then carries on from the seconds it had left", async () => {
    await playToEnd(pilotHouse, "s1");
    await wait(3000);
    expect(text()).toContain("Plays in 7");

    await act(async () => useUi.setState({ settings: "general" }));
    await wait(30_000);
    expect(text()).toContain("Plays in 7");
    expect(opened()).toEqual(["e13"]);

    await act(async () => useUi.setState({ settings: null }));
    await wait(6000);
    expect(text()).toContain("Plays in 1");
    expect(opened()).toEqual(["e13"]);
    await wait(1000);
    expect(opened()).toEqual(["e13", "e21"]);
  });

  it("starts counting at an end behind Settings once Settings closes", async () => {
    await playToEnd(pilotHouse, "s1", () =>
      act(async () => useUi.setState({ settings: "general" })),
    );
    await wait(30_000);
    expect(text()).toContain("Plays in 10");
    expect(opened()).toEqual(["e13"]);

    await act(async () => useUi.setState({ settings: null }));
    await wait(10_000);
    expect(opened()).toEqual(["e13", "e21"]);
  });

  it.each([
    ["the viewer leaves", () => key("Escape")],
    ["the account changes", () => act(async () => resetForAccount())],
    [
      "another title starts",
      () =>
        act(async () => playTitle(movieNow({ ...series.title, kind: "movie", id: "m1" }, null), 0)),
    ],
  ])("plays nothing when %s during the countdown", async (_, interrupt) => {
    await playToEnd(pilotHouse, "s1");

    await interrupt();
    await wait(15_000);

    expect(opened()).not.toContain("e21");
    expect(ipc.argsOf("playback.close")).toContainEqual({ sessionId: "s1" });
  });

  it("says when the next episode didn't start, and tries it again", async () => {
    await playToEnd(pilotHouse, "s1");
    const failed = ipc.hold("playback.openTitle");
    await wait(10_000);
    await act(async () =>
      failed.reject({ kind: "stream", failure: { kind: "unavailable", status: 404 } }),
    );

    expect(text()).toContain("S2 E1 · Low Tide");
    expect(text()).toContain("Didn't start");
    expect(text()).toContain("The provider has no file for this episode right now.");

    await press("Try again");
    expect(opened()).toEqual(["e13", "e21", "e21"]);
  });

  it("gives the controls back when the viewer closes why the next episode didn't start", async () => {
    await playToEnd(pilotHouse, "s1");
    const failed = ipc.hold("playback.openTitle");
    await wait(10_000);
    await act(async () =>
      failed.reject({ kind: "stream", failure: { kind: "unavailable", status: 404 } }),
    );

    await press("Close message");
    expect(text()).not.toContain("Didn't start");
    expect(text()).not.toContain("no file for this");
    expect(titlePlayer.state().phase.kind).toBe("failed");

    // Play beside the picture tries it again; one more failure says so again.
    const again = ipc.hold("playback.openTitle");
    await press("Play");
    expect(opened()).toEqual(["e13", "e21", "e21"]);
    await act(async () =>
      again.reject({ kind: "stream", failure: { kind: "unavailable", status: 404 } }),
    );
    expect(text()).toContain("Didn't start");
  });

  // Space plays the title everywhere else. Enter on a message's cross is in title-subtitles.test.ts.
  it("closes why the next episode didn't start with Space on its cross, and starts nothing", async () => {
    document.body.append(container);
    await playToEnd(pilotHouse, "s1");
    const failed = ipc.hold("playback.openTitle");
    await wait(10_000);
    await act(async () =>
      failed.reject({ kind: "stream", failure: { kind: "unavailable", status: 404 } }),
    );
    useUi.setState({ playingTitle: true });

    const close = container.querySelector<HTMLButtonElement>('[aria-label="Close message"]')!;
    close.focus();
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    await act(async () => close.dispatchEvent(event));
    // Not taken as a shortcut, so the focused button presses itself; Space plays nothing.
    expect(event.defaultPrevented).toBe(false);
    expect(opened()).toEqual(["e13", "e21"]);
    await act(async () => close.click());
    expect(text()).not.toContain("Didn't start");
    expect(titlePlayer.state().phase.kind).toBe("failed");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Play");
    container.remove();
  });

  it("ends the last episode of a series watched through by recording that every version of it is finished", async () => {
    // The two before it were watched, one of them in the English version.
    ipc.always("viewing.episodes", standing(finished(1, 3), finished(2, 1, "en")));
    const saved = ipc.hold("viewing.recordProgress");
    await playToEnd(openWater, "s2");

    expect(text()).toContain("Finished S2 E2");
    expect(text()).toContain("That was the last episode");
    expect(text()).toContain("Harbour Lights is finished for now.");
    expect(ipc.argsOf("viewing.finishSeries")).toEqual([]);

    await act(async () => saved.resolve(stored));
    await wait(0);
    expect(ipc.argsOf("viewing.finishSeries")).toMatchObject([
      {
        series: [
          { subscriptionId: SUBSCRIPTION, id: "nl" },
          { subscriptionId: SUBSCRIPTION, id: "en" },
        ],
      },
    ]);
    await wait(15_000);
    expect(opened()).toEqual(["e22"]);
  });

  it("leaves a series in Continue watching when its last episode ends with an earlier one unwatched", async () => {
    // Started at the second season: the first season's episode was never watched.
    ipc.always("viewing.episodes", standing(finished(2, 1)));
    const saved = ipc.hold("viewing.recordProgress");
    await playToEnd(openWater, "s2");
    await act(async () => saved.resolve(stored));
    await wait(15_000);

    expect(text()).toContain("That was the last episode");
    expect(ipc.argsOf("viewing.recordProgress")).toHaveLength(1);
    expect(ipc.methods()).not.toContain("viewing.finishSeries");
    expect(opened()).toEqual(["e22"]);
  });
});

describe("the next episode, with some watched already", () => {
  it("passes over an episode marked watched, in what it offers and in what it plays", async () => {
    marked(watched(2, 1));

    await playToEnd(pilotHouse, "s1");

    expect(ipc.argsOf("viewing.episodes")[0]).toEqual({
      series: { subscriptionId: SUBSCRIPTION, id: "nl" },
    });
    expect(text()).toContain("S2 E2 · Open Water");
    expect(text()).not.toContain("Low Tide");
    await wait(10_000);
    expect(opened()).toEqual(["e13", "e22"]);
  });

  it("passes over one finished in another version of the series, by its numbers", async () => {
    ipc.always("viewing.episodes", standing(finished(2, 1, "en")));

    await playToEnd(pilotHouse, "s1");

    expect(text()).toContain("S2 E2 · Open Water");
  });

  it("asks again as the episode ends, and once more before the next one opens", async () => {
    // Marked while it played, with nothing said to the player.
    await playToEnd(pilotHouse, "s1", async () => marked(watched(2, 1)));
    expect(text()).toContain("S2 E2 · Open Water");
    expect(text()).toContain("Plays in 10");

    // And the last one marked while it counts down: nothing is left to play.
    marked(watched(2, 1), watched(2, 2));
    await wait(10_000);

    expect(opened()).toEqual(["e13"]);
    expect(text()).not.toContain("Plays in");
    expect(text()).toContain("The rest is watched");
  });

  it("follows the record while the episode plays, and a mark alone starts and stops nothing", async () => {
    await playToEnd(pilotHouse, "s1", async () => {
      marked(watched(2, 1), watched(2, 2));
      await act(async () => ipc.emit("viewing.changed", { sequence: 2 }));
      expect(titlePlayer.state()).toMatchObject({ next: null, phase: { kind: "playing" } });
      expect(opened()).toEqual(["e13"]);
      expect(ipc.methods()).not.toContain("playback.close");
    });

    expect(text()).toContain("The rest is watched");
    expect(text()).toContain("Every later episode is watched.");
  });

  it("records the series finished once none is left after it, with when this play began", async () => {
    marked(watched(2, 1), watched(2, 2));
    const saved = ipc.hold("viewing.recordProgress");
    const began = Date.now();

    await playToEnd(pilotHouse, "s1");
    await act(async () => saved.resolve(stored));
    await wait(0);

    expect(ipc.argsOf("viewing.recordProgress")).toMatchObject([{ since: began }]);
    expect(ipc.argsOf("viewing.finishSeries")).toMatchObject([{ since: began }]);
  });
});

describe("the next episode, as the record answers", () => {
  const unread = { kind: "unexpected", detail: "database is locked" } as const;

  it("goes by the latest answer when an earlier one arrives after it", async () => {
    await playToEnd(pilotHouse, "s1", async () => {
      // Asked twice as the record changed twice: the second answer comes first.
      const before = ipc.hold("viewing.episodes");
      const after = ipc.hold("viewing.episodes");
      await act(async () => ipc.emit("viewing.changed", { sequence: 2 }));
      await act(async () => ipc.emit("viewing.changed", { sequence: 3 }));
      await act(async () => after.resolve(standing(watched(2, 1))));
      await act(async () => before.resolve(standing()));

      expect(titlePlayer.state().next?.id).toBe("e22");
      marked(watched(2, 1));
    });

    expect(text()).toContain("S2 E2 · Open Water");
    await wait(10_000);
    expect(opened()).toEqual(["e13", "e22"]);
  });

  it("waits for the answer to a later question before it opens one", async () => {
    await playToEnd(pilotHouse, "s1");
    const atCountdown = ipc.hold("viewing.episodes");
    const afterMark = ipc.hold("viewing.episodes");

    // Asked as the countdown ends and again as an episode is marked. The first answers first,
    // with the record as it stood before the mark.
    await wait(10_000);
    await act(async () => ipc.emit("viewing.changed", { sequence: 2 }));
    await act(async () => atCountdown.resolve(standing()));
    expect(opened()).toEqual(["e13"]);

    await act(async () => afterMark.resolve(standing(watched(2, 1))));
    expect(opened()).toEqual(["e13", "e22"]);
  });

  it.each([
    ["before", true],
    ["after", false],
  ])(
    "opens nothing on an earlier answer when the later question fails %s it arrives",
    async (_, failsFirst) => {
      await playToEnd(pilotHouse, "s1");
      const atCountdown = ipc.hold("viewing.episodes");
      const afterMark = ipc.hold("viewing.episodes");
      await wait(10_000);
      await act(async () => ipc.emit("viewing.changed", { sequence: 2 }));

      if (failsFirst) await act(async () => afterMark.reject(unread));
      await act(async () => atCountdown.resolve(standing()));
      if (!failsFirst) await act(async () => afterMark.reject(unread));

      expect(text()).not.toContain("Plays in");
      await wait(15_000);
      expect(opened()).toEqual(["e13"]);

      // Another try asks again, and plays what the record says then.
      marked(watched(2, 1));
      await press("Next episode");
      expect(opened()).toEqual(["e13", "e22"]);
    },
  );

  it.each([
    ["cancels", () => press("Cancel")],
    ["plays the episode again", () => key(" ")],
  ])("opens nothing once the viewer %s before the record answers", async (_, takeBack) => {
    await playToEnd(pilotHouse, "s1");
    const asked = ipc.hold("viewing.episodes");
    await wait(10_000);

    await takeBack();
    await act(async () => asked.resolve(standing()));
    await wait(15_000);

    expect(opened()).toEqual(["e13"]);
  });

  it("opens nothing behind Settings opened before the record answers, and asks again once it closes", async () => {
    await playToEnd(pilotHouse, "s1");
    const asked = ipc.hold("viewing.episodes");
    await wait(10_000);

    await act(async () => useUi.setState({ settings: "general" }));
    await act(async () => asked.resolve(standing()));
    await wait(15_000);
    expect(opened()).toEqual(["e13"]);

    await act(async () => useUi.setState({ settings: null }));
    await wait(1000);
    expect(opened()).toEqual(["e13", "e21"]);
  });

  it("opens nothing when the record doesn't answer as the countdown ends, and the next one on another try", async () => {
    await playToEnd(pilotHouse, "s1");
    expect(text()).toContain("Plays in 10");
    const asked = ipc.hold("viewing.episodes");

    await wait(10_000);
    await act(async () => asked.reject(unread));

    // The episode it knew of stays on offer, and nothing started on its own.
    expect(opened()).toEqual(["e13"]);
    expect(text()).not.toContain("Plays in");
    expect(text()).toContain("S2 E1 · Low Tide");
    await wait(15_000);
    expect(opened()).toEqual(["e13"]);

    await press("Next episode");
    expect(opened()).toEqual(["e13", "e21"]);
  });

  it("offers and counts down to none while the record never said how the series stands", async () => {
    const first = ipc.hold("viewing.episodes");
    await playToEnd(pilotHouse, "s1", async () => {
      await act(async () => first.reject(unread));
      expect(titlePlayer.state().next).toBeUndefined();
      // Asked again as the episode ends, to no answer either.
      void ipc.hold("viewing.episodes").reject(unread);
    });

    await wait(15_000);
    expect(text()).not.toContain("Low Tide");
    expect(text()).not.toContain("Plays in");
    expect(opened()).toEqual(["e13"]);

    // N asks once more, and plays what the record then says is next.
    marked(watched(2, 1));
    await key("n");
    expect(opened()).toEqual(["e13", "e22"]);
  });
});
