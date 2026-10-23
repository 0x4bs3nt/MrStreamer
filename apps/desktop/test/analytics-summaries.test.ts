import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyticsActions,
  analyticsFeatures,
  analyticsSettings,
} from "@mrstreamer/contracts/analytics";
import { Analytics } from "../src/main/analytics/service.ts";
import { analyticsStore } from "../src/main/analytics/storage.ts";
import { localCapture, type CaptureTransport } from "../src/main/analytics/transport.ts";
import {
  type AnalyticsRecord,
  CaptureEvent,
  type StreamSummary,
  type BuildProperties,
  WINDOW_MS,
} from "../src/main/analytics/model.ts";
import { tempDir } from "./support.ts";

const properties: BuildProperties = {
  app_version: "0.0.16",
  build_channel: "stable",
  update_channel: "stable",
  os: "linux",
  arch: "x64",
  distribution: "direct",
};
const owners: Analytics[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  const closing = Promise.all(owners.splice(0).map((owner) => owner.close()));
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1500);
  await closing;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.useRealTimers();
});
function clock(at = "2026-10-24T23:59:00Z") {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date(at));
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await pause(5);
  }
  throw new Error("Observable analytics work did not settle.");
}
async function start(
  options: {
    store?: ReturnType<typeof analyticsStore>;
    transport?: CaptureTransport;
    directory?: string;
  } = {},
) {
  const directory = options.directory ?? (await tempDir());
  let record: AnalyticsRecord | null = null;
  const writes: AnalyticsRecord[] = [];
  const store = options.store ?? {
    load: async () => record && structuredClone(record),
    save: async (next: AnalyticsRecord) => {
      record = structuredClone(next);
      writes.push(record);
    },
  };
  const events: CaptureEvent[] = [];
  const owner = new Analytics({
    dataDir: directory,
    properties,
    origin: Promise.resolve("fresh"),
    store,
    transport: options.transport ?? {
      kind: "local",
      send: async (event) => {
        if (event.event !== "app_version_observed") events.push(structuredClone(event));
        return "accepted";
      },
    },
  });
  owners.push(owner);
  await owner.settings();
  owner.setForeground(true);
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await until(async () => !!(await store.load())?.installationId);
  return { owner, events, writes, store, directory };
}
function run(owner: Analytics, ongoing = false) {
  const token = owner.beginPlayback("live", ongoing)!;
  const binding = owner.bindPlayback(token, "local")!;
  owner.notePlaybackState(token, binding, 1, "playing");
  return { token, binding };
}

