import { describe, expect, it } from "vitest";
import { mainLayer } from "../src/main/runtime.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { VerifiedFiles } from "../src/main/platform/verified-files.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

describe("current movie and series filters", { timeout: 20000 }, () => {
  it("keeps complete choices for colliding provider IDs and variants, and drops a replaced file's observations", async () => {
    const provider = await fakeProvider({ titles: 1 });
    const other = await fakeProvider({ titles: 1, second: true });
    const seed = provider.titles.movies[0]!;
    let movies = [
      { ...seed, id: 70001, name: "Shared 4K (NL)", tmdb: "4567" },
      { ...seed, id: 70002, name: "Shared FHD (EN)", tmdb: "4567" },
      { ...seed, id: 70003, name: "No metadata", tmdb: "" },
      { ...seed, id: 70011, name: "Adult SD (PL)", tmdb: "", adult: true },
      { ...seed, id: 70005, name: "Category adult SD (FR)", tmdb: "", categoryId: "505" },
    ];
    provider.serveTitles((all) => ({ ...all, movies, series: [] }));
    other.serveTitles((all) => ({
      ...all,
      movies: [{ ...seed, id: 70001, name: "Shared HD (DE)", tmdb: "4567" }],
      series: [],
    }));
    const runtime = runtimeFor(mainLayer(testConfig(await tempDir())));
    try {
      const subscriptions = await promised(runtime, Subscriptions);
      const titles = await promised(runtime, OnDemand);
      const files = await promised(runtime, VerifiedFiles);
      const settings = await promised(runtime, Settings);
      const first = await subscriptions.add({
        server: provider.url,
        username: "demo",
        password: "demo",
      });
      const second = await subscriptions.add({
        server: other.url,
        username: "demo",
        password: "demo",
      });
      await titles.refresh(first.id);
      await titles.refresh(second.id);
      const choices = {
        qualities: ["4k", "full-hd", "hd", "unknown"],
        languages: ["de", "en", "nl", "unknown"],
        verified: [],
        files: 0,
      };
      expect(await titles.filterOptions("movie")).toEqual(choices);
      expect(await titles.filterOptions("series")).toEqual({
        qualities: [],
        languages: [],
        verified: [],
        files: 0,
      });
      const [source] = await subscriptions.saved();
      if (!source) throw new Error("Expected saved subscription");
      const file = await titles.file({ kind: "movie", subscriptionId: first.id, id: "70001" });
      await files.remember(source.key, source.fileRevision, {
        kind: "movie",
        id: "70001",
        fileKey: "observed-file",
        listingKey: file.listingKey,
        audio: ["en", null],
        subtitles: ["nl"],
      });
      const observed = {
        ...choices,
        verified: [
          { kind: "audio", language: "en" },
          { kind: "audio", language: "unknown" },
          { kind: "subtitles", language: "nl" },
        ],
        files: 1,
      };
      expect(await titles.filterOptions("movie")).toEqual(observed);
      // Hints of titles for adults only once the viewer shows them, and they filter that row.
      const listedBefore = [provider.titleListRequests(), provider.detailRequests()];
      await settings.update({ adultTitles: true });
      expect(await titles.filterOptions("movie")).toEqual({
        ...observed,
        qualities: ["4k", "full-hd", "hd", "sd", "unknown"],
        languages: ["de", "en", "fr", "nl", "pl", "unknown"],
      });
      expect(
        await titles.collection({
          kind: "movie",
          id: "adult",
          offset: 0,
          limit: 20,
          filters: { quality: "sd", language: "pl" },
        }),
      ).toMatchObject({ total: 1, titles: [{ id: "70011" }] });
      expect([provider.titleListRequests(), provider.detailRequests()]).toEqual(listedBefore);
      await settings.update({ adultTitles: false });
      expect(await titles.filterOptions("movie")).toEqual(observed);
      expect(
        await titles.searchKind("movie", "shared", { quality: "hd", language: "de" }),
      ).toMatchObject({
        total: 1,
        titles: [
          {
            subscriptionId: second.id,
            id: "70001",
            versions: expect.arrayContaining([
              expect.objectContaining({ subscriptionId: first.id, id: "70001" }),
            ]),
          },
        ],
      });
      movies = movies.map((movie) => (movie.id === 70001 ? { ...movie, container: "mp4" } : movie));
      await titles.refresh(first.id);
      expect(await titles.filterOptions("movie")).toEqual(choices);
      const before = [
        provider.titleListRequests(),
        other.titleListRequests(),
        provider.detailRequests(),
        other.detailRequests(),
        provider.fileRequests(),
        other.fileRequests(),
      ];
      expect(await titles.filterOptions("movie")).toEqual(choices);
      expect(await titles.filterOptions("series")).toEqual({
        qualities: [],
        languages: [],
        verified: [],
        files: 0,
      });
      expect([
        provider.titleListRequests(),
        other.titleListRequests(),
        provider.detailRequests(),
        other.detailRequests(),
        provider.fileRequests(),
        other.fileRequests(),
      ]).toEqual(before);
    } finally {
      await runtime.dispose();
    }
  });

  it("offers empty choices while lists load or fail, then preserves the accepted lists after a failed refresh", async () => {
    const provider = await fakeProvider({ titles: 1 });
    const seed = provider.titles.movies[0]!;
    provider.serveTitles((all) => ({
      ...all,
      movies: [{ ...seed, name: "Loading HD (EN)", tmdb: "" }],
      series: [],
    }));
    const runtime = runtimeFor(mainLayer(testConfig(await tempDir())));
    try {
      const subscriptions = await promised(runtime, Subscriptions);
      const titles = await promised(runtime, OnDemand);
      const saved = await subscriptions.add({
        server: provider.url,
        username: "demo",
        password: "demo",
      });
      const empty = { qualities: [], languages: [], verified: [], files: 0 };
      expect(await titles.filterOptions("movie")).toEqual(empty);
      const held = provider.hold("titles");
      const refresh = titles.refresh(saved.id);
      await held.arrived;
      try {
        expect(await titles.filterOptions("movie")).toEqual(empty);
        expect(await titles.filterOptions("series")).toEqual(empty);
      } finally {
        held.release();
      }
      await refresh;
      const loaded = { qualities: ["hd"], languages: ["en"], verified: [], files: 0 };
      expect(await titles.filterOptions("movie")).toEqual(loaded);
      provider.failTitles(503);
      await expect(titles.refresh(saved.id)).rejects.toThrow();
      expect(await titles.filterOptions("movie")).toEqual(loaded);
      expect(await titles.filterOptions("series")).toEqual(empty);
    } finally {
      await runtime.dispose();
    }
  });

  it("uses the refreshed series name for episode hints when its details reopen", async () => {
    const provider = await fakeProvider({ titles: 2 });
    const seed = provider.titles.series[0]!;
    let series = [{ ...seed, name: "Hint sample 4K (NL)" }];
    provider.serveTitles((all) => ({ ...all, movies: [], series }));
    const runtime = runtimeFor(mainLayer(testConfig(await tempDir())));
    try {
      const subscriptions = await promised(runtime, Subscriptions);
      const titles = await promised(runtime, OnDemand);
      const saved = await subscriptions.add({
        server: provider.url,
        username: "demo",
        password: "demo",
      });
      const target = { subscriptionId: saved.id, id: String(seed.id) };
      await titles.refresh(saved.id);
      await titles.details("series", target);
      expect(await titles.filterOptions("series")).toMatchObject({
        qualities: ["4k"],
        languages: ["nl"],
      });
      series = [{ ...seed, name: "Hint sample HD (EN)" }];
      await titles.refresh(saved.id);
      await titles.details("series", target);
      const before = [
        provider.titleListRequests(),
        provider.detailRequests(),
        provider.fileRequests(),
      ];
      expect(await titles.filterOptions("series")).toMatchObject({
        qualities: ["hd"],
        languages: ["en"],
      });
      expect(await titles.searchKind("series", "hint", { language: "nl" })).toMatchObject({
        total: 0,
      });
      expect(
        await titles.searchKind("series", "hint", { quality: "hd", language: "en" }),
      ).toMatchObject({
        total: 1,
      });
      expect([
        provider.titleListRequests(),
        provider.detailRequests(),
        provider.fileRequests(),
      ]).toEqual(before);
    } finally {
      await runtime.dispose();
    }
  });
  it("filters all 4K versions while retaining every menu alternative and excluding matching HD files", async () => {
    const provider = await fakeProvider({ titles: 1 });
    const seed = provider.titles.movies[0]!;
    provider.serveTitles((all) => ({
      ...all,
      series: [],
      movies: [
        { ...seed, id: 71001, name: "Harbour 4K (EN)", tmdb: "4567", adult: false },
        { ...seed, id: 71002, name: "Harbour 4K (NL)", tmdb: "4567", adult: false },
        { ...seed, id: 71003, name: "Harbour HD (NL)", tmdb: "4567", adult: false },
      ],
    }));
    const runtime = runtimeFor(mainLayer(testConfig(await tempDir())));
    const subscriptions = await promised(runtime, Subscriptions);
    const titles = await promised(runtime, OnDemand);
    const files = await promised(runtime, VerifiedFiles);
    const saved = await subscriptions.add({
      server: provider.url,
      username: "demo",
      password: "demo",
    });
    await titles.refresh(saved.id);
    const [source] = await subscriptions.saved();
    if (!source) throw new Error("Expected saved subscription");
    for (const [id, audio] of [
      ["71001", ["en"]],
      ["71002", ["nl"]],
      ["71003", ["nl", "de"]],
    ] as const) {
      const file = await titles.file({ kind: "movie", subscriptionId: saved.id, id });
      await files.remember(source.key, source.fileRevision, {
        kind: "movie",
        id,
        fileKey: id,
        listingKey: file.listingKey,
        audio: [...audio],
        subtitles: [],
      });
    }
    const before = [
      provider.titleListRequests(),
      provider.detailRequests(),
      provider.fileRequests(),
    ];
    const collection = (filters?: Parameters<typeof titles.collection>[0]["filters"]) =>
      titles.collection({
        kind: "movie",
        id: "4k",
        offset: 0,
        limit: 20,
        ...(filters ? { filters } : {}),
      });
    expect((await collection()).titles[0]?.id).toBe("71001");
    const dutch = await collection({ language: "nl", verified: { kind: "audio", language: "nl" } });
    expect(dutch).toMatchObject({
      total: 1,
      unfiltered: 1,
      titles: [
        {
          id: "71002",
          versions: expect.arrayContaining([
            expect.objectContaining({ id: "71001" }),
            expect.objectContaining({ id: "71002" }),
            expect.objectContaining({ id: "71003" }),
          ]),
        },
      ],
    });
    expect(await collection({ language: "nl", quality: "hd" })).toMatchObject({
      total: 0,
      titles: [],
    });
    expect(
      await collection({ language: "nl", verified: { kind: "audio", language: "de" } }),
    ).toMatchObject({ total: 0, titles: [] });
    expect([
      provider.titleListRequests(),
      provider.detailRequests(),
      provider.fileRequests(),
    ]).toEqual(before);
  });

  it("filters one actual version, remembers read tracks across restart and rejects removed files without fetching", async () => {
    const dir = await tempDir();
    const provider = await fakeProvider({ titles: 2 });
    const seed = provider.titles.movies[0]!;
    let movies = [
      { ...seed, id: 70001, name: "Filter sample 4K (NL)", tmdb: "4567", adult: false },
      { ...seed, id: 70002, name: "Filter sample HD (EN)", tmdb: "4567", adult: false },
    ];
    provider.serveTitles((all) => ({ ...all, movies, series: [] }));
    const start = async () => {
      const runtime = runtimeFor(mainLayer(testConfig(dir)));
      return {
        runtime,
        subscriptions: await promised(runtime, Subscriptions),
        titles: await promised(runtime, OnDemand),
        files: await promised(runtime, VerifiedFiles),
      };
    };
    let app = await start();
    const subscription = await app.subscriptions.add({
      server: provider.url,
      username: "demo",
      password: "demo",
    });
    expect((await app.titles.filterOptions("movie")).qualities).toEqual([]);
    expect(provider.titleListRequests()).toBe(0);
    await app.titles.refresh(subscription.id);
    const [source] = await app.subscriptions.saved();
    if (!source) throw new Error("Expected saved subscription");
    await app.files.remember(source.key, source.fileRevision, {
      kind: "movie",
      id: "70001",
      fileKey: "exact-file",
      listingKey: (await app.titles.file({ kind: "movie", subscriptionId: source.id, id: "70001" }))
        .listingKey,
      audio: ["en"],
      subtitles: ["nl"],
    });
    const before = [
      provider.titleListRequests(),
      provider.detailRequests(),
      provider.fileRequests(),
    ];
    expect(
      await app.titles.collection({
        kind: "movie",
        id: "all",
        offset: 0,
        limit: 20,
        filters: { quality: "4k", language: "en", verified: { kind: "audio", language: "en" } },
      }),
    ).toMatchObject({ total: 0, unfiltered: 1, titles: [] });
    const matched = await app.titles.searchKind("movie", "sample", {
      quality: "4k",
      language: "nl",
      verified: { kind: "audio", language: "en" },
    });
    expect(matched).toMatchObject({
      total: 1,
      unfiltered: 1,
      titles: [
        {
          id: "70001",
          versions: expect.arrayContaining([
            expect.objectContaining({ subscriptionId: source.id, id: "70002", tags: ["EN", "HD"] }),
          ]),
        },
      ],
    });
    expect(await app.titles.filterOptions("movie")).toMatchObject({
      files: 1,
      verified: expect.arrayContaining([
        { kind: "audio", language: "en" },
        { kind: "subtitles", language: "nl" },
      ]),
    });
    expect(await app.titles.filterOptions("series")).toMatchObject({ files: 0, verified: [] });
    expect([
      provider.titleListRequests(),
      provider.detailRequests(),
      provider.fileRequests(),
    ]).toEqual(before);
    await app.runtime.dispose();
    app = await start();
    expect(
      (
        await app.titles.searchKind("movie", "sample", {
          verified: { kind: "audio", language: "en" },
        })
      ).titles[0]?.id,
    ).toBe("70001");
    movies = movies.slice(1);
    await app.titles.refresh(source.id);
    expect(await app.titles.filterOptions("movie")).toMatchObject({ files: 0, verified: [] });
    expect(
      (
        await app.titles.searchKind("movie", "sample", {
          verified: { kind: "audio", language: "en" },
        })
      ).total,
    ).toBe(0);
    expect(
      (
        await app.titles.searchKind("movie", "sample", {
          verified: { kind: "audio", language: "unknown" },
        })
      ).total,
    ).toBe(0);
    await app.runtime.dispose();
  });

  it("counts only observed episode track languages and revalidates remembered facts only against current opened series details", async () => {
    const dir = await tempDir();
    const provider = await fakeProvider({ titles: 2 });
    let series = [provider.titles.series[0]!];
    provider.serveTitles((all) => ({ ...all, movies: [], series }));
    const start = async () => {
      const runtime = runtimeFor(mainLayer(testConfig(dir)));
      return {
        runtime,
        subscriptions: await promised(runtime, Subscriptions),
        titles: await promised(runtime, OnDemand),
        files: await promised(runtime, VerifiedFiles),
      };
    };
    let app = await start();
    const subscription = await app.subscriptions.add({
      server: provider.url,
      username: "demo",
      password: "demo",
    });
    await app.titles.refresh(subscription.id);
    const [source] = await app.subscriptions.saved();
    if (!source) throw new Error("Expected saved subscription");
    const details = await app.titles.details("series", {
      subscriptionId: source.id,
      id: String(series[0]!.id),
    });
    if (details.kind !== "series") throw new Error("Expected series details");
    const first = details.seasons[0]!.episodes[0]!;
    const file = await app.titles.file({
      kind: "episode",
      subscriptionId: source.id,
      id: first.id,
      seriesId: first.seriesId,
      season: first.season,
      episode: first.number,
    });
    await app.files.remember(source.key, source.fileRevision, {
      kind: "episode",
      id: first.id,
      seriesId: first.seriesId,
      fileKey: "episode-source",
      listingKey: file.listingKey,
      audio: ["en", null],
      subtitles: ["nl"],
    });
    const before = [
      provider.titleListRequests(),
      provider.detailRequests(),
      provider.fileRequests(),
    ];
    const observed = async () => {
      const [title] = await app.titles.titles("series", [
        { subscriptionId: source.id, id: first.seriesId },
      ]);
      return title?.versions.find(
        (version) => version.subscriptionId === source.id && version.id === first.seriesId,
      )?.observed;
    };
    const tracks = { files: 1, audio: ["en", null], subtitles: ["nl"] };
    expect(await observed()).toEqual(tracks);
    expect(await app.titles.filterOptions("series")).toMatchObject({
      files: 1,
      verified: [
        { kind: "audio", language: "en" },
        { kind: "audio", language: "unknown" },
        { kind: "subtitles", language: "nl" },
      ],
    });
    expect(
      (
        await app.titles.searchKind("series", "formats", {
          verified: { kind: "audio", language: "en" },
        })
      ).total,
    ).toBe(1);
    expect(
      (
        await app.titles.searchKind("series", "formats", {
          verified: { kind: "audio", language: "unknown" },
        })
      ).total,
    ).toBe(1);
    expect(
      (
        await app.titles.searchKind("series", "formats", {
          verified: { kind: "subtitles", language: "unknown" },
        })
      ).total,
    ).toBe(0);
    expect([
      provider.titleListRequests(),
      provider.detailRequests(),
      provider.fileRequests(),
    ]).toEqual(before);
    await app.runtime.dispose();
    app = await start();
    expect(await observed()).toBeUndefined();
    expect(await app.titles.filterOptions("series")).toMatchObject({ files: 0, verified: [] });
    await app.titles.details("series", { subscriptionId: source.id, id: first.seriesId });
    expect(await app.titles.filterOptions("series")).toMatchObject({ files: 1 });
    expect(await observed()).toEqual(tracks);
    series = series.map((listed) => ({
      ...listed,
      seasons: listed.seasons.map((episodes) =>
        episodes.filter((episode) => String(episode.id) !== first.id),
      ),
    }));
    await app.titles.refresh(source.id);
    expect(await observed()).toBeUndefined();
    expect(await app.titles.filterOptions("series")).toMatchObject({ files: 0, verified: [] });
    await app.titles.details("series", { subscriptionId: source.id, id: first.seriesId });
    expect(await observed()).toBeUndefined();
    expect(
      (
        await app.titles.searchKind("series", "formats", {
          verified: { kind: "audio", language: "en" },
        })
      ).total,
    ).toBe(0);
    await app.runtime.dispose();
  });
});
