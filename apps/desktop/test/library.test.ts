import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { Library } from "../src/main/services/library.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { QUALITY_STREAM_IDS } from "./fake-provider.ts";
import {
  collect,
  fakeProvider,
  promised,
  runtimeFor,
  tempDir,
  testSecrets,
  userAgent,
} from "./support.ts";

/** The library, settings and subscriptions on `dataDir`, as a start of the app reads them. */
async function started(dataDir: string, fetchImpl?: typeof fetch) {
  const runtime = runtimeFor(
    Library.layer({ confirmDelay: 0 }).pipe(
      Layer.provideMerge(Settings.layer(dataDir)),
      Layer.provideMerge(
        Subscriptions.layer({
          dataDir,
          secrets: testSecrets,
          providerOptions: { userAgent, ...(fetchImpl ? { fetch: fetchImpl } : {}) },
        }),
      ),
    ),
  );
  const library = await promised(runtime, Library);
  return {
    library,
    settings: await promised(runtime, Settings),
    subscriptions: await promised(runtime, Subscriptions),
    updates: await collect(runtime, library.changes),
  };
}

const login = (provider: { readonly url: string }) => ({
  server: provider.url,
  username: "demo",
  password: "demo",
});

/**
 * A library on a connected fake provider, and the statuses it reports. `own` names a channel or
 * category of the connected subscription by the provider's id, and the library's calls about one
 * subscription are about that one. `restart` starts another on the same data folder.
 */
async function connectedLibrary(channels = 300, adultChannels = false) {
  const provider = await fakeProvider({ channels, adultChannels });
  const dataDir = await tempDir();
  const { library: all, settings, subscriptions, updates } = await started(dataDir);
  const { id: subscriptionId } = await subscriptions.add(login(provider));
  const own = (id: string) => ({ subscriptionId, id });
  const ofOwn = (library: typeof all) => ({
    ...library,
    refresh: () => library.refresh(subscriptionId),
    isStale: (maxAge: number) => library.isStale(subscriptionId, maxAge),
    status: async () => {
      const [status] = await library.status();
      if (!status) throw new Error("No subscription is saved");
      return status;
    },
  });
  const restart = async () => ofOwn((await started(dataDir)).library);
  return {
    provider,
    dataDir,
    library: ofOwn(all),
    settings,
    subscriptions,
    subscriptionId,
    updates,
    restart,
    own,
  };
}

