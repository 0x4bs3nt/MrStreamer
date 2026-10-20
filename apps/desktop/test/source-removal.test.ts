import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { Settings } from "../src/main/services/preferences.ts";
import { startFakePlaylist } from "./fake-playlist.ts";
import { ViewingRecord } from "@mrstreamer/core/viewing/service";
import { mainLayer } from "../src/main/runtime.ts";
import { Library } from "../src/main/services/library.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

const boundary = vi.hoisted(() => ({
  next: null as null | { directory: string; arrived: () => void; released: Promise<void> },
  failure: null as null | { path: string; arrived: () => void; released: Promise<void> },
  deleting: null as null | { path: string; arrived: () => void; released: Promise<void> },
  reading: null as null | { path: string; arrived: () => void; released: Promise<void> },
}));

// Hold the external filesystem operation, after Library accepted the provider response.
// Every other filesystem operation and all services remain real.
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    mkdir: async (...args: Parameters<typeof real.mkdir>) => {
      const held = boundary.next;
      if (held && String(args[0]) === held.directory) {
        boundary.next = null;
        held.arrived();
        await held.released;
      }
      return real.mkdir(...args);
    },
    rm: async (...args: Parameters<typeof real.rm>) => {
      const held = boundary.deleting;
      if (held && String(args[0]) === held.path) {
        boundary.deleting = null;
        held.arrived();
        await held.released;
      }
      const failed = boundary.failure;
      if (failed && String(args[0]) === failed.path) {
        boundary.failure = null;
        failed.arrived();
        await failed.released;
        throw Object.assign(new Error("simulated filesystem refusal"), { code: "EACCES" });
      }
      return real.rm(...args);
    },
    readFile: async (...args: Parameters<typeof real.readFile>) => {
      const held = boundary.reading;
      if (held && String(args[0]) === held.path) {
        boundary.reading = null;
        held.arrived();
        await held.released;
      }
      return real.readFile(...args);
    },
  };
});

afterEach(() => {
  boundary.next = null;
  boundary.failure = null;
  boundary.reading = null;
  boundary.deleting = null;
});

it("settles a refresh before its first scheduler turn and lets the saved source refresh again", async () => {
  const dataDir = await tempDir();
  const runtime = runtimeFor(mainLayer(testConfig(dataDir)));
  const subscriptions = await promised(runtime, Subscriptions);
  const provider = await fakeProvider();
  const { id } = await subscriptions.add({
    server: provider.url,
    username: "demo",
    password: "demo",
  });
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const library = yield* Library;
      const saved = (yield* (yield* Subscriptions).saved).find((source) => source.id === id)!;
      const refresh = yield* Effect.forkChild(Effect.exit(library.refresh(id)), {
        startImmediately: true,
      });
      // Let admission finish through microtasks without giving the new owner a scheduler turn.
      yield* Effect.forEach(
        Array.from({ length: 20 }),
        () => Effect.promise(() => Promise.resolve()),
        { discard: true },
      );
      const forgotten = yield* Effect.exit(library.forget(saved).pipe(Effect.timeout("2 seconds")));
      yield* Fiber.await(refresh);
      const later = yield* Effect.exit(library.refresh(id).pipe(Effect.timeout("5 seconds")));
      return { forgotten, later };
    }),
  );
  expect(Exit.isSuccess(result.forgotten), "forget must settle an owner that has not started").toBe(
    true,
  );
  expect(Exit.isSuccess(result.later), "the saved source must remain refreshable").toBe(true);
});

