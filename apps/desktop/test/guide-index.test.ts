// A guide as it downloads and is indexed in the background: what the status says at each step,
// the guide before answering until the new one is whole, and the files of each kept while
// anything reads them. The guide service runs on the app's store and indexing worker, with an own
// guide and an address the test hands out as it likes, and reads of the channels, builds and
// writes of the store it can hold or fail.
import { chmod, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { AppFailure } from "@mrstreamer/contracts/errors";
import { Failed } from "@mrstreamer/core/failure";
import { openGuideIndex } from "@mrstreamer/core/guide/index-file";
import { GUIDE_KEPT } from "@mrstreamer/core/guide/limits";
import type { CatalogueChannels } from "@mrstreamer/core/guide/programmes";
import {
  Guide,
  GuideAddresses,
  GuideCatalogue,
  GuideIndexer,
  GuideSearcher,
  GuideSource,
  GuideStore,
  GUIDE_ARCHIVE_MS,
} from "@mrstreamer/core/guide/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Worker, type WorkerOptions } from "node:worker_threads";
import * as Fiber from "effect/Fiber";
import { describe, expect, it, vi } from "vitest";
import { guideIndexerLayer } from "../src/main/platform/guide-indexer.ts";
import { guideSearcherLayer } from "../src/main/platform/guide-searcher.ts";
import { guideStoreLayer } from "../src/main/platform/guide-store.ts";
import { guideIndexWorker, guideSearchWorker, runtimeFor, tempDir } from "./support.ts";

// Each guide download is indexed in a worker thread started from source, which strips the types
// of what it imports anew: a few hundred milliseconds each on a busy machine.
vi.setConfig({ testTimeout: 20_000 });

const ID = "own";
const HOUR = 60 * 60 * 1000;
/** 20:10 at +02:00, where the guides here write their times. */
const NOW = Date.parse("2026-10-02T20:10:00+02:00");
const at = (time: string) => Date.parse(`2026-10-02T${time}:00+02:00`);
const ADDRESS = "https://guide.example.org/xmltv.xml";

/**
 * The files of `dir` the process holds open, by name, where the system says (Linux's /proc);
 * none elsewhere.
 */
async function openIn(dir: string): Promise<string[]> {
  const fds = await readdir("/proc/self/fd").catch(() => []);
  const paths = await Promise.all(fds.map((fd) => readlink(`/proc/self/fd/${fd}`).catch(() => "")));
  return paths
    .filter((path) => path.startsWith(`${dir}/`))
    .map((path) => path.slice(dir.length + 1));
}

/** Why `promise` failed, as the window is told. */
const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (cause: unknown) => (cause instanceof Failed ? cause.error : cause),
  );

/** Everything kept of a guide in `dir`, by name: what is set, documents, indexes, downloads. */
async function guideFilesIn(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [])).filter((name) => name.startsWith("guide")).sort();
}

/** The guide indexes kept in `dir`, by name. */
async function indexesIn(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(".sqlite"));
}

const programme = (id: string, from: string, to: string, title: string) =>
  `<programme start="20261002${from}00 +0200" stop="20261002${to}00 +0200" channel="${id}"><title>${title}</title></programme>`;
const tv = (...elements: string[]) =>
  `<?xml version="1.0" encoding="utf-8"?><tv>${elements.join("")}</tv>`;

/**
 * Channels "1" to `count`, whose guide ids are "one.test" for the first and "c<n>.test" for each
 * other, after the ones `before` names for a channel.
 */
function catalogue(
  count = 1,
  before: Readonly<Record<string, readonly string[]>> = {},
): CatalogueChannels {
  const all = Array.from({ length: count }, (_, at): LiveChannel => {
    const id = String(at + 1);
    return {
      subscriptionId: ID,
      id,
      name: `Channel ${id}`,
      title: `Channel ${id}`,
      tags: [],
      number: at + 1,
      logoUrl: null,
      categoryIds: [],
      variants: [{ id, name: `Channel ${id}`, tags: [], quality: null }],
      catchupDays: null,
    };
  });
  const guideIdOf = (id: string) => (id === "1" ? "one.test" : `c${id}.test`);
  const byId = new Map(all.map((channel) => [channel.id, channel]));
  const byGuideId = new Map(all.map((channel) => [guideIdOf(channel.id), channel]));
  return {
    all,
    searchNames: all.map((channel) => channel.title.toLowerCase()),
    channel: (id) => byId.get(id),
    listed: (id) => byId.has(id),
    guideIdsOf: (id) => (byId.has(id) ? [...(before[id] ?? []), guideIdOf(id)] : []),
    channelsOf: (guideId) => {
      const channel = byGuideId.get(guideId);
      if (channel) return [channel];
      return all.filter((each) => before[each.id]?.includes(guideId));
    },
  };
}

/**
 * A worker that opens what it builds from, the index before or else the document, and never ends
 * on its own, as a build of a large guide stopped half way; ending it waits for `ended`.
 */
