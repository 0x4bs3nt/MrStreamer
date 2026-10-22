import {
  indexCatalogue,
  searchPage,
  type CatalogueSource,
} from "@mrstreamer/core/ondemand/catalogue";
import { factsOf, titleOf, type SavedMember } from "@mrstreamer/core/ondemand/watchlist";
import { xtreamProvider } from "@mrstreamer/core/xtream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeProvider } from "../../desktop/test/fake-provider.ts";
import { tmdbName } from "../../desktop/test/fake-tmdb.ts";
import {
  BROWSE_MATCHES,
  BROWSE_QUERY,
  browseControls,
  browseTitles,
} from "../scripts/browse-profile.ts";

// The simulator fixture's browse profile (scripts/fixture-server.ts, FIXTURE_PROFILE=browse) as
// the app reads it: both providers' lists over HTTP, through core's catalogue, Search and the
// watchlist's identity, with the profile's controls changing what the panels answer.

type Controls = ReturnType<typeof browseControls>;

/** A provider as the fixture server starts it with the profile, and its controls. */
async function start(second: boolean) {
  const login = { username: "fixture", password: second ? "second-pass" : "fixture-pass" };
  const provider = await startFakeProvider({
    ...login,
    second,
    titlesOf: (built) => browseTitles(built, second),
  });
  return { provider, controls: browseControls(provider, second), login };
}

/** Answers a control route the way the fixture server's control port does. */
function control(controls: Controls, route: string) {
  const answered = controls.control("POST", new URL(route, "http://control.test"));
  if (!answered) throw new Error(`no route ${route}`);
  return answered;
}

