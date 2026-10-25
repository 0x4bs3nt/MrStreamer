// Programme reminders through the app's services, against the fake provider and a guide served
// for the test, with a test clock the test moves and a stand-in for the system's notifications.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { Guide } from "@mrstreamer/core/guide/service";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it, vi } from "vitest";
import { mainLayer } from "../src/main/runtime.ts";
import { Library } from "../src/main/services/library.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { Reminders, type Notifier } from "../src/main/services/reminders.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import type { FakeProvider } from "./fake-provider.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

// Each guide download is indexed in a worker thread started from source.
vi.setConfig({ testTimeout: 20_000 });

const MINUTE = 60_000;
/** 20:10 in the guide's +02:00. */
const NOW = Date.parse("2026-10-02T20:10:00+02:00");
const at = (time: string) => Date.parse(`2026-10-02T${time}:00+02:00`);

/** A programme on a guide channel that day, "2030" to "2130". */
const programme = (id: string, from: string, to: string, title: string) =>
  `<programme start="20261002${from}00 +0200" stop="20261002${to}00 +0200" channel="${id}"><title>${title}</title><desc>About ${title}.</desc></programme>`;
const tv = (...programmes: string[]) =>
  `<?xml version="1.0" encoding="utf-8" ?><tv>${programmes.join("")}</tv>`;

/** The evening on a guide channel: on now, then two to come. */
const evening = (id: string) => [
  programme(id, "2000", "2030", "Evening News"),
  programme(id, "2030", "2130", "Ski Jumping"),
  programme(id, "2130", "2300", "Late Film"),
];

/**
 * The system's notifications, as the test sees what was asked of them and answers for them. Each
 * notice also notes how reminders.json at `file` kept its reminder as it was asked to show.
 */
function fakeNotifier(file: string, supported = true) {
  type Events = Parameters<Notifier["show"]>[1];
  const shown: { id: string; title: string; body: string }[] = [];
  const storedAtShow: unknown[] = [];
  const closed: string[] = [];
  const events = new Map<string, Events>();
  /** When set, the system says it couldn't show the next notice, or throws as it is asked. */
  let refuse: "no" | "fail" | "throw" = "no";
  const notifier: Notifier = {
    supported,
    show(notice, on) {
      if (refuse === "throw") throw new Error("The system broke.");
      const kept = JSON.parse(readFileSync(file, "utf8")) as {
        subscriptions: Record<string, { id: string; state: unknown }[]>;
      };
      storedAtShow.push(
        Object.values(kept.subscriptions)
          .flat()
          .find((each) => each.id === notice.id)?.state,
      );
      shown.push(notice);
      events.set(notice.id, on);
      if (refuse === "fail") on.failed();
      else on.shown();
    },
    close(id) {
      closed.push(id);
    },
  };
  return {
    notifier,
    shown,
    storedAtShow,
    closed,
    click: (id: string) => events.get(id)?.clicked(),
    refuseNext: (value: "no" | "fail" | "throw") => {
      refuse = value;
    },
  };
}

const login = (provider: { readonly url: string }) => ({
  server: provider.url,
  username: "demo",
  password: "demo",
});

/** A channel of the provider with a guide id, by its stream id and guide id. */
function guidedChannel(provider: FakeProvider) {
  const channel = provider.catalogue.channels.find(
    (each) => each.streamId >= 2000 && !each.offline && each.guideId && !each.adult,
  )!;
  return { id: String(channel.streamId), guideId: channel.guideId! };
}

/**
 * The app's services on one profile, connected to the fake provider with `evening` in its guide.
 * `start` starts the app at `time`, as again after a restart; one app runs per profile.
 */
