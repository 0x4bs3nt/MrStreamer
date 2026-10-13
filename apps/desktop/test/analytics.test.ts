import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { type } from "arktype";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipcInputs } from "@mrstreamer/contracts/ipc";
import { analyticsBuild, analyticsReleaseConfiguration } from "../src/main/analytics/build.ts";
import {
  AnalyticsRecord,
  CaptureEvent,
  type BuildProperties,
} from "../src/main/analytics/model.ts";
import { emptySummaryCounts } from "../src/main/analytics/summary.ts";
import { appFailure, downloadFailure, checkFailure } from "../src/main/analytics/operations.ts";
import { Analytics } from "../src/main/analytics/service.ts";
import { analyticsStore, profileOrigin } from "../src/main/analytics/storage.ts";
import {
  analyticsTransport,
  localCapture,
  type CaptureTransport,
} from "../src/main/analytics/transport.ts";
import { tempDir } from "./support.ts";

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

const properties: BuildProperties = {
  app_version: "0.0.11-nightly.20261011.284",
  build_channel: "nightly",
  update_channel: "stable",
  os: "linux",
  arch: "x64",
  distribution: "direct",
};

/** Lifecycle clock tests keep persistence immediate; disk and failure cases use real files. */
function memoryStore(): ReturnType<typeof analyticsStore> {
  let current: typeof AnalyticsRecord.infer | null = null;
  return {
    async load() {
      return current && structuredClone(current);
    },
    async save(record) {
      current = structuredClone(record);
    },
  };
}

async function start(
  options: {
    dataDir?: string;
    properties?: BuildProperties;
    transport?: Omit<CaptureTransport, "kind"> | null;
    store?: ReturnType<typeof analyticsStore>;
  } = {},
) {
  const dataDir = options.dataDir ?? (await tempDir());
  const events: CaptureEvent[] = [];
  const transport =
    options.transport === undefined
      ? {
          async send(event: CaptureEvent) {
            events.push(structuredClone(event));
            return "accepted" as const;
          },
        }
      : options.transport;
  const owner = new Analytics({
    dataDir,
    origin: profileOrigin(dataDir),
    properties: options.properties ?? properties,
    transport: transport ? { ...transport, kind: "local" } : null,
    ...(options.store ? { store: options.store } : {}),
  });
  owners.push(owner);
  await owner.settings();
  return { owner, dataDir, events };
}

async function saved(dataDir: string) {
  const record = AnalyticsRecord(
    JSON.parse(await readFile(join(dataDir, "analytics.json"), "utf8")),
  );
  if (record instanceof type.errors) throw new Error("Invalid test analytics state.");
  return record;
}

/** Lets observable asynchronous storage/network side effects finish, including under fake clocks. */
async function until(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    try {
      if (await check()) return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await pause(5);
  }
  throw new Error("Analytics side effect did not complete.");
}

async function captureServer(status: number | (() => number) = 200) {
  const payloads: unknown[] = [];
  const server = createServer(async (req, res) => {
    const bytes: Buffer[] = [];
    for await (const chunk of req) bytes.push(Buffer.from(chunk));
    payloads.push(JSON.parse(Buffer.concat(bytes).toString()));
    res.writeHead(typeof status === "number" ? status : status(), {
      Location: "https://us.i.posthog.com/i/v0/e/",
    });
    res.end("ok");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local capture address.");
  return { payloads, endpoint: `http://127.0.0.1:${address.port}/i/v0/e/` };
}

describe("analytics observations", () => {
  it("defaults on, but only foreground app use creates first-seen and daily observations", async () => {
    const { owner, events, dataDir } = await start();
    expect(await owner.settings()).toEqual({ enabled: true, transport: "local" });
    owner.setForeground(false);
    await owner.settings();
    expect(events).toEqual([]);
    owner.setForeground(true);
    await until(() => events.length === 2);
    owner.setForeground(false);
    owner.setForeground(true);
    await owner.settings();
    expect(events.map((event) => event.event)).toEqual(["installation_observed", "app_active_day"]);
    expect(events[0]?.properties.profile_origin).toBe("fresh");
    expect(events[0]?.distinct_id).toBe(events[1]?.distinct_id);
    expect((await saved(dataDir)).installationId).toBe(events[0]?.distinct_id);
    expect(await owner.settings()).not.toHaveProperty("installationId");
  });

  it("retains identity and origin on restart, and separates an upgraded profile from an unknown one", async () => {
    for (const [file, origin] of [
      ["preferences.json", "upgrading"],
      ["Local State", "unknown"],
    ] as const) {
      const dataDir = await tempDir();
      await writeFile(join(dataDir, file), "{}");
      const first = await start({ dataDir });
      first.owner.setForeground(true);
      await until(() => first.events.length === 2);
      expect(first.events[0]?.properties.profile_origin).toBe(origin);
      await first.owner.close();
      const second = await start({ dataDir });
      second.owner.setForeground(true);
      await second.owner.settings();
      expect(second.events).toEqual([]);
      expect((await saved(dataDir)).installationId).toBe(first.events[0]?.distinct_id);
      expect((await saved(dataDir)).profileOrigin).toBe(origin);
    }
  });

  it("observes UTC rollover during a long foreground session, and never backfills hidden days", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(new Date("2026-10-11T23:59:30Z"));
    const store = memoryStore();
    const { owner, events } = await start({ store });
    owner.setForeground(true);
    await until(async () => events.length === 2 && (await store.load())?.pending.length === 0);
    vi.setSystemTime(new Date("2026-10-12T00:00:30Z"));
    await vi.advanceTimersByTimeAsync(60_000);
    await until(async () => events.length === 3 && (await store.load())?.pending.length === 0);
    expect(events[2]).toMatchObject({
      event: "app_active_day",
      properties: { activity_date: "2026-10-12" },
    });
    owner.setForeground(false);
    vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toHaveLength(3);
    owner.setForeground(true);
    await until(() => events.length === 4);
    expect(events[3]).toMatchObject({ properties: { activity_date: "2026-10-14" } });
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    await vi.advanceTimersByTimeAsync(60_000);
    await owner.settings();
    expect(events).toHaveLength(4);
  });

  it("keeps selected update channel separate from the installed build and copies only coarse properties", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    const store = memoryStore();
    const { owner, events } = await start({ store });
    owner.setForeground(true);
    await until(async () => events.length === 2 && (await store.load())?.pending.length === 0);
    owner.setUpdateChannel("nightly");
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
    await vi.advanceTimersByTimeAsync(60_000);
    await until(() => events.length === 3);
    expect(events[0]?.properties).toMatchObject({
      build_channel: "nightly",
      update_channel: "stable",
    });
    expect(events[2]?.properties).toMatchObject({
      build_channel: "nightly",
      update_channel: "nightly",
    });
    expect(
      analyticsBuild({
        version: "private text",
        packaged: true,
        platform: "custom",
        arch: "riscv64",
        store: true,
      }),
    ).toEqual({
      app_version: "unknown",
      build_channel: "unknown",
      os: "unknown",
      arch: "unknown",
      distribution: "store",
    });
    expect(
      analyticsBuild({
        version: "0.0.11",
        packaged: false,
        platform: "darwin",
        arch: "arm64",
        store: false,
      }),
    ).toMatchObject({ build_channel: "unknown" });
    expect(
      analyticsBuild({
        version: "0.0.11",
        packaged: true,
        platform: "win32",
        arch: "ia32",
        store: true,
      }),
    ).toMatchObject({ build_channel: "stable", distribution: "store" });
  });
});

