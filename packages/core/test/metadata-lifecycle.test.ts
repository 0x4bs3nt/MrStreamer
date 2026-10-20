import { afterEach, describe, expect, it, vi } from "vitest";
import {
  metadataStore,
  type MetadataDeps,
  type MetadataFile,
  type Wanted,
} from "../src/metadata/store.ts";
import { tmdb, TmdbError, type Tmdb } from "../src/metadata/tmdb.ts";

const title = (id = "1"): Wanted => ({ kind: "movie", tmdbId: id, addedAt: Number(id) });
const answer = (name = "Title") => ({
  name,
  original: "Original",
  genres: [35],
  language: "en",
  popularity: 10,
  rating: 7.5,
  votes: 400,
  collection: null,
  backdrop: "/picture.jpg",
});

function open(
  client: Tmdb,
  initial: MetadataFile | null = null,
  overrides: Partial<MetadataDeps> = {},
) {
  let saved = initial;
  const write = vi.fn(async (file: MetadataFile) => {
    saved = structuredClone(file);
  });
  const store = metadataStore({
    read: async () => structuredClone(initial),
    write,
    client,
    region: "NL",
    onChange: () => {},
    ...overrides,
  });
  return { store, write, saved: () => saved };
}

const clientWith = (details: Tmdb["details"]): Tmdb => ({
  ...tmdb({ key: "fixture" }),
  details,
  services: async () => [],
});

async function finish(store: ReturnType<typeof metadataStore>) {
  for (let turn = 0; turn < 100 && store.status().fetching; turn++) {
    await vi.runOnlyPendingTimersAsync();
  }
  expect(store.status().fetching).toBe(false);
  await store.flush();
}

afterEach(() => vi.useRealTimers());

