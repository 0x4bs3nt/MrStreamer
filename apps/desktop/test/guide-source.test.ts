// The global XMLTV sources of Settings > Guides, read by every subscription after its own guide,
// and channels mapped to a guide's by hand: through the guide service as the window calls it, on
// the app's runtime, against the fake provider, the fake playlist and a host for guides. And the
// addresses releases before gave one subscription each, which come over as sources.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { gzipSync } from "node:zlib";
import { AppFailure } from "@mrstreamer/contracts/errors";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import { guideAddress } from "@mrstreamer/core/guide/address";
import { buildGuideIndex } from "@mrstreamer/core/guide/index-file";
import { GUIDE_LIMITS } from "@mrstreamer/core/guide/limits";
import { guideRef, OWN_GUIDE, type CatalogueChannels } from "@mrstreamer/core/guide/programmes";
import {
  Guide,
  GuideAddresses,
  GuideCatalogue,
  GuideSource,
  GuideStore,
  GUIDE_ARCHIVE_MS,
} from "@mrstreamer/core/guide/service";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guideIndexerLayer } from "../src/main/platform/guide-indexer.ts";
import { guideSearcherLayer } from "../src/main/platform/guide-searcher.ts";
import { guideStoreLayer } from "../src/main/platform/guide-store.ts";
import type { Secrets } from "../src/main/platform/secrets.ts";
import { xmltvFetch } from "../src/main/providers/xmltv.ts";
import { mainLayer, type MainConfig } from "../src/main/runtime.ts";
import { Library } from "../src/main/services/library.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { GUIDE_KEY, startGuideHost, type GuideHost } from "./fake-guide-host.ts";
import { PLAYLIST_CHANNELS, startFakePlaylist } from "./fake-playlist.ts";
import type { FakeProvider } from "./fake-provider.ts";
import {
  fakeProvider,
  guideIndexWorker,
  guideSearchWorker,
  runtimeFor,
  tempDir,
  testConfig,
  testSecrets,
  userAgent,
} from "./support.ts";

// Each guide download is indexed in a worker thread started from source, which strips the types
// of what it imports anew: a few hundred milliseconds each on a busy machine.
vi.setConfig({ testTimeout: 20_000 });

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
/** 20:10 at +02:00, where every guide here writes its times. */
const NOW = Date.parse("2026-10-02T20:10:00+02:00");
const at = (time: string) => Date.parse(`2026-10-02T${time}:00+02:00`);
/** The guide id the fake provider gives its quality channel, which its own guide here lacks. */
const QUALITY = "kwaliteit1.be";

const closing: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const each of closing.splice(0)) await each.close();
});

async function guideHost(): Promise<GuideHost> {
  const host = await startGuideHost();
  closing.push(host);
  return host;
}

/** A programme on a guide channel that day, from "2000" to "2100". */
const programme = (id: string, from: string, to: string, title: string) =>
  `<programme start="20261002${from}00 +0200" stop="20261002${to}00 +0200" channel="${id}"><title>${title}</title></programme>`;
/** An hour's programme on a guide channel, on at NOW. */
const slot = (id: string, title: string) => programme(id, "2000", "2100", title);
const named = (id: string, name: string) =>
  `<channel id="${id}"><display-name>${name}</display-name></channel>`;
const tv = (...elements: string[]) =>
  `<?xml version="1.0" encoding="utf-8"?><tv>${elements.join("")}</tv>`;

const login = (provider: { readonly url: string }) => ({
  server: provider.url,
  username: "demo",
  password: "demo",
});

/** Why `promise` failed, as the window is told. */
const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (cause: unknown) => (cause instanceof Failed ? cause.error : cause),
  );

const changed = { kind: "guide", failure: { kind: "changed" } };

/** An indexer whose worker never finishes, however long it is given. */
const stuck: MainConfig["guideIndexWorker"] = (options) =>
  new Worker("setInterval(() => {}, 1000);", { ...options, eval: true });

/** A clock that stands at NOW until a test moves it. */
const clock = () =>
  Layer.effectDiscard(TestClock.setTime(NOW)).pipe(
    Layer.provideMerge(TestClock.layer({ warningDelay: "1 day" })),
  );

/**
 * The app's services on `dataDir`, with the clock at NOW, and what `changes` gives it in place of
 * the test's own; another call is the app started again.
 */
async function app(dataDir: string, changes: Partial<MainConfig> = {}) {
  const runtime = runtimeFor(
    mainLayer({ ...testConfig(dataDir), ...changes }).pipe(Layer.provideMerge(clock())),
  );
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
  const guide = await runtime.runPromise(Guide);
  return {
    run,
    guide,
    /** Quits the app: what it had open closes. */
    close: () => runtime.dispose(),
    library: await runtime.runPromise(Library),
    roster: await runtime.runPromise(Roster),
    subscriptions: await runtime.runPromise(Subscriptions),
    /** The title a channel shows as on now. */
    nowOn: async (channel: OwnedId) =>
      (await run(guide.listings([channel])))[ownedKey(channel)]?.now?.title,
    /** A subscription's guide as Settings shows it. */
    status: async (subscriptionId: string) => {
      const status = (await run(guide.status)).find(
        (each) => each.subscriptionId === subscriptionId,
      );
      if (!status) throw new Error("No such subscription");
      return status;
    },
    /** The sources, in their order. */
    sources: () => run(guide.sources),
    /** Adds a source, and waits for its download to be done. */
    add: async (address: string) => {
      const added = await run(guide.addSource(address));
      return run(guide.refreshSource(added.id));
    },
    /** Moves the clock on, short of the service's own quarter-hourly look at the guides. */
    advance: (ms: number) => run(TestClock.adjust(ms)),
  };
}

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

/**
 * What is kept of guides in a folder, by name, each index's id as "*". A file replaced goes once
 * nothing reads it, so what a test expects of these it waits for.
 */
async function guideFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => []);
  return names
    .filter((name) => /^guide[-.]/.test(name) || name === "sources.json")
    .map((name) => name.replace(/\.[0-9a-f-]{36}\./, ".*."))
    .sort();
}

/** An own guide alone, as it is kept: its index, named by guide.json. */
const OWN_ONLY = ["guide-index.*.sqlite", "guide.json"];
/** One source, as the sources' folder keeps it: its index, named by sources.json. */
const ONE_SOURCE = ["guide-index.*.sqlite", "sources.json"];

/** The folder the app keeps the sources in. */
const sourcesIn = (dataDir: string) => join(dataDir, "guides");

/** Every file under `dir` as text, to look for what must not be written anywhere. */
async function written(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) parts.push(await readFile(join(entry.parentPath, entry.name), "latin1"));
  }
  return parts.join("\n");
}

/**
 * One Xtream subscription on the fake provider, whose own guide says "Provider" on its first
 * channel and knows nothing of its quality channel, and a host with a guide of another origin
 * that says "External" on the first and "Elsewhere" on the quality channel.
 */
async function connected() {
  const provider = await fakeProvider();
  provider.serveGuide(tv(named("aac.test", "AAC"), slot("aac.test", "Provider")));
  const host = await guideHost();
  host.serve(
    "/guide.xml",
    tv(
      named("aac.test", "AAC One"),
      named(QUALITY, "Kwaliteit"),
      slot("aac.test", "External"),
      programme(QUALITY, "2000", "2300", "Elsewhere"),
    ),
  );
  const dataDir = await tempDir();
  const services = await app(dataDir);
  const { id } = await services.run(services.subscriptions.add(login(provider)));
  const channel = (channelId: string): OwnedId => ({ subscriptionId: id, id: channelId });
  await services.run(services.guide.refresh(id));
  const catalogue = await services.run(services.library.guideChannels(id));
  return {
    ...services,
    provider,
    host,
    dataDir,
    id,
    channel,
    first: channel("1000"),
    quality: channel(namingChannel(catalogue, QUALITY)),
  };
}

/** The catalogue channel that names `guideId`, by its id. */
function namingChannel(catalogue: CatalogueChannels, guideId: string): string {
  const found = catalogue.all.find((each) => catalogue.guideIdsOf(each.id).includes(guideId));
  if (!found) throw new Error(`No channel names ${guideId}.`);
  return found.id;
}

/** A channel of the fake provider that sends no guide id, by its id. */
function unguided(provider: FakeProvider): string {
  const channel = provider.catalogue.channels.find(
    (each) => each.streamId >= 2000 && !each.offline && !each.guideId,
  );
  if (!channel) throw new Error("The fake catalogue has no channel without a guide id.");
  return String(channel.streamId);
}

