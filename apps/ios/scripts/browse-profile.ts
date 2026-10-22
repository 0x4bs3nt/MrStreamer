// FIXTURE_PROFILE=browse for scripts/fixture-server.ts: the fake panel's lists with what a Search
// and Watchlist journey needs added at their end, and the control port's few routes it uses.
//
// The first provider adds the movies "Ocean Voyage 001 (EN)" to "Ocean Voyage 125 (EN)" and the
// series "Ocean Tides 001 (EN)" to "Ocean Tides 125 (EN)": 125 titles of each kind that Search
// finds for "Ocean", a word no other title, channel or fake TMDB name holds. Rank n is id 70,000 + n. Each is a second older than the
// one before, and all are older than the default titles, so ties fall in that order without a
// clock, and New stays as it was. Two rows of each kind hold the word and are not more matches:
// an (NL) version of 010 under its TMDB id, which joins it, and one for adults, which Search
// leaves out. The provider also lists "Quiet Lighthouse (EN)" twice under TMDB ids of their own.
// The second provider (FIXTURE_SECOND=1) lists the first of them under another id and the same
// TMDB id: one title with a version from each, beside an unrelated one of the same name.
//
// Its control routes, on the control port beside the others:
//   POST /shared?listed=false            later lists leave out this provider's shared member, and
//                                        answer as usual otherwise; listed=true lists it again
//   POST /hold-title-lists?ms=60000      movie and series lists wait unanswered until released, or
//                                        for `ms`, at most ten minutes; one hold at a time
//   POST /release-title-lists            answers the held lists
//   GET  /profile                        what it declares of the lists it started with, unchanged
//                                        by /shared, and the state of these controls
import { createHash } from "node:crypto";
import type { FakeProvider, FakeTitles } from "../../desktop/test/fake-provider.ts";

type Movie = FakeTitles["movies"][number];
type Series = FakeTitles["series"][number];

/** The word Search is given. */
export const BROWSE_QUERY = "Ocean";
/** The titles of each kind Search finds for it, adults and versions of one title counted once. */
export const BROWSE_MATCHES = 125;
/** Rank n's provider id is this plus n, for movies and series alike. */
const RANKED = 70_000;
/** The rank whose title has a second version. */
const VERSIONED = 10;
/** Where each kind's TMDB ids start; movies and series are numbered apart on TMDB. */
const TMDB = 600_000;
const ADULT = 70_600;
const SHARED = { first: 70_900, second: 70_950, tmdb: "650900" } as const;
const UNRELATED = { id: 70_901, tmdb: "650901" } as const;
const NAME = "Quiet Lighthouse (EN)";
/** Before the default titles, the oldest of which is about a million seconds before theirs. */
const ADDED = 1_788_000_000;
/** The longest a hold lasts. */
const HOLD_MAX_MS = 600_000;

const padded = (rank: number) => String(rank).padStart(3, "0");

/** A movie of the profile's own, streaming the panel's MP4 clip. */
const movie = (id: number, name: string, added: number, tmdb: string): Movie => ({
  id,
  name,
  categoryId: "502",
  adult: false,
  rating: 7,
  added,
  container: "mp4",
  fixture: "title-h264-aac.mp4",
  tmdb,
});

/** A series of the profile's own, with one episode streaming the panel's MP4 clip. */
const series = (id: number, name: string, added: number, tmdb: string): Series => ({
  id,
  name,
  categoryId: "601",
  adult: false,
  added,
  seasons: [
    [
      {
        id: id * 10,
        name: "",
        categoryId: "601",
        adult: false,
        rating: 0,
        added,
        container: "mp4",
        fixture: "title-h264-aac.mp4",
      },
    ],
  ],
  tmdb,
});

/** The lists `built` with the profile's titles added, for `startFakeProvider`'s `titlesOf`. */
export function browseTitles(built: FakeTitles, second: boolean): FakeTitles {
  if (second) {
    return { ...built, movies: [...built.movies, movie(SHARED.second, NAME, ADDED, SHARED.tmdb)] };
  }
  const ranks = Array.from({ length: BROWSE_MATCHES }, (_, index) => index + 1);
  const added = (rank: number) => ADDED - rank;
  const movies = ranks.map((rank) =>
    movie(RANKED + rank, `Ocean Voyage ${padded(rank)} (EN)`, added(rank), String(TMDB + rank)),
  );
  const shows = ranks.map((rank) =>
    series(RANKED + rank, `Ocean Tides ${padded(rank)} (EN)`, added(rank), String(TMDB + rank)),
  );
  const version = `${padded(VERSIONED)} (NL)`;
  return {
    ...built,
    movies: [
      ...built.movies,
      ...movies,
      movie(
        RANKED + 500 + VERSIONED,
        `Ocean Voyage ${version}`,
        added(VERSIONED),
        String(TMDB + VERSIONED),
      ),
      // Newer than every match, so it would rank first were it not left out.
      {
        ...movie(ADULT, "Ocean Voyage After Dark (EN)", ADDED, String(TMDB + 600)),
        categoryId: "505",
        adult: true,
      },
      movie(SHARED.first, NAME, ADDED, SHARED.tmdb),
      movie(UNRELATED.id, NAME, ADDED, UNRELATED.tmdb),
    ],
    series: [
      ...built.series,
      ...shows,
      series(
        RANKED + 500 + VERSIONED,
        `Ocean Tides ${version}`,
        added(VERSIONED),
        String(TMDB + VERSIONED),
      ),
      { ...series(ADULT, "Ocean Tides After Dark (EN)", ADDED, String(TMDB + 600)), adult: true },
    ],
  };
}

