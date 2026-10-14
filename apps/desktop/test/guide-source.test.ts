// A guide from an XMLTV address of the viewer's own, for one subscription, and channels mapped
// to a guide's by hand: through the guide service as the window calls it, on the app's runtime,
// against the fake provider, the fake playlist and a host for guides.
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { AppFailure } from "@mrstreamer/contracts/errors";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { Failed } from "@mrstreamer/core/failure";
import { GUIDE_LIMITS } from "@mrstreamer/core/guide/limits";
import type { CatalogueChannels } from "@mrstreamer/core/guide/programmes";
import {
  Guide,
  GuideAddresses,
  GuideCatalogue,
  GuideSource,
  GuideStore,
} from "@mrstreamer/core/guide/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, describe, expect, it } from "vitest";
import { guideStoreLayer } from "../src/main/platform/guide-store.ts";
import type { Secrets } from "../src/main/platform/secrets.ts";
import { xmltvFetch } from "../src/main/providers/xmltv.ts";
import { mainLayer } from "../src/main/runtime.ts";
import { Library } from "../src/main/services/library.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { GUIDE_KEY, startGuideHost, type GuideHost } from "./fake-guide-host.ts";
import { PLAYLIST_CHANNELS, startFakePlaylist } from "./fake-playlist.ts";
import type { FakeProvider } from "./fake-provider.ts";
import {
  fakeProvider,
  runtimeFor,
  tempDir,
  testConfig,
  testSecrets,
  userAgent,
} from "./support.ts";

const HOUR = 60 * 60 * 1000;
/** 20:10 at +02:00, where every guide here writes its times. */
const NOW = Date.parse("2026-10-02T20:10:00+02:00");
const at = (time: string) => Date.parse(`2026-10-02T${time}:00+02:00`);

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

/** A clock that stands at NOW until a test moves it. */
const clock = () =>
  Layer.effectDiscard(TestClock.setTime(NOW)).pipe(
    Layer.provideMerge(TestClock.layer({ warningDelay: "1 day" })),
  );

/** The app's services on `dataDir`, with the clock at NOW; another call is the app started again. */
async function app(dataDir: string, secrets: Secrets = testSecrets) {
  const runtime = runtimeFor(
    mainLayer({ ...testConfig(dataDir), secrets }).pipe(Layer.provideMerge(clock())),
  );
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
  const guide = await runtime.runPromise(Guide);
  return {
    run,
    guide,
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
    /** Checks an address and switches to what the check found. */
    attach: async (subscriptionId: string, address: string) =>
      run(guide.use(subscriptionId, (await run(guide.check(subscriptionId, address))).id)),
    /** Moves the clock on, short of the service's own quarter-hourly look at the guides. */
    advance: (ms: number) => run(TestClock.adjust(ms)),
  };
}

/** What is kept of guides in a folder, by name. */
async function guideFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => []);
  return names.filter((name) => name.startsWith("guide")).sort();
}

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
 * channel, and a host with a guide of another origin that says "External" there.
 */
async function connected() {
  const provider = await fakeProvider();
  provider.serveGuide(tv(named("aac.test", "AAC"), slot("aac.test", "Provider")));
  const host = await guideHost();
  host.serve(
    "/guide.xml",
    tv(
      named("aac.test", "AAC One"),
      named("other.test", "Other"),
      slot("aac.test", "External"),
      programme("other.test", "2000", "2300", "Elsewhere"),
    ),
  );
  const dataDir = await tempDir();
  const services = await app(dataDir);
  const { id } = await services.run(services.subscriptions.add(login(provider)));
  const channel = (channelId: string): OwnedId => ({ subscriptionId: id, id: channelId });
  await services.run(services.guide.refresh(id));
  return { ...services, provider, host, dataDir, id, channel, first: channel("1000") };
}

/** A channel of the fake provider that sends no guide id, by its id. */
function unguided(provider: FakeProvider): string {
  const channel = provider.catalogue.channels.find(
    (each) => each.streamId >= 2000 && !each.offline && !each.guideId,
  );
  if (!channel) throw new Error("The fake catalogue has no channel without a guide id.");
  return String(channel.streamId);
}

