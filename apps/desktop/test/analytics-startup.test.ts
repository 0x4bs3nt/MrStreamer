import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import type { PreferenceSnapshot } from "@mrstreamer/contracts/ipc";
import { Failed } from "@mrstreamer/core/failure";
import { preferencePublication } from "../src/main/preference-publication.ts";
import { Analytics } from "../src/main/analytics/service.ts";
import { analyticsStore } from "../src/main/analytics/storage.ts";
import * as jsonFile from "../src/main/platform/json-file.ts";
import type {
  AnalyticsRecord,
  BuildProperties,
  CaptureEvent,
  ProfileOrigin,
  SummaryEvent,
} from "../src/main/analytics/model.ts";
import { tempDir } from "./support.ts";

const properties: BuildProperties = {
  app_version: "0.0.18",
  build_channel: "stable",
  update_channel: "stable",
  os: "linux",
  arch: "x64",
  distribution: "direct",
};
const id = "fd17819b-85f2-41e4-8322-444bfa91ece0";
const timestamp = "2026-10-23T12:00:00.000Z";
const envelope = {
  ...properties,
  profile_origin: "upgrading" as const,
  $process_person_profile: false as const,
  $geoip_disable: true as const,
};
const installation = {
  uuid: "e1ebd019-ab3e-4d80-b1bd-912eb2ac0800",
  distinct_id: id,
  timestamp,
  event: "installation_observed",
  properties: envelope,
} satisfies CaptureEvent;
const usage: SummaryEvent = {
  uuid: "be219421-d07a-48f0-bd4e-fdb8bf58fa46",
  distinct_id: id,
  timestamp,
  event: "usage_window",
  properties: {
    ...envelope,
    window_start: timestamp,
    window_end: "2026-10-23T12:05:00.000Z",
    counts: { feature_home: 2 },
  },
};
const play: SummaryEvent = {
  uuid: "3634b8ec-c442-48da-861c-0e99941d35be",
  distinct_id: id,
  timestamp,
  event: "stream_summary",
  properties: {
    ...envelope,
    stream_type: "live",
    started_at: timestamp,
    started_update_channel: "stable",
    watch_duration_seconds: 42,
    end_reason: "interrupted",
  },
};
function retained(): AnalyticsRecord {
  return {
    format: 2,
    enabled: true,
    installationId: id,
    profileOrigin: "upgrading",
    firstSeen: true,
    lastDay: "2026-10-23",
    pending: [{ event: structuredClone(installation), attempts: 1 }],
  };
}

const owners: Analytics[] = [];
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date(timestamp));
});
afterEach(async () => {
  const closing = Promise.all(owners.splice(0).map((owner) => owner.close()));
  await vi.advanceTimersByTimeAsync(1500);
  await closing;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function start(
  options: {
    record?: AnalyticsRecord | null;
    origin?: Promise<ProfileOrigin>;
    store?: ReturnType<typeof analyticsStore>;
    consentChanged?: () => void | Promise<void>;
  } = {},
) {
  const dataDir = await tempDir();
  const load = Promise.withResolvers<AnalyticsRecord | null>();
  let record = options.record === undefined ? retained() : structuredClone(options.record);
  const writes: AnalyticsRecord[] = [];
  const store = options.store ?? {
    load: () => load.promise,
    async save(next: AnalyticsRecord) {
      record = structuredClone(next);
      writes.push(record);
    },
  };
  const events: CaptureEvent[] = [];
  const owner = new Analytics({
    dataDir,
    origin: options.origin ?? Promise.resolve("fresh"),
    properties,
    store,
    ...(options.consentChanged ? { consentChanged: options.consentChanged } : {}),
    transport: {
      kind: "local",
      async send(event) {
        events.push(structuredClone(event));
        return "accepted";
      },
    },
  });
  owners.push(owner);
  return { owner, events, writes, load, snapshot: () => structuredClone(record) };
}

/** Real file work settles independently of the controlled deadline clock. */
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await pause(5);
  }
  throw new Error("Analytics startup side effect did not settle.");
}

