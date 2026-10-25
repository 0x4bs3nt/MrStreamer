// The viewer's channel lists through their public service, on the app's services and a real
// database in a temporary folder, with two fake providers that number their channels alike.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CustomList } from "@mrstreamer/contracts/custom-lists";
import { Failed } from "@mrstreamer/core/failure";
import { ViewingRecord } from "@mrstreamer/core/viewing/service";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { mainLayer } from "../src/main/runtime.ts";
import { CustomLists } from "../src/main/services/custom-lists.ts";
import { Library } from "../src/main/services/library.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import type { FakeChannel, FakeProvider } from "./fake-provider.ts";
import { QUALITY_STREAM_IDS } from "./fake-provider.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

/** The app's services on `dataDir`, as a start of the app has them. */
async function started(dataDir: string) {
  const runtime = runtimeFor(mainLayer(testConfig(dataDir)));
  return {
    quit: () => runtime.dispose(),
    /**
     * Removes a subscription with its record, as Settings does with Also delete, and has the
     * removal wait until `release`: before its turn among the storage changes (`queued`), once
     * the record is erased (`erased`), or as it erases, which then fails and erases nothing
     * (`refused`). Answers once it waits there.
     */
    removing: async (subscriptionId: string, held: "queued" | "erased" | "refused") => {
      const services = await runtime.context();
      const subscriptions = Context.get(services, Subscriptions);
      const viewing = Context.get(services, ViewingRecord);
      const arrived = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const wait = Effect.promise(() => {
        arrived.resolve();
        return released.promise;
      });
      const slowed =
        held === "queued"
          ? Context.add(services, Subscriptions, {
              ...subscriptions,
              remove: (id, steps) => Effect.andThen(wait, subscriptions.remove(id, steps)),
            })
          : Context.add(services, ViewingRecord, {
              ...viewing,
              erase: (account) =>
                held === "erased"
                  ? Effect.andThen(viewing.erase(account), wait)
                  : Effect.andThen(wait, Effect.fail(refused)),
            });
      const roster = await promised(
        runtimeFor(Roster.layer.pipe(Layer.provide(Layer.succeedContext(slowed)))),
        Roster,
      );
      const done = roster.remove(subscriptionId, true);
      await arrived.promise;
      return { done, release: () => released.resolve() };
    },
    lists: await promised(runtime, CustomLists),
    roster: await promised(runtime, Roster),
    subscriptions: await promised(runtime, Subscriptions),
    library: await promised(runtime, Library),
    viewing: await promised(runtime, ViewingRecord),
    settings: await promised(runtime, Settings),
  };
}

/** What an erase that can't be done fails with. */
const refused = new Failed({
  error: { kind: "unexpected", detail: "The record can't be erased." },
});

const login = (provider: FakeProvider) => ({
  server: provider.url,
  username: "demo",
  password: "demo",
});

/** Two subscriptions saved with their channels, each of a provider that numbers channels alike. */
async function withTwo(options: { adultChannels?: boolean } = {}) {
  const dataDir = await tempDir();
  const first = await fakeProvider({ adultChannels: options.adultChannels ?? false });
  const second = await fakeProvider({ channels: 200, second: true });
  const app = await started(dataDir);
  const a = (await app.roster.add(login(first))).id;
  await app.library.refresh(a);
  const b = (await app.roster.add(login(second))).id;
  await app.library.refresh(b);
  return { ...app, dataDir, first, second, a, b };
}

/** What a list shows of its channels: listed ones by owned id, others by kind and name. */
function shown(list: CustomList | undefined) {
  return {
    members: list?.members.map((each) =>
      each.kind === "listed"
        ? `${each.channel.subscriptionId}:${each.channel.id}`
        : `unlisted:${each.subscriptionId}:${each.name}`,
    ),
    away: list?.away,
  };
}

/** The first online channels of category `category` that have no guide id, by stream id. */
function plain(provider: FakeProvider, category: string, count: number): FakeChannel[] {
  return provider.catalogue.channels
    .filter((each) => each.categoryId === category && !each.offline && each.guideId === null)
    .slice(0, count);
}

/** Opens the database as a separate program would: for what is kept on disk, not what shows. */
function onDisk<A>(dataDir: string, read: (db: DatabaseSync) => A): A {
  const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));
  try {
    return read(db);
  } finally {
    db.close();
  }
}