describe("a guide from an address of the viewer's own", () => {
  it("is checked without changing anything, used only when told to, and kept apart from the provider's", async () => {
    const { run, guide, provider, host, dataDir, id, first, nowOn, status } = await connected();
    const own = {
      document: await readFile(join(dataDir, "guide.xml"), "utf8"),
      meta: await readFile(join(dataDir, "guide.json"), "utf8"),
    };

    const found = await run(guide.check(id, host.address()));

    expect(found).toEqual({
      id: expect.any(String),
      origin: host.origin,
      guideChannels: 2,
      matched: 1,
      listed: (await run(guide.status))[0]?.listed,
      until: at("23:00"),
      sameSource: false,
    });
    // Checked only: the provider's guide is still the one in use.
    expect(await nowOn(first)).toBe("Provider");
    expect(await status(id)).toMatchObject({ source: { kind: "own" } });

    const switched = await run(guide.use(id, found.id));

    expect(switched).toMatchObject({
      source: { kind: "external", origin: host.origin, since: NOW, locked: false },
      channels: 1,
      guideChannels: 2,
      fetchedAt: NOW,
      failure: null,
    });
    expect(await nowOn(first)).toBe("External");
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
    expect(JSON.stringify([found, switched, await run(guide.status)])).not.toContain(GUIDE_KEY);
    const disk = await written(dataDir);
    expect(disk).not.toContain(GUIDE_KEY);
    expect(disk).not.toContain("/guide.xml?");
    // The provider's own guide stays as every release keeps it, with its own programmes.
    expect(await readFile(join(dataDir, "guide.xml"), "utf8")).toBe(own.document);
    expect(await readFile(join(dataDir, "guide.json"), "utf8")).toBe(own.meta);

    // After a restart it shows from what was kept, with nothing asked of either server.
    const asked = [host.requests().length, provider.guideRequests()];
    const restarted = await app(dataDir);
    expect(await restarted.nowOn(first)).toBe("External");
    expect(await restarted.status(id)).toMatchObject({
      source: { kind: "external", origin: host.origin, since: NOW },
      fetchedAt: NOW,
    });
    await restarted.run(restarted.guide.refreshIfStale(id));
    expect([host.requests().length, provider.guideRequests()]).toEqual(asked);
  });

  it("keeps its last download when a later one fails, says why also after a restart, and never falls back", async () => {
    const { run, guide, provider, host, dataDir, id, first, nowOn, status, attach, advance } =
      await connected();
    await attach(id, host.address());
    const asked = provider.guideRequests();

    host.serve("/guide.xml", 503);
    expect(await failureOf(run(guide.refresh(id)))).toEqual({
      kind: "provider-error",
      status: 503,
    });
    await advance(10 * 60 * 1000);
    host.serve("/guide.xml", tv(slot("aac.test", "Cut off")).slice(0, -20));
    expect(await failureOf(run(guide.refresh(id)))).toEqual({
      kind: "guide",
      failure: { kind: "incomplete" },
    });

    const failing = {
      source: { kind: "external", origin: host.origin },
      channels: 1,
      fetchedAt: NOW,
      failure: { kind: "guide", failure: { kind: "incomplete" } },
      // Since the first download that failed.
      failedAt: NOW,
    };
    expect(await status(id)).toMatchObject(failing);
    expect(await nowOn(first)).toBe("External");
    // The provider's guide wasn't asked for in its place.
    expect(provider.guideRequests()).toBe(asked);
    expect(await guideFiles(dataDir)).toHaveLength(4);

    const restarted = await app(dataDir);
    expect(await restarted.status(id)).toMatchObject(failing);
    expect(await restarted.nowOn(first)).toBe("External");

    // The next download that works replaces it, and the failure is gone.
    host.serve("/guide.xml", tv(slot("aac.test", "External again")));
    await restarted.run(restarted.guide.refresh(id));
    expect(await restarted.nowOn(first)).toBe("External again");
    expect(await restarted.status(id)).toMatchObject({ failure: null, failedAt: null });
    expect(await guideFiles(dataDir)).toHaveLength(4);
    expect(provider.guideRequests()).toBe(asked);
  });

  it("goes back to the provider's guide when asked, from what was kept of it, and drops the address", async () => {
    const { run, guide, provider, host, dataDir, id, first, nowOn, attach } = await connected();
    await attach(id, host.address());
    const asked = provider.guideRequests();

    const restored = await run(guide.restore(id));

    expect(restored).toMatchObject({
      source: { kind: "own" },
      channels: 1,
      fetchedAt: NOW,
      availability: "available",
      failure: null,
    });
    expect(await nowOn(first)).toBe("Provider");
    expect(provider.guideRequests()).toBe(asked);
    expect(await guideFiles(dataDir)).toEqual(["guide.json", "guide.xml"]);
    expect(await (await app(dataDir)).nowOn(first)).toBe("Provider");
  });

  it("says so when the provider's guide can't be had on the way back, and shows nothing as its own", async () => {
    const { run, guide, provider, host, id, first, nowOn, attach, advance } = await connected();
    await attach(id, host.address());
    // The provider's own guide is too old to show by now, and its server fails.
    await advance(7 * HOUR);
    provider.serveGuide(502);

    const restored = await run(guide.restore(id));

    expect(restored).toMatchObject({
      source: { kind: "own" },
      failure: { kind: "provider-error", status: 502 },
    });
    expect(await nowOn(first)).not.toBe("External");
  });

  it("reads a guide that is gzip by its content, split anywhere, or unpacked by the connection", async () => {
    const { run, guide, host, id } = await connected();
    const document = tv(named("aac.test", "AAC"), slot("aac.test", "Packed"));
    const check = async (path: string) => (await run(guide.check(id, host.address(path)))).matched;

    host.serve("/packed.xml.gz", gzipSync(document), { pieceBytes: 1 });
    expect(await check("/packed.xml.gz")).toBe(1);
    // Named as plain XML, and gzip all the same.
    host.serve("/plain-named.xml", gzipSync(document));
    expect(await check("/plain-named.xml")).toBe(1);
    // Sent as gzip by the server, which the connection unpacks: the guide arrives as XML.
    host.serve("/sent-packed.xml.gz", gzipSync(document), {
      headers: { "Content-Encoding": "gzip" },
    });
    expect(await check("/sent-packed.xml.gz")).toBe(1);
  });

  it("refuses an address whose answer is no guide to use, and keeps the guide in use", async () => {
    const { run, guide, host, dataDir, id, first, nowOn, status, attach } = await connected();
    const ended = programme("aac.test", "1800", "1900", "Earlier");
    const refusals: [answer: Parameters<GuideHost["serve"]>[1], failure: object][] = [
      [404, { kind: "provider-error", status: 404 }],
      ["<!doctype html><title>Sign in</title>", { kind: "guide", failure: { kind: "not-xmltv" } }],
      [
        tv(slot("aac.test", "Cut")).slice(0, -9),
        { kind: "guide", failure: { kind: "incomplete" } },
      ],
      [
        gzipSync(tv(slot("aac.test", "Cut"))).subarray(0, 40),
        { kind: "guide", failure: { kind: "incomplete" } },
      ],
      // Programmes that read well, in a document that never opens or never closes as one.
      [`${slot("aac.test", "No start")}</tv>`, { kind: "guide", failure: { kind: "not-xmltv" } }],
      [
        tv(slot("aac.test", "No end")).replace(/<\/tv>$/, "</tvirus>"),
        { kind: "guide", failure: { kind: "incomplete" } },
      ],
      [
        tv(slot("aac.test", "No end")).replace(/<\/tv>$/, "<!-- </tv> -->"),
        { kind: "guide", failure: { kind: "incomplete" } },
      ],
      [tv(named("aac.test", "AAC")), { kind: "guide", failure: { kind: "empty" } }],
      [tv(ended), { kind: "guide", failure: { kind: "ended" } }],
      [
        tv(slot("aac.test", "t".repeat(GUIDE_LIMITS.elementBytes))),
        { kind: "guide", failure: { kind: "too-large", limit: "element" } },
      ],
      [
        tv(
          ...Array.from({ length: GUIDE_LIMITS.channels + 1 }, (_, n) => `<channel id="c${n}"/>`),
          slot("aac.test", "Many"),
        ),
        { kind: "guide", failure: { kind: "too-large", limit: "channels" } },
      ],
    ];
    const refused = async () => {
      for (const [answer, failure] of refusals) {
        host.serve("/bad.xml", answer);
        const told = await failureOf(run(guide.check(id, host.address("/bad.xml"))));
        expect(told).toEqual(failure);
        expect(JSON.stringify(told)).not.toContain(GUIDE_KEY);
      }
    };

    // A first address that can't be used leaves the provider's guide.
    await refused();
    expect(await nowOn(first)).toBe("Provider");
    expect(await status(id)).toMatchObject({ source: { kind: "own" }, failure: null });
    expect(await guideFiles(dataDir)).toEqual(["guide.json", "guide.xml"]);

    // And one in place of an address in use leaves that address, with what it downloaded.
    await attach(id, host.address());
    const kept = await guideFiles(dataDir);
    await refused();
    expect(await failureOf(run(guide.check(id, "ftp://guide.example.org/x")))).toEqual({
      kind: "guide",
      failure: { kind: "address" },
    });
    expect(await nowOn(first)).toBe("External");
    expect(await status(id)).toMatchObject({
      source: { kind: "external", origin: host.origin },
      failure: null,
    });
    expect(await guideFiles(dataDir)).toEqual(kept);
  });

  it("gives a playlist that names no guide one, and says it has none again once it goes back", async () => {
    const playlist = await startFakePlaylist();
    closing.push(playlist);
    const host = await guideHost();
    const { id: guideId } = PLAYLIST_CHANNELS.tracks;
    host.serve("/guide.xml", tv(named(guideId, "Tracks"), slot(guideId, "Test card")));
    const dataDir = await tempDir();
    const { run, guide, subscriptions, nowOn, status, attach } = await app(dataDir);
    const { id } = await run(
      subscriptions.add({ server: playlist.link, username: "", password: "" }),
    );
    const channel = { subscriptionId: id, id: guideId };
    await run(guide.refresh(id));
    expect(await status(id)).toMatchObject({ source: { kind: "own" }, availability: "none" });

    await attach(id, host.address());

    expect(await nowOn(channel)).toBe("Test card");
    expect(await status(id)).toMatchObject({
      source: { kind: "external", origin: host.origin },
      channels: 1,
      availability: "available",
    });
    expect(await (await app(dataDir)).nowOn(channel)).toBe("Test card");

    expect(await run(guide.restore(id))).toMatchObject({
      source: { kind: "own" },
      availability: "none",
      channels: 0,
      failure: null,
    });
    expect(await nowOn(channel)).toBeUndefined();
  });
});

