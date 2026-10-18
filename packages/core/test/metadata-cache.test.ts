import { afterEach, describe, expect, it, vi } from "vitest";
import { metadataStore, type MetadataFile } from "../src/metadata/store.ts";
import { TmdbError, tmdb } from "../src/metadata/tmdb.ts";

const DAY = 86_400_000;
afterEach(() => vi.useRealTimers());

/** Runs the public background fetch to completion without real retry/pacing waits. */
async function finish(store: ReturnType<typeof metadataStore>) {
  for (let turn = 0; turn < 100 && store.status().fetching; turn++) {
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
  }
  expect(store.status().fetching).toBe(false);
  await store.flush();
}

function serviceStore(
  initial: MetadataFile | null,
  fault: "offline" | "busy" | "unavailable" | "missing" | null,
  abandon = false,
) {
  let saved = initial;
  const at = 1000 * DAY;
  const onService = vi.fn(async (_kind: string, _id: number, _region: string, page: number) => {
    if (page === 2 && fault) {
      if (fault === "offline") throw new TypeError("offline");
      throw new TmdbError(
        fault === "busy"
          ? { kind: "busy", retryAfter: 1 }
          : fault === "unavailable"
            ? { kind: "unavailable", detail: "fixture" }
            : { kind: "missing" },
      );
    }
    if (abandon && _kind === "tv" && page === 2) store.want([]);
    return { ids: [page === 1 ? "new" : "last"], pages: 2 };
  });
  const store = metadataStore({
    read: async () => structuredClone(initial),
    write: async (file) => {
      saved = structuredClone(file);
    },
    client: {
      ...tmdb({ key: "test" }),
      details: async () => {
        throw new TmdbError({ kind: "missing" });
      },
      services: async () => [{ id: 1, name: "Cinema", priority: 1 }],
      onService,
    },
    region: "NL",
    now: () => at,
    onChange: () => {},
  });
  store.want([{ kind: "movie", tmdbId: "1", addedAt: 1 }]);
  return { store, saved: () => saved, onService };
}

const complete: MetadataFile = {
  version: 1,
  entries: {},
  services: {
    region: "NL",
    at: 990 * DAY,
    movie: [{ id: 1, name: "Cinema", priority: 1, ids: ["old", "retained"] }],
    tv: [],
  },
};

describe("complete streaming-service snapshots", () => {
  it.each(["offline", "busy", "unavailable"] as const)(
    "retains complete membership and freshness after a midpage %s failure, including restart",
    async (fault) => {
      vi.useFakeTimers();
      const failed = serviceStore(complete, fault);
      await finish(failed.store);
      expect(failed.saved()?.services).toEqual(complete.services);
      expect([...failed.store.services("movie")[0]!.ids]).toEqual(["old", "retained"]);
      const restarted = metadataStore({
        read: async () => failed.saved(),
        write: async () => {},
        client: null,
        region: "NL",
        now: () => 1000 * DAY,
        onChange: () => {},
      });
      await Promise.resolve();
      expect([...restarted.services("movie")[0]!.ids]).toEqual(["old", "retained"]);
      const recovered = serviceStore(failed.saved(), null);
      await finish(recovered.store);
      expect(recovered.saved()?.services?.at).toBe(1000 * DAY);
      expect([...recovered.store.services("movie")[0]!.ids]).toEqual(["new", "last"]);
    },
  );

  it("exposes no partial service snapshot after a first failed crawl", async () => {
    vi.useFakeTimers();
    const first = serviceStore(null, "offline");
    await finish(first.store);
    expect(first.store.services("movie")).toEqual([]);
    expect(first.saved()?.services ?? null).toBeNull();
  });

  it("does not publish a crawl abandoned during its final request", async () => {
    vi.useFakeTimers();
    const abandoned = serviceStore(complete, null, true);
    await finish(abandoned.store);
    expect(abandoned.saved()?.services).toEqual(complete.services);
    expect([...abandoned.store.services("movie")[0]!.ids]).toEqual(["old", "retained"]);
  });

  it("treats a missing terminal page separately from a transient failure", async () => {
    vi.useFakeTimers();
    const terminal = serviceStore(complete, "missing");
    await finish(terminal.store);
    expect([...terminal.store.services("movie")[0]!.ids]).toEqual(["new"]);
    expect(terminal.saved()?.services?.at).toBe(1000 * DAY);
  });
});

describe("warmed metadata aliases", () => {
  it("checks the raw expiry even without a key, including a backward clock correction", async () => {
    let now = 182 * DAY - 1;
    const store = metadataStore({
      read: async () => ({
        version: 1,
        entries: { "movie:1": { at: 0, names: { en: "Translated" }, original: "Original" } },
      }),
      write: async () => {},
      client: null,
      region: "NL",
      now: () => now,
      onChange: () => {},
    });
    await Promise.resolve();
    expect(store.searchName("movie", "1")).toContain("translated");
    now++;
    expect(store.get("movie", "1")).toBeNull();
    expect(store.name("movie", "1", "en")).toBeNull();
    expect(store.searchName("movie", "1")).toBe("");
    now -= DAY;
    expect(store.searchName("movie", "1")).toContain("translated");
  });

  it("removes cached aliases when a refreshed title becomes missing", async () => {
    vi.useFakeTimers();
    const store = metadataStore({
      read: async () => ({
        version: 1,
        entries: { "movie:1": { at: 0, names: { en: "Obsolete" } } },
      }),
      write: async () => {},
      client: {
        ...tmdb({ key: "test" }),
        details: async () => {
          throw new TmdbError({ kind: "missing" });
        },
        services: async () => [],
      },
      region: "NL",
      now: () => 151 * DAY,
      onChange: () => {},
    });
    await Promise.resolve();
    expect(store.searchName("movie", "1")).toBe("obsolete");
    store.want([{ kind: "movie", tmdbId: "1", addedAt: 0 }]);
    await finish(store);
    expect(store.status().known).toBe(1);
    expect(store.get("movie", "1")).toBeNull();
    expect(store.searchName("movie", "1")).toBe("");
  });
});
