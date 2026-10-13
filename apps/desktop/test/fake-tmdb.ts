// A stand-in for TMDB's API: every film and series it is asked about exists, with genres, a
// language and names that follow from its id (see `tmdbName`), every series has two seasons whose
// episodes are named the same way (see `tmdbEpisodeName`), and one streaming service streams the
// first titles it is told about.
import { createServer } from "node:http";

export interface FakeTmdb {
  readonly url: string;
  /** Requests for one title's details so far, in one language or all. */
  detailRequests(language?: string): number;
  /** Requests a title's details made as it opened, with its credits, refused ones included. */
  aboutRequests(): number;
  /** Season requests so far, in order, by series, season and language: "90000/1/nl". */
  seasonRequests(): readonly string[];
  /**
   * Makes season requests answer with this HTTP status, or not until another answer is set, or
   * restores them with null. Those held are answered as the next setting says.
   */
  failSeasons(answer: number | "hold" | null): void;
  /** Holds the answers to titles' details as they open, or sends those held and stops holding. */
  holdAbout(hold: boolean): void;
  /** Makes every request answer 401, as for a revoked key, or restores them. */
  refuse(refused: boolean): void;
  /** What the service streams, as TMDB ids, by kind. */
  stream(kind: "movie" | "tv", ids: readonly string[]): void;
  close(): Promise<void>;
}

/**
 * The name the fake TMDB gives title `id` in `language`, as TMDB answers: the original when it has
 * no translation. Every third title was made in Dutch, "Origineel 3", the rest in English,
 * "Original 1". English translates all but every fifth, "English 3"; Dutch all but every seventh,
 * "Nederlands 1". Other languages translate nothing.
 */
export function tmdbName(id: number, language: string): { name: string; original: string } {
  const madeIn = id % 3 === 0 ? "nl" : "en";
  const original = madeIn === "nl" ? `Origineel ${id}` : `Original ${id}`;
  if (language === madeIn) return { name: original, original };
  if (language === "en" && id % 5 !== 0) return { name: `English ${id}`, original };
  if (language === "nl" && id % 7 !== 0) return { name: `Nederlands ${id}`, original };
  return { name: original, original };
}

/**
 * The name the fake TMDB gives an episode of series `id` in `language`, "Episode 2" where it has
 * none, as TMDB answers. Series made in Dutch, every third, name theirs "Origineel 1x2", the rest
 * "Original 1x2". English translates the odd episodes, "English 1x3"; Dutch translates all,
 * "Nederlands 1x2"; other languages none.
 */
function tmdbEpisodeName(id: number, season: number, episode: number, language: string): string {
  const madeIn = id % 3 === 0 ? "nl" : "en";
  const numbered = `${season}x${episode}`;
  if (language === madeIn) return `${madeIn === "nl" ? "Origineel" : "Original"} ${numbered}`;
  if (language === "en" && episode % 2 === 1) return `English ${numbered}`;
  if (language === "nl") return `Nederlands ${numbered}`;
  return `Episode ${episode}`;
}

/** Episodes per season the fake TMDB lists for every series: four, then one. */
const SEASON_EPISODES = [4, 1];