describe("live library", () => {
  it("keeps duplicate category memberships, unknown references and raw selections through refresh and restart", async () => {
    const provider = await fakeProvider({ channels: 60 });
    let channels = [
      { stream_id: 10, name: "First", category_id: "001", category_ids: ["001", 2, "2"] },
      { stream_id: 11, name: "Second", category_id: 2 },
      { stream_id: 12, name: "Unknown", category_id: 99 },
      { stream_id: 13, name: "Unassigned" },
      { stream_id: 14, name: "Adult", category_ids: [2, 3] },
      { stream_id: 15, name: "Unnamed category", category_id: 9 },
    ];
    const dataDir = await tempDir();
    const services = await started(dataDir, async (input, init) => {
      const action = new URL(String(input)).searchParams.get("action");
      if (action === "get_live_categories")
        return Response.json([
          { category_id: "001", category_name: "News" },
          { category_id: 2, category_name: "News" },
          { category_id: 3, category_name: "XXX" },
          { category_id: 9, category_name: "" },
        ]);
      if (action === "get_live_streams") return Response.json(channels);
      return fetch(input, init);
    });
    const { id: subscriptionId } = await services.subscriptions.add(login(provider));
    const category = { subscriptionId, id: "001" };
    const ids = async (library: typeof services.library) =>
      (await library.channels({ category })).map((channel) => channel.id);
    expect(await ids(services.library)).toEqual(["10", "11"]);
    expect(await services.library.categories()).toMatchObject([
      {
        id: "001",
        title: "News",
        channelCount: 2,
        members: [category, { subscriptionId, id: "2" }],
      },
      { id: "9", title: "Category 9", channelCount: 1 },
    ]);
    expect((await services.library.channels({})).map((channel) => channel.id)).toEqual([
      "10",
      "11",
      "12",
      "13",
      "15",
    ]);
    await services.settings.update({ adultTitles: true });
    expect(await ids(services.library)).toEqual(["10", "11", "14"]);
    expect(await services.library.channels({ query: "Adult" })).toEqual([]);
    channels = channels.toReversed();
    await services.library.refresh(subscriptionId);
    expect(await ids(services.library)).toEqual(["10", "14", "11"]);
    expect((await services.library.channels({})).map((channel) => channel.id)).toEqual([
      "15",
      "14",
      "13",
      "12",
      "11",
      "10",
    ]);
    const restarted = (await started(dataDir)).library;
    expect(await ids(restarted)).toEqual(["10", "14", "11"]);
    expect(await restarted.channel({ subscriptionId, id: "12" })).toMatchObject({
      title: "Unknown",
      categoryIds: ["99"],
    });
  });

  it("loads categories and channels from the provider, without separator entries", async () => {
    const { provider, library, updates, own, subscriptionId } = await connectedLibrary();

    const categories = await library.categories();
    const all = await library.channels({});

    const separators = provider.catalogue.channels.filter((channel) =>
      channel.name.startsWith("#####"),
    );
    expect(separators.length).toBeGreaterThan(0);
    expect(all.flatMap((channel) => channel.variants)).toHaveLength(
      provider.catalogue.channels.length - separators.length,
    );
    expect(all.some((channel) => channel.name.startsWith("#####"))).toBe(false);
    expect(categories[0]).toEqual({
      ...own("1"),
      name: "TEST | Formats and failures",
      group: null,
      title: "TEST | Formats and failures",
      channelCount: 13,
      members: [own("1")],
    });
    expect(categories[1]).toMatchObject({ group: "United Kingdom", title: "Entertainment" });
    expect(updates).toContainEqual({
      subscriptionId,
      channelCount: all.length,
      fetchedAt: expect.any(Number),
      failure: null,
      failedAt: null,
    });
  });

  it("normalises the provider's loose fields", async () => {
    const { library, own } = await connectedLibrary(2000);

    const channels = await library.channels({ category: own("2") });

    // The mock sends every third channel number as a string and some logos as "".
    expect(channels.every((channel) => typeof channel.number === "number")).toBe(true);
    expect(channels.some((channel) => channel.logoUrl === null)).toBe(true);
    expect(
      channels
        .filter((channel) => channel.logoUrl)
        .every((channel) => channel.logoUrl?.startsWith("http")),
    ).toBe(true);
    expect(channels.every((channel) => channel.categoryIds.includes("2"))).toBe(true);
  });

  it("ranks names that start with the query first and ignores case and punctuation", async () => {
    const { library } = await connectedLibrary();

    const results = await library.channels({ query: "arena" });

    expect(results.every((channel) => channel.name.toLowerCase().includes("arena"))).toBe(true);
    const firstLater = results.findIndex(
      (channel) => !channel.name.toLowerCase().startsWith("arena"),
    );
    const lastStart = results.findLastIndex((channel) =>
      channel.name.toLowerCase().startsWith("arena"),
    );
    // The fake provider names some channels "ARENA…" and others "UK: ARENA…".
    expect(lastStart).toBeGreaterThanOrEqual(0);
    expect(firstLater).toBeGreaterThan(lastStart);

    expect(await library.channels({ query: "test h 264 ac 3" })).toMatchObject([
      { name: "TEST | H.264 + AC-3" },
      { name: "TEST | H.264 + AC-3 DVB" },
      { name: "TEST | H.264 + E-AC-3" },
    ]);
  });

  it("shows a channel's qualities as one channel, found by any of its streams' ids", async () => {
    const { library, own } = await connectedLibrary();
    const fhd = String(QUALITY_STREAM_IDS);
    const hd = String(QUALITY_STREAM_IDS + 1);
    const sd = String(QUALITY_STREAM_IDS + 2);

    const found = await library.channels({ query: "kwaliteit" });

    expect(found).toMatchObject([
      {
        ...own(fhd),
        title: "Kwaliteit 1",
        tags: [],
        variants: [
          { id: fhd, tags: ["FHD"], quality: "fhd" },
          { id: hd, tags: ["HD"], quality: "hd" },
          { id: sd, tags: ["SD"], quality: "sd" },
        ],
      },
    ]);
    const canonical = found.map(({ searchGroup: _group, ...channel }) => channel);
    const { searchIdentity, ...playbackChannel } = await library.channel(own(sd));
    expect(searchIdentity).toBeDefined();
    expect(playbackChannel).toEqual(canonical[0]);
    expect(await library.channels({ channels: [sd, hd, fhd].map(own) })).toEqual(canonical);
  });

  it("finds nothing by an id that names another subscription", async () => {
    const { library, own } = await connectedLibrary();
    const [channel] = await library.channels({ category: own("2") });
    if (!channel) throw new Error("Category 2 needs a channel");
    const elsewhere = (id: string) => ({ subscriptionId: "another-subscription", id });

    // The same provider ids, as another subscription's lists could hold them.
    await expect(library.channel(elsewhere(channel.id))).rejects.toMatchObject({
      error: { kind: "no-subscription" },
    });
    expect(await library.channels({ channels: [elsewhere(channel.id)] })).toEqual([]);
    expect(await library.channels({ category: elsewhere("2") })).toEqual([]);
    expect(await library.channels({ channels: [elsewhere(channel.id), channel] })).toEqual([
      channel,
    ]);
  });

  it("drops channels that arrive for a subscription that went meanwhile", async () => {
    const { provider, library, subscriptions, subscriptionId, own } = await connectedLibrary();
    const other = await fakeProvider({ channels: 40 });
    const held = provider.hold("channels");

    const first = library.refresh();
    first.catch(() => {});
    await held.arrived;
    await subscriptions.remove(subscriptionId);
    const replaced = await subscriptions.add(login(other));
    held.release();

    await expect(first).rejects.toMatchObject({ error: { kind: "unexpected" } });
    const channels = await library.channels({});
    expect(channels.length).toBeLessThan(300);
    expect(new Set(channels.map((channel) => channel.subscriptionId))).toEqual(
      new Set([replaced.id]),
    );
    // What named the subscription before names nothing now.
    await expect(library.channel(own(channels[0]?.id ?? ""))).rejects.toMatchObject({
      error: { kind: "no-subscription" },
    });
  });

  it("keeps its channels, and reports no failure, when a refresh begun before the login was entered again ends", async () => {
    const { provider, library, subscriptions, updates } = await connectedLibrary();
    await library.refresh();
    const before = await library.status();
    const told = updates.length;
    const held = provider.hold("channels");

    const late = library.refresh();
    late.catch(() => {});
    await held.arrived;
    await subscriptions.add(login(provider));
    held.release();

    await expect(late).rejects.toMatchObject({ error: { kind: "unexpected" } });
    expect(await library.status()).toEqual(before);
    expect(updates).toHaveLength(told);
  });

  it("serves the cached catalogue after a restart without the provider", async () => {
    const { provider, restart, library } = await connectedLibrary();
    const before = await library.channels({});
    await provider.close();

    const restarted = await restart();

    expect(await restarted.channels({})).toEqual(before);
    expect((await restarted.status()).channelCount).toBe(before.length);
  });

  it("keeps a catalogue saved before guide ids, and counts it as due for a refresh", async () => {
    const { provider, library, restart, dataDir } = await connectedLibrary();
    await library.refresh();
    const path = join(dataDir, "catalogue.json");
    const saved = JSON.parse(await readFile(path, "utf8"));
    // What a version without guide ids wrote: the same file, without the key.
    await writeFile(
      path,
      JSON.stringify(saved, (key, value) => (key === "guideId" ? undefined : value)),
    );
    provider.failCatalogue(500);

    const restarted = await restart();

    const loaded = await restarted.channels({});
    // Missing guide ids preserve ordinary channel/stream ownership, while search cannot trust
    // guide identities the old cache never stored.
    expect(
      loaded.map(({ searchIdentity: _identity, searchGroup: _group, ...channel }) => channel),
    ).toEqual(
      (await library.channels({})).map(
        ({ searchIdentity: _identity, searchGroup: _group, ...channel }) => channel,
      ),
    );
    const canonical = await Promise.all(loaded.map((channel) => restarted.channel(channel)));
    expect(canonical.every((channel) => channel.searchIdentity?.guideId == null)).toBe(true);
    expect(loaded.every((channel) => !Object.hasOwn(channel, "searchIdentity"))).toBe(true);
    expect(await restarted.isStale(60 * 60 * 1000)).toBe(true);
    expect(await library.isStale(60 * 60 * 1000)).toBe(false);
  });

  it("keeps the last catalogue when a refresh fails", async () => {
    const { provider, library, updates, subscriptionId } = await connectedLibrary();
    const before = await library.channels({});
    const { fetchedAt } = await library.status();

    provider.failCatalogue(503);
    await expect(library.refresh()).rejects.toMatchObject({
      error: { kind: "provider-error", status: 503 },
    });

    expect(await library.channels({})).toEqual(before);
    expect(await library.status()).toEqual({
      subscriptionId,
      channelCount: before.length,
      fetchedAt,
      failure: { kind: "provider-error", status: 503 },
      failedAt: expect.any(Number),
    });
    expect(updates.at(-1)).toEqual(await library.status());

    provider.failCatalogue(null);
    await library.refresh();
    expect(await library.status()).toMatchObject({ failure: null, failedAt: null });
  });

  it("does not let an empty channel list replace the catalogue", async () => {
    const { provider, library } = await connectedLibrary();
    const before = await library.channels({});

    provider.serveChannels(() => []);

    await expect(library.refresh()).rejects.toMatchObject({
      error: { kind: "incomplete-catalogue", received: 0 },
    });
    expect(await library.channels({})).toEqual(before);
  });

  it("keeps the catalogue when the confirming fetch comes back empty", async () => {
    const { provider, library, restart } = await connectedLibrary();
    const before = await library.channels({});
    let requests = 0;
    provider.serveChannels((all) => (++requests === 1 ? all.slice(0, 5) : []));

    await expect(library.refresh()).rejects.toMatchObject({
      error: { kind: "incomplete-catalogue", received: 5 },
    });

    expect(await library.channels({})).toEqual(before);
    expect((await library.status()).failure).toMatchObject({ kind: "incomplete-catalogue" });
    expect(await (await restart()).channels({})).toEqual(before);
  });

  it("uses a much shorter channel list only when a second fetch confirms it", async () => {
    const { provider, library } = await connectedLibrary();
    const before = await library.channels({});
    let requests = 0;
    // A glitch: one short answer, then the full list again.
    provider.serveChannels((all) => (++requests === 1 ? all.slice(0, 40) : all));

    await expect(library.refresh()).rejects.toMatchObject({
      error: { kind: "incomplete-catalogue", received: 40 },
    });
    expect(await library.channels({})).toEqual(before);

    // A real change: the panel keeps sending the short list.
    provider.serveChannels((all) => all.slice(0, 40));
    await library.refresh();
    expect((await library.channels({})).length).toBeLessThan(40);
  });

  it("keeps channels by provider id when names and order change", async () => {
    const { provider, library, own } = await connectedLibrary();
    const [first, second] = await library.channels({ category: own("2") });
    if (!first || !second) throw new Error("Category 2 needs two channels");

    provider.serveChannels((all) =>
      all
        .filter((channel) => String(channel.streamId) !== second.id)
        .map((channel) =>
          String(channel.streamId) === first.id ? { ...channel, name: "UK: RENAMED ONE" } : channel,
        )
        .reverse(),
    );
    await library.refresh();

    // What the recently watched list asks for: the renamed channel stays, the removed one drops out.
    expect(await library.channels({ channels: [second, first] })).toMatchObject([
      { id: first.id, title: "Renamed One" },
    ]);
    await expect(library.channel(second)).rejects.toMatchObject({
      error: { kind: "channel-not-found", channelId: second.id },
    });
  });

  it("keeps channels for adults to Live TV's lists while Settings shows them, and out of search", async () => {
    const { library, settings, own } = await connectedLibrary(300, true);
    const guideChannels = () => library.guideChannels(own("").subscriptionId);
    // One flagged by the provider in an ordinary category, two in a category named for adults.
    const names = ["AFTER HOURS", "LATE SHOW", "NIGHT CLUB"];
    const all = async () => (await library.channels({})).map((channel) => channel.name);
    const channels = [own("4000")];
    const adultCategory = async () =>
      (await library.categories()).find((category) => category.name === "XXX | ADULTS");

    expect((await all()).filter((name) => names.includes(name))).toEqual([]);
    expect(await adultCategory()).toBeUndefined();
    expect(await library.channels({ channels })).toEqual([]);
    await expect(library.channel(own("4000"))).rejects.toMatchObject({
      error: { kind: "channel-not-found" },
    });
    expect((await guideChannels()).guideIdsOf("4000")).toEqual([]);

    await settings.update({ adultTitles: true });

    expect((await all()).filter((name) => names.includes(name))).toEqual(names);
    expect(await adultCategory()).toMatchObject({ channelCount: 2 });
    expect((await library.channels({ channels })).map((channel) => channel.adult)).toEqual([true]);
    expect((await guideChannels()).guideIdsOf("4000")).toEqual(["afterhours.adult"]);
    expect(await library.channels({ query: "night club" })).toEqual([]);
    expect(await library.channels({ query: "after hours" })).toEqual([]);
  });
});

