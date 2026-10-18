import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import type { OnDemandCatalogue, ProviderTitle } from "@mrstreamer/core/provider";
import type {
  CatalogueOwner,
  WorkerCalls,
  WorkerReply,
  WorkerSetup,
} from "../src/main/ondemand/protocol.ts";
import { tempDir } from "./support.ts";
import { writeJsonFile } from "../src/main/platform/json-file.ts";

const workers: Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});

function start(dir: string, clock?: BigInt64Array) {
  const entry =
    inject("catalogueWorker") ??
    new URL("../src/main/ondemand/catalogue-worker.ts", import.meta.url);
  const setup: WorkerSetup = {
    metadataPath: join(dir, "metadata.json.gz"),
    userAgent: "test",
    tmdb: null,
  };
  // Only the test worker's wall clock changes. Production calls and message shapes stay intact.
  const worker = clock
    ? new Worker(
        `const {workerData} = require("node:worker_threads");
        const clock = new BigInt64Array(workerData.clock);
        Date.now = () => Number(Atomics.load(clock, 0));
        import(${JSON.stringify(typeof entry === "string" ? pathToFileURL(entry).href : entry.href)});`,
        { eval: true, workerData: { ...setup, clock: clock.buffer } },
      )
    : new Worker(entry, { workerData: setup });
  workers.push(worker);
  let sequence = 0;
  function call<M extends keyof WorkerCalls>(
    method: M,
    args: WorkerCalls[M]["args"],
  ): Promise<WorkerCalls[M]["result"]> {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const receive = (reply: WorkerReply) => {
        if (reply.id !== id) return;
        worker.off("message", receive);
        if (reply.ok) resolve(reply.value as WorkerCalls[M]["result"]);
        else reject(reply.error);
      };
      worker.on("message", receive);
      worker.postMessage({ id, method, args, interfaceLanguage: "en" });
    });
  }
  const owner: CatalogueOwner = { subscriptionId: "saved", key: "account", dir };
  return {
    call,
    owner,
    async accept(name: string, revision: number, title: Partial<ProviderTitle> = {}) {
      const catalogue: OnDemandCatalogue = {
        movieCategories: [],
        seriesCategories: [],
        series: [],
        movies: [
          {
            id: "1",
            name,
            posterUrl: null,
            backdropUrl: null,
            rating: null,
            addedAt: 1,
            releaseDate: null,
            categoryIds: [],
            adult: false,
            container: "mkv",
            ...title,
          },
        ],
      };
      await call("refresh", {
        ...owner,
        revision,
        catalogue,
        account: { kind: "m3u", link: "http://unused.test/list" },
      });
      await call("finishRefresh", { ...owner, revision, keep: true });
    },
    async names() {
      const result = await call("byIds", {
        owners: [owner],
        language: "en",
        kind: "movie",
        versions: [{ subscriptionId: owner.subscriptionId, id: "1" }],
      });
      return result.map((title) => title.title);
    },
    stop: () => worker.terminate(),
  };
}

describe("accepted catalogue persistence", () => {
  it("retries a failed write on flush and reloads the accepted lists without a provider", async () => {
    const dir = await tempDir();
    const path = join(dir, "ondemand.json.gz");
    const app = start(dir);
    await app.accept("Previous", 1);
    await app.call("flush", {});
    // A directory at the atomic rename destination makes the next write fail on every platform.
    await rm(path);
    await mkdir(path);
    await app.accept("Latest", 2);
    await app.call("flush", {});
    expect((await stat(path)).isDirectory()).toBe(true);
    await rm(path, { recursive: true });
    await app.call("flush", {});
    await app.stop();
    expect(await start(dir).names()).toEqual(["Latest"]);
  });

  it("keeps only the newest replacement while a failed snapshot waits", async () => {
    const dir = await tempDir();
    const path = join(dir, "ondemand.json.gz");
    const app = start(dir);
    await app.accept("Superseded", 1);
    await mkdir(path);
    await app.call("flush", {});
    await app.accept("Replacement", 2);
    await rm(path, { recursive: true });
    await Promise.all([app.call("flush", {}), app.call("flush", {})]);
    await app.stop();
    expect(await start(dir).names()).toEqual(["Replacement"]);
  });

  it("forgets a failed snapshot so a later flush cannot resurrect it", async () => {
    const dir = await tempDir();
    const path = join(dir, "ondemand.json.gz");
    const app = start(dir);
    await app.accept("Removed", 1);
    await mkdir(path);
    await app.call("flush", {});
    await rm(path, { recursive: true });
    await app.call("forget", app.owner);
    await app.call("flush", {});
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await app.names()).toEqual([]);
  });

  it("settles repeated persistent write failures within the existing shutdown allowance", async () => {
    const dir = await tempDir();
    const app = start(dir);
    await app.accept("Accepted", 1);
    await mkdir(join(dir, "ondemand.json.gz"));
    const began = performance.now();
    await app.call("flush", {});
    await app.call("flush", {});
    expect(performance.now() - began).toBeLessThan(2000);
    expect(await app.names()).toEqual(["Accepted"]);
  });
});

