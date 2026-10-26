// @vitest-environment happy-dom
// Marking an episode watched or unwatched from its row in a series' details: the dots beside the
// row, apart from the button that plays it, what the sheet shows while the mark is stored and
// once it is, Undo, a mark that wasn't stored, and a record that can't be read. Then what
// Continue watching makes of a marked series beside what was played.
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError } from "@mrstreamer/contracts/errors";
import type { Episode, SeriesDetails, Title } from "@mrstreamer/contracts/ondemand";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import type {
  EpisodeMark,
  MarkedSeries,
  SeriesViewing,
  TitleProgress,
  Viewing,
} from "@mrstreamer/contracts/viewing";
import { DetailsView } from "../../src/renderer/src/features/titles/DetailsView.tsx";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";
import { queries, syncViewing } from "../../src/renderer/src/lib/queries.ts";
import { useContinueWatching } from "../../src/renderer/src/lib/titles.ts";

/** The series version these tests open, as requests name it. */
const HARBOUR = { subscriptionId: SUBSCRIPTION, id: "harbour" };

const series: Title = {
  kind: "series",
  key: "series:tmdb:90000",
  subscriptionId: SUBSCRIPTION,
  id: "harbour",
  name: "Night Harbour (NL)",
  title: "Night Harbour",
  originalTitle: null,
  originalLanguage: "nl",
  tags: ["NL"],
  year: 2024,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: "90000",
  genres: [],
  versions: [{ subscriptionId: SUBSCRIPTION, id: "harbour", tags: ["NL"] }],
};

const episode = (season: number, number: number): Episode => ({
  subscriptionId: SUBSCRIPTION,
  id: `${season}-${number}`,
  seriesId: "harbour",
  season,
  number,
  title: `Part ${season}.${number}`,
  plot: null,
  duration: 2700,
  stillUrl: null,
  airDate: null,
});

/** A first season of three episodes, and a second of two. */
const details: SeriesDetails = {
  kind: "series",
  title: series,
  originalTitle: null,
  plot: null,
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: null,
  backdropUrl: null,
  seasons: [1, 2].map((number) => ({
    number,
    name: `Season ${number}`,
    posterUrl: null,
    episodes: [episode(number, 1), episode(number, 2), ...(number === 1 ? [episode(1, 3)] : [])],
  })),
};

/** A play of an episode that stopped at `position` of 45 minutes. */
const played = (
  season: number,
  number: number,
  position: number,
  at: number,
  since = at,
  subscriptionId = SUBSCRIPTION,
): TitleProgress => ({
  title: {
    kind: "episode",
    subscriptionId,
    id: `${season}-${number}`,
    seriesId: "harbour",
    season,
    episode: number,
  },
  position,
  duration: 2700,
  finished: position >= 2650,
  at,
  since,
});

const marked = (season: number, number: number, watched: boolean, at: number): EpisodeMark => ({
  season,
  episode: number,
  watched,
  at,
  revision: at,
});

/** The first episode watched, and the second stopped a third of the way in. */
const before: SeriesViewing = {
  progress: [played(1, 1, 2700, 1), played(1, 2, 900, 2)],
  marks: [],
  undoable: null,
};
/** The same once the second was marked watched. */
const after: SeriesViewing = { ...before, marks: [marked(1, 2, true, 10)], undoable: 10 };

let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
});

const text = () => document.body.textContent ?? "";
/** Waits until `check` passes, moving the fake clock so React Query passes the answers on. */
const until = (check: () => void) =>
  vi.waitFor(
    async () => {
      await act(() => vi.advanceTimersByTimeAsync(10));
      check();
    },
    { timeout: 5000 },
  );

const buttons = () => [...document.body.querySelectorAll("button")];
/** The button that says exactly `label`. */
const button = (label: string) => buttons().find((each) => each.textContent === label);
/** The sheet's main action: what the series goes on with. */
const mainAction = () =>
  buttons().find((each) => /^(Play|Resume|Replay) S\d/.test(each.textContent ?? ""))?.textContent;
/** The dots on an episode's row. */
const dots = (label: string) =>
  document.body.querySelector<HTMLElement>(`[aria-label="More for ${label}"]`);
const items = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
/** The rows whose episode shows as watched, by their episode's name. */
const watched = () =>
  [...document.body.querySelectorAll('[aria-label="Watched"]')].map(
    (check) => /Part \d\.\d/.exec(check.closest(".group")?.textContent ?? "")?.[0],
  );