describe("the browse profile", () => {
  let first: Awaited<ReturnType<typeof start>>;
  let second: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    [first, second] = await Promise.all([start(false), start(true)]);
  });
  afterAll(async () => {
    for (const each of [first, second]) {
      each.controls.stop();
      await each.provider.close();
    }
  });

  /** Both providers' lists as the app reads them now. */
  async function lists(): Promise<CatalogueSource[]> {
    return Promise.all(
      (
        [
          ["alpha", first],
          ["beta", second],
        ] as const
      ).map(async ([subscriptionId, { provider, login }]) => ({
        subscriptionId,
        catalogue: await xtreamProvider(
          { server: provider.url, ...login },
          { userAgent: "fixture" },
        ).onDemandCatalogue(),
      })),
    );
  }

  it("has Search find the declared matches of each kind, in the declared order", async () => {
    const { search } = first.controls.declared;
    if (!search) throw new Error("the first provider declares its search");
    const sources = await lists();
    const raw = sources[0]!.catalogue;
    for (const kind of ["movies", "series"] as const) {
      const rows = raw[kind].filter((row) => row.name.includes(BROWSE_QUERY));
      expect(rows).toHaveLength(search.rows);
    }
    // With the first provider alone or both, in two languages, before and after TMDB's names.
    for (const listed of [sources.slice(0, 1), sources]) {
      for (const language of ["en", "nl"]) {
        const catalogue = indexCatalogue(listed, language);
        for (const named of [false, true]) {
          const aliases = named
            ? (title: { readonly tmdbId: string | null }) => {
                const names = tmdbName(Number(title.tmdbId), language);
                return { title: names.name, original: names.original, names: [names.name] };
              }
            : undefined;
          for (const kind of ["movie", "series"] as const) {
            const all = searchPage(catalogue, kind, BROWSE_QUERY, aliases, 1000);
            expect(all.total).toBe(BROWSE_MATCHES);
            expect(all.titles).toHaveLength(BROWSE_MATCHES);
            for (const [rank, id] of Object.entries(search.ranked)) {
              expect(all.titles[Number(rank) - 1]).toMatchObject({ id: String(id) });
            }
            const versioned = all.titles[search.versioned.rank - 1]!;
            expect(versioned.versions.map((version) => version.id).toSorted()).toEqual(
              search.versioned.ids.map(String),
            );
            expect(all.titles.map((title) => title.id)).not.toContain(String(search.adult));
            // Search's pages of 20, as More asks for them: the same order, the last five short.
            for (let limit = 20; limit < BROWSE_MATCHES + 20; limit += 20) {
              const page = searchPage(catalogue, kind, BROWSE_QUERY, aliases, limit);
              expect(page.total).toBe(BROWSE_MATCHES);
              expect(page.titles).toEqual(all.titles.slice(0, limit));
            }
          }
        }
      }
    }
  });

  it("keeps a saved shared title through the other provider when its first member goes", async () => {
    const { shared, unrelated } = first.controls.declared;
    if (!unrelated) throw new Error("the first provider declares the unrelated title");
    const beta = second.controls.declared.shared.id;
    /** What Search finds for the name, by TMDB id, with each one's versions. */
    const read = async () => {
      const catalogue = indexCatalogue(await lists(), "en");
      const found = searchPage(catalogue, "movie", "Quiet Lighthouse").titles;
      const versions = Object.fromEntries(
        found.map((title) => [
          title.tmdbId,
          title.versions.map((version) => `${version.subscriptionId}:${version.id}`).toSorted(),
        ]),
      );
      return { catalogue, found, versions };
    };
    const before = await read();
    // One title with a version from each provider, and an unrelated one of the same name.
    expect(before.versions).toEqual({
      [shared.tmdb]: [`alpha:${shared.id}`, `beta:${beta}`],
      [unrelated.tmdb]: [`alpha:${unrelated.id}`],
    });
    const title = before.found.find((each) => each.tmdbId === shared.tmdb)!;
    const saved: SavedMember = {
      ...factsOf(title, "alpha"),
      id: "saved",
      savedAt: 1,
      sequence: 1,
      subscriptionId: "alpha",
    };

    // A successful refresh without the first provider's member: the second's version remains.
    expect(control(first.controls, "/shared?listed=false").body).toMatchObject({
      sharedListed: false,
    });
    const gone = await read();
    expect(gone.versions).toEqual({
      [shared.tmdb]: [`beta:${beta}`],
      [unrelated.tmdb]: [`alpha:${unrelated.id}`],
    });
    expect(titleOf(gone.catalogue, saved)?.key).toBe(title.key);

    // Gone from both, it is unlisted, and back when they list it again.
    control(second.controls, "/shared?listed=false");
    expect(titleOf((await read()).catalogue, saved)).toBeNull();
    control(first.controls, "/shared?listed=true");
    control(second.controls, "/shared?listed=true");
    expect((await read()).versions).toEqual(before.versions);

    // A failed refresh says nothing of it: reading fails, rather than answering lists without it.
    first.provider.failTitles(503);
    try {
      await expect(lists()).rejects.toThrow();
    } finally {
      first.provider.failTitles(null);
    }
    expect(control(first.controls, "/shared?listed=maybe").status).toBe(400);
  });

  it("holds the movie and series lists until released, at its limit or on stopping", async () => {
    const { provider, login } = first;
    const state = () => first.controls.state().titleLists;
    const endpoints = [
      ["get_vod_streams", provider.titles.movies.length],
      ["get_series", provider.titles.series.length],
    ] as const;

    for (const [action, rows] of endpoints) {
      const list = new URL("/player_api.php", provider.url);
      list.search = new URLSearchParams({ ...login, action }).toString();
      for (const release of [
        () => control(first.controls, "/release-title-lists"),
        () => first.controls.stop(),
      ]) {
        control(first.controls, "/hold-title-lists?ms=60000");
        let settled = false;
        const answered = fetch(list).finally(() => {
          settled = true;
        });
        await expect.poll(state).toMatchObject({ held: true, arrived: true });
        // Holding again keeps the hold that request waits on.
        control(first.controls, "/hold-title-lists?ms=60000");
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(settled, action).toBe(false);
        release();
        const answer = await answered;
        expect(answer.status).toBe(200);
        expect(await answer.json()).toHaveLength(rows);
      }
      expect(state()).toEqual({ held: false, lastRelease: "stop" });
      control(first.controls, "/hold-title-lists?ms=200");
      const limited = await fetch(list);
      expect(limited.status).toBe(200);
      expect(await limited.json()).toHaveLength(rows);
      expect(state()).toEqual({ held: false, lastRelease: "limit" });

      // A held request the app gives up on leaves the list answering once released.
      control(first.controls, "/hold-title-lists?ms=60000");
      const abandoned = new AbortController();
      const given = fetch(list, { signal: abandoned.signal });
      await expect.poll(state).toMatchObject({ arrived: true });
      abandoned.abort();
      await expect(given).rejects.toThrow();
      control(first.controls, "/release-title-lists");
      const after = await fetch(list);
      expect(after.status).toBe(200);
      expect(await after.json()).toHaveLength(rows);
      expect(state()).toEqual({ held: false, lastRelease: "control" });
    }

    for (const ms of ["0", "600001", "soon"]) {
      expect(control(first.controls, `/hold-title-lists?ms=${ms}`).status).toBe(400);
    }
    expect(state()).toEqual({ held: false, lastRelease: "control" });
  });
});