/** Where Search's pages of 20 begin and end, and the last few: the ranks the profile declares. */
const CHECKED = [1, 20, 21, 40, 41, 60, 61, 80, 81, 100, 101, 120, 121, 125];

/**
 * What the profile declares about the lists a provider starts with: their counts and a hash of the
 * titles as built, not of the HTTP answers, and not of later lists `/shared` changes.
 */
function browseDeclared(titles: FakeTitles, second: boolean) {
  return {
    name: "browse" as const,
    provider: second ? ("second" as const) : ("first" as const),
    search: second
      ? null
      : {
          query: BROWSE_QUERY,
          /** Per kind, as Search counts them. */
          matches: BROWSE_MATCHES,
          /** Rows of each kind holding the word: the matches, a second version and one for adults. */
          rows: BROWSE_MATCHES + 2,
          /** Provider ids by rank, the same for movies and series. */
          ranked: Object.fromEntries(CHECKED.map((rank) => [rank, RANKED + rank])),
          /** The rank whose title joins two versions, by their ids. */
          versioned: { rank: VERSIONED, ids: [RANKED + VERSIONED, RANKED + 500 + VERSIONED] },
          /** The id of each kind's row for adults, which Search leaves out. */
          adult: ADULT,
        },
    shared: { name: NAME, id: second ? SHARED.second : SHARED.first, tmdb: SHARED.tmdb },
    unrelated: second ? null : { name: NAME, ...UNRELATED },
    movies: titles.movies.length,
    series: titles.series.length,
    sha256: createHash("sha256").update(JSON.stringify(titles)).digest("hex"),
  };
}

/** How the last hold ended: released through the control port, at its limit, or on stopping. */
type Release = "control" | "limit" | "stop";

/**
 * The profile's controls over `provider`, which lists `browseTitles`. `control` answers the
 * routes it owns with a status and body, and anything else with undefined; `stop` releases a hold.
 */
export function browseControls(provider: FakeProvider, second: boolean) {
  const declared = browseDeclared(provider.titles, second);
  let listed = true;
  let hold: {
    readonly release: () => void;
    readonly timer: NodeJS.Timeout;
    readonly since: number;
    readonly ms: number;
    arrived: boolean;
  } | null = null;
  let lastRelease: Release | null = null;

  const release = (how: Release) => {
    if (!hold) return;
    clearTimeout(hold.timer);
    hold.release();
    hold = null;
    lastRelease = how;
  };
  const state = () => ({
    ...declared,
    sharedListed: listed,
    titleLists: hold
      ? { held: true, arrived: hold.arrived, releasesAt: hold.since + hold.ms }
      : { held: false, lastRelease },
  });

  return {
    declared,
    state,
    control(method: string, url: URL): { status: number; body: unknown } | undefined {
      if (url.pathname === "/profile") return { status: 200, body: state() };
      if (method !== "POST") return undefined;
      if (url.pathname === "/shared") {
        const asked = url.searchParams.get("listed");
        if (asked !== "true" && asked !== "false") return { status: 400, body: null };
        listed = asked === "true";
        provider.serveTitles((all) =>
          listed
            ? all
            : { ...all, movies: all.movies.filter((each) => each.id !== declared.shared.id) },
        );
        return { status: 200, body: state() };
      }
      if (url.pathname === "/hold-title-lists") {
        const ms = Number(url.searchParams.get("ms") ?? 60_000);
        if (!Number.isInteger(ms) || ms <= 0 || ms > HOLD_MAX_MS)
          return { status: 400, body: null };
        // A second hold would leave the first's requests without a release.
        if (!hold) {
          const held = provider.hold("titles");
          const timer = setTimeout(() => release("limit"), ms);
          timer.unref();
          const current = { release: held.release, timer, since: Date.now(), ms, arrived: false };
          hold = current;
          void held.arrived.then(() => {
            current.arrived = true;
          });
        }
        return { status: 200, body: state() };
      }
      if (url.pathname === "/release-title-lists") {
        release("control");
        return { status: 200, body: state() };
      }
      return undefined;
    },
    stop: () => release("stop"),
  };
}