describe("analytics consent and persistence", () => {
  it("has a narrow typed IPC preference, persists disable before first use and stays off on restart", async () => {
    expect(
      ipcInputs["preferences.update"]()({
        analyticsEnabled: false,
        event: "title",
        installationId: "secret",
      }),
    ).toEqual({ analyticsEnabled: false });
    expect(ipcInputs["preferences.update"]()({ analyticsEnabled: "false" })).toBeInstanceOf(
      type.errors,
    );
    const first = await start();
    await first.owner.configure(false);
    first.owner.setForeground(true);
    await first.owner.settings();
    expect(first.events).toEqual([]);
    expect((await saved(first.dataDir)).installationId).toBeNull();
    await first.owner.close();
    const restarted = await start({ dataDir: first.dataDir });
    restarted.owner.setForeground(true);
    expect(await restarted.owner.settings()).toEqual({ enabled: false, transport: "local" });
    expect(restarted.events).toEqual([]);
    await restarted.owner.configure(true);
    await until(() => restarted.events.length === 2);
    expect(restarted.events[0]?.properties.profile_origin).toBe("fresh");
  });

  it("reenables with the same identity without a duplicate installation or activity day", async () => {
    const { owner, events, dataDir } = await start();
    owner.setForeground(true);
    await until(() => events.length === 2);
    const identity = events[0]?.distinct_id;
    await owner.configure(false);
    expect((await saved(dataDir)).pending).toEqual([]);
    await owner.configure(true);
    await owner.settings();
    expect(events).toHaveLength(2);
    expect((await saved(dataDir)).installationId).toBe(identity);
    expect((await saved(dataDir)).firstSeen).toBe(true);
  });

  it("disables synchronously while capture waits on persistence, and the latest consent write wins", async () => {
    const dataDir = await tempDir();
    const disk = analyticsStore(dataDir);
    let release: (() => void) | undefined;
    let saving = false;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { owner, events } = await start({
      dataDir,
      store: {
        load: disk.load,
        async save(record) {
          saving = true;
          await wait;
          await disk.save(record);
        },
      },
    });
    owner.setForeground(true);
    await until(() => saving);
    const disabling = owner.configure(false);
    expect(events).toEqual([]);
    release?.();
    await disabling;
    expect(events).toEqual([]);
    expect((await saved(dataDir)).pending).toEqual([]);
    const enabling = owner.configure(true);
    const lastDisable = owner.configure(false);
    await Promise.all([enabling, lastDisable]);
    expect(await owner.settings()).toMatchObject({ enabled: false });
    expect(events).toEqual([]);
  });

  it("aborts its active request, clears pending events and restart never resumes them", async () => {
    let signal: AbortSignal | undefined;
    const { owner, dataDir } = await start({
      transport: {
        send(_event, owned) {
          signal = owned;
          return new Promise((resolve) =>
            owned.addEventListener("abort", () => resolve("retry"), { once: true }),
          );
        },
      },
    });
    owner.setForeground(true);
    await until(() => signal !== undefined);
    const disabling = owner.configure(false);
    expect(signal?.aborted).toBe(true);
    await disabling;
    expect((await saved(dataDir)).pending).toEqual([]);
    await owner.close();
    const restarted = await start({ dataDir });
    restarted.owner.setForeground(true);
    await restarted.owner.settings();
    expect(restarted.events).toEqual([]);
  });

  it("fails closed on damaged or unreadable telemetry without creating a fresh identity or logging it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const text of [
        "{broken",
        '{"format":1,"installationId":"PRIVATE-ID","enabled":false}',
      ]) {
        const dataDir = await tempDir();
        await writeFile(join(dataDir, "analytics.json"), text);
        const { owner, events } = await start({ dataDir });
        owner.setForeground(true);
        expect(await owner.settings()).toEqual({ enabled: false, transport: "unavailable" });
        await expect(owner.configure(true)).rejects.toThrow(
          "Analytics preference could not be saved.",
        );
        expect(events).toEqual([]);
        expect(await readFile(join(dataDir, "analytics.json"), "utf8")).toBe(text);
      }
      const unavailable = await start({
        store: {
          load: async () => {
            throw new Error("PRIVATE-ID");
          },
          save: async () => {},
        },
      });
      expect(await unavailable.owner.settings()).toMatchObject({ transport: "unavailable" });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("never sends an unpersisted identity and sanitizes a failed opt-out write", async () => {
    const failing = await start({
      store: {
        load: async () => null,
        save: async () => {
          throw new Error("PRIVATE-ID");
        },
      },
    });
    failing.owner.setForeground(true);
    await until(async () => (await failing.owner.settings()).transport === "unavailable");
    expect(failing.events).toEqual([]);
    await expect(failing.owner.configure(false)).rejects.toThrow(
      "Analytics preference could not be saved.",
    );
  });

  it("keeps an unconfigured integration disabled regardless of enabled preference", async () => {
    const { owner, dataDir } = await start({ transport: null });
    expect(await owner.settings()).toEqual({ enabled: true, transport: "unconfigured" });
    owner.setForeground(true);
    owner.noteFeature("home");
    owner.noteRenderer("starts");
    expect(owner.noteOperationStarted("update_check")).toBeNull();
    await owner.configure(false);
    await owner.configure(true);
    expect((await saved(dataDir)).installationId).toBeNull();
    expect((await saved(dataDir)).summary).toBeUndefined();
    expect((await saved(dataDir)).pending).toEqual([]);
  });
});

describe("analytics delivery and deadlines", () => {
  it("requires named release configuration and excludes development, isolated and automated profiles", () => {
    const production = analyticsReleaseConfiguration({
      releaseBuild: true,
      host: "https://eu.i.posthog.com",
      projectToken: "phc_local_contract_fixture",
    });
    expect(production).toEqual({
      releaseBuild: true,
      capture: {
        endpoint: "https://eu.i.posthog.com/i/v0/e/",
        projectToken: "phc_local_contract_fixture",
      },
    });
    for (const invalid of [
      {
        releaseBuild: false,
        host: "https://eu.i.posthog.com",
        projectToken: "phc_local_contract_fixture",
      },
      { releaseBuild: true, host: undefined, projectToken: "phc_local_contract_fixture" },
      { releaseBuild: true, host: "https://eu.i.posthog.com", projectToken: undefined },
      {
        releaseBuild: true,
        host: "https://other.example",
        projectToken: "phc_local_contract_fixture",
      },
      { releaseBuild: true, host: "https://us.i.posthog.com", projectToken: "personal-api-key" },
    ])
      expect(analyticsReleaseConfiguration(invalid)).toEqual({
        releaseBuild: false,
        capture: null,
      });
    const eligible = {
      production: production.capture,
      releaseBuild: true,
      packaged: true,
      isolated: false,
      automated: false,
      localEndpoint: undefined,
    };
    // Merely constructing eligible configuration makes no request to its host.
    expect(analyticsTransport(eligible)?.kind).toBe("production");
    for (const excluded of [
      { ...eligible, releaseBuild: false },
      { ...eligible, packaged: false },
      { ...eligible, isolated: true },
      { ...eligible, automated: true },
      { ...eligible, localEndpoint: "https://eu.i.posthog.com/i/v0/e/" },
    ])
      expect(analyticsTransport(excluded)).toBeNull();
    expect(
      analyticsTransport({
        ...eligible,
        isolated: true,
        automated: true,
        localEndpoint: "http://127.0.0.1:1234/i/v0/e/",
      })?.kind,
    ).toBe("local");
  });
  it("inspects the exact local HTTP payload allowlist and never follows a redirect to production", async () => {
    const capture = await captureServer(302);
    const transport = localCapture(capture.endpoint);
    expect(transport).not.toBeNull();
    const { owner } = await start({ transport });
    owner.setForeground(true);
    await until(() => capture.payloads.length === 2);
    const first = CaptureEvent(capture.payloads[0]);
    const day = CaptureEvent(capture.payloads[1]);
    if (first instanceof type.errors || day instanceof type.errors)
      throw new Error("Invalid local payload.");
    expect(capture.payloads[0]).toEqual({ api_key: "mrstreamer-local-verification", ...first });
    expect(first.properties).toEqual({
      ...properties,
      profile_origin: "fresh",
      $process_person_profile: false,
      $geoip_disable: true,
    });
    expect(capture.payloads[1]).toEqual({ api_key: "mrstreamer-local-verification", ...day });
    expect(day.properties).toEqual({
      ...first.properties,
      activity_date: day.timestamp.slice(0, 10),
    });
    expect(first.distinct_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.uuid).not.toBe(day.uuid);
    for (const endpoint of [
      "https://us.i.posthog.com/i/v0/e/",
      "https://eu.i.posthog.com/i/v0/e/",
      "http://localhost:1234/i/v0/e/",
      "http://example.com:1234/i/v0/e/",
      "http://127.0.0.1:1234/other",
      "http://user:secret@127.0.0.1:1234/i/v0/e/",
      "http://127.0.0.1:1234/i/v0/e/?token=secret",
      "bad address",
    ]) {
      expect(localCapture(endpoint)).toBeNull();
    }
  });

  it("copies only allowed values at capture even when a loaded caller supplies extra content", async () => {
    const capture = await captureServer();
    const transport = localCapture(capture.endpoint);
    if (!transport) throw new Error("No local transport.");
    const fixture = {
      event: "installation_observed" as const,
      uuid: "da0330b7-8e49-4f15-96d3-db7598f60a47",
      distinct_id: "f157c0b7-1b97-4a60-a96b-1c2ca9e56904",
      timestamp: "2026-10-11T12:00:00.000Z",
      private_title: "private",
      properties: {
        ...properties,
        profile_origin: "unknown" as const,
        $process_person_profile: false as const,
        $geoip_disable: true as const,
        provider: "private",
      },
    };
    expect(await transport.send(fixture, new AbortController().signal)).toBe("accepted");
    expect(capture.payloads[0]).not.toHaveProperty("private_title");
    expect(capture.payloads[0]).not.toHaveProperty("properties.provider");
  });

  it("retries a failing local HTTP endpoint with identical event identity, then delivers the activity", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let requests = 0;
    const capture = await captureServer(() => (++requests === 1 ? 503 : 200));
    const local = localCapture(capture.endpoint)!;
    let answered = 0;
    const { owner, dataDir } = await start({
      transport: {
        async send(event, signal) {
          const result = await local.send(event, signal);
          answered++;
          return result;
        },
      },
    });
    owner.setForeground(true);
    await until(() => capture.payloads.length === 1 && answered === 1);
    // The retry waits out its backoff on the fake clock, once the refusal is in.
    await vi.advanceTimersByTimeAsync(2000);
    await until(
      async () => capture.payloads.length === 3 && (await saved(dataDir)).pending.length === 0,
    );
    expect(capture.payloads[1]).toEqual(capture.payloads[0]);
    expect(capture.payloads[2]).toMatchObject({ event: "app_active_day" });
  });

  it("retries offline events with the exact UUID/timestamp and bounds attempts across restart", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const events: CaptureEvent[] = [];
    const store = memoryStore();
    const offline: Omit<CaptureTransport, "kind"> = {
      async send(event) {
        events.push(structuredClone(event));
        return "retry";
      },
    };
    const first = await start({
      store,
      transport: {
        send(event, signal) {
          events.push(structuredClone(event));
          return new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve("retry"), { once: true }),
          );
        },
      },
    });
    first.owner.setForeground(true);
    await until(() => events.length === 1);
    await first.owner.settings();
    const close = first.owner.close();
    await vi.advanceTimersByTimeAsync(500);
    await close;
    const restarted = await start({ dataDir: first.dataDir, transport: offline, store });
    restarted.owner.setForeground(true);
    await until(() => events.length > 1);
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(2000);
      await restarted.owner.settings();
    }
    await until(async () => (await store.load())?.pending.length === 0);
    const installs = events.filter((event) => event.event === "installation_observed");
    const days = events.filter((event) => event.event === "app_active_day");
    expect(installs.length).toBeLessThanOrEqual(3);
    expect(days.length).toBeLessThanOrEqual(3);
    for (const event of installs) expect(event).toEqual(installs[0]);
    for (const event of days) expect(event).toEqual(days[0]);
  });

  it("bounds its persisted outbox while foreground days accumulate behind an offline transport", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const store = memoryStore();
    let signal: AbortSignal | undefined;
    const { owner } = await start({
      store,
      transport: {
        send(_event, owned) {
          signal = owned;
          return new Promise(() => {});
        },
      },
    });
    owner.setForeground(true);
    // Finish each observation before moving the clock; file visibility can precede save completion.
    await vi.advanceTimersByTimeAsync(0);
    const first = await store.load();
    expect(first?.firstSeen).toBe(true);
    expect(signal).toBeDefined();
    for (let day = 2; day <= 20; day++) {
      owner.setForeground(false);
      const date = `2026-10-${String(day).padStart(2, "0")}`;
      vi.setSystemTime(new Date(`${date}T12:00:00Z`));
      owner.setForeground(true);
      await vi.advanceTimersByTimeAsync(0);
      const record = await store.load();
      expect(record?.lastDay).toBe(date);
      expect(record?.pending.length).toBeLessThanOrEqual(8);
    }
    const kept = await store.load();
    expect(kept?.pending).toHaveLength(8);
    expect(kept?.pending[0]?.event.event).toBe("installation_observed");
    expect(kept?.pending[0]?.event).toEqual(first?.pending[0]?.event);
    expect(kept?.installationId).toBe(first?.installationId);
    expect(kept?.firstSeen).toBe(true);
    expect(
      kept?.pending.flatMap(({ event }) =>
        event.event === "app_active_day" ? [event.properties.activity_date] : [],
      ),
    ).toEqual([
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
    ]);
    expect(await owner.settings()).toEqual({ enabled: true, transport: "local" });
    const closing = owner.close();
    await vi.advanceTimersByTimeAsync(500);
    await closing;
    expect(signal?.aborted).toBe(true);
    expect(await store.load()).toEqual(kept);
  });

  it("bounds startup state reads and preference writes when storage never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const dataDir = await tempDir();
    const owner = new Analytics({
      dataDir,
      origin: Promise.resolve("unknown"),
      properties,
      transport: null,
      store: { load: () => new Promise(() => {}), save: async () => {} },
    });
    owners.push(owner);
    const settings = owner.settings();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await settings).toMatchObject({ transport: "unavailable" });
    const stalledWrite = await start({
      store: { load: async () => null, save: () => new Promise(() => {}) },
    });
    const changed = expect(stalledWrite.owner.configure(false)).rejects.toThrow(
      "Analytics preference could not be saved.",
    );
    await vi.advanceTimersByTimeAsync(1500);
    await changed;
    expect(await stalledWrite.owner.settings()).toMatchObject({ transport: "unavailable" });
  });
});