export async function startFakeTmdb(): Promise<FakeTmdb> {
  const details = new Map<string, number>();
  let about = 0;
  let refused = false;
  const seasons: string[] = [];
  let seasonFailure: number | "hold" | null = null;
  /** Season requests waiting while their answers are held. */
  const heldSeasons: (() => void)[] = [];
  let aboutHeld = false;
  /** Answers to a title's details as it opens, waiting while they are held. */
  const held: (() => void)[] = [];
  const streamed: Record<string, readonly string[]> = { movie: [], tv: [] };
  const json = (response: import("node:http").ServerResponse, body: unknown, status = 200) =>
    response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://tmdb");
    const opened = url.searchParams.get("append_to_response") === "credits";
    if (opened) about++;
    if (refused) return json(response, { status_code: 7 }, 401);
    const season = /^\/3\/tv\/(\d+)\/season\/(\d+)$/.exec(url.pathname);
    if (season) {
      const language = url.searchParams.get("language") ?? "en";
      const id = Number(season[1]);
      const number = Number(season[2]);
      seasons.push(`${id}/${number}/${language}`);
      const answer = (): void => {
        if (seasonFailure === "hold") return void heldSeasons.push(answer);
        if (seasonFailure !== null) return void json(response, { status_code: 11 }, seasonFailure);
        const count = SEASON_EPISODES[number - 1];
        if (count === undefined) return void json(response, { status_code: 34 }, 404);
        json(response, {
          season_number: number,
          episodes: Array.from({ length: count }, (_, index) => {
            const episode = index + 1;
            const name = tmdbEpisodeName(id, number, episode, language);
            return {
              episode_number: episode,
              season_number: number,
              name,
              overview: name.startsWith("Episode") ? "" : `TMDB's story of ${name}.`,
              still_path: `/still-${id}-${number}-${episode}.jpg`,
              air_date: `2020-0${number}-0${episode}`,
              runtime: 50,
              vote_average: 8.2,
              // Too few votes on the third for a rating that says much.
              vote_count: episode === 3 ? 4 : 12,
              crew: [
                { name: "Dora Director", job: "Director" },
                { name: "Wim Writer", job: "Writer" },
                { name: "Cas Camera", job: "Director of Photography" },
              ],
              guest_stars: [
                { name: "Gus Guest", character: "The Visitor", profile_path: "/gus.jpg" },
              ],
            };
          }),
        });
      };
      return answer();
    }
    const title = /^\/3\/(movie|tv)\/(\d+)$/.exec(url.pathname);
    if (title) {
      const language = url.searchParams.get("language") ?? "en";
      details.set(language, (details.get(language) ?? 0) + 1);
      const id = Number(title[2]);
      const { name, original } = tmdbName(id, language);
      const series = title[1] === "tv";
      const answer = () =>
        json(response, {
          ...(series
            ? { name, original_name: original }
            : { title: name, original_title: original }),
          // Odd ids are comedies, even ones dramas; every third is Dutch.
          genres: [{ id: id % 2 ? 35 : 18 }],
          original_language: id % 3 === 0 ? "nl" : "en",
          popularity: id % 100,
          vote_average: 7.5,
          vote_count: 400,
          belongs_to_collection: null,
          backdrop_path: `/backdrop-${id}.jpg`,
          // What a title's details ask for when it opens.
          ...(opened
            ? {
                overview: `TMDB's story of ${name}.`,
                poster_path: `/poster-${id}.jpg`,
                runtime: series ? null : 101,
                episode_run_time: series ? [44] : undefined,
                created_by: series ? [{ name: "Ada Creator" }] : undefined,
                credits: {
                  cast: [{ name: "Alan Actor", character: "The Lead", profile_path: "/alan.jpg" }],
                  crew: [{ name: "Grace Director", job: "Director" }],
                },
              }
            : {}),
        });
      if (opened && aboutHeld) return void held.push(answer);
      return answer();
    }
    const services = /^\/3\/watch\/providers\/(movie|tv)$/.exec(url.pathname);
    if (services) {
      return json(response, {
        results: [
          { provider_id: 8, provider_name: "Netflix", display_priorities: { NL: 1 } },
          { provider_id: 72, provider_name: "Videoland", display_priorities: { NL: 2 } },
        ],
      });
    }
    const discover = /^\/3\/discover\/(movie|tv)$/.exec(url.pathname);
    if (discover) {
      const kind = discover[1] ?? "movie";
      const ids = url.searchParams.get("with_watch_providers") === "8" ? streamed[kind] : [];
      return json(response, {
        page: 1,
        total_pages: 1,
        results: (ids ?? []).map((id) => ({ id: Number(id) })),
      });
    }
    json(response, { status_code: 34 }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/3`,
    aboutRequests: () => about,
    seasonRequests: () => [...seasons],
    failSeasons: (answer) => {
      seasonFailure = answer;
      if (answer !== "hold") for (const held of heldSeasons.splice(0)) held();
    },
    holdAbout: (hold) => {
      aboutHeld = hold;
      if (!hold) for (const answer of held.splice(0)) answer();
    },
    detailRequests: (language) =>
      language === undefined
        ? [...details.values()].reduce((sum, count) => sum + count, 0)
        : (details.get(language) ?? 0),
    refuse: (value) => {
      refused = value;
    },
    stream: (kind, ids) => {
      streamed[kind] = ids;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // A season held open would keep it from closing.
        server.closeAllConnections();
      }),
  };
}