/** Opens the dots of `label` and answers which of its two marks can be picked. */
async function offered(label: string): Promise<boolean[]> {
  await act(async () => dots(label)?.click());
  await until(() => expect(items()).toHaveLength(2));
  return items().map((each) => !each.hasAttribute("data-disabled"));
}

/** Opens the dots of `label` and picks `item`. */
async function pick(label: string, item: "Mark watched" | "Mark unwatched"): Promise<void> {
  await offered(label);
  await act(async () =>
    items()
      .find((each) => each.textContent?.startsWith(item))
      ?.click(),
  );
}

/**
 * The series' sheet, open on a record that reads `standing`, or that can't be read for the error
 * given, with the subscriptions `saved` and the title as the lists have it.
 */
async function sheet(
  standing: SeriesViewing | AppError,
  {
    saved = [SAVED],
    title = series,
    shown = details,
  }: { saved?: SubscriptionSummary[]; title?: Title; shown?: SeriesDetails } = {},
): Promise<void> {
  ipc.reset();
  const read = "kind" in standing ? null : standing;
  if (read) ipc.always("viewing.episodes", read);
  else ipc.refuse("viewing.episodes", standing as AppError);
  const listed = ipc.hold("ondemand.titles");
  const progress = ipc.hold("viewing.progress");
  const opened = ipc.hold("ondemand.details");
  // As the app's: a read that failed is not tried again by itself.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["subscriptions"], saved);
  const stopSync = syncViewing(client);
  const view = queryView(client);
  await view.render(createElement(DetailsView, { target: { kind: "series", ...HARBOUR } }));
  unmount = () => {
    stopSync();
    view.unmount();
  };
  await act(async () => listed.resolve([title]));
  await act(async () => progress.resolve(read?.progress ?? []));
  await act(async () => opened.resolve({ ...shown, title }));
  await until(() => expect(text()).toContain("Part 1.2"));
}

describe("an episode's row", () => {
  it("plays with one button and marks with another beside it, which plays nothing", async () => {
    await sheet(before);

    const row = dots("S1 E2")?.closest(".group");
    const play = buttons().find((each) => each.textContent?.includes("Part 1.2"));
    expect(row?.contains(play ?? null)).toBe(true);
    expect(play?.contains(dots("S1 E2"))).toBe(false);
    expect(document.body.querySelector("button button")).toBeNull();

    // An episode played partway can go either way, without marking it watched first.
    expect(await offered("S1 E2")).toEqual([true, true]);
    expect(items().map((each) => each.textContent)).toEqual(["Mark watched", "Mark unwatched"]);

    expect(ipc.methods()).not.toContain("viewing.markEpisode");
    expect(ipc.methods()).not.toContain("playback.openTitle");
  });

  it("offers an episode that is watched, or neither played nor marked, only the mark that would change it", async () => {
    await sheet(before);

    expect(await offered("S1 E1")).toEqual([false, true]);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await until(() => expect(items()).toHaveLength(0));
    expect(await offered("S1 E3")).toEqual([true, false]);
  });
});