describe("completed daily product and reliability capture", () => {
  function clock(day = "2026-10-11") {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(new Date(`${day}T12:00:00Z`));
  }

  async function nextDay(owner: Analytics, day = "2026-10-12") {
    owner.setForeground(false);
    vi.setSystemTime(new Date(`${day}T12:00:00Z`));
    owner.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
  }

  it("captures fixed counts and bounded failures with terminal denominators independent of start day", async () => {
    clock();
    const capture = await captureServer();
    const { owner } = await start({ transport: localCapture(capture.endpoint) });
    owner.setForeground(true);
    await until(() => capture.payloads.length === 2);
    for (const feature of [
      "home",
      "live_tv",
      "movies",
      "series",
      "watchlist",
      "downloads",
      "search",
      "settings",
      "player",
      "details",
    ] as const)
      owner.noteFeature(feature);
    const midnight = owner.noteOperationStarted("playback_open");
    for (const outcome of ["success", "success", "failed", "interrupted"] as const) {
      const generation = owner.noteOperationStarted("download_transfer");
      owner.noteOperationFinished(
        "download_transfer",
        generation,
        outcome,
        downloadFailure({ kind: "folder", detail: "/PRIVATE/PATH" }),
      );
    }
    for (const outcome of ["success", "failed"] as const) {
      const generation = owner.noteOperationStarted("update_check");
      owner.noteOperationFinished(
        "update_check",
        generation,
        outcome,
        checkFailure({ kind: "offline" }),
      );
    }
    owner.noteRenderer("starts");
    owner.noteRenderer("starts");
    owner.noteRenderer("crashed");
    await nextDay(owner);
    await until(() => capture.payloads.length === 4);
    owner.noteOperationFinished(
      "playback_open",
      midnight,
      "failed",
      appFailure({ kind: "unreachable", server: "PRIVATE", detail: "SECRET" }),
    );
    const summary = CaptureEvent(capture.payloads[3]);
    if (summary instanceof type.errors || summary.event !== "app_summary_day")
      throw new Error("No completed summary.");
    expect(summary.properties.summary_date).toBe("2026-10-11");
    expect(Object.values(summary.properties.counts.features)).toEqual(Array(10).fill(1));
    expect(summary.properties.counts.download_transfer).toMatchObject({
      started: 4,
      success: 2,
      failed: 1,
      interrupted: 1,
      failures: { disk: 1 },
    });
    expect(summary.properties.counts.update_check).toMatchObject({
      started: 2,
      success: 1,
      failed: 1,
      failures: { network: 1 },
    });
    expect(summary.properties.counts.playback_open).toMatchObject({ started: 1, failed: 0 });
    const transfer = summary.properties.counts.download_transfer;
    expect(transfer.success / (transfer.success + transfer.failed)).toBe(2 / 3);
    expect(summary.properties.counts.renderer).toEqual({
      starts: 2,
      crashed: 1,
      killed: 0,
      other: 0,
    });
    expect(JSON.stringify(capture.payloads)).not.toMatch(/PRIVATE|SECRET/);
    await nextDay(owner, "2026-10-13");
    await until(() => capture.payloads.length === 6);
    expect(capture.payloads[5]).toMatchObject({
      properties: {
        counts: { playback_open: { started: 0, failed: 1, failures: { network: 1 } } },
      },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(capture.payloads).toHaveLength(6);
  });

  it("preserves the previous build's recorded dimensions when an upgrade precedes rollover", async () => {
    clock();
    const store = memoryStore();
    const before = await start({ store });
    before.owner.setForeground(true);
    await until(() => before.events.length === 2);
    const generation = before.owner.noteOperationStarted("playback_open");
    before.owner.noteOperationFinished("playback_open", generation, "failed", "unsupported");
    await before.owner.close();
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
    const upgraded = {
      ...properties,
      app_version: "0.0.12",
      build_channel: "stable" as const,
      update_channel: "nightly" as const,
    };
    const after = await start({ store, properties: upgraded });
    after.owner.setForeground(true);
    await until(() => after.events.length === 2);
    expect(after.events[0]).toMatchObject({ event: "app_active_day", properties: upgraded });
    expect(after.events[1]).toMatchObject({
      event: "app_summary_day",
      properties: {
        ...properties,
        summary_date: "2026-10-11",
        counts: { playback_open: { failed: 1 } },
      },
    });
    expect(after.events[1]?.distinct_id).toBe(before.events[0]?.distinct_id);
  });

  it("resets partial-day counts on build or update-channel changes and excludes stale check results", async () => {
    clock();
    const store = memoryStore();
    const before = await start({ store });
    before.owner.setForeground(true);
    await until(() => before.events.length === 2);
    before.owner.noteFeature("home");
    await before.owner.close();
    const upgraded = { ...properties, app_version: "0.0.12", build_channel: "stable" as const };
    const after = await start({ store, properties: upgraded });
    after.owner.noteFeature("movies");
    const oldCheck = after.owner.noteOperationStarted("update_check");
    after.owner.setUpdateChannel("nightly");
    after.owner.noteOperationFinished("update_check", oldCheck, "failed", "network");
    after.owner.noteFeature("series");
    const newCheck = after.owner.noteOperationStarted("update_check");
    after.owner.noteOperationFinished("update_check", newCheck, "success");
    await nextDay(after.owner);
    await until(() => after.events.length === 2);
    expect(after.events[1]).toMatchObject({
      event: "app_summary_day",
      properties: {
        ...upgraded,
        update_channel: "nightly",
        counts: {
          features: { home: 0, movies: 0, series: 1 },
          update_check: { started: 1, success: 1, failed: 0 },
        },
      },
    });
  });

  it("excludes obsolete outcomes after a channel round trip, keeps same-channel midnight results and pending dimensions", async () => {
    clock();
    const capture = await captureServer();
    let accepting = false;
    const transport = localCapture(capture.endpoint);
    if (!transport) throw new Error("No local transport.");
    const store = memoryStore();
    const { owner } = await start({
      store,
      transport: {
        async send(event, signal) {
          if (!accepting) return "retry";
          return transport.send(event, signal);
        },
      },
    });
    owner.setForeground(true);
    await until(async () => (await store.load())?.pending[0]?.attempts === 1);
    const pending = (await store.load())?.pending.map((item) => item.event);
    const obsolete = owner.noteOperationStarted("update_check");
    owner.setUpdateChannel("nightly");
    owner.setUpdateChannel("stable");
    const current = owner.noteOperationStarted("update_check");
    owner.setUpdateChannel("stable");
    owner.noteOperationFinished("update_check", current, "success");
    owner.noteOperationFinished("update_check", obsolete, "failed", "network");
    await vi.advanceTimersByTimeAsync(1000);
    // Channel changes do not relabel events already waiting in the durable outbox.
    expect((await store.load())?.pending.map((item) => item.event)).toEqual(pending);
    accepting = true;
    await nextDay(owner);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => capture.payloads.length === 4);
    expect(capture.payloads[3]).toMatchObject({
      event: "app_summary_day",
      properties: {
        update_channel: "stable",
        counts: { update_check: { started: 1, success: 1, failed: 0, failures: { network: 0 } } },
      },
    });
    // Same-owner, same-channel results remain valid when only the UTC day changes.
    const crossing = owner.noteOperationStarted("playback_open");
    await nextDay(owner, "2026-10-13");
    await until(() => capture.payloads.length === 6);
    owner.setUpdateChannel("stable");
    owner.noteOperationFinished("playback_open", crossing, "success");
    await nextDay(owner, "2026-10-14");
    await until(() => capture.payloads.length === 8);
    expect(capture.payloads[7]).toMatchObject({
      properties: { counts: { playback_open: { started: 0, success: 1 } } },
    });
  });

  it("does not accept an outcome whose start was dropped during clock rollback", async () => {
    clock();
    const { owner, events } = await start({ store: memoryStore() });
    owner.setForeground(true);
    await until(() => events.length === 2);
    owner.noteFeature("home");
    vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
    const dropped = owner.noteOperationStarted("playback_open");
    expect(dropped).toBeNull();
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    owner.noteOperationFinished("playback_open", dropped, "failed", "app");
    const observed = owner.noteOperationStarted("playback_open");
    owner.noteOperationFinished("playback_open", observed, "success");
    await nextDay(owner);
    await until(() => events.length === 4);
    expect(events[3]).toMatchObject({
      properties: { counts: { playback_open: { started: 1, success: 1, failed: 0 } } },
    });
  });

  it("pauses notes synchronously, clears daily counts, and never backfills across off/on or restart", async () => {
    clock();
    const store = memoryStore();
    const { owner } = await start({ store });
    owner.setForeground(true);
    await until(async () => (await store.load())?.pending.length === 0);
    const old = owner.noteOperationStarted("playback_open");
    owner.noteFeature("home");
    const off = owner.configure(false);
    owner.noteFeature("movies");
    owner.noteOperationFinished("playback_open", old, "failed", "app");
    await off;
    expect((await store.load())?.summary).toBeUndefined();
    await owner.close();
    const restarted = await start({ store });
    restarted.owner.noteFeature("series");
    await restarted.owner.configure(true);
    restarted.owner.noteOperationFinished("playback_open", old, "success");
    restarted.owner.noteFeature("settings");
    await nextDay(restarted.owner);
    await until(() => restarted.events.length === 2);
    expect(restarted.events[1]).toMatchObject({
      properties: {
        counts: {
          features: { home: 0, movies: 0, series: 0, settings: 1 },
          playback_open: { success: 0, failed: 0 },
        },
      },
    });
  });

  it("coalesces a burst through slow storage so opt-out needs only bounded persistence work", async () => {
    clock();
    const disk = memoryStore();
    let pendingSave: (() => void) | undefined;
    let gated = false;
    const store = {
      load: disk.load,
      async save(record: AnalyticsRecord) {
        if (gated)
          await new Promise<void>((resolve) => {
            pendingSave = resolve;
          });
        await disk.save(record);
      },
    };
    const { owner } = await start({ store });
    owner.setForeground(true);
    await until(async () => (await disk.load())?.pending.length === 0);
    gated = true;
    for (let n = 0; n < 10_000; n++) owner.noteFeature("home");
    await vi.advanceTimersByTimeAsync(1000);
    expect(pendingSave).toBeDefined();
    for (let n = 0; n < 10_000; n++) owner.noteFeature("home");
    const off = owner.configure(false);
    owner.noteFeature("home");
    gated = false;
    pendingSave?.();
    await off;
    expect((await disk.load())?.summary).toBeUndefined();
    expect(await owner.settings()).toMatchObject({ enabled: false, transport: "local" });
  });

  it("keeps only the newest completed bucket and never reopens days on clock rollback", async () => {
    clock();
    const { owner, events } = await start({ store: memoryStore() });
    owner.noteFeature("home");
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
    owner.noteFeature("movies");
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    owner.noteFeature("series");
    owner.setForeground(true);
    await until(() => events.length === 3);
    expect(events[2]).toMatchObject({
      event: "app_summary_day",
      properties: { summary_date: "2026-10-12", counts: { features: { home: 0, movies: 1 } } },
    });
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    owner.noteFeature("home");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toHaveLength(3);
    await nextDay(owner, "2026-10-14");
    await until(() => events.length === 5);
    expect(events[4]).toMatchObject({
      properties: { summary_date: "2026-10-13", counts: { features: { home: 0, series: 1 } } },
    });
  });

  it("migrates format-one state without a summary and preserves disabled consent and identity", async () => {
    const first = await start();
    first.owner.setForeground(true);
    await until(() => first.events.length === 2);
    await first.owner.configure(false);
    await first.owner.close();
    const old = await saved(first.dataDir);
    expect(old.summary).toBeUndefined();
    const restarted = await start({ dataDir: first.dataDir });
    restarted.owner.noteFeature("home");
    await restarted.owner.configure(true);
    restarted.owner.noteFeature("movies");
    await restarted.owner.close();
    const kept = await saved(first.dataDir);
    expect(kept.installationId).toBe(old.installationId);
    expect(kept.summary?.counts.features).toMatchObject({ home: 0, movies: 1 });
    expect(restarted.events).toEqual([]);
  });

  it("caps counts and flags clipping, validates renderer literals, and strips nested payload extras", async () => {
    clock();
    expect(ipcInputs["analytics.feature"]()("details")).toBe("details");
    for (const value of ["PRIVATE", { feature: "home", query: "PRIVATE" }, { feature: "home" }])
      expect(ipcInputs["analytics.feature"]()(value)).toBeInstanceOf(type.errors);
    const { owner, events, dataDir } = await start();
    owner.setForeground(true);
    await until(() => events.length === 2);
    owner.noteFeature("home");
    await owner.close();
    const stored = await saved(dataDir);
    if (!stored.summary) throw new Error("No counts.");
    stored.summary.counts.features.home = 1_000_000;
    stored.summary.counts.actions.favourite_added = 1_000_000;
    stored.summary.counts.settings.title_language = 1_000_000;
    stored.summary.counts.playback.live.starts = 1_000_000;
    await analyticsStore(dataDir).save(stored);
    const restarted = await start({ dataDir });
    restarted.owner.noteFeature("home");
    restarted.owner.noteAction("favourite_added");
    restarted.owner.noteSetting("title_language");
    const token = restarted.owner.beginPlayback("live")!;
    const binding = restarted.owner.bindPlayback(token, "local")!;
    restarted.owner.notePlaybackState(token, binding, 1, "playing");
    await nextDay(restarted.owner);
    await until(() => restarted.events.length === 2);
    const event = restarted.events[1];
    expect(event).toMatchObject({
      properties: {
        counts: {
          saturated: true,
          features: { home: 1_000_000 },
          actions: { favourite_added: 1_000_000 },
          settings: { title_language: 1_000_000 },
          playback: { live: { starts: 1_000_000 } },
        },
      },
    });
    const capture = await captureServer();
    const transport = localCapture(capture.endpoint);
    if (!event || event.event !== "app_summary_day" || !transport)
      throw new Error("No transport/summary.");
    const raw = {
      ...event,
      properties: {
        ...event.properties,
        query: "PRIVATE",
        counts: {
          ...event.properties.counts,
          stack: "PRIVATE",
          features: { ...event.properties.counts.features, provider: "PRIVATE" },
          playback_open: {
            ...event.properties.counts.playback_open,
            failures: {
              ...event.properties.counts.playback_open.failures,
              private_error: "PRIVATE",
            },
          },
        },
      },
    };
    expect(await transport.send(raw, new AbortController().signal)).toBe("accepted");
    expect(capture.payloads[0]).toEqual({ api_key: "mrstreamer-local-verification", ...event });
    expect(JSON.stringify(capture.payloads)).not.toContain("PRIVATE");
    const invalid = {
      ...event,
      properties: {
        ...event.properties,
        counts: {
          ...emptySummaryCounts(),
          features: { ...event.properties.counts.features, home: -1 },
        },
      },
    };
    expect(await transport.send(invalid, new AbortController().signal)).toBe("discard");
    expect(capture.payloads).toHaveLength(1);
  });
});

it("retains a summary's exact payload and three-attempt budget across a hung request and restart", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
  const store = memoryStore();
  const summaries: CaptureEvent[] = [];
  const before = await start({
    store,
    transport: {
      send(event, signal) {
        if (event.event !== "app_summary_day") return Promise.resolve("accepted");
        summaries.push(structuredClone(event));
        return new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve("retry"), { once: true }),
        );
      },
    },
  });
  before.owner.setForeground(true);
  await until(async () => (await store.load())?.pending.length === 0);
  before.owner.noteFeature("player");
  before.owner.setForeground(false);
  vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
  before.owner.setForeground(true);
  await until(() => summaries.length === 1);
  const closing = before.owner.close();
  await vi.advanceTimersByTimeAsync(500);
  await closing;
  const after = await start({
    store,
    transport: {
      async send(event) {
        if (event.event === "app_summary_day") summaries.push(structuredClone(event));
        return "retry";
      },
    },
  });
  after.owner.setForeground(true);
  await vi.advanceTimersByTimeAsync(0);
  for (let attempt = 0; attempt < 4; attempt++) await vi.advanceTimersByTimeAsync(2000);
  expect(summaries).toHaveLength(3);
  for (const event of summaries) expect(event).toEqual(summaries[0]);
  expect((await store.load())?.pending).toEqual([]);
  expect((await store.load())?.summary?.reportedDay).toBe("2026-10-11");
});

