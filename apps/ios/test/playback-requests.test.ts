import { nativePlayer } from "./native-player.ts";
import type { Episode, SeriesDetails, Title, TitleRef } from "@mrstreamer/contracts/ondemand";
import type { SeriesViewing, TitleProgress } from "@mrstreamer/contracts/viewing";
import type { ContinueEntry } from "@mrstreamer/core/viewing/continue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What the viewer asked for last is what plays: a series' resume or Next episode that waits for
// an answer gives way to anything asked meanwhile, and a late answer, kept or failed, neither
// replaces it nor opens Watch or details. The app's own owners run (resume, play-title, playback);
// the native player, navigation and provider are stand-ins whose calls are what the viewer would
// see. Removing a subscription while a resume waits is in providers.test.ts.

const SUB = "xtream-test";

/** Each source the player was given, by its address, in order. */
const sources: string[] = [];
const fakePlayer = nativePlayer((source) => {
  sources.push(source.uri);
});

const pushed: string[] = [];
type Answer<T> = { resolve: (value: T) => void; reject: (cause: unknown) => void };
const held: {
  details: Array<Answer<SeriesDetails>>;
  standing: Array<(s: SeriesViewing) => void>;
  /** The same reads of how a series' episodes stand, to refuse. */
  unreadable: Array<(cause: unknown) => void>;
  /** Reads of how far movies got. */
  progress: Array<Answer<readonly TitleProgress[]>>;
} = { details: [], standing: [], unreadable: [], progress: [] };

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-video", () => ({ createVideoPlayer: () => fakePlayer }));
vi.mock("../src/account.ts", () => ({
  members: () => [{ entry: { id: "demo", kind: "xtream" } }],
}));
vi.mock("expo-router", () => ({
  router: { push: (href: string) => pushed.push(href), navigate: () => undefined },
}));
vi.mock("../src/titles.ts", () => ({
  detailsOf: () =>
    new Promise<SeriesDetails>((resolve, reject) => held.details.push({ resolve, reject })),
  titleFile: async (ref: TitleRef) => ({ url: `file:${ref.kind}:${ref.id}`, container: "mp4" }),
  titleOf: () => undefined,
  useMetadataVersion: () => 0,
  useTitleLists: () => ({ kind: "idle" }),
}));
/** The viewing record's saves of how far an episode got, as asked. */
const saves = vi.hoisted(() => ({
  asked: [] as number[],
  answer: async () => undefined,
  finished: [] as number[],
}));
vi.mock("../src/viewing.ts", () => ({
  seriesViewing: () =>
    new Promise<SeriesViewing>((resolve, reject) => {
      held.standing.push(resolve);
      held.unreadable.push(reject);
    }),
  progressOf: () =>
    new Promise<readonly TitleProgress[]>((resolve, reject) =>
      held.progress.push({ resolve, reject }),
    ),
  recordProgress: (_title: unknown, position: number) => {
    saves.asked.push(position);
    return saves.answer();
  },
  finishSeries: async (_versions: readonly unknown[], since: number) => {
    saves.finished.push(since);
  },
  useViewing: () => null,
}));

const { failureOf, playEpisode, playMovie, resumeEpisode, resumeMovie } =
  await import("../src/play-title.ts");
const { closeWatch, onScreen, play, playNext, showVersions, stop } =
  await import("../src/playback.ts");
const { resume } = await import("../src/resume.ts");

function title(kind: Title["kind"], id: string, versions: readonly string[] = [id]): Title {
  return {
    kind,
    key: `${kind}:${id}`,
    subscriptionId: SUB,
    id,
    name: id,
    title: id,
    originalTitle: null,
    originalLanguage: null,
    tags: [],
    year: null,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt: null,
    adult: false,
    tmdbId: null,
    genres: [],
    versions: versions.map((each) => ({ subscriptionId: SUB, id: each, tags: [] })),
  };
}

const episode = (seriesId: string, number: number): Episode => ({
  subscriptionId: SUB,
  id: `${seriesId}e${number}`,
  seriesId,
  season: 1,
  number,
  title: `Episode ${number}`,
  plot: null,
  duration: 600,
  stillUrl: null,
  airDate: null,
});

function seriesDetails(id: string, versions: readonly string[] = [id]): SeriesDetails {
  return {
    kind: "series",
    title: title("series", id, versions),
    originalTitle: null,
    plot: null,
    genres: [],
    cast: [],
    directors: [],
    releaseDate: null,
    duration: 600,
    backdropUrl: null,
    seasons: [
      { number: 1, name: "Season 1", posterUrl: null, episodes: [episode(id, 1), episode(id, 2)] },
    ],
  };
}

