// Episodes marked watched or unwatched by hand, as the viewing record keeps them: apart from how
// far any file played, by the series and the episode's numbers, in the record of the
// subscription they were marked in. The fake providers list "TEST | Formats" in two versions
// under one TMDB id, two seasons of three and two episodes in the Dutch one, and a second
// provider lists it under the same series and episode ids.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { ViewingRecord, type EpisodeRef } from "@mrstreamer/core/viewing/service";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { mainLayer } from "../src/main/runtime.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

/** The provider's ids of the series' Dutch and English versions, and of two listed alone. */
const NL = "80000";
const EN = "79998";
const ALONE = "80001";
const OTHER = "80002";

/** The files the providers list for the Dutch version's episodes, by season and number. */
const FILES: Readonly<Record<string, string>> = {
  "1:1": "81000",
  "1:2": "81001",
  "1:3": "81002",
  "2:1": "81010",
  "2:2": "81011",
};

/**
 * The app with the default provider's subscription saved, and the second provider's too when
 * `both`. The clock stands still until `moveOn`, so each step is later than the one before.
 * `start` ends the app and begins it again on the same data folder.
 */
async function marksApp({ both = false } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => void vi.useRealTimers());
  const moveOn = () => {
    vi.setSystemTime(Date.now() + 60_000);
    return Date.now();
  };
  const dataDir = await tempDir();
  const [first, second] = [await fakeProvider(), await fakeProvider({ second: true })];
  let running: { dispose(): Promise<void> } | null = null;
  const start = async () => {
    await running?.dispose();
    const runtime = runtimeFor(mainLayer(testConfig(dataDir)));
    running = runtime;
    return {
      viewing: await promised(runtime, ViewingRecord),
      subscriptions: await promised(runtime, Subscriptions),
      roster: await promised(runtime, Roster),
      onDemand: await promised(runtime, OnDemand),
    };
  };
  const app = await start();
  const login = (server: string) => ({ server, username: "demo", password: "demo" });
  const a = (await app.subscriptions.add(login(first.url))).id;
  const b = both ? (await app.subscriptions.add(login(second.url))).id : "not-saved";
  /** Runs `use` on the database through a connection of its own, as another build's would be. */
  const database = <A>(use: (db: DatabaseSync) => A): A => {
    const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));
    try {
      return use(db);
    } finally {
      db.close();
    }
  };
  return { ...app, start, dataDir, first, second, a, b, login, moveOn, database };
}

const of = (subscriptionId: string, id: string): OwnedId => ({ subscriptionId, id });

/** An episode of the Dutch version, or of `seriesId`, as its row in the details names it. */
function episode(
  subscriptionId: string,
  season: number,
  number: number,
  seriesId = NL,
): EpisodeRef {
  return {
    kind: "episode",
    subscriptionId,
    id: FILES[`${season}:${number}`] ?? `${seriesId}-${season}-${number}`,
    seriesId,
    season,
    episode: number,
  };
}

type Viewing = Awaited<ReturnType<typeof marksApp>>["viewing"];

const mark = (
  viewing: Viewing,
  ref: EpisodeRef,
  watched: boolean,
  commandId: string = randomUUID(),
) => viewing.markEpisode(commandId, ref, watched);

/** A checkpoint of `title` at `position` of 2700 seconds, in a play that began at `since`. */
const play = (viewing: Viewing, title: TitleRef, position: number, since = Date.now()) =>
  viewing.recordProgress(randomUUID(), title, position, 2700, since);

/** Where the marked series go on, by the version each was marked in. */
const goesOn = async (viewing: Viewing) =>
  (await viewing.state()).marked.map(({ series, next }) => [
    series.id,
    next && `${next.season}:${next.episode}`,
  ]);

/** The record as the window reads it, without how far it has come. */
const recordOf = async (viewing: Viewing) => ({ ...(await viewing.state()), sequence: 0 });

/** Every numbered episode of the Dutch version but the last, by season and number. */
const ALL_BUT_LAST = [
  [1, 1],
  [1, 2],
  [1, 3],
  [2, 1],
] as const;