it.each([
  { kind: "original", cancel: false },
  { kind: "added", cancel: false },
  { kind: "original", cancel: true },
  { kind: "added", cancel: true },
])(
  "settles an admitted $kind catalogue write before removal, cancelled=$cancel",
  async ({ kind, cancel }) => {
    const dataDir = await tempDir();
    const runtime = runtimeFor(mainLayer(testConfig(dataDir)));
    const subscriptions = await promised(runtime, Subscriptions);
    const library = await promised(runtime, Library);
    const roster = await runtime.runPromise(Roster);
    const first = await fakeProvider();
    const login = (server: string) => ({ server, username: "demo", password: "demo" });
    let id = (await subscriptions.add(login(first.url))).id;
    if (kind === "added") {
      const second = await fakeProvider({ second: true });
      id = (await subscriptions.add(login(second.url))).id;
    }
    await library.refresh(id);
    const folder = kind === "original" ? dataDir : join(dataDir, "subscriptions", id);
    const arrived = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    boundary.next = { directory: folder, arrived: arrived.resolve, released: released.promise };
    const refresh = library.refresh(id).then(
      () => null,
      (cause: unknown) => cause,
    );
    await arrived.promise;
    let returned = false;
    const fiber = runtime.runFork(roster.remove(id, false));
    const removal = runtime.runPromise(Fiber.await(fiber)).then((exit) => {
      returned = true;
      return exit;
    });
    let interrupting: Promise<unknown> | undefined;
    try {
      // Its login goes first; the removal then waits for the write the refresh began.
      const login =
        kind === "original"
          ? join(dataDir, "subscription.json")
          : join(folder, "subscription.json");
      await vi.waitFor(async () => expect(await stat(login).catch(() => null)).toBeNull());
      if (cancel) interrupting = runtime.runPromise(Fiber.interrupt(fiber));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(returned, "removal must not return past an admitted write").toBe(false);
    } finally {
      released.resolve();
      boundary.next = null;
    }
    expect(Exit.isSuccess(await removal)).toBe(!cancel);
    await interrupting;
    expect(await refresh).toMatchObject({
      error: { kind: "unexpected", detail: "The subscription changed while loading channels." },
    });
    expect((await subscriptions.list()).some((source) => source.id === id)).toBe(false);
    const surviving = kind === "original" ? join(folder, "catalogue.json") : folder;
    expect(
      await stat(surviving).catch(() => null),
      "an admitted write must not recreate removed source storage",
    ).toBeNull();
    await runtime.dispose();
    const restarted = runtimeFor(mainLayer(testConfig(dataDir)));
    expect(
      (await (await promised(restarted, Subscriptions)).list()).some((source) => source.id === id),
    ).toBe(false);
  },
  30_000,
);

it("does not return a removed source from a viewing read held on another source's catalogue", async () => {
  const dataDir = await tempDir();
  let runtime = runtimeFor(mainLayer(testConfig(dataDir)));
  let subscriptions = await promised(runtime, Subscriptions);
  let viewing = await promised(runtime, ViewingRecord);
  const library = await promised(runtime, Library);
  const aProvider = await fakeProvider();
  const bProvider = await fakeProvider({ second: true });
  const login = (server: string) => ({ server, username: "demo", password: "demo" });
  const { id: a } = await subscriptions.add(login(aProvider.url));
  const { id: b } = await subscriptions.add(login(bProvider.url));
  await library.refresh(a);
  await library.refresh(b);
  await viewing.setFavourite(randomUUID(), { subscriptionId: a, id: "1000" }, true);
  await viewing.setFavourite(randomUUID(), { subscriptionId: b, id: "1000" }, true);
  await runtime.dispose();
  runtime = runtimeFor(mainLayer(testConfig(dataDir)));
  subscriptions = await promised(runtime, Subscriptions);
  viewing = await promised(runtime, ViewingRecord);
  const roster = await promised(runtime, Roster);
  const arrived = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  boundary.reading = {
    path: join(dataDir, "catalogue.json"),
    arrived: arrived.resolve,
    released: released.promise,
  };
  const pending = viewing.state();
  try {
    await arrived.promise;
    await roster.remove(b, false);
  } finally {
    released.resolve();
    boundary.reading = null;
  }
  expect((await subscriptions.list()).map((each) => each.id)).toEqual([a]);
  expect((await pending).favourites.map((each) => each.subscriptionId)).toEqual([a]);
}, 30_000);

// R2-02, roll-forward form: once its login went, a failed cache deletion finishes the removal
// and never saves an excluded source again.
it("finishes removing a source whose cache deletion fails after its login went", async () => {
  const dataDir = await tempDir();
  let runtime = runtimeFor(mainLayer(testConfig(dataDir)));
  let subscriptions = await promised(runtime, Subscriptions);
  const library = await promised(runtime, Library);
  const onDemand = await promised(runtime, OnDemand);
  const provider = await fakeProvider();
  const { id } = await subscriptions.add({
    server: provider.url,
    username: "demo",
    password: "demo",
  });
  await library.refresh(id);
  await onDemand.refresh(id);
  const arrived = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  boundary.failure = {
    path: join(dataDir, "catalogue.json"),
    arrived: arrived.resolve,
    released: released.promise,
  };
  const warnings: string[] = [];
  const rawRoster = await runtime.runPromise(Roster);
  const removal = runtime
    .runPromise(
      rawRoster
        .remove(id, false)
        .pipe(
          Effect.provideService(
            Logger.CurrentLoggers,
            new Set([
              Logger.make(({ message }) =>
                warnings.push(String(Array.isArray(message) ? message[0] : message)),
              ),
            ]),
          ),
        ),
    )
    .then(
      () => "removed",
      () => "refused",
    );
  try {
    await arrived.promise;
  } finally {
    released.resolve();
    boundary.failure = null;
  }
  expect(await removal).toBe("removed");
  expect(warnings).toContain("[storage] removal cleanup failed");
  expect(await subscriptions.list()).toEqual([]);
  expect((await onDemand.status()).lists).toEqual([]);
  expect(await stat(join(dataDir, "subscription.json")).catch(() => null)).toBeNull();
  await runtime.dispose();
  runtime = runtimeFor(mainLayer(testConfig(dataDir)));
  subscriptions = await promised(runtime, Subscriptions);
  expect(await subscriptions.list(), "the removal holds after a restart").toEqual([]);
}, 30_000);