describe("custom channel lists", { timeout: 30_000 }, () => {
  it("hold exact channels of several subscriptions in the viewer's order, named and ordered, across a restart", async () => {
    const app = await withTwo();
    const { lists, a, b } = app;
    const sport = randomUUID();
    const news = randomUUID();
    await lists.create({ id: sport, name: "  Late sport " });
    await lists.create({ id: news, name: "News", channel: { subscriptionId: b, id: "2014" } });
    // The same provider id in both subscriptions is two channels.
    await lists.setMember(sport, { subscriptionId: b, id: "2014" }, true);
    await lists.setMember(sport, { subscriptionId: a, id: "2014" }, true);
    await lists.setMember(sport, { subscriptionId: a, id: "2015" }, true);
    // Added again, by its id or another of its streams', it stays where it was.
    await lists.setMember(sport, { subscriptionId: b, id: "2014" }, true);
    await lists.rename(news, "News 24");
    await lists.order([news, sport]);

    const expected = [
      { name: "News 24", members: [`${b}:2014`] },
      { name: "Late sport", members: [`${b}:2014`, `${a}:2014`, `${a}:2015`] },
    ];
    const read = (all: readonly CustomList[]) =>
      all.map((list) => ({ name: list.name, members: shown(list).members }));
    expect(read(await lists.lists())).toEqual(expected);
    await app.quit();
    const again = await started(app.dataDir);
    expect(read(await again.lists.lists())).toEqual(expected);

    // Taken out, and deleted with what it held.
    await again.lists.setMember(sport, { subscriptionId: a, id: "2014" }, false);
    expect(shown((await again.lists.lists())[1]).members).toEqual([`${b}:2014`, `${a}:2015`]);
    await again.lists.remove(news);
    expect((await again.lists.lists()).map((list) => list.name)).toEqual(["Late sport"]);
  });

  it("tells lists apart by name without case or accents, and a create sent again makes nothing more", async () => {
    const { lists } = await withTwo();
    const id = randomUUID();
    await lists.create({ id, name: "Café" });
    await expect(lists.create({ id: randomUUID(), name: "cafe" })).rejects.toMatchObject({
      error: { kind: "list-name-taken" },
    });
    await expect(lists.create({ id: randomUUID(), name: "   " })).rejects.toMatchObject({
      error: { kind: "invalid-input" },
    });
    // Sent again after it was stored, as a retry is: the same list, once.
    await lists.create({ id, name: "Café" });
    expect((await lists.lists()).map((list) => list.name)).toEqual(["Café"]);
    const other = randomUUID();
    await lists.create({ id: other, name: "Kids" });
    await expect(lists.rename(other, "CAFÉ")).rejects.toMatchObject({
      error: { kind: "list-name-taken" },
    });

    // A create sent again after its list was deleted doesn't bring it back.
    await lists.remove(id);
    await expect(lists.create({ id, name: "Café" })).rejects.toMatchObject({
      error: { kind: "no-list" },
    });
    await expect(lists.rename(id, "Back")).rejects.toMatchObject({ error: { kind: "no-list" } });
    // The name is free again, for a list of its own.
    await lists.create({ id: randomUUID(), name: "cafe" });
    expect((await lists.lists()).map((list) => list.name)).toEqual(["Kids", "cafe"]);
    // An order that doesn't name every list there is changes nothing.
    await expect(lists.order([other])).rejects.toMatchObject({ error: { kind: "list-changed" } });
  });

  it("deletes a list with the channels of every account, and a new list of its name holds none", async () => {
    const app = await withTwo();
    const { lists, roster, second, a, b } = app;
    const id = randomUUID();
    await lists.create({ id, name: "Late sport", channel: { subscriptionId: a, id: "2014" } });
    await lists.setMember(id, { subscriptionId: b, id: "2015" }, true);
    // One of them away, as its subscription is removed without erasing.
    await roster.remove(b, false);
    expect(shown((await lists.lists())[0])).toEqual({ members: [`${a}:2014`], away: 1 });

    await lists.remove(id);
    const again = randomUUID();
    await lists.create({ id: again, name: "Late sport" });
    const back = (await roster.add(login(second))).id;
    await app.library.refresh(back);
    expect(shown((await lists.lists())[0])).toEqual({ members: [], away: 0 });
    await expect(
      lists.setMember(id, { subscriptionId: a, id: "2014" }, true),
    ).rejects.toMatchObject({ error: { kind: "no-list" } });
  });

  it("keeps a removed subscription's channels in their places, counted, until it is added again", async () => {
    const app = await withTwo();
    const { lists, roster, second, a, b } = app;
    const id = randomUUID();
    await lists.create({ id, name: "Mixed" });
    await lists.setMember(id, { subscriptionId: a, id: "2014" }, true);
    await lists.setMember(id, { subscriptionId: b, id: "2014" }, true);
    await lists.setMember(id, { subscriptionId: a, id: "2015" }, true);

    await roster.remove(b, false);
    expect(shown((await lists.lists())[0])).toEqual({
      members: [`${a}:2014`, `${a}:2015`],
      away: 1,
    });
    // A channel can't be put in a list for a subscription that went.
    await expect(
      lists.setMember(id, { subscriptionId: b, id: "2016" }, true),
    ).rejects.toMatchObject({ error: { kind: "no-subscription" } });

    // Added again, under another id, its account's channel is back where it was.
    const back = (await roster.add(login(second))).id;
    expect(back).not.toBe(b);
    await app.library.refresh(back);
    expect(shown((await lists.lists())[0])).toEqual({
      members: [`${a}:2014`, `${back}:2014`, `${a}:2015`],
      away: 0,
    });
  });

  it("erases an account's channels of every list with Also delete, and keeps the lists and the other account's", async () => {
    const app = await withTwo();
    const { lists, roster, viewing, dataDir, second, a, b } = app;
    const one = randomUUID();
    const two = randomUUID();
    await lists.create({ id: one, name: "One", channel: { subscriptionId: b, id: "2014" } });
    await lists.create({ id: two, name: "Two", channel: { subscriptionId: a, id: "2014" } });
    await lists.setMember(two, { subscriptionId: b, id: "2015" }, true);
    await viewing.setFavourite(randomUUID(), { subscriptionId: b, id: "2016" }, true);
    const named = () =>
      onDisk(dataDir, (db) =>
        db
          .prepare("select account, name from custom_list_members order by name")
          .all()
          .map((row) => [row["account"], row["name"]]),
      );
    const account = `${second.url}|demo`;
    expect(named().filter(([owner]) => owner === account)).toHaveLength(2);

    await roster.remove(b, true);

    expect(named().some(([owner]) => owner === account)).toBe(false);
    expect((await lists.lists()).map((list) => [list.name, shown(list)])).toEqual([
      ["One", { members: [], away: 0 }],
      ["Two", { members: [`${a}:2014`], away: 0 }],
    ]);
    // Added again, its account has none of what it had.
    const back = (await roster.add(login(second))).id;
    await app.library.refresh(back);
    expect((await lists.lists()).map((list) => shown(list).members)).toEqual([[], [`${a}:2014`]]);
  });

  it("never shows again the channels of an account erased by a build before lists, whatever that build recorded for it since", async () => {
    const app = await withTwo();
    const { lists, dataDir, second, b } = app;
    const id = randomUUID();
    await lists.create({ id, name: "Late sport", channel: { subscriptionId: b, id: "2014" } });
    await app.quit();
    const account = `${second.url}|demo`;
    // As such a build erases the account: its events go, and the tables it doesn't know stay.
    // Then, added again there, it records a watch and a favourite under the same account.
    onDisk(dataDir, (db) => {
      db.prepare("delete from events where account = ?").run(account);
      const event = db.prepare(
        "insert into events (account, type, version, channel_id, at, command_id) values (?, ?, 1, ?, ?, ?)",
      );
      event.run(account, "watched", "2014", Date.now(), randomUUID());
      event.run(account, "favourite-added", "2015", Date.now(), randomUUID());
    });

    const again = await started(dataDir);
    expect(shown((await again.lists.lists())[0])).toEqual({ members: [], away: 0 });
    expect(
      onDisk(dataDir, (db) => db.prepare("select count(*) as n from custom_list_members").get()),
    ).toEqual({ n: 0 });
    // A channel added now is kept as any other is.
    await again.lists.setMember(id, { subscriptionId: b, id: "2014" }, true);
    await again.quit();
    const third = await started(dataDir);
    expect(shown((await third.lists.lists())[0]).members).toEqual([`${b}:2014`]);
  });

  it("follows a channel through a lost canonical stream, and through a join and a split of its streams", async () => {
    const app = await withTwo();
    const { lists, library, first, a } = app;
    const id = randomUUID();
    // BE | KWALITEIT 1 in Full HD, HD and SD: one channel, by the Full HD stream's id.
    const [fhd, hd] = [QUALITY_STREAM_IDS, QUALITY_STREAM_IDS + 1].map(String);
    const [one, two] = plain(first, "2", 2);
    if (!one || !two || !fhd || !hd) throw new Error("The fake catalogue needs these channels");
    await lists.create({ id, name: "Followed", channel: { subscriptionId: a, id: hd } });
    await lists.setMember(id, { subscriptionId: a, id: String(one.streamId) }, true);
    await lists.setMember(id, { subscriptionId: a, id: String(two.streamId) }, true);
    const members = async () => shown((await lists.lists())[0]).members;
    expect(await members()).toEqual([
      `${a}:${fhd}`,
      `${a}:${one.streamId}`,
      `${a}:${two.streamId}`,
    ]);

    // The Full HD stream goes: the channel goes on by its HD stream's id.
    first.serveChannels((all) => all.filter((each) => String(each.streamId) !== fhd));
    await library.refresh(a);
    expect(await members()).toEqual([`${a}:${hd}`, `${a}:${one.streamId}`, `${a}:${two.streamId}`]);
    // And the provider gives that id to another channel: the list keeps the one it had.
    const elsewhere = (all: readonly FakeChannel[]) =>
      all.map((each) =>
        String(each.streamId) === fhd
          ? { ...each, name: "BE | ANOTHER CHANNEL", offline: false }
          : each,
      );
    first.serveChannels(elsewhere);
    await library.refresh(a);
    expect(await members()).toEqual([`${a}:${hd}`, `${a}:${one.streamId}`, `${a}:${two.streamId}`]);

    // Two channels the provider joins show once, and split again, both are back in their places.
    const rename = (streamId: number, name: string) => (all: readonly FakeChannel[]) =>
      all.map((each) => (each.streamId === streamId ? { ...each, name } : each));
    first.serveChannels((all) =>
      rename(two.streamId, "UK: JOINED SD")(rename(one.streamId, "UK: JOINED HD")(elsewhere(all))),
    );
    await library.refresh(a);
    const joined = Math.min(one.streamId, two.streamId);
    expect(await members()).toEqual([`${a}:${hd}`, `${a}:${joined}`]);
    first.serveChannels(elsewhere);
    await library.refresh(a);
    expect(await members()).toEqual([`${a}:${hd}`, `${a}:${one.streamId}`, `${a}:${two.streamId}`]);
    // Its first stream listed with it again, the channel goes by that stream's id once more.
    first.serveChannels((all) => all);
    await library.refresh(a);
    expect(await members()).toEqual([
      `${a}:${fhd}`,
      `${a}:${one.streamId}`,
      `${a}:${two.streamId}`,
    ]);
  });

  it("shows a channel its saved subscription no longer lists by its last name, to take out", async () => {
    const app = await withTwo();
    const { lists, library, first, a } = app;
    const id = randomUUID();
    const [one, two] = plain(first, "3", 2);
    if (!one || !two) throw new Error("The fake catalogue needs these channels");
    await lists.create({
      id,
      name: "Dropped",
      channel: { subscriptionId: a, id: String(one.streamId) },
    });
    await lists.setMember(id, { subscriptionId: a, id: String(two.streamId) }, true);
    const title = (await library.channel({ subscriptionId: a, id: String(one.streamId) })).title;

    first.serveChannels((all) => all.filter((each) => each.streamId !== one.streamId));
    await library.refresh(a);
    const [list] = await lists.lists();
    expect(shown(list).members).toEqual([`unlisted:${a}:${title}`, `${a}:${two.streamId}`]);
    const placeholder = list?.members[0];
    if (!placeholder) throw new Error("The list holds the channel");
    await lists.removeMember(id, placeholder.member);
    expect(shown((await lists.lists())[0]).members).toEqual([`${a}:${two.streamId}`]);
  });

  it("shows nothing for adults, listed, unlisted or away, while Settings hides them", async () => {
    const app = await withTwo({ adultChannels: true });
    const { lists, library, settings, roster, first, a, b } = app;
    await settings.update({ adultTitles: true });
    const id = randomUUID();
    await lists.create({ id, name: "Night", channel: { subscriptionId: a, id: "4000" } });
    await lists.setMember(id, { subscriptionId: a, id: "4001" }, true);
    await lists.setMember(id, { subscriptionId: a, id: "2014" }, true);
    await lists.setMember(id, { subscriptionId: b, id: "2014" }, true);
    // One for adults the provider drops, and the other subscription away.
    first.serveChannels((all) => all.filter((each) => each.streamId !== 4001));
    await library.refresh(a);
    await roster.remove(b, false);
    const shownNow = async () => shown((await lists.lists())[0]);
    expect(await shownNow()).toEqual({
      members: [`${a}:4000`, `unlisted:${a}:Late Show`, `${a}:2014`],
      away: 1,
    });

    await settings.update({ adultTitles: false });
    expect(await shownNow()).toEqual({ members: [`${a}:2014`], away: 1 });
    // The away count hides an adult channel too.
    const night = randomUUID();
    await settings.update({ adultTitles: true });
    await lists.create({ id: night, name: "Away", channel: { subscriptionId: a, id: "4000" } });
    await roster.remove(a, false);
    await settings.update({ adultTitles: false });
    expect(shown((await lists.lists()).find((list) => list.id === night))).toEqual({
      members: [],
      away: 0,
    });
  });

  it("puts a list's channels in another order only from the list as it shows, keeping the places of those it doesn't", async () => {
    const app = await withTwo();
    const { lists, roster, second, a, b } = app;
    const id = randomUUID();
    await lists.create({ id, name: "Order" });
    for (const [subscriptionId, channel] of [
      [a, "2014"],
      [b, "2014"],
      [a, "2015"],
      [a, "2016"],
    ] as const) {
      await lists.setMember(id, { subscriptionId, id: channel }, true);
    }
    const read = async () => (await lists.lists())[0];
    const list = await read();
    if (!list) throw new Error("The list is there");
    const ids = list.members.map((each) => each.member);
    const [w, x, y, z] = ids;
    if (!w || !x || !y || !z) throw new Error("The list holds four channels");

    // An order made before a change is refused, and so is one naming a channel twice.
    await lists.setMember(id, { subscriptionId: a, id: "2017" }, true);
    await expect(
      lists.arrange({ list: id, revision: list.revision, order: [z, y, x, w] }),
    ).rejects.toMatchObject({ error: { kind: "list-changed" } });
    const now = await read();
    if (!now) throw new Error("The list is there");
    await expect(
      lists.arrange({ list: id, revision: now.revision, order: [z, z] }),
    ).rejects.toMatchObject({ error: { kind: "list-changed" } });

    // The other subscription away: its channel isn't shown, and keeps its second place.
    await roster.remove(b, false);
    const away = await read();
    if (!away) throw new Error("The list is there");
    await expect(
      lists.arrange({ list: id, revision: away.revision, order: [x, w] }),
    ).rejects.toMatchObject({ error: { kind: "list-changed" } });
    const v = away.members[3]?.member;
    if (!v) throw new Error("The list holds the new channel");
    await lists.arrange({ list: id, revision: away.revision, order: [v, z, y, w] });
    const back = (await roster.add(login(second))).id;
    await app.library.refresh(back);
    expect(shown(await read()).members).toEqual([
      `${a}:2017`,
      `${back}:2014`,
      `${a}:2016`,
      `${a}:2015`,
      `${a}:2014`,
    ]);
  });

  it.each(["queued", "erased"] as const)(
    "erases with a record what was put in lists for its subscription while it was removed (%s)",
    async (held) => {
      const app = await withTwo();
      const { lists, removing, roster, second, a, b } = app;
      const id = randomUUID();
      await lists.create({ id, name: "Raced", channel: { subscriptionId: a, id: "2014" } });

      const removal = await removing(b, held);
      // Stored before the erase while the removal waits its turn, refused once it erased.
      await lists.setMember(id, { subscriptionId: b, id: "2014" }, true).catch(() => {});
      removal.release();
      await removal.done;

      const back = (await roster.add(login(second))).id;
      await app.library.refresh(back);
      expect(shown((await lists.lists())[0])).toEqual({ members: [`${a}:2014`], away: 0 });
    },
  );

  it.each(["setMember", "create"] as const)(
    "keeps an account erased when a list change for it (%s) starts as its removal does",
    async (change) => {
      const provider = await fakeProvider();
      const app = await started(await tempDir());
      /** The rounds whose list kept a channel of the erased account, and what came back. */
      const away: number[] = [];
      const restored: string[] = [];
      /** The rounds whose change was refused, with why: only because its subscription went. */
      const refused: { readonly turns: number; readonly reason: unknown }[] = [];
      let made: string | null = null;
      // The change starts a few turns of the event loop after the removal, a few more each round:
      // whichever comes first, the account's channel is erased with its record or never stored.
      for (let turns = 0; turns <= 32; turns++) {
        // Each round adds the account the round before removed with Also delete, as the viewer
        // can: its list holds none of that account's channels.
        const owner = (await app.roster.add(login(provider))).id;
        await app.library.refresh(owner);
        if (made !== null) {
          const last = (await app.lists.lists()).find((each) => each.id === made);
          for (const member of last?.members ?? []) restored.push(`${turns - 1}:${member.kind}`);
        }
        if (turns === 32) break;
        const id = randomUUID();
        made = id;
        const channel = { subscriptionId: owner, id: "2014" };
        if (change === "setMember") await app.lists.create({ id, name: id });
        const removal = app.roster.remove(owner, true);
        for (let turn = 0; turn < turns; turn++) await Promise.resolve();
        const [, outcome] = await Promise.allSettled([
          removal,
          change === "create"
            ? app.lists.create({ id, name: id, channel })
            : app.lists.setMember(id, channel, true),
        ]);
        await removal;
        if (outcome.status === "rejected") refused.push({ turns, reason: outcome.reason });
        if ((await app.lists.lists()).find((each) => each.id === id)?.away) away.push(turns);
      }
      expect({ away, restored }).toEqual({ away: [], restored: [] });
      // A change that went through was erased; one refused was refused for no other reason.
      expect(refused).toMatchObject(
        refused.map(({ turns }) => ({ turns, reason: { error: { kind: "no-subscription" } } })),
      );
      await app.quit();
    },
  );

  it("refuses a channel its saved subscription doesn't list as not found, making nothing", async () => {
    const { lists, a } = await withTwo();
    const id = randomUUID();
    const missing = { subscriptionId: a, id: "no-such-channel" };
    const notFound = { error: { kind: "channel-not-found", channelId: "no-such-channel" } };
    await expect(lists.create({ id, name: "Missing", channel: missing })).rejects.toMatchObject(
      notFound,
    );
    await lists.create({ id, name: "Missing" });
    await expect(lists.setMember(id, missing, true)).rejects.toMatchObject(notFound);
    expect(shown((await lists.lists()).find((each) => each.id === id))).toEqual({
      members: [],
      away: 0,
    });
  });

  it("takes a list change for a subscription again once its removal failed and kept it", async () => {
    const app = await withTwo();
    const { lists, removing, a, b } = app;
    const id = randomUUID();
    await lists.create({ id, name: "Kept", channel: { subscriptionId: a, id: "2014" } });

    const removal = await removing(b, "refused");
    // In force while it erases: the change is refused and nothing is stored.
    await expect(
      lists.setMember(id, { subscriptionId: b, id: "2014" }, true),
    ).rejects.toMatchObject({ error: { kind: "no-subscription" } });
    removal.release();
    await expect(removal.done).rejects.toBe(refused);
    // The removal gave way, so the subscription is saved still and the change goes through.
    await lists.setMember(id, { subscriptionId: b, id: "2014" }, true);
    expect(shown((await lists.lists()).find((each) => each.id === id))).toEqual({
      members: [`${a}:2014`, `${b}:2014`],
      away: 0,
    });
  });
});