describe("metadata request ownership", () => {
  it("aborts the actual TMDB request when the last source disappears, without marking it missing or refused", async () => {
    vi.useFakeTimers();
    const aborted = vi.fn();
    const request = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted();
              reject(init.signal?.reason);
            },
            { once: true },
          );
        }),
    );
    const { store, saved } = open(tmdb({ key: "fixture", fetch: request }));
    store.want([title()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    store.want([]);
    await finish(store);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(saved()?.entries).toEqual({});
    expect(store.status()).toMatchObject({ known: 0, wanted: 0, refused: false });
    await store.close();
  });

  it.each(["answer", "missing", "refused"] as const)(
    "ignores an obsolete late %s, then fetches the replacement language",
    async (result) => {
      vi.useFakeTimers();
      const late = Promise.withResolvers<ReturnType<typeof answer>>();
      const signals: AbortSignal[] = [];
      const details = vi.fn<Tmdb["details"]>(async (_kind, _id, language, signal) => {
        if (signal) signals.push(signal);
        return language === "en" ? late.promise : answer("Nederlands");
      });
      const { store, saved } = open(clientWith(details));
      store.want([title()]);
      await vi.advanceTimersByTimeAsync(0);
      store.want([title()], "nl");
      expect(signals[0]?.aborted).toBe(true);
      if (result === "answer") late.resolve(answer("Obsolete"));
      else late.reject(new TmdbError({ kind: result }));
      await finish(store);
      expect(details).toHaveBeenCalledTimes(2);
      expect(store.status()).toMatchObject({ known: 1, refused: false });
      expect(store.name("movie", "1", "nl")?.name).toBe("Nederlands");
      expect(saved()?.entries["movie:1"]?.names).toEqual({ nl: "Nederlands" });
      await store.close();
    },
  );

  it.each(["busy", "unavailable"] as const)(
    "closes a %s retry without advancing the retry clock",
    async (kind) => {
      vi.useFakeTimers();
      const details = vi.fn<Tmdb["details"]>(async () => {
        throw new TmdbError(
          kind === "busy" ? { kind, retryAfter: 60 } : { kind, detail: "offline" },
        );
      });
      const { store } = open(clientWith(details));
      store.want([title(), title("2")]);
      await vi.advanceTimersByTimeAsync(0);
      expect(details).toHaveBeenCalledTimes(1);
      await store.close();
      expect(store.status()).toMatchObject({ fetching: false, refused: false, known: 0 });
      expect(details).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      store.want([title("3")]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(details).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves retry-after across replacement while cancelling the obsolete retry", async () => {
    vi.useFakeTimers();
    const details = vi.fn<Tmdb["details"]>(async (_kind, id) => {
      if (id === "1") throw new TmdbError({ kind: "busy", retryAfter: 60 });
      return answer();
    });
    const { store } = open(clientWith(details));
    store.want([title()]);
    await vi.advanceTimersByTimeAsync(0);
    store.want([title("2")]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(details).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await finish(store);
    expect(details.mock.calls.map((call) => call[1])).toEqual(["1", "2"]);
    expect(store.status()).toMatchObject({ known: 1, refused: false });
    await store.close();
  });

  it("awaits a noncooperative request and persistence on close, preserving earlier completed answers on restart", async () => {
    vi.useFakeTimers();
    const late = Promise.withResolvers<ReturnType<typeof answer>>();
    const writing = Promise.withResolvers<void>();
    let saved: MetadataFile | null = null;
    let fail = true;
    const write = vi.fn(async (file: MetadataFile) => {
      if (fail) {
        fail = false;
        throw new Error("disk unavailable");
      }
      await writing.promise;
      saved = structuredClone(file);
    });
    const details = vi.fn<Tmdb["details"]>(async (_kind, id) =>
      id === "2" ? answer("Completed") : late.promise,
    );
    const { store } = open(clientWith(details), null, { write });
    store.want([title(), title("2")]);
    await vi.advanceTimersByTimeAsync(25);
    let closed = false;
    const closing = store.close().then(() => {
      closed = true;
    });
    expect(closed).toBe(false);
    late.resolve(answer("Late"));
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    expect(write).toHaveBeenCalledTimes(2);
    writing.resolve();
    await closing;
    expect(store.status().fetching).toBe(false);
    const restarted = metadataStore({
      read: async () => saved,
      write: async () => {},
      client: null,
      region: "NL",
      onChange: () => {},
    });
    await restarted.flush();
    expect(restarted.name("movie", "2", "en")?.name).toBe("Completed");
    expect(restarted.get("movie", "1")).toBeNull();
    await restarted.close();
  });

  it("keeps a completed primary answer when its English fallback is cancelled", async () => {
    vi.useFakeTimers();
    const fallback = Promise.withResolvers<ReturnType<typeof answer>>();
    const details = vi.fn<Tmdb["details"]>(async (_kind, _id, language) =>
      language === "en" ? fallback.promise : { ...answer(), name: null, language: "fr" },
    );
    const { store, saved } = open(clientWith(details));
    store.want([title()], "nl");
    await vi.advanceTimersByTimeAsync(0);
    expect(details).toHaveBeenCalledTimes(2);
    store.want([]);
    fallback.resolve(answer("Late English"));
    await finish(store);
    expect(saved()?.entries["movie:1"]?.names).toEqual({ nl: null });
    expect(store.name("movie", "1", "nl")?.name).toBe("Original");
    await store.close();
  });

  it("keeps equal-content demand running without aborting or repeating its 40 title requests", async () => {
    vi.useFakeTimers();
    const aborted = vi.fn();
    const details = vi.fn<Tmdb["details"]>(
      async (_kind, id, _language, signal) =>
        new Promise((resolve, reject) => {
          const cancel = () => {
            clearTimeout(timer);
            aborted();
            reject(signal?.reason);
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", cancel);
            resolve(answer(`Title ${id}`));
          }, 200);
          signal?.addEventListener("abort", cancel, { once: true });
        }),
    );
    const { store } = open(clientWith(details));
    const wanted = Array.from({ length: 40 }, (_, i) => title(String(i + 1)));
    store.want(wanted);
    await vi.advanceTimersByTimeAsync(250);
    expect(store.status().fetching).toBe(true);
    store.want(wanted.map((item) => ({ ...item })));
    await finish(store);
    expect(aborted).not.toHaveBeenCalled();
    expect(details).toHaveBeenCalledTimes(40);
    expect(store.status().known).toBe(40);
    await store.close();
  });

  it("restarts equal demand after an offline run gives up", async () => {
    vi.useFakeTimers();
    let offline = true;
    const details = vi.fn<Tmdb["details"]>(async () => {
      if (offline) throw new TmdbError({ kind: "unavailable", detail: "offline" });
      return answer();
    });
    const { store } = open(clientWith(details));
    const wanted = Array.from({ length: 40 }, (_, i) => title(String(i + 1)));
    store.want(wanted);
    await finish(store);
    expect(store.status()).toMatchObject({ known: 0, fetching: false, refused: false });
    const failedCalls = details.mock.calls.length;
    expect(failedCalls).toBeGreaterThanOrEqual(24 * 3);
    offline = false;
    store.want(wanted.map((item) => ({ ...item })));
    expect(store.status().fetching).toBe(true);
    await finish(store);
    expect(details.mock.calls.length - failedCalls).toBe(40);
    expect(store.status().known).toBe(40);
    await store.close();
  });

  it("retries titles before the service crawl after refreshing during offline retry completion", async () => {
    vi.useFakeTimers();
    let offline = true;
    const lastRetry = Promise.withResolvers<ReturnType<typeof answer>>();
    const attempts = new Map<string, number>();
    const exhausted = new Set<string>();
    let knownAtCrawl: number | undefined;
    const details = vi.fn<Tmdb["details"]>(async (_kind, id) => {
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      if (id === "40" && attempt === 3) return lastRetry.promise;
      if (offline) {
        if (attempt === 3) exhausted.add(id);
        throw new TmdbError({ kind: "unavailable", detail: "offline" });
      }
      return answer();
    });
    const { store } = open({
      ...clientWith(details),
      services: async (kind) => (kind === "movie" ? [{ id: 8, name: "Service", priority: 1 }] : []),
      onService: async () => {
        knownAtCrawl = store.status().known;
        return { ids: [], pages: 1 };
      },
    });
    const wanted = Array.from({ length: 40 }, (_, i) => title(String(i + 1)));
    store.want(wanted);
    for (let turn = 0; turn < 2000 && exhausted.size < 24; turn++)
      await vi.advanceTimersByTimeAsync(10);
    expect(exhausted.size).toBeGreaterThanOrEqual(24);
    for (let turn = 0; turn < 100 && vi.getTimerCount() > 0; turn++)
      await vi.runOnlyPendingTimersAsync();
    expect(attempts.get("40")).toBe(3);
    expect(store.status()).toMatchObject({ known: 0, fetching: true, refused: false });
    const failedCalls = details.mock.calls.length;

    offline = false;
    store.want(wanted.map((item) => ({ ...item })));
    lastRetry.reject(new TmdbError({ kind: "unavailable", detail: "offline" }));
    await finish(store);
    expect(store.status()).toMatchObject({ known: 40, fetching: false, refused: false });
    expect(knownAtCrawl).toBe(40);
    expect(details.mock.calls.length - failedCalls).toBe(40);
    await store.close();
  });

  it("keeps a still-wanted shared TMDB id cached after a source replacement", async () => {
    vi.useFakeTimers();
    const details = vi.fn<Tmdb["details"]>(async () => answer());
    const { store } = open(clientWith(details));
    store.want([title()]);
    await finish(store);
    store.want([title()]);
    await finish(store);
    expect(details).toHaveBeenCalledTimes(1);
    expect(store.get("movie", "1")?.genres).toEqual([35]);
    await store.close();
  });

  it("resumes a cancelled English fallback without fetching the completed translation again", async () => {
    vi.useFakeTimers();
    const firstEnglish = Promise.withResolvers<ReturnType<typeof answer>>();
    let english = 0;
    const details = vi.fn<Tmdb["details"]>(async (_kind, _id, language) => {
      if (language !== "en") return { ...answer(), name: null, language: "fr" };
      return ++english === 1 ? firstEnglish.promise : answer("English name");
    });
    const { store } = open(clientWith(details));
    store.want([title()], "nl");
    await vi.advanceTimersByTimeAsync(0);
    store.want([]);
    firstEnglish.resolve(answer("Obsolete English"));
    await finish(store);
    store.want([title()], "nl");
    await finish(store);
    expect(store.name("movie", "1", "nl")?.name).toBe("English name");
    expect(details.mock.calls.map((call) => call[2])).toEqual(["nl", "en", "en"]);
    await store.close();
  });

  it("retains all currently wanted translations and metadata in a large warm catalogue without refetching", async () => {
    vi.useFakeTimers();
    const wanted = Array.from({ length: 25_000 }, (_, i) => title(String(i + 1)));
    const initial: MetadataFile = {
      version: 1,
      entries: Object.fromEntries(
        wanted.map(({ tmdbId }) => {
          const { name, ...metadata } = answer();
          return [
            `movie:${tmdbId}`,
            { ...metadata, at: Date.now(), names: { en: name, nl: "Nederlands" } },
          ];
        }),
      ),
    };
    const details = vi.fn<Tmdb["details"]>(async () => answer());
    const { store } = open(clientWith(details), initial);
    store.want(wanted, "nl");
    await finish(store);
    store.want([...wanted], "en");
    await finish(store);
    expect(store.status().known).toBe(25_000);
    expect(details).not.toHaveBeenCalled();
    for (const { tmdbId } of wanted) {
      expect(store.name("movie", tmdbId, "nl")?.name).toBe("Nederlands");
      expect(store.get("movie", tmdbId)).toMatchObject({
        genres: [35],
        rating: 7.5,
        backdrop: "/picture.jpg",
      });
    }
    await store.close();
  });
});