it("cannot restore a loaded aggregate after opt-out was requested during startup", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
  const store = memoryStore();
  const before = await start({ store });
  before.owner.setForeground(true);
  await until(async () => (await store.load())?.pending.length === 0);
  before.owner.noteFeature("home");
  await before.owner.close();
  let loaded: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  const events: CaptureEvent[] = [];
  const owner = new Analytics({
    dataDir: before.dataDir,
    origin: Promise.resolve("unknown"),
    properties,
    store: {
      async load() {
        await gate;
        return store.load();
      },
      save: store.save,
    },
    transport: {
      kind: "local",
      async send(event) {
        events.push(structuredClone(event));
        return "accepted";
      },
    },
  });
  owners.push(owner);
  const disabled = owner.configure(false);
  loaded?.();
  await disabled;
  expect((await store.load())?.summary).toBeUndefined();
  await owner.configure(true);
  owner.noteFeature("settings");
  owner.setForeground(false);
  vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
  owner.setForeground(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(events[1]).toMatchObject({
    event: "app_summary_day",
    properties: { counts: { features: { home: 0, settings: 1 } } },
  });
});

describe("confirmed daily playback measurements", () => {
  function playbackClock(at = "2026-10-11T12:00:00Z") {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(new Date(at));
  }
  async function measuring() {
    const result = await start({ store: memoryStore() });
    result.owner.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    return result;
  }
  async function playing(
    owner: Analytics,
    token: string,
    binding: string,
    seconds: number,
    sequence = 0,
  ) {
    for (let second = 0; second < seconds; second++) {
      owner.notePlaybackState(token, binding, ++sequence, "playing");
      await vi.advanceTimersByTimeAsync(1000);
    }
    return sequence;
  }
  async function complete(owner: Analytics) {
    owner.setForeground(false);
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
    owner.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
  }

  it("counts a receiver title's pre-observer load failure once without a second open operation", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const frame = "current-frame";
    const hint = { control: randomUUID(), order: 1, ongoing: false };
    const token = owner.admitPlayback("vod", hint, frame)!;
    const preparation = owner.noteOperationStarted("playback_open");
    owner.noteOperationFinished("playback_open", preparation, "success");
    const failedLoad = owner.receiverLoadFailureObserver(hint.control, frame);
    failedLoad("network");
    failedLoad("network");
    // A later physical failure is the same incident until receiver-confirmed recovery.
    const physical = owner.remotePlayback("vod", hint.control);
    physical.failure("credentials");
    physical.stop();
    owner.endPlayback(token);
    await complete(owner);
    expect(events.find((event) => event.event === "app_summary_day")).toMatchObject({
      properties: {
        counts: {
          playback_open: { started: 1, success: 1, failed: 0 },
          playback: {
            vod: {
              starts: 0,
              errors: 1,
              failures: { network: 1, credentials: 0 },
            },
          },
        },
      },
    });
  });

  it("rejects a superseded receiver load failure and old physical callback after a new run", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const frame = "current-frame";
    const old = { control: randomUUID(), order: 1, ongoing: false };
    owner.admitPlayback("vod", old, frame);
    const staleFailure = owner.receiverLoadFailureObserver(old.control, frame);
    const stalePhysical = owner.remotePlayback("vod", old.control);
    const current = { control: randomUUID(), order: 2, ongoing: false };
    owner.admitPlayback("vod", current, frame);
    staleFailure("credentials");
    stalePhysical.failure("credentials");
    const freshFailure = owner.receiverLoadFailureObserver(current.control, frame);
    freshFailure("network");
    const currentPhysical = owner.remotePlayback("vod", current.control);
    currentPhysical.failure("network");
    currentPhysical.failure("credentials");
    owner.endControlledPlayback(current.control, frame);
    await complete(owner);
    expect(events.find((event) => event.event === "app_summary_day")).toMatchObject({
      properties: {
        counts: {
          playback: {
            vod: { starts: 0, errors: 1, failures: { network: 1, credentials: 0 } },
          },
        },
      },
    });
  });

  it.each(["consent", "dimensions"] as const)(
    "rejects a pre-reset receiver load callback after %s changes, while a current continuation can fail",
    async (reset) => {
      playbackClock();
      const { owner, events } = await measuring();
      await until(() => events.length === 2);
      const frame = "current-frame";
      const hint = { control: randomUUID(), order: 1, ongoing: false };
      owner.admitPlayback("vod", hint, frame);
      const stale = owner.receiverLoadFailureObserver(hint.control, frame);
      if (reset === "consent") {
        await owner.configure(false);
        await owner.configure(true);
        await vi.advanceTimersByTimeAsync(0);
      } else {
        owner.setUpdateChannel("nightly");
        owner.setUpdateChannel("stable");
      }
      stale("credentials");
      owner.admitPlayback("vod", hint, frame);
      owner.receiverLoadFailureObserver(hint.control, frame)("network");
      owner.endControlledPlayback(hint.control, frame);
      await complete(owner);
      expect(events.filter((event) => event.event === "app_summary_day").at(-1)).toMatchObject({
        properties: {
          counts: {
            playback: {
              vod: { starts: 0, errors: 1, failures: { network: 1, credentials: 0 } },
            },
          },
        },
      });
    },
  );

  it("measures receiver replay with a fresh load control and rejects the old load's facts", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const first = owner.beginPlayback("vod")!;
    const old = owner.remotePlayback("vod", first);
    for (let i = 0; i < 20; i++) {
      old.state("playing");
      await vi.advanceTimersByTimeAsync(1000);
    }
    old.state("stopped");
    const replay = owner.beginPlayback("vod")!;
    const fresh = owner.remotePlayback("vod", replay);
    old.state("playing");
    old.failure("credentials");
    for (let i = 0; i < 20; i++) {
      fresh.state("playing");
      await vi.advanceTimersByTimeAsync(1000);
    }
    fresh.failure("network");
    fresh.failure("network");
    fresh.stop();
    owner.endPlayback(replay);
    await complete(owner);
    expect(events.find((event) => event.event === "app_summary_day")).toMatchObject({
      properties: {
        counts: {
          playback: {
            vod: {
              starts: 2,
              errors: 1,
              watch_minutes: 1,
              failures: { network: 1, credentials: 0 },
            },
          },
        },
      },
    });
  });

  it.each(["consent", "dimensions"] as const)(
    "resolves fresh receiver open failures after %s reset but rejects callbacks created before the reset",
    async (reset) => {
      playbackClock();
      const { owner, events } = await measuring();
      await until(() => events.length === 2);
      const control = owner.beginPlayback("vod")!;
      const remote = owner.remotePlayback("vod", control);
      remote.state("playing");
      const stale = owner.playbackFailureObserver(control);
      if (reset === "consent") {
        await owner.configure(false);
        await owner.configure(true);
        await vi.advanceTimersByTimeAsync(0);
      } else {
        owner.setUpdateChannel("nightly");
        owner.setUpdateChannel("stable");
      }
      remote.state("playing");
      remote.stop();
      stale("credentials");
      owner.playbackFailureObserver(control)("network");
      owner.playbackFailureObserver(control)("network");
      await complete(owner);
      const summaries = events.filter((event) => event.event === "app_summary_day");
      expect(summaries.at(-1)).toMatchObject({
        properties: {
          counts: {
            playback: {
              vod: {
                starts: 0,
                errors: 1,
                failures: { network: 1, credentials: 0 },
              },
            },
          },
        },
      });
    },
  );

  it.each(["consent", "dimensions", "end"] as const)(
    "rejects a delayed closed-binding failure after %s reset",
    async (reset) => {
      playbackClock();
      const { owner, events } = await measuring();
      await until(() => events.length === 2);
      const token = owner.beginPlayback("live")!;
      const closed = new AbortController();
      const binding = owner.bindPlayback(token, "local", "live", closed.signal)!;
      owner.notePlaybackState(token, binding, 1, "playing");
      closed.abort();
      if (reset === "consent") {
        await owner.configure(false);
        await owner.configure(true);
        await vi.advanceTimersByTimeAsync(0);
      } else if (reset === "dimensions") {
        owner.setUpdateChannel("nightly");
        owner.setUpdateChannel("stable");
      } else owner.endPlayback(token);
      owner.beginPlayback("live", true);
      owner.notePlaybackFailure(token, binding, "credentials");
      owner.noteFeature("home");
      await complete(owner);
      expect(events.filter((event) => event.event === "app_summary_day").at(-1)).toMatchObject({
        properties: { counts: { playback: { live: { errors: 0, failures: { credentials: 0 } } } } },
      });
    },
  );

  it("exports late terminal failure once, excluding closed generations after a newer bind and run", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const token = owner.beginPlayback("live")!;
    const closed = new AbortController();
    const first = owner.bindPlayback(token, "local", "live", closed.signal)!;
    owner.notePlaybackState(token, first, 1, "playing");
    closed.abort();
    await Promise.resolve();
    owner.notePlaybackFailure(token, first, "network");
    owner.notePlaybackFailure(token, first, "network");
    const replacement = owner.bindPlayback(token, "local")!;
    owner.notePlaybackState(token, replacement, 1, "playing");
    owner.notePlaybackFailure(token, first, "credentials");
    owner.stopPlaybackBinding(replacement);
    owner.notePlaybackFailure(token, first, "credentials");
    owner.notePlaybackFailure(token, replacement, "unsupported");
    const fresh = owner.beginPlayback("live")!;
    owner.notePlaybackFailure(token, replacement, "credentials");
    owner.endPlayback(fresh);
    await complete(owner);
    expect(events.find((event) => event.event === "app_summary_day")).toMatchObject({
      properties: {
        counts: {
          playback: {
            live: {
              starts: 1,
              errors: 2,
              failures: { network: 1, unsupported: 1, credentials: 0 },
            },
          },
        },
      },
    });
  });

  it("admits gameplay hints without advisory registration, preserves reconnects and rejects superseded controls", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const frame = "current-frame";
    const first = { control: randomUUID(), order: 1, ongoing: false };
    const token = owner.admitPlayback("live", first, frame)!;
    expect(token).not.toBe(first.control);
    expect(owner.admitPlayback("live", first, frame)).toBe(token);
    expect(owner.controlledPlayback(first.control, frame)).toBe(token);
    expect(owner.controlledPlayback(first.control, "other-frame")).toBeNull();
    expect(owner.admitPlayback("vod", first, frame)).toBeNull();
    expect(owner.admitPlayback("live", { ...first, control: randomUUID() }, frame)).toBeNull();
    let binding = owner.bindPlayback(token, "local", "live")!;
    await playing(owner, token, binding, 20);
    owner.stopPlaybackBinding(binding);
    expect(owner.admitPlayback("live", first, frame)).toBe(token);
    binding = owner.bindPlayback(token, "local", "live")!;
    await playing(owner, token, binding, 20);
    const replay = { control: randomUUID(), order: 2, ongoing: false };
    const second = owner.admitPlayback("live", replay, frame)!;
    expect(second).not.toBe(token);
    expect(owner.admitPlayback("live", first, frame)).toBeNull();
    expect(owner.controlledPlayback(first.control, frame)).toBeNull();
    owner.notePlaybackState(token, binding, 100, "playing");
    owner.notePlaybackFailure(token, binding, "credentials");
    const fresh = owner.bindPlayback(second, "local", "live")!;
    await playing(owner, second, fresh, 10);
    owner.notePlaybackFailure(second, fresh, "network");
    owner.endPlayback(second);
    expect(owner.admitPlayback("live", replay, frame)).toBeNull();
    expect(owner.admitPlayback("live", first, frame)).toBeNull();
    await complete(owner);
    expect(events.find((event) => event.event === "app_summary_day")).toMatchObject({
      properties: {
        counts: {
          playback: {
            live: {
              starts: 2,
              watch_minutes: 1,
              errors: 1,
              failures: { network: 1, credentials: 0 },
            },
          },
        },
      },
    });
    expect(JSON.stringify(events)).not.toMatch(/control|order|frame|watch_ms/);
  });

  it("keeps a remote run across frame adoption and output moves, and renews only its current lineage after resets", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    await until(() => events.length === 2);
    const first = { control: randomUUID(), order: 1, ongoing: false };
    const token = owner.admitPlayback("vod", first, "old-frame")!;
    const remote = owner.remotePlayback("vod", token);
    remote.state("playing");
    await vi.advanceTimersByTimeAsync(1000);
    owner.rendererGone();
    expect(owner.controlledPlayback(first.control, "old-frame")).toBeNull();
    const adopted = { control: randomUUID(), order: 1, ongoing: true };
    expect(owner.admitPlayback("vod", adopted, "new-frame")).toBe(token);
    expect(owner.admitPlayback("vod", first, "old-frame")).toBeNull();
    await owner.configure(false);
    await owner.configure(true);
    await vi.advanceTimersByTimeAsync(0);
    remote.state("playing");
    const renewed = owner.controlledPlayback(adopted.control, "new-frame")!;
    expect(renewed).not.toBeNull();
    expect(renewed).not.toBe(token);
    remote.state("paused");
    remote.stop();
    // Current normal media admission can return a paused receiver here without another poll.
    expect(owner.admitPlayback("vod", adopted, "new-frame")).toBe(renewed);
    let binding = owner.bindPlayback(renewed, "local", "vod")!;
    await playing(owner, renewed, binding, 35);
    owner.setUpdateChannel("nightly");
    owner.setUpdateChannel("stable");
    const continued = owner.admitPlayback("vod", adopted, "new-frame")!;
    binding = owner.bindPlayback(continued, "local", "vod")!;
    await playing(owner, continued, binding, 35);
    owner.notePlaybackFailure(renewed, null, "credentials");
    owner.notePlaybackFailure(continued, binding, "network");
    owner.endPlayback(continued);
    await complete(owner);
    expect(events.filter((event) => event.event === "app_summary_day").at(-1)).toMatchObject({
      properties: {
        counts: {
          playback: {
            vod: {
              starts: 0,
              watch_minutes: 1,
              errors: 1,
              failures: { network: 1, credentials: 0 },
            },
          },
        },
      },
    });
  });

  it("promotes an admitted preview session and replays an existing local session through independent binding admission", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    expect(owner.admitPlayback("live", undefined, "frame")).toBeNull();
    const hint = { control: randomUUID(), order: 1, ongoing: false };
    const token = owner.admitPlayback("live", hint, "frame")!;
    const binding = owner.bindPlayback(token, "local", "live")!;
    owner.setPlaybackEligible(token, false);
    await playing(owner, token, binding, 40);
    owner.setPlaybackEligible(token, true);
    await playing(owner, token, binding, 20, 40);
    owner.endPlayback(token);
    const replay = { control: randomUUID(), order: 2, ongoing: false };
    const renewed = owner.admitPlayback("live", replay, "frame")!;
    const next = owner.bindPlayback(renewed, "local", "live")!;
    await playing(owner, renewed, next, 20);
    owner.endPlayback(renewed);
    await complete(owner);
    expect(events.find((event) => event.event === "app_summary_day")).toMatchObject({
      properties: { counts: { playback: { live: { starts: 2, watch_minutes: 1, errors: 0 } } } },
    });
  });

  it("does not revive an obsolete remote intent after a newer selection ended or consent changed", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    await until(() => events.length === 2);
    const old = { control: randomUUID(), order: 1, ongoing: false };
    const token = owner.admitPlayback("live", old, "frame")!;
    const stale = owner.remotePlayback("live", token);
    stale.state("playing");
    const current = { control: randomUUID(), order: 2, ongoing: false };
    const next = owner.admitPlayback("vod", current, "frame")!;
    owner.endPlayback(next);
    await owner.configure(false);
    await owner.configure(true);
    await vi.advanceTimersByTimeAsync(0);
    stale.state("playing");
    stale.failure("credentials");
    expect(owner.resumePlayback("live")).toBeNull();
    expect(owner.admitPlayback("live", old, "frame")).toBeNull();
    owner.noteFeature("home");
    await complete(owner);
    expect(events.find((event) => event.event === "app_summary_day")).toMatchObject({
      properties: { counts: { playback: { live: { starts: 0, watch_minutes: 0, errors: 0 } } } },
    });
  });

  it("observes a receiver admitted while consent was off, then rejects its hint after a newer disabled-period load", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    await until(() => events.length === 2);
    await owner.configure(false);
    const old = { control: randomUUID(), order: 1, ongoing: false };
    expect(owner.admitPlayback("live", old, "frame")).toBeNull();
    const obsolete = owner.remotePlayback("live", old.control);
    obsolete.state("playing");
    const hint = { control: randomUUID(), order: 2, ongoing: false };
    expect(owner.admitPlayback("live", hint, "frame")).toBeNull();
    const current = owner.remotePlayback("live", hint.control);
    current.state("playing");
    await vi.advanceTimersByTimeAsync(60_000);
    await owner.configure(true);
    await vi.advanceTimersByTimeAsync(0);
    obsolete.state("playing");
    obsolete.failure("credentials");
    for (let second = 0; second < 35; second++) {
      current.state("playing");
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(owner.controlledPlayback(hint.control, "frame")).not.toBeNull();
    expect(owner.controlledPlayback(old.control, "frame")).toBeNull();
    current.failure("network");
    current.stop();
    await complete(owner);
    expect(events.find((event) => event.event === "app_summary_day")).toMatchObject({
      properties: {
        counts: {
          playback: {
            live: {
              starts: 0,
              watch_minutes: 1,
              errors: 1,
              failures: { network: 1, credentials: 0 },
            },
          },
        },
      },
    });
  });

  it("retires stopped controls while sharing is off so a late advisory or media request cannot revive them", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    await until(() => events.length === 2);
    await owner.configure(false);
    const hint = { control: randomUUID(), order: 1, ongoing: false };
    expect(owner.admitPlayback("live", hint, "frame")).toBeNull();
    expect(owner.isPlaybackControlCurrent(hint.control, "frame")).toBe(true);
    owner.endControlledPlayback(hint.control, "other-frame");
    expect(owner.isPlaybackControlCurrent(hint.control, "frame")).toBe(true);
    owner.endControlledPlayback(hint.control, "frame");
    expect(owner.isPlaybackControlCurrent(hint.control, "frame")).toBe(false);
    await owner.configure(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(owner.admitPlayback("live", hint, "frame")).toBeNull();
    const stale = owner.remotePlayback("live", hint.control);
    stale.state("playing");
    stale.failure("credentials");
    const current = { control: randomUUID(), order: 2, ongoing: false };
    const token = owner.admitPlayback("live", current, "frame")!;
    const binding = owner.bindPlayback(token, "local", "live")!;
    await playing(owner, token, binding, 35);
    owner.endControlledPlayback(hint.control, "frame");
    expect(owner.controlledPlayback(current.control, "frame")).toBe(token);
    owner.endControlledPlayback(current.control, "frame");
    await complete(owner);
    expect(events.find((event) => event.event === "app_summary_day")).toMatchObject({
      properties: { counts: { playback: { live: { starts: 1, watch_minutes: 1, errors: 0 } } } },
    });
  });

  it("requires confirmed playback, rounds many intervals once, and keeps one start across replacement and output moves", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const token = owner.beginPlayback("vod")!;
    let binding = owner.bindPlayback(token, "local")!;
    owner.notePlaybackState(token, binding, 1, "paused");
    await vi.advanceTimersByTimeAsync(90_000);
    for (let run = 0; run < 6; run++) {
      binding = owner.bindPlayback(token, run % 2 ? "remote" : "local")!;
      const sequence = await playing(owner, token, binding, 6);
      owner.notePlaybackState(token, binding, sequence + 1, "seeking");
      await vi.advanceTimersByTimeAsync(10_000);
    }
    owner.endPlayback(token);
    await complete(owner);
    expect(events.find((event) => event.event === "app_summary_day")).toMatchObject({
      properties: {
        counts: {
          playback: {
            vod: { starts: 1, errors: 0, watch_minutes: 1 },
            live: { starts: 0, watch_minutes: 0 },
          },
        },
      },
    });
    expect(JSON.stringify(events)).not.toMatch(/watch_ms|sessionId|binding|position/);
  });

  it("splits confirmed monotonic time before UTC foreground rollover without starting again at midnight", async () => {
    playbackClock("2026-10-11T23:59:20Z");
    const { owner, events } = await measuring();
    const token = owner.beginPlayback("live")!;
    const binding = owner.bindPlayback(token, "local")!;
    const sequence = await playing(owner, token, binding, 80);
    owner.notePlaybackState(token, binding, sequence + 1, "paused");
    owner.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(events.find((event) => event.event === "app_summary_day")).toMatchObject({
      properties: {
        summary_date: "2026-10-11",
        counts: { playback: { live: { starts: 1, watch_minutes: 1 } } },
      },
    });
    owner.setForeground(false);
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    owner.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(events.filter((event) => event.event === "app_summary_day")[1]).toMatchObject({
      properties: {
        summary_date: "2026-10-12",
        counts: { playback: { live: { starts: 0, watch_minutes: 1 } } },
      },
    });
  });

  it("excludes preview intervals and deduplicates an incident until successful recovery", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const token = owner.beginPlayback("live")!;
    const binding = owner.bindPlayback(token, "local")!;
    owner.setPlaybackEligible(token, false);
    await playing(owner, token, binding, 60);
    owner.notePlaybackFailure(token, binding, "network");
    owner.setPlaybackEligible(token, true);
    let sequence = await playing(owner, token, binding, 20, 60);
    owner.notePlaybackFailure(token, binding, "network");
    owner.notePlaybackFailure(token, null, "unsupported");
    await vi.advanceTimersByTimeAsync(60_000);
    sequence = await playing(owner, token, binding, 20, sequence);
    owner.notePlaybackFailure(token, binding, "credentials");
    sequence = await playing(owner, token, binding, 20, sequence);
    owner.setPlaybackEligible(token, false);
    await playing(owner, token, binding, 60, sequence);
    owner.endPlayback(token);
    await complete(owner);
    expect(events.find((event) => event.event === "app_summary_day")).toMatchObject({
      properties: {
        counts: {
          playback: {
            live: {
              starts: 1,
              errors: 2,
              watch_minutes: 1,
              failures: { network: 1, credentials: 1, unsupported: 0 },
            },
          },
        },
      },
    });
  });

  it("bounds missing renderer heartbeats, suspend and wall-clock jumps, while remote playback survives renderer loss", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    let token = owner.beginPlayback("live")!;
    let binding = owner.bindPlayback(token, "local")!;
    owner.notePlaybackState(token, binding, 1, "playing");
    await vi.advanceTimersByTimeAsync(3600_000);
    owner.rendererGone();
    owner.notePlaybackState(token, binding, 2, "playing");
    token = owner.beginPlayback("vod")!;
    binding = owner.bindPlayback(token, "remote")!;
    let sequence = await playing(owner, token, binding, 20);
    owner.rendererGone();
    sequence = await playing(owner, token, binding, 20, sequence);
    owner.suspendPlayback();
    await vi.advanceTimersByTimeAsync(3600_000);
    sequence = await playing(owner, token, binding, 20, sequence);
    vi.setSystemTime(new Date(Date.now() + 3600_000));
    owner.noteFeature("home");
    owner.notePlaybackState(token, binding, ++sequence, "paused");
    owner.endPlayback(token);
    await complete(owner);
    expect(events.find((event) => event.event === "app_summary_day")).toMatchObject({
      properties: {
        counts: {
          playback: { live: { starts: 1, watch_minutes: 0 }, vod: { starts: 1, watch_minutes: 1 } },
        },
      },
    });
  });

  it("invalidates old bindings across opt-out/on and dimension ABA, with no disabled-period backfill or historical start", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const old = owner.beginPlayback("live")!;
    const binding = owner.bindPlayback(old, "local")!;
    await playing(owner, old, binding, 40);
    await owner.configure(false);
    await vi.advanceTimersByTimeAsync(3600_000);
    await owner.configure(true);
    owner.notePlaybackState(old, binding, 100, "playing");
    owner.notePlaybackFailure(old, null, "network");
    const ongoing = owner.beginPlayback("live", true)!;
    const renewed = owner.bindPlayback(ongoing, "local")!;
    await playing(owner, ongoing, renewed, 40);
    owner.setUpdateChannel("nightly");
    owner.setUpdateChannel("stable");
    owner.notePlaybackState(ongoing, renewed, 100, "playing");
    const future = owner.beginPlayback("live", true)!;
    const fresh = owner.bindPlayback(future, "local")!;
    await playing(owner, future, fresh, 40);
    owner.endPlayback(future);
    await complete(owner);
    expect(events.find((event) => event.event === "app_summary_day")).toMatchObject({
      properties: { counts: { playback: { live: { starts: 0, errors: 0, watch_minutes: 1 } } } },
    });
  });

  it("drops old binding sequences without creating playback counts", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const token = owner.beginPlayback("vod")!;
    const old = owner.bindPlayback(token, "local")!;
    const binding = owner.bindPlayback(token, "local")!;
    owner.noteFeature("home");
    owner.notePlaybackState(token, old, 999, "playing");
    owner.notePlaybackState(token, binding, 2, "paused");
    owner.notePlaybackState(token, binding, 1, "playing");
    owner.notePlaybackFailure(token, old, "network");
    await vi.advanceTimersByTimeAsync(60_000);
    owner.endPlayback(token);
    await complete(owner);
    expect(events.find((event) => event.event === "app_summary_day")).toMatchObject({
      properties: { counts: { playback: { vod: { starts: 0, errors: 0, watch_minutes: 0 } } } },
    });
  });
});

