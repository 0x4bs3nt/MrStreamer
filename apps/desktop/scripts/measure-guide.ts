// Measures the programme guide against its budgets: no main-process stall over 50 ms while it
// downloads, indexes, opens or answers, now and next for a screen of channels under 5 ms, under
// 80 MB of heap and 150 MB of resident memory added once loaded. How long a guide takes to be
// ready in the background, downloaded and indexed, is reported without a budget. Indexing runs in a worker thread, as in the app, so its own memory shows in the peak
// resident memory added while indexing, not in what stays. Uses a generated guide the size of a
// large subscription, or a real XMLTV file, packed with gzip or not. It also times what Settings
// asks to map channels by hand: a page of the 13,000 channels, a search of the guide's channels,
// and now and next with a few hundred of them mapped; and a page of a grid, 30 channels by 6
// hours.
//
//   node --expose-gc scripts/measure-guide.ts [--file guide.xml[.gz]]
//       [--guide-channels 1300] [--programmes 70] [--subscriptions 1] [--json results.json]
//
// The last two size the generated guide, which is written to a temporary file as it is made, so
// one as large as a real 512 MiB guide fits. The file stays local: provider guides are not
// committed.
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { xmltvDocument } from "@mrstreamer/core/guide/document";
import { GUIDE_LIMITS } from "@mrstreamer/core/guide/limits";
import type { CatalogueChannels } from "@mrstreamer/core/guide/programmes";
import {
  Guide,
  GuideAddresses,
  GuideCatalogue,
  GuideSource,
  GUIDE_ARCHIVE_MS,
} from "@mrstreamer/core/guide/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import {
  environment,
  metric,
  positiveCount,
  prepareMeasurementOutput,
  saveMeasurement,
  type Measurement,
} from "./measurement.ts";
import { guideIndexerLayer } from "../src/main/platform/guide-indexer.ts";
import { guideSearcherLayer } from "../src/main/platform/guide-searcher.ts";
import { guideStoreLayer } from "../src/main/platform/guide-store.ts";

const CHANNELS = 13_000;
const CHUNK_BYTES = 64 * 1024;
/** How many channels the measurement maps by hand. */
const MAPPED = 300;
/** A generated guide stays within what a guide may unpack to, at about 450 bytes a programme. */
const GENERATED_PROGRAMMES = 4_000_000;
/** Two days of one-minute programmes, the shortest a guide keeps: what a generated channel holds. */
const GENERATED_PER_CHANNEL = 2 * 24 * 60;
const HOUR = 60 * 60 * 1000;
/** How long the event loop is watched with nothing to do, before anything is measured. */
const IDLE_MS = 3000;

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    json: { type: "string" },
    subscriptions: { type: "string", default: "1" },
    "guide-channels": { type: "string", default: "1300" },
    programmes: { type: "string", default: "70" },
  },
});
const GUIDE_CHANNELS = positiveCount(values["guide-channels"], "guide-channels", 50000);
const PROGRAMMES_PER_CHANNEL = positiveCount(
  values.programmes,
  "programmes",
  GENERATED_PER_CHANNEL,
);
const SUBSCRIPTIONS = positiveCount(values.subscriptions, "subscriptions", 4);
if (!values.file && GUIDE_CHANNELS * PROGRAMMES_PER_CHANNEL > GENERATED_PROGRAMMES)
  throw new Error(`Generated guide exceeds ${GENERATED_PROGRAMMES} total programmes`);
const output =
  values.json ?? join(process.cwd(), ".local/measurements", `guide-${Date.now()}.json`);
