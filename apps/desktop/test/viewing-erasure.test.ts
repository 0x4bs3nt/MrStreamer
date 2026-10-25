// Public viewing/watchlist commands held at their store boundary, on real SQLite and the app's
// saved roster. Removing with Also delete must stay erased when an older command resumes.
import { Failed } from "@mrstreamer/core/failure";
import { seriesEpisodeSeasons } from "@mrstreamer/core/ondemand/details";
import { seriesIdentity } from "@mrstreamer/core/viewing/marks";
import {
  LegacyViewing,
  ViewingAccount,
  ViewingChannels,
  ViewingRecord,
  ViewingSeries,
  ViewingStore,
} from "@mrstreamer/core/viewing/service";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it, onTestFinished } from "vitest";
import { databaseLayer } from "../src/main/platform/database.ts";
import { viewingStoreLayer } from "../src/main/platform/viewing-store.ts";
import { WatchlistStore, watchlistStoreLayer } from "../src/main/platform/watchlist-store.ts";
import { mainLayer, viewingAccount } from "../src/main/runtime.ts";
import { Library } from "../src/main/services/library.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { Watchlist } from "../src/main/services/watchlist.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

/** Holds the next write before its actual SQLite transaction starts. */
function writeGate() {
  let next: { arrived: () => void; released: Promise<void> } | null = null;
  return {
    wait: Effect.suspend(() => {
      const held = next;
      next = null;
      if (!held) return Effect.void;
      held.arrived();
      return Effect.promise(() => held.released);
    }),
    hold() {
      const arrived = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      next = { arrived: arrived.resolve, released: released.promise };
      onTestFinished(() => released.resolve());
      return { arrived: arrived.promise, release: () => released.resolve() };
    },
  };
}

async function erasureApp() {
  const dataDir = await tempDir();
  const providers = [await fakeProvider(), await fakeProvider({ second: true })] as const;
  const login = (of: 0 | 1) => ({ server: providers[of].url, username: "demo", password: "demo" });
  const runtime = runtimeFor(mainLayer(testConfig(dataDir)));
  const services = await runtime.context();
  const subscriptions = Context.get(services, Subscriptions);
  const library = Context.get(services, Library);
  const onDemand = Context.get(services, OnDemand);
  const roster = await promised(runtime, Roster);
  const a = (await roster.add(login(0))).id;
  const b = (await roster.add(login(1))).id;
  await runtime.runPromise(
    Effect.forEach([a, b], (id) => Effect.andThen(library.refresh(id), onDemand.refresh(id))),
  );

  const stores = runtimeFor(
    Layer.mergeAll(viewingStoreLayer, watchlistStoreLayer).pipe(
      Layer.provide(databaseLayer(dataDir)),
    ),
  );
  const viewingStore = await stores.runPromise(ViewingStore);
  const watchlistStore = await stores.runPromise(WatchlistStore);
  const viewingGate = writeGate();
  const watchlistGate = writeGate();
  const record = runtimeFor(
    ViewingRecord.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ViewingStore, {
            ...viewingStore,
            commit: (input) => Effect.andThen(viewingGate.wait, viewingStore.commit(input)),
          }),
          Layer.succeed(ViewingAccount, viewingAccount(subscriptions)),
          Layer.succeed(ViewingChannels, { lookup: library.lookup }),
          Layer.succeed(ViewingSeries, {
            identity: (series) =>
              Effect.map(onDemand.titles("series", [series]), ([title]) =>
                seriesIdentity(series, title),
              ),
            seasons: (series) =>
              Effect.map(onDemand.details("series", series), (details) =>
                details.kind === "series" ? seriesEpisodeSeasons(details) : [],
              ),
          }),
          Layer.succeed(LegacyViewing, { take: Effect.succeed(null), drop: Effect.void }),
        ),
      ),
    ),
  );
  const saving = runtimeFor(
    Watchlist.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeedContext(services),
          Layer.succeed(WatchlistStore, {
            ...watchlistStore,
            save: (input) => Effect.andThen(watchlistGate.wait, watchlistStore.save(input)),
            remove: (input) => Effect.andThen(watchlistGate.wait, watchlistStore.remove(input)),
          }),
        ),
      ),
    ),
  );
  const viewing = await promised(record, ViewingRecord);
  const watchlist = await promised(saving, Watchlist);
  return {
    dataDir,
    runtime,
    services,
    subscriptions,
    roster,
    a,
    b,
    viewing,
    watchlist,
    viewingGate,
    watchlistGate,
    add: (of: 0 | 1) => roster.add(login(of)),
    list: () => watchlist.list({ sort: "saved", offset: 0, limit: 100 }),
    removing: async () => {
      const held = writeGate();
      const paused = held.hold();
      const viewing = Context.get(services, ViewingRecord);
      const refused = new Failed({ error: { kind: "unexpected", detail: "Erase refused." } });
      const failing = Context.add(services, ViewingRecord, {
        ...viewing,
        erase: () => Effect.andThen(held.wait, Effect.fail(refused)),
      });
      const removal = await promised(
        runtimeFor(Roster.layer.pipe(Layer.provide(Layer.succeedContext(failing)))),
        Roster,
      );
      const done = removal.remove(b, true).then(
        () => null,
        (error: unknown) => error,
      );
      await paused.arrived;
      return { done, release: paused.release, refused };
    },
  };
}