describe("the sources of Settings > Guides", () => {
  it("adds a source at once, downloads it in the background, and gives it the channels the own guide lacks", async () => {
    const { run, guide, provider, host, dataDir, id, first, quality, nowOn, status, sources } =
      await connected();
    expect(await nowOn(quality)).toBeUndefined();

    const added = await run(guide.addSource(host.address()));

    // Saved at once, its download under way.
    expect(added).toEqual({
      id: expect.any(String),
      origin: host.origin,
      locked: false,
      processing: { state: "downloading", bytes: expect.any(Number), total: null },
    });
    expect((await sources()).map((each) => each.id)).toEqual([added.id]);
    const ready = await run(guide.refreshSource(added.id));
    expect(ready.processing).toEqual({
      state: "ready",
      channels: 1,
      programmes: 2,
      until: at("23:00"),
      fetchedAt: NOW,
    });
    // The own guide comes first: the source supplies only what it lacks.
    expect(await nowOn(first)).toBe("Provider");
    expect(await nowOn(quality)).toBe("Elsewhere");
    expect(await status(id)).toMatchObject({
      channels: 2,
      supplied: [
        { source: null, channels: 1 },
        { source: { id: added.id, origin: host.origin }, channels: 1 },
      ],
    });
    // The address went out as the app's own request, with nothing of the provider's login.
    expect(host.requests()).toEqual([
      {
        path: "/guide.xml",
        search: `?key=${GUIDE_KEY}`,
        headers: expect.objectContaining({ "user-agent": userAgent }),
      },
    ]);
    expect(host.requests()[0]?.headers).not.toHaveProperty("authorization");
    expect(JSON.stringify(host.requests())).not.toContain("demo");
    // Only its origin is ever told, and the address is nowhere on disk but sealed.
    expect(JSON.stringify([added, ready, await sources(), await run(guide.status)])).not.toContain(
      GUIDE_KEY,
    );
    const disk = await written(dataDir);
    expect(disk).not.toContain(GUIDE_KEY);
    expect(disk).not.toContain("/guide.xml?");
    await vi.waitFor(async () => expect(await guideFiles(sourcesIn(dataDir))).toEqual(ONE_SOURCE));
    await vi.waitFor(async () => expect(await guideFiles(dataDir)).toEqual(OWN_ONLY));

    // After a restart it shows from what was kept, with nothing asked of either server.
    const asked = [host.requests().length, provider.guideRequests()];
    const restarted = await app(dataDir);
    expect(await restarted.nowOn(quality)).toBe("Elsewhere");
    expect((await restarted.sources())[0]).toMatchObject({
      origin: host.origin,
      processing: { state: "ready", fetchedAt: NOW },
    });
    await restarted.run(restarted.guide.refreshIfStale(id));
    expect([host.requests().length, provider.guideRequests()]).toEqual(asked);
  });

  it("gives each channel whole to the first source in order with programmes for it, and follows the order the viewer gives", async () => {
    const { run, guide, host, dataDir, quality, nowOn, sources, add } = await connected();
    host.serve(
      "/early.xml",
      tv(slot(QUALITY, "Early"), programme(QUALITY, "2200", "2300", "Early late")),
    );
    // Where the early source has a gap, the late one has a programme: the gap stays.
    host.serve(
      "/late.xml",
      tv(slot(QUALITY, "Late"), programme(QUALITY, "2100", "2200", "Late gap")),
    );
    const early = await add(host.address("/early.xml"));
    const late = await add(host.address("/late.xml"));
    const day = async () =>
      (await run(guide.schedule(quality, NOW, NOW + 6 * HOUR))).map(({ title }) => title);

    expect(await nowOn(quality)).toBe("Early");
    expect(await day()).toEqual(["Early", "Early late"]);

    await run(guide.moveSource(late.id, -1));

    expect((await sources()).map((each) => each.id)).toEqual([late.id, early.id]);
    expect(await nowOn(quality)).toBe("Late");
    expect(await day()).toEqual(["Late", "Late gap"]);
    // At either end it stays where it is.
    await run(guide.moveSource(late.id, -1));
    await run(guide.moveSource(early.id, 1));
    expect((await sources()).map((each) => each.id)).toEqual([late.id, early.id]);
    expect((await sources()).map((each) => each.processing)).toMatchObject([
      { state: "ready", channels: 1 },
      { state: "ready", channels: 0 },
    ]);
    expect(await (await app(dataDir)).nowOn(quality)).toBe("Late");
  });

  it("keeps a failing source's last download and its place, says why and since when, also after a restart", async () => {
    const { run, guide, provider, host, dataDir, quality, nowOn, sources, add, advance } =
      await connected();
    host.serve("/other.xml", tv(slot("other.test", "Other")));
    const failing = await add(host.address());
    const other = await add(host.address("/other.xml"));
    const asked = provider.guideRequests();

    host.serve("/guide.xml", 503);
    expect((await run(guide.refreshSource(failing.id))).processing).toEqual({
      state: "failed",
      reason: { kind: "provider-error", status: 503 },
      since: NOW,
      kept: NOW,
    });
    await advance(10 * 60 * 1000);
    host.serve("/guide.xml", tv(slot(QUALITY, "Cut off")).slice(0, -20));
    const told = {
      id: failing.id,
      processing: {
        state: "failed",
        reason: { kind: "guide", failure: { kind: "incomplete" } },
        // Since the first download that failed.
        since: NOW,
        kept: NOW,
      },
    };
    expect(await run(guide.refreshSource(failing.id))).toMatchObject(told);
    expect(await nowOn(quality)).toBe("Elsewhere");
    // Its place in the order, and the other source, are as they were.
    expect((await sources()).map((each) => each.id)).toEqual([failing.id, other.id]);
    expect((await sources())[1]?.processing).toMatchObject({ state: "ready" });
    expect(provider.guideRequests()).toBe(asked);

    const restarted = await app(dataDir);
    expect((await restarted.sources())[0]).toMatchObject(told);
    expect(await restarted.nowOn(quality)).toBe("Elsewhere");

    // The next download that works replaces it, and the failure is gone.
    host.serve("/guide.xml", tv(slot(QUALITY, "Elsewhere again")));
    expect(
      (await restarted.run(restarted.guide.refreshSource(failing.id))).processing,
    ).toMatchObject({ state: "ready", channels: 1 });
    expect(await restarted.nowOn(quality)).toBe("Elsewhere again");
    await vi.waitFor(async () =>
      expect(await guideFiles(sourcesIn(dataDir))).toEqual([
        "guide-index.*.sqlite",
        "guide-index.*.sqlite",
        "sources.json",
      ]),
    );
  });

  it("reads a guide that is gzip by its content, split anywhere, or unpacked by the connection", async () => {
    const { host, quality, nowOn, add } = await connected();
    const document = (title: string) => tv(named(QUALITY, "Kwaliteit"), slot(QUALITY, title));

    host.serve("/packed.xml.gz", gzipSync(document("Packed")), { pieceBytes: 1 });
    expect((await add(host.address("/packed.xml.gz"))).processing).toMatchObject({ channels: 1 });
    // Named as plain XML, and gzip all the same.
    host.serve("/plain-named.xml", gzipSync(document("Plain named")));
    expect((await add(host.address("/plain-named.xml"))).processing).toMatchObject({
      state: "ready",
    });
    // Sent as gzip by the server, which the connection unpacks: the guide arrives as XML.
    host.serve("/sent-packed.xml.gz", gzipSync(document("Sent packed")), {
      headers: { "Content-Encoding": "gzip" },
    });
    expect((await add(host.address("/sent-packed.xml.gz"))).processing).toMatchObject({
      state: "ready",
    });
    expect(await nowOn(quality)).toBe("Packed");
  });

  it("refuses an address that isn't one, and keeps a source whose answer is no guide, saying why", async () => {
    const { run, guide, host, dataDir, first, quality, nowOn, sources, add } = await connected();
    expect(await failureOf(run(guide.addSource("ftp://guide.example.org/x")))).toEqual({
      kind: "guide",
      failure: { kind: "address" },
    });
    expect(await sources()).toEqual([]);
    const ended = programme(QUALITY, "1800", "1900", "Earlier");
    const refusals: [answer: Parameters<GuideHost["serve"]>[1], failure: object][] = [
      [404, { kind: "provider-error", status: 404 }],
      ["<!doctype html><title>Sign in</title>", { kind: "guide", failure: { kind: "not-xmltv" } }],
      [
        gzipSync(tv(slot(QUALITY, "Cut"))).subarray(0, 40),
        { kind: "guide", failure: { kind: "incomplete" } },
      ],
      // Programmes that read well, in a document that never opens or never closes as one.
      [`${slot(QUALITY, "No start")}</tv>`, { kind: "guide", failure: { kind: "not-xmltv" } }],
      [
        tv(slot(QUALITY, "No end")).replace(/<\/tv>$/, "<!-- </tv> -->"),
        { kind: "guide", failure: { kind: "incomplete" } },
      ],
      [tv(named(QUALITY, "Kwaliteit")), { kind: "guide", failure: { kind: "empty" } }],
      [tv(ended), { kind: "guide", failure: { kind: "ended" } }],
      [
        tv(slot(QUALITY, "t".repeat(GUIDE_LIMITS.elementBytes))),
        { kind: "guide", failure: { kind: "too-large", limit: "element" } },
      ],
    ];
    for (const [index, [answer, failure]] of refusals.entries()) {
      host.serve(`/bad-${index}.xml`, answer);
      const told = await add(host.address(`/bad-${index}.xml`));
      expect(told.processing).toEqual({ state: "failed", reason: failure, since: NOW, kept: null });
      expect(JSON.stringify(told)).not.toContain(GUIDE_KEY);
    }

    // Each stays in the order, with nothing of it in use.
    expect(await sources()).toHaveLength(refusals.length);
    expect(await nowOn(first)).toBe("Provider");
    expect(await nowOn(quality)).toBeUndefined();
    await vi.waitFor(async () =>
      expect(await guideFiles(sourcesIn(dataDir))).toEqual(["sources.json"]),
    );
    // A dozen downloads, each indexed in a worker of its own.
  }, 60_000);

  it("is the same source for the same address however it is typed, and goes with what it downloaded", async () => {
    const { run, guide, host, dataDir, quality, nowOn, sources, add } = await connected();
    const source = await add(host.address());

    const again = await run(
      guide.addSource(`${host.address().toUpperCase().slice(0, 4)}${host.address().slice(4)}#x`),
    );

    expect(again).toMatchObject({ id: source.id, processing: { state: "ready" } });
    expect(await sources()).toHaveLength(1);
    expect(host.requests()).toHaveLength(1);

    await run(guide.removeSource(source.id));

    expect(await sources()).toEqual([]);
    expect(await nowOn(quality)).toBeUndefined();
    expect(await failureOf(run(guide.removeSource(source.id)))).toEqual(changed);
    await vi.waitFor(async () =>
      expect(await guideFiles(sourcesIn(dataDir))).toEqual(["sources.json"]),
    );
    expect(await (await app(dataDir)).sources()).toEqual([]);
  });

  it("gives a playlist that names no guide programmes from a source, and says it has none of its own", async () => {
    const playlist = await startFakePlaylist();
    closing.push(playlist);
    const host = await guideHost();
    const { id: guideId } = PLAYLIST_CHANNELS.tracks;
    host.serve("/guide.xml", tv(named(guideId, "Tracks"), slot(guideId, "Test card")));
    const dataDir = await tempDir();
    const { run, guide, subscriptions, nowOn, status, add } = await app(dataDir);
    const { id } = await run(
      subscriptions.add({ server: playlist.link, username: "", password: "" }),
    );
    const channel = { subscriptionId: id, id: guideId };
    await run(guide.refresh(id));

    const source = await add(host.address());

    expect(await nowOn(channel)).toBe("Test card");
    expect(await status(id)).toMatchObject({
      availability: "none",
      channels: 1,
      supplied: [{ source: { id: source.id }, channels: 1 }],
      processing: { state: "empty" },
    });
    expect(await (await app(dataDir)).nowOn(channel)).toBe("Test card");
  });
});