prepareMeasurementOutput(output);
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("Guide memory instrumentation requires --expose-gc");
const now = Date.now();
const dataDir = await mkdtemp(join(tmpdir(), "mr-streamer-guide-"));
const runtimes: { dispose(): Promise<void> }[] = [];
const stalls = monitorEventLoopDelay({ resolution: 5 });
try {
  // The document streams from a file, as it would from the network, so it never sits in the heap.
  const documentPath = values.file ?? join(dataDir, "generated.xml");
  if (!values.file) await generate(documentPath);
  const guideIds = await guideChannelIds(documentPath);
  if (!guideIds.length) throw new Error("Guide instrumentation requires programme channels");

  /** Synthetic subscription ids remain separate even when local channel ids collide. */
  const SUBSCRIPTION = "measure";

  // Catalogue channels: some share a guide channel, most have none, as on real subscriptions.
  const subscriptions = Array.from(
    { length: SUBSCRIPTIONS },
    (_, index) => `${SUBSCRIPTION}-${index}`,
  );
  const channels: LiveChannel[] = subscriptions.flatMap((subscriptionId) =>
    Array.from({ length: CHANNELS }, (_, index) => ({
      subscriptionId,
      id: String(index),
      name: `Channel ${index}`,
      title: `Channel ${index}`,
      tags: [],
      number: index + 1,
      logoUrl: null,
      categoryIds: [],
      variants: [{ id: String(index), name: `Channel ${index}`, tags: [], quality: null }],
      catchupDays: null,
    })),
  );
  const catalogues = new Map<string, CatalogueChannels>();
  for (const subscription of subscriptions) {
    const ownChannels = channels.filter((channel) => channel.subscriptionId === subscription);
    const guideIdsOf = new Map<string, readonly string[]>();
    const byGuideId = new Map<string, LiveChannel[]>();
    for (const [index, channel] of ownChannels.entries()) {
      const guideId = index % 6 === 0 ? guideIds[(index / 6) % guideIds.length] : undefined;
      if (!guideId) continue;
      guideIdsOf.set(channel.id, [guideId]);
      byGuideId.set(guideId, [...(byGuideId.get(guideId) ?? []), channel]);
    }
    const byId = new Map(ownChannels.map((channel) => [channel.id, channel]));
    const guideChannels: CatalogueChannels = {
      all: ownChannels,
      searchNames: ownChannels.map((channel) => channel.name.toLowerCase()),
      channel: (id) => byId.get(id),
      listed: (id) => byId.has(id),
      guideIdsOf: (id) => guideIdsOf.get(id) ?? [],
      channelsOf: (id) => byGuideId.get(id) ?? [],
    };

    catalogues.set(subscription, guideChannels);
  }
  // Each subscription's folder, as the app makes it when the subscription is added.
  for (const subscription of subscriptions) await mkdir(join(dataDir, subscription));

  /** The guide service as the app runs it, with one document/store per subscription. */
  async function create() {
    const runtime = ManagedRuntime.make(
      Guide.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(GuideSource, {
              saved: Effect.succeed(
                subscriptions.map((subscription) => ({
                  id: subscription,
                  revision: 1,
                  key: subscription,
                  store: join(dataDir, subscription),
                  archive: GUIDE_ARCHIVE_MS,
                  download: async () => ({
                    kind: "document" as const,
                    body: Readable.toWeb(
                      createReadStream(documentPath, { highWaterMark: CHUNK_BYTES }),
                    ) as ReadableStream<Uint8Array>,
                    size: (await stat(documentPath)).size,
                  }),
                })),
              ),
            }),
            Layer.succeed(GuideCatalogue, {
              channels: (subscriptionId) => Effect.succeed(catalogues.get(subscriptionId)!),
            }),
            guideStoreLayer,
            // The app's own indexing worker, from source as Node runs TypeScript.
            // And its search worker.
            guideSearcherLayer(
              (options) =>
                new Worker(new URL("../src/main/guide/search-worker.ts", import.meta.url), options),
            ),
            guideIndexerLayer(
              (options) =>
                new Worker(new URL("../src/main/guide/index-worker.ts", import.meta.url), options),
            ),
            // The measured guide is the subscription's own: no address is sealed or requested.
            Layer.succeed(GuideAddresses, {
              seal: (address) => Effect.succeed(address),
              open: (sealed) => Effect.succeed(sealed),
              fetch: async () => ({
                body: createReadStream(documentPath, { highWaterMark: CHUNK_BYTES }),
                size: null,
              }),
            }),
          ),
        ),
      ),
    );
    runtimes.push(runtime);
    const guide = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* Guide;
      }),
    );
    return {
      refresh: async () => {
        const samples: number[] = [];
        for (const subscription of subscriptions) {
          const started = performance.now();
          await runtime.runPromise(guide.refresh(subscription));
          samples.push(performance.now() - started);
        }
        return samples;
      },
      listings: (asked: readonly LiveChannel[]) => runtime.runPromise(guide.listings(asked)),
      range: (asked: readonly LiveChannel[], from: number, to: number) =>
        runtime.runPromise(guide.range(asked, from, to)),
      search: (query: string) => runtime.runPromise(guide.search(query)),
      searchChannels: (query: string, asked: readonly LiveChannel[], until: number) =>
        runtime.runPromise(guide.searchChannels(query, asked, until)),
      mapChannels: (query: string) =>
        runtime.runPromise(
          guide.mapChannels({
            subscriptionId: subscriptions[0]!,
            filter: "without",
            query,
            offset: 0,
            limit: 120,
          }),
        ),
      mapOptions: (query: string) =>
        runtime.runPromise(
          guide.mapOptions({ subscriptionId: subscriptions[0]!, query, offset: 0, limit: 120 }),
        ),
      map: (channelId: string, guideId: string, revision: string) =>
        runtime.runPromise(guide.map(subscriptions[0]!, channelId, guideId, revision)),
    };
  }

  /** Runs `work` noting the largest resident memory the process reaches meanwhile, in bytes. */
  async function peakOf<A>(work: () => Promise<A>): Promise<[A, number]> {
    let peak = process.memoryUsage.rss();
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage.rss());
    }, 50);
    try {
      const result = await work();
      return [result, Math.max(peak, process.memoryUsage.rss())];
    } finally {
      clearInterval(sampler);
    }
  }

  /**
   * Ends a turn of the event loop, as each request from the window does: the stalls measured
   * while answering are those of one answer, not of a hundred run back to back.
   */
  const turn = () => new Promise((resolve) => setImmediate(resolve));

  /** Collects garbage until the heap settles, as before and after loading alike. */
  async function settled() {
    gc!();
    await new Promise((resolve) => setTimeout(resolve, 100));
    gc!();
  }

  await settled();
  const rssBefore = process.memoryUsage.rss();

  // What the machine itself costs the event loop with nothing to do: the floor under every
  // stall measured after it.
  stalls.reset();
  stalls.enable();
  await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
  stalls.disable();
  const idleStall = stalls.max / 1e6;

  stalls.enable();
  await new Promise((resolve) => setTimeout(resolve, 10));
  stalls.reset();
  let started = performance.now();
  let guide: Awaited<ReturnType<typeof create>> | undefined = await create();
  const [subscriptionDownloadSamples, peak] = await peakOf(() => guide!.refresh());
  const peakMb = (peak - rssBefore) / 1e6;
  const downloadMs = performance.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 10));
  stalls.disable();
  const downloadStall = stalls.max / 1e6;

  // What stays once the guide is loaded and its first answers read, with the workers gone.
  await guide.listings(channels.slice(0, 60));
  await settled();
  const heapLoaded = process.memoryUsage().heapUsed;
  const rssMb = (process.memoryUsage.rss() - rssBefore) / 1e6;

  // Close and release the old service before opening a fresh service on its persisted stores.
  // This is the same process with warm OS caches, not a fresh-process restart. What releasing it
  // frees of the heap is what the loaded guides held.
  const retiredGuide = new WeakRef(guide);
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  guide = undefined;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await settled();
  const retiredGuideCollected = retiredGuide.deref() === undefined;
  if (!retiredGuideCollected)
    throw new Error("Old guide wrapper is still retained before cached reads");
  const heapMb = (heapLoaded - process.memoryUsage().heapUsed) / 1e6;
  if (heapMb < 0) throw new Error("Negative retained guide heap delta");

  stalls.reset();
  stalls.enable();
  await new Promise((resolve) => setTimeout(resolve, 10));
  stalls.reset();
  started = performance.now();
  const restarted = await create();
  await restarted.listings(
    subscriptions.map((subscriptionId) =>
      channels.find((channel) => channel.subscriptionId === subscriptionId)!,
    ),
  );
  const diskMs = performance.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 10));
  stalls.disable();
  const diskStall = stalls.max / 1e6;

  // Everything after this answers questions of the loaded guides.
  stalls.reset();
  stalls.enable();
  const screen = Array.from(
    { length: 60 },
    (_, index) => channels[(index % SUBSCRIPTIONS) * CHANNELS + Math.floor(index / SUBSCRIPTIONS)]!,
  );
  const listingsSamples: number[] = [];
  for (let round = 0; round < 100; round++) {
    const began = performance.now();
    await restarted.listings(screen);
    listingsSamples.push(performance.now() - began);
    await turn();
  }
  // A screen of channels that all have a guide id: every one of them is read.
  const guided = channels.filter((_, index) => index % 6 === 0);
  const guidedScreen = guided.slice(0, 60);
  const guidedSamples: number[] = [];
  for (let round = 0; round < 100; round++) {
    const began = performance.now();
    await restarted.listings(guidedScreen);
    guidedSamples.push(performance.now() - began);
    await turn();
  }
  const guidedShown = Object.keys(await restarted.listings(guidedScreen)).length;

  // A page of a grid: 30 channels by 6 hours, from an hour ago.
  const page = guided.slice(0, 30);
  const rangeSamples: number[] = [];
  for (let round = 0; round < 20; round++) {
    const began = performance.now();
    await restarted.range(page, now - HOUR, now + 5 * HOUR);
    rangeSamples.push(performance.now() - began);
    await turn();
  }
  const rangeChannels = Object.values(
    await restarted.range(page, now - HOUR, now + 5 * HOUR),
  ).length;

  const searchSamples: number[] = [];
  let matches: Awaited<ReturnType<typeof restarted.search>> = [];
  for (let round = 0; round < 5; round++) {
    const began = performance.now();
    matches = await restarted.search("news");
    searchSamples.push(performance.now() - began);
    await turn();
  }

  // Live TV's search of the list it shows: every channel, until the end of the day.
  const endOfDay = new Date(now).setHours(24, 0, 0, 0);
  const listSearchSamples: number[] = [];
  for (let round = 0; round < 20; round++) {
    const began = performance.now();
    await restarted.searchChannels("news", channels, endOfDay);
    listSearchSamples.push(performance.now() - began);
    await turn();
  }
  const found = Object.keys(await restarted.searchChannels("news", channels, endOfDay)).length;

  // What Settings asks to map channels by hand: a page of the channels without programmes, and
  // the guide's channels a search finds, as the viewer types.
  const mapPageSamples: number[] = [];
  for (let round = 0; round < 20; round++) {
    const began = performance.now();
    await restarted.mapChannels("");
    mapPageSamples.push(performance.now() - began);
    await turn();
  }
  const mapSearchSamples: number[] = [];
  for (let round = 0; round < 20; round++) {
    const began = performance.now();
    await restarted.mapChannels("channel 12");
    mapSearchSamples.push(performance.now() - began);
    await turn();
  }
  await restarted.mapOptions("");
  const optionsSamples: number[] = [];
  for (let round = 0; round < 20; round++) {
    const began = performance.now();
    await restarted.mapOptions("c1");
    optionsSamples.push(performance.now() - began);
    await turn();
  }
  const unmatched = await restarted.mapChannels("");
  // Channels without a guide id of their own, each mapped to one of the guide's channels.
  const byHand = channels
    .filter((channel) => channel.subscriptionId === subscriptions[0])
    .filter((_, index) => index % 6 === 1)
    .slice(0, MAPPED);
  for (const [at, channel] of byHand.entries()) {
    const guideId = guideIds[at % guideIds.length];
    if (guideId) await restarted.map(channel.id, guideId, unmatched.revision);
    await turn();
  }
  const mappedListingsSamples: number[] = [];
  for (let round = 0; round < 100; round++) {
    const began = performance.now();
    await restarted.listings(screen);
    mappedListingsSamples.push(performance.now() - began);
    await turn();
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  stalls.disable();
  const answerStall = stalls.max / 1e6;

  const metrics: Measurement["metrics"] = {
    "longest stall while idle": metric("ms", [idleStall]),
    "download and index": metric("ms", [downloadMs]),
    "time to ready per subscription": metric("ms", subscriptionDownloadSamples),
    "longest stall while downloading": metric("ms", [downloadStall], 50),
    "read from disk after a restart": metric("ms", [diskMs]),
    "longest stall while reading": metric("ms", [diskStall], 50),
    "longest stall while answering": metric("ms", [answerStall], 50),
    "now and next for 60 channels": metric("ms", listingsSamples, 5),
    "now and next for 60 guided channels": metric("ms", guidedSamples, 5),
    "range 30 channels by 6 hours": metric("ms", rangeSamples),
    "search news": metric("ms", searchSamples),
    "list search news": metric("ms", listSearchSamples),
    "mapping list": metric("ms", mapPageSamples),
    "mapping list searched": metric("ms", mapSearchSamples),
    "guide channels searched": metric("ms", optionsSamples),
    "now and next channels mapped": metric("ms", mappedListingsSamples, 5),
    "memory held by guide": metric("MB", [heapMb], 80),
    "resident memory added": metric("MB", [rssMb], 150),
    "peak resident memory added while indexing": metric("MB", [peakMb]),
  };
  saveMeasurement(output, {
    schemaVersion: 1,
    tool: "guide",
    environment: environment(),
    workload: {
      subscriptions: SUBSCRIPTIONS,
      channelsPerSubscription: CHANNELS,
      guideChannels: guideIds.length,
      programmesPerChannel: PROGRAMMES_PER_CHANNEL,
      documentBytes: (await stat(documentPath)).size,
      source: values.file ? "local-file" : "synthetic",
      screenChannels: 60,
      mappedChannels: byHand.length,
    },
    conditions: {
      warmup:
        "fresh guide disposed and collected before fresh service in same process; mapping options warmed once",
      readyScope: "one refresh per subscription, in the background; unbudgeted",
      heapBudgetScope:
        "all subscriptions loaded in first service, heap its disposal and collection frees",
      residentBudgetScope:
        "all subscriptions loaded in first service, resident memory delta once indexing workers ended",
      indexing: "worker thread per document, started from source",
      cachedReadScope: "fresh service in same process; OS cache warm; GC before phase",
      cache: "fresh temporary stores then disk reads",
      garbageCollection: true,
      eventLoopResolutionMs: 5,
      answerScope: "each measured answer in a turn of its own, as requests from the window are",
    },
    observations: [
      { name: "cached-read preparation", retiredGuideCollected },
      { name: "resident memory before loading", megabytes: rssBefore / 1e6 },
      { name: "answers", guidedScreenShown: guidedShown, rangeChannels },
    ],
    metrics,
    checks: values.file
      ? { localDocumentLoaded: guideIds.length > 0 }
      : {
          searchReturnsProgrammes: matches.length > 0,
          listSearchReturnsChannels: found > 0,
          mappingsAvailable: unmatched.total > 0,
        },
  });
  for (const [name, value] of Object.entries(metrics)) {
    console.log(
      `${name}: ${Math.max(...value.samples).toFixed(2)} ${value.unit} max; budget ${value.budget?.outcome ?? "not-configured"}${value.budget ? ` (< ${value.budget.limit} ${value.unit})` : ""}`,
    );
  }
  console.log(`Raw measurement: ${output}`);

  /** The guide channels a document lists programmes for, packed with gzip or not. */
  async function guideChannelIds(path: string): Promise<string[]> {
    const ids = new Set<string>();
    const decoder = new TextDecoder();
    let tail = "";
    for await (const chunk of xmltvDocument(createReadStream(path), GUIDE_LIMITS.bytes)) {
      const text = tail + decoder.decode(chunk, { stream: true });
      for (const match of text.matchAll(/<programme[^>]*channel="([^"]+)"/g))
        ids.add(match[1] ?? "");
      tail = text.slice(-200);
    }
    return [...ids];
  }

  /** Writes a guide shaped like a large panel's: two days of programmes for each guide channel. */
  async function generate(path: string): Promise<void> {
    const words = [
      "News",
      "Match",
      "Journal",
      "Kitchen",
      "Crime",
      "Nature",
      "Quiz",
      "Talk",
      "Film",
    ];
    const first = now - 24 * 60 * 60 * 1000;
    const slot = (48 * 60 * 60 * 1000) / PROGRAMMES_PER_CHANNEL;
    const file = createWriteStream(path);
    // Written a mebibyte or so at a time, whatever a channel holds, as the file takes it.
    let parts: string[] = [];
    let pending = 0;
    const write = async (text: string) => {
      parts.push(text);
      pending += text.length;
      if (pending >= 1024 * 1024) await flush();
    };
    const flush = async () => {
      const text = parts.join("");
      parts = [];
      pending = 0;
      if (!file.write(text))
        await new Promise<void>((resolve) => file.once("drain", () => resolve()));
    };
    await write('<?xml version="1.0" encoding="utf-8"?><tv>\n');
    for (let channel = 0; channel < GUIDE_CHANNELS; channel++) {
      for (let index = 0; index < PROGRAMMES_PER_CHANNEL; index++) {
        const start = first + index * slot;
        const title = `${words[(channel + index) % words.length]} ${channel % 97} ${index}`;
        const description = `Episode ${index}. ${"A description of a length panels often send. ".repeat(5)}`;
        await write(
          `<programme start="${time(start)}" stop="${time(start + slot)}" channel="c${channel}.test">` +
            `<title lang="en">${title}</title><desc lang="en">${description}</desc></programme>\n`,
        );
      }
    }
    await flush();
    file.end("</tv>");
    await finished(file);
  }

  function time(at: number): string {
    return `${new Date(at).toISOString().slice(0, 19).replace(/[-T:]/g, "")} +0000`;
  }
} finally {
  stalls.disable();
  let runtimesDisposed = false;
  try {
    await Promise.all(runtimes.map((runtime) => runtime.dispose()));
    runtimesDisposed = true;
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await writeFile(
      `${output}.cleanup.json`,
      JSON.stringify(
        { dataDir, runtimesDisposed, dataDirRemoved: !(await stat(dataDir).catch(() => null)) },
        null,
        2,
      ),
    );
  }
}
