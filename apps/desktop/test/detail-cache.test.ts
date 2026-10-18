import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import * as Layer from "effect/Layer";
import { ViewingStore } from "@mrstreamer/core/viewing/service";
import { databaseLayer } from "../src/main/platform/database.ts";
import {
  DetailCache,
  detailCacheLayer,
  type DetailKey,
  type DetailRecord,
} from "../src/main/platform/detail-cache.ts";
import { viewingStoreLayer } from "../src/main/platform/viewing-store.ts";
import { watchlistStoreLayer } from "../src/main/platform/watchlist-store.ts";
import { promised, runtimeFor, tempDir } from "./support.ts";

const providerKey = {
  kind: "provider",
  account: "account",
  subscriptionId: "saved",
  sourceStamp: "saved-login",
  titleKind: "series",
  id: "123",
} satisfies DetailKey;
const provider = {
  kind: "provider",
  at: 100,
  catalogueStamp: "accepted-catalogue",
  value: {
    originalName: "Series",
    plot: null,
    genres: [],
    cast: [],
    directors: [],
    releaseDate: null,
    duration: null,
    posterUrl: null,
    backdropUrl: null,
    seasons: [],
    episodes: [],
    container: null,
  },
} satisfies DetailRecord;

async function started(dir: string) {
  const runtime = runtimeFor(
    Layer.mergeAll(detailCacheLayer, viewingStoreLayer, watchlistStoreLayer).pipe(
      Layer.provide(databaseLayer(dir)),
    ),
  );
  return {
    runtime,
    cache: await promised(runtime, DetailCache),
    viewing: await promised(runtime, ViewingStore),
  };
}