describe("one source for every subscription", () => {
  it("downloads and indexes it once for all of them, and never shares an answer between them", async () => {
    const [first, second] = [await fakeProvider(), await fakeProvider({ channels: 200 })];
    // The first's own guide has the channel; the second's has no guide id the other knows.
    first.serveGuide(tv(slot("aac.test", "Journaal")));
    second.serveGuide(tv(slot("nothing.test", "Nothing")));
    const host = await guideHost();
    host.serve(
      "/guide.xml",
      tv(slot("aac.test", "Shared"), programme("aac.test", "2100", "2200", "Shared later")),
    );
    const dataDir = await tempDir();
    const { run, guide, roster, subscriptions, status, sources, add } = await app(dataDir);
    const a = (await run(subscriptions.add(login(first)))).id;
    const b = (await run(subscriptions.add(login(second)))).id;
    const channel = (subscriptionId: string) => ({ subscriptionId, id: "1000" });
    await run(guide.refresh(a));
    await run(guide.refresh(b));

    const source = await add(host.address());

    const shows = async () => {
      const listings = await run(guide.listings([channel(a), channel(b)]));
      return [channel(a), channel(b)].map((each) => listings[ownedKey(each)]?.now?.title);
    };
    expect(await shows()).toEqual(["Journaal", "Shared"]);
    expect(await run(guide.schedule(channel(b), NOW, NOW + 24 * HOUR))).toMatchObject([
      { title: "Shared" },
      { title: "Shared later" },
    ]);
    // Each subscription's channel is found apart, from the guide that supplies it.
    expect(await run(guide.search("shared"))).toMatchObject([
      { channel: channel(b), programme: { title: "Shared" } },
      { channel: channel(b), programme: { title: "Shared later" } },
    ]);
    expect(await run(guide.search("journaal"))).toMatchObject([{ channel: channel(a) }]);
    expect(await run(guide.searchChannels("a", [channel(a), channel(b)], at("23:00")))).toEqual({
      [ownedKey(channel(a))]: { now: true, later: null },
      [ownedKey(channel(b))]: { now: true, later: { start: at("21:00"), title: "Shared later" } },
    });
    expect(await status(a)).toMatchObject({ supplied: [{ source: null, channels: 1 }] });
    expect(await status(b)).toMatchObject({
      supplied: [{ source: { id: source.id }, channels: 1 }],
    });
    // Matched across subscriptions: the second's channel only, the first's being its own.
    expect((await sources())[0]?.processing).toMatchObject({ state: "ready", channels: 1 });
    // Asked for and indexed once.
    expect(host.requests()).toHaveLength(1);
    await vi.waitFor(async () => expect(await guideFiles(sourcesIn(dataDir))).toEqual(ONE_SOURCE));
    // Each keeps its own guide in its own folder, the first where a profile kept its one.
    for (const folder of [dataDir, join(dataDir, "subscriptions", b)]) {
      await vi.waitFor(async () => expect(await guideFiles(folder)).toEqual(OWN_ONLY));
    }

    // One that goes leaves the source to the other.
    await run(roster.remove(a, false));
    expect(await shows()).toEqual([undefined, "Shared"]);
    expect(await sources()).toHaveLength(1);
  });
});

describe("channels mapped to a guide's by hand", () => {
  /** A guide with a channel no catalogue channel names: "spare.test". */
  const guideWith = (title: string, ...more: string[]) =>
    tv(
      named("aac.test", "AAC One"),
      named("spare.test", "Spare Channel"),
      named("quiet.test", "Quiet"),
      slot("aac.test", title),
      slot("spare.test", `${title} spare`),
      ...more,
    );

  /** The subscription with its own guide, and the host's guide as a source: both list "spare.test". */
  async function mapping() {
    const base = await connected();
    const { run, guide, provider, host, id, channel, add } = base;
    provider.serveGuide(guideWith("Own"));
    await run(guide.refresh(id));
    host.serve("/guide.xml", guideWith("Source"));
    const source = await add(host.address());
    const loose = unguided(provider);
    /** The first page of the channels a filter and a search find. */
    const list = (filter: "without" | "mapped" | "all", query = "") =>
      run(guide.mapChannels({ subscriptionId: id, filter, query, offset: 0, limit: 200 }));
    const { revision } = await list("all");
    return {
      ...base,
      source,
      loose: channel(loose),
      list,
      revision,
      own: (guideId: string) => guideRef(OWN_GUIDE, guideId),
      sourced: (guideId: string) => guideRef(source.id, guideId),
    };
  }

  it("lists every guide's channels by name and id, its own first, and a subscription's channels by how they get programmes", async () => {
    const { run, guide, host, id, list, loose, first, own, sourced } = await mapping();
    const options = (query: string, offset = 0, limit = 200) =>
      run(guide.mapOptions({ subscriptionId: id, query, offset, limit }));
    const ofOwn = (guideId: string, name: string, programmes: boolean) => ({
      ref: own(guideId),
      id: guideId,
      origin: null,
      name,
      programmes,
    });
    const ofSource = (guideId: string, name: string, programmes: boolean) => ({
      ref: sourced(guideId),
      id: guideId,
      origin: host.origin,
      name,
      programmes,
    });

    // Names and ids, and whether there is anything on: no programme comes along.
    expect(await options("")).toEqual({
      total: 6,
      listed: 6,
      channels: [
        ofOwn("aac.test", "AAC One", true),
        ofOwn("quiet.test", "Quiet", false),
        ofOwn("spare.test", "Spare Channel", true),
        ofSource("aac.test", "AAC One", true),
        ofSource("quiet.test", "Quiet", false),
        ofSource("spare.test", "Spare Channel", true),
      ],
    });
    const spare = await options("spare");
    expect(spare.channels.map((each) => each.ref)).toEqual([
      own("spare.test"),
      sourced("spare.test"),
    ]);
    // What the guides list in all, whatever a search finds.
    expect(spare).toMatchObject({ total: 2, listed: 6 });
    // By its id too, and a page at a time.
    expect((await options("QUIET.test")).channels.map((each) => each.id)).toEqual([
      "quiet.test",
      "quiet.test",
    ]);
    expect(await options("", 1, 1)).toMatchObject({ total: 6, channels: [{ id: "quiet.test" }] });

    const all = await list("all");
    const without = await list("without");
    expect(all.total).toBe((await run(guide.status))[0]?.listed);
    expect(all.channels.find((each) => each.id === first.id)).toMatchObject({
      shown: { ref: own("aac.test"), id: "aac.test", origin: null },
      mapped: null,
      listed: true,
    });
    expect(without.channels.some((each) => each.id === first.id)).toBe(false);
    expect(without.channels.find((each) => each.id === loose.id)).toMatchObject({
      shown: null,
      mapped: null,
    });
    expect((await list("mapped")).total).toBe(0);
    const title = all.channels.find((each) => each.id === loose.id)?.title ?? "";
    expect((await list("without", title)).channels.some((each) => each.id === loose.id)).toBe(true);
    expect((await list("without", "no channel is called this")).total).toBe(0);
  });

  it("shows a mapped channel the guide channel of the guide it names everywhere at once, past the order, and its own again once automatic", async () => {
    const { run, guide, host, id, list, revision, loose, first, nowOn, status, own, sourced } =
      await mapping();
    const covered = (await status(id)).channels;

    const mapped = await run(guide.map(id, loose.id, sourced("spare.test"), revision));

    expect(mapped).toMatchObject({
      id: loose.id,
      shown: { ref: sourced("spare.test"), origin: host.origin },
      mapped: { ref: sourced("spare.test"), id: "spare.test", origin: host.origin },
    });
    expect(await nowOn(loose)).toBe("Source spare");
    expect(await run(guide.schedule(loose, NOW, NOW + 24 * HOUR))).toMatchObject([
      { title: "Source spare" },
    ]);
    expect(await run(guide.search("source spare"))).toMatchObject([{ channel: loose }]);
    expect(await run(guide.searchChannels("spare", [loose, first], at("23:00")))).toEqual({
      [ownedKey(loose)]: { now: true, later: null },
    });
    expect(await status(id)).toMatchObject({ channels: covered + 1, mapped: 1, unresolved: 0 });
    expect((await list("mapped")).channels).toMatchObject([{ id: loose.id }]);

    // A mapping counts alone: the channel leaves the guide channel its own id names, and the
    // guide that comes first.
    await run(guide.map(id, first.id, sourced("aac.test"), revision));
    expect(await nowOn(first)).toBe("Source");
    expect(await run(guide.search("own"))).toEqual([]);

    expect(await run(guide.map(id, first.id, null, revision))).toMatchObject({
      shown: { ref: own("aac.test") },
      mapped: null,
    });
    expect(await nowOn(first)).toBe("Own");
    expect(await run(guide.search("own"))).toMatchObject([{ channel: first }]);
    expect(await status(id)).toMatchObject({ channels: covered + 1, mapped: 1 });
  });

  it("maps only to a channel a guide of the subscription lists, by its exact id, for a channel the provider lists", async () => {
    const { run, guide, id, revision, loose, nowOn, status, own, sourced } = await mapping();
    const map = (channelId: string, ref: string, from = revision) =>
      failureOf(run(guide.map(id, channelId, ref, from)));

    // Never by a name, nor by an id that only looks alike, nor of a guide that isn't there.
    expect(await map(loose.id, own("Spare Channel"))).toEqual(changed);
    expect(await map(loose.id, sourced("SPARE.TEST"))).toEqual(changed);
    expect(await map(loose.id, guideRef("no-such-source", "spare.test"))).toEqual(changed);
    expect(await map(loose.id, "spare.test")).toEqual(changed);
    expect(await map("no-such-channel", own("spare.test"))).toMatchObject({
      kind: "channel-not-found",
    });
    expect(await map(loose.id, own("spare.test"), "another-guide")).toEqual(changed);
    expect(await failureOf(run(guide.map("gone", loose.id, own("spare.test"), revision)))).toEqual({
      kind: "no-subscription",
    });
    expect(await nowOn(loose)).toBeUndefined();
    expect(await status(id)).toMatchObject({ mapped: 0 });
  });

  it("keeps mappings through a restart and a new channel list, and leaves one unresolved rather than point it elsewhere", async () => {
    const { run, guide, library, provider, host, dataDir, id, list, revision, loose, source } =
      await mapping();
    const nowOn = async (channel: OwnedId) =>
      (await run(guide.listings([channel])))[ownedKey(channel)]?.now?.title;
    const sourced = (guideId: string) => guideRef(source.id, guideId);
    const status = async () => (await run(guide.status)).find((each) => each.subscriptionId === id);
    await run(guide.map(id, loose.id, sourced("spare.test"), revision));

    const restarted = await app(dataDir);
    expect(await restarted.nowOn(loose)).toBe("Source spare");
    provider.serveChannels((all) => all.toReversed());
    await restarted.run(restarted.library.refresh(id));
    expect(await restarted.nowOn(loose)).toBe("Source spare");
    expect(await restarted.status(id)).toMatchObject({ mapped: 1, unresolved: 0 });

    // The source stops listing the channel it was mapped to: no programmes, and none of another.
    host.serve("/guide.xml", tv(named("aac.test", "AAC One"), slot("aac.test", "Source")));
    await run(guide.refreshSource(source.id));
    expect(await nowOn(loose)).toBeUndefined();
    expect(await status()).toMatchObject({ mapped: 1, unresolved: 1 });
    expect((await list("without")).channels.find((each) => each.id === loose.id)).toMatchObject({
      shown: null,
      mapped: { ref: sourced("spare.test") },
    });
    // It shows again as soon as the source lists it again.
    host.serve("/guide.xml", guideWith("Source"));
    await run(guide.refreshSource(source.id));
    expect(await nowOn(loose)).toBe("Source spare");

    // The source goes: the mapping leads nowhere, and the channel is automatic again.
    await run(guide.removeSource(source.id));
    expect(await status()).toMatchObject({ mapped: 1, unresolved: 1 });
    expect(await nowOn(loose)).toBeUndefined();
    expect((await list("mapped")).channels).toMatchObject([
      { id: loose.id, shown: null, mapped: { ref: sourced("spare.test"), origin: null } },
    ]);

    // The provider stops listing the channel: its mapping is all that is left, to take away.
    const title = (await list("mapped")).channels[0]?.title;
    provider.serveChannels((all) => all.filter((each) => String(each.streamId) !== loose.id));
    await run(library.refresh(id));
    expect((await list("mapped")).channels).toEqual([
      {
        id: loose.id,
        number: null,
        title,
        shown: null,
        mapped: { ref: sourced("spare.test"), id: "spare.test", origin: null },
        listed: false,
      },
    ]);
    const { revision: now } = await list("mapped");
    expect(await run(guide.map(id, loose.id, null, now))).toBeNull();
    expect(await status()).toMatchObject({ mapped: 0, unresolved: 0 });
  });
});