describe("the guides of two subscriptions that use the same ids", () => {
  it("gives one a guide of its own and leaves the other's, in listings, schedules and searches", async () => {
    const [first, second] = [await fakeProvider(), await fakeProvider({ channels: 200 })];
    first.serveGuide(tv(slot("aac.test", "Journaal")));
    second.serveGuide(tv(slot("aac.test", "Journal")));
    const host = await guideHost();
    host.serve("/guide.xml", tv(slot("aac.test", "Elsewhere")));
    const dataDir = await tempDir();
    const { run, guide, roster, subscriptions, attach, status } = await app(dataDir);
    const a = (await run(subscriptions.add(login(first)))).id;
    const b = (await run(subscriptions.add(login(second)))).id;
    const channel = (subscriptionId: string) => ({ subscriptionId, id: "1000" });
    await run(guide.refresh(a));
    await run(guide.refresh(b));

    await attach(b, host.address());

    const shows = async (asked: typeof guide) => {
      const listings = await run(asked.listings([channel(a), channel(b)]));
      return [channel(a), channel(b)].map((each) => listings[ownedKey(each)]?.now?.title);
    };
    expect(await shows(guide)).toEqual(["Journaal", "Elsewhere"]);
    expect(await run(guide.schedule(channel(b)))).toMatchObject([{ title: "Elsewhere" }]);
    expect(await run(guide.search("else"))).toMatchObject([{ channel: channel(b) }]);
    expect(await run(guide.search("journal"))).toEqual([]);
    expect(await run(guide.search("journaal"))).toMatchObject([{ channel: channel(a) }]);
    expect(await run(guide.searchChannels("e", [channel(a), channel(b)], at("23:00")))).toEqual({
      [ownedKey(channel(b))]: { now: true, later: null },
    });
    expect(await status(a)).toMatchObject({ source: { kind: "own" }, channels: 1 });
    expect(await status(b)).toMatchObject({ source: { kind: "external" }, channels: 1 });
    // Each keeps its own in its own folder, and reads it from there after a restart.
    expect(await guideFiles(dataDir)).toEqual(["guide.json", "guide.xml"]);
    expect(await guideFiles(join(dataDir, "subscriptions", b))).toHaveLength(4);
    expect(await shows((await app(dataDir)).guide)).toEqual(["Journaal", "Elsewhere"]);

    await run(roster.remove(b, false));

    expect(await shows(guide)).toEqual(["Journaal", undefined]);
    expect(await status(a)).toMatchObject({ source: { kind: "own" }, channels: 1 });
  });
});