describe("durable usage and logical-play summaries", () => {
  it.each(["pending", "usage", "unfinished"] as const)(
    "expires only the old %s work and sends fresh peers with the persisted identity",
    async (expiredSlot) => {
      const receiver = await sink(false);
      const directory = await tempDir();
      const store = analyticsStore(directory);
      const id = randomUUID();
      const common = {
        ...properties,
        profile_origin: "fresh" as const,
        $process_person_profile: false as const,
        $geoip_disable: true as const,
      };
      const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
      const fresh = new Date(Date.now() - 3_600_000).toISOString();
      const summary = (timestamp: string): StreamSummary => ({
        uuid: randomUUID(),
        distinct_id: id,
        timestamp,
        event: "stream_summary",
        properties: {
          ...common,
          stream_type: "live",
          started_at: timestamp,
          started_update_channel: "stable",
          watch_duration_seconds: 12,
          end_reason: "ended",
        },
      });
      const expired = summary(old);
      const ended = summary(fresh);
      const windowStart = new Date(
        Math.floor(Date.parse(expiredSlot === "usage" ? old : fresh) / WINDOW_MS) * WINDOW_MS,
      ).toISOString();
      const usage = {
        uuid: randomUUID(),
        distinct_id: id,
        timestamp: windowStart,
        event: "usage_window" as const,
        properties: {
          ...common,
          window_start: windowStart,
          window_end: new Date(Date.parse(windowStart) + WINDOW_MS).toISOString(),
          counts: { action_search_used: 3 },
        },
      };
      const interrupted = summary(expiredSlot === "unfinished" ? old : fresh);
      interrupted.properties.end_reason = "interrupted";
      const direct = {
        event: {
          uuid: randomUUID(),
          distinct_id: id,
          timestamp: fresh,
          event: "installation_observed" as const,
          properties: common,
        },
        attempts: 0,
      };
      await store.save({
        format: 2,
        enabled: true,
        installationId: id,
        profileOrigin: "fresh",
        firstSeen: true,
        lastDay: new Date().toISOString().slice(0, 10),
        pending: [direct],
        summaries: {
          version: 1,
          installationId: id,
          pending: [...(expiredSlot === "pending" ? [expired] : []), ended].map((event) => ({
            event,
            attempts: 1,
            failures: 2,
            nextAttemptAt: fresh,
          })),
          usage,
          unfinished: { event: interrupted, watchMs: 12_000 },
        },
      });
      const loaded = await store.load();
      expect(loaded).toMatchObject({ enabled: true, installationId: id, pending: [direct] });
      expect(loaded?.summaries?.pending).toMatchObject([
        { event: ended, attempts: 1, failures: 2 },
      ]);
      expect(loaded?.summaries?.usage).toEqual(expiredSlot === "usage" ? null : usage);
      expect(loaded?.summaries?.unfinished).toEqual(
        expiredSlot === "unfinished" ? null : { event: interrupted, watchMs: 12_000 },
      );
      const { owner } = await start({
        directory,
        store,
        transport: localCapture(receiver.endpoint)!,
      });
      const expected = [
        direct.event,
        ended,
        ...(expiredSlot === "usage" ? [] : [usage]),
        ...(expiredSlot === "unfinished" ? [] : [interrupted]),
      ];
      await until(() => receiver.bodies.length === expected.length);
      await until(async () => (await store.load())?.summaries?.pending.length === 0);
      expect(receiver.bodies.map((body) => JSON.parse(body).uuid).sort()).toEqual(
        expected.map((event) => event.uuid).sort(),
      );
      for (const body of receiver.bodies) {
        const raw: unknown = JSON.parse(body);
        const event = CaptureEvent().assert(structuredClone(raw));
        expect(raw).toEqual({ api_key: "mrstreamer-local-verification", ...event });
        expect(event.distinct_id).toBe(id);
      }
      expect(await owner.settings()).toEqual({ enabled: true, transport: "local" });
    },
  );

  it("purges exhausted direct reservations at restart while retaining an active third delivery", async () => {
    clock();
    const directory = await tempDir();
    const store = analyticsStore(directory);
    const id = randomUUID();
    const common = {
      ...properties,
      profile_origin: "fresh" as const,
      $process_person_profile: false as const,
      $geoip_disable: true as const,
    };
    const timestamp = new Date().toISOString();
    const exhausted = {
      event: {
        uuid: randomUUID(),
        distinct_id: id,
        timestamp,
        event: "installation_observed" as const,
        properties: common,
      },
      attempts: 3,
    };
    const third = {
      event: {
        uuid: randomUUID(),
        distinct_id: id,
        timestamp,
        event: "renderer_exited" as const,
        properties: { ...common, reason: "crashed" as const },
      },
      attempts: 2,
    };
    await store.save({
      format: 2,
      enabled: true,
      installationId: id,
      profileOrigin: "fresh",
      firstSeen: true,
      lastDay: timestamp.slice(0, 10),
      pending: [exhausted, third],
    });
    const sent: CaptureEvent[] = [];
    const { owner } = await start({
      directory,
      store,
      transport: {
        kind: "local",
        send: async (event) => {
          sent.push(event);
          return new Promise(() => {});
        },
      },
    });
    await until(() => sent.length === 1);
    expect(sent[0]).toEqual(third.event);
    expect((await store.load())?.pending).toEqual([{ ...third, attempts: 3 }]);
    owner.noteRendererExit("other");
    await vi.advanceTimersByTimeAsync(0);
    expect((await store.load())?.pending[0]).toEqual({ ...third, attempts: 3 });
    const closing = owner.close();
    await vi.advanceTimersByTimeAsync(500);
    await closing;
    expect((await store.load())?.pending[0]).toEqual({ ...third, attempts: 3 });
    const restarted = await start({ directory, store });
    await vi.advanceTimersByTimeAsync(0);
    expect(restarted.events.map((event) => event.uuid)).not.toContain(third.event.uuid);
    expect(restarted.events.map((event) => event.uuid)).not.toContain(exhausted.event.uuid);
    await until(async () => (await store.load())?.pending.length === 0);
    expect((await store.load())?.installationId).toBe(id);
  });

  it.each(["steady", "waiting-and-seeking"] as const)(
    "checkpoints %s playback only at explicit pause or counted thresholds, preserving recovery duration",
    async (cadence) => {
      clock("2026-10-25T00:00:00Z");
      const first = await start();
      const { token, binding } = run(first.owner);
      await vi.advanceTimersByTimeAsync(0);
      const admitted = (await first.store.load())?.summaries?.unfinished;
      expect(admitted).toMatchObject({
        watchMs: 0,
        event: { properties: { watch_duration_seconds: 0 } },
      });
      const writes = first.writes.length;
      for (let tick = 1; tick <= 120; tick++) {
        await vi.advanceTimersByTimeAsync(1000);
        first.owner.notePlaybackState(
          token,
          binding,
          tick + 1,
          cadence === "steady" || tick % 2 === 0
            ? "playing"
            : tick % 4 === 1
              ? "waiting"
              : "seeking",
        );
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(first.writes.length).toBe(writes);
      let sequence = 122;
      first.owner.notePlaybackState(token, binding, sequence, "paused");
      await vi.advanceTimersByTimeAsync(0);
      const counted = cadence === "steady" ? 120 : 60;
      expect(first.writes.length).toBe(writes + 1);
      const paused = await first.store.load();
      expect(paused?.summaries?.unfinished).toMatchObject({ watchMs: counted * 1000 });
      const recover = async (snapshot: AnalyticsRecord | null, seconds: number) => {
        const recovered = await start({
          store: { load: async () => structuredClone(snapshot), save: async () => {} },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(recovered.events.filter((event) => event.event === "stream_summary")).toMatchObject([
          {
            uuid: admitted?.event.uuid,
            properties: { end_reason: "interrupted", watch_duration_seconds: seconds },
          },
        ]);
      };
      await recover(paused, counted);
      for (let tick = 1; tick <= 60; tick++) {
        await vi.advanceTimersByTimeAsync(1000);
        first.owner.notePlaybackState(token, binding, ++sequence, "seeking");
        first.owner.notePlaybackState(token, binding, ++sequence, "waiting");
        first.owner.notePlaybackState(token, binding, ++sequence, "paused");
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(first.writes.length).toBe(writes + 1);
      expect(await first.store.load()).toEqual(paused);
      await recover(await first.store.load(), counted);
      first.owner.notePlaybackState(token, binding, ++sequence, "playing");
      await vi.advanceTimersByTimeAsync(1000);
      first.owner.notePlaybackState(token, binding, ++sequence, "paused");
      await vi.advanceTimersByTimeAsync(0);
      expect(first.writes.length).toBe(writes + 2);
      expect((await first.store.load())?.summaries?.unfinished?.watchMs).toBe((counted + 1) * 1000);
      await recover(await first.store.load(), counted + 1);
      first.owner.notePlaybackState(token, binding, ++sequence, "playing");
      for (let tick = 1; tick <= 300; tick++) {
        await vi.advanceTimersByTimeAsync(1000);
        first.owner.notePlaybackState(token, binding, ++sequence, "playing");
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(first.writes.length).toBe(writes + 3);
      const threshold = await first.store.load();
      expect(threshold?.summaries?.unfinished).toMatchObject({ watchMs: (counted + 301) * 1000 });
      await recover(threshold, counted + 301);
      first.owner.endPlayback(token);
      await vi.advanceTimersByTimeAsync(0);
      expect(first.events.filter((event) => event.event === "stream_summary")).toMatchObject([
        {
          uuid: admitted?.event.uuid,
          properties: { end_reason: "ended", watch_duration_seconds: counted + 301 },
        },
      ]);
    },
  );

  it("persists an admitted burst once, sends only at UTC boundaries and preserves sparse delta totals through channel changes and rollback", async () => {
    clock();
    const { owner, events, writes, store } = await start();
    const before = writes.length;
    for (let i = 0; i < 30; i++) owner.noteAction("search_used");
    owner.noteFeature("search");
    await vi.advanceTimersByTimeAsync(0);
    expect(writes.length - before).toBe(1);
    expect(events.filter((event) => event.event === "usage_window")).toEqual([]);
    expect((await store.load())?.summaries?.usage).toMatchObject({
      timestamp: "2026-10-24T23:55:00.000Z",
      properties: { counts: { action_search_used: 30, feature_search: 1 } },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const first = events.find((event) => event.event === "usage_window");
    expect(first).toMatchObject({
      timestamp: "2026-10-24T23:55:00.000Z",
      properties: { window_end: "2026-10-25T00:00:00.000Z" },
    });
    owner.noteFeature("home");
    owner.setUpdateChannel("nightly");
    owner.noteSetting("update_channel");
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(new Date("2026-10-24T23:58:00Z"));
    owner.noteAction("epg_opened");
    await owner.close();
    const summaries = events.filter((event) => event.event === "usage_window");
    expect(new Set(summaries.map((event) => event.uuid)).size).toBe(summaries.length);
    expect(summaries.flatMap((event) => Object.entries(event.properties.counts))).toEqual([
      ["action_search_used", 30],
      ["feature_search", 1],
      ["feature_home", 1],
      ["setting_update_channel", 1],
      ["action_epg_opened", 1],
    ]);
    expect(summaries.find((event) => event.properties.counts.setting_update_channel)).toMatchObject(
      { properties: { update_channel: "nightly" } },
    );
    expect(summaries.find((event) => event.properties.counts.feature_home)).toMatchObject({
      properties: { update_channel: "stable" },
    });
  });

  it("checkpoints counted progress every five minutes, recovers the same interrupted UUID without dead time, and keeps consent reads independent of recovery", async () => {
    clock("2026-10-25T00:00:00Z");
    const first = await start();
    const { token, binding } = run(first.owner);
    await vi.advanceTimersByTimeAsync(0);
    const admitted = (await first.store.load())?.summaries?.unfinished;
    const before = first.writes.length;
    for (let second = 1; second <= 302; second++) {
      await vi.advanceTimersByTimeAsync(1000);
      first.owner.notePlaybackState(token, binding, second + 1, "playing");
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(first.writes.length - before).toBe(1);
    expect(first.events.filter((event) => event.event === "stream_summary")).toEqual([]);
    const crash = structuredClone(await first.store.load());
    first.owner.notePlaybackState(token, binding, 304, "paused");
    await vi.advanceTimersByTimeAsync(0);
    const pausedWrites = first.writes.length;
    for (let poll = 305; poll < 365; poll++) {
      first.owner.notePlaybackState(token, binding, poll, "paused");
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(first.writes.length).toBe(pausedWrites);
    vi.setSystemTime(new Date("2026-10-25T06:00:00Z"));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let current = crash;
    const events: CaptureEvent[] = [];
    const owner = new Analytics({
      dataDir: first.directory,
      origin: Promise.resolve("unknown"),
      properties: { ...properties, app_version: "0.0.17" },
      store: {
        load: async () => current,
        save: async (next) => {
          await gate;
          current = structuredClone(next);
        },
      },
      transport: {
        kind: "local",
        send: async (event) => {
          events.push(event);
          return "accepted";
        },
      },
    });
    owners.push(owner);
    expect(await owner.settings()).toEqual({ enabled: true, transport: "local" });
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    const recovered = events.find((event) => event.event === "stream_summary");
    expect(recovered).toMatchObject({
      uuid: admitted?.event.uuid,
      timestamp: "2026-10-25T00:05:00.000Z",
      properties: {
        app_version: "0.0.16",
        started_at: "2026-10-25T00:00:00.000Z",
        watch_duration_seconds: 300,
        end_reason: "interrupted",
      },
    });
    expect(current?.summaries?.unfinished).toBeNull();
  });

  it("admits summaries separately from usage/reliability budgets, never reports continuations, and keeps an admitted end despite later rate saturation", async () => {
    clock();
    const { owner, events } = await start();
    const playing = run(owner);
    for (let i = 0; i < 100; i++) {
      owner.noteFeature("home");
      owner.noteRendererExit("crashed");
    }
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 70; i++) {
      const token = owner.beginPlayback("vod")!;
      const binding = owner.bindPlayback(token, "local")!;
      owner.notePlaybackState(token, binding, 1, "playing");
      owner.endPlayback(token);
      await vi.advanceTimersByTimeAsync(0);
    }
    // One live plus 59 titles admitted, independently of saturated reliability and usage.
    expect(events.filter((event) => event.event === "stream_summary")).toHaveLength(60);
    expect(
      events.some((event) => event.event === "stream_started" || event.event === "stream_stopped"),
    ).toBe(false);
    owner.endPlayback(playing.token);
    const continuation = run(owner, true);
    await vi.advanceTimersByTimeAsync(0);
    const before = events.filter((event) => event.event === "stream_summary").length;
    owner.endPlayback(continuation.token);
    await owner.close();
    expect(events.filter((event) => event.event === "stream_summary")).toHaveLength(before);
    expect(events.filter((event) => event.event === "renderer_exited")).toHaveLength(60);
  });

  it("drops invalid/future/wrong-identity optional blocks while preserving base consent, identity and every retired legacy name", async () => {
    const directory = await tempDir();
    const id = randomUUID();
    const common = {
      ...properties,
      profile_origin: "fresh",
      $process_person_profile: false,
      $geoip_disable: true,
    };
    const pending = [
      ["stream_started", { stream_type: "live" }],
      ["stream_stopped", { stream_type: "vod", watch_duration_seconds: 4 }],
      ...analyticsActions.map((key) => [key, {}]),
      ...analyticsFeatures.map((feature) => ["feature_opened", { feature }]),
      ...analyticsSettings.map((setting_key) => ["settings_changed", { setting_key }]),
      ["feature_opened", { feature: "home" }],
      ["settings_changed", { setting_key: "home_rows" }],
      [
        "stream_error",
        { stream_type: "live", error_type: "unsupported", diagnostic_stage: "future_stage" },
      ],
    ].map(([event, own]) => ({
      event: {
        uuid: randomUUID(),
        distinct_id: id,
        timestamp: new Date().toISOString(),
        event,
        properties: { ...common, ...(own as object) },
      },
      attempts: 1,
    }));
    for (const summaries of [
      { version: 9 },
      { version: 1 },
      { version: 1, installationId: randomUUID(), pending: [], usage: null, unfinished: null },
    ]) {
      await writeFile(
        join(directory, "analytics.json"),
        JSON.stringify({
          format: 2,
          enabled: true,
          installationId: id,
          profileOrigin: "fresh",
          firstSeen: true,
          lastDay: new Date().toISOString().slice(0, 10),
          pending,
          summaries,
        }),
      );
      const store = analyticsStore(directory);
      expect(await store.load()).toMatchObject({
        enabled: true,
        installationId: id,
        pending: pending.map((item) => ({ event: { uuid: item.event.uuid }, attempts: 1 })),
      });
      expect(await store.load()).not.toHaveProperty("summaries");
      const { owner, events } = await start({ store, directory });
      await until(() => events.length === pending.length);
      expect(events.map((event) => event.uuid)).toEqual(pending.map((item) => item.event.uuid));
      await owner.configure(false);
      expect(
        JSON.parse(await readFile(join(directory, "analytics.json"), "utf8")),
      ).not.toHaveProperty("summaries");
    }
  });

  it("shares the 64-slot budget, discards oldest summaries first and synchronously clears all work on consent ABA", async () => {
    clock();
    const { owner, store } = await start({
      transport: { kind: "local", send: () => new Promise(() => {}) },
    });
    const run = owner.beginPlayback("live")!;
    const binding = owner.bindPlayback(run, "local")!;
    owner.notePlaybackState(run, binding, 1, "playing");
    for (let i = 0; i < 10; i++) {
      owner.noteAction("search_used");
      owner.setUpdateChannel(i % 2 ? "stable" : "nightly");
      await vi.advanceTimersByTimeAsync(0);
    }
    owner.noteAction("epg_opened");
    for (let i = 0; i < 60; i++) owner.noteRendererExit("crashed");
    await vi.advanceTimersByTimeAsync(0);
    const record = await store.load();
    const durableCount = (record: AnalyticsRecord) =>
      record.pending.length +
      (record.lifecycle?.pending.length ?? 0) +
      (record.summaries?.pending.length ?? 0) +
      Number(!!record.summaries?.usage) +
      Number(!!record.summaries?.unfinished);
    expect(record?.summaries?.usage).toMatchObject({
      properties: { counts: { action_epg_opened: 1 } },
    });
    expect(record?.summaries?.unfinished).toBeTruthy();
    expect(durableCount(record!)).toBe(64);
    expect(record?.pending.filter((item) => item.event.event === "renderer_exited")).toHaveLength(
      60,
    );
    expect(record?.pending[0]?.event.event).toBe("installation_observed");
    expect(record?.summaries?.pending).toHaveLength(0);
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(128 * 1024);
    owner.noteAction("epg_opened");
    owner.endPlayback(run);
    await vi.advanceTimersByTimeAsync(0);
    const ended = await store.load();
    expect(durableCount(ended!)).toBe(64);
    expect(ended?.summaries?.unfinished).toBeNull();
    expect(ended?.summaries?.pending).toMatchObject([
      {
        event: {
          uuid: record?.summaries?.unfinished?.event.uuid,
          properties: { end_reason: "ended" },
        },
      },
    ]);
    expect(ended?.summaries?.usage).toMatchObject({
      uuid: record?.summaries?.usage?.uuid,
      properties: { counts: { action_epg_opened: 2 } },
    });
    const stale = owner.actionObserver("search_used");
    const disabled = owner.configure(false);
    owner.endPlayback(run);
    stale();
    await disabled;
    expect(await store.load()).not.toHaveProperty("summaries");
    expect((await store.load())?.pending).toEqual([]);
    await owner.configure(true);
    stale();
    await vi.advanceTimersByTimeAsync(0);
    expect((await store.load())?.summaries?.usage ?? null).toBeNull();
  });

  it("never persists an oversized record even when only protected identity work remains", async () => {
    clock();
    const first = await start();
    const before = await first.store.load();
    let saved = false;
    const owner = new Analytics({
      dataDir: first.directory,
      origin: Promise.resolve("unknown"),
      properties: { ...properties, app_version: "1".repeat(128 * 1024) + ".0.0" },
      store: {
        load: async () => before,
        save: async () => {
          saved = true;
        },
      },
      transport: { kind: "local", send: async () => "accepted" },
    });
    owners.push(owner);
    await owner.settings();
    owner.noteFeature("home");
    await vi.advanceTimersByTimeAsync(0);
    expect(await owner.settings()).toEqual({ enabled: true, transport: "unavailable" });
    expect(saved).toBe(false);
    expect((await first.store.load())?.installationId).toBe(before?.installationId);
  });

  it("fails closed at the existing 1.5s checkpoint deadline without resetting identity or consent", async () => {
    clock();
    const first = await start();
    const snapshot = await first.store.load();
    const owner = new Analytics({
      dataDir: first.directory,
      origin: Promise.resolve("fresh"),
      properties,
      store: { load: async () => snapshot, save: () => new Promise(() => {}) },
      transport: { kind: "local", send: async () => "accepted" },
    });
    owners.push(owner);
    await owner.settings();
    run(owner);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await owner.settings()).toEqual({ enabled: true, transport: "unavailable" });
    expect(snapshot?.installationId).toBe((await first.store.load())?.installationId);
  });
});

async function sink(withhold: boolean) {
  const bodies: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    // This suite inspects summary/reliability receipts; version receipts are covered separately.
    if (JSON.parse(body).event !== "app_version_observed") bodies.push(body);
    if (!withhold || JSON.parse(body).event !== "usage_window") res.end("ok");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback listener.");
  return { bodies, endpoint: `http://127.0.0.1:${address.port}/i/v0/e/` };
}

describe("real HTTP summary delivery", () => {
  it("spends at most three byte-identical body-timeout deliveries and lets ready incidents drain", async () => {
    // Advance scheduling time only. The actual HTTP socket and request deadline stay real.
    vi.useFakeTimers({ toFake: ["Date"] });
    const receiver = await sink(true);
    const directory = await tempDir();
    const store = analyticsStore(directory);
    const { owner } = await start({
      directory,
      store,
      transport: localCapture(receiver.endpoint)!,
    });
    await until(() => receiver.bodies.length === 2);
    owner.noteAction("search_used");
    await until(async () => !!(await store.load())?.summaries?.usage);
    owner.setUpdateChannel("nightly"); // Seal without ending this owned process.
    await until(() => receiver.bodies.length === 3);
    owner.noteRendererExit("crashed");
    await until(() => receiver.bodies.some((body) => JSON.parse(body).event === "renderer_exited"));
    for (let attempt = 1; attempt <= 2; attempt++) {
      await until(async () => (await store.load())?.summaries?.pending[0]?.attempts === attempt);
      await pause(1100);
      vi.setSystemTime(Date.now() + WINDOW_MS);
      owner.noteRendererExit("other");
      await until(
        () =>
          receiver.bodies.filter((body) => JSON.parse(body).event === "usage_window").length ===
          attempt + 1,
      );
    }
    await until(async () => (await store.load())?.summaries?.pending.length === 0);
    const deliveries = receiver.bodies.filter((body) => JSON.parse(body).event === "usage_window");
    expect(deliveries).toHaveLength(3);
    expect(new Set(deliveries).size).toBe(1);
  });

  it("retains refused-connect summaries without burning deliveries and expires them after seven days", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const receiver = await sink(false);
    const directory = await tempDir();
    const store = analyticsStore(directory);
    const { owner } = await start({
      directory,
      store,
      transport: localCapture(receiver.endpoint)!,
    });
    await until(() => receiver.bodies.length === 2);
    receiver.bodies.length = 0;
    const server = servers.at(-1)!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.pop();
    owner.noteFeature("home");
    owner.setUpdateChannel("nightly");
    await until(async () => ((await store.load())?.summaries?.pending[0]?.failures ?? 0) >= 1);
    expect((await store.load())?.summaries?.pending[0]?.attempts).toBe(0);
    expect(receiver.bodies).toEqual([]);
    vi.setSystemTime(Date.now() + 8 * 86_400_000);
    owner.noteRendererExit("other");
    await until(async () => (await store.load())?.summaries?.pending.length === 0);
  });
});