describe("work that finishes after what it was for changed", () => {
  it("drops a source's download that ends after the source was removed", async () => {
    const { run, guide, host, dataDir, quality, nowOn, sources } = await connected();
    const held = host.hold();
    const added = await run(guide.addSource(host.address()));
    await held.arrived;

    await run(guide.removeSource(added.id));
    held.release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await sources()).toEqual([]);
    expect(await nowOn(quality)).toBeUndefined();
    await vi.waitFor(async () =>
      expect(await guideFiles(sourcesIn(dataDir))).toEqual(["sources.json"]),
    );
    expect(await openIn(sourcesIn(dataDir))).toEqual([]);
  });

  it("keeps nothing for a subscription that went, whatever of it was still under way, and leaves the sources", async () => {
    const [first, second] = [await fakeProvider(), await fakeProvider({ channels: 200 })];
    second.serveGuide(tv(named("aac.test", "AAC"), slot("aac.test", "Journal")));
    const host = await guideHost();
    host.serve("/guide.xml", tv(named("spare.test", "Spare"), slot("spare.test", "Elsewhere")));
    const dataDir = await tempDir();
    const { run, guide, roster, subscriptions, sources, add } = await app(dataDir);
    const a = (await run(subscriptions.add(login(first)))).id;
    const b = (await run(subscriptions.add(login(second)))).id;
    const folder = join(dataDir, "subscriptions", b);
    const source = await add(host.address());
    const page = (id: string) =>
      run(guide.mapChannels({ subscriptionId: id, filter: "all", query: "", offset: 0, limit: 1 }));
    const revisions = { a: (await page(a)).revision, b: (await page(b)).revision };

    // Each has a download under way, and a mapping asked for just as it is removed.
    const holds = [first.hold("guide"), second.hold("guide")];
    const downloads = [a, b].map((id) => failureOf(run(guide.refresh(id))));
    await Promise.all(holds.map((hold) => hold.arrived));
    const ref = guideRef(source.id, "spare.test");
    const mappings = [
      failureOf(run(guide.map(a, "1000", ref, revisions.a))),
      failureOf(run(guide.map(b, "1000", ref, revisions.b))),
    ];
    await Promise.all([run(roster.remove(b, false)), run(roster.remove(a, false))]);
    // The providers answer only now, for subscriptions that are gone.
    for (const hold of holds) hold.release();
    await Promise.all([...mappings, ...downloads]);
    // Whatever was still being written has had its turn by now.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await stat(folder).catch(() => null)).toBeNull();
    await vi.waitFor(async () => expect(await guideFiles(dataDir)).toEqual([]));
    // A start afterwards finds nothing to bring back, and the source as it was.
    const restarted = await app(dataDir);
    expect(await restarted.run(restarted.guide.status)).toEqual([]);
    expect((await restarted.sources()).map((each) => each.id)).toEqual([source.id]);
    expect(await sources()).toHaveLength(1);
    expect(await stat(folder).catch(() => null)).toBeNull();
  });
});

describe("a subscription removed while its guide takes its time", () => {
  it("goes at once while what 0.0.12 kept is indexed, and its start's refresh asks nothing after", async () => {
    const provider = await fakeProvider();
    const dataDir = await tempDir();
    const before = await app(dataDir);
    const { id } = await before.run(before.subscriptions.add(login(provider)));
    await before.run(before.guide.refresh(id));
    await before.close();
    // What 0.0.12 kept: the document itself, named by a guide.json without an index.
    const { key, fetchedAt } = JSON.parse(await readFile(join(dataDir, "guide.json"), "utf8"));
    for (const name of await readdir(dataDir)) {
      if (name.startsWith("guide-index.")) await rm(join(dataDir, name));
    }
    await writeFile(join(dataDir, "guide.json"), JSON.stringify({ key, fetchedAt }));
    await writeFile(
      join(dataDir, "guide.xml"),
      tv(named("aac.test", "AAC"), slot("aac.test", "Provider")),
    );
    const { run, guide, roster, status } = await app(dataDir, { guideIndexWorker: stuck });
    const asked = provider.guideRequests();

    // As at the start, the refresh waits for the document to be indexed first.
    const refreshing = failureOf(run(guide.refreshIfStale(id)));
    await vi.waitFor(async () =>
      expect((await status(id)).processing).toMatchObject({ state: "reading" }),
    );
    await run(roster.remove(id, false));

    expect(await refreshing).toEqual(changed);
    expect(provider.guideRequests()).toBe(asked);
    expect(await guideFiles(dataDir)).toEqual([]);
  });

  it("goes at once while a download asked for under its login before a new one hangs", async () => {
    const provider = await fakeProvider();
    const dataDir = await tempDir();
    const { run, guide, roster, subscriptions } = await app(dataDir);
    const { id } = await run(subscriptions.add(login(provider)));
    const held = provider.hold("guide");
    const before = failureOf(run(guide.refresh(id)));
    await held.arrived;

    // The login is stored anew, and its guide asked for under it: the download before stops.
    await run(subscriptions.update(id, { secret: "demo" }));
    const after = failureOf(run(guide.refresh(id)));
    expect(await before).toEqual(changed);
    await run(roster.remove(id, false));
    held.release();

    expect(await after).toEqual(changed);
    await vi.waitFor(async () => expect(await guideFiles(dataDir)).toEqual([]));
  });
});