async function reminding(options: { adultChannels?: boolean; supported?: boolean } = {}) {
  const provider = await fakeProvider({ adultChannels: options.adultChannels ?? false });
  const channel = guidedChannel(provider);
  provider.serveGuide(
    tv(...evening(channel.guideId), ...(options.adultChannels ? evening("afterhours.adult") : [])),
  );
  const dataDir = await tempDir();
  const notices = fakeNotifier(join(dataDir, "reminders.json"), options.supported);
  let owner: string | null = null;
  const start = async (time = NOW) => {
    const clock = Layer.effectDiscard(TestClock.setTime(time)).pipe(
      Layer.provideMerge(TestClock.layer({ warningDelay: "1 day" })),
    );
    const runtime = runtimeFor(
      mainLayer({ ...testConfig(dataDir), notifier: notices.notifier }).pipe(
        Layer.provideMerge(clock),
      ),
    );
    const subscriptions = await promised(runtime, Subscriptions);
    owner ??= (await subscriptions.add(login(provider))).id;
    const subscriptionId = owner;
    const reminders = await promised(runtime, Reminders);
    const guide = await promised(runtime, Guide);
    const own = (id: string): OwnedId => ({ subscriptionId, id });
    return {
      subscriptionId,
      own,
      reminders,
      guide,
      library: await promised(runtime, Library),
      settings: await promised(runtime, Settings),
      roster: await promised(runtime, Roster),
      /** The clock moves on to `time`, as it does while the app runs or the computer sleeps. */
      clockTo: (time: number) => runtime.runPromise(TestClock.setTime(time)),
      close: () => runtime.dispose(),
    };
  };
  const app = await start();
  await app.library.refresh(app.subscriptionId);
  await app.guide.refresh(app.subscriptionId);
  return { provider, channel, dataDir, notices, start, app };
}

/**
 * Runs `phase` with a folder where reminders.json is, which no write can replace, on every
 * system, then takes it away and puts back the file that was there, if any.
 */
async function unwritable(dataDir: string, phase: () => Promise<void>) {
  const path = join(dataDir, "reminders.json");
  const before = existsSync(path) ? await readFile(path) : null;
  await rm(path, { force: true });
  await mkdir(path);
  try {
    await phase();
  } finally {
    await rmdir(path);
    if (before) await writeFile(path, before);
  }
}

/** The provider lists the channel of stream `id` for adults from now on, as a panel may refile it. */
const forAdults = (provider: FakeProvider, id: string) =>
  provider.serveChannels((all) =>
    all.map((each) => (String(each.streamId) === id ? { ...each, adult: true } : each)),
  );