it("migrates populated legacy current/ready buckets without changing a pending retry envelope", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
  const dataDir = await tempDir();
  const {
    playback: _playback,
    actions: _actions,
    settings: _settings,
    ...legacy
  } = emptySummaryCounts();
  legacy.features.home = 7;
  legacy.playback_open.success = 3;
  const id = "11111111-1111-4111-8111-111111111111";
  const pending = {
    uuid: "22222222-2222-4222-8222-222222222222",
    distinct_id: id,
    timestamp: "2026-10-10T12:00:00.000Z",
    event: "app_summary_day" as const,
    properties: {
      ...properties,
      profile_origin: "upgrading" as const,
      $process_person_profile: false as const,
      $geoip_disable: true as const,
      summary_date: "2026-10-09",
      counts: legacy,
    },
  };
  await writeFile(
    join(dataDir, "analytics.json"),
    JSON.stringify({
      format: 1,
      enabled: true,
      installationId: id,
      profileOrigin: "upgrading",
      firstSeen: true,
      lastDay: "2026-10-11",
      summary: {
        day: "2026-10-11",
        properties,
        counts: legacy,
        ready: { day: "2026-10-09", properties, counts: legacy },
        reportedDay: "2026-10-09",
      },
      pending: [{ event: pending, attempts: 1 }],
    }),
  );
  const loaded = await analyticsStore(dataDir).load();
  expect(loaded?.summary?.counts).toMatchObject({
    features: { home: 7 },
    playback_open: { success: 3 },
    playback: { live: { starts: 0, watch_minutes: 0 } },
    actions: { favourite_added: 0 },
    settings: { home_rows: 0 },
  });
  expect(loaded?.summary?.ready?.counts.features.home).toBe(7);
  expect(loaded?.pending[0]).toEqual({ event: pending, attempts: 1 });
  const { owner, events } = await start({ dataDir });
  owner.setForeground(true);
  await vi.advanceTimersByTimeAsync(0);
  await until(() => events.length === 3);
  expect(events[0]).toEqual(pending);
  expect(events[2]).toMatchObject({
    properties: {
      summary_date: "2026-10-11",
      counts: { features: { home: 7 }, playback: { vod: { starts: 0 } } },
    },
  });
});