function stubbornWorker(options: WorkerOptions, ended: Promise<void>, attached: () => void) {
  const worker = new Worker(
    `const { workerData, parentPort } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const { openSync } = require("node:fs");
    if (workerData.previous) {
      const db = new DatabaseSync(workerData.previous, { readOnly: true });
      db.prepare("select count(*) from programme").get();
    } else openSync(workerData.document, "r");
    parentPort.postMessage({ kind: "progress", programmes: 1 });
    setInterval(() => {}, 1000);`,
    { ...options, eval: true },
  );
  worker.once("message", attached);
  const terminate = worker.terminate.bind(worker);
  worker.terminate = async () => {
    await ended;
    return terminate();
  };
  return worker;
}

/** Something a test lets go of when it likes: `arrived` settles once it is waited on. */
function held() {
  const arrived = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    arrived: arrived.promise,
    release: released.resolve,
    wait: () => {
      arrived.resolve();
      return released.promise;
    },
  };
}

/** A search worker that takes searches and never answers. */
const silentSearchWorker = (options: WorkerOptions) =>
  new Worker(`setInterval(() => {}, 1000);`, { ...options, eval: true });

async function standalone({
  channels = 1,
  aliases = {},
  searchWorker = guideSearchWorker,
  searchTimeout,
}: {
  readonly channels?: number;
  /** Guide ids a channel names before its own, by channel id. */
  readonly aliases?: Readonly<Record<string, readonly string[]>>;
  /** Starts the search worker, as the app does unless a test says otherwise. */
  readonly searchWorker?: (options: WorkerOptions) => Worker;
  readonly searchTimeout?: number;
} = {}) {
  const dir = await tempDir();
  /** What the own guide answers next: a document's bytes as the test sends them, or a failure. */
  let answer: () => Promise<{ body: ReadableStream<Uint8Array>; size: number | null }>;
  /** What the address answers. */
  let elsewhere = "";
  let indexing: ReturnType<typeof held> | null = null;
  let carrying: ReturnType<typeof held> | null = null;
  let listing: ReturnType<typeof held> | null = null;
  let writesFail = false;
  let ownWriting: ReturnType<typeof held> | null = null;
  let sealing: ReturnType<typeof held> | null = null;
  let sweeping: ReturnType<typeof held> | null = null;
  let stubborn: { hold: ReturnType<typeof held>; any: boolean } | null = null;
  let discarding: ReturnType<typeof held> | null = null;
  const indexer = Layer.effect(
    GuideIndexer,
    Effect.map(GuideIndexer, (worker) => ({
      build: async (...args: Parameters<typeof worker.build>) => {
        // The next build that reads the past from an index waits before it begins.
        const waiting = args[0].previous === null ? null : carrying;
        if (waiting) {
          carrying = null;
          await waiting.wait();
        }
        const built = await worker.build(...args);
        await indexing?.wait();
        return built;
      },
    })),
  ).pipe(
    Layer.provide(
      guideIndexerLayer((options) => {
        // The next build, or the next that reads the past from an index, runs in a worker that
        // won't end.
        const waiting = stubborn?.any || options.workerData.previous !== null ? stubborn : null;
        if (!waiting) return guideIndexWorker(options);
        stubborn = null;
        return stubbornWorker(options, waiting.hold.wait(), () => {});
      }),
    ),
  );
  /** Each of the store's writes and sweeps the test holds, once, until it lets it go. */
  const once = (hold: ReturnType<typeof held> | null, take: () => void) =>
    Effect.promise(async () => {
      if (!hold) return;
      take();
      await hold.wait();
    });
  const store = Layer.effect(
    GuideStore,
    Effect.map(GuideStore, (kept) => ({
      ...kept,
      setConfig: (...write: Parameters<typeof kept.setConfig>) =>
        writesFail
          ? Effect.fail(new Failed({ error: { kind: "unexpected", detail: "ENOSPC" } }))
          : kept.setConfig(...write),
      setOwn: (...write: Parameters<typeof kept.setOwn>) =>
        Effect.andThen(
          Effect.suspend(() => once(ownWriting, () => (ownWriting = null))),
          kept.setOwn(...write),
        ),
      download: (...made: Parameters<typeof kept.download>) =>
        Effect.map(kept.download(...made), (download) => ({
          ...download,
          discard: async () => {
            const waiting = discarding;
            discarding = null;
            await waiting?.wait();
            await download.discard();
          },
        })),
      sweep: (...sweep: Parameters<typeof kept.sweep>) =>
        Effect.andThen(
          Effect.suspend(() => once(sweeping, () => (sweeping = null))),
          kept.sweep(...sweep),
        ),
    })),
  ).pipe(Layer.provide(guideStoreLayer));
  const listed = catalogue(channels, aliases);
  const ports = Layer.mergeAll(
    store,
    indexer,
    guideSearcherLayer(searchWorker, searchTimeout),
    Layer.succeed(GuideSource, {
      saved: Effect.succeed([
        {
          id: ID,
          revision: 1,
          key: "account",
          store: dir,
          archive: GUIDE_ARCHIVE_MS,
          download: async () => ({ kind: "document" as const, ...(await answer()) }),
        },
      ]),
    }),
    // Every read of the channels waits while the test holds them.
    Layer.succeed(GuideCatalogue, {
      channels: () =>
        Effect.andThen(
          Effect.promise(async () => {
            if (listing) await listing.wait();
          }),
          Effect.succeed(listed),
        ),
    }),
    Layer.succeed(GuideAddresses, {
      seal: (address) =>
        Effect.andThen(
          Effect.suspend(() => once(sealing, () => (sealing = null))),
          Effect.succeed(address),
        ),
      open: (sealed) => Effect.succeed(sealed),
      fetch: async () => ({ body: new Blob([elsewhere]).stream(), size: elsewhere.length }),
    }),
  );
  const clock = Layer.effectDiscard(TestClock.setTime(NOW)).pipe(
    Layer.provideMerge(TestClock.layer({ warningDelay: "1 day" })),
  );
  const runtime = runtimeFor(Guide.layer.pipe(Layer.provide(ports), Layer.provideMerge(clock)));
  const guide = await runtime.runPromise(Guide);
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
  /** Each step the status was at when a change was told, a step once however often it was told. */
  const told: string[] = [];
  runtime.runFork(
    Stream.runForEach(guide.changes, () =>
      Effect.map(guide.status, ([status]) => {
        const step = status?.processing.state ?? "none";
        if (told.at(-1) !== step) told.push(step);
      }),
    ),
  );
  const one: OwnedId = { subscriptionId: ID, id: "1" };
  return {
    dir,
    runtime,
    run,
    guide,
    one,
    told,
    /** Holds the next write of the own guide kept, until `release`. */
    holdOwnWrite() {
      ownWriting = held();
      return ownWriting;
    },
    /** Holds the next sealing of an address, until `release`. */
    holdSeal() {
      sealing = held();
      return sealing;
    },
    /** Holds the next sweep of the guide's folder, before it begins, until `release`. */
    holdSweep() {
      sweeping = held();
      return sweeping;
    },
    /**
     * Makes the next build that reads the past from an index, or with `any` the next build, run
     * in a worker that won't end: `arrived` once the build begins, and stopping it waits for
     * `release`.
     */
    holdStubborn(any = false) {
      const hold = held();
      stubborn = { hold, any };
      return hold;
    },
    /** Holds the next removal of a download, once it is read, until `release`. */
    holdDiscard() {
      discarding = held();
      return discarding;
    },
    /** What the address answers from now on. */
    serveElsewhere(document: string) {
      elsewhere = document;
    },
    /** Holds every read of the channels until `release`. */
    holdChannels() {
      const hold = held();
      listing = hold;
      return {
        ...hold,
        release: () => {
          listing = null;
          hold.release();
        },
      };
    },
    /** Holds the next build that reads the past from an index, before it begins. */
    holdCarrying() {
      carrying = held();
      return carrying;
    },
    /** Makes writes of what is set fail, as a full disk does, or work again. */
    failWrites(fail: boolean) {
      writesFail = fail;
    },
    /** The programmes of channel 1 from 17:00 to 22:00, by title. */
    titles: async () =>
      (await run(guide.range([one], at("17:00"), at("22:00"))))[ownedKey(one)]?.map(
        (each) => each.title,
      ),
    /** The own guide's next answer: `document` whole, at once. */
    serve(document: string) {
      answer = async () => ({ body: new Blob([document]).stream(), size: document.length });
    },
    /** The own guide's next answer: `document`, its first half now, the rest on `release`. */
    serveHalf(document: string) {
      const bytes = new TextEncoder().encode(document);
      const half = Math.floor(bytes.length / 2);
      const rest = held();
      answer = async () => ({
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.subarray(0, half));
            void rest.wait().then(() => {
              controller.enqueue(bytes.subarray(half));
              controller.close();
            });
          },
        }),
        size: bytes.length,
      });
      return { half, total: bytes.length, ...rest };
    },
    /** The own guide's next answer: an HTTP failure. */
    fail(status: number) {
      answer = () => Promise.reject(new AppFailure({ kind: "provider-error", status }));
    },
    /** Holds the next document once it is indexed, before it becomes the guide. */
    holdIndexing() {
      indexing = held();
      return indexing;
    },
    status: async () => (await run(guide.status))[0],
    nowOn: async () => (await run(guide.listings([one])))[ownedKey(one)]?.now?.title,
  };
}