describe("marking an episode", () => {
  it("marks it watched without a play or a length, opens no stream, and says where the series goes on", async () => {
    const { viewing, a, first, database, moveOn } = await marksApp();

    const marked = await mark(viewing, episode(a, 1, 1), true);

    expect(marked).toMatchObject({ season: 1, episode: 1, watched: true, at: Date.now() });
    expect(await viewing.episodes(of(a, NL))).toEqual({
      progress: [],
      marks: [marked],
      undoable: marked?.revision,
    });
    // Kept under the TMDB id the lists gather its versions by.
    expect((await viewing.state()).marked).toEqual([
      {
        series: of(a, NL),
        kept: "tmdb:90000",
        at: Date.now(),
        next: { season: 1, episode: 2, resume: null },
      },
    ]);
    // Nothing of a play was made up for it, in a row or as an event, and nothing was fetched.
    expect(
      database((db) => [
        db.prepare("select count(*) as rows from titles").get()?.["rows"],
        db.prepare("select count(*) as rows from events where type = 'title-progress'").get()?.[
          "rows"
        ],
      ]),
    ).toEqual([0, 0]);
    expect([first.fileRequests(), first.streamRequests()]).toEqual([0, 0]);

    // The next one that isn't watched, into the next season, then none: the series leaves.
    for (const [season, number] of ALL_BUT_LAST.slice(1)) {
      moveOn();
      await mark(viewing, episode(a, season, number), true);
    }
    expect(await goesOn(viewing)).toEqual([[NL, "2:2"]]);
    moveOn();
    await mark(viewing, episode(a, 2, 2), true);
    expect(await goesOn(viewing)).toEqual([[NL, null]]);
  });

  it("offers an earlier episode once none is left after the one marked", async () => {
    const { viewing, a, moveOn } = await marksApp();
    await mark(viewing, episode(a, 1, 1), true);
    moveOn();

    await mark(viewing, episode(a, 2, 2), true);

    expect(await goesOn(viewing)).toEqual([[NL, "1:2"]]);
  });

  it("marks it unwatched: it goes on from its beginning, and how far its file got stays under the mark", async () => {
    const { viewing, a, moveOn } = await marksApp();
    await play(viewing, episode(a, 1, 2), 900);
    const played = await viewing.episodes(of(a, NL));
    moveOn();

    const marked = await mark(viewing, episode(a, 1, 2), false);

    expect(await goesOn(viewing)).toEqual([[NL, "1:2"]]);
    expect((await viewing.state()).marked[0]?.next).toEqual({
      season: 1,
      episode: 2,
      resume: null,
    });
    expect(await viewing.episodes(of(a, NL))).toEqual({
      ...played,
      marks: [marked],
      undoable: marked?.revision,
    });
  });

  it("changes nothing more when it arrives again, or asks for what is marked already", async () => {
    const { viewing, a, moveOn } = await marksApp();
    const first = await mark(viewing, episode(a, 1, 1), true, "mark");
    const { sequence } = await viewing.state();
    moveOn();

    expect(await mark(viewing, episode(a, 1, 1), true, "mark")).toEqual(first);
    expect(await mark(viewing, episode(a, 1, 1), true)).toEqual(first);

    expect((await viewing.state()).sequence).toBe(sequence);
    // The mark is still the one to take back.
    await viewing.undoMark(randomUUID(), of(a, NL), first?.revision ?? 0);
    expect(await viewing.episodes(of(a, NL))).toEqual({ progress: [], marks: [], undoable: null });
  });

  it("refuses an episode its series doesn't list, a series off the lists, and a subscription that isn't saved", async () => {
    const { viewing, a } = await marksApp();
    const { sequence } = await viewing.state();

    await expect(mark(viewing, episode(a, 9, 9), true)).rejects.toMatchObject({
      error: { kind: "title-not-found" },
    });
    await expect(mark(viewing, episode(a, 1, 1, "unlisted"), true)).rejects.toMatchObject({
      error: { kind: "title-not-found" },
    });
    await expect(mark(viewing, episode("another-subscription", 1, 1), true)).rejects.toMatchObject({
      error: { kind: "no-subscription" },
    });

    expect(await viewing.state()).toMatchObject({ marked: [], sequence });
    expect(await viewing.episodes(of("another-subscription", NL))).toEqual({
      progress: [],
      marks: [],
      undoable: null,
    });
  });

  it("stores nothing when the database fails partway, and the same change saves on the retry", async () => {
    const { viewing, a, database, moveOn } = await marksApp();
    await play(viewing, episode(a, 1, 1), 900);
    const before = [await viewing.state(), await viewing.episodes(of(a, NL))];
    const events = () =>
      database((db) => db.prepare("select count(*) as rows from events").get()?.["rows"]);
    const written = events();
    moveOn();
    // The disk gives out at the last thing a mark writes: the mark itself.
    database((db) =>
      db.exec(`create trigger full before insert on marked_episodes
               begin select raise(abort, 'disk full'); end`),
    );

    await expect(mark(viewing, episode(a, 1, 1), true, "mark")).rejects.toMatchObject({
      error: { kind: "unexpected" },
    });
    expect([await viewing.state(), await viewing.episodes(of(a, NL))]).toEqual(before);
    expect(events()).toBe(written);

    database((db) => db.exec("drop trigger full"));
    const marked = await mark(viewing, episode(a, 1, 1), true, "mark");
    expect((await viewing.episodes(of(a, NL))).marks).toEqual([marked]);
    expect(events()).toBe(Number(written) + 1);
  });
});