describe("channels mapped to a guide's by hand", () => {
  /** The provider's guide with a channel no catalogue channel names: "spare.test". */
  const guideWith = (...more: string[]) =>
    tv(
      named("aac.test", "AAC One"),
      named("spare.test", "Spare Channel"),
      named("quiet.test", "Quiet"),
      slot("aac.test", "Own"),
      slot("spare.test", "Spare"),
      ...more,
    );

  async function mapping() {
    const base = await connected();
    const { run, guide, provider, id, channel } = base;
    provider.serveGuide(guideWith());
    await run(guide.refresh(id));
    const loose = unguided(provider);
    /** The first page of the channels a filter and a search find. */
    const list = (filter: "without" | "mapped" | "all", query = "") =>
      run(guide.mapChannels({ subscriptionId: id, filter, query, offset: 0, limit: 200 }));
    const { revision } = await list("all");
    return { ...base, loose: channel(loose), list, revision };
  }

  it("lists the guide's channels by name and id, and a subscription's channels by how they get programmes", async () => {
    const { run, guide, id, list, loose, first } = await mapping();
    const options = (query: string, offset = 0, limit = 200) =>
      run(guide.mapOptions({ subscriptionId: id, query, offset, limit }));

    // Names and ids, and whether there is anything on: no programme comes along.
    expect(await options("")).toEqual({
      total: 3,
      channels: [
        { id: "aac.test", name: "AAC One", programmes: true },
        { id: "quiet.test", name: "Quiet", programmes: false },
        { id: "spare.test", name: "Spare Channel", programmes: true },
      ],
    });
    expect((await options("spare")).channels.map((each) => each.id)).toEqual(["spare.test"]);
    // By its id too, and a page at a time.
    expect((await options("QUIET.test")).channels.map((each) => each.id)).toEqual(["quiet.test"]);
    expect(await options("", 1, 1)).toMatchObject({ total: 3, channels: [{ id: "quiet.test" }] });

    const all = await list("all");
    const without = await list("without");
    expect(all.total).toBe((await run(guide.status))[0]?.listed);
    expect(without.total).toBe(all.total - 1);
    expect(all.channels.find((each) => each.id === first.id)).toMatchObject({
      guideId: "aac.test",
      mappedTo: null,
      listed: true,
    });
    expect(without.channels.some((each) => each.id === first.id)).toBe(false);
    expect(without.channels.find((each) => each.id === loose.id)).toMatchObject({
      guideId: null,
      mappedTo: null,
    });
    expect((await list("mapped")).total).toBe(0);
    const title = all.channels.find((each) => each.id === loose.id)?.title ?? "";
    expect((await list("without", title)).channels.some((each) => each.id === loose.id)).toBe(true);
    expect((await list("without", "no channel is called this")).total).toBe(0);
  });

  it("shows a mapped channel its guide channel everywhere at once, and its own again once restored", async () => {
    const { run, guide, id, list, revision, loose, first, nowOn, status } = await mapping();
    const covered = (await status(id)).channels;

    const mapped = await run(guide.map(id, loose.id, "spare.test", revision));

    expect(mapped).toMatchObject({ id: loose.id, guideId: "spare.test", mappedTo: "spare.test" });
    expect(await nowOn(loose)).toBe("Spare");
    expect(await run(guide.schedule(loose))).toMatchObject([{ title: "Spare" }]);
    expect(await run(guide.search("spare"))).toMatchObject([{ channel: loose }]);
    expect(await run(guide.searchChannels("spare", [loose, first], at("23:00")))).toEqual({
      [ownedKey(loose)]: { now: true, later: null },
    });
    expect(await status(id)).toMatchObject({ channels: covered + 1, mapped: 1, unresolved: 0 });
    expect((await list("mapped")).channels).toMatchObject([{ id: loose.id }]);

    // A mapping counts alone: the channel leaves the guide channel its own id names.
    await run(guide.map(id, first.id, "spare.test", revision));
    expect(await nowOn(first)).toBe("Spare");
    expect(await run(guide.search("own"))).toEqual([]);
    expect((await run(guide.search("spare"))).map((match) => match.channel.id)).toEqual([first.id]);
    expect(await run(guide.searchChannels("spare", [loose, first], at("23:00")))).toEqual({
      [ownedKey(loose)]: { now: true, later: null },
      [ownedKey(first)]: { now: true, later: null },
    });

    expect(await run(guide.map(id, first.id, null, revision))).toMatchObject({
      guideId: "aac.test",
      mappedTo: null,
    });
    expect(await nowOn(first)).toBe("Own");
    expect(await run(guide.search("own"))).toMatchObject([{ channel: first }]);
    expect(await status(id)).toMatchObject({ channels: covered + 1, mapped: 1 });
  });

  it("maps only to a channel the guide lists, for a channel the provider lists, from the guide as it is", async () => {
    const { run, guide, id, revision, loose, nowOn, status } = await mapping();
    const map = (channelId: string, guideId: string, from = revision) =>
      failureOf(run(guide.map(id, channelId, guideId, from)));

    // Never by a name, nor by an id that only looks alike.
    expect(await map(loose.id, "Spare Channel")).toEqual(changed);
    expect(await map(loose.id, "SPARE.TEST")).toEqual(changed);
    expect(await map("no-such-channel", "spare.test")).toMatchObject({ kind: "channel-not-found" });
    expect(await map(loose.id, "spare.test", "another-guide")).toEqual(changed);
    expect(await failureOf(run(guide.map("gone", loose.id, "spare.test", revision)))).toEqual({
      kind: "no-subscription",
    });
    expect(await nowOn(loose)).toBeUndefined();
    expect(await status(id)).toMatchObject({ mapped: 0 });
  });

  it("keeps mappings through a restart and a new channel list, and leaves one unresolved rather than point it elsewhere", async () => {
    const { run, guide, library, provider, dataDir, id, list, revision, loose, nowOn, status } =
      await mapping();
    await run(guide.map(id, loose.id, "spare.test", revision));

    const restarted = await app(dataDir);
    expect(await restarted.nowOn(loose)).toBe("Spare");
    provider.serveChannels((all) => all.toReversed());
    await restarted.run(restarted.library.refresh(id));
    expect(await restarted.nowOn(loose)).toBe("Spare");
    expect(await restarted.status(id)).toMatchObject({ mapped: 1, unresolved: 0 });

    // The guide stops listing the channel it was mapped to: no programmes, and none of another's.
    provider.serveGuide(tv(named("aac.test", "AAC One"), slot("aac.test", "Own")));
    await run(guide.refresh(id));
    expect(await nowOn(loose)).toBeUndefined();
    expect(await status(id)).toMatchObject({ mapped: 1, unresolved: 1 });
    expect((await list("without")).channels.find((each) => each.id === loose.id)).toMatchObject({
      guideId: null,
      mappedTo: "spare.test",
    });
    // It shows again as soon as the guide lists it again.
    provider.serveGuide(guideWith());
    await run(guide.refresh(id));
    expect(await nowOn(loose)).toBe("Spare");

    // The provider stops listing the channel: its mapping is all that is left, to take away.
    const title = (await list("mapped")).channels[0]?.title;
    provider.serveChannels((all) => all.filter((each) => String(each.streamId) !== loose.id));
    await run(library.refresh(id));
    expect(await status(id)).toMatchObject({ mapped: 1, unresolved: 1 });
    expect((await list("mapped")).channels).toEqual([
      { id: loose.id, number: null, title, guideId: null, mappedTo: "spare.test", listed: false },
    ]);
    const { revision: now } = await list("mapped");
    expect(await run(guide.map(id, loose.id, null, now))).toBeNull();
    expect(await status(id)).toMatchObject({ mapped: 0, unresolved: 0 });
    expect(await guideFiles(dataDir)).toEqual(["guide.json", "guide.xml"]);
  });

  it("starts without them on another guide, keeps them for the same address, and drops them on the way back", async () => {
    const { run, guide, host, id, list, loose, nowOn, status, attach } = await mapping();
    host.serve("/guide.xml", guideWith());
    host.serve("/other.xml", guideWith());
    const mapLoose = async () =>
      run(guide.map(id, loose.id, "spare.test", (await list("all")).revision));
    await mapLoose();

    // Made against the provider's guide: the address starts on its channels' own ids.
    await attach(id, host.address());
    expect(await status(id)).toMatchObject({ mapped: 0 });
    expect(await nowOn(loose)).toBeUndefined();

    await mapLoose();
    // The same address entered again, however it is typed, is the same guide.
    const again = await run(
      guide.check(id, `${host.address().toUpperCase().slice(0, 4)}${host.address().slice(4)}#x`),
    );
    expect(again.sameSource).toBe(true);
    await run(guide.use(id, again.id));
    expect(await nowOn(loose)).toBe("Spare");
    // Checked again with nothing typed, it is the address in use.
    const kept = await run(guide.check(id, ""));
    expect(kept.sameSource).toBe(true);
    await run(guide.use(id, kept.id));
    expect(await status(id)).toMatchObject({ mapped: 1 });

    await attach(id, host.address("/other.xml"));
    expect(await status(id)).toMatchObject({ mapped: 0 });
    await mapLoose();
    await run(guide.restore(id));
    expect(await status(id)).toMatchObject({ source: { kind: "own" }, mapped: 0 });
    expect(await nowOn(loose)).toBeUndefined();
  });
});