it("validates and strips every new nested capture dictionary without normalizing a pending snapshot", async () => {
  const counts = emptySummaryCounts();
  const capture = await captureServer();
  const transport = localCapture(capture.endpoint)!;
  const event = {
    uuid: "22222222-2222-4222-8222-222222222222",
    distinct_id: "11111111-1111-4111-8111-111111111111",
    timestamp: "2026-10-11T12:00:00.000Z",
    event: "app_summary_day" as const,
    properties: {
      ...properties,
      profile_origin: "fresh" as const,
      $process_person_profile: false as const,
      $geoip_disable: true as const,
      summary_date: "2026-10-11",
      counts,
    },
  };
  const raw = {
    ...event,
    properties: {
      ...event.properties,
      counts: {
        ...counts,
        playback: {
          ...counts.playback,
          PRIVATE: "SECRET",
          live: {
            ...counts.playback.live,
            title: "SECRET",
            failures: { ...counts.playback.live.failures, PRIVATE: "SECRET" },
          },
        },
        actions: { ...counts.actions, PRIVATE: "SECRET" },
        settings: { ...counts.settings, PRIVATE: "SECRET" },
        watch_ms: { live: 99, PRIVATE: "SECRET" },
      },
    },
  };
  expect(await transport.send(raw, new AbortController().signal)).toBe("accepted");
  expect(capture.payloads[0]).toEqual({ api_key: "mrstreamer-local-verification", ...event });
  for (const invalid of [-1, 1.5, 1_000_001, NaN]) {
    expect(
      await transport.send(
        {
          ...event,
          properties: {
            ...event.properties,
            counts: {
              ...counts,
              actions: { ...counts.actions, search_used: invalid },
            },
          },
        },
        new AbortController().signal,
      ),
    ).toBe("discard");
  }
  expect(
    await transport.send(
      {
        ...event,
        properties: {
          ...event.properties,
          counts: {
            ...counts,
            playback: {
              ...counts.playback,
              live: { ...counts.playback.live, watch_minutes: 1441 },
            },
          },
        },
      },
      new AbortController().signal,
    ),
  ).toBe("discard");
  expect(capture.payloads).toHaveLength(1);
});