describe("taking a mark back", () => {
  it("puts the episode's progress and Continue watching back exactly as they were", async () => {
    const { viewing, a, moveOn } = await marksApp();
    await play(viewing, episode(a, 1, 1), 2690);
    moveOn();
    await play(viewing, episode(a, 1, 2), 900);
    const before = await recordOf(viewing);
    const episodes = await viewing.episodes(of(a, NL));
    moveOn();
    const marked = await mark(viewing, episode(a, 1, 2), true);
    expect(await goesOn(viewing)).toEqual([[NL, "1:3"]]);
    moveOn();

    await viewing.undoMark("undo", of(a, NL), marked?.revision ?? 0);

    expect(await recordOf(viewing)).toEqual(before);
    expect(await viewing.episodes(of(a, NL))).toEqual(episodes);
    // Sent again, it changes nothing more and fails nothing.
    await viewing.undoMark("undo", of(a, NL), marked?.revision ?? 0);
    expect(await viewing.episodes(of(a, NL))).toEqual(episodes);
  });

  it("puts back how far the episode had got, whatever the play that was going saved since", async () => {
    const { viewing, a, moveOn } = await marksApp();
    const began = Date.now();
    await play(viewing, episode(a, 1, 1), 900, began);
    const before = await recordOf(viewing);
    const episodes = await viewing.episodes(of(a, NL));
    moveOn();
    const marked = await mark(viewing, episode(a, 1, 1), true);

    // The play that was going saves on, in the file and in an older file of the episode, and
    // reaches its credits.
    moveOn();
    await play(viewing, episode(a, 1, 1), 1200, began);
    await play(viewing, { ...episode(a, 1, 1), id: "an-older-file" }, 1500, began);
    moveOn();
    await play(viewing, episode(a, 1, 1), 2690, began);
    expect((await viewing.episodes(of(a, NL))).progress).toEqual(episodes.progress);

    await viewing.undoMark(randomUUID(), of(a, NL), marked?.revision ?? 0);

    expect(await viewing.episodes(of(a, NL))).toEqual(episodes);
    expect(await recordOf(viewing)).toEqual(before);
    // With the mark gone, the play that goes on counts again.
    moveOn();
    await play(viewing, episode(a, 1, 1), 1260, began);
    expect((await viewing.episodes(of(a, NL))).progress).toMatchObject([
      { position: 1260, since: began },
    ]);
  });

  it("puts back the mark the episode had before, with where the series went on then", async () => {
    const { viewing, a, moveOn } = await marksApp();
    const watched = await mark(viewing, episode(a, 1, 1), true);
    const before = await recordOf(viewing);
    moveOn();
    const unwatched = await mark(viewing, episode(a, 1, 1), false);
    expect(await goesOn(viewing)).toEqual([[NL, "1:1"]]);

    await viewing.undoMark(randomUUID(), of(a, NL), unwatched?.revision ?? 0);

    expect((await viewing.episodes(of(a, NL))).marks).toEqual([watched]);
    expect(await recordOf(viewing)).toEqual(before);
    // The one put back was made before: its own Undo is past.
    await expect(
      viewing.undoMark(randomUUID(), of(a, NL), watched?.revision ?? 0),
    ).rejects.toMatchObject({ error: { kind: "mark-changed" } });
  });

  it("refuses once the series was marked again, and changes nothing", async () => {
    const { viewing, a, moveOn } = await marksApp();
    const first = await mark(viewing, episode(a, 1, 1), true);
    moveOn();
    const second = await mark(viewing, episode(a, 1, 2), true);
    const marks = (await viewing.episodes(of(a, NL))).marks;

    await expect(
      viewing.undoMark(randomUUID(), of(a, NL), first?.revision ?? 0),
    ).rejects.toMatchObject({ error: { kind: "mark-changed" } });

    expect((await viewing.episodes(of(a, NL))).marks).toEqual(marks);
    await viewing.undoMark(randomUUID(), of(a, NL), second?.revision ?? 0);
    expect((await viewing.episodes(of(a, NL))).marks).toEqual([first]);
  });

  it("refuses once a play of the series began after the mark, in any version of it", async () => {
    const { viewing, a, moveOn } = await marksApp();
    const marked = await mark(viewing, episode(a, 1, 1), true);
    moveOn();
    await play(viewing, { ...episode(a, 1, 2, EN), id: "799981" }, 300);

    // The window is told so, by the rule the Undo itself goes by.
    expect((await viewing.episodes(of(a, NL))).undoable).toBeNull();
    await expect(
      viewing.undoMark(randomUUID(), of(a, NL), marked?.revision ?? 0),
    ).rejects.toMatchObject({ error: { kind: "mark-changed" } });
    expect((await viewing.episodes(of(a, NL))).marks).toEqual([marked]);
  });
});