describe("marking an episode watched", () => {
  it("shows it once it is stored, moves the series on, offers Undo and opens no stream", async () => {
    await sheet(before);
    expect(mainAction()).toBe("Resume S1 E2");
    expect(watched()).toEqual(["Part 1.1"]);
    const stored = ipc.hold("viewing.markEpisode");
    const trigger = dots("S1 E2");

    await pick("S1 E2", "Mark watched");

    expect(ipc.argsOf("viewing.markEpisode")).toMatchObject([
      {
        watched: true,
        episode: {
          kind: "episode",
          ...HARBOUR,
          id: "1-2",
          seriesId: "harbour",
          season: 1,
          episode: 2,
        },
      },
    ]);
    // Being stored: the row says so and claims nothing yet, and nothing else changed.
    await until(() => expect(text()).toContain("Saving…"));
    expect(watched()).toEqual(["Part 1.1"]);
    expect(mainAction()).toBe("Resume S1 E2");
    expect(text()).not.toContain("marked watched");

    ipc.always("viewing.episodes", after);
    await act(async () => stored.resolve(marked(1, 2, true, 10)));

    await until(() => expect(text()).toContain("S1 E2 marked watched"));
    expect(text()).not.toContain("Saving…");
    expect(watched()).toEqual(["Part 1.1", "Part 1.2"]);
    expect(mainAction()).toBe("Play S1 E3");
    expect(button("Undo")).toBeDefined();
    // The row kept its place and its dots, though the series moved on: the focus stays on them.
    expect(dots("S1 E2")).toBe(trigger);
    // With one subscription saved nothing says whose the mark is.
    expect(text()).not.toContain(" on ");
    expect(ipc.methods()).not.toContain("playback.openTitle");
  });

  it("says so when it wasn't stored, changes nothing, and sends the same change again on Retry", async () => {
    await sheet(before);
    const failed = ipc.hold("viewing.markEpisode");
    await pick("S1 E2", "Mark watched");

    await act(async () => failed.reject({ kind: "unexpected", detail: "disk full" }));

    await until(() => expect(text()).toContain("Couldn't mark S1 E2 watched."));
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("disk full");
    expect(watched()).toEqual(["Part 1.1"]);
    expect(mainAction()).toBe("Resume S1 E2");
    expect(button("Undo")).toBeUndefined();

    const stored = ipc.hold("viewing.markEpisode");
    await act(async () => button("Retry")?.click());
    const [first, second] = ipc.argsOf("viewing.markEpisode");
    expect(second).toEqual(first);
    ipc.always("viewing.episodes", after);
    await act(async () => stored.resolve(marked(1, 2, true, 10)));
    await until(() => expect(text()).toContain("S1 E2 marked watched"));
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });

  it("names the subscription once the title's versions are of several", async () => {
    const other = { ...SAVED, id: "b0e1", name: "Holiday house" };
    const both = {
      ...series,
      versions: [...series.versions, { subscriptionId: other.id, id: "harbour", tags: [] }],
    };
    await sheet(before, { saved: [{ ...SAVED, name: "Mega IPTV" }, other], title: both });
    const stored = ipc.hold("viewing.markEpisode");

    await act(async () => dots("S1 E2")?.click());
    await until(() =>
      expect(items().map((each) => each.textContent)).toEqual([
        "Mark watchedMega IPTV",
        "Mark unwatchedMega IPTV",
      ]),
    );
    await act(async () => items()[0]?.click());
    ipc.always("viewing.episodes", after);
    await act(async () => stored.resolve(marked(1, 2, true, 10)));

    await until(() => expect(text()).toContain("S1 E2 marked watched on Mega IPTV"));
  });

  it("offers the first episode again once every numbered one is watched", async () => {
    const all = details.seasons.flatMap((season, at) =>
      season.episodes.map((each) => marked(each.season, each.number, true, at * 2 + each.number)),
    );

    await sheet({ progress: [], marks: all, undoable: null });

    expect(mainAction()).toBe("Replay S1 E1");
  });
});

describe("marking an episode unwatched, and Undo", () => {
  /** The second episode marked unwatched: it plays from its beginning again. */
  const reset: SeriesViewing = { ...before, marks: [marked(1, 2, false, 10)], undoable: 10 };

  it("takes its resume point away, and Undo brings back exactly what was there", async () => {
    await sheet(before);
    expect(text()).toContain("30 min left");
    const stored = ipc.hold("viewing.markEpisode");
    await pick("S1 E2", "Mark unwatched");
    ipc.always("viewing.episodes", reset);
    await act(async () => stored.resolve(marked(1, 2, false, 10)));

    await until(() => expect(text()).toContain("S1 E2 marked unwatched"));
    expect(mainAction()).toBe("Play S1 E2");
    expect(text()).not.toContain("30 min left");

    const undone = ipc.hold("viewing.undoMark");
    await act(async () => button("Undo")?.click());
    expect(ipc.argsOf("viewing.undoMark")).toMatchObject([{ series: HARBOUR, revision: 10 }]);
    ipc.always("viewing.episodes", before);
    await act(async () => undone.resolve(null));

    await until(() => expect(mainAction()).toBe("Resume S1 E2"));
    expect(text()).toContain("30 min left");
    expect(text()).not.toContain("marked unwatched");
    expect(button("Undo")).toBeUndefined();
  });

  it("says when the mark can no longer be undone, and offers nothing more", async () => {
    await sheet(before);
    const stored = ipc.hold("viewing.markEpisode");
    await pick("S1 E2", "Mark unwatched");
    ipc.always("viewing.episodes", reset);
    await act(async () => stored.resolve(marked(1, 2, false, 10)));
    await until(() => expect(button("Undo")).toBeDefined());

    const refused = ipc.hold("viewing.undoMark");
    await act(async () => button("Undo")?.click());
    await act(async () => refused.reject({ kind: "mark-changed" }));

    await until(() => expect(text()).toContain("This can no longer be undone."));
    expect(button("Undo")).toBeUndefined();
    expect(button("Retry")).toBeUndefined();
    expect(mainAction()).toBe("Play S1 E2");
  });

  it("stops offering Undo once the series was played after the mark", async () => {
    await sheet(before);
    const stored = ipc.hold("viewing.markEpisode");
    await pick("S1 E2", "Mark unwatched");
    ipc.always("viewing.episodes", reset);
    await act(async () => stored.resolve(marked(1, 2, false, 10)));
    await until(() => expect(button("Undo")).toBeDefined());

    // The viewer starts the next episode; the record says so.
    ipc.always("viewing.episodes", {
      ...reset,
      progress: [...reset.progress, played(1, 3, 300, 20)],
      undoable: null,
    });
    await act(async () => ipc.emit("viewing.changed", { sequence: 9 }));

    await until(() => expect(button("Undo")).toBeUndefined());
    expect(text()).not.toContain("marked unwatched");
    expect(mainAction()).toBe("Resume S1 E3");
  });
});