describe("opened title detail storage", () => {
  it("restores only the same source and removes opened-title history on account erasure", async () => {
    const dir = await tempDir();
    const first = await started(dir);
    const about = { kind: "about", titleKind: "series", id: "123", language: "en" } as const;
    const missing = { kind: "about", at: 100, value: null } as const;
    await first.cache.remember(providerKey, provider);
    await first.cache.remember(about, missing);
    await first.runtime.dispose();
    const second = await started(dir);
    expect(await second.cache.read(providerKey)).toMatchObject(provider);
    expect(await second.cache.read({ ...providerKey, account: "other" })).toBeNull();
    expect(await second.cache.read({ ...providerKey, sourceStamp: "new-login" })).toBeNull();
    expect(await second.cache.read({ ...providerKey, importRevision: "new-mapping" })).toBeNull();
    expect(await second.cache.read({ ...about, language: "nl" })).toBeNull();
    await second.cache.forget("saved");
    expect(await second.cache.read(providerKey)).toBeNull();
    expect(await second.cache.read(about)).toMatchObject(missing);
    await second.cache.remember(providerKey, provider);
    const other = { ...providerKey, account: "other", subscriptionId: "other-saved" };
    await second.cache.remember(other, provider);
    await second.viewing.erase("account");
    expect(await second.cache.read(providerKey)).toBeNull();
    // Shared detail keys and timestamps still reveal which titles were opened.
    expect(await second.cache.read(about)).toBeNull();
    expect(await second.cache.read(other)).toMatchObject(provider);
  });

  it("treats corrupt and unknown disk formats as misses without breaking later writes", async () => {
    const dir = await tempDir();
    const { cache } = await started(dir);
    await cache.remember(providerKey, provider);
    const disk = new DatabaseSync(join(dir, "mrstreamer.db"));
    try {
      const healthy = { kind: "season", id: "unaffected", number: 1, language: "en" } as const;
      await cache.remember(healthy, { kind: "season", at: 100, value: null });
      for (const payload of [
        "{",
        '{"schema":2,"kind":"provider"}',
        '{"schema":1,"kind":"provider","value":{}}',
        "x".repeat(9 * 1024 * 1024),
      ]) {
        await cache.remember(providerKey, provider);
        disk
          .prepare("update title_detail_cache set payload = ? where owner = ?")
          .run(payload, providerKey.subscriptionId);
        expect(await cache.read(providerKey)).toBeNull();
        expect(await cache.read(healthy)).toMatchObject({ kind: "season", value: null });
      }
    } finally {
      disk.close();
    }
    await cache.remember(providerKey, provider);
    expect(await cache.read(providerKey)).toMatchObject(provider);
  });

  it("bounds tiny missing answers and leaves huge uncached details usable by their caller", async () => {
    const { cache } = await started(await tempDir());
    for (let id = 0; id < 2050; id++)
      await cache.remember(
        { kind: "season", id: String(id), number: 1, language: "en" },
        { kind: "season", at: 100, value: null },
      );
    expect(await cache.read({ kind: "season", id: "0", number: 1, language: "en" })).toBeNull();
    expect(
      await cache.read({ kind: "season", id: "2049", number: 1, language: "en" }),
    ).toMatchObject({ value: null });
    await cache.remember(providerKey, {
      ...provider,
      value: { ...provider.value, plot: "x".repeat(9 * 1024 * 1024) },
    });
    expect(await cache.read(providerKey)).toBeNull();
    await cache.remember(providerKey, provider);
    expect(await cache.read(providerKey)).toMatchObject(provider);
  });
  it("persists only parsed display fields, excluding undeclared stream locations and headers", async () => {
    const dir = await tempDir();
    const { cache } = await started(dir);
    const input = {
      ...provider,
      url: "private-stream",
      value: {
        ...provider.value,
        headers: { Authorization: "private" },
        seasons: [{ number: 1, name: "Season 1", posterUrl: null, url: "private-season" }],
        episodes: [
          {
            id: "episode",
            season: 1,
            number: 1,
            name: "Episode",
            plot: null,
            duration: null,
            stillUrl: null,
            airDate: null,
            addedAt: null,
            container: "mkv",
            url: "private-episode",
          },
        ],
      },
    };
    await cache.remember(providerKey, input);
    const result = await cache.read(providerKey);
    expect(result).toMatchObject({ kind: "provider", value: { episodes: [{ id: "episode" }] } });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(input.value.episodes[0]?.url).toBe("private-episode");
    const disk = new DatabaseSync(join(dir, "mrstreamer.db"), { readOnly: true });
    try {
      expect(disk.prepare("select payload from title_detail_cache").get()?.payload).not.toContain(
        "private",
      );
    } finally {
      disk.close();
    }
  });

  it("keeps only declared TMDB display fields in title and season records", async () => {
    const dir = await tempDir();
    const { cache } = await started(dir);
    const cast = [{ name: "Actor", character: "Lead", profile: null, token: "private-cast" }];
    const about = {
      original: "Title",
      language: "en",
      overview: null,
      poster: null,
      backdrop: null,
      genres: [],
      runtime: null,
      cast,
      directors: [],
      token: "private-title",
    };
    const episode = {
      number: 1,
      name: "Episode",
      overview: null,
      still: null,
      airDate: null,
      runtime: null,
      rating: null,
      cast,
      directors: [],
      token: "private-episode",
    };
    const titleKey = { kind: "about", titleKind: "series", id: "123", language: "en" } as const;
    const seasonKey = { kind: "season", id: "123", number: 1, language: "en" } as const;
    await cache.remember(titleKey, { kind: "about", at: 100, value: about });
    await cache.remember(seasonKey, { kind: "season", at: 100, value: [episode] });
    expect(await cache.read(titleKey)).toMatchObject({
      value: { original: "Title", cast: [{ name: "Actor" }] },
    });
    expect(await cache.read(seasonKey)).toMatchObject({
      value: [{ number: 1, cast: [{ name: "Actor" }] }],
    });
    const disk = new DatabaseSync(join(dir, "mrstreamer.db"), { readOnly: true });
    try {
      const rows = disk.prepare("select payload from title_detail_cache").all();
      expect(rows).toHaveLength(2);
      expect(JSON.stringify(rows)).not.toContain("private");
    } finally {
      disk.close();
    }
    expect(cast[0]?.token).toBe("private-cast");
  });

  it("evicts old records before live payload exceeds 64 MiB", async () => {
    const { cache } = await started(await tempDir());
    const record = { ...provider, value: { ...provider.value, plot: "x".repeat(6 * 1024 * 1024) } };
    for (let id = 0; id < 11; id++)
      await cache.remember({ ...providerKey, id: String(id) }, record);
    expect(await cache.read({ ...providerKey, id: "0" })).toBeNull();
    expect(await cache.read({ ...providerKey, id: "10" })).toMatchObject({ kind: "provider" });
  });

  it("makes room for a new series when the oldest cached details are small", async () => {
    const dir = await tempDir();
    const { cache, runtime } = await started(dir);
    for (let id = 0; id < 65; id++)
      await cache.remember(
        { kind: "about", titleKind: "movie", id: String(id), language: "en" },
        { kind: "about", at: 100, value: null },
      );
    const large = { ...provider, value: { ...provider.value, plot: "x".repeat(7 * 1024 * 1024) } };
    for (let id = 0; id < 9; id++) await cache.remember({ ...providerKey, id: String(id) }, large);
    const next = { ...provider, value: { ...provider.value, plot: "y".repeat(2 * 1024 * 1024) } };
    const key = { ...providerKey, id: "next" };
    for (let attempt = 0; attempt < 4; attempt++) await cache.remember(key, next);
    await runtime.dispose();
    const restarted = await started(dir);
    const restored = await restarted.cache.read(key);
    expect(restored?.kind).toBe("provider");
    expect(restored?.kind === "provider" && restored.value?.plot?.length).toBe(
      next.value.plot.length,
    );
    const disk = new DatabaseSync(join(dir, "mrstreamer.db"), { readOnly: true });
    try {
      expect(
        Number(disk.prepare("select sum(bytes) as bytes from title_detail_cache").get()?.bytes),
      ).toBeLessThanOrEqual(64 * 1024 * 1024);
    } finally {
      disk.close();
      await restarted.runtime.dispose();
    }
  });
});