describe("the channels of several subscriptions", () => {
  /**
   * A library on two providers that number their channels and categories alike, as two panels of
   * one kind do, so every id is taken twice: 300 channels, then 200 others beside them. Both list
   * the "TEST" channels and "Kwaliteit 1" under the same names.
   */
  async function two() {
    const [first, second] = [
      await fakeProvider({ channels: 300 }),
      await fakeProvider({ channels: 200 }),
    ];
    const dataDir = await tempDir();
    const services = await started(dataDir);
    const a = (await services.subscriptions.add(login(first))).id;
    const b = (await services.subscriptions.add(login(second))).id;
    const statusOf = async (subscriptionId: string) =>
      (await services.library.status()).find((each) => each.subscriptionId === subscriptionId);
    return { ...services, dataDir, first, second, a, b, statusOf };
  }
  const of = (subscriptionId: string, id: string) => ({ subscriptionId, id });

  it("shows them together, each subscription's in its own order and the subscriptions in theirs", async () => {
    const { library, dataDir, first, second, a, b, statusOf } = await two();

    const all = await library.channels({});

    const [ofA, ofB] = [a, b].map((id) => all.filter((each) => each.subscriptionId === id));
    expect(all).toEqual([...(ofA ?? []), ...(ofB ?? [])]);
    expect(ofA?.length).toBe((await statusOf(a))?.channelCount);
    expect(ofB?.length).toBe((await statusOf(b))?.channelCount);
    // The same id names another channel in each, and finds the one of the subscription asked.
    expect(await library.channel(of(a, "2014"))).toMatchObject({
      ...of(a, "2014"),
      name: "EARTH XTRA HD",
    });
    expect(await library.channel(of(b, "2014"))).toMatchObject({
      ...of(b, "2014"),
      name: "UK: OPEN PLUS HD",
    });
    expect(
      (await library.channels({ channels: [of(b, "2014"), of(a, "2014")] })).map(
        (each) => each.subscriptionId,
      ),
    ).toEqual([b, a]);

    // Each keeps its own cache, and both show again without a provider.
    await Promise.all([first.close(), second.close()]);
    const restarted = (await started(dataDir)).library;
    expect(await restarted.channels({})).toEqual(all);
  });

  it("shows categories of the same country and name as one, with whose each is underneath", async () => {
    const { library, a, b } = await two();

    const categories = await library.categories();
    const entertainment = categories.find(
      (each) => each.group === "United Kingdom" && each.title === "Entertainment",
    );

    // One list for both, named by the first subscription's category.
    expect(entertainment).toMatchObject({ ...of(a, "2"), members: [of(a, "2"), of(b, "2")] });
    const listed = await library.channels({ category: of(a, "2") });
    expect(listed.map((each) => each.subscriptionId)).toEqual([a, a, a, a, a, b, b, b]);
    expect(entertainment?.channelCount).toBe(listed.length);
    // Either of its categories names the same list.
    expect(await library.channels({ category: of(b, "2") })).toEqual(listed);
    // A category only one of them has stays that one's.
    const kids = categories.filter((each) => each.title === "Kids");
    expect(kids.every((each) => each.members.length <= 2)).toBe(true);
    expect(new Set(categories.map((each) => `${each.group}|${each.title}`)).size).toBe(
      categories.length,
    );
  });

  it("marks the channels another subscription lists under the same name, and no other", async () => {
    const { library, subscriptions, a, b } = await two();
    const named = async (name: string) =>
      (await library.channels({})).filter((each) => each.name === name);

    expect(await named("TEST | H.264 + AAC")).toMatchObject([
      { subscriptionId: a, ambiguous: true },
      { subscriptionId: b, ambiguous: true },
    ]);
    // Told apart wherever it shows: by id, in a category and in a search.
    expect(await library.channel(of(b, "1000"))).toMatchObject({ ambiguous: true });
    expect(
      (await library.channels({ query: "h 264 aac" })).map((each) => [
        each.subscriptionId,
        each.ambiguous,
      ]),
    ).toEqual([
      [a, true],
      [b, true],
    ]);
    // Marked exactly where the other subscription has a channel that shows under that name.
    const all = await library.channels({});
    const titles = (subscriptionId: string) =>
      new Set(
        all.flatMap((each) =>
          each.subscriptionId === subscriptionId ? [each.title.toLowerCase()] : [],
        ),
      );
    const others = { [a]: titles(b), [b]: titles(a) };
    expect(all.some((each) => !each.ambiguous)).toBe(true);
    for (const each of all) {
      expect([each.name, each.ambiguous ?? false]).toEqual([
        each.name,
        others[each.subscriptionId]?.has(each.title.toLowerCase()),
      ]);
    }

    // Once the other one is gone, nothing is left to tell it from.
    const gone = (await subscriptions.saved()).find((each) => each.id === b);
    await subscriptions.remove(b);
    await library.forget(gone!);

    const left = await library.channels({});
    expect(new Set(left.map((each) => each.subscriptionId))).toEqual(new Set([a]));
    expect(left.some((each) => each.ambiguous)).toBe(false);
    expect((await library.categories()).every((each) => each.members.length === 1)).toBe(true);
    await expect(library.channel(of(b, "1000"))).rejects.toMatchObject({
      error: { kind: "no-subscription" },
    });
  });

  it("searches every subscription before it cuts the list", async () => {
    const dataDir = await tempDir();
    const { library, subscriptions } = await started(dataDir);
    // The first has more matches than a search returns, none of them good: the word only sits
    // inside its names. The second, added later, has three names that start with it.
    const [many, few] = [await fakeProvider({ channels: 400 }), await fakeProvider()];
    many.serveChannels((all) => all.map((each, at) => ({ ...each, name: `Bravo ${at}` })));
    few.serveChannels((all) =>
      all.map((each, at) => ({ ...each, name: at < 3 ? `Ravo ${at}` : `Other ${at}` })),
    );
    const a = (await subscriptions.add(login(many))).id;
    const b = (await subscriptions.add(login(few))).id;
    await library.refresh(a);
    await library.refresh(b);

    const results = await library.channels({ query: "ravo" });

    expect(results).toHaveLength(200);
    expect(results.slice(0, 3).map(({ subscriptionId, title }) => [subscriptionId, title])).toEqual(
      [0, 1, 2].map((at) => [b, `Ravo ${at}`]),
    );
    expect(new Set(results.slice(3).map((each) => each.subscriptionId))).toEqual(new Set([a]));
  });

  it("keeps one subscription's channels when it can't be reached, and holds no other back", async () => {
    const { library, first, a, b, statusOf, updates } = await two();
    const before = await library.channels({});

    first.failCatalogue(503);
    await expect(library.refresh(a)).rejects.toMatchObject({
      error: { kind: "provider-error", status: 503 },
    });
    await library.refresh(b);

    expect(await library.channels({})).toEqual(before);
    expect(await statusOf(a)).toMatchObject({
      failure: { kind: "provider-error", status: 503 },
      failedAt: expect.any(Number),
    });
    expect(await statusOf(b)).toMatchObject({ failure: null, failedAt: null });
    expect(updates.filter((each) => each.failure).map((each) => each.subscriptionId)).toEqual([a]);
    // Failing again doesn't move the moment it began to fail.
    const since = (await statusOf(a))?.failedAt;
    await library.refresh(a).catch(() => {});
    expect((await statusOf(a))?.failedAt).toBe(since);
  });

  it("shows what is there while a new subscription's channels load, and then with them", async () => {
    const provider = await fakeProvider({ channels: 300 });
    const other = await fakeProvider({ channels: 200 });
    const dataDir = await tempDir();
    const { library, subscriptions, updates } = await started(dataDir);
    const a = (await subscriptions.add(login(provider))).id;
    const first = await library.channels({});
    const held = other.hold("channels");

    const b = (await subscriptions.add(login(other))).id;
    // Asked for while the new one's list is still on its way: no wait, and nothing missing.
    expect(await library.channels({})).toEqual(first);
    await held.arrived;
    held.release();
    await expect.poll(() => updates.some((each) => each.subscriptionId === b)).toBe(true);

    const both = await library.channels({});
    expect(new Set(both.map((each) => each.subscriptionId))).toEqual(new Set([a, b]));
  });

  it("shows the others' channels when one never answered, and fails only with nothing to show", async () => {
    const provider = await fakeProvider({ channels: 300 });
    const down = await fakeProvider({ channels: 200 });
    const dataDir = await tempDir();
    const { library, subscriptions, updates } = await started(dataDir);
    const b = (await subscriptions.add(login(down))).id;
    down.failCatalogue(500);

    // Alone, it has nothing to show but why.
    await expect(library.channels({})).rejects.toMatchObject({
      error: { kind: "provider-error", status: 500 },
    });

    const a = (await subscriptions.add(login(provider))).id;
    await library.refresh(a);

    const channels = await library.channels({});
    expect(new Set(channels.map((each) => each.subscriptionId))).toEqual(new Set([a]));
    expect(updates.findLast((each) => each.subscriptionId === b)).toMatchObject({
      channelCount: 0,
      fetchedAt: null,
      failure: { kind: "provider-error", status: 500 },
    });
  });
});