describe("metadata closure and replacement boundaries", () => {
  it("reuses every warm answer after narrow and empty wants, persistence and restart", async () => {
    vi.useFakeTimers();
    const wanted = Array.from({ length: 12_000 }, (_, index) => title(String(index + 1)));
    const initial: MetadataFile = {
      version: 1,
      entries: Object.fromEntries(
        wanted.map(({ tmdbId }, index) => [
          `movie:${tmdbId}`,
          {
            at: Date.now() - index * 1000,
            names: { en: `English ${index} `.repeat(8), nl: `Nederlands ${index} `.repeat(8) },
            genres: [35],
            rating: 7.5,
            backdrop: `/picture-${tmdbId}.jpg`,
          },
        ]),
      ),
    };
    const details = vi.fn<Tmdb["details"]>(async () => answer());
    const { store, saved } = open(clientWith(details), initial);
    store.want(wanted, "nl");
    await finish(store);
    store.want([title("12000")], "nl");
    await finish(store);
    expect(store.name("movie", "11999", "nl")?.name).toBe(
      initial.entries["movie:11999"]?.names?.nl,
    );
    store.want([]);
    await finish(store);
    store.want(wanted, "en");
    await finish(store);
    expect(store.status().known).toBe(wanted.length);
    expect(details).not.toHaveBeenCalled();
    await store.close();

    const restarted = open(clientWith(details), saved());
    restarted.store.want(wanted, "nl");
    await finish(restarted.store);
    expect(details).not.toHaveBeenCalled();
    expect(restarted.store.status().known).toBe(wanted.length);
    for (const { tmdbId } of wanted) {
      expect(restarted.store.name("movie", tmdbId, "nl")?.name).toBe(
        initial.entries[`movie:${tmdbId}`]?.names?.nl,
      );
      expect(restarted.store.get("movie", tmdbId)).toMatchObject({
        genres: [35],
        rating: 7.5,
        backdrop: `/picture-${tmdbId}.jpg`,
      });
    }
    await restarted.store.close();
  });

  it("closes before a delayed cache load without starting requests or dropping loaded data", async () => {
    vi.useFakeTimers();
    const reading = Promise.withResolvers<unknown>();
    const details = vi.fn<Tmdb["details"]>(async () => answer());
    const { store } = open(clientWith(details), null, { read: () => reading.promise });
    store.want([title()]);
    const closing = store.close();
    expect(store.close()).toBe(closing);
    reading.resolve({
      version: 1,
      entries: Object.fromEntries(
        Array.from({ length: 2000 }, (_, index) => [
          `movie:${index + 1}`,
          { at: Date.now(), names: { en: "Cached" } },
        ]),
      ),
    });
    await closing;
    expect(details).not.toHaveBeenCalled();
    expect(store.name("movie", "1", "en")?.name).toBe("Cached");
    expect(store.name("movie", "2000", "en")?.name).toBe("Cached");
    expect(store.status().fetching).toBe(false);
  });

  it.each(["services", "onService"] as const)(
    "aborts an owned %s request and leaves the complete service snapshot intact",
    async (method) => {
      vi.useFakeTimers();
      const cancelled = vi.fn();
      const request = (signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              cancelled();
              reject(signal.reason);
            },
            { once: true },
          );
        });
      const client: Tmdb = {
        ...clientWith(async () => answer()),
        services: async (_kind, _region, signal) =>
          method === "services" ? request(signal) : [{ id: 1, name: "Cinema", priority: 1 }],
        onService: async (_kind, _id, _region, _page, signal) => request(signal),
      };
      const initial: MetadataFile = {
        version: 1,
        entries: {},
        services: {
          region: "NL",
          at: Date.now() - 8 * 86_400_000,
          movie: [{ id: 1, name: "Cinema", priority: 1, ids: ["old"] }],
          tv: [],
        },
      };
      const { store, saved } = open(client, initial);
      store.want([title()]);
      await vi.advanceTimersByTimeAsync(0);
      await store.close();
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(saved()?.services).toEqual(initial.services);
      expect([...store.services("movie")[0]!.ids]).toEqual(["old"]);
      expect(store.status().refused).toBe(false);
    },
  );

  it("does not reset the start rate through repeated language replacements", async () => {
    vi.useFakeTimers();
    const details = vi.fn<Tmdb["details"]>(async (_kind, _id, language) => answer(language));
    const { store } = open(clientWith(details));
    const wanted = Array.from({ length: 100 }, (_, i) => title(String(i + 1)));
    store.want(wanted);
    await vi.advanceTimersByTimeAsync(0);
    for (let turn = 0; turn < 20; turn++) {
      store.want(wanted, String(turn));
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(details).toHaveBeenCalledTimes(1);
    await store.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(store.status().refused).toBe(false);
  });

  it("uses at most eight concurrent requests and cancels every one at shutdown", async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let aborted = 0;
    const details = vi.fn<Tmdb["details"]>(async (_kind, _id, _language, signal) => {
      inFlight++;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            inFlight--;
            aborted++;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    });
    const { store } = open(clientWith(details));
    store.want(Array.from({ length: 100 }, (_, i) => title(String(i + 1))));
    await vi.advanceTimersByTimeAsync(1000);
    expect(inFlight).toBe(8);
    expect(details).toHaveBeenCalledTimes(8);
    await store.close();
    expect(inFlight).toBe(0);
    expect(aborted).toBe(8);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a current missing answer and key refusal as authoritative, then allows a new key's store", async () => {
    vi.useFakeTimers();
    const missing = vi.fn<Tmdb["details"]>(async () => {
      throw new TmdbError({ kind: "missing" });
    });
    const first = open(clientWith(missing));
    first.store.want([title()]);
    await finish(first.store);
    first.store.want([title()]);
    await finish(first.store);
    expect(missing).toHaveBeenCalledTimes(1);
    expect(first.store.status()).toMatchObject({ known: 1, refused: false });
    await first.store.close();

    const refused = vi.fn<Tmdb["details"]>(async () => {
      throw new TmdbError({ kind: "refused" });
    });
    const oldKey = open(clientWith(refused), first.saved());
    oldKey.store.want([title("2")]);
    await finish(oldKey.store);
    oldKey.store.want([title("2")]);
    expect(oldKey.store.status().refused).toBe(true);
    expect(refused).toHaveBeenCalledTimes(1);
    await oldKey.store.close();

    const renewed = vi.fn<Tmdb["details"]>(async () => answer("Renewed"));
    const newKey = open(clientWith(renewed), oldKey.saved());
    newKey.store.want([title(), title("2")]);
    await finish(newKey.store);
    expect(renewed).toHaveBeenCalledTimes(1);
    expect(newKey.store.status()).toMatchObject({ known: 2, refused: false });
    await newKey.store.close();
  });
});

it("restarts when language churn returns to the original run before cancellation settles", async () => {
  vi.useFakeTimers();
  const late = Promise.withResolvers<ReturnType<typeof answer>>();
  let starts = 0;
  const details = vi.fn<Tmdb["details"]>(async () =>
    starts++ === 0 ? late.promise : answer("Current"),
  );
  const { store } = open(clientWith(details));
  const wanted = [title()];
  store.want(wanted, "en");
  await vi.advanceTimersByTimeAsync(0);
  store.want(wanted, "nl");
  store.want(wanted, "en");
  late.resolve(answer("Obsolete"));
  await finish(store);
  expect(details).toHaveBeenCalledTimes(2);
  expect(details.mock.calls.map((call) => call[2])).toEqual(["en", "en"]);
  expect(store.name("movie", "1", "en")?.name).toBe("Current");
  await store.close();
});