const nothingPlayed: SeriesViewing = { progress: [], marks: [], undoable: null };

/** How far a movie or an episode of `s1` got, as the record keeps it. */
const progressAt = (kind: "movie" | "episode", id: string, position: number): TitleProgress => ({
  title:
    kind === "movie"
      ? { kind, subscriptionId: SUB, id }
      : { kind, subscriptionId: SUB, id, seriesId: "s1", season: 1, episode: Number(id.at(-1)) },
  position,
  duration: 600,
  finished: false,
  at: 1,
  since: 1,
});

/** The next save of progress waits until the test calls what this returns; later ones don't. */
function holdNextSave() {
  let answer: (refused?: unknown) => void = () => {};
  saves.answer = () => {
    saves.answer = async () => undefined;
    return new Promise<undefined>((done, fail) => {
      answer = (refused) => (refused === undefined ? done(undefined) : fail(refused));
    });
  };
  return (refused?: unknown) => answer(refused);
}

/** The player is ready and seeks to where the play starts; answers where that is. */
function startsAt() {
  fakePlayer.ready();
  return fakePlayer.currentTime;
}

const seriesEntry = (id: string): ContinueEntry => ({
  key: `series:${id}`,
  title: title("series", id),
  version: { subscriptionId: SUB, id },
  progress: null,
  line: "S1 E1",
  done: null,
  artworkUrl: null,
});

/** Lets every answer given so far, and what follows from it, run. */
const settle = () => new Promise((done) => setTimeout(done, 0));

/** Answers the series' resume: its details, then how its episodes stand. */
async function answer(details: SeriesDetails) {
  held.details.shift()?.resolve(details);
  await settle();
  held.standing.shift()?.(nothingPlayed);
  await settle();
}

const live = (id: string) =>
  play(
    { id, subscriptionId: SUB, title: id, place: "", live: true, next: false, versions: false },
    {
      kind: "live",
      candidates: [
        { variantId: "stream", open: async () => ({ url: `live:${id}`, container: "m3u8" }) },
      ],
      explicit: false,
    },
    { watch: true, login: [] },
  );

beforeEach(() => {
  stop();
  sources.length = 0;
  pushed.length = 0;
  held.details.length = 0;
  held.standing.length = 0;
  held.unreadable.length = 0;
  held.progress.length = 0;
  saves.asked.length = 0;
  saves.answer = async () => undefined;
  onScreen("/");
});
afterEach(() => stop());