/** A subscription's channels that name no guide channel themselves, by their ids. */
function listing(subscriptionId: string, ...ids: string[]): CatalogueChannels {
  const all = ids.map((id): LiveChannel => ({
    subscriptionId,
    id,
    name: `Channel ${id}`,
    title: `Channel ${id}`,
    tags: [],
    number: null,
    logoUrl: null,
    categoryIds: [],
    catchupDays: null,
    variants: [{ id, name: `Channel ${id}`, tags: [], quality: null }],
  }));
  const byId = new Map(all.map((each) => [each.id, each]));
  return {
    all,
    searchNames: all.map((each) => each.title.toLowerCase()),
    channel: (id) => byId.get(id),
    listed: (id) => byId.has(id),
    guideIdsOf: () => [],
  };
}

describe("a mapping whose channels or guide changed under it", () => {
  const ID = "held";
  /** A step a test can make wait once: a port takes `pass` where it is to wait. */
  function gate() {
    let waiting: { readonly arrived: () => void; readonly released: Promise<void> } | null = null;
    return {
      pass: Effect.promise(async () => {
        const hold = waiting;
        waiting = null;
        hold?.arrived();
        await hold?.released;
      }),
      /** Makes the next one wait: `arrived` settles once it is asked for, `release` lets it go. */
      hold: () => {
        const arrived = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        waiting = { arrived: arrived.resolve, released: released.promise };
        return { arrived: arrived.promise, release: released.resolve };
      },
    };
  }

  /**
   * The guide service alone, on ports the test holds: one subscription whose channels and whose
   * own guide are what the test last gave it, and a write of its own guide that waits when told
   * to.
   */
  async function held(given: { channels: CatalogueChannels; document: string }) {
    const dir = await tempDir();
    const ownWrites = gate();
    const store = Layer.effect(
      GuideStore,
      Effect.map(GuideStore, (kept) => ({
        ...kept,
        setOwn: (...write: Parameters<typeof kept.setOwn>) =>
          Effect.andThen(ownWrites.pass, kept.setOwn(...write)),
      })),
    ).pipe(Layer.provide(guideStoreLayer));
    const ports = Layer.mergeAll(
      store,
      Layer.succeed(GuideSource, {
        sources: join(dir, "guides"),
        saved: Effect.sync(() => [
          {
            id: ID,
            revision: 1,
            key: "account",
            store: dir,
            archive: GUIDE_ARCHIVE_MS,
            download: async () => ({
              kind: "document" as const,
              body: new Blob([given.document]).stream(),
              size: null,
            }),
          },
        ]),
      }),
      Layer.succeed(GuideCatalogue, { channels: () => Effect.sync(() => given.channels) }),
      Layer.succeed(GuideAddresses, {
        seal: (address) => Effect.succeed(address),
        open: (sealed) => Effect.succeed(sealed),
        fetch: async () => ({ body: new Blob([""]).stream(), size: null }),
      }),
      guideIndexerLayer(guideIndexWorker),
      guideSearcherLayer(guideSearchWorker),
    );
    const runtime = runtimeFor(Guide.layer.pipe(Layer.provide(ports), Layer.provideMerge(clock())));
    const guide = await runtime.runPromise(Guide);
    return {
      dir,
      guide,
      run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
      holdOwnWrite: ownWrites.hold,
    };
  }

  it("is made against the channels and the guide as they are when its turn at the files comes", async () => {
    const guides = (...ids: string[]) =>
      tv(...ids.map((id) => named(id, id)), ...ids.map((id) => slot(id, id)));
    const given = { channels: listing(ID, "1", "2", "3"), document: guides("a.test", "b.test") };
    const { dir, guide, run, holdOwnWrite } = await held(given);
    await run(guide.refresh(ID));
    const page = { subscriptionId: ID, query: "", offset: 0, limit: 10 };
    const { revision } = await run(guide.mapChannels({ ...page, filter: "all" }));
    const own = (guideId: string) => guideRef(OWN_GUIDE, guideId);

    // A download that no longer lists a guide channel is being kept, and three mappings made
    // from the list before wait behind it for the subscription's turn.
    given.document = guides("a.test");
    const keeping = holdOwnWrite();
    const refreshed = run(guide.refresh(ID));
    await keeping.arrived;
    const first = run(guide.map(ID, "1", own("a.test"), revision));
    const second = failureOf(run(guide.map(ID, "2", own("a.test"), revision)));
    const third = failureOf(run(guide.map(ID, "3", own("b.test"), revision)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Meanwhile the provider stops listing a channel.
    given.channels = listing(ID, "1", "3");
    keeping.release();
    await refreshed;

    expect(await first).toMatchObject({ id: "1", mapped: { ref: own("a.test") } });
    expect(await second).toEqual({ kind: "channel-not-found", channelId: "2" });
    expect(await third).toEqual(changed);
    // Neither was kept, in what shows or on disk.
    expect((await run(guide.status))[0]).toMatchObject({ mapped: 1, unresolved: 0 });
    expect((await run(guide.mapChannels({ ...page, filter: "mapped" }))).channels).toMatchObject([
      { id: "1", mapped: { ref: own("a.test") } },
    ]);
    expect(JSON.parse(await readFile(join(dir, "guide-source.json"), "utf8")).mappings).toEqual({
      "1": { source: OWN_GUIDE, guideId: "a.test", name: "Channel 1" },
    });
  });
});

describe("the guide store", () => {
  it("writes nothing into a folder that is gone, so a late write can't bring a subscription back", async () => {
    const folder = join(await tempDir(), "subscriptions", "gone");
    const runtime = runtimeFor(guideStoreLayer);
    const store = await runtime.runPromise(GuideStore);
    const place = { store: folder, key: "account" };

    const set = failureOf(
      runtime.runPromise(
        store.setConfig(place, {
          external: null,
          mappings: { "1": { source: OWN_GUIDE, guideId: "a", name: "One" } },
        }),
      ),
    );
    const download = failureOf(runtime.runPromise(store.download(place, store.newDownload())));

    expect(await set).toMatchObject({ kind: "unexpected" });
    expect(await download).toMatchObject({ kind: "unexpected" });
    expect(await stat(folder).catch(() => null)).toBeNull();
  });
});

describe("a source across starts", () => {
  /** A keychain that no longer opens the guide's address, and still opens the login. */
  const withoutGuide: Secrets = {
    seal: testSecrets.seal,
    open(sealed) {
      const plain = testSecrets.open(sealed);
      if (plain.includes(GUIDE_KEY)) throw new AppFailure({ kind: "keychain-refused" });
      return plain;
    },
  };

  it("keeps what it downloaded when the keychain no longer opens its address, says so, and takes the address again", async () => {
    const { host, dataDir, id, quality, add } = await connected();
    const source = await add(host.address());
    const asked = host.requests().length;

    const locked = await app(dataDir, { secrets: withoutGuide });

    expect((await locked.sources())[0]).toMatchObject({
      id: source.id,
      locked: true,
      processing: { state: "ready", fetchedAt: NOW },
    });
    expect(await locked.nowOn(quality)).toBe("Elsewhere");
    expect(await locked.run(locked.guide.refreshSource(source.id))).toMatchObject({
      locked: true,
      processing: { state: "ready" },
    });
    await locked.run(locked.guide.refreshIfStale(id));
    await locked.advance(7 * HOUR);
    await locked.run(locked.guide.refreshIfStale(id));
    // Nothing was asked of the host.
    expect(host.requests()).toHaveLength(asked);

    // The address typed again is the same source, sealed anew.
    host.serve(
      "/guide.xml",
      tv(
        `<programme start="20261002200000 +0200" stop="20261003060000 +0200" channel="${QUALITY}"><title>Again</title></programme>`,
      ),
    );
    const again = await locked.run(locked.guide.addSource(host.address()));
    expect(again).toMatchObject({ id: source.id, locked: false });
    await locked.run(locked.guide.refreshSource(source.id));
    expect(await locked.nowOn(quality)).toBe("Again");
  });
});

describe("an address a release before gave one subscription", () => {
  /**
   * What the per-subscription address of this release's predecessors kept in a subscription's
   * folder: its download, `document` indexed or as it was, named by guide-source.json with the
   * channels mapped against it.
   */
  async function setAddress(
    folder: string,
    address: string,
    document: { readonly file: string; readonly fetchedAt: number },
    mappings: Readonly<Record<string, { guideId: string; name: string }>>,
  ) {
    const { key }: { key: string } = JSON.parse(await readFile(join(folder, "guide.json"), "utf8"));
    const found = guideAddress(address);
    if (!found) throw new Error("No address.");
    await writeFile(
      join(folder, "guide-source.json"),
      JSON.stringify({
        version: 1,
        key,
        external: {
          origin: found.origin,
          identity: found.identity,
          sealedAddress: testSecrets.seal(found.href),
          since: NOW,
          document,
        },
        mappings,
      }),
    );
  }

  /** `xml` indexed into a file of `folder`, as this release's predecessor kept an address's. */
  async function indexInto(folder: string, xml: string): Promise<string> {
    const file = `guide-index.${randomUUID()}.sqlite`;
    const document = join(folder, `document-${randomUUID()}.xml`);
    await writeFile(document, xml);
    await buildGuideIndex(
      {
        document,
        target: join(folder, file),
        previous: null,
        since: NOW,
        archive: GUIDE_ARCHIVE_MS,
        strict: true,
      },
      () => {},
    );
    await rm(document);
    return file;
  }

  const external = tv(
    named(QUALITY, "Kwaliteit"),
    named("spare.test", "Spare"),
    slot(QUALITY, "External"),
    slot("spare.test", "Spare"),
  );

  it("moves to the sources with what it downloaded and its mappings, the same address of two subscriptions becoming one", async () => {
    const { run, guide, subscriptions, provider, host, dataDir, id, quality, close } =
      await connected();
    const second = await fakeProvider({ channels: 200 });
    second.serveGuide(tv(slot("nothing.test", "Nothing")));
    const other = (await run(subscriptions.add(login(second)))).id;
    await run(guide.refresh(other));
    await close();
    const otherFolder = join(dataDir, "subscriptions", other);
    const loose = unguided(provider);
    // What this release's predecessor kept for each: an index of the address's guide.
    await setAddress(
      dataDir,
      host.address(),
      { file: await indexInto(dataDir, external), fetchedAt: NOW },
      { [loose]: { guideId: "spare.test", name: "Loose" } },
    );
    await setAddress(
      otherFolder,
      host.address(),
      { file: await indexInto(otherFolder, external), fetchedAt: NOW },
      {},
    );
    const asked = [host.requests().length, provider.guideRequests()];

    const upgraded = await app(dataDir);
    const [source, ...more] = await upgraded.sources();

    expect(more).toEqual([]);
    expect(source).toMatchObject({
      origin: host.origin,
      locked: false,
      processing: { state: "ready", fetchedAt: NOW },
    });
    // Its own guide first, then the address for what that lacks; the mapping names the source.
    expect(await upgraded.nowOn({ subscriptionId: id, id: "1000" })).toBe("Provider");
    expect(await upgraded.nowOn(quality)).toBe("External");
    expect(await upgraded.nowOn({ subscriptionId: id, id: loose })).toBe("Spare");
    expect(await upgraded.status(id)).toMatchObject({ mapped: 1, unresolved: 0 });
    // The address names the source now, and stays with its download until the source's first
    // download after: a move only adds.
    expect(JSON.parse(await readFile(join(dataDir, "guide-source.json"), "utf8"))).toMatchObject({
      external: { source: source?.id },
      mappings: { [loose]: { source: source?.id, guideId: "spare.test", name: "Loose" } },
    });
    // One copy in the sources: the second's was the same download.
    await vi.waitFor(async () => expect(await guideFiles(sourcesIn(dataDir))).toEqual(ONE_SOURCE));
    const keptBoth = [
      "guide-index.*.sqlite",
      "guide-index.*.sqlite",
      "guide-source.json",
      "guide.json",
    ];
    expect(await guideFiles(otherFolder)).toEqual(keptBoth);
    expect(await written(dataDir)).not.toContain(GUIDE_KEY);
    // Asking nobody.
    expect([host.requests().length, provider.guideRequests()]).toEqual(asked);
    const again = await app(dataDir);
    expect(await again.nowOn(quality)).toBe("External");
    expect((await again.sources()).map((each) => each.id)).toEqual([source?.id]);

    // The source's first download lets go of what releases before kept.
    host.serve("/guide.xml", external);
    await again.run(again.guide.refreshSource(source?.id ?? ""));
    await vi.waitFor(async () => expect(await guideFiles(otherFolder)).toEqual(OWN_ONLY));
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(join(dataDir, "guide-source.json"), "utf8"))).toMatchObject({
        external: null,
        mappings: { [loose]: { source: source?.id } },
      }),
    );
    await vi.waitFor(async () => expect(await guideFiles(sourcesIn(dataDir))).toEqual(ONE_SOURCE));
    expect(await again.nowOn({ subscriptionId: id, id: loose })).toBe("Spare");
  });

  it("comes over from 0.0.12 with its address and its mappings, each document indexed once when it is wanted, and downloads the address straight after", async () => {
    const { host, provider, dataDir, id, quality, close } = await connected();
    await close();
    expect(await openIn(dataDir)).toEqual([]);
    const loose = unguided(provider);
    // What 0.0.12 kept instead: the documents themselves, named as it named them.
    const { key, fetchedAt } = JSON.parse(await readFile(join(dataDir, "guide.json"), "utf8"));
    for (const name of await readdir(dataDir)) {
      if (name.startsWith("guide-index.")) await rm(join(dataDir, name));
    }
    await writeFile(join(dataDir, "guide.json"), JSON.stringify({ key, fetchedAt }));
    await writeFile(
      join(dataDir, "guide.xml"),
      tv(named("aac.test", "AAC"), slot("aac.test", "Provider")),
    );
    const document = `guide-external.${randomUUID()}.xml`;
    await writeFile(join(dataDir, document), external);
    await setAddress(
      dataDir,
      host.address(),
      { file: document, fetchedAt },
      { [loose]: { guideId: "spare.test", name: "Loose" } },
    );
    // The address answers as it did, so what is read is the same before its download and after.
    host.serve("/guide.xml", external);
    const once = [host.requests().length + 1, provider.guideRequests()];

    const upgraded = await app(dataDir);
    // As the app does after its start. Indexed in the background; a refresh that finds the own
    // guide recent waits for it and asks its provider nothing, and the address downloads again
    // once what 0.0.12 kept for it is indexed.
    await upgraded.run(upgraded.guide.refreshIfStale(id));
    await vi.waitFor(() =>
      expect([host.requests().length, provider.guideRequests()]).toEqual(once),
    );
    await vi.waitFor(async () =>
      expect((await upgraded.sources())[0]?.processing).toMatchObject({ state: "ready" }),
    );

    expect(await upgraded.nowOn({ subscriptionId: id, id: "1000" })).toBe("Provider");
    expect(await upgraded.nowOn(quality)).toBe("External");
    expect(await upgraded.nowOn({ subscriptionId: id, id: loose })).toBe("Spare");
    expect(await upgraded.status(id)).toMatchObject({
      mapped: 1,
      unresolved: 0,
      fetchedAt,
      processing: { state: "ready" },
    });
    // Each is an index where it is read, and the source's own download let go of what 0.0.12
    // kept for the address.
    await vi.waitFor(async () => expect(await guideFiles(sourcesIn(dataDir))).toEqual(ONE_SOURCE));
    await vi.waitFor(async () =>
      expect(await guideFiles(dataDir)).toEqual([
        "guide-index.*.sqlite",
        "guide-source.json",
        "guide.json",
      ]),
    );
    expect([host.requests().length, provider.guideRequests()]).toEqual(once);
  });
});