describe("work that finishes after what it was for changed", () => {
  it("switches to a check only while it is the latest and the login is the one it began under", async () => {
    const { run, guide, subscriptions, provider, host, id, first, nowOn, status } =
      await connected();
    const check = () => run(guide.check(id, host.address()));
    const use = (candidate: string) => failureOf(run(guide.use(id, candidate)));

    const before = await check();
    // The password entered again: the subscription is the same, the login it stands on is not.
    await run(subscriptions.add(login(provider)));
    expect(await use(before.id)).toEqual(changed);

    const earlier = await check();
    const latest = await check();
    expect(await use(earlier.id)).toEqual(changed);
    expect(await use("no-such-check")).toEqual(changed);
    expect(await nowOn(first)).toBe("Provider");
    expect(await status(id)).toMatchObject({ source: { kind: "own" } });

    // A new name changes nothing of its login: the check still counts.
    await run(subscriptions.update(id, { name: "Holiday house" }));
    expect(await use(latest.id)).toBeNull();
    expect(await nowOn(first)).toBe("External");
    // Once used, it can't be used again.
    expect(await use(latest.id)).toEqual(changed);
  });

  it("stops a check that is called off or overtaken, and leaves nothing of it", async () => {
    const { run, guide, host, dataDir, id, first, nowOn } = await connected();
    const held = host.hold();
    const cancelled = failureOf(run(guide.check(id, host.address())));
    await held.arrived;

    await run(guide.cancelCheck(id));

    expect(await cancelled).toEqual({ kind: "guide", failure: { kind: "cancelled" } });
    // A later check takes the place of one still running.
    const overtaken = failureOf(run(guide.check(id, host.address())));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const latest = run(guide.check(id, host.address()));
    expect(await overtaken).toEqual({ kind: "guide", failure: { kind: "cancelled" } });
    held.release();
    const found = await latest;
    // What a check found waits in one file, until it is used or dropped.
    expect(await guideFiles(dataDir)).toHaveLength(3);

    await run(guide.cancelCheck(id));

    expect(await failureOf(run(guide.use(id, found.id)))).toEqual(changed);
    expect(await guideFiles(dataDir)).toEqual(["guide.json", "guide.xml"]);
    expect(await nowOn(first)).toBe("Provider");
  });

  it("drops a download that ends after the guide went back to the provider's", async () => {
    const { run, guide, host, dataDir, id, first, nowOn, status, attach } = await connected();
    await attach(id, host.address());
    host.serve("/guide.xml", tv(slot("aac.test", "Late")));
    const held = host.hold();
    const late = failureOf(run(guide.refresh(id)));
    await held.arrived;

    await run(guide.restore(id));
    held.release();

    expect(await late).toEqual(changed);
    expect(await nowOn(first)).toBe("Provider");
    expect(await status(id)).toMatchObject({ source: { kind: "own" }, failure: null });
    expect(await guideFiles(dataDir)).toEqual(["guide.json", "guide.xml"]);
  });

  it("keeps nothing for a subscription that went, whatever of it was still under way", async () => {
    const [first, second] = [await fakeProvider(), await fakeProvider({ channels: 200 })];
    second.serveGuide(tv(named("aac.test", "AAC"), slot("aac.test", "Journal")));
    const host = await guideHost();
    host.serve("/guide.xml", tv(named("aac.test", "AAC"), slot("aac.test", "Elsewhere")));
    const dataDir = await tempDir();
    const { run, guide, roster, subscriptions, attach } = await app(dataDir);
    const a = (await run(subscriptions.add(login(first)))).id;
    const b = (await run(subscriptions.add(login(second)))).id;
    const folder = join(dataDir, "subscriptions", b);
    for (const id of [a, b]) await attach(id, host.address());
    const page = (id: string) =>
      run(guide.mapChannels({ subscriptionId: id, filter: "all", query: "", offset: 0, limit: 1 }));
    const revisions = { a: (await page(a)).revision, b: (await page(b)).revision };

    // Each has a download under way, and a mapping asked for just as it is removed.
    const held = host.hold();
    const downloads = [a, b].map((id) => failureOf(run(guide.refresh(id))));
    await held.arrived;
    const mappings = [
      failureOf(run(guide.map(a, "1000", "aac.test", revisions.a))),
      failureOf(run(guide.map(b, "1000", "aac.test", revisions.b))),
    ];
    await Promise.all([run(roster.remove(b, false)), run(roster.remove(a, false))]);
    // The host answers only now, to subscriptions that are gone.
    held.release();
    await Promise.all(mappings);
    // Whatever was still being written has had its turn by now.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await Promise.all(downloads)).toEqual([changed, changed]);
    expect(await stat(folder).catch(() => null)).toBeNull();
    expect(await guideFiles(dataDir)).toEqual([]);
    // A start afterwards finds nothing to bring back.
    const restarted = await app(dataDir);
    expect(await restarted.run(restarted.guide.status)).toEqual([]);
    expect(await stat(folder).catch(() => null)).toBeNull();
    expect(await guideFiles(dataDir)).toEqual([]);
  });
});

