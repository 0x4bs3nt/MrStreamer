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
  type CaptureEvent,
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
        events.push(structuredClone(event));
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
    for (let i = 0; i < 60; i++) {
      owner.noteAction("search_used");
      owner.setUpdateChannel(i % 2 ? "stable" : "nightly");
      await vi.advanceTimersByTimeAsync(0);
    }
    for (let i = 0; i < 60; i++) owner.noteRendererExit("crashed");
    await vi.advanceTimersByTimeAsync(0);
    const record = await store.load();
    expect(record!.pending.length + record!.summaries!.pending.length).toBe(64);
    expect(record?.pending.filter((item) => item.event.event === "renderer_exited")).toHaveLength(
      60,
    );
    expect(record?.pending[0]?.event.event).toBe("installation_observed");
    expect(record?.summaries?.pending).toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(128 * 1024);
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
    bodies.push(body);
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