describe("an address a release before gave, moving to the sources", () => {
  /** How long a wait for a download indexed in a worker gives a busy machine. */
  const INDEXED = { timeout: 15_000 };
  /** The steps of a move, and the reads, a test can make fail. */
  type Step = "copy" | "setSources" | "setConfig" | "sources" | "config";
  const ADDRESS = "https://guide.example.org/guide.xml?key=s3cret";

  /**
   * The guide service alone on `root`, as one start of the app: the subscriptions `order` names,
   * each in a folder of its own with channels "1" and "2" that name no guide channel, and a store
   * whose step `failing` names fails once. Addresses are sealed as they are, their host answers
   * with `host.xml`, and documents are indexed by `indexWorker`'s workers.
   */
  async function started(
    root: string,
    order: readonly string[],
    failing: Step | null = null,
    host: { xml: string } = { xml: "" },
    indexWorker: MainConfig["guideIndexWorker"] = guideIndexWorker,
  ) {
    let asked = 0;
    let fails = failing;
    const once = (step: Step) => {
      if (fails !== step) return false;
      fails = null;
      return true;
    };
    const disk = Effect.fail(failedWith(new Error("The disk is full.")));
    const store = Layer.effect(
      GuideStore,
      Effect.map(GuideStore, (kept) => ({
        ...kept,
        copy: (...args: Parameters<typeof kept.copy>) =>
          once("copy") ? Effect.succeed("failed" as const) : kept.copy(...args),
        setSources: (...args: Parameters<typeof kept.setSources>) =>
          once("setSources") ? disk : kept.setSources(...args),
        setConfig: (...args: Parameters<typeof kept.setConfig>) =>
          once("setConfig") ? disk : kept.setConfig(...args),
        sources: (...args: Parameters<typeof kept.sources>) =>
          once("sources") ? disk : kept.sources(...args),
        config: (...args: Parameters<typeof kept.config>) =>
          once("config") ? disk : kept.config(...args),
      })),
    ).pipe(Layer.provide(guideStoreLayer));
    const ports = Layer.mergeAll(
      store,
      Layer.succeed(GuideSource, {
        sources: join(root, "guides"),
        saved: Effect.sync(() =>
          order.map((id) => ({
            id,
            revision: 1,
            key: "account",
            store: join(root, id),
            archive: GUIDE_ARCHIVE_MS,
            download: async () => ({ kind: "none" as const }),
          })),
        ),
      }),
      Layer.succeed(GuideCatalogue, {
        channels: (subscriptionId) => Effect.succeed(listing(subscriptionId, "1", "2")),
      }),
      Layer.succeed(GuideAddresses, {
        seal: (address) => Effect.succeed(address),
        open: (sealed) => Effect.succeed(sealed),
        fetch: async () => {
          asked += 1;
          return { body: new Blob([host.xml]).stream(), size: null };
        },
      }),
      guideIndexerLayer(indexWorker),
      guideSearcherLayer(guideSearchWorker),
    );
    const runtime = runtimeFor(Guide.layer.pipe(Layer.provide(ports), Layer.provideMerge(clock())));
    const guide = await runtime.runPromise(Guide);
    const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
    return {
      run,
      guide,
      close: () => runtime.dispose(),
      sources: () => run(guide.sources),
      /** How many times the host was asked for a guide. */
      asked: () => asked,
      nowOn: async (subscriptionId: string, id: string) =>
        (await run(guide.listings([{ subscriptionId, id }])))[ownedKey({ subscriptionId, id })]?.now
          ?.title,
      status: async (subscriptionId: string) =>
        (await run(guide.status)).find((each) => each.subscriptionId === subscriptionId),
    };
  }

  /**
   * What a release before kept in subscription `id`'s folder for ADDRESS: its download, `xml`
   * as 0.0.12 kept it or indexed as the release after did, from `fetchedAt`, named by
   * guide-source.json with the channels mapped against it.
   */
  async function legacy(
    root: string,
    id: string,
    { xml, fetchedAt, indexed }: { xml: string; fetchedAt: number; indexed: boolean },
    mappings: Readonly<Record<string, { guideId: string; name: string }>>,
  ) {
    const folder = join(root, id);
    await mkdir(folder, { recursive: true });
    const found = guideAddress(ADDRESS);
    if (!found) throw new Error("No address.");
    let file = `guide-external.${randomUUID()}.xml`;
    if (indexed) {
      file = `guide-index.${randomUUID()}.sqlite`;
      await writeFile(join(folder, "document.xml"), xml);
      await buildGuideIndex(
        {
          document: join(folder, "document.xml"),
          target: join(folder, file),
          previous: null,
          since: NOW,
          archive: GUIDE_ARCHIVE_MS,
          strict: true,
        },
        () => {},
      );
      await rm(join(folder, "document.xml"));
    } else {
      await writeFile(join(folder, file), xml);
    }
    await writeFile(
      join(folder, "guide-source.json"),
      JSON.stringify({
        version: 1,
        key: "account",
        external: {
          origin: found.origin,
          identity: found.identity,
          sealedAddress: found.href,
          document: { file, fetchedAt },
        },
        mappings,
      }),
    );
    return file;
  }

  const config = async (root: string, id: string) =>
    JSON.parse(await readFile(join(root, id, "guide-source.json"), "utf8"));

  /** Every file under `root`, by its path there, each index's id as "*". */
  const everything = async (root: string) =>
    (await readdir(root, { recursive: true }))
      .map((name) => name.replace(/\.[0-9a-f-]{36}\./, ".*."))
      .sort();

  /** What 0.0.12 kept for subscription "a": the address's download as XMLTV, mapped against. */
  const kept012 = (root: string) =>
    legacy(
      root,
      "a",
      {
        xml: tv(named("spare.test", "Spare"), slot("spare.test", "Spare")),
        fetchedAt: NOW - HOUR,
        indexed: false,
      },
      { "1": { guideId: "spare.test", name: "One" } },
    );

  it.each(["copy", "setSources", "setConfig"] as const)(
    "keeps the address, its download and its mappings when %s fails, reads it where it is meanwhile, and moves it at the next start",
    async (step) => {
      const root = await tempDir();
      const file = await kept012(root);
      const before = await readFile(join(root, "a", "guide-source.json"), "utf8");

      const failing = await started(root, ["a"], step);
      const kept = await failing.sources();
      // What was set for the subscription is as it was, its download beside it, and it reads it.
      expect(await readFile(join(root, "a", "guide-source.json"), "utf8")).toBe(before);
      expect(await readdir(join(root, "a"))).toContain(file);
      await vi.waitFor(async () => expect(await failing.nowOn("a", "1")).toBe("Spare"), INDEXED);
      expect(await failing.status("a")).toMatchObject({ mapped: 1, unresolved: 0 });
      expect(kept).toEqual(
        step === "setConfig"
          ? [expect.objectContaining({ origin: "https://guide.example.org" })]
          : [],
      );
      await failing.close();

      const again = await started(root, ["a"]);
      await vi.waitFor(
        async () =>
          expect(await again.sources()).toMatchObject([
            {
              origin: "https://guide.example.org",
              processing: { state: "ready", fetchedAt: NOW - HOUR },
            },
          ]),
        INDEXED,
      );
      const [source] = await again.sources();
      expect(await again.nowOn("a", "1")).toBe("Spare");
      expect(await again.status("a")).toMatchObject({ mapped: 1, unresolved: 0 });
      // It names the source, and stays, with its download, until the source has one of its own.
      expect(await config(root, "a")).toMatchObject({
        external: { source: source?.id },
        mappings: { "1": { source: source?.id, guideId: "spare.test" } },
      });
      await vi.waitFor(
        async () =>
          expect(await guideFiles(join(root, "a"))).toEqual([
            "guide-external.*.xml",
            "guide-source.json",
          ]),
        INDEXED,
      );
      await vi.waitFor(
        async () => expect(await guideFiles(sourcesIn(root))).toEqual(ONE_SOURCE),
        INDEXED,
      );
      await again.close();
    },
  );

  it.each(["sources", "config"] as const)(
    "lets go of nothing in a run whose %s can't be read, and reads it again at the next start",
    async (step) => {
      const root = await tempDir();
      await kept012(root);
      const first = await started(root, ["a"]);
      await vi.waitFor(
        async () =>
          expect(await first.sources()).toMatchObject([{ processing: { state: "ready" } }]),
        INDEXED,
      );
      await first.close();
      // What work cut short would leave, which a sweep takes.
      const left = `guide-index.${randomUUID()}.sqlite`;
      await writeFile(join(root, "a", left), "");
      await writeFile(join(sourcesIn(root), left), "");
      const files = await everything(root);

      const failing = await started(root, ["a"], step);
      await failing.sources();
      await failing.nowOn("a", "1");
      await failing.status("a");
      // Given time to sweep, it doesn't.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await failing.close();
      expect(await everything(root)).toEqual(files);

      const again = await started(root, ["a"]);
      await vi.waitFor(async () => expect(await again.nowOn("a", "1")).toBe("Spare"), INDEXED);
      expect(await again.status("a")).toMatchObject({ mapped: 1, unresolved: 0 });
      // A run that reads everything sweeps.
      await vi.waitFor(
        async () => expect(await readdir(join(root, "a"))).not.toContain(left),
        INDEXED,
      );
      await vi.waitFor(
        async () => expect(await readdir(sourcesIn(root))).not.toContain(left),
        INDEXED,
      );
      await again.close();
    },
  );

  it("reads one download of an address two subscriptions had, the newest, then the larger, then the first by name, whichever is read first, until its own lets go of the others", async () => {
    /** A download of the address as subscription `id` kept it, which names its programmes after it. */
    const kept = (id: string, spare: boolean) =>
      tv(
        named("shared.test", "Shared"),
        slot("shared.test", `${id} shared`),
        ...(spare ? [named("spare.test", "Spare"), slot("spare.test", `${id} spare`)] : []),
      );
    const cases = [
      // The newer: what only the older one listed waits for the source's own download.
      { a: { spare: true, fetchedAt: NOW - 2 * HOUR }, b: { spare: false, fetchedAt: NOW - HOUR } },
      // At the same time, the larger.
      { a: { spare: false, fetchedAt: NOW - HOUR }, b: { spare: true, fetchedAt: NOW - HOUR } },
      // As large too, the first by name.
      { a: { spare: true, fetchedAt: NOW - HOUR }, b: { spare: true, fetchedAt: NOW - HOUR } },
    ];
    for (const [at, { a, b }] of cases.entries()) {
      for (const order of [
        ["a", "b"],
        ["b", "a"],
      ]) {
        const root = await tempDir();
        const mappings = {
          "1": { guideId: "shared.test", name: "One" },
          "2": { guideId: "spare.test", name: "Two" },
        };
        const files = {
          a: await legacy(
            root,
            "a",
            { xml: kept("a", a.spare), fetchedAt: a.fetchedAt, indexed: false },
            mappings,
          ),
          b: await legacy(
            root,
            "b",
            { xml: kept("b", b.spare), fetchedAt: b.fetchedAt, indexed: false },
            mappings,
          ),
        };
        const read = at === 2 ? (files.a < files.b ? "a" : "b") : "b";
        const spare = read === "a" ? a.spare : b.spare;
        const host = { xml: kept("fresh", true) };
        const label = `case ${at}, ${order.join(" then ")}`;

        for (const start of ["upgraded", "again"]) {
          const app = await started(root, order, null, host);
          await vi.waitFor(
            async () =>
              expect(await app.sources(), label).toMatchObject([
                { processing: { state: "ready" } },
              ]),
            INDEXED,
          );
          for (const id of ["a", "b"]) {
            expect(await app.nowOn(id, "1"), `${label}, ${start}`).toBe(`${read} shared`);
            expect(await app.nowOn(id, "2"), `${label}, ${start}`).toBe(
              spare ? `${read} spare` : undefined,
            );
            expect(await app.status(id), `${label}, ${start}`).toMatchObject({
              mapped: 2,
              unresolved: spare ? 0 : 1,
            });
          }
          // The other stays where it was, with its address, unread.
          expect(await readdir(join(root, read === "a" ? "b" : "a")), label).toContain(
            files[read === "a" ? "b" : "a"],
          );
          await app.close();
        }
      }
    }
  });

  it("keeps what a run that couldn't read everything replaced until the next start that can, which lets go of it", async () => {
    const root = await tempDir();
    await kept012(root);
    const host = { xml: tv(named("spare.test", "Spare"), slot("spare.test", "Fresh")) };
    const first = await started(root, ["a"], null, host);
    await vi.waitFor(
      async () => expect(await first.sources()).toMatchObject([{ processing: { state: "ready" } }]),
      INDEXED,
    );
    await first.close();

    // What is set for "a" can't be read once: the run keeps everything.
    const failing = await started(root, ["a"], "config", host);
    const [source] = await failing.sources();
    for (let download = 0; download < 3; download++) {
      await failing.run(failing.guide.refreshSource(source?.id ?? ""));
    }
    expect(await failing.nowOn("a", "1")).toBe("Fresh");
    expect((await readdir(sourcesIn(root))).filter((name) => name.endsWith(".sqlite")).length).toBe(
      4,
    );
    expect(await readdir(join(root, "a"))).toContainEqual(
      expect.stringMatching(/^guide-external\./),
    );
    await failing.close();

    // A start that reads everything: one download of the source's own, nothing a move kept.
    const healthy = await started(root, ["a"], null, host);
    expect(await healthy.nowOn("a", "1")).toBe("Fresh");
    await vi.waitFor(
      async () => expect(await guideFiles(sourcesIn(root))).toEqual(ONE_SOURCE),
      INDEXED,
    );
    await vi.waitFor(
      async () => expect(await guideFiles(join(root, "a"))).toEqual(["guide-source.json"]),
      INDEXED,
    );
    expect((await config(root, "a")).external).toBeNull();
    await healthy.close();
  });

  it("lets go of what a move kept once the source has a download of its own", async () => {
    const root = await tempDir();
    const mappings = { "1": { guideId: "spare.test", name: "One" } };
    await legacy(
      root,
      "a",
      {
        xml: tv(named("spare.test", "Spare"), slot("spare.test", "Older")),
        fetchedAt: NOW - 2 * HOUR,
        indexed: true,
      },
      mappings,
    );
    await legacy(
      root,
      "b",
      {
        xml: tv(named("spare.test", "Spare"), slot("spare.test", "Newer")),
        fetchedAt: NOW - HOUR,
        indexed: true,
      },
      mappings,
    );
    const host = { xml: tv(named("spare.test", "Spare"), slot("spare.test", "Fresh")) };
    const app = await started(root, ["a", "b"], null, host);
    const [source] = await app.sources();
    expect(await app.nowOn("a", "1")).toBe("Newer");

    await app.run(app.guide.refreshSource(source?.id ?? ""));

    expect(await app.nowOn("a", "1")).toBe("Fresh");
    for (const id of ["a", "b"]) {
      await vi.waitFor(
        async () => expect(await guideFiles(join(root, id))).toEqual(["guide-source.json"]),
        INDEXED,
      );
      expect((await config(root, id)).external).toBeNull();
      expect((await config(root, id)).mappings["1"]).toMatchObject({ source: source?.id });
    }
    await vi.waitFor(
      async () => expect(await guideFiles(sourcesIn(root))).toEqual(ONE_SOURCE),
      INDEXED,
    );
    await app.close();
  });

  it("downloads a source a move brought at the start's refresh, however recent what it brought, once that is indexed", async () => {
    const root = await tempDir();
    await kept012(root);
    const host = { xml: tv(named("spare.test", "Spare"), slot("spare.test", "Fresh")) };
    const app = await started(root, ["a"], null, host);

    // As the app does after its start, while what 0.0.12 kept is still being indexed.
    await app.run(app.guide.refreshIfStale("a"));

    await vi.waitFor(async () => expect(await app.nowOn("a", "1")).toBe("Fresh"), INDEXED);
    expect(app.asked()).toBe(1);
    await vi.waitFor(
      async () => expect(await guideFiles(join(root, "a"))).toEqual(["guide-source.json"]),
      INDEXED,
    );
    await app.close();
  });

  it("asks nothing for a source a move brought that is removed while what it brought is indexed", async () => {
    const root = await tempDir();
    await kept012(root);
    const app = await started(root, ["a"], null, { xml: "" }, stuck);
    await app.run(app.guide.refreshIfStale("a"));
    const [source] = await app.sources();

    await app.run(app.guide.removeSource(source?.id ?? ""));
    // Whatever waited for the indexing has had its turn by now.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await app.sources()).toEqual([]);
    expect(app.asked()).toBe(0);
    await app.close();
  });
});

