// @vitest-environment happy-dom
// Continue watching's Resume on a series waits for the series' details and for how its episodes
// stand. Whatever the viewer does meanwhile, a new account above all, wins over that wait.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Title } from "@mrstreamer/contracts/ondemand";
import type { TitleProgress } from "@mrstreamer/contracts/viewing";
import { openDetails, resetForAccount, useUi } from "../../src/renderer/src/app/ui-store.ts";
import { useResume, type ContinueEntry } from "../../src/renderer/src/lib/titles.ts";

function seriesOf(id: string): Title {
  return {
    kind: "series",
    key: `series:${id}`,
    subscriptionId: SUBSCRIPTION,
    id,
    name: `${id} (NL)`,
    title: id,
    originalTitle: null,
    originalLanguage: null,
    tags: ["NL"],
    year: 2024,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt: null,
    adult: false,
    tmdbId: null,
    genres: [],
    versions: [{ subscriptionId: SUBSCRIPTION, id, tags: ["NL"] }],
  };
}

/** Series `id` as Continue watching offers it. */
function entryOf(id: string): ContinueEntry {
  return {
    key: `series:${id}`,
    title: seriesOf(id),
    version: { subscriptionId: SUBSCRIPTION, id },
    progress: null,
    line: "S1 E2",
    done: 0.2,
    artworkUrl: null,
  };
}

/** A play of episode `episode` that stopped at `position` of 45 minutes. */
const played = (episode: number, position: number): TitleProgress => ({
  title: {
    kind: "episode",
    subscriptionId: SUBSCRIPTION,
    id: `e${episode}`,
    seriesId: "series",
    season: 1,
    episode,
  },
  position,
  duration: 2700,
  finished: position >= 2650,
  at: 1,
  since: 1,
});

/** Halfway through episode 2: how every series here stands in the record. */
const halfway = played(2, 600);

/** The details of series `id`: one season of two episodes. */
function detailsOf(id: string) {
  return {
    kind: "series" as const,
    title: seriesOf(id),
    originalTitle: null,
    plot: null,
    genres: [],
    cast: [],
    directors: [],
    releaseDate: null,
    duration: null,
    backdropUrl: null,
    seasons: [
      {
        number: 1,
        name: "Season 1",
        posterUrl: null,
        episodes: [1, 2].map((number) => ({
          subscriptionId: SUBSCRIPTION,
          id: `${id}-e${number}`,
          seriesId: id,
          season: 1,
          number,
          title: `Part ${number}`,
          plot: null,
          duration: 2700,
          stillUrl: null,
          airDate: null,
        })),
      },
    ],
  };
}

/** The episodes playback was asked to open. */
const opened = () =>
  ipc.argsOf("playback.openTitle").map((args) => (args as { title: { id: string } }).title.id);

const entry = entryOf("old-series");
const details = detailsOf("old-series");

let client: QueryClient;
let resume: (entry: ContinueEntry) => void;
let unmount: () => void;

beforeEach(async () => {
  ipc.reset();
  ipc.always("viewing.episodes", { progress: [halfway], marks: [], undoable: null });
  useUi.setState(useUi.getInitialState(), true);
  client = new QueryClient();
  function Probe() {
    resume = useResume();
    return null;
  }
  const mounted = queryView(client);
  await mounted.render(createElement(Probe));
  unmount = mounted.unmount;
});

afterEach(() => unmount());

describe("resuming a series from Continue watching", () => {
  it("plays the episode when nothing changed while its details loaded", async () => {
    const answer = ipc.hold("ondemand.details");
    resume(entry);
    await act(async () => answer.resolve(details));

    expect(opened()).toEqual(["old-series-e2"]);
  });

  it("does nothing once the account changed, though the wait was cut short", async () => {
    ipc.hold("ondemand.details");
    resume(entry);

    await act(async () => {
      resetForAccount();
      await client.resetQueries();
    });

    expect(useUi.getState()).toMatchObject({ details: null, playingTitle: false });
    expect(opened()).toEqual([]);
  });

  it("gives way to details the viewer opened meanwhile", async () => {
    const answer = ipc.hold("ondemand.details");
    resume(entry);
    openDetails({ kind: "movie", subscriptionId: SUBSCRIPTION, id: "another" });
    await act(async () => answer.resolve(details));

    expect(useUi.getState()).toMatchObject({
      details: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "another" },
      playingTitle: false,
    });
    expect(opened()).toEqual([]);
  });

  it("gives way to a newer resume of another series", async () => {
    const first = ipc.hold("ondemand.details");
    const second = ipc.hold("ondemand.details");
    resume(entry);
    resume(entryOf("new-series"));
    await act(async () => second.resolve(detailsOf("new-series")));
    await act(async () => first.resolve(details));

    expect(opened()).toEqual(["new-series-e2"]);
  });

  it("goes on where the series' details would: past an episode marked watched, from its beginning", async () => {
    ipc.always("viewing.episodes", {
      progress: [played(1, 600)],
      marks: [{ season: 1, episode: 1, watched: true, at: 5, revision: 5 }],
      undoable: 5,
    });
    const answer = ipc.hold("ondemand.details");

    resume(entry);
    await act(async () => answer.resolve(details));

    expect(opened()).toEqual(["old-series-e2"]);
    expect(ipc.argsOf("viewing.episodes")[0]).toEqual({
      series: { subscriptionId: SUBSCRIPTION, id: "old-series" },
    });
  });

  it("opens the details instead once every episode is watched", async () => {
    ipc.always("viewing.episodes", {
      progress: [],
      marks: [1, 2].map((episode) => ({
        season: 1,
        episode,
        watched: true,
        at: 5,
        revision: episode,
      })),
      undoable: 2,
    });
    const answer = ipc.hold("ondemand.details");

    resume(entry);
    await act(async () => answer.resolve(details));

    expect(opened()).toEqual([]);
    expect(useUi.getState().details).toEqual({
      kind: "series",
      subscriptionId: SUBSCRIPTION,
      id: "old-series",
    });
  });
});