describe("programme reminders", () => {
  it("tells once at its start, in the window and from the system, and never again after a restart", async () => {
    const { app, channel, notices, start } = await reminding();
    const set = await app.reminders.set(app.own(channel.id), at("20:30"));
    expect(set).toMatchObject({
      title: "Ski Jumping",
      start: at("20:30"),
      stop: at("21:30"),
      status: { kind: "upcoming" },
      banner: false,
    });
    // Setting it again answers the one set.
    expect((await app.reminders.set(app.own(channel.id), at("20:30"))).id).toBe(set.id);

    await app.clockTo(at("20:29"));
    await app.reminders.check();
    expect(notices.shown).toEqual([]);

    await app.clockTo(at("20:30"));
    await app.reminders.check();
    await app.reminders.check();
    const name = (await app.library.channel(app.own(channel.id))).title;
    expect(notices.shown).toEqual([{ id: set.id, title: "Ski Jumping", body: `${name} · now` }]);
    expect((await app.reminders.list()).reminders).toMatchObject([
      { id: set.id, status: { kind: "told", at: at("20:30") }, banner: true },
    ]);

    await app.close();
    const again = await start(at("20:40"));
    await again.reminders.check();
    expect(notices.shown).toHaveLength(1);
    expect((await again.reminders.list()).reminders).toMatchObject([
      { id: set.id, status: { kind: "told" }, banner: false },
    ]);
  });

  it("tells on its own at its start, without being asked", async () => {
    const { app, channel, notices } = await reminding();
    const reminder = await app.reminders.set(app.own(channel.id), at("20:30"));
    // The clock runs on as the app's would, a quarter of a minute at a time.
    for (let time = NOW; notices.shown.length === 0 && time <= at("20:40"); time += MINUTE / 4) {
      await app.clockTo(time);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(notices.shown).toMatchObject([{ id: reminder.id, title: "Ski Jumping" }]);
    const [told] = (await app.reminders.list()).reminders;
    expect(told?.status.kind === "told" && told.status.at - at("20:30")).toBeLessThan(MINUTE);
  });

  it("refuses a programme that started or that the guide doesn't list at that time", async () => {
    const { app, channel } = await reminding();
    await expect(app.reminders.set(app.own(channel.id), at("20:00"))).rejects.toMatchObject({
      error: { kind: "reminder", reason: "started" },
    });
    await expect(app.reminders.set(app.own(channel.id), at("20:45"))).rejects.toMatchObject({
      error: { kind: "reminder", reason: "not-in-guide" },
    });
    expect((await app.reminders.list()).reminders).toEqual([]);
  });

  it("tells nothing once cancelled, and a cancel after it told closes its notice", async () => {
    const { app, channel, notices } = await reminding();
    const first = await app.reminders.set(app.own(channel.id), at("20:30"));
    const second = await app.reminders.set(app.own(channel.id), at("21:30"));
    await app.reminders.cancel(first.id);
    // Already gone: nothing changes.
    await app.reminders.cancel(first.id);

    await app.clockTo(at("20:30"));
    await app.reminders.check();
    expect(notices.shown).toEqual([]);

    await app.clockTo(at("21:30"));
    await app.reminders.check();
    expect(notices.shown.map((notice) => notice.id)).toEqual([second.id]);
    await app.reminders.cancel(second.id);
    expect(notices.closed).toEqual([second.id]);
    expect((await app.reminders.list()).reminders).toEqual([]);
  });

  it("never loses a cancel to a check under way, nor tells twice", async () => {
    const { app, channel, notices, start } = await reminding();
    const reminder = await app.reminders.set(app.own(channel.id), at("20:30"));
    await app.clockTo(at("20:30"));
    await Promise.all([
      app.reminders.check(),
      app.reminders.cancel(reminder.id),
      app.reminders.check(),
    ]);
    expect(notices.shown.length).toBeLessThanOrEqual(1);
    // Whatever told first, its notice went with the cancel.
    expect(notices.closed).toEqual(notices.shown.map((notice) => notice.id));
    expect((await app.reminders.list()).reminders).toEqual([]);

    await app.close();
    const again = await start(at("20:35"));
    await again.reminders.check();
    expect(notices.shown.length).toBeLessThanOrEqual(1);
    expect((await again.reminders.list()).reminders).toEqual([]);
  });

  it("follows the guide at its start time only: another title is changed, none is gone", async () => {
    const { app, provider, channel, notices } = await reminding();
    const reminder = await app.reminders.set(app.own(channel.id), at("20:30"));

    provider.serveGuide(
      tv(
        programme(channel.guideId, "2000", "2030", "Evening News"),
        programme(channel.guideId, "2030", "2200", "Ski Flying"),
      ),
    );
    await app.guide.refresh(app.subscriptionId);
    await app.reminders.check();
    expect((await app.reminders.list()).reminders).toMatchObject([
      {
        id: reminder.id,
        title: "Ski Flying",
        stop: at("22:00"),
        status: { kind: "changed", was: "Ski Jumping" },
      },
    ]);

    // Its title moved to another time: that is never followed.
    provider.serveGuide(
      tv(
        programme(channel.guideId, "2000", "2100", "News Special"),
        programme(channel.guideId, "2100", "2200", "Ski Jumping"),
      ),
    );
    await app.guide.refresh(app.subscriptionId);
    await app.reminders.check();
    expect((await app.reminders.list()).reminders).toMatchObject([
      { id: reminder.id, start: at("20:30"), status: { kind: "gone" } },
    ]);

    await app.clockTo(at("20:30"));
    await app.reminders.check();
    expect(notices.shown).toEqual([]);

    // Listed again while it is on, it tells.
    provider.serveGuide(tv(...evening(channel.guideId)));
    await app.guide.refresh(app.subscriptionId);
    await app.reminders.check();
    expect(notices.shown).toMatchObject([{ id: reminder.id, title: "Ski Jumping" }]);
  });

  it("keeps a reminder whose guide isn't read yet, and tells as it was set", async () => {
    const { app, provider, channel, dataDir, notices, start } = await reminding();
    await app.reminders.set(app.own(channel.id), at("20:30"));
    await app.close();
    // The next start finds no guide on disk, and its download never answers.
    await writeFile(join(dataDir, "guide.json"), "{");
    provider.serveGuide("hold");
    const again = await start(at("20:30"));
    await again.reminders.check();
    expect(notices.shown).toMatchObject([{ title: "Ski Jumping" }]);
  });

  it("is gone once the provider stops listing its channel, and back once it lists it again", async () => {
    const { app, provider, channel } = await reminding();
    const reminder = await app.reminders.set(app.own(channel.id), at("20:30"));

    provider.serveChannels((all) => all.filter((each) => String(each.streamId) !== channel.id));
    await app.library.refresh(app.subscriptionId);
    await app.reminders.check();
    expect((await app.reminders.list()).reminders).toMatchObject([
      { id: reminder.id, status: { kind: "gone" } },
    ]);

    provider.serveChannels((all) => all);
    await app.library.refresh(app.subscriptionId);
    await app.reminders.check();
    expect((await app.reminders.list()).reminders).toMatchObject([
      { id: reminder.id, status: { kind: "upcoming" } },
    ]);
  });

  it("started later than its start, tells once, late, while its programme is on, and misses one that ended", async () => {
    // As after the app was closed, or the computer slept: the check comes with the clock past both.
    const { app, channel, notices, start } = await reminding();
    const ended = await app.reminders.set(app.own(channel.id), at("20:30"));
    const on = await app.reminders.set(app.own(channel.id), at("21:30"));
    await app.close();

    const again = await start(at("22:00"));
    await again.reminders.check();
    await again.reminders.check();
    const name = (await again.library.channel(again.own(channel.id))).title;
    expect(notices.shown).toEqual([
      { id: on.id, title: "Late Film", body: `${name} · started 30 min ago` },
    ]);
    expect((await again.reminders.list()).reminders).toMatchObject([
      { id: ended.id, status: { kind: "missed" }, banner: false },
      { id: on.id, status: { kind: "told", at: at("22:00") }, banner: true },
    ]);
  });

  it("shows a channel for adults only while adults show, and never from the system", async () => {
    const { app, notices } = await reminding({ adultChannels: true });
    await app.settings.update({ adultTitles: true });
    const told = await app.reminders.set(app.own("4000"), at("20:30"));
    const hidden = await app.reminders.set(app.own("4000"), at("21:30"));

    await app.clockTo(at("20:30"));
    await app.reminders.check();
    expect(notices.shown).toEqual([]);
    expect((await app.reminders.list()).reminders).toMatchObject([
      { id: told.id, status: { kind: "told" }, banner: true },
      { id: hidden.id, status: { kind: "upcoming" } },
    ]);

    await app.settings.update({ adultTitles: false });
    expect((await app.reminders.list()).reminders).toEqual([]);
    await app.clockTo(at("21:30"));
    await app.reminders.check();

    await app.settings.update({ adultTitles: true });
    expect(notices.shown).toEqual([]);
    // Its notice in the window doesn't come back, and the one due while hidden was missed.
    expect((await app.reminders.list()).reminders).toMatchObject([
      { id: told.id, status: { kind: "told" }, banner: false },
      { id: hidden.id, status: { kind: "missed" }, banner: false },
    ]);
  });

  it("hides one that told, and closes its system notice, once its channel is for adults while they're hidden", async () => {
    const { app, provider, channel, notices } = await reminding();
    await app.settings.update({ adultTitles: false });
    const reminder = await app.reminders.set(app.own(channel.id), at("20:30"));
    await app.clockTo(at("20:30"));
    await app.reminders.check();
    expect(notices.shown.map((each) => each.id)).toEqual([reminder.id]);

    forAdults(provider, channel.id);
    await app.library.refresh(app.subscriptionId);
    expect((await app.library.lookup(app.subscriptionId))(channel.id)?.adult).toBe(true);
    // The new catalogue is enough: nothing else asks.
    await vi.waitFor(async () => expect((await app.reminders.list()).reminders).toEqual([]));
    expect(notices.closed).toEqual([reminder.id]);
    await app.clockTo(at("20:31") + 30_000);
    await app.reminders.check();
    expect((await app.reminders.list()).reminders).toEqual([]);
    // A click on what the system may still show brings nothing back.
    notices.click(reminder.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await app.reminders.list()).reminders).toEqual([]);

    // Shown again, it is as it was: told once, its notice in the window gone for good.
    await app.settings.update({ adultTitles: true });
    expect((await app.reminders.list()).reminders).toMatchObject([
      { id: reminder.id, status: { kind: "told" }, banner: false },
    ]);
    expect(notices.shown).toHaveLength(1);
  });

  it("keeps one that told listed while adults show, closing only its system notice, once its channel is for adults", async () => {
    const { app, provider, channel, notices } = await reminding();
    await app.settings.update({ adultTitles: true });
    const reminder = await app.reminders.set(app.own(channel.id), at("20:30"));
    await app.clockTo(at("20:30"));
    await app.reminders.check();

    forAdults(provider, channel.id);
    await app.library.refresh(app.subscriptionId);
    await app.reminders.check();
    // A channel for adults keeps no system notice, also while adults show; the window's stays.
    expect(notices.closed).toEqual([reminder.id]);
    expect((await app.reminders.list()).reminders).toMatchObject([
      { id: reminder.id, status: { kind: "told" }, banner: true },
    ]);
    expect(notices.shown).toHaveLength(1);
  });

  it("hides one that was missed once its channel is for adults while they're hidden", async () => {
    const { app, provider, channel, start } = await reminding();
    await app.settings.update({ adultTitles: false });
    const reminder = await app.reminders.set(app.own(channel.id), at("20:30"));
    await app.close();
    // Its programme ended while the app was closed.
    const again = await start(at("21:40"));
    await again.reminders.check();
    expect((await again.reminders.list()).reminders).toMatchObject([
      { id: reminder.id, status: { kind: "missed" } },
    ]);

    forAdults(provider, channel.id);
    await again.library.refresh(again.subscriptionId);
    await again.reminders.check();
    expect((await again.reminders.list()).reminders).toEqual([]);
    await again.settings.update({ adultTitles: true });
    expect((await again.reminders.list()).reminders).toMatchObject([
      { id: reminder.id, status: { kind: "missed" } },
    ]);
  });

  it("hides one that told even while reminders.json can't be written", async () => {
    const { app, provider, channel, dataDir, notices } = await reminding();
    await app.settings.update({ adultTitles: false });
    const reminder = await app.reminders.set(app.own(channel.id), at("20:30"));
    await app.clockTo(at("20:30"));
    await app.reminders.check();

    // A folder in its place: nothing can be written over it.
    const path = join(dataDir, "reminders.json");
    await rm(path);
    await mkdir(path);
    try {
      forAdults(provider, channel.id);
      await app.library.refresh(app.subscriptionId);
      await app.reminders.check();
      expect((await app.reminders.list()).reminders).toEqual([]);
      expect(notices.closed).toEqual([reminder.id]);
    } finally {
      await rmdir(path);
    }
    // Once it can be written, it stays hidden, and told: it tells nothing again.
    await app.reminders.check();
    expect((await app.reminders.list()).reminders).toEqual([]);
    expect(notices.shown).toHaveLength(1);
  });

  it("keeps one that told as it told when the guide lists something else at its start", async () => {
    const { app, provider, channel, notices } = await reminding();
    const reminder = await app.reminders.set(app.own(channel.id), at("20:30"));
    await app.clockTo(at("20:30"));
    await app.reminders.check();
    for (const programmes of [
      [
        programme(channel.guideId, "2000", "2030", "Evening News"),
        programme(channel.guideId, "2030", "2200", "Ski Flying"),
      ],
      [
        programme(channel.guideId, "2000", "2100", "News Special"),
        programme(channel.guideId, "2100", "2200", "Ski Jumping"),
      ],
    ]) {
      provider.serveGuide(tv(...programmes));
      await app.guide.refresh(app.subscriptionId);
      await app.reminders.check();
      expect((await app.reminders.list()).reminders).toMatchObject([
        {
          id: reminder.id,
          title: "Ski Jumping",
          stop: at("21:30"),
          status: { kind: "told", at: at("20:30") },
        },
      ]);
    }
    expect(notices.shown).toHaveLength(1);
  });

  it("goes with its subscription, its notice too, and the next start drops one a release before left", async () => {
    const { app, channel, dataDir, notices, start } = await reminding();
    const reminder = await app.reminders.set(app.own(channel.id), at("20:30"));
    await app.clockTo(at("20:30"));
    await app.reminders.check();
    expect(notices.shown).toHaveLength(1);

    await app.roster.remove(app.subscriptionId, false);
    expect(notices.closed).toEqual([reminder.id]);
    expect((await app.reminders.list()).reminders).toEqual([]);
    const kept = JSON.parse(await readFile(join(dataDir, "reminders.json"), "utf8")) as unknown;
    expect(kept).toEqual({ version: 1, subscriptions: {} });

    // As a release that knows no reminders leaves them when it removes a subscription.
    await app.close();
    const left = {
      id: "left-behind",
      channel: channel.id,
      streams: [channel.id],
      channelName: "Left Behind",
      adult: false,
      start: at("20:40"),
      stop: at("21:00"),
      set: "Left Behind",
      title: "Left Behind",
      state: { kind: "pending" },
    };
    await writeFile(
      join(dataDir, "reminders.json"),
      JSON.stringify({ version: 1, subscriptions: { "gone-subscription": [left] } }),
    );
    const again = await start(at("20:45"));
    await again.reminders.check();
    expect((await again.reminders.list()).reminders).toEqual([]);
    expect(notices.shown).toHaveLength(1);
    const read = JSON.parse(await readFile(join(dataDir, "reminders.json"), "utf8")) as {
      subscriptions: Record<string, unknown>;
    };
    expect(read.subscriptions["gone-subscription"]).toBeUndefined();
  });

  it("changes nothing and tells nothing while it can't be saved, and the same call works once it can", async () => {
    const { app, channel, dataDir, notices } = await reminding();
    // Read first: a folder at its path before it is read makes a file it can't read, which
    // refuses every call, rather than one it can't write.
    expect((await app.reminders.list()).reminders).toEqual([]);
    await unwritable(dataDir, async () => {
      await expect(app.reminders.set(app.own(channel.id), at("20:30"))).rejects.toMatchObject({
        error: { kind: "unexpected" },
      });
      expect((await app.reminders.list()).reminders).toEqual([]);
    });
    const reminder = await app.reminders.set(app.own(channel.id), at("20:30"));

    // Due, but what it told can't be written: it doesn't tell, and tells once it can.
    await unwritable(dataDir, async () => {
      await app.clockTo(at("20:30"));
      await app.reminders.check();
      expect(notices.shown).toEqual([]);
      expect((await app.reminders.list()).reminders).toMatchObject([
        { id: reminder.id, status: { kind: "upcoming" } },
      ]);
      await expect(app.reminders.cancel(reminder.id)).rejects.toMatchObject({
        error: { kind: "unexpected" },
      });
    });
    await app.clockTo(at("20:31"));
    await app.reminders.check();
    expect(notices.shown).toMatchObject([{ id: reminder.id }]);
    await app.reminders.cancel(reminder.id);
    expect((await app.reminders.list()).reminders).toEqual([]);
  });

  it("keeps a file it can't read, or a newer release wrote, as it is, and uses none of it", async () => {
    const { app, channel, dataDir, start } = await reminding();
    await app.close();
    const path = join(dataDir, "reminders.json");
    for (const [text, reason] of [
      ["{ not json", "unreadable"],
      [JSON.stringify({ version: 2, subscriptions: {}, groups: [] }), "newer"],
    ] as const) {
      await writeFile(path, text);
      const again = await start();
      await expect(again.reminders.list()).rejects.toMatchObject({
        error: { kind: "reminder", reason },
      });
      await expect(again.reminders.set(again.own(channel.id), at("20:30"))).rejects.toMatchObject({
        error: { kind: "reminder", reason },
      });
      await again.reminders.check();
      await again.close();
      expect(await readFile(path, "utf8")).toBe(text);
    }
  });

  it("keeps what it doesn't know of a reminder, and an entry it can't read, through its writes", async () => {
    const { app, channel, dataDir, start } = await reminding();
    const reminder = await app.reminders.set(app.own(channel.id), at("20:30"));
    await app.close();
    const path = join(dataDir, "reminders.json");
    const file = JSON.parse(await readFile(path, "utf8")) as {
      subscriptions: Record<string, Record<string, unknown>[]>;
    };
    const [entry] = file.subscriptions[app.subscriptionId] ?? [];
    const later = { kind: "later", when: "never" };
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        subscriptions: { [app.subscriptionId]: [{ ...entry, repeat: "weekly" }, later] },
      }),
    );
    const again = await start();
    await again.reminders.set(again.own(channel.id), at("21:30"));
    const written = JSON.parse(await readFile(path, "utf8")) as typeof file;
    expect(written.subscriptions[app.subscriptionId]).toEqual([
      expect.objectContaining({ id: reminder.id, repeat: "weekly" }),
      expect.objectContaining({ title: "Late Film" }),
      later,
    ]);
  });

  it("shows its notice in the window again when its system notice is clicked, while it holds", async () => {
    const { app, channel, notices } = await reminding();
    const reminder = await app.reminders.set(app.own(channel.id), at("20:30"));
    await app.clockTo(at("20:30"));
    await app.reminders.check();
    await app.reminders.dismiss(reminder.id);
    expect((await app.reminders.list()).reminders).toMatchObject([{ banner: false }]);

    notices.click(reminder.id);
    await vi.waitFor(async () =>
      expect((await app.reminders.list()).reminders).toMatchObject([{ banner: true }]),
    );
    expect(notices.closed).toEqual([reminder.id]);

    // Once the programme ended, a click shows nothing, and its notice went at the end.
    await app.reminders.dismiss(reminder.id);
    await app.clockTo(at("21:30"));
    await app.reminders.check();
    notices.click(reminder.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await app.reminders.list()).reminders).toMatchObject([{ banner: false }]);
  });

  it("says when the system couldn't show a notice, or shows none, and tells in the window either way", async () => {
    const { app, channel, notices } = await reminding();
    const first = await app.reminders.set(app.own(channel.id), at("20:30"));
    const second = await app.reminders.set(app.own(channel.id), at("21:30"));
    expect((await app.reminders.list()).notifications).toBeNull();

    notices.refuseNext("fail");
    await app.clockTo(at("20:30"));
    await app.reminders.check();
    await vi.waitFor(async () =>
      expect(await app.reminders.list()).toMatchObject({
        notifications: "failed",
        reminders: [{ id: first.id, banner: true }, { id: second.id }],
      }),
    );

    notices.refuseNext("no");
    await app.clockTo(at("21:30"));
    await app.reminders.check();
    await vi.waitFor(async () => expect((await app.reminders.list()).notifications).toBeNull());

    // A system that throws as it is asked is one that couldn't show it.
    const throwing = await reminding();
    const thrown = await throwing.app.reminders.set(
      throwing.app.own(throwing.channel.id),
      at("20:30"),
    );
    throwing.notices.refuseNext("throw");
    await throwing.app.clockTo(at("20:30"));
    await throwing.app.reminders.check();
    expect(await throwing.app.reminders.list()).toMatchObject({
      notifications: "failed",
      reminders: [{ id: thrown.id, status: { kind: "told" }, banner: true }],
    });

    const unsupported = await reminding({ supported: false });
    const told = await unsupported.app.reminders.set(
      unsupported.app.own(unsupported.channel.id),
      at("20:30"),
    );
    await unsupported.app.clockTo(at("20:30"));
    await unsupported.app.reminders.check();
    expect(unsupported.notices.shown).toEqual([]);
    expect(await unsupported.app.reminders.list()).toMatchObject({
      notifications: "unsupported",
      reminders: [{ id: told.id, banner: true }],
    });
  });

  it.each([
    ["it couldn't read, read again by the list", "{ cut short", "unreadable", "list"],
    [
      "a newer release wrote, read again by the list",
      JSON.stringify({ version: 2, subscriptions: {} }),
      "newer",
      "list",
    ],
    ["it couldn't read, read again by setting it once more", "{ cut short", "unreadable", "set"],
  ] as const)("tells on its own at its start once a file %s", async (_case, text, reason, via) => {
    const { app, channel, dataDir, notices, start } = await reminding();
    const reminder = await app.reminders.set(app.own(channel.id), at("20:30"));
    await app.close();
    const path = join(dataDir, "reminders.json");
    const saved = await readFile(path, "utf8");
    await writeFile(path, text);
    const again = await start(at("20:28"));
    await expect(again.reminders.list()).rejects.toMatchObject({
      error: { kind: "reminder", reason },
    });
    // What the guide's first changes wake has settled before the file is whole again.
    await again.clockTo(at("20:28") + 10_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeFile(path, saved);
    // Only that call reads it again: Retry in the bell's list, or Remind me pressed once more,
    // which answers the reminder already set.
    if (via === "set")
      expect((await again.reminders.set(again.own(channel.id), at("20:30"))).id).toBe(reminder.id);
    expect((await again.reminders.list()).reminders).toMatchObject([
      { id: reminder.id, status: { kind: "upcoming" } },
    ]);

    // The clock runs on past its start a quarter of a minute at a time, and nothing else asks.
    for (let time = at("20:28") + 15_000; time <= at("20:31"); time += MINUTE / 4) {
      await again.clockTo(time);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(notices.shown.map((each) => each.id)).toEqual([reminder.id]);
    // Told was on disk before the system was asked.
    expect(notices.storedAtShow).toEqual([{ kind: "told", at: expect.any(Number) }]);
    const [told] = (await again.reminders.list()).reminders;
    expect(told?.status.kind === "told" && told.status.at - at("20:30")).toBeLessThan(MINUTE);

    // A cancel still takes it with its notice, and the app still closes.
    await again.reminders.cancel(reminder.id);
    expect(notices.closed).toEqual([reminder.id]);
    await again.close();
  });

  it("waits for nothing while no reminder is kept, through a clock that jumps decades", async () => {
    const { app, dataDir, start } = await reminding();
    await app.close();
    const path = join(dataDir, "reminders.json");
    await writeFile(path, "{ cut short");
    const again = await start();
    await expect(again.reminders.list()).rejects.toMatchObject({
      error: { kind: "reminder", reason: "unreadable" },
    });
    await writeFile(path, JSON.stringify({ version: 1, subscriptions: {} }));
    expect((await again.reminders.list()).reminders).toEqual([]);
    await again.clockTo(NOW + 50 * 365 * 24 * 60 * MINUTE);
    expect((await again.reminders.list()).reminders).toEqual([]);
  });

  it("keeps told and missed reminders until the end of the day their programme ends", async () => {
    const { app, channel, start } = await reminding();
    const reminder = await app.reminders.set(app.own(channel.id), at("21:30"));
    await app.clockTo(at("22:00"));
    await app.reminders.check();
    await app.clockTo(new Date(at("23:00")).setHours(23, 59, 0, 0));
    await app.reminders.check();
    expect((await app.reminders.list()).reminders).toMatchObject([{ id: reminder.id }]);

    await app.clockTo(new Date(at("23:00")).setHours(24, 0, 0, 0));
    await app.reminders.check();
    expect((await app.reminders.list()).reminders).toEqual([]);
    await app.close();
    const again = await start(new Date(at("23:00")).setHours(24, 1, 0, 0));
    expect((await again.reminders.list()).reminders).toEqual([]);
  });
});
