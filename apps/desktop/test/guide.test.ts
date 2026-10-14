import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { Guide } from "@mrstreamer/core/guide/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it, vi } from "vitest";
import { mainLayer } from "../src/main/runtime.ts";
import { Library } from "../src/main/services/library.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import {
  fakeGuide,
  QUALITY_STREAM_IDS,
  type FakeChannel,
  type FakeProvider,
  type FakeProviderOptions,
} from "./fake-provider.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

// Each guide download is indexed in a worker thread started from source, which strips the types
// of what it imports anew: a few hundred milliseconds each on a busy machine.
vi.setConfig({ testTimeout: 20_000 });

const HOUR = 60 * 60 * 1000;
const QUARTER = HOUR / 4;
/** 20:10 in the fake guide's +02:00. */
const NOW = Date.parse("2026-10-02T20:10:00+02:00");

/**
 * A connected library and guide on the fake provider. The guide runs on the app's runtime, with a
 * test clock the test moves; `create` starts another, as after a restart.
 *
 * Its lookups take and answer the provider's channel ids alone: `own` names one with the
 * connected subscription, as the guide itself is asked and answers (`ask`).
 */
/** The app's services on `dataDir`, with a test clock at NOW that the test moves. */
function started(dataDir: string) {
  // The clock reads NOW before the guide starts, so its checks count from there.
  const clock = Layer.effectDiscard(TestClock.setTime(NOW)).pipe(
    Layer.provideMerge(TestClock.layer({ warningDelay: "1 day" })),
  );
  return runtimeFor(mainLayer(testConfig(dataDir)).pipe(Layer.provideMerge(clock)));
}

const login = (provider: { readonly url: string }) => ({
  server: provider.url,
  username: "demo",
  password: "demo",
});