describe("a record that can't be read", () => {
  const locked: AppError = { kind: "unexpected", detail: "database is locked" };

  it("says so, names no episode to go on with, shows none as watched or not, and reads again on Try again", async () => {
    await sheet(locked);

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't read what you watched. Something went wrong: database is locked",
    );
    expect(mainAction()).toBeUndefined();
    expect(watched()).toEqual([]);
    expect(text()).not.toContain("min left");
    // The episodes are there to play, and none offers a mark that could be wrong.
    expect(buttons().some((each) => each.textContent?.includes("Part 1.2"))).toBe(true);
    expect(dots("S1 E2")).toBeNull();
    // It isn't asked again and again meanwhile.
    const asked = ipc.argsOf("viewing.episodes").length;
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(ipc.argsOf("viewing.episodes")).toHaveLength(asked);

    ipc.always("viewing.episodes", before);
    await act(async () => button("Try again")?.click());

    await until(() => expect(mainAction()).toBe("Resume S1 E2"));
    expect(watched()).toEqual(["Part 1.1"]);
    expect(dots("S1 E2")).not.toBeNull();
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps what it read before when a later read fails", async () => {
    await sheet(before);
    const again = ipc.hold("viewing.episodes");

    await act(async () => ipc.emit("viewing.changed", { sequence: 9 }));
    await act(async () => again.reject(locked));

    await until(() => expect(ipc.argsOf("viewing.episodes")).toHaveLength(2));
    expect(mainAction()).toBe("Resume S1 E2");
    expect(watched()).toEqual(["Part 1.1"]);
    expect(dots("S1 E2")).not.toBeNull();
    expect(text()).not.toContain("Couldn't read");
  });
});

describe("Continue watching with a marked series", () => {
  const OTHER = "b0e1";
  const both: Title = {
    ...series,
    versions: [...series.versions, { subscriptionId: OTHER, id: "harbour", tags: [] }],
  };
  const mark = (
    next: MarkedSeries["next"],
    at = 10,
    subscriptionId = SUBSCRIPTION,
  ): MarkedSeries => ({
    series: { subscriptionId, id: "harbour" },
    kept: "tmdb:90000",
    at,
    next,
  });
  const from = (season: number, number: number) => ({ season, episode: number, resume: null });

  /** What the row shows of the series for a record that reads `viewing`. */
  async function row(viewing: Pick<Viewing, "continueWatching" | "marked">): Promise<string[]> {
    // Each read replaces the last one's view, so no earlier record is still mounted.
    unmount();
    ipc.reset();
    const client = new QueryClient();
    client.setQueryData(queries.viewing().queryKey, {
      favourites: [],
      recent: [],
      sequence: 1,
      ...viewing,
    });
    ipc.always("ondemand.titles", [both]);
    let lines: string[] = [];
    function Probe() {
      const { entries, loading } = useContinueWatching();
      lines = loading ? ["loading"] : entries.map((entry) => entry.line);
      return null;
    }
    const view = queryView(client);
    await view.render(createElement(Probe));
    unmount = view.unmount;
    await until(() => expect(lines).not.toEqual(["loading"]));
    return lines;
  }

  it("offers the episode the mark said, and where it resumes when the mark left that standing", async () => {
    expect(await row({ continueWatching: [], marked: [mark(from(2, 1))] })).toEqual(["S2 E1"]);
    expect(
      await row({
        continueWatching: [],
        marked: [mark({ season: 1, episode: 2, resume: { position: 900, duration: 2700 } })],
      }),
    ).toEqual(["S1 E2 · 30 min left"]);
  });

  it("keeps to the mark while a play begun before it saves on, and follows one begun after", async () => {
    const going = played(1, 2, 1500, 60, 5);
    expect(await row({ continueWatching: [going], marked: [mark(from(2, 1))] })).toEqual(["S2 E1"]);

    const again = played(1, 2, 1500, 60, 30);
    expect(await row({ continueWatching: [again], marked: [mark(from(2, 1))] })).toEqual([
      "S1 E2 · 20 min left",
    ]);
  });

  it("leaves the series out once every numbered episode is marked watched, whatever a play from before saves", async () => {
    expect(
      await row({ continueWatching: [played(2, 2, 2000, 60, 5)], marked: [mark(null)] }),
    ).toEqual([]);
  });

  it("shows nothing for marks kept under a TMDB id the lists no longer give the series", async () => {
    const waiting = { ...mark(from(2, 1)), kept: "tmdb:777" };

    expect(await row({ continueWatching: [], marked: [waiting] })).toEqual([]);
    // What was played of it shows as ever.
    expect(await row({ continueWatching: [played(1, 2, 1500, 60)], marked: [waiting] })).toEqual([
      "S1 E2 · 20 min left",
    ]);
  });

  it("goes by whichever subscription the series was played or marked in last", async () => {
    // Marked in one subscription, then played in the other, whose record the mark says nothing of.
    const theirs = played(1, 1, 600, 60, 5, OTHER);
    expect(await row({ continueWatching: [theirs], marked: [mark(from(2, 1))] })).toEqual([
      "S1 E1 · 35 min left",
    ]);
    expect(await row({ continueWatching: [theirs], marked: [mark(from(2, 1), 90)] })).toEqual([
      "S2 E1",
    ]);
  });
});

