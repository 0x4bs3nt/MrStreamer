// Real main runtime, provider catalogue, ffprobe and proxy establish the saved subtitle owner.
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { mainLayer } from "../src/main/runtime.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { OnlineSubtitles } from "../src/main/services/online-subtitles.ts";
import { collect, fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";
const hasTools =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
/** What the window decodes: the movie's FLAC sound plays as it is, with nothing to convert. */
const DECODERS = ["h264", "aac", "flac"] as const;

/** Answers SubDL at main's `fetch` with one English result for whatever is asked, and counts. */
function serveSubdl() {
  const request = fetch;
  let requests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "api.subdl.com") {
      requests++;
      const asked = url.searchParams;
      return Response.json({
        status: true,
        results: [{ tmdb_id: Number(asked.get("tmdb_id")), type: asked.get("type") }],
        subtitles: [
          {
            language: "English",
            release_name: "Cinema cut",
            url: "https://dl.subdl.com/fixture.srt",
            ...(asked.has("season_number")
              ? {
                  season: Number(asked.get("season_number")),
                  episode: Number(asked.get("episode_number")),
                }
              : {}),
          },
        ],
      });
    }
    if (url.hostname === "dl.subdl.com") {
      requests++;
      return new Response("1\n00:00:01,000 --> 00:00:03,000\nWelcome.\n");
    }
    return request(input, init);
  });
  return { request, requests: () => requests };
}

/** The real main services over a fake provider's lists, with SubDL set up and nothing asked yet. */
async function started(listed = 1) {
  const provider = await fakeProvider({ titles: listed, maxConnections: 2, slotReleaseMs: 0 });
  const service = serveSubdl();
  const runtime = runtimeFor(
    mainLayer({ ...testConfig(await tempDir()), ffmpeg: "ffmpeg", ffprobe: "ffprobe" }),
  );
  const subscriptions = await promised(runtime, Subscriptions);
  const titles = await promised(runtime, OnDemand);
  const playback = await promised(runtime, Playback);
  const subtitles = await promised(runtime, OnlineSubtitles);
  const saved = await subscriptions.add({
    server: provider.url,
    username: "demo",
    password: "demo",
  });
  await titles.refresh(saved.id);
  await subtitles.configure(
    { enabled: true, service: "subdl", languages: ["en"] },
    { subdl: { apiKey: "fixture-key" } },
  );
  return { provider, service, runtime, titles, playback, subtitles, subscriptionId: saved.id };
}

/** S1 E2 of the fixture series, opened as the window opens it. */
function secondEpisode({
  provider,
  titles,
  playback,
  subscriptionId,
}: Awaited<ReturnType<typeof started>>) {
  const series = provider.titles.series.find((each) => each.name === "TEST | Formats (NL)")!;
  const episode = series.seasons[0]![1]!;
  const ref = {
    kind: "episode" as const,
    subscriptionId,
    id: String(episode.id),
    seriesId: String(series.id),
    season: 1,
    episode: 2,
  };
  /** The provider lists another file under the episode's id from now on. */
  const relist = () =>
    provider.serveTitles((all) => ({
      ...all,
      series: all.series.map((each) =>
        each.id === series.id
          ? {
              ...each,
              seasons: each.seasons.map((season) =>
                season.map((file) =>
                  file.id === episode.id ? { ...file, container: "mkv" } : file,
                ),
              ),
            }
          : each,
      ),
    }));
  const open = async () => {
    const file = await titles.file(ref);
    return playback.openTitle(ref, file.url, DECODERS, file);
  };
  return { open, relist };
}