async function connectedGuide(options: FakeProviderOptions = {}) {
  const provider = await fakeProvider(options);
  provider.serveGuide(fakeGuide(provider.catalogue, NOW));
  const dataDir = await tempDir();
  let subscriptionId: string | null = null;
  const create = async () => {
    const runtime = started(dataDir);
    const subscriptions = await runtime.runPromise(Subscriptions);
    const connect = subscriptions.add(login(provider));
    const owner = (subscriptionId ??= (await runtime.runPromise(connect)).id);
    const guide = await runtime.runPromise(Guide);
    const roster = await runtime.runPromise(Roster);
    const library = await promised(runtime, Library);
    const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
    const own = (id: string) => ({ subscriptionId: owner, id });
    /** An answer per channel, by the provider's id alone. */
    const byId = <A>(answer: Record<string, A>) =>
      Object.fromEntries(
        Object.entries(answer).map(([key, value]) => [key.slice(owner.length + 1), value]),
      );
    return {
      own,
      /** The guide's own answer, by each channel's `ownedKey`. */
      ask: (channels: readonly OwnedId[]) => run(guide.listings(channels)),
      refresh: () => run(guide.refresh(owner)),
      refreshIfStale: () => run(guide.refreshIfStale(owner)),
      listings: async (channelIds: readonly string[]) =>
        byId(await run(guide.listings(channelIds.map(own)))),
      /** The channel's programmes over [from, until), as Live TV asks for a day. */
      day: (channelId: string, from: number, until: number) =>
        run(guide.schedule(own(channelId), from, until)),
      playback: await promised(runtime, Playback),
      schedule: (channelId: string) => run(guide.schedule(own(channelId), NOW, NOW + 24 * HOUR)),
      search: (query: string) => run(guide.search(query)),
      searchChannels: async (query: string, channelIds: readonly string[], until: number) =>
        byId(await run(guide.searchChannels(query, channelIds.map(own), until))),
      /** The connected subscription's guide, as Settings shows it. */
      status: async () => {
        const [{ subscriptionId: of, ...status } = { subscriptionId: null }] = await run(
          guide.status,
        );
        expect(of).toBe(owner);
        return status;
      },
      /** Removes the subscription, with what was loaded from it. */
      clear: () => run(roster.remove(owner, false)),
      /** Enters the login again, as the viewer does to repair it: the subscription stays the same. */
      reconnect: () => run(connect),
      library: { ...library, refresh: () => library.refresh(owner) },
      settings: await promised(runtime, Settings),
      /**
       * Moves the clock on a quarter of an hour at a time, letting each check the guide runs on
       * its own finish before the next.
       */
      advance: async (ms: number) => {
        for (let passed = 0; passed < ms; passed += QUARTER) {
          await run(TestClock.adjust(Math.min(QUARTER, ms - passed)));
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
    };
  };
  const guide = await create();
  return { provider, library: guide.library, create, guide, ...channelsOf(provider) };
}

/** A channel with a guide id and one without, as the library names them. */
function channelsOf(provider: FakeProvider) {
  const regular = provider.catalogue.channels.filter(
    (channel) => channel.streamId >= 2000 && !channel.offline,
  );
  const guided = regular.find((channel) => channel.guideId)!;
  const unguided = regular.find((channel) => !channel.guideId)!;
  return {
    guided: String(guided.streamId),
    guideId: guided.guideId!,
    unguided: String(unguided.streamId),
  };
}

const at = (time: string) => Date.parse(`2026-10-02T${time}:00+02:00`);

/** A programme on a guide channel that day, from "2000" to "2100". */
const programme = (id: string, from: string, to: string, title: string) =>
  `<programme start="20261002${from}00 +0200" stop="20261002${to}00 +0200" channel="${id}"><title>${title}</title></programme>`;

/** An hour's programme on a guide channel, on at NOW. */
const slot = (id: string, title: string) => programme(id, "2000", "2100", title);

describe("programme guide", () => {
  it("lists what aired since the start of the day, and plays one from the panel's archive for its window", async () => {
    const { provider, guide, guided } = await connectedGuide();
    await guide.refresh();
    const morning = new Date(NOW).setHours(0, 0, 0, 0);
    const midnight = new Date(NOW).setHours(24, 0, 0, 0);

    // The fake guide begins at 18:00: what aired since then comes first, then what is on now.
    const day = await guide.day(guided, morning, midnight);
    const aired = day.find((programme) => programme.stop <= NOW);
    expect(aired).toMatchObject({ start: at("18:00"), stop: at("18:30") });
    expect(day.find((programme) => programme.stop > NOW)).toMatchObject({ start: at("20:00") });

    // Played from the panel's archive: its window on the panel's clock, and nothing live.
    const session = await guide.playback.open(guide.own(guided), ["h264", "aac", "mp3", "opus"], {
      variants: [guided],
      archive: { start: aired!.start, end: aired!.stop },
    });
    await (await fetch(session.url)).arrayBuffer();
    expect(provider.archiveRequests()).toEqual([
      { streamId: guided, minutes: 30, start: "2026-10-02:18-00" },
    ]);
    expect(provider.streamRequests()).toBe(0);
  });

  it("answers for each channel by its subscription, and has nothing for another's", async () => {
    const { guide, guided } = await connectedGuide();
    await guide.refresh();
    const mine = guide.own(guided);
    // The same provider id, as another subscription could list a channel under it.
    const theirs = { subscriptionId: "another-subscription", id: guided };

    const listings = await guide.ask([theirs, mine]);

    expect(Object.keys(listings)).toEqual([ownedKey(mine)]);
    expect(listings[ownedKey(mine)]?.now).toMatchObject({ start: at("20:00") });
    expect(await guide.ask([theirs])).toEqual({});
  });

  it("shows what's on now and next, and the rest of the day, for channels with a guide", async () => {
    const { guide, guided, unguided } = await connectedGuide();
    await guide.refresh();

    const listings = await guide.listings([guided, unguided]);
    const schedule = await guide.schedule(guided);

    expect(Object.keys(listings)).toEqual([guided]);
    expect(listings[guided]?.now).toMatchObject({ start: at("20:00"), stop: at("20:30") });
    expect(listings[guided]?.now?.description).toMatch(/^Episode 4 of \w+ & friends\.$/);
    expect(listings[guided]?.next).toMatchObject({
      start: at("20:30"),
      title: expect.stringMatching(/ News 5$/),
    });
    expect(schedule[0]).toEqual(listings[guided]?.now);
    expect(schedule).toHaveLength(48);
    expect(await guide.schedule(unguided)).toEqual([]);
  });

  it("reads an untidy guide that arrives in small pieces", async () => {
    const { provider, guide, guided, guideId } = await connectedGuide();
    const programme = (attributes: string, body: string) =>
      `<programme ${attributes.replaceAll("ID", guideId)}>${body}</programme>`;
    provider.serveGuide(
      [
        '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE tv SYSTEM "xmltv.dtd"><tv>',
        `<channel id="${guideId}"><display-name>Messy</display-name></channel>`,
        programme(
          `start="20261002180000 +0200" stop="20261002190000 +0200" channel="ID"`,
          "<title>Earlier</title>",
        ),
        // Single quotes, attributes in another order, references, two titles.
        programme(
          `channel='ID' stop='20261002203000 +0200' start='20261002200000 +0200'`,
          '<title lang="nl">Het &#233;&#xE9;n</title><title lang="en">The one</title>',
        ),
        // No stop: runs until the next programme.
        programme(
          `start="20261002203000 +0200" channel="ID"`,
          "<title><![CDATA[Tom & Jerry <live>]]></title><desc>  Line one\n  line two </desc>",
        ),
        programme(
          `start="20261002190000 +0000" stop="20261002193000 +0000" channel="ID"`,
          "<title>Late &amp; loud</title>",
        ),
        // Starts before the previous one ends, which then ends early.
        programme(
          `start="20261002211500 +0200" stop="20261002220000 +0200" channel="ID"`,
          "<title>Overlap</title>",
        ),
        programme(`start="soon" stop="20261002230000 +0200" channel="ID"`, "<title>Broken</title>"),
        programme(
          `start="20261002230000 +0200" stop="20261002220000 +0200" channel="ID"`,
          "<title>Backwards</title>",
        ),
        programme(
          `start="20261002230000 +0200" stop="20261002233000 +0200" channel="ID"`,
          "<title/>",
        ),
        `<programme start="20261002230000 +0200" stop="20261002233000 +0200" channel="${guideId}"/>`,
        programme(
          `start="20261002200000 +0200" stop="20261002210000 +0200" channel="nobody.test"`,
          "<title>Unknown channel</title>",
        ),
        "</tv>",
      ].join("\n"),
      { pieceBytes: 7 },
    );

    await guide.refresh();

    expect(await guide.schedule(guided)).toEqual([
      { start: at("20:00"), stop: at("20:30"), title: "Het één", description: null },
      {
        start: at("20:30"),
        stop: at("21:00"),
        title: "Tom & Jerry <live>",
        description: "Line one line two",
      },
      { start: at("21:00"), stop: at("21:15"), title: "Late & loud", description: null },
      { start: at("21:15"), stop: at("22:00"), title: "Overlap", description: null },
    ]);
    expect((await guide.search("een")).map((match) => match.programme.title)).toEqual(["Het één"]);
  });

  it("says how many channels it covers, and since when, for Settings", async () => {
    const { guide } = await connectedGuide();
    const listed = (await guide.library.channels({})).length;
    expect(await guide.status()).toEqual({
      source: { kind: "own" },
      channels: 0,
      listed,
      guideChannels: 0,
      fetchedAt: null,
      availability: "unknown",
      mapped: 0,
      unresolved: 0,
      failure: null,
      failedAt: null,
      processing: { state: "empty" },
    });

    await guide.refresh();

    const ids = (await guide.library.channels({})).map((channel) => channel.id);
    const shown = Object.keys(await guide.listings(ids)).length;
    expect(shown).toBeGreaterThan(0);
    expect(await guide.status()).toMatchObject({
      source: { kind: "own" },
      channels: shown,
      listed,
      fetchedAt: NOW,
      availability: "available",
      failure: null,
    });
  });

  it("finds programmes by title, on now first, on the channel that shows them", async () => {
    const { guide, guided } = await connectedGuide();
    await guide.refresh();
    const word = (await guide.listings([guided]))[guided]?.now?.title.split(" ")[0] ?? "";

    const matches = await guide.search(`${word.toLowerCase()} news`);

    expect(matches.length).toBeGreaterThan(1);
    expect(matches.every((match) => match.programme.title.startsWith(`${word} News`))).toBe(true);
    const onNow = matches.filter((match) => match.programme.start <= NOW);
    expect(matches.slice(0, onNow.length)).toEqual(onNow);
    const later = matches.slice(onNow.length).map((match) => match.programme.start);
    expect(later).toEqual(later.toSorted((a, b) => a - b));
    expect(matches.some((match) => match.channel.id === guided)).toBe(true);
    expect(await guide.search("  ")).toEqual([]);
  });

  it("lists a channel for adults' programmes only while Settings shows it, where a search of its list finds them and a search of everything never does", async () => {
    const { guide } = await connectedGuide({ adultChannels: true });
    await guide.refresh();
    // "AFTER HOURS", for adults, with guide id afterhours.adult.
    const nowOn = async () => (await guide.listings(["4000"]))["4000"]?.now?.title;
    const inList = () => guide.searchChannels("news", ["4000"], at("23:00"));
    expect(await nowOn()).toBeUndefined();
    expect(await inList()).toEqual({});

    await guide.settings.update({ adultTitles: true });
    const title = (await nowOn()) ?? "";

    expect(title).not.toBe("");
    expect((await guide.search(title)).some((match) => match.channel.id === "4000")).toBe(false);
    expect(await inList()).toMatchObject({ "4000": { now: true } });
  });

  it("searches every channel of a list, where the search of everything stops at fifty programmes", async () => {
    const { guide } = await connectedGuide();
    await guide.refresh();
    // Every programme of the fake guide is some "News", so every channel with a guide matches.
    const all = (await guide.library.channels({})).map((channel) => channel.id);
    const covered = Object.keys(await guide.listings(all));
    const last = covered.at(-1) ?? "";

    const everything = await guide.search("news");
    const found = await guide.searchChannels("news", all, at("23:00"));

    expect(everything).toHaveLength(50);
    expect(everything.some((match) => match.channel.id === last)).toBe(false);
    expect(Object.keys(found).toSorted()).toEqual(covered.toSorted());
    expect(await guide.searchChannels("news", [last], at("23:00"))).toEqual({
      [last]: found[last],
    });
  });

  it("finds a channel by its programme on now and by its first later one before the day ends", async () => {
    const { provider, guide, guided, guideId } = await connectedGuide();
    provider.serveGuide(
      `<tv>${[
        programme(guideId, "2000", "2100", "Het Journaal"),
        programme(guideId, "2100", "2200", "Sport"),
        programme(guideId, "2200", "2230", "Het Journaal Laat"),
        programme(guideId, "2230", "2300", "Één Nacht"),
      ].join("")}</tv>`,
    );
    await guide.refresh();
    const search = async (query: string, until: string) =>
      (await guide.searchChannels(query, [guided], at(until)))[guided];

    expect(await search("journaal", "23:00")).toEqual({
      now: true,
      later: { start: at("22:00"), title: "Het Journaal Laat" },
    });
    // The day ends where the list says: a programme that starts then isn't today's.
    expect(await search("journaal", "22:00")).toEqual({ now: true, later: null });
    expect(await search("SPORT", "23:00")).toEqual({
      now: false,
      later: { start: at("21:00"), title: "Sport" },
    });
    // Every word, in any order, whatever the case and the accents.
    expect(await search("nacht EEN", "23:00")).toEqual({
      now: false,
      later: { start: at("22:30"), title: "Één Nacht" },
    });
    expect(await search("journaal nacht", "23:00")).toBeUndefined();
    expect(await search("  ", "23:00")).toBeUndefined();
  });

  it("finds each channel that shows a guide id, where the search of everything names the first", async () => {
    // Two channels of one name in different countries, which stay two channels, send one guide id.
    let sharing: ReadonlySet<string> = new Set();
    const { provider, guide } = await connectedGuide({
      guideIdOf: (channel) =>
        sharing.has(String(channel.streamId)) ? "shared.test" : channel.guideId,
    });
    const byTitle = Map.groupBy(await guide.library.channels({}), (channel) => channel.title);
    const pair = [...byTitle.values()].find((channels) => channels.length > 1)?.slice(0, 2) ?? [];
    const [first, second] = pair.map((channel) => channel.id);
    if (!first || !second) throw new Error("The fake catalogue has no two channels of one name.");
    sharing = new Set(pair.flatMap((channel) => channel.variants.map((variant) => variant.id)));
    await guide.library.refresh();
    provider.serveGuide(`<tv>${slot("shared.test", "Journaal")}</tv>`);
    await guide.refresh();

    expect(await guide.search("journaal")).toMatchObject([{ channel: { id: first } }]);
    expect(await guide.searchChannels("journaal", [second], at("23:00"))).toEqual({
      [second]: { now: true, later: null },
    });
    expect(
      Object.keys(await guide.searchChannels("journaal", [first, second], at("23:00"))),
    ).toEqual([first, second]);
  });

  it("keeps the guide across a restart without downloading it again", async () => {
    const { provider, guide, create, guided } = await connectedGuide();
    await guide.refresh();
    provider.serveGuide(500);

    const restarted = await create();
    await restarted.refreshIfStale();

    expect(provider.guideRequests()).toBe(1);
    expect(Object.keys(await restarted.listings([guided]))).toEqual([guided]);
  });

  it("downloads again after six hours, and keeps the guide when that fails", async () => {
    const { provider, guide, guided } = await connectedGuide();
    await guide.refresh();

    await guide.advance(5 * HOUR);
    await guide.refreshIfStale();
    expect(provider.guideRequests()).toBe(1);

    provider.serveGuide(502);
    await guide.advance(HOUR);
    await expect(guide.refreshIfStale()).rejects.toMatchObject({
      error: { kind: "provider-error", status: 502 },
    });
    provider.serveGuide('<?xml version="1.0"?><tv></tv>');
    await expect(guide.refreshIfStale()).rejects.toMatchObject({
      error: { kind: "guide", failure: { kind: "empty" } },
    });

    expect((await guide.listings([guided]))[guided]?.now?.start).toBe(at("02:00") + 24 * HOUR);
    // Settings says why the latest download failed, since the first one that did, and from when
    // the guide in use is.
    expect(await guide.status()).toMatchObject({
      fetchedAt: NOW,
      failure: { kind: "guide", failure: { kind: "empty" } },
      failedAt: NOW + 6 * HOUR,
    });
  });

  it("checks on its own and downloads once the guide is six hours old", async () => {
    const { provider, guide } = await connectedGuide();
    await guide.refresh();

    await guide.advance(6 * HOUR - QUARTER);
    expect(provider.guideRequests()).toBe(1);
    await guide.advance(QUARTER);

    await vi.waitFor(() => expect(provider.guideRequests()).toBe(2));
  });

  it("answers without listings while the first download is still running", async () => {
    const { provider, guide, library, guided } = await connectedGuide();
    provider.serveGuide("hold");

    const download = guide.refresh().catch(() => {});

    expect(await guide.listings([guided])).toEqual({});
    expect(await guide.searchChannels("news", [guided], at("23:00"))).toEqual({});
    expect(await library.channel(guide.own(guided))).toMatchObject({ id: guided });
    await provider.close();
    await download;
  });

  it("stops a download when the subscription goes, and keeps nothing from it", async () => {
    const { provider, guide, create, guided } = await connectedGuide();
    provider.serveGuide(fakeGuide(provider.catalogue, NOW), { pieceBytes: 64 });
    const download = guide.refresh().then(
      () => "finished",
      () => "stopped",
    );
    await vi.waitFor(() => expect(provider.guideRequests()).toBe(1));

    await guide.clear();

    expect(await download).toBe("stopped");
    expect(await guide.listings([guided])).toEqual({});
    expect(await (await create()).listings([guided])).toEqual({});
  });

  it("keeps the guide it has, also after a restart, when a download begun before the login was entered again finishes", async () => {
    const { provider, guide, create, guided, guideId } = await connectedGuide();
    provider.serveGuide(`<tv>${slot(guideId, "Before")}</tv>`);
    await guide.refresh();
    provider.serveGuide(`<tv>${slot(guideId, "Late")}</tv>`);
    const held = provider.hold("guide");
    const download = guide.refresh();
    await held.arrived;

    const again = await guide.reconnect();
    held.release();
    await download;

    expect(guide.own(guided)).toMatchObject({ subscriptionId: again.id });
    const nowOn = async ({ listings }: typeof guide) => (await listings([guided]))[guided]?.now;
    expect(await nowOn(guide)).toMatchObject({ title: "Before" });
    expect(await nowOn(await create())).toMatchObject({ title: "Before" });
  });

  it("shows a guide id only on the channels it names", async () => {
    // Panels file unrelated channels under one guide id. Here two variants of one channel and an
    // unrelated channel send the variants' id, and three unrelated channels send an id none of them
    // is: only the variants get programmes.
    let files = new Map<number, string>();
    const { provider, guide } = await connectedGuide({
      guideIdOf: (channel) => files.get(channel.streamId) ?? null,
    });
    const regular = provider.catalogue.channels.filter(
      (channel) => channel.streamId >= 2000 && !channel.offline,
    );
    const base = (channel: FakeChannel) =>
      channel.name.replace(/^[A-Z]{2}(: | \| )/, "").replace(/ (HD|FHD|4K|SD)$/, "");
    const variants = regular.filter((channel, _, all) =>
      all.some((other) => other !== channel && base(other) === base(channel)),
    );
    const [first] = variants;
    if (!first) throw new Error("The fake catalogue has no variants of one channel.");
    const same = variants.filter((channel) => base(channel) === base(first));
    const others = regular.filter((channel) => !base(channel).includes(base(first).split(" ")[0]!));
    const [stranger, ...crime] = others.slice(0, 4);
    const named = `${base(first).replaceAll(" ", "")}.be`;
    files = new Map([
      ...same.map((channel): [number, string] => [channel.streamId, named]),
      [stranger!.streamId, named],
      ...crime.map((channel): [number, string] => [channel.streamId, "PlayCrime.be"]),
    ]);
    provider.serveGuide(`<tv>${slot(named, "Theirs")}${slot("PlayCrime.be", "Crime")}</tv>`);
    await guide.refresh();

    const ids = [...same, stranger!, ...crime].map((channel) => String(channel.streamId));
    const listings = await guide.listings(ids);

    expect(Object.keys(listings).toSorted()).toEqual(
      same.map((channel) => String(channel.streamId)).toSorted(),
    );
  });

  it("shows one channel with its programmes when its streams spell its guide id differently", async () => {
    // A panel writes one channel's guide id as "kwaliteit1.be" on the Full HD stream and as
    // "kwaliteit1 BE" on the HD one, and its guide lists programmes under the first only.
    const fhd = String(QUALITY_STREAM_IDS);
    const hd = String(QUALITY_STREAM_IDS + 1);
    const { provider, guide, create } = await connectedGuide({
      guideIdOf: (channel) => (String(channel.streamId) === hd ? "kwaliteit1 BE" : channel.guideId),
    });
    provider.serveGuide(`<tv>${slot("kwaliteit1.be", "Journaal")}</tv>`);
    await guide.refresh();
    const shown = async ({ library, listings }: typeof guide) => {
      const channels = await library.channels({ query: "kwaliteit" });
      const now = await listings(channels.map((channel) => channel.id));
      return channels.map((channel) => [
        channel.id,
        channel.variants.map((variant) => variant.id).toSorted(),
        now[channel.id]?.now?.title,
      ]);
    };
    const one = (title: string) => [[fhd, [fhd, hd, String(QUALITY_STREAM_IDS + 2)], title]];

    expect(await shown(guide)).toEqual(one("Journaal"));

    // The provider lists the stream whose spelling the guide doesn't know first.
    provider.serveChannels((all) => all.toReversed());
    await guide.library.refresh();
    expect(await shown(guide)).toEqual(one("Journaal"));
    expect(await shown(await create())).toEqual(one("Journaal"));

    // A guide that knows both spellings shows, counts and finds the channel once.
    provider.serveGuide(
      `<tv>${slot("kwaliteit1 BE", "Nieuws")}${slot("kwaliteit1.be", "Nieuws")}</tv>`,
    );
    await guide.refresh();
    expect(await shown(guide)).toEqual(one("Nieuws"));
    expect(await guide.status()).toMatchObject({ channels: 1 });
    expect(await guide.search("nieuws")).toMatchObject([{ channel: { id: fhd } }]);
  });

  it("forgets the guide when the subscription goes", async () => {
    const { guide, create, guided } = await connectedGuide();
    await guide.refresh();

    await guide.clear();

    expect(await guide.listings([guided])).toEqual({});
    expect(await (await create()).listings([guided])).toEqual({});
  });
});

describe("the guides of several subscriptions", () => {
  /**
   * Two subscriptions whose providers number their channels alike and use the same guide ids, as
   * two panels of one kind do. Their first channel, "1000", is "aac.test" in both guides.
   */
  async function two() {
    const [first, second] = [await fakeProvider(), await fakeProvider({ channels: 200 })];
    const dataDir = await tempDir();
    const create = async () => {
      const runtime = started(dataDir);
      const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
      return {
        run,
        guide: await runtime.runPromise(Guide),
        roster: await runtime.runPromise(Roster),
        subscriptions: await runtime.runPromise(Subscriptions),
      };
    };
    const services = await create();
    const { run, subscriptions } = services;
    const a = (await run(subscriptions.add(login(first)))).id;
    const b = (await run(subscriptions.add(login(second)))).id;
    return { ...services, create, first, second, a, b };
  }
  const channel = (subscriptionId: string) => ({ subscriptionId, id: "1000" });

  it("shows each subscription's channels its own guide, though both use the same guide ids", async () => {
    const { run, guide, create, first, second, a, b } = await two();
    first.serveGuide(`<tv>${slot("aac.test", "Journaal")}</tv>`);
    second.serveGuide(`<tv>${slot("aac.test", "Journal")}</tv>`);

    await run(guide.refresh(a));
    // Until its own guide is in, the other's channel shows nothing of this one's.
    expect(await run(guide.listings([channel(a), channel(b)]))).toEqual({
      [ownedKey(channel(a))]: expect.objectContaining({ now: expect.anything() }),
    });
    await run(guide.refresh(b));

    const shows = async (asked: typeof guide) => {
      const listings = await run(asked.listings([channel(b), channel(a)]));
      return [channel(a), channel(b)].map((each) => listings[ownedKey(each)]?.now?.title);
    };
    expect(await shows(guide)).toEqual(["Journaal", "Journal"]);
    expect(await run(guide.schedule(channel(b), NOW, NOW + 24 * HOUR))).toMatchObject([
      { title: "Journal" },
    ]);
    expect(await run(guide.range([channel(a), channel(b)], at("19:00"), at("23:00")))).toEqual({
      [ownedKey(channel(a))]: [expect.objectContaining({ title: "Journaal" })],
      [ownedKey(channel(b))]: [expect.objectContaining({ title: "Journal" })],
    });
    expect(await run(guide.searchChannels("jour", [channel(a), channel(b)], at("23:00")))).toEqual({
      [ownedKey(channel(a))]: { now: true, later: null },
      [ownedKey(channel(b))]: { now: true, later: null },
    });
    // A search names each programme with the channel of the subscription that shows it.
    expect(await run(guide.search("jour"))).toMatchObject([
      { channel: channel(a), programme: { title: "Journaal" } },
      { channel: channel(b), programme: { title: "Journal" } },
    ]);
    expect(await run(guide.status)).toMatchObject([
      { subscriptionId: a, channels: 1, availability: "available" },
      { subscriptionId: b, channels: 1, availability: "available" },
    ]);
    // Each is kept in its own place, and read from there after a restart.
    expect(await shows((await create()).guide)).toEqual(["Journaal", "Journal"]);
  });

  it("cuts a search of every guide only once all of them are in", async () => {
    const { run, guide, first, second, a, b } = await two();
    // More later programmes in the first than a search returns, and one on now in the second.
    const guided = [...new Set(first.catalogue.channels.flatMap((each) => each.guideId ?? []))];
    expect(guided.length).toBeGreaterThan(60);
    first.serveGuide(
      `<tv>${guided
        .slice(0, 60)
        .map((id, index) => programme(id, "2100", "2200", `Late Show ${index}`))
        .join("")}</tv>`,
    );
    second.serveGuide(`<tv>${slot("aac.test", "Late Show tonight")}</tv>`);
    await run(guide.refresh(a));
    await run(guide.refresh(b));

    const found = await run(guide.search("late show"));

    expect(found).toHaveLength(50);
    expect(found[0]).toMatchObject({
      channel: channel(b),
      programme: { title: "Late Show tonight" },
    });
    expect(new Set(found.slice(1).map((each) => each.channel.subscriptionId))).toEqual(
      new Set([a]),
    );
  });

  it("keeps the others' guides when one can't be fetched, and when one subscription goes", async () => {
    const { run, guide, roster, create, first, second, a, b } = await two();
    first.serveGuide(`<tv>${slot("aac.test", "Journaal")}</tv>`);
    second.serveGuide(`<tv>${slot("aac.test", "Journal")}</tv>`);
    await run(guide.refresh(a));
    await run(guide.refresh(b));

    second.serveGuide(500);
    await expect(run(guide.refresh(b))).rejects.toBeDefined();

    const now = async (asked: typeof guide, of: string) =>
      (await run(asked.listings([channel(of)])))[ownedKey(channel(of))]?.now?.title;
    // The one that failed keeps the guide it had; the other never noticed.
    expect([await now(guide, a), await now(guide, b)]).toEqual(["Journaal", "Journal"]);

    await run(roster.remove(b, false));

    expect([await now(guide, a), await now(guide, b)]).toEqual(["Journaal", undefined]);
    expect(await run(guide.status)).toMatchObject([{ subscriptionId: a, channels: 1 }]);
    expect(await now((await create()).guide, a)).toBe("Journaal");
  });
});