describe("the guide store's copy of a release before's download", () => {
  it("says a file is missing only where the system says so, and fails where it can't look", async () => {
    const root = await tempDir();
    const from = join(root, "from");
    const to = join(root, "to");
    await mkdir(from);
    await writeFile(join(from, "guide-index.kept.sqlite"), "index");
    const runtime = runtimeFor(guideStoreLayer);
    const store = await runtime.runPromise(GuideStore);
    const copy = (file: string) =>
      runtime.runPromise(store.copy({ store: from }, { store: to }, file));

    expect(await copy("guide-index.gone.sqlite")).toBe("missing");
    // A folder it may not look into: the file may well be there.
    await chmod(from, 0o600);
    try {
      expect(await copy("guide-index.kept.sqlite")).toBe("failed");
    } finally {
      await chmod(from, 0o700);
    }
    expect(await copy("guide-index.kept.sqlite")).toBe("copied");
    expect(await readFile(join(to, "guide-index.kept.sqlite"), "utf8")).toBe("index");
    expect(await readFile(join(from, "guide-index.kept.sqlite"), "utf8")).toBe("index");
  });
});

describe("a source taking a channel over with time alone", () => {
  it("is told when the own guide's last programme on a channel ends, and read from then on", async () => {
    const services = await connected();
    const { run, guide, provider, host, id, first, advance } = services;
    provider.serveGuide(
      tv(named("aac.test", "AAC"), programme("aac.test", "2000", "2030", "Ending")),
    );
    await run(guide.refresh(id));
    host.serve(
      "/guide.xml",
      tv(named("aac.test", "AAC One"), programme("aac.test", "2000", "2300", "Elsewhere on")),
    );
    await services.add(host.address());
    const range = async () =>
      (await run(guide.range([first], NOW - HOUR, NOW + 3 * HOUR)))[ownedKey(first)] ?? [];
    const [ending] = await range();
    expect(ending?.title).toBe("Ending");
    expect(
      await run(guide.programme(first, ending?.guide ?? "", ending?.start ?? 0)),
    ).toMatchObject({
      title: "Ending",
    });

    // At 20:30 the own guide has nothing left on it: the window is told, with nothing else new.
    let told = 0;
    const counting = Effect.runFork(
      Stream.runForEach(guide.changes, () => Effect.sync(() => told++)),
    );
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
    await settle();
    // A minute at a time, as the service checks the time each minute.
    for (let minute = 0; minute < 19; minute++) {
      await advance(MINUTE);
      await settle();
    }
    expect(told).toBe(0);
    for (let minute = 0; minute < 2; minute++) {
      await advance(MINUTE);
      await settle();
    }
    await vi.waitFor(() => expect(told).toBe(1));
    await Effect.runPromise(Fiber.interrupt(counting));

    expect((await range()).map(({ title }) => title)).toEqual(["Elsewhere on"]);
    // Details of a slot of the guide that no longer supplies the channel aren't given.
    expect(await run(guide.programme(first, ending?.guide ?? "", ending?.start ?? 0))).toBeNull();
  });
});

