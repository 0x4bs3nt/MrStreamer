import type { Episode, SeriesDetails, Title, TitleRef } from "@mrstreamer/contracts/ondemand";
import type { SeriesViewing } from "@mrstreamer/contracts/viewing";
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
const listeners = new Map<string, (payload: never) => void>();
const fakePlayer = {
  muted: true,
  timeUpdateEventInterval: 0,
  staysActiveInBackground: false,
  currentTime: 0,
  duration: 600,
  addListener: (event: string, listener: (payload: never) => void) => {
    listeners.set(event, listener);
  },
  replaceAsync: vi.fn(async (source: { uri: string } | null) => {
    if (source) sources.push(source.uri);
  }),
  play: vi.fn(),
  pause: vi.fn(),
  seekBy: vi.fn(),
};
const emit = (event: string, payload: unknown) => listeners.get(event)?.(payload as never);

const pushed: string[] = [];
const held: {
  details: Array<{ resolve: (d: SeriesDetails) => void; reject: (e: unknown) => void }>;
  standing: Array<(s: SeriesViewing) => void>;
} = { details: [], standing: [] };

vi.mock("expo-video", () => ({ createVideoPlayer: () => fakePlayer }));
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
vi.mock("../src/viewing.ts", () => ({
  seriesViewing: () => new Promise<SeriesViewing>((resolve) => held.standing.push(resolve)),
  recordProgress: async () => undefined,
  finishSeries: async () => undefined,
  useViewing: () => null,
}));

const { failureOf, playEpisode, playMovie } = await import("../src/play-title.ts");
const { onScreen, play, playNext, showVersions, stop } = await import("../src/playback.ts");
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
    async () => ({ url: `live:${id}`, hls: true }),
    { watch: true, login: [] },
  );

beforeEach(() => {
  stop();
  sources.length = 0;
  pushed.length = 0;
  held.details.length = 0;
  held.standing.length = 0;
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
    expect(pushed).toEqual([`/series/title/${encodeURIComponent(`${SUB}:s1`)}`]);
  });
});

describe("Next episode", () => {
  it("plays the next episode once the record answers", async () => {
    const details = seriesDetails("s1");
    playEpisode(details, episode("s1", 1), 0, () => undefined);
    await settle();
    playNext();
    held.standing.shift()?.(nothingPlayed);
    await settle();
    expect(sources).toEqual(["file:episode:s1e1", "file:episode:s1e2"]);
  });

  it("stays cancelled when the viewer goes away and comes back while the record answers", async () => {
    playEpisode(seriesDetails("s1"), episode("s1", 1), 0, () => undefined);
    await settle();
    playNext();
    onScreen("/films");
    onScreen("/");
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

describe("a version that fails", () => {
  it("marks a movie's version by its file until it plays", async () => {
    const version = { subscriptionId: SUB, id: "m1" };
    playMovie(title("movie", "m1", ["m1", "m2"]), version, 0, () => undefined);
    await settle();
    emit("statusChange", { status: "error", error: { message: "Cannot Open" } });
    expect(failureOf("movie", version)).toBe("file");
    playMovie(title("movie", "m1", ["m1", "m2"]), version, 0, () => undefined);
    await settle();
    emit("playingChange", { isPlaying: true });
    expect(failureOf("movie", version)).toBeUndefined();
  });

  it("marks a series' version by an episode, and offers its other versions", async () => {
    const shown = vi.fn();
    const details = seriesDetails("s1", ["s1", "s9"]);
    playEpisode(details, episode("s1", 1), 0, shown);
    await settle();
    emit("statusChange", { status: "error", error: { message: "Cannot Open" } });
    expect(failureOf("series", { subscriptionId: SUB, id: "s1" })).toBe("episode");
    expect(failureOf("series", { subscriptionId: SUB, id: "s1e1" })).toBeUndefined();
    showVersions();
    expect(shown).toHaveBeenCalledOnce();
  });

  it("keeps a movie's and a series' failures apart when they share an id", async () => {
    const shared = { subscriptionId: SUB, id: "x1" };
    playMovie(title("movie", "x1", ["x1", "x2"]), shared, 0, () => undefined);
    await settle();
    emit("statusChange", { status: "error", error: { message: "Cannot Open" } });
    // A series listed under the same id plays an episode: the movie's failure stands.
    playEpisode(seriesDetails("x1"), episode("x1", 1), 0, () => undefined);
    await settle();
    emit("playingChange", { isPlaying: true });
    expect(failureOf("movie", shared)).toBe("file");
    expect(failureOf("series", shared)).toBeUndefined();
  });
});