describe("a mapping whose channels or guide changed under it", () => {
  const ID = "held";
  /** Channels that name no guide channel themselves, by their ids. */
  function listing(...ids: string[]): CatalogueChannels {
    const all = ids.map((id): LiveChannel => ({
      subscriptionId: ID,
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
      channelsOf: () => [],
    };
  }

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
   * own guide are what the test last gave it, the guide `elsewhere` at any address, and a write
   * to the store and a read of the channels that each wait when told to.
   */
  async function held(given: {
    channels: CatalogueChannels;
    document: string;
    elsewhere?: string;
  }) {
    const dir = await tempDir();
    const writes = gate();
    const lists = gate();
    const store = Layer.effect(
      GuideStore,
      Effect.map(GuideStore, (kept) => ({
        ...kept,
        setConfig: (...write: Parameters<typeof kept.setConfig>) =>
          Effect.andThen(writes.pass, kept.setConfig(...write)),
      })),
    ).pipe(Layer.provide(guideStoreLayer));
    const ports = Layer.mergeAll(
      store,
      Layer.succeed(GuideSource, {
        saved: Effect.sync(() => [
          {
            id: ID,
            revision: 1,
            key: "account",
            store: dir,
            download: async () => ({
              kind: "document" as const,
              body: new Blob([given.document]).stream(),
            }),
          },
        ]),
      }),
      Layer.succeed(GuideCatalogue, {
        channels: () =>
          Effect.andThen(
            lists.pass,
            Effect.sync(() => given.channels),
          ),
      }),
      Layer.succeed(GuideAddresses, {
        seal: (address) => Effect.succeed(address),
        open: (sealed) => Effect.succeed(sealed),
        fetch: async () => new Blob([given.elsewhere ?? ""]).stream(),
      }),
    );
    const runtime = runtimeFor(Guide.layer.pipe(Layer.provide(ports), Layer.provideMerge(clock())));
    const guide = await runtime.runPromise(Guide);
    return {
      dir,
      guide,
      run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
      holdWrite: writes.hold,
      holdChannels: lists.hold,
    };
  }

  it("is made against the channels and the guide as they are when its turn at the files comes", async () => {
    const guides = (...ids: string[]) =>
      tv(...ids.map((id) => named(id, id)), ...ids.map((id) => slot(id, id)));
    const given = { channels: listing("1", "2", "3"), document: guides("a.test", "b.test") };
    const { dir, guide, run, holdWrite } = await held(given);
    await run(guide.refresh(ID));
    const page = { subscriptionId: ID, query: "", offset: 0, limit: 10 };
    const { revision } = await run(guide.mapChannels({ ...page, filter: "all" }));

    // One mapping is being written, and two more wait behind it.
    const writing = holdWrite();
    const first = run(guide.map(ID, "1", "a.test", revision));
    await writing.arrived;
    const second = failureOf(run(guide.map(ID, "2", "a.test", revision)));
    const third = failureOf(run(guide.map(ID, "3", "b.test", revision)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Meanwhile the provider stops listing a channel, and the guide a guide channel.
    given.channels = listing("1", "3");
    given.document = guides("a.test");
    await run(guide.refresh(ID));
    writing.release();

    expect(await first).toMatchObject({ id: "1", mappedTo: "a.test" });
    expect(await second).toEqual({ kind: "channel-not-found", channelId: "2" });
    expect(await third).toEqual(changed);
    // Neither was kept, in what shows or on disk.
    expect((await run(guide.status))[0]).toMatchObject({ mapped: 1, unresolved: 0 });
    expect((await run(guide.mapChannels({ ...page, filter: "mapped" }))).channels).toMatchObject([
      { id: "1", mappedTo: "a.test" },
    ]);
    expect(JSON.parse(await readFile(join(dir, "guide-source.json"), "utf8")).mappings).toEqual({
      "1": { guideId: "a.test", name: "Channel 1" },
    });
  });

  it("is refused when its list of channels was still being read as the guide became another's", async () => {
    // Both guides list a channel by the one id.
    const guides = (title: string) => tv(named("shared.test", title), slot("shared.test", title));
    const { dir, guide, run, holdChannels } = await held({
      channels: listing("1"),
      document: guides("Before"),
      elsewhere: guides("After"),
    });
    await run(guide.refresh(ID));
    const page = () =>
      run(
        guide.mapChannels({ subscriptionId: ID, filter: "all", query: "", offset: 0, limit: 10 }),
      );

    // A list has the guide and waits for the channels, while an address takes that guide's place.
    const reading = holdChannels();
    const late = page();
    await reading.arrived;
    await run(guide.use(ID, (await run(guide.check(ID, "https://guide.example/xmltv"))).id));
    reading.release();
    const { revision } = await late;

    expect(await failureOf(run(guide.map(ID, "1", "shared.test", revision)))).toEqual(changed);
    expect((await run(guide.status))[0]).toMatchObject({ source: { kind: "external" }, mapped: 0 });
    expect(JSON.parse(await readFile(join(dir, "guide-source.json"), "utf8")).mappings).toEqual({});
    // A list read since is the new guide's, and a choice from it counts.
    expect(await run(guide.map(ID, "1", "shared.test", (await page()).revision))).toMatchObject({
      id: "1",
      mappedTo: "shared.test",
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
          mappings: { "1": { guideId: "a", name: "One" } },
        }),
      ),
    );
    const draft = failureOf(runtime.runPromise(store.draft(place)));

    expect(await set).toMatchObject({ kind: "unexpected" });
    expect(await draft).toMatchObject({ kind: "unexpected" });
    expect(await stat(folder).catch(() => null)).toBeNull();
  });
});

describe("a guide address across starts", () => {
  /** A keychain that no longer opens the guide's address, and still opens the login. */
  const withoutGuide: Secrets = {
    seal: testSecrets.seal,
    open(sealed) {
      const plain = testSecrets.open(sealed);
      if (plain.includes(GUIDE_KEY)) throw new AppFailure({ kind: "keychain-refused" });
      return plain;
    },
  };

  it("keeps what it downloaded and what was set when the keychain no longer opens it, and asks for it again", async () => {
    const { run, guide, host, dataDir, id, first, attach } = await connected();
    host.serve(
      "/guide.xml",
      tv(
        named("aac.test", "AAC"),
        named("spare.test", "Spare"),
        slot("aac.test", "External"),
        slot("spare.test", "Spare"),
      ),
    );
    await attach(id, host.address());
    const page = await run(
      guide.mapChannels({ subscriptionId: id, filter: "without", query: "", offset: 0, limit: 1 }),
    );
    const loose = { subscriptionId: id, id: page.channels[0]?.id ?? "" };
    await run(guide.map(id, loose.id, "spare.test", page.revision));
    const set = await readFile(join(dataDir, "guide-source.json"), "utf8");
    const asked = host.requests().length;

    const locked = await app(dataDir, withoutGuide);

    expect(await locked.status(id)).toMatchObject({
      source: { kind: "external", origin: host.origin, locked: true },
      channels: 2,
      mapped: 1,
      fetchedAt: NOW,
    });
    expect(await locked.nowOn(first)).toBe("External");
    expect(await locked.nowOn(loose)).toBe("Spare");
    const failed = { kind: "guide", failure: { kind: "locked" } };
    expect(await failureOf(locked.run(locked.guide.refresh(id)))).toEqual(failed);
    expect(await failureOf(locked.run(locked.guide.check(id, "")))).toEqual(failed);
    await locked.run(locked.guide.refreshIfStale(id));
    // Nothing was asked of the host, and nothing set was written over or taken away.
    expect(host.requests()).toHaveLength(asked);
    expect(await readFile(join(dataDir, "guide-source.json"), "utf8")).toBe(set);

    // The address typed again is the same guide: its mappings stay.
    const again = await locked.run(locked.guide.check(id, host.address()));
    expect(again.sameSource).toBe(true);
    expect(await locked.run(locked.guide.use(id, again.id))).toMatchObject({
      source: { kind: "external", locked: false, since: NOW },
      mapped: 1,
    });
    expect(await locked.nowOn(loose)).toBe("Spare");
  });

  it("shows the provider's guide to a release from before, and its own again after it", async () => {
    const { host, dataDir, id, first, attach } = await connected();
    await attach(id, host.address());
    // A release that knows no other guide downloads the provider's, where it always kept it,
    // and leaves the files it doesn't know as they are.
    const meta: { key: string; fetchedAt: number } = JSON.parse(
      await readFile(join(dataDir, "guide.json"), "utf8"),
    );
    await writeFile(join(dataDir, "guide.xml"), tv(slot("aac.test", "From before")));
    await writeFile(join(dataDir, "guide.json"), JSON.stringify({ ...meta, fetchedAt: NOW }));

    const back = await app(dataDir);

    // Its own guide again, from its own document, and never the provider's under its name.
    expect(await back.nowOn(first)).toBe("External");
    expect(await back.status(id)).toMatchObject({
      source: { kind: "external", origin: host.origin },
    });
    // The provider's is what the older release left, read when it is asked for.
    await back.run(back.guide.restore(id));
    expect(await back.nowOn(first)).toBe("From before");
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

    const body = await fetch(ADDRESS);
    let text = "";
    for await (const piece of body) text += Buffer.from(piece).toString();

    expect(text).toBe("<tv></tv>");
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
      for await (const _piece of await fetch(address)) void _piece;
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