describe("the request for a guide's address", () => {
  const ADDRESS = `https://guide.example.org/xmltv.gz?key=${GUIDE_KEY}`;
  /** A fetch that answers each address from `answers`, noting what it was asked. */
  function fetching(answers: Readonly<Record<string, () => Response>>) {
    const asked: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
    const fetch = xmltvFetch({
      userAgent,
      fetch: async (input, init) => {
        const url = String(input);
        asked.push({ url, init });
        const answer = answers[url];
        if (!answer) throw new TypeError(`fetch failed for ${url}`);
        return answer();
      },
    });
    return { asked, fetch: (address: string) => fetch(address, new AbortController().signal) };
  }
  const redirect = (location: string) => () =>
    new Response(null, { status: 302, headers: { Location: location } });
  const refusal = (work: Promise<unknown>) =>
    work.then(
      () => null,
      (cause: unknown) => (cause instanceof AppFailure ? cause.error : cause),
    );

  it("follows a few redirects, never from https to http, and sends nothing but its own headers", async () => {
    const moved = `https://cdn.example.net/guide.xml?token=${GUIDE_KEY}`;
    const plain = `http://cdn.example.net/guide.xml?token=${GUIDE_KEY}`;
    const { asked, fetch } = fetching({
      [ADDRESS]: redirect(moved),
      [moved]: () => new Response("<tv></tv>"),
      "https://guide.example.org/down": redirect(plain),
      "http://guide.example.org/up": redirect(moved),
      "https://guide.example.org/loop": redirect("https://guide.example.org/loop"),
    });

    const { body, size } = await fetch(ADDRESS);
    let text = "";
    for await (const piece of body) text += Buffer.from(piece).toString();

    expect(text).toBe("<tv></tv>");
    // The server said no length.
    expect(size).toBeNull();
    expect(asked.map((each) => each.url)).toEqual([ADDRESS, moved]);
    expect(asked[1]?.init).toMatchObject({
      redirect: "manual",
      headers: { "User-Agent": userAgent, Accept: expect.any(String) },
    });
    expect(Object.keys(asked[1]?.init?.headers ?? {})).toEqual(["User-Agent", "Accept"]);

    // The key in an address typed with https never travels unencrypted.
    expect(await refusal(fetch("https://guide.example.org/down"))).toEqual({
      kind: "guide",
      failure: { kind: "redirect", reason: "unencrypted" },
    });
    expect(asked.map((each) => each.url)).not.toContain(plain);
    // From http to https is no loss.
    await expect(fetch("http://guide.example.org/up")).resolves.toBeDefined();
    const before = asked.length;
    expect(await refusal(fetch("https://guide.example.org/loop"))).toEqual({
      kind: "guide",
      failure: { kind: "redirect", reason: "too-many" },
    });
    expect(asked.length - before).toBe(6);
  });

  it("fails naming no more of the address than its origin", async () => {
    const { fetch } = fetching({
      "https://guide.example.org/refused": () => new Response("no", { status: 403 }),
      "https://guide.example.org/lost": () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from("<tv>"));
              controller.error(new TypeError(`terminated: ${ADDRESS}`));
            },
          }),
        ),
    });
    const read = async (address: string) => {
      for await (const _piece of (await fetch(address)).body) void _piece;
    };

    const unreachable = await refusal(fetch(ADDRESS));
    const lost = await refusal(read("https://guide.example.org/lost"));

    expect(unreachable).toMatchObject({ kind: "unreachable", server: "https://guide.example.org" });
    expect(lost).toMatchObject({ kind: "unreachable", server: "https://guide.example.org" });
    expect(await refusal(fetch("https://guide.example.org/refused"))).toEqual({
      kind: "provider-error",
      status: 403,
    });
    for (const told of [unreachable, lost]) {
      expect(JSON.stringify(told)).not.toContain(GUIDE_KEY);
      expect(JSON.stringify(told)).not.toContain("xmltv.gz");
    }
  });
});
