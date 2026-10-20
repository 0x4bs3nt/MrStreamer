import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Codec } from "@mrstreamer/contracts/playback";
import { Guide } from "@mrstreamer/core/guide/service";
import { ViewingRecord } from "@mrstreamer/core/viewing/service";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it, vi } from "vitest";
import { mainLayer } from "../src/main/runtime.ts";
import { Library } from "../src/main/services/library.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { Watchlist } from "../src/main/services/watchlist.ts";
import type { FakeProvider } from "./fake-provider.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

const DECODERS: readonly Codec[] = ["h264", "aac"];

/** The app's services on `dataDir`, as a start of the app has them. */
async function started(dataDir: string, now?: number) {
  const services = mainLayer(testConfig(dataDir));
  const runtime = runtimeFor(
    now === undefined
      ? services
      : services.pipe(
          Layer.provideMerge(
            Layer.effectDiscard(TestClock.setTime(now)).pipe(
              Layer.provideMerge(TestClock.layer({ warningDelay: "1 day" })),
            ),
          ),
        ),
  );
  return {
    runtime,
    /**
     * Removes a subscription with its record, as Settings does with the box ticked, on these
     * services, and has the removal wait until `release`. `queued` waits before its turn among
     * the storage changes, as behind a login being stored. `erased` waits once the record is
     * deleted, as while the login and the lists go. Answers once it waits there.
     */
    removing: async (subscriptionId: string, held: "queued" | "erased") => {
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
              remove: (id, erase) => Effect.andThen(wait, subscriptions.remove(id, erase)),
            })
          : Context.add(services, ViewingRecord, {
              ...viewing,
              erase: (account) => Effect.andThen(viewing.erase(account), wait),
            });
      const roster = await promised(
        runtimeFor(Roster.layer.pipe(Layer.provide(Layer.succeedContext(slowed)))),
        Roster,
      );
      const done = roster.remove(subscriptionId, true);
      await arrived.promise;
      return { done, release: () => released.resolve() };
    },
    roster: await promised(runtime, Roster),
    subscriptions: await promised(runtime, Subscriptions),
    library: await promised(runtime, Library),
    onDemand: await promised(runtime, OnDemand),
    guide: await promised(runtime, Guide),
    playback: await promised(runtime, Playback),
    viewing: await promised(runtime, ViewingRecord),
    watchlist: await promised(runtime, Watchlist),
    settings: await promised(runtime, Settings),
  };
}

const login = (provider: FakeProvider) => ({
  server: provider.url,
  username: "demo",
  password: "demo",
});

/** A channel of `provider` that streams without end, by the id both providers use. */
const live = (provider: FakeProvider) =>
  String(provider.catalogue.channels.find((each) => !each.offline && !each.fixture)?.streamId);

/** Holds a stream open as a player does. */
async function watching(url: string) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  await response.body?.getReader().read();
  return { status: response.status, stop: () => controller.abort() };
}

/**
 * The app with one subscription saved and its lists loaded, and a second provider beside it
 * that numbers everything alike.
 */
async function withOne() {
  const dataDir = await tempDir();
  const [first, second] = [
    await fakeProvider({ slotReleaseMs: 0 }),
    await fakeProvider({ slotReleaseMs: 0, channels: 200, second: true }),
  ];
  const app = await started(dataDir);
  const a = (await app.subscriptions.add(login(first))).id;
  await app.library.refresh(a);
  return { ...app, dataDir, first, second, a };
}

/** The same with both saved, and every list of both loaded. */
async function withTwo() {
  const app = await withOne();
  const b = (await app.subscriptions.add(login(app.second))).id;
  await app.library.refresh(b);
  await app.onDemand.refresh(app.a);
  await app.onDemand.refresh(b);
  return { ...app, b };
}

