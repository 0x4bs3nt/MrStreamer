import { describe, expect, it } from "vitest";
import { xtreamProvider } from "../src/main/providers/xtream.ts";

/** A provider whose panel answers every request with `body`. */
const answering = (body: unknown) =>
  xtreamProvider(
    { server: "https://panel.test", username: "fixture", password: "fixture" },
    { userAgent: "fixture", fetch: async () => Response.json(body) },
  );

const episode = (fields: { [key: string]: unknown }) => ({
  id: "1",
  episode_num: 1,
  season: 1,
  ...fields,
});

describe("Xtream details", () => {
  it("reads a series' details, its seasons and its episodes as panels write them", async () => {
    const details = await answering({
      info: {
        name: "Show",
        o_name: " Original ",
        description: "Told here.",
        genre: "Drama / Crime",
        actors: "Ada, Alan",
        release_date: "2001-02-03",
        backdrop_path: [null, "https://image.test/b.jpg"],
        cover: "https://image.test/p.jpg",
        episode_run_time: "45",
      },
      seasons: [
        { season_number: "0", name: "Specials", cover_big: "https://image.test/s0.jpg" },
        { season_number: 1, name: " ", cover: "https://image.test/s1.jpg" },
        { season_number: "x", name: "Not a season" },
      ],
      episodes: {
        "0": [episode({ id: 9, season: "0", episode_num: "1", title: "Pilot", info: [] })],
        "1": [
          episode({
            id: "10",
            title: " ",
            container_extension: "mkv",
            added: "1700000000",
            info: {
              plot: " A plot. ",
              duration: "00:44:30",
              movie_image: "not a url",
              releasedate: "2001-02-10",
            },
          }),
          episode({ id: "11", episode_num: "2", info: null, added: 0 }),
          episode({ id: "12", episode_num: "", title: "No number" }),
          { episode_num: 3, season: 1, title: "No id" },
        ],
      },
    }).seriesDetails("1");

    expect(details).toEqual({
      originalName: "Original",
      plot: "Told here.",
      genres: ["Drama", "Crime"],
      cast: ["Ada", "Alan"],
      directors: [],
      releaseDate: "2001-02-03",
      backdropUrl: "https://image.test/b.jpg",
      duration: 2700,
      posterUrl: "https://image.test/p.jpg",
      seasons: [
        { number: 0, name: "Specials", posterUrl: "https://image.test/s0.jpg" },
        { number: 1, name: null, posterUrl: "https://image.test/s1.jpg" },
      ],
      episodes: [
        {
          id: "9",
          season: 0,
          number: 1,
          name: "Pilot",
          plot: null,
          duration: null,
          stillUrl: null,
          airDate: null,
          addedAt: null,
          container: "mp4",
        },
        {
          id: "10",
          season: 1,
          number: 1,
          name: "Episode 1",
          plot: "A plot.",
          duration: 2670,
          stillUrl: null,
          airDate: "2001-02-10",
          addedAt: 1_700_000_000_000,
          container: "mkv",
        },
        {
          id: "11",
          season: 1,
          number: 2,
          name: "Episode 2",
          plot: null,
          duration: null,
          stillUrl: null,
          airDate: null,
          addedAt: null,
          container: "mp4",
        },
      ],
      container: null,
    });
  });

  it("reads episodes listed as an array of seasons, and a series panels know nothing more about", async () => {
    const listed = await answering({
      info: [],
      seasons: null,
      episodes: [
        [episode({ id: "1", info: { duration_secs: "2400", air_date: "2020-01-01" } })],
        [episode({ id: "2", season: 2 })],
      ],
    }).seriesDetails("1");
    expect(
      listed.episodes.map(({ id, season, duration, airDate }) => [id, season, duration, airDate]),
    ).toEqual([
      ["1", 1, 2400, "2020-01-01"],
      ["2", 2, null, null],
    ]);
    expect(listed).toMatchObject({ originalName: null, plot: null, duration: null, seasons: [] });

    for (const body of [{ info: null, episodes: null }, {}]) {
      expect(await answering(body).seriesDetails("1")).toMatchObject({
        originalName: null,
        posterUrl: null,
        seasons: [],
        episodes: [],
      });
    }
  });

  it("reads a movie's details, with or without its file's details", async () => {
    const movie = answering({
      info: {
        name: "Film",
        plot: "",
        description: "Told.",
        duration_secs: 0,
        duration: "01:40:00",
        movie_image: "https://image.test/m.jpg",
      },
      movie_data: { container_extension: " mkv " },
    });
    expect(await movie.movieDetails("1")).toMatchObject({
      plot: "Told.",
      duration: 6000,
      posterUrl: "https://image.test/m.jpg",
      container: "mkv",
      seasons: [],
      episodes: [],
    });
    for (const body of [
      { info: [], movie_data: [] },
      { info: null, movie_data: null },
    ]) {
      expect(await answering(body).movieDetails("1")).toMatchObject({
        plot: null,
        duration: null,
        container: null,
      });
    }
  });

  it("says the server isn't an Xtream API when the details don't look like them", async () => {
    const notAnApi = { error: { kind: "unreachable", server: "https://panel.test" } };
    await expect(answering({ info: "text" }).seriesDetails("1")).rejects.toMatchObject(notAnApi);
    await expect(answering({ episodes: "text" }).seriesDetails("1")).rejects.toMatchObject(
      notAnApi,
    );
    await expect(answering({ movie_data: 3 }).movieDetails("1")).rejects.toMatchObject(notAnApi);
  });
});