describe("viewing-data erasure with pending writes", { timeout: 30_000 }, () => {
  it("keeps a favourite erased when its older write resumes", async () => {
    const app = await erasureApp();
    const held = app.viewingGate.hold();
    const command = app.viewing
      .setFavourite("late-favourite", { subscriptionId: app.b, id: "1" }, true)
      .then(
        () => null,
        (error: unknown) => error,
      );
    await held.arrived;
    await app.roster.remove(app.b, true);
    held.release();
    const result = await command;
    const back = (await app.add(1)).id;
    expect((await app.viewing.state()).favourites).toEqual([]);
    expect(result).toMatchObject({ error: { kind: "no-subscription" } });
    // A refused command kept no receipt: the same id can record a new action after re-adding.
    await app.viewing.setFavourite("late-favourite", { subscriptionId: back, id: "1" }, true);
    expect((await app.viewing.state()).favourites).toEqual([{ subscriptionId: back, id: "1" }]);
  });

  it("keeps a title erased when its older watchlist save resumes", async () => {
    const app = await erasureApp();
    const held = app.watchlistGate.hold();
    const command = app.watchlist.save("movie", { subscriptionId: app.b, id: "91001" }).then(
      () => null,
      (error: unknown) => error,
    );
    await held.arrived;
    await app.roster.remove(app.b, true);
    held.release();
    const result = await command;
    await app.add(1);
    expect((await app.list()).entries).toEqual([]);
    expect(result).toMatchObject({ error: { kind: "no-subscription" } });
  });

  it.each(["history", "progress", "mark"] as const)(
    "keeps %s erased when an older write resumes",
    async (kind) => {
      const app = await erasureApp();
      const held = app.viewingGate.hold();
      const channel = { subscriptionId: app.b, id: "1" };
      const write = () => {
        if (kind === "history") return app.viewing.recordWatch("late-watch", channel);
        if (kind === "progress")
          return app.viewing.recordProgress(
            "late-progress",
            {
              kind: "movie",
              subscriptionId: app.b,
              id: "90001",
            },
            600,
            5400,
            1,
          );
        return app.viewing.markEpisode(
          "late-mark",
          {
            kind: "episode",
            subscriptionId: app.b,
            id: "81000",
            seriesId: "80000",
            season: 1,
            episode: 1,
          },
          true,
        );
      };
      const command = write().then(
        () => null,
        (error: unknown) => error,
      );
      await held.arrived;
      await app.roster.remove(app.b, true);
      held.release();
      const result = await command;
      const back = (await app.add(1)).id;
      expect(await app.viewing.state()).toMatchObject({
        favourites: [],
        recent: [],
        continueWatching: [],
        marked: [],
      });
      expect(
        await app.viewing.progress({ movies: [{ subscriptionId: back, id: "90001" }] }),
      ).toEqual([]);
      expect(await app.viewing.episodes({ subscriptionId: back, id: "80000" })).toMatchObject({
        progress: [],
        marks: [],
        undoable: null,
      });
      expect(result).toMatchObject({ error: { kind: "no-subscription" } });
    },
  );

  it("refuses a shared-title save wholly when one of its accounts was erased", async () => {
    const app = await erasureApp();
    const held = app.watchlistGate.hold();
    const command = app.watchlist.save("movie", { subscriptionId: app.a, id: "91001" }).then(
      () => null,
      (error: unknown) => error,
    );
    await held.arrived;
    await app.roster.remove(app.b, true);
    held.release();
    const result = await command;
    await app.add(1);
    expect((await app.list()).entries).toEqual([]);
    expect(result).toMatchObject({ error: { kind: "no-subscription" } });
  });

  it("commits the other account's pending writes while an account is erased", async () => {
    const app = await erasureApp();
    const viewing = app.viewingGate.hold();
    const saving = app.watchlistGate.hold();
    const favourite = app.viewing.setFavourite(
      "other-favourite",
      { subscriptionId: app.a, id: "1" },
      true,
    );
    const title = app.watchlist.save("movie", { subscriptionId: app.a, id: "91000" });
    await Promise.all([viewing.arrived, saving.arrived]);
    await app.roster.remove(app.b, true);
    viewing.release();
    saving.release();
    await Promise.all([favourite, title]);
    await app.add(1);
    expect((await app.viewing.state()).favourites).toEqual([{ subscriptionId: app.a, id: "1" }]);
    expect((await app.list()).entries.map((entry) => entry.subscriptionId)).toEqual([app.a]);
  });

  it.each(["viewing", "watchlist"] as const)(
    "retries the same %s command after a failed erase restores the source",
    async (kind) => {
      const app = await erasureApp();
      const held = (kind === "viewing" ? app.viewingGate : app.watchlistGate).hold();
      const write = () =>
        kind === "viewing"
          ? app.viewing.setFavourite("retry-favourite", { subscriptionId: app.b, id: "1" }, true)
          : app.watchlist.save("movie", { subscriptionId: app.b, id: "91001" });
      const command = write().then(
        () => null,
        (error: unknown) => error,
      );
      await held.arrived;
      const removal = await app.removing();
      held.release();
      expect(await command).toMatchObject({ error: { kind: "no-subscription" } });
      removal.release();
      expect(await removal.done).toBe(removal.refused);
      await write();
      expect(
        kind === "viewing"
          ? (await app.viewing.state()).favourites.length
          : (await app.list()).total,
      ).toBe(1);
      // Retrying the ordinary removal now succeeds and still erases that retried write.
      await app.roster.remove(app.b, true);
      await app.add(1);
      expect((await app.viewing.state()).favourites).toEqual([]);
      expect((await app.list()).entries).toEqual([]);
    },
  );

  it("leaves an away account's saved shared title when another account removes its entry", async () => {
    const app = await erasureApp();
    const entry = await app.watchlist.save("movie", { subscriptionId: app.a, id: "91001" });
    const held = app.watchlistGate.hold();
    const command = app.watchlist.remove(entry);
    await held.arrived;
    await app.roster.remove(app.b, false);
    held.release();
    await command;
    const back = (await app.add(1)).id;
    expect((await app.list()).entries.map((saved) => saved.subscriptionId)).toEqual([back]);
  });

  it("keeps an away account's watchlist when its old removal resumes", async () => {
    const app = await erasureApp();
    const entry = await app.watchlist.save("movie", { subscriptionId: app.b, id: "91001" });
    const held = app.watchlistGate.hold();
    const command = app.watchlist.remove(entry).then(
      () => null,
      (error: unknown) => error,
    );
    await held.arrived;
    await app.roster.remove(app.b, false);
    held.release();
    expect(await command).toMatchObject({ error: { kind: "no-subscription" } });
    const back = (await app.add(1)).id;
    expect((await app.list()).entries.map((saved) => saved.subscriptionId)).toEqual([back]);
  });
});