describe("a guide as it downloads and is indexed", () => {
  it("says what it is doing at each step, while the guide before answers until the new one is whole", async () => {
    const { run, guide, serve, serveHalf, holdIndexing, status, nowOn, told } = await standalone();
    serve(tv(programme("one.test", "2000", "2100", "Before")));
    await run(guide.refresh(ID));
    expect(await status()).toMatchObject({ processing: { state: "ready" }, fetchedAt: NOW });

    const next = tv(
      programme("one.test", "2000", "2100", "After"),
      programme("one.test", "2100", "2200", "Later"),
    );
    const download = serveHalf(next);
    const indexing = holdIndexing();
    told.length = 0;
    const refreshed = run(guide.refresh(ID));

    await download.arrived;
    await vi.waitFor(async () =>
      expect((await status())?.processing).toEqual({
        state: "downloading",
        bytes: download.half,
        total: download.total,
      }),
    );
    expect(await nowOn()).toBe("Before");

    download.release();
    await indexing.arrived;
    expect((await status())?.processing).toEqual({ state: "reading", programmes: 2, since: NOW });
    expect(await nowOn()).toBe("Before");

    indexing.release();
    await refreshed;
    // Everything Settings shows of it comes with the status.
    expect(await status()).toMatchObject({
      processing: {
        state: "ready",
        channels: 1,
        programmes: 2,
        until: NOW - 10 * 60 * 1000 + 2 * HOUR,
        fetchedAt: NOW,
      },
      availability: "available",
      failure: null,
    });
    expect(await nowOn()).toBe("After");
    // Each step was told as it came, for Settings to show it live.
    await vi.waitFor(() => expect(told).toEqual(["downloading", "reading", "ready"]));
  });

  it("says since when downloads fail and why, and keeps the guide it has", async () => {
    const { run, guide, serve, fail, status, nowOn } = await standalone();
    serve(tv(programme("one.test", "2000", "2100", "Kept")));
    await run(guide.refresh(ID));

    fail(503);
    await expect(run(guide.refresh(ID))).rejects.toBeTruthy();

    const failure = { kind: "provider-error", status: 503 };
    expect(await status()).toMatchObject({
      // The guide downloaded before stays in use, and says since when.
      processing: { state: "failed", reason: failure, since: NOW, kept: NOW },
      failure,
      failedAt: NOW,
      fetchedAt: NOW,
    });
    expect(await nowOn()).toBe("Kept");

    serve(tv(programme("one.test", "2000", "2100", "Back")));
    await run(guide.refresh(ID));
    expect(await status()).toMatchObject({ processing: { state: "ready" }, failure: null });
    expect(await nowOn()).toBe("Back");
  });

  it("reads a stretch of time for a grid, the past it keeps from downloads that no longer list it among it", async () => {
    const { run, guide, one, serve } = await standalone();
    serve(
      tv(
        programme("one.test", "1800", "1900", "Six"),
        programme("one.test", "1900", "2000", "Seven"),
        programme("one.test", "2000", "2100", "Eight"),
      ),
    );
    await run(guide.refresh(ID));
    // The next download lists from eight on only.
    serve(
      tv(
        programme("one.test", "2000", "2100", "Eight"),
        programme("one.test", "2100", "2200", "Nine"),
      ),
    );
    await run(guide.refresh(ID));
    const titles = async (from: number, to: number) =>
      (await run(guide.range([one, { subscriptionId: ID, id: "2" }], from, to)))[
        ownedKey(one)
      ]?.map((each) => each.title);

    expect(await titles(NOW - 2.5 * HOUR, NOW + 2 * HOUR)).toEqual([
      "Six",
      "Seven",
      "Eight",
      "Nine",
    ]);
    // A channel without guide data is left out.
    expect(
      Object.keys(await run(guide.range([{ subscriptionId: ID, id: "2" }], NOW, NOW + HOUR))),
    ).toEqual([]);
  });

  it("leaves descriptions out of a grid's stretch, and reads a slot's from the guide channel it came from", async () => {
    // The channel names a spelling of its guide id whose programme has ended, then one whose
    // programme, begun at the same time, is still on: the slot is the second's.
    const { run, guide, one, serve } = await standalone({
      channels: 2,
      aliases: { "1": ["expired.test"] },
    });
    const described = (id: string, from: string, to: string, title: string, about: string) =>
      `<programme start="20261002${from}00 +0200" stop="20261002${to}00 +0200" channel="${id}"><title>${title}</title><desc>${about}</desc></programme>`;
    serve(
      tv(
        described("expired.test", "1900", "1945", "Expired first spelling", "About expired"),
        described("one.test", "1900", "2100", "Current second spelling", "About current"),
        described("c2.test", "1900", "2100", "Elsewhere", "About elsewhere"),
      ),
    );
    await run(guide.refresh(ID));

    const [slot] = (await run(guide.range([one], NOW, NOW + HOUR)))[ownedKey(one)] ?? [];
    expect(slot).toMatchObject({
      start: at("19:00"),
      stop: at("21:00"),
      title: "Current second spelling",
    });
    expect(slot && "description" in slot).toBe(false);
    if (!slot) throw new Error("No slot.");
    expect(await run(guide.programme(one, slot.guide, slot.start))).toEqual({
      start: at("19:00"),
      stop: at("21:00"),
      title: "Current second spelling",
      description: "About current",
    });
    // Nothing starts then, and another channel's guide channel isn't this one's.
    expect(await run(guide.programme(one, slot.guide, at("19:30")))).toBeNull();
    const [elsewhere] =
      (await run(guide.range([{ subscriptionId: ID, id: "2" }], NOW, NOW + HOUR)))[
        ownedKey({ subscriptionId: ID, id: "2" })
      ] ?? [];
    expect(elsewhere?.title).toBe("Elsewhere");
    expect(await run(guide.programme(one, elsewhere?.guide ?? "", at("19:00")))).toBeNull();
  });
});