describe("a mark and what plays", () => {
  it("stands against the progress and the end of a play that began before it", async () => {
    const { viewing, a, moveOn } = await marksApp();
    const began = Date.now();
    await play(viewing, episode(a, 2, 2), 600, began);
    const played = (await viewing.episodes(of(a, NL))).progress;
    moveOn();
    const marked = await mark(viewing, episode(a, 2, 2), false);
    const stands = await recordOf(viewing);

    // That play saves on, reaches the credits of the series' last episode and says so.
    moveOn();
    await play(viewing, episode(a, 2, 2), 2690, began);
    await viewing.finishSeries(randomUUID(), [of(a, NL), of(a, EN)], began);

    // The mark, where it said the series goes on and what the episode held when it was marked
    // are as they were, and the mark can be taken back.
    expect(await recordOf(viewing)).toEqual(stands);
    expect(await goesOn(viewing)).toEqual([[NL, "2:2"]]);
    expect(await viewing.episodes(of(a, NL))).toEqual({
      progress: played,
      marks: [marked],
      undoable: marked?.revision,
    });
  });

  it("gives way to a play begun after it, which a late word of the play before never replaces", async () => {
    const { viewing, a, moveOn } = await marksApp();
    const began = Date.now();
    await play(viewing, episode(a, 1, 1), 900, began);
    moveOn();
    const marked = await mark(viewing, episode(a, 1, 1), true);
    const again = moveOn();
    await play(viewing, episode(a, 1, 1), 300, again);
    const replayed = await recordOf(viewing);
    const episodes = await viewing.episodes(of(a, NL));
    expect(episodes).toMatchObject({
      progress: [{ position: 300, since: again }],
      marks: [marked],
      undoable: null,
    });

    // A checkpoint of the play from before the mark arrives only now.
    moveOn();
    await play(viewing, episode(a, 1, 1), 1200, began);

    expect(await viewing.episodes(of(a, NL))).toEqual(episodes);
    expect(await recordOf(viewing)).toEqual(replayed);
    await expect(
      viewing.undoMark(randomUUID(), of(a, NL), marked?.revision ?? 0),
    ).rejects.toMatchObject({ error: { kind: "mark-changed" } });
  });

  it("keeps the play begun last for a title without marks too, a movie as an episode", async () => {
    const { viewing, a, moveOn } = await marksApp();
    const movie: TitleRef = { kind: "movie", subscriptionId: a, id: "91000" };
    const began = Date.now();
    await play(viewing, movie, 900, began);
    const again = moveOn();
    await play(viewing, movie, 300, again);

    moveOn();
    await play(viewing, movie, 1200, began);

    expect(await viewing.progress({ movies: [of(a, movie.id)] })).toMatchObject([
      { position: 300, since: again, at: again },
    ]);
  });

  it("follows what a play from before it watches of the episodes after it", async () => {
    const { viewing, a, moveOn } = await marksApp();
    const began = Date.now();
    await play(viewing, episode(a, 1, 2), 600, began);
    moveOn();
    await mark(viewing, episode(a, 1, 1), true);
    expect(await goesOn(viewing)).toEqual([[NL, "1:2"]]);

    // The second episode, which was playing, is watched to its end.
    moveOn();
    await play(viewing, episode(a, 1, 2), 2690, began);

    expect(await goesOn(viewing)).toEqual([[NL, "1:3"]]);
  });

  it("goes nowhere once a play from before it watches the last episode left, and stays marked", async () => {
    const { viewing, a, moveOn } = await marksApp();
    const began = Date.now();
    await play(viewing, episode(a, 2, 2), 600, began);
    let last = null;
    for (const [season, number] of ALL_BUT_LAST) {
      moveOn();
      last = await mark(viewing, episode(a, season, number), true);
    }
    expect(await goesOn(viewing)).toEqual([[NL, "2:2"]]);

    moveOn();
    await play(viewing, episode(a, 2, 2), 2690, began);
    await viewing.finishSeries(randomUUID(), [of(a, NL), of(a, EN)], began);

    // Every numbered episode is watched: nothing is offered, and the latest mark can go back.
    expect(await goesOn(viewing)).toEqual([[NL, null]]);
    expect((await viewing.episodes(of(a, NL))).undoable).toBe(last?.revision);
    await viewing.undoMark(randomUUID(), of(a, NL), last?.revision ?? 0);
    expect(await goesOn(viewing)).toEqual([[NL, "2:1"]]);
  });

  it("gives way to a play begun after it, whose end takes the series out of Continue watching", async () => {
    const { viewing, a, moveOn } = await marksApp();
    let marked = null;
    for (const [season, number] of ALL_BUT_LAST) {
      marked = await mark(viewing, episode(a, season, number), true);
      moveOn();
    }
    const began = Date.now();

    await play(viewing, episode(a, 2, 2), 2690, began);
    await viewing.finishSeries(randomUUID(), [of(a, NL), of(a, EN)], began);

    const state = await viewing.state();
    expect([state.marked, state.continueWatching]).toEqual([[], []]);
    const { progress } = await viewing.episodes(of(a, NL));
    expect(progress[0]?.since).toBeGreaterThan(marked?.at ?? Infinity);
  });

  it("goes on by the episodes its version lists now, once the app read them again", async () => {
    const { viewing, onDemand, a, first, moveOn } = await marksApp();
    // Both episodes of a series marked watched: it has nowhere to go on.
    await mark(viewing, episode(a, 1, 1, ALONE), true);
    moveOn();
    const last = await mark(viewing, episode(a, 1, 2, ALONE), true);
    expect(await goesOn(viewing)).toEqual([[ALONE, null]]);

    // The provider adds a third, which the series' details list when they are opened next.
    first.serveTitles((all) => ({
      ...all,
      series: all.series.map((each) => {
        const [season = []] = each.seasons;
        const [file] = season;
        return String(each.id) === ALONE && file
          ? { ...each, seasons: [[...season, { ...file, id: 800_012 }]] }
          : each;
      }),
    }));
    await onDemand.refresh(a);
    const details = await onDemand.details("series", of(a, ALONE));
    const seasons = details.kind === "series" ? details.seasons : [];
    await viewing.relist(randomUUID(), of(a, ALONE), seasons);

    expect(await goesOn(viewing)).toEqual([[ALONE, "1:3"]]);
    // Its marks and their Undo are as they were, and reading the same list again changes nothing.
    expect(await viewing.episodes(of(a, ALONE))).toMatchObject({
      marks: [{ episode: 1 }, { episode: 2 }],
      undoable: last?.revision,
    });
    const { sequence } = await viewing.state();
    await viewing.relist(randomUUID(), of(a, ALONE), seasons);
    // Nor does another series' list, or one without episodes.
    await viewing.relist(randomUUID(), of(a, OTHER), seasons.slice(0, 0));
    await viewing.relist(randomUUID(), of(a, NL), seasons);
    expect(await viewing.state()).toMatchObject({ sequence });
    expect(await goesOn(viewing)).toEqual([[ALONE, "1:3"]]);
  });

  it("leaves Continue watching with its series, and returns with the next mark, whose Undo hides it again", async () => {
    const { viewing, a, moveOn } = await marksApp();
    const first = await mark(viewing, episode(a, 1, 1), true);
    moveOn();

    // Nothing of the series was played: the mark alone holds it in the row.
    await viewing.removeFromContinue(randomUUID(), { series: [of(a, NL), of(a, EN)] });

    expect((await viewing.state()).marked).toEqual([]);
    expect(await viewing.episodes(of(a, NL))).toMatchObject({ marks: [first], undoable: null });
    await expect(
      viewing.undoMark(randomUUID(), of(a, NL), first?.revision ?? 0),
    ).rejects.toMatchObject({ error: { kind: "mark-changed" } });

    moveOn();
    const second = await mark(viewing, episode(a, 1, 2), true);
    expect(await goesOn(viewing)).toEqual([[NL, "1:3"]]);
    await viewing.undoMark(randomUUID(), of(a, NL), second?.revision ?? 0);
    expect((await viewing.state()).marked).toEqual([]);
  });

  it("stays out of Continue watching for a play that was going when the series was taken out", async () => {
    const { viewing, a, moveOn } = await marksApp();
    // An episode plays, and has saved nothing yet, when another is marked and the series removed.
    const began = Date.now();
    moveOn();
    await mark(viewing, episode(a, 1, 1), true);
    moveOn();
    await viewing.removeFromContinue(randomUUID(), { series: [of(a, NL), of(a, EN)] });

    moveOn();
    await play(viewing, episode(a, 1, 2), 900, began);

    const state = await viewing.state();
    expect([state.marked, state.continueWatching]).toEqual([[], []]);
    // One begun afterwards brings it back.
    const again = moveOn();
    await play(viewing, episode(a, 1, 2), 1000, again);
    expect((await viewing.state()).continueWatching).toMatchObject([{ position: 1000 }]);
  });
});