it("rejects stale logical request tokens and stopped receiver observations across consent changes", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
  const { owner, events } = await start({ store: memoryStore() });
  owner.setForeground(true);
  await vi.advanceTimersByTimeAsync(0);
  await until(() => events.length === 2);
  const stale = owner.beginPlayback("live")!;
  const fail = owner.playbackFailureObserver(stale);
  const current = owner.beginPlayback("live")!;
  fail("network");
  const staleRemote = owner.remotePlayback("live", stale);
  staleRemote.state("playing");
  staleRemote.failure("network");
  staleRemote.stop();
  const remote = owner.remotePlayback("live", current);
  remote.state("playing");
  await owner.configure(false);
  await owner.configure(true);
  await vi.advanceTimersByTimeAsync(0);
  staleRemote.state("playing");
  staleRemote.failure("network");
  remote.state("playing");
  expect(owner.resumePlayback("live")).not.toBeNull();
  remote.stop();
  const replacement = owner.remotePlayback("live", current);
  replacement.state("playing");
  replacement.failure("network");
  replacement.stop();
  owner.noteFeature("home");
  owner.setForeground(false);
  vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
  owner.setForeground(true);
  await vi.advanceTimersByTimeAsync(0);
  await until(() => events.some((event) => event.event === "app_summary_day"));
  expect(events.find((event) => event.event === "app_summary_day")).toMatchObject({
    properties: {
      counts: { playback: { live: { starts: 0, errors: 1, failures: { network: 1 } } } },
    },
  });
});
