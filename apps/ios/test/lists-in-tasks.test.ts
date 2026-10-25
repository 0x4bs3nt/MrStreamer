import {
  byIds,
  indexCatalogue,
  indexSteps,
  kindOf,
  searchPage,
  type CatalogueSource,
} from "@mrstreamer/core/ondemand/catalogue";
import { xtreamProvider } from "@mrstreamer/core/xtream";
import { describe, expect, it, vi } from "vitest";
import { inTasks } from "../src/library.ts";

// Long movie and series lists read and indexed a few slices per task, as the iOS app does: other
// work runs between the tasks, the lists come out as reading and indexing them at once gives
// them, and the work stops when its load is aborted.

/** Competing input tasks during work whose scheduler clock advances independently of host speed. */
async function alongside<A>(work: () => Promise<A>): Promise<{ result: A; tasks: number }> {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => ++now);
  let tasks = 0;
  let timer = setTimeout(function task() {
    tasks += 1;
    timer = setTimeout(task, 0);
  }, 0);
  try {
    return { result: await work(), tasks };
  } finally {
    clearTimeout(timer);
    clock.mockRestore();
  }
}

/**
 * A panel's movie and series rows, as its API sends them: language versions of one film under a
 * TMDB id, some without one, some for adults, ids listed twice, and rows no schema accepts.
 */
function panelRows(count: number, offset: number) {
  const tags = ["EN", "NL", "4K", "MULTI"];
  const movies: unknown[] = [];
  const series: unknown[] = [];
  for (let at = 0; at < count; at++) {
    const film = Math.floor((at + offset) / 3);
    const row = {
      name: `${tags[at % tags.length]} - Film ${film}${at % 7 === 0 ? ` (${1990 + (film % 30)})` : ""}`,
      category_id: at % 50 === 0 ? "adult" : "films",
      rating: String((at % 10) + 0.5),
      added: String(1_700_000_000 + at),
      tmdb: at % 5 === 0 ? "" : String(1000 + film),
      is_adult: at % 211 === 0 ? 1 : 0,
    };
    movies.push({ ...row, stream_id: at % 97 === 0 ? 1 : at + 1, container_extension: "mkv" });
    if (at % 4 === 0) series.push({ ...row, series_id: at + 1, last_modified: row.added });
  }
  // No id, an id of the wrong type, and no row at all.
  movies.push({ name: "No id" }, { stream_id: { id: 1 }, name: "Odd id" }, null);
  series.push({ name: "No id" }, "a series");
  return { movies, series };
}

const categories = [
  { category_id: "films", category_name: "Films" },
  { category_id: "adult", category_name: "XXX Adults" },
];

/** A provider reading `rows` from a panel, at once or with `inTasks`. */
function panel(rows: { readonly movies: unknown; readonly series: unknown }, tasks: boolean) {
  return xtreamProvider(
    { server: "http://panel.test", username: "fixture", password: "secret" },
    {
      userAgent: "fixture",
      ...(tasks ? { inTasks } : {}),
      fetch: async (input) => {
        const action = new URL(String(input)).searchParams.get("action") ?? "";
        if (action.endsWith("categories")) return Response.json(categories);
        return Response.json(action === "get_series" ? rows.series : rows.movies);
      },
    },
  );
}

const shown = (catalogue: ReturnType<typeof indexCatalogue>) =>
  (["movie", "series"] as const).map((kind) => ({
    titles: kindOf(catalogue, kind).titles,
    found: byIds(catalogue, kind, [
      { subscriptionId: "b", id: "2" },
      { subscriptionId: "a", id: "1" },
    ]),
    search: searchPage(catalogue, kind, "film 12"),
  }));