describe("what a mark is kept by", () => {
  it("holds for every version of the series its subscription lists, and for a row the series is listed under anew", async () => {
    const { viewing, onDemand, a, first, moveOn } = await marksApp();
    await play(viewing, { ...episode(a, 1, 1, EN), id: "799980" }, 2690);
    moveOn();
    const marked = await mark(viewing, episode(a, 1, 2), true);

    // Read by the English version: the same marks, and both versions' files.
    const english = await viewing.episodes(of(a, EN));
    expect(english).toEqual(await viewing.episodes(of(a, NL)));
    expect(english.marks).toEqual([marked]);
    expect(english.progress.map(({ title }) => title.id)).toEqual(["799980"]);

    // The provider drops the Dutch row and lists the English one under another id.
    first.serveTitles((all) => ({
      ...all,
      series: all.series.flatMap((each) =>
        String(each.id) === NL ? [] : String(each.id) === EN ? [{ ...each, id: 70_001 }] : [each],
      ),
    }));
    await onDemand.refresh(a);

    expect((await viewing.episodes(of(a, "70001"))).marks).toEqual([marked]);
  });

  /** Lists the two series that stand alone with the TMDB ids given, "0" for none. */
  const listAlone = async (
    { onDemand, a, first }: Awaited<ReturnType<typeof marksApp>>,
    tmdb: { readonly [id: string]: string },
    name?: string,
  ) => {
    first.serveTitles((all) => ({
      ...all,
      series: all.series.map((each) => {
        const id = tmdb[String(each.id)];
        return id === undefined ? each : { ...each, tmdb: id, ...(name ? { name } : {}) };
      }),
    }));
    await onDemand.refresh(a);
  };

  it("goes by the provider's id for a series without a TMDB id, and never by its name", async () => {
    const app = await marksApp();
    const { viewing, a } = app;
    // Two rows TMDB doesn't know, under one name.
    await listAlone(app, { [ALONE]: "0", [OTHER]: "0" }, "Same Name (NL)");

    const marked = await mark(viewing, episode(a, 1, 1, ALONE), true);

    expect((await viewing.episodes(of(a, ALONE))).marks).toEqual([marked]);
    expect((await viewing.episodes(of(a, OTHER))).marks).toEqual([]);
    expect((await viewing.state()).marked).toMatchObject([{ kept: `id:${ALONE}` }]);
  });

  it("stays with a row that gets a TMDB id, and holds for the version that joins it there", async () => {
    const app = await marksApp();
    const { viewing, a, moveOn } = app;
    await listAlone(app, { [ALONE]: "0", [OTHER]: "0" });
    const made = await mark(viewing, episode(a, 1, 1, ALONE), true);

    // The provider gives both rows one TMDB id: the lists now show them as one series.
    await listAlone(app, { [ALONE]: "777777", [OTHER]: "777777" });

    expect(await viewing.episodes(of(a, ALONE))).toMatchObject({
      marks: [made],
      undoable: made?.revision,
    });
    expect((await viewing.episodes(of(a, OTHER))).marks).toEqual([made]);
    expect(await goesOn(viewing)).toEqual([[ALONE, "1:2"]]);

    // Marked on in the other version: one series' marks, and one Undo, the latest.
    moveOn();
    const next = await mark(viewing, episode(a, 1, 2, OTHER), true);
    expect((await viewing.episodes(of(a, ALONE))).marks).toEqual([made, next]);
    expect((await viewing.state()).marked).toMatchObject([{ kept: "tmdb:777777" }, {}]);
    await expect(
      viewing.undoMark(randomUUID(), of(a, ALONE), made?.revision ?? 0),
    ).rejects.toMatchObject({ error: { kind: "mark-changed" } });
    await viewing.undoMark(randomUUID(), of(a, OTHER), next?.revision ?? 0);
    expect((await viewing.episodes(of(a, OTHER))).marks).toEqual([made]);
    // The first one's Undo passed with the second mark, taken back or not.
    await expect(
      viewing.undoMark(randomUUID(), of(a, ALONE), made?.revision ?? 0),
    ).rejects.toMatchObject({ error: { kind: "mark-changed" } });
  });

  it("waits while its row has another TMDB id or none, and is never another series'", async () => {
    const app = await marksApp();
    const { viewing, a } = app;
    await listAlone(app, { [ALONE]: "777777", [OTHER]: "0" });
    const made = await mark(viewing, episode(a, 1, 1, ALONE), true);
    const none = { progress: [], marks: [], undoable: null };

    // The row loses its TMDB id: a provider gives a dropped row's id to another series.
    await listAlone(app, { [ALONE]: "0", [OTHER]: "0" });
    expect(await viewing.episodes(of(a, ALONE))).toEqual(none);

    // It is given another, which the other row has too: neither takes the mark.
    await listAlone(app, { [ALONE]: "888888", [OTHER]: "888888" });
    expect(await viewing.episodes(of(a, ALONE))).toEqual(none);
    expect(await viewing.episodes(of(a, OTHER))).toEqual(none);

    // The id it was marked under moves to the other row: the series is that row now.
    await listAlone(app, { [ALONE]: "0", [OTHER]: "777777" });
    expect(await viewing.episodes(of(a, ALONE))).toEqual(none);
    expect((await viewing.episodes(of(a, OTHER))).marks).toEqual([made]);

    // And back where it was, it holds as it did.
    await listAlone(app, { [ALONE]: "777777", [OTHER]: "0" });
    expect(await viewing.episodes(of(a, ALONE))).toEqual({
      progress: [],
      marks: [made],
      undoable: made?.revision,
    });
  });

  it("stays in the record of the subscription it was made in, under ids another uses too", async () => {
    const { viewing, roster, onDemand, a, b, first, login, moveOn } = await marksApp({
      both: true,
    });
    // Both list the series under one TMDB id, with the same series and episode ids.
    const mine = await mark(viewing, episode(a, 1, 1), true);
    expect(await viewing.episodes(of(b, NL))).toEqual({ progress: [], marks: [], undoable: null });
    moveOn();
    const theirs = await mark(viewing, episode(b, 1, 2), false);
    expect((await viewing.episodes(of(a, NL))).marks).toEqual([mine]);
    expect((await viewing.state()).marked.map(({ series }) => series)).toEqual([
      of(b, NL),
      of(a, NL),
    ]);

    // Taking one back leaves the other's.
    await viewing.undoMark(randomUUID(), of(b, NL), theirs?.revision ?? 0);
    expect((await viewing.episodes(of(a, NL))).marks).toEqual([mine]);

    // Its subscription removed, the record keeps it for when the account is added again.
    await roster.remove(a, false);
    expect((await viewing.state()).marked).toEqual([]);
    const again = (await roster.add(login(first.url))).id;
    expect(again).not.toBe(a);
    // Its lists say which series the marks are of.
    await onDemand.refresh(again);
    expect((await viewing.episodes(of(again, NL))).marks).toEqual([mine]);
    expect((await viewing.state()).marked.map(({ series }) => series)).toEqual([of(again, NL)]);
  });
});