describe.skipIf(!hasTools)("saved subtitles of the actual playback session", () => {
  it("restores the exact file without a service request, keeps Off for it, and says which session's file was replaced", async () => {
    const { provider, service, runtime, titles, playback, subtitles, subscriptionId } =
      await started();
    const { request } = service;
    try {
      const movie = provider.titles.movies.find((title) =>
        title.name.startsWith("TEST | Long subtitles"),
      )!;
      const ref = { kind: "movie" as const, subscriptionId, id: String(movie.id) };
      const open = async () => {
        const file = await titles.file(ref);
        return playback.openTitle(ref, file.url, DECODERS, file);
      };
      const first = await open();
      expect(await subtitles.saved(first.sessionId)).toBeNull();
      expect(service.requests()).toBe(0);
      const found = await subtitles.search(first.sessionId);
      const chosen = await subtitles.choose(first.sessionId, found.results[0]!.id);
      expect(chosen.saved.subtitle?.release).toBe("Cinema cut");
      await subtitles.timing(first.sessionId, { offset: -2, speed: 25 / 24 });
      expect(service.requests()).toBe(2);
      await subtitles.hide(first.sessionId);
      await playback.close(first.sessionId);
      await expect(subtitles.saved(first.sessionId)).rejects.toBeDefined();
      const second = await open();
      expect(await subtitles.saved(second.sessionId)).toMatchObject({
        shown: false,
        timing: { offset: -2, speed: 25 / 24 },
        subtitle: { release: "Cinema cut" },
      });
      await subtitles.show(second.sessionId, chosen.saved.selection);
      expect(await subtitles.saved(second.sessionId)).not.toHaveProperty("shown");
      expect(service.requests()).toBe(2);
      const replaced = await collect(runtime, playback.fileReplaced);
      const before = await request(`${second.url}?start=0`);
      await before.arrayBuffer();
      expect(replaced).toEqual([]);
      provider.replaceMovieFile(movie.id, "title-mpeg4-mp3.avi");
      const answer = await request(`${second.url}?start=0`);
      expect(answer.ok).toBe(true);
      await answer.arrayBuffer();
      await vi.waitFor(() => expect(replaced).toEqual([second.sessionId]));
      await expect(subtitles.saved(second.sessionId)).rejects.toBeDefined();
      await expect(subtitles.show(second.sessionId, chosen.saved.selection)).rejects.toBeDefined();
      await subtitles.hide(second.sessionId);
      await playback.close(second.sessionId);
      const replacement = await open();
      expect(await subtitles.saved(replacement.sessionId)).toBeNull();
      expect(service.requests()).toBe(2);
    } finally {
      await runtime.dispose();
      vi.restoreAllMocks();
    }
  }, 30_000);

  it("keeps an episode's saved result, timing and search through a refresh that lists it unchanged, and ends them when its listing changed", async () => {
    const all = await started();
    const { provider, service, runtime, titles, playback, subtitles, subscriptionId } = all;
    const { open, relist } = secondEpisode(all);
    try {
      const playing = await open();
      const found = await subtitles.search(playing.sessionId);
      const chosen = await subtitles.choose(playing.sessionId, found.results[0]!.id);
      expect(chosen.saved.subtitle?.release).toBe("Cinema cut");
      expect(service.requests()).toBe(2);

      // The lists are fetched again while the episode plays, and say what they said before.
      const asked = provider.detailRequests();
      await titles.refresh(subscriptionId);
      await subtitles.timing(playing.sessionId, { offset: 1.5, speed: 1 }, chosen.saved.selection);
      await subtitles.hide(playing.sessionId);
      expect(await subtitles.saved(playing.sessionId)).toMatchObject({
        shown: false,
        timing: { offset: 1.5, speed: 1 },
        subtitle: { release: "Cinema cut" },
      });
      await subtitles.show(playing.sessionId, chosen.saved.selection);
      expect((await subtitles.search(playing.sessionId)).results).toHaveLength(1);
      expect(service.requests()).toBe(3);
      // The provider was asked once whether it still lists the file, not by every command.
      expect(provider.detailRequests()).toBe(asked + 1);

      // Now the provider lists another file under the episode's id: same session, other listing.
      relist();
      await titles.refresh(subscriptionId);
      await expect(subtitles.saved(playing.sessionId)).rejects.toBeDefined();
      await expect(
        subtitles.timing(playing.sessionId, { offset: 2, speed: 1 }, chosen.saved.selection),
      ).rejects.toBeDefined();
      await expect(subtitles.search(playing.sessionId)).rejects.toBeDefined();
      await expect(subtitles.show(playing.sessionId, chosen.saved.selection)).rejects.toBeDefined();
      await subtitles.hide(playing.sessionId);
      await playback.close(playing.sessionId);
      // The file listed now has nothing saved, and the old listing's result was not shown for it.
      const relisted = await open();
      expect(await subtitles.saved(relisted.sessionId)).toBeNull();
      expect(service.requests()).toBe(3);
    } finally {
      await runtime.dispose();
      vi.restoreAllMocks();
    }
  }, 30_000);

  it("keeps Off for the playing episode while the provider gives no answer after a refresh, and nothing that needs its listing", async () => {
    const all = await started();
    const { provider, service, runtime, titles, playback, subtitles, subscriptionId } = all;
    const { open } = secondEpisode(all);
    try {
      const playing = await open();
      const found = await subtitles.search(playing.sessionId);
      const { saved } = await subtitles.choose(playing.sessionId, found.results[0]!.id);
      await subtitles.timing(playing.sessionId, { offset: 1.5, speed: 1 }, saved.selection);

      await titles.refresh(subscriptionId);
      provider.failDetails(503);
      await expect(subtitles.saved(playing.sessionId)).rejects.toBeDefined();
      await expect(
        subtitles.timing(playing.sessionId, { offset: 2, speed: 1 }, saved.selection),
      ).rejects.toBeDefined();
      await expect(subtitles.search(playing.sessionId)).rejects.toBeDefined();
      await expect(subtitles.show(playing.sessionId, saved.selection)).rejects.toBeDefined();
      // Playback still holds the exact file: the viewer's Off for it needs no listing.
      await subtitles.hide(playing.sessionId);
      expect(service.requests()).toBe(2);

      provider.failDetails(null);
      expect(await subtitles.saved(playing.sessionId)).toMatchObject({
        shown: false,
        timing: { offset: 1.5, speed: 1 },
        subtitle: { release: "Cinema cut" },
      });
      await playback.close(playing.sessionId);
      // The closed session's Off reaches nothing: the file's next session chose the result again.
      const again = await open();
      await subtitles.show(again.sessionId, saved.selection);
      await subtitles.hide(playing.sessionId);
      expect(await subtitles.saved(again.sessionId)).not.toHaveProperty("shown");
    } finally {
      await runtime.dispose();
      vi.restoreAllMocks();
    }
  }, 30_000);

  it("keeps a playing episode's rights after 200 other titles' details were read, asking the provider whether it still lists the file", async () => {
    const all = await started(210);
    const { provider, service, runtime, titles, playback, subtitles, subscriptionId } = all;
    const { open, relist } = secondEpisode(all);
    /** As many other details as are kept at once: the series' own are kept no longer. */
    const readOthers = () =>
      Promise.all(
        provider.titles.movies
          .slice(0, 200)
          .map((movie) => titles.details("movie", { subscriptionId, id: String(movie.id) })),
      );
    try {
      const playing = await open();
      const found = await subtitles.search(playing.sessionId);
      const { saved } = await subtitles.choose(playing.sessionId, found.results[0]!.id);

      await readOthers();
      const asked = provider.detailRequests();
      await subtitles.timing(playing.sessionId, { offset: 1.5, speed: 1 }, saved.selection);
      await subtitles.hide(playing.sessionId);
      expect(await subtitles.saved(playing.sessionId)).toMatchObject({
        shown: false,
        timing: { offset: 1.5, speed: 1 },
        subtitle: { release: "Cinema cut" },
      });
      await subtitles.show(playing.sessionId, saved.selection);
      expect((await subtitles.search(playing.sessionId)).results).toHaveLength(1);
      // Its series was asked for once, and kept again.
      expect(provider.detailRequests()).toBe(asked + 1);

      // Not kept again, and the provider has no answer: nothing is taken for listed.
      await readOthers();
      provider.failDetails(503);
      await expect(subtitles.saved(playing.sessionId)).rejects.toBeDefined();
      await expect(subtitles.search(playing.sessionId)).rejects.toBeDefined();
      // It answers again, with another file under the episode's id.
      provider.failDetails(null);
      relist();
      await expect(subtitles.saved(playing.sessionId)).rejects.toBeDefined();
      await expect(
        subtitles.timing(playing.sessionId, { offset: 2, speed: 1 }, saved.selection),
      ).rejects.toBeDefined();
      await expect(subtitles.search(playing.sessionId)).rejects.toBeDefined();
      await expect(subtitles.show(playing.sessionId, saved.selection)).rejects.toBeDefined();
      await playback.close(playing.sessionId);
      const relisted = await open();
      expect(await subtitles.saved(relisted.sessionId)).toBeNull();
      expect(service.requests()).toBe(3);
    } finally {
      await runtime.dispose();
      vi.restoreAllMocks();
    }
  }, 60_000);
});