describe("movie and series lists read and indexed in tasks", () => {
  it("lets other tasks run while a panel's rows are read, and reads what reading them at once reads", async () => {
    const rows = panelRows(20_000, 0);
    const { result, tasks } = await alongside(() => panel(rows, true).onDemandCatalogue());
    expect(tasks).toBeGreaterThan(2);
    expect(result).toEqual(await panel(rows, false).onDemandCatalogue());
    expect(result.movies.length).toBeLessThan(rows.movies.length);
  });

  it("indexes both kinds between other tasks into the catalogue indexing them at once gives", async () => {
    const sources: CatalogueSource[] = [
      {
        subscriptionId: "a",
        catalogue: await panel(panelRows(3000, 0), false).onDemandCatalogue(),
      },
      {
        subscriptionId: "b",
        catalogue: await panel(panelRows(2000, 1500), false).onDemandCatalogue(),
      },
    ];
    for (const language of ["nl", "en"]) {
      const { result, tasks } = await alongside(() =>
        inTasks(indexSteps(sources, language), () => true),
      );
      expect(tasks).toBeGreaterThan(2);
      if (!result) throw new Error("Stopped");
      expect(shown(result)).toEqual(shown(indexCatalogue(sources, language)));
    }
  });

  it("gathers thousands of versions of one film between other tasks, as indexing at once does", async () => {
    // Every row of both panels under one TMDB id: one title, its versions in the viewer's order.
    const sameFilm = (count: number, offset: number) => {
      const rows = panelRows(count, offset);
      const film = (row: unknown) => ({
        ...(row as object),
        tmdb: "42",
        is_adult: 0,
        category_id: "films",
      });
      return { movies: rows.movies.slice(0, count).map(film), series: rows.series.map(film) };
    };
    const sources: CatalogueSource[] = [
      { subscriptionId: "a", catalogue: await panel(sameFilm(4000, 0), false).onDemandCatalogue() },
      { subscriptionId: "b", catalogue: await panel(sameFilm(3000, 9), false).onDemandCatalogue() },
    ];
    const { result, tasks } = await alongside(() => inTasks(indexSteps(sources, "nl"), () => true));
    expect(tasks).toBeGreaterThan(2);
    if (!result) throw new Error("Stopped");
    const most = Math.max(...kindOf(result, "movie").titles.map((title) => title.versions.length));
    expect(most).toBeGreaterThan(3000);
    expect(shown(result)).toEqual(shown(indexCatalogue(sources, "nl")));
  });

  it.each([new Error("Left"), null, false])(
    "stops reading rows once the load is aborted, and fails with its reason, %j",
    async (reason) => {
      const controller = new AbortController();
      const reading = panel(panelRows(3000, 0), true).onDemandCatalogue(controller.signal);
      // The bodies have arrived and their rows are being read when the load is left.
      await new Promise((done) => setTimeout(done, 0));
      controller.abort(reason);
      await expect(reading).rejects.toBe(reason);
    },
  );

  it("refuses the login when a catalogue request answers HTTP 401", async () => {
    const refusing = xtreamProvider(
      { server: "http://panel.test", username: "fixture", password: "secret" },
      { userAgent: "fixture", inTasks, fetch: async () => new Response(null, { status: 401 }) },
    );
    await expect(refusing.onDemandCatalogue()).rejects.toMatchObject({
      error: { kind: "invalid-login" },
    });
  });

  it("refuses a catalogue response that is not JSON", async () => {
    // An answer that isn't JSON at all is no Xtream API.
    const garbled = xtreamProvider(
      { server: "http://panel.test", username: "fixture", password: "secret" },
      { userAgent: "fixture", inTasks, fetch: async () => new Response("<html>") },
    );
    await expect(garbled.onDemandCatalogue()).rejects.toMatchObject({
      error: { kind: "unreachable" },
    });
  });

  it("stops indexing once it is no longer wanted, leaving nothing half made", async () => {
    const catalogue = await panel(panelRows(20_000, 0), false).onDemandCatalogue();
    // Wanted for the first task only: the load is left after one task of work.
    let asked = 0;
    const left = await inTasks(
      indexSteps([{ subscriptionId: "a", catalogue }], "en"),
      () => ++asked < 2,
    );
    expect(left).toBeNull();
    // Indexing the same lists again gives what lists never indexed before give.
    const again = indexCatalogue([{ subscriptionId: "a", catalogue }], "en");
    const fresh = indexCatalogue([{ subscriptionId: "a", catalogue: { ...catalogue } }], "en");
    expect(shown(again)).toEqual(shown(fresh));
  });
});