describe("optional analytics startup", () => {
  async function compose(options: Parameters<typeof start>[0] = {}) {
    let refresh: (() => Promise<void>) | undefined;
    const started = await start({ ...options, consentChanged: () => refresh?.() });
    const { owner } = started;
    const published: PreferenceSnapshot[] = [];
    const publication = await Effect.runPromise(
      preferencePublication({
        read: Effect.promise(async () => ({
          volume: 1,
          muted: false,
          nextEpisodeDelaySeconds: 10,
          analyticsEnabled: (await owner.settings()).enabled,
        })),
        write: () => Effect.void,
        consent: (enabled) =>
          Effect.tryPromise({
            try: () => owner.configure(enabled),
            catch: () =>
              new Failed({
                error: { kind: "unexpected", detail: "Analytics preference could not be saved." },
              }),
          }),
        reconfigure: Effect.void,
        publish: (snapshot) => published.push(snapshot),
        stale: () => {},
      }),
    );
    refresh = async () => {
      await Effect.runPromise(publication.get);
    };
    const recovered = owner.loaded.then(refresh);
    return { ...started, publication, published, recovered };
  }

  it.each(["success", "rejection"] as const)(
    "publishes settled initial consent after a bounded startup snapshot: %s",
    async (outcome) => {
      const { load, publication, published, recovered } = await compose({ record: null });
      const boot = Effect.runPromise(publication.get);
      await vi.advanceTimersByTimeAsync(1500);
      expect((await boot).preferences.analyticsEnabled).toBe(false);
      expect(published).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(200);
      if (outcome === "success") load.resolve(null);
      else load.reject(new Error("private load failure"));
      await recovered;
      expect(
        published.map(({ revision, preferences }) => [revision, preferences.analyticsEnabled]),
      ).toEqual(
        outcome === "success"
          ? [
              [1, false],
              [2, true],
            ]
          : [[1, false]],
      );
    },
  );

  it.each([
    [false, [true]],
    [true, [false]],
    [false, [true, false, true]],
    [true, [false, true, false]],
  ] as const)(
    "publishes actual queued consent commits after update deadlines, initial %s requests %j",
    async (initial, requests) => {
      const before = { ...retained(), enabled: initial, pending: [] };
      const load = Promise.withResolvers<AnalyticsRecord | null>();
      let durable: AnalyticsRecord = structuredClone(before);
      const commits: boolean[] = [];
      const { owner, events, publication, published, recovered } = await compose({
        store: {
          load: () => load.promise,
          async save(next) {
            await new Promise<void>((resolve) => setTimeout(resolve, 30));
            durable = structuredClone(next);
            commits.push(next.enabled);
          },
        },
      });
      owner.setForeground(true);
      const boot = Effect.runPromise(publication.get);
      await vi.advanceTimersByTimeAsync(1500);
      expect((await boot).preferences.analyticsEnabled).toBe(false);
      const changes = requests.map((analyticsEnabled) =>
        Effect.runPromiseExit(publication.update({ analyticsEnabled })),
      );
      await vi.advanceTimersByTimeAsync(1500);
      for (const change of changes) expect((await change)._tag).toBe("Failure");
      expect(commits).toEqual([]);
      load.resolve(before);
      await recovered;
      await vi.advanceTimersByTimeAsync(500);
      // No public get repairs the cached snapshot after the failed updates.
      expect(published.at(-1)?.preferences.analyticsEnabled).toBe(requests.at(-1));
      expect(published.at(-1)?.preferences.analyticsEnabled).toBe(durable.enabled);
      expect((await owner.settings()).enabled).toBe(durable.enabled);
      expect(commits.slice(0, requests.length)).toEqual(requests);
      expect(published.map(({ revision }) => revision)).toEqual(
        published.map((_, index) => index + 1),
      );
      expect(events.length > 0).toBe(requests.at(-1));
    },
  );

  it.each([true, false])(
    "publishes a queued choice after normal loading and two bounded saves, initial %s",
    async (initial) => {
      const before = { ...retained(), enabled: initial, pending: [] };
      let durable: AnalyticsRecord = structuredClone(before);
      const { owner, publication, published, recovered } = await compose({
        store: {
          load: async () => before,
          async save(next) {
            await new Promise<void>((resolve) => setTimeout(resolve, 1200));
            durable = structuredClone(next);
          },
        },
      });
      await recovered;
      expect(published.at(-1)?.preferences.analyticsEnabled).toBe(initial);
      const first = Effect.runPromiseExit(publication.update({ analyticsEnabled: initial }));
      const queued = Effect.runPromiseExit(publication.update({ analyticsEnabled: !initial }));
      await vi.advanceTimersByTimeAsync(1500);
      expect((await first)._tag).toBe("Success");
      expect((await queued)._tag).toBe("Failure");
      expect(published.at(-1)?.preferences.analyticsEnabled).toBe(initial);
      expect(durable.enabled).toBe(initial);
      await vi.advanceTimersByTimeAsync(900);
      // Both individual saves met their 1500 ms I/O deadline. Only queueing expired the caller.
      expect(published.at(-1)?.preferences.analyticsEnabled).toBe(!initial);
      expect(published.at(-1)?.preferences.analyticsEnabled).toBe(durable.enabled);
      expect(await owner.settings()).toEqual({ enabled: !initial, transport: "local" });
    },
  );

  it("publishes saved consent even when subsequent startup recovery fails", async () => {
    const before: AnalyticsRecord = {
      ...retained(),
      enabled: false,
      summaries: { version: 1, installationId: id, pending: [], usage, unfinished: null },
    };
    const load = Promise.withResolvers<AnalyticsRecord | null>();
    let durable: AnalyticsRecord = structuredClone(before);
    let saved = false;
    const { owner, events, publication, published, recovered } = await compose({
      store: {
        load: () => load.promise,
        async save(next) {
          if (saved) throw new Error("private recovery failure");
          saved = true;
          durable = structuredClone(next);
        },
      },
    });
    const boot = Effect.runPromise(publication.get);
    await vi.advanceTimersByTimeAsync(1500);
    await boot;
    const update = Effect.runPromiseExit(publication.update({ analyticsEnabled: true }));
    await vi.advanceTimersByTimeAsync(1500);
    expect((await update)._tag).toBe("Failure");
    load.resolve(before);
    await recovered;
    await vi.advanceTimersByTimeAsync(0);
    expect(published.at(-1)?.preferences.analyticsEnabled).toBe(true);
    expect(durable.enabled).toBe(true);
    expect(await owner.settings()).toEqual({ enabled: true, transport: "unavailable" });
    expect(events).toEqual([]);
  });

  it.each(["throw", "reject"] as const)(
    "keeps consent commits independent of a callback %s",
    async (failure) => {
      const consentChanged = vi.fn(() => {
        if (failure === "throw") throw new Error("publication failed");
        return Promise.reject(new Error("publication failed"));
      });
      const { owner, load, snapshot } = await start({ consentChanged });
      load.resolve(retained());
      await owner.loaded;
      expect((await owner.configure(false)).enabled).toBe(false);
      expect((await owner.configure(true)).enabled).toBe(true);
      expect(snapshot()?.enabled).toBe(true);
      expect(consentChanged).toHaveBeenCalledTimes(2);
    },
  );

  it.each([200, 1700])(
    "delivers retained work after a %i ms store load without extending the settings deadline",
    async (ms) => {
      const { owner, load, events, writes, snapshot } = await start();
      const settings = owner.settings();
      setTimeout(() => load.resolve(retained()), ms);
      await vi.advanceTimersByTimeAsync(Math.min(1500, ms));
      expect(await settings).toEqual(
        ms <= 1500
          ? { enabled: true, transport: "local" }
          : { enabled: false, transport: "unavailable" },
      );
      await vi.advanceTimersByTimeAsync(Math.max(0, ms - 1500));
      expect(await owner.settings()).toEqual({ enabled: true, transport: "local" });
      expect(events).toEqual([installation]);
      expect(writes[0]?.pending).toEqual([{ event: installation, attempts: 2 }]);
      expect(snapshot()).toMatchObject({
        installationId: id,
        profileOrigin: "upgrading",
        pending: [],
      });
      owner.setForeground(true);
      await owner.configure(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(events.map((event) => event.event)).toEqual([
        "installation_observed",
        "app_version_observed",
      ]);
      expect(events[1]?.properties).toMatchObject({ observation_kind: "unknown_history" });
    },
  );

  it("waits for a late origin before classifying a fresh foreground profile, then observes it once", async () => {
    const origin = Promise.withResolvers<ProfileOrigin>();
    const { owner, load, events, snapshot } = await start({ record: null, origin: origin.promise });
    load.resolve(null);
    owner.setForeground(true);
    const settings = owner.settings();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await settings).toEqual({ enabled: false, transport: "unavailable" });
    expect(events).toEqual([]);
    origin.resolve("fresh");
    await vi.advanceTimersByTimeAsync(200);
    expect(await owner.settings()).toEqual({ enabled: true, transport: "local" });
    expect(events.map((event) => event.event)).toEqual([
      "installation_observed",
      "app_active_day",
      "app_version_observed",
    ]);
    expect(events.every((event) => event.properties.profile_origin === "fresh")).toBe(true);
    expect(new Set(events.map((event) => event.distinct_id)).size).toBe(1);
    expect(snapshot()).toMatchObject({ firstSeen: true, lastDay: "2026-10-23", pending: [] });
    owner.setForeground(false);
    owner.setForeground(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toHaveLength(3);
  });

  it.each(["store", "origin"] as const)(
    "fails closed on a late %s rejection without writing or exposing the failure",
    async (port) => {
      const origin = Promise.withResolvers<ProfileOrigin>();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { owner, load, events, writes } = await start({ origin: origin.promise });
      const settings = owner.settings();
      await vi.advanceTimersByTimeAsync(1500);
      expect(await settings).toMatchObject({ transport: "unavailable" });
      if (port === "store") {
        load.reject(new Error("PRIVATE-ID /private/path"));
        origin.resolve("fresh");
      } else {
        load.resolve(retained());
        origin.reject(new Error("PRIVATE-ID /private/path"));
      }
      await vi.advanceTimersByTimeAsync(200);
      owner.setForeground(true);
      await expect(owner.configure(true)).rejects.toThrow(
        "Analytics preference could not be saved.",
      );
      expect(await owner.settings()).toEqual({ enabled: false, transport: "unavailable" });
      expect(events).toEqual([]);
      expect(writes).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("keeps a timed-out opt-out pending until loading settles, clears work and never backfills on re-enable", async () => {
    const before = {
      ...retained(),
      summaries: {
        version: 1 as const,
        installationId: id,
        pending: [],
        usage,
        unfinished: { event: play, watchMs: 42_000 },
      },
    };
    const { owner, load, events, snapshot } = await start({ record: before });
    owner.setForeground(true);
    const disabled = expect(owner.configure(false)).rejects.toThrow(
      "Analytics preference could not be saved.",
    );
    await vi.advanceTimersByTimeAsync(1500);
    await disabled;
    expect(events).toEqual([]);
    load.resolve(before);
    await vi.advanceTimersByTimeAsync(200);
    expect(await owner.settings()).toEqual({ enabled: false, transport: "local" });
    expect(snapshot()).toEqual({ ...retained(), enabled: false, pending: [] });
    await owner.configure(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.map((event) => event.event)).toEqual(["app_version_observed"]);
    expect(events[0]?.properties).toMatchObject({ observation_kind: "unknown_history" });
    expect(events[0]?.properties).not.toHaveProperty("previous_app_version");
    expect(snapshot()).toMatchObject({ ...retained(), pending: [] });
  });

  it.each([
    [false, true],
    [true, false],
    [false, true, false],
  ])(
    "serializes consent requests made after the startup deadline: %j",
    async (...requests: boolean[]) => {
      const { owner, load, events, snapshot } = await start();
      const settings = owner.settings();
      await vi.advanceTimersByTimeAsync(1500);
      await settings;
      const changes = requests.map((enabled) => owner.configure(enabled));
      load.resolve(retained());
      await vi.advanceTimersByTimeAsync(200);
      await Promise.all(changes);
      expect(await owner.settings()).toEqual({ enabled: requests.at(-1), transport: "local" });
      expect(snapshot()).toEqual({ ...retained(), enabled: requests.at(-1), pending: [] });
      expect(events).toEqual([]);
    },
  );

  it("respects saved opt-out after a late load", async () => {
    const before = { ...retained(), enabled: false, pending: [] };
    const { owner, load, events, writes } = await start({ record: before });
    owner.setForeground(true);
    await vi.advanceTimersByTimeAsync(1700);
    load.resolve(before);
    await vi.advanceTimersByTimeAsync(0);
    expect(await owner.settings()).toEqual({ enabled: false, transport: "local" });
    expect(events).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("recovers open summaries once after a pending enable and preserves an existing summary's retry time", async () => {
    const delayed = { ...play, uuid: "9a93e0a9-c293-44fe-a41e-c491e9f99107" };
    const before: AnalyticsRecord = {
      ...retained(),
      summaries: {
        version: 1,
        installationId: id,
        usage,
        unfinished: { event: play, watchMs: 42_000 },
        pending: [
          { event: delayed, attempts: 1, failures: 2, nextAttemptAt: "2026-10-23T12:00:05.000Z" },
        ],
      },
    };
    const { owner, load, events, snapshot } = await start({ record: before });
    const settings = owner.settings();
    await vi.advanceTimersByTimeAsync(1500);
    await settings;
    const enabled = owner.configure(true);
    await vi.advanceTimersByTimeAsync(200);
    load.resolve(before);
    await vi.advanceTimersByTimeAsync(0);
    await enabled;
    expect(events).toEqual([installation, usage, play]);
    expect(snapshot()?.summaries).toEqual({ ...before.summaries, usage: null, unfinished: null });
    await owner.configure(true);
    await vi.advanceTimersByTimeAsync(3300);
    expect(events).toEqual([installation, usage, play, delayed]);
    expect(snapshot()?.summaries?.pending).toEqual([]);
  });

  it("keeps a failed recovery write unavailable without sending or replacing durable consent", async () => {
    const before: AnalyticsRecord = {
      ...retained(),
      summaries: { version: 1, installationId: id, pending: [], usage, unfinished: null },
    };
    const gate = Promise.withResolvers<AnalyticsRecord>();
    const { owner, events } = await start({
      store: {
        load: () => gate.promise,
        save: async () => {
          throw new Error("PRIVATE-ID");
        },
      },
    });
    await vi.advanceTimersByTimeAsync(1700);
    gate.resolve(structuredClone(before));
    await vi.advanceTimersByTimeAsync(0);
    expect(await owner.settings()).toEqual({ enabled: true, transport: "unavailable" });
    await expect(owner.configure(true)).rejects.toThrow("Analytics preference could not be saved.");
    expect(events).toEqual([]);
    expect(before.summaries?.usage).toEqual(usage);
  });

  it.each(["resolve", "reject"] as const)(
    "bounds quit during a pending load and does no later work on %s",
    async (outcome) => {
      const { owner, load, events, writes } = await start();
      owner.setForeground(true);
      const closing = owner.close();
      await vi.advanceTimersByTimeAsync(500);
      await closing;
      if (outcome === "resolve") load.resolve(retained());
      else load.reject(new Error("PRIVATE-ID"));
      await vi.advanceTimersByTimeAsync(2000);
      expect(events).toEqual([]);
      expect(writes).toEqual([]);
      await expect(owner.configure(true)).rejects.toThrow(
        "Analytics preference could not be saved.",
      );
    },
  );

  it("does not notify composition for a consent save finishing during close", async () => {
    const before = { ...retained(), enabled: false, pending: [] };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const consentChanged = vi.fn();
    let durable: AnalyticsRecord = structuredClone(before);
    const { owner, events } = await start({
      consentChanged,
      store: {
        load: async () => before,
        async save(next) {
          entered.resolve();
          await release.promise;
          durable = structuredClone(next);
        },
      },
    });
    await owner.loaded;
    const changing = owner.configure(true);
    await entered.promise;
    const closing = owner.close();
    await vi.advanceTimersByTimeAsync(500);
    await closing;
    release.resolve();
    await changing;
    expect(durable.enabled).toBe(true);
    expect(consentChanged).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("does not notify composition for a rejected consent save", async () => {
    const consentChanged = vi.fn();
    const { owner } = await start({
      consentChanged,
      store: {
        load: async () => retained(),
        save: async () => {
          throw new Error("private save failure");
        },
      },
    });
    await owner.loaded;
    await expect(owner.configure(false)).rejects.toThrow(
      "Analytics preference could not be saved.",
    );
    expect(consentChanged).not.toHaveBeenCalled();
    expect(await owner.settings()).toEqual({ enabled: true, transport: "unavailable" });
  });

  it("does not apply a queued preference after quitting with initialization still pending", async () => {
    const { owner, load, events, writes } = await start();
    const disabled = expect(owner.configure(false)).rejects.toThrow(
      "Analytics preference could not be saved.",
    );
    const closing = owner.close();
    await vi.advanceTimersByTimeAsync(500);
    await closing;
    await vi.advanceTimersByTimeAsync(1000);
    await disabled;
    load.resolve(retained());
    await vi.advanceTimersByTimeAsync(200);
    expect(events).toEqual([]);
    expect(writes).toEqual([]);
  });

  it.each(["success", "failure", "opt-out"] as const)(
    "handles a late format-one migration %s through the real loader",
    async (outcome) => {
      const dataDir = await tempDir();
      const path = join(dataDir, "analytics.json");
      const legacy = {
        ...retained(),
        format: 1,
        summary: { private: "discarded" },
        pending: [
          ...retained().pending,
          { event: { ...installation, event: "app_summary_day" }, attempts: 0 },
        ],
      };
      await writeFile(path, JSON.stringify(legacy));
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const original = jsonFile.writeJsonFile;
      vi.spyOn(jsonFile, "writeJsonFile").mockImplementationOnce(async (destination, value) => {
        entered.resolve();
        await release.promise;
        if (outcome === "failure") throw new Error("PRIVATE-ID rename EACCES");
        await original(destination, value);
      });
      const { owner, events } = await start({ store: analyticsStore(dataDir) });
      const disabled =
        outcome === "opt-out"
          ? expect(owner.configure(false)).rejects.toThrow(
              "Analytics preference could not be saved.",
            )
          : null;
      await entered.promise;
      const settings = owner.settings();
      await vi.advanceTimersByTimeAsync(1500);
      await disabled;
      expect(await settings).toEqual({ enabled: false, transport: "unavailable" });
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(legacy);
      release.resolve();
      if (outcome === "success") {
        await until(
          async () =>
            events.length === 1 && (await analyticsStore(dataDir).load())?.pending.length === 0,
        );
        expect(events).toEqual([installation]);
        expect(await analyticsStore(dataDir).load()).toMatchObject({ ...retained(), pending: [] });
        expect(await owner.settings()).toEqual({ enabled: true, transport: "local" });
      } else if (outcome === "opt-out") {
        await until(async () => {
          const settings = await owner.settings();
          return settings.enabled === false && settings.transport === "local";
        });
        expect(events).toEqual([]);
        expect(await analyticsStore(dataDir).load()).toEqual({
          ...retained(),
          enabled: false,
          pending: [],
        });
        expect(await owner.settings()).toEqual({ enabled: false, transport: "local" });
      } else {
        await until(async () => {
          try {
            await owner.configure(true);
            return false;
          } catch {
            return true;
          }
        });
        expect(await owner.settings()).toEqual({ enabled: false, transport: "unavailable" });
        expect(events).toEqual([]);
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual(legacy);
      }
    },
  );
});