// Each starts the app two or three times, on two providers' lists: two to six seconds beside the
// rest of the suite, where one start alone takes up to three.
describe("marks on disk", { timeout: 20_000 }, () => {
  /** Drops everything worked out from the events, as a change to the record's rules does. */
  const dropState = (db: DatabaseSync) =>
    db.exec(
      "delete from state; delete from titles; delete from marked_episodes; delete from marked_series; delete from meta where key = 'state-version';",
    );

  /**
   * A record with a history of every kind: marks made, replaced and taken back, a play from
   * before a mark that saves on, one that arrives late, and a series only marked that leaves
   * Continue watching while a play from before goes on. Answers the last mark made.
   */
  async function history({ viewing, a, moveOn }: Awaited<ReturnType<typeof marksApp>>) {
    const began = Date.now();
    await play(viewing, episode(a, 1, 2), 900, began);
    moveOn();
    await mark(viewing, episode(a, 1, 1), true);
    moveOn();
    await mark(viewing, episode(a, 1, 1), false);
    moveOn();
    const undone = await mark(viewing, episode(a, 2, 1), false);
    await viewing.undoMark(randomUUID(), of(a, NL), undone?.revision ?? 0);
    moveOn();
    await mark(viewing, episode(a, 1, 2), true);
    // The play from before that mark saves on, and so does one of another episode.
    moveOn();
    await play(viewing, episode(a, 1, 2), 1500, began);
    await play(viewing, episode(a, 2, 1), 2690, began);
    // A series only marked leaves Continue watching, and a play from before then saves.
    moveOn();
    await mark(viewing, episode(a, 1, 1, ALONE), true);
    moveOn();
    await viewing.removeFromContinue(randomUUID(), { series: [of(a, ALONE)] });
    moveOn();
    await play(viewing, { ...episode(a, 1, 2, ALONE), id: "800011" }, 900, began);
    moveOn();
    const last = await mark(viewing, episode(a, 1, 3), true);
    // The series is read again with one episode fewer than it listed when it was marked.
    await viewing.relist(randomUUID(), of(a, NL), [
      { number: 1, episodes: [1, 2, 3].map((number) => ({ id: "", season: 1, number })) },
      { number: 2, episodes: [{ id: "", season: 2, number: 1 }] },
    ]);
    return last;
  }

  /** Everything the window reads of the two series marked. */
  const read = async (viewing: Viewing, a: string) => [
    await viewing.state(),
    await viewing.episodes(of(a, NL)),
    await viewing.episodes(of(a, ALONE)),
  ];

  it("keeps them, where each series goes on and their Undo across a restart, and adds up to the same, Undo too, when the record is rebuilt from its events", async () => {
    const app = await marksApp();
    const { viewing, a, database, moveOn } = app;
    const last = await history(app);
    const before = await read(viewing, a);
    // Every episode it lists now is watched but the first, which was marked unwatched.
    expect(await goesOn(viewing)).toEqual([[NL, "1:1"]]);
    expect(before[1]).toMatchObject({ progress: [{ position: 900 }, { position: 2690 }] });
    /** The marks of the series once its latest mark was taken back: as they were before it. */
    const undone = [
      { season: 1, episode: 1, watched: false },
      { season: 1, episode: 2, watched: true },
    ];

    const restarted = (await app.start()).viewing;
    expect(await read(restarted, a)).toEqual(before);
    // The latest mark can still be taken back, to what it replaced.
    await restarted.undoMark(randomUUID(), of(a, NL), last?.revision ?? 0);
    expect((await restarted.episodes(of(a, NL))).marks).toMatchObject(undone);
    // Marked again, so the events the record is rebuilt from hold a mark taken back too.
    moveOn();
    const again = await mark(restarted, episode(a, 1, 3), true);
    const marked = await read(restarted, a);

    database(dropState);
    const rebuilt = (await app.start()).viewing;
    expect(await read(rebuilt, a)).toEqual(marked);
    await rebuilt.undoMark(randomUUID(), of(a, NL), again?.revision ?? 0);
    expect((await rebuilt.episodes(of(a, NL))).marks).toMatchObject(undone);
  });

  it("survive a build from before marks, whose later play of the episode takes over", async () => {
    const app = await marksApp();
    const { viewing, a, subscriptions, moveOn, database } = app;
    const marked = await mark(viewing, episode(a, 1, 1), true);
    const account = (await subscriptions.saved())[0]?.key ?? "";
    const at = moveOn();
    const { subscriptionId: _owner, ...title } = episode(a, 1, 1);
    // What such a build does: it drops and makes its title rows without this build's columns,
    // never looks at the marks, and saves a play the way it always did.
    database((db) => {
      db.exec("delete from titles; alter table titles drop column since;");
      db.prepare(
        "insert into events (account, type, version, channel_id, at, command_id, payload) values (?, 'title-progress', 1, '', ?, 'older', ?)",
      ).run(account, at, JSON.stringify({ title, position: 900, duration: 2700, since: at }));
      db.prepare(
        "insert into titles (account, key, title, series_id, position, duration, finished, at, hidden, removed_at) values (?, ?, ?, ?, 900, 2700, 0, ?, 0, null)",
      ).run(account, `episode:${title.id}`, JSON.stringify(title), title.seriesId, at);
    });

    const returned = (await app.start()).viewing;

    const { progress, marks } = await returned.episodes(of(a, NL));
    expect(marks).toEqual([marked]);
    // Its play began after the mark, as far as anything says: it stands, and the Undo is past.
    expect(progress).toMatchObject([{ position: 900, at, since: at }]);
    await expect(
      returned.undoMark(randomUUID(), of(a, NL), marked?.revision ?? 0),
    ).rejects.toMatchObject({ error: { kind: "mark-changed" } });
  });

  it("go at the next start when a build from before marks erased their account", async () => {
    const app = await marksApp({ both: true });
    const { viewing, subscriptions, a, b, dataDir, database } = app;
    await mark(viewing, episode(a, 1, 1), true);
    const kept = await mark(viewing, episode(b, 1, 1), true);
    const key = (await subscriptions.saved()).find((each) => each.id === a)?.key ?? "";
    // What such a build's erase deletes, for good: the account's events and what it worked out
    // from them, and nothing of the tables it never heard of.
    database((db) => {
      db.exec("pragma secure_delete = on");
      for (const table of ["events", "state", "titles"]) {
        db.prepare(`delete from ${table} where account = ?`).run(key);
      }
      db.exec("pragma wal_checkpoint(truncate)");
    });

    const returned = (await app.start()).viewing;

    expect(await returned.episodes(of(a, NL))).toEqual({ progress: [], marks: [], undoable: null });
    expect((await returned.state()).marked.map(({ series }) => series)).toEqual([of(b, NL)]);
    expect((await returned.episodes(of(b, NL))).marks).toEqual([kept]);
    const file = Buffer.concat(
      await Promise.all(
        ["mrstreamer.db", "mrstreamer.db-wal"].map((name) =>
          readFile(join(dataDir, name)).catch(() => Buffer.alloc(0)),
        ),
      ),
    );
    expect(key).not.toBe("");
    expect(file.includes(key)).toBe(false);
  });

  it("go for good with their account's record, and only that account's", async () => {
    const app = await marksApp({ both: true });
    const { viewing, roster, subscriptions, a, b, dataDir, database, moveOn } = app;
    await mark(viewing, episode(a, 1, 1), true);
    moveOn();
    await mark(viewing, episode(a, 1, 2), true);
    moveOn();
    const kept = await mark(viewing, episode(b, 1, 1), true);
    const key = (await subscriptions.saved()).find((each) => each.id === a)?.key ?? "";

    await roster.remove(a, true);

    // Nothing of it stays in the file, for this build or an older one to find.
    const file = Buffer.concat(
      await Promise.all(
        ["mrstreamer.db", "mrstreamer.db-wal"].map((name) =>
          readFile(join(dataDir, name)).catch(() => Buffer.alloc(0)),
        ),
      ),
    );
    expect(key).not.toBe("");
    expect(file.includes(key)).toBe(false);
    // Nor does a rebuild from the events bring any of it back.
    database(dropState);
    const rebuilt = (await app.start()).viewing;
    expect((await rebuilt.state()).marked.map(({ series }) => series)).toEqual([of(b, NL)]);
    expect((await rebuilt.episodes(of(b, NL))).marks).toEqual([kept]);
  });
});