describe("a series' resume", () => {
  it("plays where the series goes on once its details answer", async () => {
    resume(seriesEntry("s1"));
    await answer(seriesDetails("s1"));
    expect(sources).toEqual(["file:episode:s1e1"]);
  });

  it("gives way to a movie played while its details load", async () => {
    resume(seriesEntry("s1"));
    playMovie(title("movie", "m1"), { subscriptionId: SUB, id: "m1" }, 0, () => undefined);
    await settle();
    await answer(seriesDetails("s1"));
    expect(sources).toEqual(["file:movie:m1"]);
  });

  it("gives way to a channel played while its details load", async () => {
    resume(seriesEntry("s1"));
    void live("c1");
    await settle();
    await answer(seriesDetails("s1"));
    expect(sources).toEqual(["live:c1"]);
  });

  it("gives way to another series' resume", async () => {
    resume(seriesEntry("s1"));
    resume(seriesEntry("s2"));
    held.details[1]?.resolve(seriesDetails("s2"));
    await settle();
    held.standing.shift()?.(nothingPlayed);
    await settle();
    await answer(seriesDetails("s1"));
    expect(sources).toEqual(["file:episode:s2e1"]);
  });

  it("plays nothing after Stop, and opens nothing when its details then fail", async () => {
    resume(seriesEntry("s1"));
    stop();
    await answer(seriesDetails("s1"));
    resume(seriesEntry("s2"));
    stop();
    held.details.shift()?.reject(new Error("unreachable"));
    await settle();
    expect(sources).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it("lapses when the viewer goes to another screen", async () => {
    resume(seriesEntry("s1"));
    onScreen("/live");
    await answer(seriesDetails("s1"));
    expect(sources).toEqual([]);
  });

  it("stays lapsed when the viewer goes away and comes back before it answers", async () => {
    resume(seriesEntry("s1"));
    onScreen("/films");
    onScreen("/");
    await answer(seriesDetails("s1"));
    resume(seriesEntry("s2"));
    onScreen("/films");
    onScreen("/");
    held.details.shift()?.reject(new Error("unreachable"));
    await settle();
    expect(sources).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it("goes on when the same screen is reported again", async () => {
    resume(seriesEntry("s1"));
    onScreen("/");
    await answer(seriesDetails("s1"));
    expect(sources).toEqual(["file:episode:s1e1"]);
  });

  it("opens the series' details when they fail and nothing was asked since", async () => {
    resume(seriesEntry("s1"));
    held.details.shift()?.reject(new Error("unreachable"));
    await settle();
    // The version that goes on is asked for, over any version picked before for the series.
    expect(pushed).toEqual([`/series/title/${encodeURIComponent(`${SUB}:s1`)}?asked=1`]);
  });
});

describe("Next episode", () => {
  it("plays the next episode once the record answers", async () => {
    const details = seriesDetails("s1");
    playEpisode(details, episode("s1", 1), 0, () => undefined);
    await settle();
    playNext();
    await settle();
    held.standing.shift()?.(nothingPlayed);
    await settle();
    expect(sources).toEqual(["file:episode:s1e1", "file:episode:s1e2"]);
  });

  it("reads the record once where this episode got to is saved", async () => {
    playEpisode(seriesDetails("s1"), episode("s1", 1), 0, () => undefined);
    await settle();
    fakePlayer.state(true);
    fakePlayer.currentTime = 590;
    // The save Next asks for waits for the test; later ones answer at once.
    let saved = () => {};
    saves.answer = () => {
      saves.answer = async () => undefined;
      return new Promise<undefined>((done) => (saved = () => done(undefined)));
    };
    playNext();
    await settle();
    expect(saves.asked).toEqual([590]);
    expect(held.standing).toEqual([]);
    saved();
    await settle();
    held.standing.shift()?.(nothingPlayed);
    await settle();
    expect(sources).toEqual(["file:episode:s1e1", "file:episode:s1e2"]);
  });

  it("stays on the episode when its save was refused, reading nothing", async () => {
    playEpisode(seriesDetails("s1"), episode("s1", 1), 0, () => undefined);
    await settle();
    fakePlayer.state(true);
    fakePlayer.currentTime = 590;
    const answer = holdNextSave();
    playNext();
    await settle();
    answer(new Error("disk full"));
    await settle();
    expect(held.standing).toEqual([]);
    expect(sources).toEqual(["file:episode:s1e1"]);
  });

  it("plays no guess when the record can't be read", async () => {
    playEpisode(seriesDetails("s1"), episode("s1", 1), 0, () => undefined);
    await settle();
    playNext();
    await settle();
    held.unreadable.shift()?.(new Error("unreadable"));
    await settle();
    expect(sources).toEqual(["file:episode:s1e1"]);
  });

  it("stays cancelled when the viewer goes away and comes back while the record answers", async () => {
    playEpisode(seriesDetails("s1"), episode("s1", 1), 0, () => undefined);
    await settle();
    playNext();
    onScreen("/films");
    onScreen("/");
    await settle();
    held.standing.shift()?.(nothingPlayed);
    await settle();
    expect(sources).toEqual(["file:episode:s1e1"]);
  });

  it("gives way to a movie played while the record answers", async () => {
    playEpisode(seriesDetails("s1"), episode("s1", 1), 0, () => undefined);
    await settle();
    playNext();
    playMovie(title("movie", "m1"), { subscriptionId: SUB, id: "m1" }, 0, () => undefined);
    await settle();
    held.standing.shift()?.(nothingPlayed);
    await settle();
    expect(sources).toEqual(["file:episode:s1e1", "file:movie:m1"]);
  });
});

describe("resuming right after Close", () => {
  const m1 = { subscriptionId: SUB, id: "m1" };

  /** m1 plays at `position`, then Close pauses it with its save still going. */
  async function closedAt(position: number) {
    playMovie(title("movie", "m1"), m1, 0, () => undefined);
    await settle();
    fakePlayer.state(true);
    fakePlayer.currentTime = position;
    const answer = holdNextSave();
    void closeWatch();
    return answer;
  }

  it("plays a movie from where Close saved it, read once the save ended", async () => {
    const saved = await closedAt(300);
    resumeMovie(title("movie", "m1"), m1, progressAt("movie", "m1", 100), () => undefined);
    await settle();
    expect(held.progress).toEqual([]);
    saved();
    await settle();
    held.progress.shift()?.resolve([progressAt("movie", "m1", 300)]);
    await settle();
    expect(sources).toEqual(["file:movie:m1", "file:movie:m1"]);
    expect(startsAt()).toBe(295);
  });

  it("plays nothing when Stop, another screen or another play came first", async () => {
    for (const first of [
      () => void stop(),
      () => onScreen("/films"),
      () => playMovie(title("movie", "m2"), { subscriptionId: SUB, id: "m2" }, 0, () => {}),
    ]) {
      const saved = await closedAt(300);
      sources.length = 0;
      resumeMovie(title("movie", "m1"), m1, progressAt("movie", "m1", 100), () => undefined);
      first();
      saved();
      await settle();
      held.progress.shift()?.resolve([progressAt("movie", "m1", 300)]);
      await settle();
      expect(sources).not.toContain("file:movie:m1");
      onScreen("/");
    }
  });

  it("plays from what the screen showed when the record can't be read", async () => {
    const saved = await closedAt(300);
    resumeMovie(title("movie", "m1"), m1, progressAt("movie", "m1", 100), () => undefined);
    saved();
    await settle();
    held.progress.shift()?.reject(new Error("unreadable"));
    await settle();
    expect(startsAt()).toBe(95);
  });

  it("plays an episode from where the record says it got to", async () => {
    const details = seriesDetails("s1");
    playEpisode(details, episode("s1", 1), 0, () => undefined);
    await settle();
    fakePlayer.state(true);
    fakePlayer.currentTime = 400;
    const saved = holdNextSave();
    void closeWatch();
    resumeEpisode(details, episode("s1", 1), undefined, () => undefined);
    await settle();
    expect(held.standing).toEqual([]);
    saved();
    await settle();
    held.standing.shift()?.({ ...nothingPlayed, progress: [progressAt("episode", "s1e1", 400)] });
    await settle();
    expect(sources).toEqual(["file:episode:s1e1", "file:episode:s1e1"]);
    expect(startsAt()).toBe(395);
  });
});

describe("a version that fails", () => {
  it("marks a movie's version by its file until it plays", async () => {
    const version = { subscriptionId: SUB, id: "m1" };
    playMovie(title("movie", "m1", ["m1", "m2"]), version, 0, () => undefined);
    await settle();
    fakePlayer.failure();
    expect(failureOf("movie", version)).toBe("file");
    playMovie(title("movie", "m1", ["m1", "m2"]), version, 0, () => undefined);
    await settle();
    fakePlayer.state(true);
    expect(failureOf("movie", version)).toBeUndefined();
  });

  it("marks a series' version by an episode, and offers its other versions", async () => {
    const shown = vi.fn();
    const details = seriesDetails("s1", ["s1", "s9"]);
    playEpisode(details, episode("s1", 1), 0, shown);
    await settle();
    fakePlayer.failure();
    expect(failureOf("series", { subscriptionId: SUB, id: "s1" })).toBe("episode");
    expect(failureOf("series", { subscriptionId: SUB, id: "s1e1" })).toBeUndefined();
    showVersions();
    expect(shown).toHaveBeenCalledOnce();
  });

  it("keeps a movie's and a series' failures apart when they share an id", async () => {
    const shared = { subscriptionId: SUB, id: "x1" };
    playMovie(title("movie", "x1", ["x1", "x2"]), shared, 0, () => undefined);
    await settle();
    fakePlayer.failure();
    // A series listed under the same id plays an episode: the movie's failure stands.
    playEpisode(seriesDetails("x1"), episode("x1", 1), 0, () => undefined);
    await settle();
    fakePlayer.state(true);
    expect(failureOf("movie", shared)).toBe("file");
    expect(failureOf("series", shared)).toBeUndefined();
  });
});

it("keeps a personal reserved-id episode's finish after its login Source changes", async () => {
  const { setSource, dropSource } = await import("../src/sources.ts");
  const { demoProvider } = await import("../src/demo.ts");
  const original = seriesDetails("s1");
  const details: SeriesDetails = {
    ...original,
    title: {
      ...original.title,
      subscriptionId: "demo",
      versions: original.title.versions.map((version) => ({ ...version, subscriptionId: "demo" })),
    },
    seasons: original.seasons.map((season) => ({
      ...season,
      episodes: season.episodes.map((episode) => ({ ...episode, subscriptionId: "demo" })),
    })),
  };
  const source = { revision: 1, provider: demoProvider(), login: ["viewer", "fixture"] };
  setSource("demo", source);
  try {
    const before = saves.finished.length;
    const last = details.seasons[0]!.episodes[1]!;
    playEpisode(details, last, 0, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    startsAt();
    fakePlayer.state(true);
    fakePlayer.currentTime = 600;
    fakePlayer.observation({ kind: "ended" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    setSource("demo", { ...source, revision: 2 });
    const first = progressAt("episode", "s1e1", 600);
    held.standing.shift()!({
      progress: [{ ...first, finished: true, title: { ...first.title, subscriptionId: "demo" } }],
      marks: [],
      undoable: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saves.finished).toHaveLength(before + 1);
  } finally {
    dropSource("demo");
  }
});