const DAY = 86_400_000;
const clockAt = (at: number) => {
  const clock = new BigInt64Array(new SharedArrayBuffer(8));
  Atomics.store(clock, 0, BigInt(at));
  return { clock, set: (time: number) => Atomics.store(clock, 0, BigInt(time)) };
};

describe("warmed worker collections", () => {
  it("updates rolling week/month and UTC-year membership without another catalogue or metadata event", async () => {
    const began = Date.UTC(2026, 11, 31, 12);
    const time = clockAt(began);
    const app = start(await tempDir(), time.clock);
    await app.accept("Boundary (MULTI)", 1, {
      addedAt: began - 6 * DAY,
      releaseDate: "2025-01-01",
    });
    const list = (id: "new-week" | "new-month" | "recent") =>
      app.call("collection", {
        owners: [app.owner],
        language: "en",
        kind: "movie",
        id,
        offset: 0,
        limit: 20,
      });
    expect((await list("new-week")).total).toBe(1);
    expect((await list("new-month")).total).toBe(1);
    expect((await list("recent")).total).toBe(1);
    time.set(began + DAY);
    expect((await list("new-week")).total).toBe(0);
    expect((await list("new-month")).total).toBe(1);
    expect((await list("recent")).total).toBe(0);
    time.set(began + 24 * DAY);
    expect((await list("new-month")).total).toBe(0);
    // A clock correction re-evaluates both membership and the next deadline.
    time.set(began);
    expect((await list("new-week")).total).toBe(1);
    expect((await list("new-month")).total).toBe(1);
    expect((await list("recent")).total).toBe(1);
  });

  it("drops expired metadata from warm aliases, rows and tiles while keeping provider titles offline", async () => {
    const dir = await tempDir();
    const at = Date.UTC(2026, 0, 1);
    await writeJsonFile(join(dir, "metadata.json.gz"), {
      version: 1,
      entries: {
        "movie:1": {
          at: at + DAY,
          names: { en: "Translation" },
          original: "Original",
          genres: [35],
          language: "en",
          popularity: 10,
          rating: 9,
          votes: 500,
        },
      },
      services: {
        region: "US",
        at,
        movie: [{ id: 1, name: "Cinema", priority: 1, ids: ["1"] }],
        tv: [],
      },
    });
    const time = clockAt(at + 182 * DAY - 1);
    const app = start(dir, time.clock);
    await app.accept("Provider (MULTI)", 1, { tmdbId: "1" });
    const search = () =>
      app.call("search", { owners: [app.owner], language: "en", query: "translation" });
    await vi.waitFor(async () => expect((await search()).movies).toHaveLength(1));
    const page = () =>
      app.call("collection", {
        owners: [app.owner],
        language: "en",
        kind: "movie",
        id: "all",
        offset: 0,
        limit: 20,
      });
    const rows = () =>
      app.call("rows", { owners: [app.owner], language: "en", kind: "movie", tab: "for-you" });
    const tiles = (of: "genres" | "services") =>
      app.call("tiles", { owners: [app.owner], language: "en", kind: "movie", of });
    expect((await page()).titles[0]?.title).toBe("Translation");
    expect((await rows()).map((row) => row.id)).toContain("popular");
    expect(await tiles("genres")).toHaveLength(1);
    expect(await tiles("services")).toHaveLength(1);
    time.set(at + 182 * DAY);
    // Services expire independently while the newer title metadata still applies.
    expect(await tiles("services")).toEqual([]);
    expect((await page()).titles[0]?.title).toBe("Translation");
    expect(await tiles("genres")).toHaveLength(1);
    time.set(at + 183 * DAY);
    expect((await search()).movies).toEqual([]);
    expect((await page()).titles[0]?.title).toBe("Provider");
    expect(await rows()).toEqual([]);
    expect(await tiles("genres")).toEqual([]);
    expect(await tiles("services")).toEqual([]);
    // The unchanged in-memory metadata is usable again after a backward correction.
    time.set(at + 181 * DAY);
    expect((await search()).movies).toHaveLength(1);
    expect((await page()).titles[0]?.title).toBe("Translation");
    expect(await tiles("services")).toHaveLength(1);
  });
});