describe("the files of a guide while it is read", () => {
  it("answers a read begun before the guide was replaced from the guide it began with, and drops that file only after", async () => {
    const { dir, run, guide, one, serve, holdChannels, nowOn } = await standalone();
    serve(tv(programme("one.test", "2000", "2100", "Before news")));
    await run(guide.refresh(ID));

    // Reads that have the guide and wait for the channels, as the guide is replaced.
    const channels = holdChannels();
    const listed = run(guide.listings([one]));
    const searched = run(guide.search("news"));
    await channels.arrived;
    serve(tv(programme("one.test", "2000", "2100", "After news")));
    await run(guide.refresh(ID));
    expect(await indexesIn(dir)).toHaveLength(2);
    channels.release();

    expect((await listed)[ownedKey(one)]?.now?.title).toBe("Before news");
    // A search reads the programmes it found whole at its end, from the same guide.
    expect((await searched).map((match) => match.programme.title)).toEqual(["Before news"]);
    expect(await nowOn()).toBe("After news");
    await vi.waitFor(async () => expect(await indexesIn(dir)).toHaveLength(1));
  });

  it("keeps the past a check of the address in use reads from, while a refresh replaces it", async () => {
    const { run, guide, serveElsewhere, holdCarrying, titles } = await standalone();
    serveElsewhere(
      tv(
        programme("one.test", "1800", "1900", "Past"),
        programme("one.test", "1900", "2100", "Current"),
      ),
    );
    await run(guide.use(ID, (await run(guide.check(ID, ADDRESS))).id));
    expect(await titles()).toEqual(["Past", "Current"]);

    // The address no longer lists the past. A check of it waits to read it from the guide in
    // use while a refresh replaces that guide.
    serveElsewhere(tv(programme("one.test", "1900", "2100", "Current")));
    const carrying = holdCarrying();
    const checked = run(guide.check(ID, ""));
    await carrying.arrived;
    await run(guide.refresh(ID));
    expect(await titles()).toEqual(["Past", "Current"]);
    carrying.release();
    await run(guide.use(ID, (await checked).id));

    expect(await titles()).toEqual(["Past", "Current"]);
  });

  it("closes a checked guide that what is set can't name, and takes it once it can", async () => {
    const { dir, run, guide, nowOn, serveElsewhere, failWrites, status } = await standalone();
    serveElsewhere(tv(programme("one.test", "2000", "2100", "Elsewhere")));
    const { id } = await run(guide.check(ID, ADDRESS));

    failWrites(true);
    await expect(run(guide.use(ID, id))).rejects.toMatchObject({
      error: { kind: "unexpected", detail: "ENOSPC" },
    });

    expect(await status()).toMatchObject({ source: { kind: "own" } });
    expect(await openIn(dir)).toEqual([]);
    failWrites(false);
    expect(await run(guide.use(ID, id))).toMatchObject({ source: { kind: "external" } });
    expect(await nowOn()).toBe("Elsewhere");
  });

  it("reads a guide of large descriptions within a small heap, keeping a few thousand characters of each", async () => {
    const documents = await mkdtemp(join(tmpdir(), "mr-streamer-guide-document-"));
    const output = await tempDir();
    // Sixty programmes of half a mebibyte each: what one batch held before it was written.
    const description = "d".repeat(512 * 1024);
    const minute = 60_000;
    const stampOf = (time: number) =>
      `${new Date(time).toISOString().slice(0, 19).replace(/[-T:]/g, "")} +0000`;
    await writeFile(
      join(documents, "guide.xml"),
      tv(
        ...Array.from(
          { length: 60 },
          (_, n) =>
            `<programme start="${stampOf(NOW + n * minute)}" stop="${stampOf(NOW + (n + 1) * minute)}" channel="one.test"><title>Item ${n}</title><desc>${description}</desc></programme>`,
        ),
      ),
    );
    const indexer = await runtimeFor(
      guideIndexerLayer((options) =>
        guideIndexWorker({
          ...options,
          resourceLimits: { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 4 },
        }),
      ),
    ).runPromise(GuideIndexer);
    const target = join(output, "guide-index.sqlite");
    try {
      const summary = await indexer.build(
        {
          document: join(documents, "guide.xml"),
          target,
          previous: null,
          since: NOW,
          archive: GUIDE_ARCHIVE_MS,
          strict: false,
        },
        () => {},
        new AbortController().signal,
      );
      expect(summary.programmes).toBe(60);
      const index = await openGuideIndex(target);
      const channel = index?.channels.get("one.test");
      if (!index || !channel) throw new Error("No guide.");
      const schedule = index.schedule(channel, NOW, NOW, NOW + HOUR);
      index.close();
      expect(schedule).toHaveLength(60);
      expect(
        schedule.every((each) => each.description?.length === GUIDE_KEPT.descriptionChars),
      ).toBe(true);
    } finally {
      await rm(documents, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "settles a stopped build once, and leaves what it can't remove for the next sweep",
    async () => {
      const documents = await mkdtemp(join(tmpdir(), "mr-streamer-guide-document-"));
      const output = await tempDir();
      const many = Array.from({ length: 60_000 }, (_, index) => {
        const start = NOW + index * 60_000;
        const stamp = new Date(start).toISOString().slice(0, 19).replace(/[-T:]/g, "");
        const end = new Date(start + 60_000).toISOString().slice(0, 19).replace(/[-T:]/g, "");
        return `<programme start="${stamp} +0000" stop="${end} +0000" channel="one.test"><title>Item ${index}</title></programme>`;
      });
      await writeFile(join(documents, "guide.xml"), tv(...many));
      const indexer = await runtimeFor(guideIndexerLayer(guideIndexWorker)).runPromise(
        GuideIndexer,
      );
      const stopping = new AbortController();
      const reading = held();
      const target = join(output, "guide-index.sqlite");
      const built = indexer.build(
        {
          document: join(documents, "guide.xml"),
          target,
          previous: null,
          since: NOW,
          archive: GUIDE_ARCHIVE_MS,
          strict: false,
        },
        () => void reading.wait(),
        stopping.signal,
      );
      try {
        await reading.arrived;
        // What it wrote so far can't be removed: the folder is closed to changes.
        await chmod(output, 0o555);
        stopping.abort();
        await expect(built).rejects.toMatchObject({ name: "AbortError" });
        expect(await stat(`${target}.part`)).toBeTruthy();
      } finally {
        await chmod(output, 0o755);
        await rm(documents, { recursive: true, force: true });
      }
    },
  );
});

describe("which guide is current, as changes to it meet", () => {
  it("lets an own guide being kept finish before an address takes its place, and keeps what each names", async () => {
    const { dir, run, guide, serve, serveElsewhere, holdOwnWrite, nowOn, status } =
      await standalone();
    serve(tv(programme("one.test", "2000", "2100", "Before")));
    await run(guide.refresh(ID));
    serveElsewhere(tv(programme("one.test", "2000", "2100", "External")));
    const { id } = await run(guide.check(ID, ADDRESS));

    // A later download of the own guide is being kept as the address is used.
    serve(tv(programme("one.test", "2000", "2100", "Own late")));
    const keeping = holdOwnWrite();
    const refreshed = run(guide.refresh(ID));
    await keeping.arrived;
    const used = run(guide.use(ID, id));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await nowOn()).toBe("Before");
    keeping.release();
    await refreshed;
    await used;

    expect(await nowOn()).toBe("External");
    expect(await status()).toMatchObject({
      source: { kind: "external" },
      processing: { state: "ready" },
    });
    // What is kept names files that are there, the own guide's among them.
    const own: { index: string } = JSON.parse(await readFile(join(dir, "guide.json"), "utf8"));
    const set: { external: { document: { file: string } } } = JSON.parse(
      await readFile(join(dir, "guide-source.json"), "utf8"),
    );
    await vi.waitFor(async () =>
      expect((await indexesIn(dir)).sort()).toEqual([own.index, set.external.document.file].sort()),
    );
    await run(guide.restore(ID));
    expect(await nowOn()).toBe("Own late");
  });

  it("keeps a checked guide that a use has open, though the check is called off meanwhile", async () => {
    const { dir, run, guide, serve, serveElsewhere, holdSeal } = await standalone();
    serve(tv(programme("one.test", "2000", "2100", "Own")));
    await run(guide.refresh(ID));
    serveElsewhere(tv(programme("one.test", "2000", "2100", "External")));
    const { id } = await run(guide.check(ID, ADDRESS));

    const sealing = holdSeal();
    const used = failureOf(run(guide.use(ID, id)));
    await sealing.arrived;
    await run(guide.cancelCheck(ID));
    // The use has it open: it stays until the use lets go.
    expect(await indexesIn(dir)).toHaveLength(2);
    sealing.release();

    expect(await used).toEqual({ kind: "guide", failure: { kind: "changed" } });
    await vi.waitFor(async () => expect(await indexesIn(dir)).toHaveLength(1));
    expect(await openIn(dir)).toEqual(await indexesIn(dir));
  });

  it("keeps the index a stopped build reads the past from until its worker has ended", async () => {
    const { dir, run, guide, serveElsewhere, holdStubborn } = await standalone();
    serveElsewhere(tv(programme("one.test", "1900", "2100", "Current")));
    await run(guide.use(ID, (await run(guide.check(ID, ADDRESS))).id));
    const [inUse] = await indexesIn(dir);

    // A check of the same address reads the past from the guide in use, in a worker that is
    // slow to end once stopped. A check of another address stops it and is used at once.
    const ending = holdStubborn();
    const checking = failureOf(run(guide.check(ID, "")));
    await ending.arrived;
    const other = (async () =>
      run(guide.use(ID, (await run(guide.check(ID, "https://other.example.org/xmltv.xml"))).id)))();
    await Promise.race([other, new Promise((resolve) => setTimeout(resolve, 3000))]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Not before that worker has ended: the guide in use, which it reads, stays until then.
    expect(await indexesIn(dir)).toContain(inUse);
    ending.release();
    expect(await checking).toEqual({ kind: "guide", failure: { kind: "cancelled" } });
    await other;
    await vi.waitFor(async () => expect(await indexesIn(dir)).not.toContain(inUse));
  });

  it("finishes the first sweep of a guide's folder before anything uses its files, though what asked for it was stopped", async () => {
    const { runtime, run, guide, serve, holdSweep, nowOn, status } = await standalone();
    const sweeping = holdSweep();
    const asked = runtime.runFork(guide.status);
    await sweeping.arrived;
    const stopped = runtime.runFork(Fiber.interrupt(asked));
    serve(tv(programme("one.test", "2000", "2100", "Swept")));
    const refreshed = run(guide.refresh(ID));
    await new Promise((resolve) => setTimeout(resolve, 50));
    sweeping.release();
    await runtime.runPromise(Fiber.join(stopped));
    await refreshed;

    expect(await nowOn()).toBe("Swept");
    expect(await status()).toMatchObject({ availability: "available", failure: null });
  });
});

/**
 * What `work` answers, and the most main-thread CPU, in milliseconds, it ran between two of the
 * yields it makes with `setImmediate`: a stall, whatever else the machine is doing. What runs
 * outside those yields, such as taking in a worker's answer, counts toward the slice it ends.
 */
async function sliced<A>(work: () => Promise<A>): Promise<{ value: A; longest: number }> {
  const native = globalThis.setImmediate;
  let began = process.threadCpuUsage();
  let longest = 0;
  const cut = () => {
    const used = process.threadCpuUsage(began);
    longest = Math.max(longest, (used.user + used.system) / 1000);
  };
  globalThis.setImmediate = Object.assign(
    (callback: (...args: unknown[]) => void, ...args: unknown[]) => {
      cut();
      return native(() => {
        began = process.threadCpuUsage();
        callback(...args);
      });
    },
    { __promisify__: native.__promisify__ },
  ) as typeof setImmediate;
  try {
    const value = await work();
    cut();
    return { value, longest };
  } finally {
    globalThis.setImmediate = native;
  }
}

describe("a search of a large guide", () => {
  it("reads its programmes away from the main thread", async () => {
    // Two thousand channels of week-long news a week ahead, every one of them shown: a search
    // reads them all.
    const channels = 2_000;
    const { run, guide, serve } = await standalone({ channels });
    const week = 7 * 24 * HOUR;
    const stamp = (time: number) =>
      `${new Date(time).toISOString().slice(0, 19).replace(/[-T:]/g, "")} +0000`;
    const programmes = Array.from({ length: channels }, (_, at) => {
      const id = at === 0 ? "one.test" : `c${at + 1}.test`;
      return Array.from({ length: 20 }, (_, slot) => {
        const start = NOW + week + slot * 7 * HOUR;
        return `<programme start="${stamp(start)}" stop="${stamp(start + 7 * HOUR)}" channel="${id}"><title>News long event</title></programme>`;
      }).join("");
    });
    serve(tv(...programmes));
    await run(guide.refresh(ID));

    const { value: found, longest } = await sliced(() => run(guide.search("news")));

    expect(found).toHaveLength(50);
    // What the main thread did was ask, and read the answer, a few milliseconds at a time.
    expect(longest).toBeLessThan(50);
  });
});

describe("work stopped on its way to becoming the guide", () => {
  it.each(["indexing", "own write", "download removal"] as const)(
    "lets go of what it holds when stopped at its %s, so forgetting the subscription finishes",
    async (point) => {
      const { dir, run, guide, serve, holdIndexing, holdOwnWrite, holdDiscard } =
        await standalone();
      serve(tv(programme("one.test", "2000", "2100", "Stopped")));
      const holding =
        point === "indexing"
          ? holdIndexing()
          : point === "own write"
            ? holdOwnWrite()
            : holdDiscard();
      const refreshed = failureOf(run(guide.refresh(ID)));
      await holding.arrived;
      const forgotten = run(guide.forget({ id: ID, store: dir }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      holding.release();

      await forgotten;
      await refreshed;
      expect(await guideFilesIn(dir)).toEqual([]);
    },
  );

  it("hands an address its turn while a download kept before it is still being cleaned up, and forgets both", async () => {
    const { dir, run, guide, serve, serveElsewhere, holdDiscard, nowOn } = await standalone();
    serveElsewhere(tv(programme("one.test", "2000", "2100", "External")));
    const { id } = await run(guide.check(ID, ADDRESS));
    serve(tv(programme("one.test", "2000", "2100", "Own")));
    const removing = holdDiscard();
    const refreshed = failureOf(run(guide.refresh(ID)));
    await removing.arrived;
    const used = run(guide.use(ID, id));
    await new Promise((resolve) => setTimeout(resolve, 20));
    removing.release();
    await used;
    await refreshed;

    expect(await nowOn()).toBe("External");
    await run(guide.forget({ id: ID, store: dir }));
    expect(await guideFilesIn(dir)).toEqual([]);
  });

  it("keeps the document an older release left while the build reading it is stopped, until its worker has ended", async () => {
    const { dir, run, guide, holdStubborn } = await standalone();
    // What 0.0.12 kept: the document itself.
    await writeFile(join(dir, "guide.xml"), tv(programme("one.test", "2000", "2100", "Kept")));
    await writeFile(join(dir, "guide.json"), JSON.stringify({ key: "account", fetchedAt: NOW }));
    const ending = holdStubborn(true);
    await run(guide.status);
    await ending.arrived;

    const forgotten = run(guide.forget({ id: ID, store: dir }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readdir(dir)).toContain("guide.xml");
    ending.release();
    await forgotten;
    expect(await guideFilesIn(dir)).toEqual([]);
  });
});

describe("a search that doesn't answer", () => {
  it.each(["its time running out", "the app quitting"] as const)(
    "settles once its worker has ended, when it is stopped and %s come together",
    async (also) => {
      const ending = held();
      let terminated = 0;
      const runtime = runtimeFor(
        guideSearcherLayer((options) => {
          const worker = silentSearchWorker(options);
          const terminate = worker.terminate.bind(worker);
          worker.terminate = async () => {
            terminated++;
            await ending.wait();
            return terminate();
          };
          return worker;
        }, 100),
      );
      const searcher = await runtime.runPromise(GuideSearcher);
      const stopping = new AbortController();
      let settled = false;
      const searched = searcher
        .first(
          { path: "none", words: ["news"], at: NOW, channels: [1], limit: 50 },
          stopping.signal,
        )
        .finally(() => (settled = true));
      void searched.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      stopping.abort();
      await ending.arrived;
      const quitting = also === "the app quitting" ? runtime.dispose() : null;
      // Past the search's time, too.
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(settled).toBe(false);
      ending.release();
      await expect(searched).rejects.toThrow();
      await quitting;
      expect(terminated).toBe(1);
      if (!quitting) await runtime.dispose();
    },
  );

  it("is given up after its time, its worker ended, and the next search starts another", async () => {
    let started = 0;
    const { run, guide, serve } = await standalone({
      searchWorker: (options) => {
        started++;
        return silentSearchWorker(options);
      },
      searchTimeout: 200,
    });
    serve(tv(programme("one.test", "2000", "2100", "News")));
    await run(guide.refresh(ID));

    expect(await run(guide.search("news"))).toEqual([]);
    expect(await run(guide.search("news"))).toEqual([]);
    expect(started).toBe(2);
  });

  it("is stopped with its worker when its subscription is forgotten, or the app quits", async () => {
    const { dir, runtime, run, guide, serve } = await standalone({
      searchWorker: silentSearchWorker,
    });
    serve(tv(programme("one.test", "2000", "2100", "News")));
    await run(guide.refresh(ID));

    const searched = run(guide.search("news"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await run(guide.forget({ id: ID, store: dir }));
    expect(await searched).toEqual([]);
    expect(await guideFilesIn(dir)).toEqual([]);

    // Searching again, as the app quits.
    serve(tv(programme("one.test", "2000", "2100", "News")));
    await run(guide.refresh(ID));
    void run(guide.search("news")).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runtime.dispose();
    expect(await openIn(dir)).toEqual([]);
  });
});

describe("a search of many matching titles", () => {
  it("finds the first fifty, reading a page of them at a time within a small heap", async () => {
    // Every programme its own title, every title found.
    const minute = 60_000;
    const stamp = (time: number) =>
      `${new Date(time).toISOString().slice(0, 19).replace(/[-T:]/g, "")} +0000`;
    const { run, guide, serve } = await standalone({
      searchWorker: (options) =>
        guideSearchWorker({
          ...options,
          resourceLimits: { maxOldGenerationSizeMb: 12, maxYoungGenerationSizeMb: 4 },
        }),
    });
    serve(
      tv(
        Array.from(
          { length: 150_000 },
          (_, at) =>
            `<programme start="${stamp(NOW + at * minute)}" stop="${stamp(NOW + (at + 1) * minute)}" channel="one.test"><title>Ordinary show ${at}</title></programme>`,
        ).join(""),
      ),
    );
    await run(guide.refresh(ID));

    const found = await run(guide.search("ordinary"));
    expect(found).toHaveLength(50);
    expect(found[0]?.programme.title).toBe("Ordinary show 0");
    expect(found[49]?.programme.title).toBe("Ordinary show 49");
  });
});