it.each([false, true])(
  "keeps a source usable when login deletion refuses, cancelled=%s",
  async (cancel) => {
    const dataDir = await tempDir();
    let runtime = runtimeFor(mainLayer(testConfig(dataDir)));
    let subscriptions = await promised(runtime, Subscriptions);
    const library = await promised(runtime, Library);
    const onDemand = await promised(runtime, OnDemand);
    const roster = await runtime.runPromise(Roster);
    const provider = await fakeProvider();
    const { id } = await subscriptions.add({
      server: provider.url,
      username: "demo",
      password: "demo",
    });
    await library.refresh(id);
    await onDemand.refresh(id);
    const viewing = await promised(runtime, ViewingRecord);
    const favourite = { subscriptionId: id, id: "1000" };
    await viewing.setFavourite(randomUUID(), favourite, true);
    const arrived = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    boundary.failure = {
      path: join(dataDir, "subscription.json"),
      arrived: arrived.resolve,
      released: released.promise,
    };
    const fiber = runtime.runFork(roster.remove(id, cancel));
    const removal = runtime.runPromise(Fiber.await(fiber));
    let interrupting: Promise<unknown> | undefined;
    let interrupted = false;
    try {
      await arrived.promise;
      if (cancel) {
        interrupting = runtime.runPromise(Fiber.interrupt(fiber)).then(() => {
          interrupted = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(interrupted, "rollback must wait for native deletion to settle").toBe(false);
      }
    } finally {
      released.resolve();
      boundary.failure = null;
    }
    expect(Exit.isFailure(await removal)).toBe(true);
    await interrupting;
    // Successful optional erasure stays committed even when login deletion then refuses.
    expect((await viewing.state()).favourites).toEqual(cancel ? [] : [favourite]);
    expect((await subscriptions.list()).map((each) => each.id)).toEqual([id]);
    expect((await onDemand.status()).lists.map((each) => each.subscriptionId)).toEqual([id]);
    expect(
      (await library.status()).map((each) => [each.subscriptionId, each.channelCount > 0]),
    ).toEqual([[id, true]]);
    await library.refresh(id);
    await runtime.dispose();
    runtime = runtimeFor(mainLayer(testConfig(dataDir)));
    subscriptions = await promised(runtime, Subscriptions);
    expect((await subscriptions.list()).map((each) => each.id)).toEqual([id]);
  },
  30_000,
);

// All three callers must still see the old writer while it is settling. Removing its map
// entry before awaiting interrupt makes the second replacement escape that wait.
it.each(["original", "added"])(
  "settles the old %s writer with competing newer-login refreshes and removal",
  async (kind) => {
    const dataDir = await tempDir();
    const runtime = runtimeFor(mainLayer(testConfig(dataDir)));
    const subscriptions = await promised(runtime, Subscriptions);
    const library = await promised(runtime, Library);
    const roster = await promised(runtime, Roster);
    const first = await fakeProvider();
    let id = (await subscriptions.add({ server: first.url, username: "demo", password: "demo" }))
      .id;
    if (kind === "added") {
      const second = await fakeProvider({ second: true });
      id = (await subscriptions.add({ server: second.url, username: "demo", password: "demo" })).id;
    }
    await library.refresh(id);
    const folder = kind === "original" ? dataDir : join(dataDir, "subscriptions", id);
    const arrived = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    boundary.next = { directory: folder, arrived: arrived.resolve, released: released.promise };
    const old = library.refresh(id).then(
      () => "accepted",
      () => "refused",
    );
    await arrived.promise;
    await subscriptions.update(id, { secret: "demo" });
    let replacementReturned = false;
    const newer = library.refresh(id).then(
      () => {
        replacementReturned = true;
        return "accepted";
      },
      () => "refused",
    );
    // Give the first replacement a turn at the held old writer, then start another.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const newest = library.refresh(id).then(
      () => "accepted",
      () => "refused",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    let removed = false;
    const removal = roster.remove(id, false).then(() => {
      removed = true;
    });
    try {
      await vi.waitFor(async () =>
        expect((await subscriptions.list()).some((source) => source.id === id)).toBe(false),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(removed, "removal must still own the older admitted write").toBe(false);
      expect(replacementReturned, "a newer login cannot write beside the old native write").toBe(
        false,
      );
    } finally {
      released.resolve();
    }
    await removal;
    expect(await Promise.all([old, newer, newest])).toEqual(["refused", "refused", "refused"]);
    expect(
      await stat(kind === "original" ? join(folder, "catalogue.json") : folder).catch(() => null),
    ).toBeNull();
  },
  30_000,
);

it.each(["login", "folder"])(
  "cancellation waits for an admitted native %s deletion and terminal cleanup",
  async (held) => {
    const dataDir = await tempDir();
    const runtime = runtimeFor(mainLayer(testConfig(dataDir)));
    const subscriptions = await promised(runtime, Subscriptions);
    const library = await promised(runtime, Library);
    const rawRoster = await runtime.runPromise(Roster);
    const first = await fakeProvider();
    const second = await fakeProvider({ second: true });
    const a = (await subscriptions.add({ server: first.url, username: "demo", password: "demo" }))
      .id;
    const b = (await subscriptions.add({ server: second.url, username: "demo", password: "demo" }))
      .id;
    await library.refresh(b);
    const folder = join(dataDir, "subscriptions", b);
    const arrived = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    boundary.deleting = {
      path: held === "login" ? join(folder, "subscription.json") : folder,
      arrived: arrived.resolve,
      released: released.promise,
    };
    const fiber = runtime.runFork(rawRoster.remove(b, false));
    await arrived.promise;
    let interrupted = false;
    const interrupting = runtime.runPromise(Fiber.interrupt(fiber)).then(() => {
      interrupted = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(interrupted, "the owner must not leave a native deletion running").toBe(false);
      expect((await subscriptions.list()).map((source) => source.id)).toEqual([a]);
    } finally {
      released.resolve();
    }
    await interrupting;
    expect(await stat(folder).catch(() => null)).toBeNull();
    await runtime.dispose();
    const restarted = runtimeFor(mainLayer(testConfig(dataDir)));
    expect(
      (await (await promised(restarted, Subscriptions)).list()).map((source) => source.id),
    ).toEqual([a]);
  },
  30_000,
);

it("cancelling the reversible erase restores the source before any cache teardown", async () => {
  const dataDir = await tempDir();
  const runtime = runtimeFor(mainLayer(testConfig(dataDir)));
  const subscriptions = await promised(runtime, Subscriptions);
  const library = await promised(runtime, Library);
  const titles = await promised(runtime, OnDemand);
  const provider = await fakeProvider();
  const { id } = await subscriptions.add({
    server: provider.url,
    username: "demo",
    password: "demo",
  });
  await library.refresh(id);
  await titles.refresh(id);
  const raw = await runtime.runPromise(Subscriptions);
  const arrived = Promise.withResolvers<void>();
  const fiber = runtime.runFork(
    raw.remove(id, { erase: Effect.andThen(Effect.sync(arrived.resolve), Effect.never) }),
  );
  await arrived.promise;
  await runtime.runPromise(Fiber.interrupt(fiber));
  expect((await subscriptions.list()).map((source) => source.id)).toEqual([id]);
  expect((await titles.status()).lists.map((list) => list.subscriptionId)).toEqual([id]);
  await library.refresh(id);
  expect(await stat(join(dataDir, "subscription.json"))).toBeTruthy();
}, 30_000);

it.each([
  { erase: false, cancelWrite: false, original: false },
  { erase: true, cancelWrite: false, original: false },
  { erase: false, cancelWrite: true, original: false },
  { erase: true, cancelWrite: true, original: true },
])(
  "settles a queued-turn preference write, $erase erase / $cancelWrite cancel / $original original",
  async ({ erase, cancelWrite, original }) => {
    const dataDir = await tempDir();
    const playlist = await startFakePlaylist();
    const runtime = runtimeFor(mainLayer(testConfig(dataDir)));
    const subscriptions = await promised(runtime, Subscriptions);
    const library = await promised(runtime, Library);
    const rawSettings = await runtime.runPromise(Settings);
    const provider = await fakeProvider({ second: true });
    const providerLogin = { server: provider.url, username: "demo", password: "demo" };
    const playlistLogin = { server: playlist.link, username: "", password: "" };
    const first = (await subscriptions.add(original ? providerLogin : playlistLogin)).id;
    const second = (await subscriptions.add(original ? playlistLogin : providerLogin)).id;
    const [a, b] = original ? [second, first] : [first, second];
    await library.refresh(a);
    await library.refresh(b);
    const services = await runtime.context();
    const rawSubscriptions = Context.get(services, Subscriptions);
    const queued = Promise.withResolvers<void>();
    const go = Promise.withResolvers<void>();
    // The real removal is waiting for its storage turn, after Settings captured discovery.
    const slowed = Context.add(services, Subscriptions, {
      ...rawSubscriptions,
      remove: (id, steps) =>
        Effect.andThen(
          Effect.promise(() => {
            queued.resolve();
            return go.promise;
          }),
          rawSubscriptions.remove(id, steps),
        ),
    });
    const roster = await promised(
      runtimeFor(Roster.layer.pipe(Layer.provide(Layer.succeedContext(slowed)))),
      Roster,
    );
    const folder = original ? dataDir : join(dataDir, "subscriptions", b);
    let returned = false;
    const removal = roster.remove(b, erase).then(() => {
      returned = true;
    });
    await queued.promise;
    const arrived = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    boundary.next = { directory: folder, arrived: arrived.resolve, released: released.promise };
    const writing = runtime.runFork(rawSettings.updateSubscription(b, { lastCategoryId: "x" }));
    let cancelling: Promise<unknown> | undefined;
    const failedCache = Promise.withResolvers<void>();
    try {
      await arrived.promise;
      if (cancelWrite) cancelling = runtime.runPromise(Fiber.interrupt(writing));
      if (original) {
        // A sibling's EACCES must not interrupt Settings while its native write is held.
        boundary.failure = {
          path: join(dataDir, "catalogue.json"),
          arrived: failedCache.resolve,
          released: Promise.resolve(),
        };
      }
      go.resolve();
      await vi.waitFor(async () =>
        expect(await stat(join(folder, "subscription.json")).catch(() => null)).toBeNull(),
      );
      if (original) await failedCache.promise;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(returned, "Settings must settle its turn before the folder goes").toBe(false);
      expect(await stat(folder)).toBeTruthy();
    } finally {
      go.resolve();
      released.resolve();
    }
    try {
      const write = await runtime.runPromise(Fiber.await(writing));
      if (cancelWrite) expect(Exit.isFailure(write)).toBe(true);
      else expect(Exit.isSuccess(write)).toBe(true);
      await cancelling;
      await removal;
      if (!original) expect(await stat(folder).catch(() => null)).toBeNull();
      expect(await stat(join(folder, "subscription.json")).catch(() => null)).toBeNull();
      expect((await subscriptions.list()).map((source) => source.id)).toEqual([a]);
    } finally {
      await runtime.dispose();
      await playlist.close();
    }
  },
  30_000,
);

it("logs a refused added-folder cleanup and startup finishes its committed removal", async () => {
  const dataDir = await tempDir();
  let runtime = runtimeFor(mainLayer(testConfig(dataDir)));
  let subscriptions = await promised(runtime, Subscriptions);
  const first = await fakeProvider();
  const second = await fakeProvider({ second: true });
  const a = (await subscriptions.add({ server: first.url, username: "demo", password: "demo" })).id;
  const b = (await subscriptions.add({ server: second.url, username: "demo", password: "demo" }))
    .id;
  const library = await promised(runtime, Library);
  await library.refresh(b);
  const folder = join(dataDir, "subscriptions", b);
  const arrived = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  boundary.failure = { path: folder, arrived: arrived.resolve, released: released.promise };
  const warnings: string[] = [];
  const roster = await runtime.runPromise(Roster);
  const removal = runtime.runPromise(
    roster
      .remove(b, false)
      .pipe(
        Effect.provideService(
          Logger.CurrentLoggers,
          new Set([
            Logger.make(({ message }) =>
              warnings.push(String(Array.isArray(message) ? message[0] : message)),
            ),
          ]),
        ),
      ),
  );
  try {
    await arrived.promise;
    expect(await stat(join(folder, "subscription.json")).catch(() => null)).toBeNull();
  } finally {
    released.resolve();
  }
  await removal;
  expect(warnings).toContain("[storage] removal cleanup failed");
  expect((await subscriptions.list()).map((source) => source.id)).toEqual([a]);
  expect(await stat(folder)).toBeTruthy();
  await runtime.dispose();
  runtime = runtimeFor(mainLayer(testConfig(dataDir)));
  subscriptions = await promised(runtime, Subscriptions);
  expect((await subscriptions.list()).map((source) => source.id)).toEqual([a]);
  expect(await stat(folder).catch(() => null)).toBeNull();
}, 30_000);