describe("the saved subscriptions", { timeout: 30_000 }, () => {
  it("loads titles beside a held guide once an Xtream subscription's channels are ready", async () => {
    const provider = await fakeProvider();
    const app = await started(await tempDir());
    const channels = provider.hold("channels");
    const guide = provider.hold("guide");
    try {
      const saved = await app.roster.add(login(provider));
      await channels.arrived;
      expect(provider.guideRequests()).toBe(0);
      expect((await app.onDemand.status()).lists[0]?.fetchedAt).toBeNull();
      channels.release();
      await guide.arrived;
      expect((await app.library.status())[0]).toMatchObject({
        subscriptionId: saved.id,
        fetchedAt: expect.any(Number),
      });
      await vi.waitFor(
        async () =>
          expect((await app.onDemand.status()).lists[0]?.fetchedAt).toEqual(expect.any(Number)),
        { timeout: 10_000 },
      );
      expect(provider.titleListRequests()).toBe(4);
      expect(provider.fileRequests()).toBe(0);
      expect(provider.detailRequests()).toBe(0);
    } finally {
      channels.release();
      guide.release();
    }
  });

  it("adds one beside another while a channel plays, and its lists join the others'", async () => {
    const { roster, library, onDemand, playback, first, second, a } = await withOne();
    const session = await playback.open({ subscriptionId: a, id: live(first) }, DECODERS);
    const stream = await watching(session.url);

    const added = await roster.add({ ...login(second), name: "Holiday house" });

    expect(added).toMatchObject({ name: "Holiday house", needsSecret: false });
    // Fetched in the background: its channels, then its movies and series, join what shows.
    await vi.waitFor(async () =>
      expect(new Set((await library.channels({})).map((each) => each.subscriptionId))).toEqual(
        new Set([a, added.id]),
      ),
    );
    await vi.waitFor(
      async () =>
        expect((await onDemand.status()).lists).toMatchObject([
          { subscriptionId: a },
          { subscriptionId: added.id, fetchedAt: expect.any(Number) },
        ]),
      { timeout: 20_000 },
    );
    // What played plays on, on the one connection it had.
    expect(first.activeStreams()).toBe(1);
    expect(first.streamRequests()).toBe(1);
    expect(await playback.playing(session.sessionId)).not.toBeNull();
    stream.stop();
  });

  it.each(["repair", "startup"] as const)(
    "refreshes titles during %s while a guide waits, joins foreground reads and lets another subscription progress",
    async (trigger) => {
      const first = await fakeProvider();
      const second = await fakeProvider({ second: true });
      const dataDir = await tempDir();
      let app = await started(dataDir);
      const a = (await app.subscriptions.add(login(first))).id;
      const b = (await app.subscriptions.add(login(second))).id;
      const before = new Map<string, number>();
      if (trigger === "startup") {
        for (const id of [a, b]) {
          await app.library.refresh(id);
          await app.guide.refresh(id);
          await app.onDemand.refresh(id);
        }
        for (const row of (await app.onDemand.status()).lists)
          before.set(row.subscriptionId, row.fetchedAt ?? 0);
        await app.runtime.dispose();
        app = await started(dataDir, Date.now() + 13 * 60 * 60 * 1000);
      }
      const guide = first.hold("guide");
      const titles = first.hold("titles");
      let refreshing: Promise<void> | undefined;
      try {
        if (trigger === "repair") {
          await app.roster.update(a, { secret: "demo" });
          await app.roster.update(b, { secret: "demo" });
        } else refreshing = app.roster.refreshDue();
        await guide.arrived;
        await titles.arrived;
        // A foreground page joins the active refresh or reads its existing cache while the guide waits.
        const page = app.onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 10 });
        titles.release();
        await vi.waitFor(
          async () => {
            const rows = (await app.onDemand.status()).lists;
            expect(rows).toMatchObject([
              { subscriptionId: a, fetchedAt: expect.any(Number) },
              { subscriptionId: b, fetchedAt: expect.any(Number) },
            ]);
            for (const row of rows)
              expect(row.fetchedAt).toBeGreaterThan(before.get(row.subscriptionId) ?? 0);
          },
          { timeout: 10_000 },
        );
        expect((await page).total).toBeGreaterThan(0);
        expect(first.titleListRequests()).toBe(trigger === "startup" ? 8 : 4);
        expect(second.titleListRequests()).toBe(trigger === "startup" ? 8 : 4);
        for (const provider of [first, second]) {
          expect(provider.fileRequests()).toBe(0);
          expect(provider.detailRequests()).toBe(0);
          expect(provider.streamRequests()).toBe(0);
        }
      } finally {
        titles.release();
        guide.release();
        await refreshing;
      }
    },
  );

  it("removes one with what was loaded from it, and leaves the other playing", async () => {
    const app = await withTwo();
    const { roster, subscriptions, library, onDemand, guide, playback, viewing, settings } = app;
    const { dataDir, first, second, a, b } = app;
    await guide.refresh(b);
    await settings.updateSubscription(b, { lastChannelId: "2014" });
    await viewing.setFavourite(randomUUID(), { subscriptionId: b, id: "2014" }, true);
    await viewing.setFavourite(randomUUID(), { subscriptionId: a, id: "2014" }, true);
    const session = await playback.open({ subscriptionId: a, id: live(first) }, DECODERS);
    const stream = await watching(session.url);

    await roster.remove(b, false);

    expect((await subscriptions.list()).map((each) => each.id)).toEqual([a]);
    expect(await readdir(join(dataDir, "subscriptions"))).toEqual([]);
    // Nothing of it is left in the lists, and the other's are as they were.
    expect(new Set((await library.channels({})).map((each) => each.subscriptionId))).toEqual(
      new Set([a]),
    );
    expect((await library.status()).map((each) => each.subscriptionId)).toEqual([a]);
    expect((await guide.status()).map((each) => each.subscriptionId)).toEqual([a]);
    expect((await onDemand.status()).lists.map((each) => each.subscriptionId)).toEqual([a]);
    expect(await onDemand.titles("movie", [{ subscriptionId: b, id: "91001" }])).toEqual([]);
    expect((await viewing.state()).favourites).toEqual([{ subscriptionId: a, id: "2014" }]);
    // The other one's stream never noticed.
    expect(first.activeStreams()).toBe(1);
    expect(await playback.playing(session.sessionId)).not.toBeNull();
    stream.stop();

    // Its record was kept: added again, its favourite is back, and nothing it was left at.
    const back = await roster.add(login(second));
    expect((await viewing.state()).favourites).toContainEqual({
      subscriptionId: back.id,
      id: "2014",
    });
    expect(await settings.ofSubscription(back.id)).toEqual({
      lastChannelId: null,
      lastCategoryId: null,
    });
  });

  it("lets owned guide work settle before deleting the removed subscription's folder", async () => {
    const { runtime, subscriptions, dataDir, a, b } = await withTwo();
    const services = await runtime.context();
    const guide = Context.get(services, Guide);
    const arrived = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const slowed = Context.add(services, Guide, {
      ...guide,
      forget: (subscription) =>
        Effect.andThen(
          Effect.promise(() => {
            arrived.resolve();
            return released.promise;
          }),
          guide.forget(subscription),
        ),
    });
    const roster = await promised(
      runtimeFor(Roster.layer.pipe(Layer.provide(Layer.succeedContext(slowed)))),
      Roster,
    );
    const folder = join(dataDir, "subscriptions", b);
    const removing = roster.remove(b, false);
    try {
      await arrived.promise;
      // It admits no new work, while already admitted writes still have their folder.
      expect((await subscriptions.list()).map((each) => each.id)).toEqual([a]);
      expect(await stat(folder).catch(() => null)).not.toBeNull();
    } finally {
      released.resolve();
      await removing;
    }
    expect(await stat(folder).catch(() => null)).toBeNull();
  });

  it("stops what plays from the one removed, and deletes its record when asked", async () => {
    const app = await withTwo();
    const { roster, playback, viewing, dataDir, first, second, a, b } = app;
    await viewing.setFavourite(randomUUID(), { subscriptionId: a, id: "2014" }, true);
    await viewing.setFavourite(randomUUID(), { subscriptionId: b, id: "2014" }, true);
    const session = await playback.open({ subscriptionId: b, id: live(second) }, DECODERS);
    const stream = await watching(session.url);
    expect(second.activeStreams()).toBe(1);

    await roster.remove(b, true);

    await vi.waitFor(() => expect(second.activeStreams()).toBe(0));
    expect((await fetch(session.url)).status).toBe(410);
    stream.stop();
    await expect(
      playback.open({ subscriptionId: b, id: live(second) }, DECODERS),
    ).rejects.toMatchObject({ error: { kind: "no-subscription" } });
    // Its record is gone for good, and the other account's is whole.
    const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));
    const accounts = db.prepare("select distinct account from events").all();
    db.close();
    expect(accounts.map((row) => row["account"])).toEqual([`${first.url}|demo`]);
    const back = await roster.add(login(second));
    expect((await viewing.state()).favourites).toEqual([{ subscriptionId: a, id: "2014" }]);
    expect(back.id).not.toBe(b);
  });

  it.each(["queued", "erased"] as const)(
    "deletes with a record what was starred and saved for its subscription while it was removed (%s), and nothing of another's",
    async (held) => {
      const app = await withTwo();
      const { roster, removing, viewing, watchlist, second, a, b } = app;
      const saved = () => watchlist.list({ sort: "saved", offset: 0, limit: 10 });
      // Films each lists alone: the second's 91001 and 91020, and the first's 91000.
      await viewing.setFavourite(randomUUID(), { subscriptionId: b, id: "2014" }, true);
      await watchlist.save("movie", { subscriptionId: b, id: "91001" });

      const removal = await removing(b, held);
      // What the viewer does meanwhile, for the one that goes and for the one that stays.
      await Promise.allSettled([
        viewing.setFavourite(randomUUID(), { subscriptionId: b, id: "2015" }, true),
        watchlist.save("movie", { subscriptionId: b, id: "91020" }),
      ]);
      await viewing.setFavourite(randomUUID(), { subscriptionId: a, id: "2014" }, true);
      const kept = await watchlist.save("movie", { subscriptionId: a, id: "91000" });
      removal.release();
      await removal.done;

      // Added again, its account finds nothing of either, and the other's is whole.
      await roster.add(login(second));
      expect((await viewing.state()).favourites).toEqual([{ subscriptionId: a, id: "2014" }]);
      expect((await saved()).entries).toMatchObject([kept]);
    },
  );

  it("keeps a subscription whose record can't be deleted, with all of the record, to try again", async () => {
    const app = await withTwo();
    const { roster, subscriptions, viewing, watchlist, dataDir, second, a, b } = app;
    const saved = () => watchlist.list({ sort: "saved", offset: 0, limit: 10 });
    const database = (sql: string) => {
      const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));
      db.exec(sql);
      db.close();
    };
    await viewing.setFavourite(randomUUID(), { subscriptionId: b, id: "2014" }, true);
    const entry = await watchlist.save("movie", { subscriptionId: b, id: "91001" });
    // The database gives out at the watchlist, after the favourites went.
    database(`create trigger held before delete on watchlist
              begin select raise(abort, 'database is locked'); end`);

    await expect(roster.remove(b, true)).rejects.toMatchObject({ error: { kind: "unexpected" } });

    // Saved as it was, with everything it kept, and what is saved for it now is stored.
    expect((await subscriptions.list()).map((each) => each.id)).toEqual([a, b]);
    expect(await readdir(join(dataDir, "subscriptions"))).toEqual([b]);
    expect((await viewing.state()).favourites).toEqual([{ subscriptionId: b, id: "2014" }]);
    const other = await watchlist.save("movie", { subscriptionId: b, id: "91020" });
    expect((await saved()).entries).toMatchObject([other, entry]);

    database("drop trigger held");
    await roster.remove(b, true);

    expect((await subscriptions.list()).map((each) => each.id)).toEqual([a]);
    await roster.add(login(second));
    expect((await viewing.state()).favourites).toEqual([]);
    expect(await saved()).toEqual({ total: 0, entries: [] });
  });

  it("brings each subscription up to date on its own, whatever becomes of another", async () => {
    const dataDir = await tempDir();
    const [down, up] = [await fakeProvider(), await fakeProvider({ channels: 200 })];
    const app = await started(dataDir);
    const a = (await app.subscriptions.add(login(down))).id;
    const b = (await app.subscriptions.add(login(up))).id;
    down.failCatalogue(500);
    down.serveGuide(500);
    down.failTitles(500);

    await app.roster.refreshDue();

    expect(await app.library.status()).toMatchObject([
      { subscriptionId: a, fetchedAt: null, failure: { kind: "provider-error", status: 500 } },
      { subscriptionId: b, fetchedAt: expect.any(Number), failure: null },
    ]);
    expect(await app.guide.status()).toMatchObject([
      { subscriptionId: a, availability: "unknown" },
      { subscriptionId: b, availability: "available" },
    ]);
    expect((await app.onDemand.status()).lists).toMatchObject([
      { subscriptionId: a, fetchedAt: null, failure: { kind: "provider-error", status: 500 } },
      { subscriptionId: b, fetchedAt: expect.any(Number), failure: null },
    ]);
    // What is there shows, without the one that never answered.
    expect(new Set((await app.library.channels({})).map((each) => each.subscriptionId))).toEqual(
      new Set([b]),
    );
  });

  it("fetches a subscription's lists again under a password entered again, and no other's", async () => {
    const { roster, library, onDemand, guide, first, second, a, b } = await withTwo();
    await guide.refresh(a);
    await guide.refresh(b);
    const before = await library.status();
    const titles = (await onDemand.status()).lists;
    const guides = [first.guideRequests(), second.guideRequests()];
    for (const provider of [first, second]) {
      provider.failCatalogue(500);
      provider.failTitles(500);
    }

    await roster.update(b, { secret: "demo" });

    // Asked under its new login, which its provider refuses this once; the other isn't asked.
    await vi.waitFor(async () =>
      expect(await library.status()).toMatchObject([
        { subscriptionId: a, failure: null, fetchedAt: before[0]?.fetchedAt },
        { subscriptionId: b, failure: { kind: "provider-error", status: 500 } },
      ]),
    );
    // Its guide and its movies and series as well, though they were loaded a moment ago.
    await vi.waitFor(
      async () => {
        expect([first.guideRequests(), second.guideRequests()]).toEqual([
          guides[0],
          (guides[1] ?? 0) + 1,
        ]);
        expect((await onDemand.status()).lists).toMatchObject([
          { subscriptionId: a, failure: null, fetchedAt: titles[0]?.fetchedAt },
          { subscriptionId: b, failure: { kind: "provider-error", status: 500 } },
        ]);
      },
      { timeout: 20_000 },
    );
    first.failTitles(null);
    second.failTitles(null);
    // A new name asks no provider anything.
    second.failCatalogue(null);
    first.failCatalogue(null);
    const renamed = await roster.update(a, { name: "Northline" });
    expect(renamed).toMatchObject({ id: a, name: "Northline" });
    expect((await library.status())[0]).toMatchObject({ fetchedAt: before[0]?.fetchedAt });
  });
});
