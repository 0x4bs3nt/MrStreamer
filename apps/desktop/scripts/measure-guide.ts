// Measures the programme guide against its budgets: download and index under 3 s, no
// main-process stall over 50 ms, now and next for a screen of channels under 5 ms, and under 80 MB
// of memory. Uses a generated guide the size of a large subscription, or a real XMLTV file. It
// also times what Settings asks to map channels by hand: a page of the 13,000 channels, a search
// of the guide's channels, and now and next with a few hundred of them mapped.
//
//   node --expose-gc scripts/measure-guide.ts [--file guide.xml]
//       [--guide-channels 1300] [--programmes 70] [--subscriptions 1] [--json results.json]
//
// The last two size the generated guide, as for one near the limits a guide is read under
// (`GUIDE_LIMITS`). The file stays local: provider guides are not committed.
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Readable } from "node:stream";
import { parseArgs } from "node:util";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { CatalogueChannels } from "@mrstreamer/core/guide/programmes";
import { Guide, GuideAddresses, GuideCatalogue, GuideSource } from "@mrstreamer/core/guide/service";
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
import { guideStoreLayer } from "../src/main/platform/guide-store.ts";

const CHANNELS = 13_000;
const CHUNK_BYTES = 64 * 1024;
/** How many channels the measurement maps by hand. */
const MAPPED = 300;

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
const PROGRAMMES_PER_CHANNEL = positiveCount(values.programmes, "programmes", 500000);
const SUBSCRIPTIONS = positiveCount(values.subscriptions, "subscriptions", 4);
if (!values.file && GUIDE_CHANNELS * PROGRAMMES_PER_CHANNEL > 500000)
  throw new Error("Generated guide exceeds 500000 total programmes per subscription");
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
  if (!values.file) await writeFile(documentPath, generated());
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
                  download: async () => ({
                    kind: "document" as const,
                    body: Readable.toWeb(
                      createReadStream(documentPath, { highWaterMark: CHUNK_BYTES }),
                    ) as ReadableStream<Uint8Array>,
                  }),
                })),
              ),
            }),
            Layer.succeed(GuideCatalogue, {
              channels: (subscriptionId) => Effect.succeed(catalogues.get(subscriptionId)!),
            }),
            guideStoreLayer,
            // The measured guide is the subscription's own: no address is sealed or requested.
            Layer.succeed(GuideAddresses, {
              seal: (address) => Effect.succeed(address),
              open: (sealed) => Effect.succeed(sealed),
              fetch: async () => createReadStream(documentPath, { highWaterMark: CHUNK_BYTES }),
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

  gc();
  const heapBefore = process.memoryUsage().heapUsed;

  stalls.enable();
  await new Promise((resolve) => setTimeout(resolve, 10));
  stalls.reset();
  let started = performance.now();
  let guide: Awaited<ReturnType<typeof create>> | undefined = await create();
  const subscriptionDownloadSamples = await guide.refresh();
  const downloadMs = performance.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 10));
  stalls.disable();
  const downloadStall = stalls.max / 1e6;

  gc();
  const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1e6;
  if (heapMb < 0) throw new Error("Negative retained guide heap delta");

  // Close and release the old service before opening a fresh service on its persisted stores.
  // This is the same process with warm OS caches, not a fresh-process restart.
  const retiredGuide = new WeakRef(guide);
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  guide = undefined;
  await new Promise<void>((resolve) => setImmediate(resolve));
  gc();
  const retiredGuideCollected = retiredGuide.deref() === undefined;
  if (!retiredGuideCollected)
    throw new Error("Old guide wrapper is still retained before cached reads");

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

  const screen = Array.from(
    { length: 60 },
    (_, index) => channels[(index % SUBSCRIPTIONS) * CHANNELS + Math.floor(index / SUBSCRIPTIONS)]!,
  );
  started = performance.now();
  const listingsSamples: number[] = [];
  for (let round = 0; round < 100; round++) {
    const began = performance.now();
    await restarted.listings(screen);
    listingsSamples.push(performance.now() - began);
  }

  started = performance.now();
  const matches = await restarted.search("news");
  const searchMs = performance.now() - started;

  // Live TV's search of the list it shows: every channel, until the end of the day.
  const endOfDay = new Date(now).setHours(24, 0, 0, 0);
  started = performance.now();
  const listSearchSamples: number[] = [];
  for (let round = 0; round < 20; round++) {
    const began = performance.now();
    await restarted.searchChannels("news", channels, endOfDay);
    listSearchSamples.push(performance.now() - began);
  }
  const found = Object.keys(await restarted.searchChannels("news", channels, endOfDay)).length;

  // What Settings asks to map channels by hand: a page of the channels without programmes, and
  // the guide's channels a search finds, as the viewer types.
  started = performance.now();
  const mapPageSamples: number[] = [];
  for (let round = 0; round < 20; round++) {
    const began = performance.now();
    await restarted.mapChannels("");
    mapPageSamples.push(performance.now() - began);
  }
  started = performance.now();
  const mapSearchSamples: number[] = [];
  for (let round = 0; round < 20; round++) {
    const began = performance.now();
    await restarted.mapChannels("channel 12");
    mapSearchSamples.push(performance.now() - began);
  }
  await restarted.mapOptions("");
  started = performance.now();
  const optionsSamples: number[] = [];
  for (let round = 0; round < 20; round++) {
    const began = performance.now();
    await restarted.mapOptions("c1");
    optionsSamples.push(performance.now() - began);
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
  }
  started = performance.now();
  const mappedListingsSamples: number[] = [];
  for (let round = 0; round < 100; round++) {
    const began = performance.now();
    await restarted.listings(screen);
    mappedListingsSamples.push(performance.now() - began);
  }

  const metrics: Measurement["metrics"] = {
    "download and index": metric("ms", [downloadMs]),
    "download and index per subscription": metric("ms", subscriptionDownloadSamples, 3000),
    "longest stall while downloading": metric("ms", [downloadStall], 50),
    "read from disk after a restart": metric("ms", [diskMs]),
    "longest stall while reading": metric("ms", [diskStall], 50),
    "now and next for 60 channels": metric("ms", listingsSamples, 5),
    "search news": metric("ms", [searchMs]),
    "list search news": metric("ms", listSearchSamples),
    "mapping list": metric("ms", mapPageSamples),
    "mapping list searched": metric("ms", mapSearchSamples),
    "guide channels searched": metric("ms", optionsSamples),
    "now and next channels mapped": metric("ms", mappedListingsSamples, 5),
    "memory held by guide": metric("MB", [heapMb], 80),
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
      downloadBudgetScope: "one refresh per subscription; aggregate unbudgeted",
      heapBudgetScope: "all subscriptions loaded in first service, aggregate retained heap delta",
      cachedReadScope: "fresh service in same process; OS cache warm; GC before phase",
      cache: "fresh temporary stores then disk reads",
      garbageCollection: true,
      eventLoopResolutionMs: 5,
    },
    observations: [{ name: "cached-read preparation", retiredGuideCollected }],
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

  /** The guide channels a document lists programmes for. */
  async function guideChannelIds(path: string): Promise<string[]> {
    const ids = new Set<string>();
    let tail = "";
    for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
      const text = tail + String(chunk);
      for (const match of text.matchAll(/<programme[^>]*channel="([^"]+)"/g))
        ids.add(match[1] ?? "");
      tail = text.slice(-200);
    }
    return [...ids];
  }

  /** A guide shaped like a large panel's: two days of programmes for each guide channel. */
  function generated(): string {
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
    const parts = ['<?xml version="1.0" encoding="utf-8"?><tv>'];
    for (let channel = 0; channel < GUIDE_CHANNELS; channel++) {
      for (let index = 0; index < PROGRAMMES_PER_CHANNEL; index++) {
        const start = first + index * slot;
        const title = `${words[(channel + index) % words.length]} ${channel % 97} ${index}`;
        const description = `Episode ${index}. ${"A description of a length panels often send. ".repeat(5)}`;
        parts.push(
          `<programme start="${time(start)}" stop="${time(start + slot)}" channel="c${channel}.test">` +
            `<title lang="en">${title}</title><desc lang="en">${description}</desc></programme>`,
        );
      }
    }
    parts.push("</tv>");
    return parts.join("\n");
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