// Each version resumes from its own play; a mark unwatched starts whichever is picked from 0.
it.each([
  { label: "HD", id: "1-2", reset: false, position: 995 },
  { label: "4K", id: "alternate", reset: false, position: 495 },
  { label: "4K", id: "alternate", reset: true, position: 0 },
])(
  "plays exact episode version $label with progress reset=$reset",
  async ({ label, id, reset, position }) => {
    const exact = {
      ...details,
      exactVersions: true as const,
      episodeOrder: ["1-1", "1-2", "1-3", "2-1", "2-2"],
      seasons: details.seasons.map((season) => ({
        ...season,
        episodes: season.episodes.map((episode) => ({
          ...episode,
          exactVersion: true as const,
          ...(episode.id === "1-2"
            ? {
                versions: [
                  {
                    id: "1-2",
                    name: "Part 1.2 HD",
                    tags: ["HD"],
                    duration: 2700,
                    container: "mp4",
                  },
                  {
                    id: "alternate",
                    name: "Part 1.2 4K",
                    tags: ["4K"],
                    duration: 2800,
                    container: "mkv",
                    observed: { files: 1, audio: ["en"], subtitles: ["nl"] },
                  },
                ],
              }
            : {}),
        })),
      })),
    };
    const playedAlternate = {
      ...played(1, 2, 500, 3),
      title: { ...played(1, 2, 500, 3).title, id: "alternate" },
    };
    await sheet(
      {
        progress: [played(1, 2, 1000, 2), playedAlternate],
        marks: reset ? [marked(1, 2, false, 10)] : [],
        undoable: null,
      },
      { shown: exact },
    );
    const trigger = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Versions for S1 E2"]',
    );
    expect(trigger?.getAttribute("title")).toBe("2 versions");
    await act(async () => trigger?.click());
    const files = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    await until(() => expect(files()).toHaveLength(2));
    expect(files().map((file) => file.getAttribute("aria-label")?.split(" · ")[0])).toEqual([
      "4K",
      "HD",
    ]);
    expect(files()[0]?.textContent).toContain("Part 1.2 4K · MKV");
    expect(files()[0]?.textContent).toContain("English sound · Nederlands subtitles");
    expect(files()[0]?.querySelector('[aria-label="Tracks read locally"]')).not.toBeNull();
    expect(files()[1]?.textContent).toContain("Part 1.2 HD · MP4");
    expect(files()[1]?.querySelector('[aria-label="Tracks read locally"]')).toBeNull();
    await act(async () =>
      files()
        .find((file) => file.getAttribute("aria-label")?.startsWith(label + " · "))
        ?.click(),
    );
    await until(() => expect(ipc.argsOf("playback.openTitle")[0]?.title.id).toBe(id));
    expect(titlePlayer.state().position).toBe(position);
    expect(ipc.argsOf("subscription.updatePreferences")).toHaveLength(0);
    expect(ipc.argsOf("playback.openTitle")[0]?.title).toMatchObject({
      kind: "episode",
      seriesId: "harbour",
      season: 1,
      episode: 2,
      id,
    });
  },
);
