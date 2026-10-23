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
import { downloadFailure, checkFailure } from "../src/main/analytics/operations.ts";
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
  let current: AnalyticsRecord | null = null;
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
    monotonic?: () => number;
  } = {},
) {
  const dataDir = options.dataDir ?? (await tempDir());
  const events: CaptureEvent[] = [];
  const transport =
    options.transport === undefined
      ? {
          async send(event: CaptureEvent) {
            // Version observations have their own complete wire/lifecycle contracts.
            if (event.event !== "app_version_observed") events.push(structuredClone(event));
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
    ...(options.monotonic ? { monotonic: options.monotonic } : {}),
  });
  owners.push(owner);
  await owner.settings();
  return { owner, dataDir, events };
}

async function saved(dataDir: string) {
  const record = AnalyticsRecord()(
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
    const payload: unknown = JSON.parse(Buffer.concat(bytes).toString());
    if (!(
      typeof payload === "object" &&
      payload !== null &&
      "event" in payload &&
      payload.event === "app_version_observed"
    ))
      payloads.push(payload);
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
    owner.noteRendererExit("crashed");
    owner.observeOperation("update_check_ended")("success");
    await owner.configure(false);
    await owner.configure(true);
    expect((await saved(dataDir)).installationId).toBeNull();
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
    const first = CaptureEvent()(capture.payloads[0]);
    const day = CaptureEvent()(capture.payloads[1]);
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
    vi.useFakeTimers({ toFake: ["Date"] });
    let requests = 0;
    const capture = await captureServer(() => (++requests === 1 ? 503 : 200));
    const local = localCapture(capture.endpoint)!;
    let answered = 0;
    const { owner, dataDir } = await start({
      transport: {
        async send(event, signal) {
          const result = await local.send(event, signal);
          if (event.event !== "app_version_observed") answered++;
          return result;
        },
      },
    });
    owner.setForeground(true);
    await until(() => capture.payloads.length === 2 && answered === 2);
    // Move only scheduling time. Socket IO/deadlines stay real, then foreground wakes the owner.
    vi.setSystemTime(Date.now() + 2000);
    owner.setForeground(true);
    await until(
      async () => capture.payloads.length === 3 && (await saved(dataDir)).pending.length === 0,
    );
    expect(capture.payloads[2]).toEqual(capture.payloads[0]);
    expect(capture.payloads[1]).toMatchObject({ event: "app_active_day" });
  });

  it("retries offline events with the exact UUID/timestamp and bounds attempts across restart", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const events: CaptureEvent[] = [];
    const store = memoryStore();
    const offline: Omit<CaptureTransport, "kind"> = {
      async send(event) {
        // Version observations have their own complete wire/lifecycle contracts.
        if (event.event !== "app_version_observed") events.push(structuredClone(event));
        return "retry";
      },
    };
    const first = await start({
      store,
      transport: {
        send(event, signal) {
          // Version observations have their own complete wire/lifecycle contracts.
          if (event.event !== "app_version_observed") events.push(structuredClone(event));
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

  it("keeps pending direct backoff through a saved preference and rejects a stale retry after consent ABA", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const store = memoryStore();
    const incidents: CaptureEvent[] = [];
    let answer: ((result: "retry" | "accepted") => void) | undefined;
    let active: AbortSignal | undefined;
    const { owner } = await start({
      store,
      transport: {
        async send(event, signal) {
          if (event.event !== "renderer_exited") return "accepted";
          incidents.push(structuredClone(event));
          active = signal;
          return new Promise<"retry" | "accepted">((resolve) => {
            answer = resolve;
          });
        },
      },
    });
    owner.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    owner.noteRendererExit("crashed");
    await vi.advanceTimersByTimeAsync(0);
    expect(incidents).toHaveLength(1);
    answer!("retry");
    await vi.advanceTimersByTimeAsync(0);
    const pending = (await store.load())?.pending;
    expect(pending).toMatchObject([{ attempts: 1, event: { uuid: incidents[0]!.uuid } }]);
    await owner.configure(true);
    expect((await store.load())?.pending).toEqual(pending);
    await vi.advanceTimersByTimeAsync(1999);
    expect(incidents).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(incidents).toEqual([incidents[0], incidents[0]]);
    const stale = answer!;
    await owner.configure(false);
    expect(active?.aborted).toBe(true);
    expect((await store.load())?.pending).toEqual([]);
    await owner.configure(true);
    stale("retry");
    await vi.advanceTimersByTimeAsync(0);
    owner.noteRendererExit("other");
    await vi.advanceTimersByTimeAsync(0);
    expect(incidents).toHaveLength(3);
    expect(incidents[2]!.uuid).not.toBe(incidents[0]!.uuid);
    answer!("accepted");
    await vi.advanceTimersByTimeAsync(6000);
    expect(incidents).toHaveLength(3);
    expect((await store.load())?.pending).toEqual([]);
  });

  it("rate-limits captures and bounds the persisted outbox behind a hung transport, keeping first-seen", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const store = memoryStore();
    let signal: AbortSignal | undefined;
    // The rate window follows its own clock, so retry timers never run during this test.
    let now = 0;
    const { owner } = await start({
      store,
      monotonic: () => now,
      transport: {
        send(_event, owned) {
          signal = owned;
          return new Promise(() => {});
        },
      },
    });
    owner.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    const first = await store.load();
    expect(signal).toBeDefined();
    // Usage bursts share a separate admission budget and persist as counters, not captures.
    for (let i = 0; i < 100; i++) owner.noteFeature("home");
    await vi.advanceTimersByTimeAsync(0);
    expect((await store.load())?.pending).toHaveLength(2);
    expect((await store.load())?.summaries?.usage).toMatchObject({
      properties: { counts: { feature_home: 60 } },
    });
    now += 60_000;
    for (let i = 0; i < 10; i++) owner.noteAction("epg_opened");
    for (let i = 0; i < 70; i++) owner.noteRendererExit("crashed");
    await vi.advanceTimersByTimeAsync(0);
    const kept = await store.load();
    expect(kept?.pending).toHaveLength(62);
    expect(kept?.pending[0]?.event).toEqual(first?.pending[0]?.event);
    expect(kept?.summaries?.usage).toMatchObject({
      properties: { counts: { feature_home: 60, action_epg_opened: 10 } },
    });
    expect(await owner.settings()).toEqual({ enabled: true, transport: "local" });
    const closing = owner.close();
    await vi.advanceTimersByTimeAsync(500);
    await closing;
    expect(signal?.aborted).toBe(true);
    expect((await store.load())?.summaries?.usage).toBeNull();
    expect((await store.load())?.summaries?.pending).toHaveLength(1);
  });

  it("bounds startup state reads and preference writes when storage never settles", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
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

/** Playback events as compact facts, in delivery order. */
function streams(events: readonly CaptureEvent[]) {
  return events.flatMap((event) => {
    switch (event.event) {
      case "stream_started":
        return [`started ${event.properties.stream_type}`];
      case "stream_summary":
      case "stream_stopped":
        return [
          `stopped ${event.properties.stream_type} ${event.properties.watch_duration_seconds}`,
        ];
      case "stream_error":
        return [`error ${event.properties.stream_type} ${event.properties.error_type}`];
      default:
        return [];
    }
  });
}

describe("direct product and reliability events", () => {
  it("sends fixed diagnostic facts once per incident, preserving recovery, moves and privacy guards", async () => {
    const capture = await captureServer();
    const { owner } = await start({ transport: localCapture(capture.endpoint) });
    owner.setForeground(true);
    await until(() => capture.payloads.length === 2);
    const token = owner.beginPlayback("live");
    if (!token) throw new Error("No playback run.");
    const binding = owner.bindPlayback(token, "local");
    if (!binding) throw new Error("No playback binding.");
    const diagnostic = {
      diagnostic_stage: "decode",
      diagnostic_reason: "decode_rejected",
      diagnostic_container: "mpegts",
      diagnostic_delivery: "converted",
      diagnostic_video_codec: "h264",
      diagnostic_audio_codec: "aac",
      diagnostic_fallback: "repair",
    } as const;
    owner.notePlaybackFailure(token, binding, "unsupported", diagnostic);
    owner.notePlaybackFailure(token, binding, "unsupported", { diagnostic_reason: "unknown" });
    const remote = owner.bindPlayback(token, "remote");
    if (!remote) throw new Error("No remote binding.");
    owner.notePlaybackFailure(token, remote, "unsupported", diagnostic);
    await until(() => capture.payloads.length === 3);
    const event = CaptureEvent()(capture.payloads[2]);
    if (event instanceof type.errors) throw new Error("Invalid diagnostic body.");
    expect(capture.payloads[2]).toEqual({ api_key: "mrstreamer-local-verification", ...event });
    expect(event).toMatchObject({
      event: "stream_error",
      properties: { stream_type: "live", error_type: "unsupported", ...diagnostic },
    });
    owner.notePlaybackState(token, remote, 1, "playing");
    owner.notePlaybackFailure(token, binding, "unsupported", diagnostic); // old binding
    owner.notePlaybackFailure(token, remote, "network", {
      diagnostic_stage: "deliver",
      diagnostic_reason: "network",
    });
    await until(() => capture.payloads.length === 4);
    expect(capture.payloads.filter((body) => CaptureEvent()(body) instanceof type.errors)).toEqual(
      [],
    );
    owner.setPlaybackEligible(token, false);
    owner.notePlaybackState(token, remote, 2, "playing");
    owner.notePlaybackFailure(token, remote, "unsupported", diagnostic);
    await owner.configure(false);
    owner.notePlaybackFailure(token, remote, "unsupported", diagnostic);
    await owner.settings();
    expect(capture.payloads).toHaveLength(4);
    expect(streams(capture.payloads.map((body) => CaptureEvent().assert(body)))).toEqual([
      "error live unsupported",
      "error live network",
    ]);
  });

  it("rejects arbitrary diagnostic values at capture and IPC and reconstructs only fixed HTTP fields", async () => {
    const capture = await captureServer();
    const transport = localCapture(capture.endpoint);
    if (!transport) throw new Error("No local transport.");
    const base = {
      uuid: randomUUID(),
      distinct_id: randomUUID(),
      timestamp: new Date().toISOString(),
      event: "stream_error" as const,
      properties: {
        ...properties,
        profile_origin: "fresh" as const,
        $process_person_profile: false as const,
        $geoip_disable: true as const,
        stream_type: "live" as const,
        error_type: "unsupported" as const,
      },
    };
    const context = {
      diagnostic_stage: "decode",
      diagnostic_reason: "decode_rejected",
      diagnostic_container: "mpegts",
      diagnostic_delivery: "direct",
      diagnostic_video_codec: "h264",
      diagnostic_audio_codec: "aac",
      diagnostic_fallback: "none",
    } as const;
    for (const key of Object.keys(context)) {
      const bad = {
        ...base,
        properties: {
          ...base.properties,
          ...context,
          [key]: "https://login:password@private.example/media/123?token=PRIVATE",
        },
      };
      expect(CaptureEvent()(bad)).toBeInstanceOf(type.errors);
      expect(await transport.send(bad, new AbortController().signal)).toBe("discard");
      expect(
        ipcInputs["analytics.playbackFailure"]()({
          token: randomUUID(),
          binding: null,
          failure: "unsupported",
          diagnostic: { ...context, [key]: "PRIVATE" },
        }),
      ).toBeInstanceOf(type.errors);
    }
    const valid = CaptureEvent().assert({
      ...base,
      properties: {
        ...base.properties,
        ...context,
        stderr: "PRIVATE",
        provider: "PRIVATE",
        path: "/PRIVATE",
        codec: "PRIVATE",
        url: "PRIVATE",
        content_id: "PRIVATE",
        error: "PRIVATE",
        credentials: "PRIVATE",
      },
    });
    expect(await transport.send(valid, new AbortController().signal)).toBe("accepted");
    expect(capture.payloads).toEqual([
      {
        api_key: "mrstreamer-local-verification",
        ...base,
        properties: { ...base.properties, ...context },
      },
    ]);
    expect(JSON.stringify(capture.payloads)).not.toContain("PRIVATE");
  });

  it("keeps enabled consent, identity and old queued events when future optional diagnostics are unknown", async () => {
    const dataDir = await tempDir();
    const id = randomUUID();
    const event = {
      uuid: randomUUID(),
      distinct_id: id,
      timestamp: new Date().toISOString(),
      event: "stream_error",
      properties: {
        ...properties,
        profile_origin: "fresh",
        $process_person_profile: false,
        $geoip_disable: true,
        stream_type: "live",
        error_type: "unsupported",
      },
    };
    const future = Object.fromEntries(
      ["stage", "reason", "container", "delivery", "video_codec", "audio_codec", "fallback"].map(
        (key) => [`diagnostic_${key}`, "future_value"],
      ),
    );
    await writeFile(
      join(dataDir, "analytics.json"),
      JSON.stringify({
        format: 2,
        enabled: true,
        installationId: id,
        profileOrigin: "fresh",
        firstSeen: true,
        lastDay: new Date().toISOString().slice(0, 10),
        pending: [
          { event: { ...event, properties: { ...event.properties, ...future } }, attempts: 1 },
          { event: { ...event, uuid: randomUUID() }, attempts: 0 },
        ],
      }),
    );
    const loaded = await analyticsStore(dataDir).load();
    expect(loaded).toMatchObject({
      enabled: true,
      installationId: id,
      pending: [
        { event, attempts: 1 },
        { event: { event: "stream_error" }, attempts: 0 },
      ],
    });
    const { owner, events } = await start({ dataDir });
    expect(await owner.settings()).toEqual({ enabled: true, transport: "local" });
    owner.setForeground(true);
    await until(() => events.length === 2);
    expect(events[0]).toEqual(event);
    expect(JSON.stringify(events)).not.toContain("future_value");
    await owner.configure(false);
    expect(await saved(dataDir)).toMatchObject({ enabled: false, installationId: id, pending: [] });
  });

  it("sends each completed action, setting, screen, outcome and renderer exit with only fixed fields", async () => {
    const capture = await captureServer();
    const { owner } = await start({ transport: localCapture(capture.endpoint) });
    // No identity exists before the first foreground observation, so nothing can be queued.
    owner.noteAction("favourite_added");
    await owner.settings();
    owner.setForeground(true);
    await until(() => capture.payloads.length === 2);
    owner.noteAction("epg_opened");
    owner.noteAction("search_used");
    owner.actionObserver("favourite_added")();
    owner.settingObserver("autoplay_next")();
    owner.noteFeature("details");
    owner.observeOperation("download_ended")(
      "failed",
      downloadFailure({ kind: "folder", detail: "/PRIVATE/PATH" }),
    );
    owner.observeOperation("download_ended")("interrupted");
    owner.observeOperation("update_check_ended")("failed", checkFailure({ kind: "offline" }));
    owner.observeOperation("update_check_ended")("success", "network");
    owner.noteRendererExit("crashed");
    await owner.close();
    await until(() => capture.payloads.length === 8);
    const sent = capture.payloads.map((payload) => {
      const event = CaptureEvent()(payload);
      if (event instanceof type.errors) throw new Error("Invalid local payload.");
      expect(payload).toEqual({ api_key: "mrstreamer-local-verification", ...event });
      return event;
    });
    const common = sent[0]?.properties;
    expect(sent.slice(2).map(({ event, properties }) => [event, properties])).toEqual(
      [
        ["download_ended", { outcome: "failed", error_type: "disk" }],
        ["download_ended", { outcome: "interrupted" }],
        ["update_check_ended", { outcome: "failed", error_type: "network" }],
        ["update_check_ended", { outcome: "success" }],
        ["renderer_exited", { reason: "crashed" }],
        [
          "usage_window",
          {
            window_start: new Date(Math.floor(Date.now() / 300000) * 300000).toISOString(),
            window_end: new Date(Math.floor(Date.now() / 300000) * 300000 + 300000).toISOString(),
            counts: {
              action_epg_opened: 1,
              action_search_used: 1,
              action_favourite_added: 1,
              setting_autoplay_next: 1,
              feature_details: 1,
            },
          },
        ],
      ].map(([event, own]) => [event, { ...common, ...(own as object) }]),
    );
    expect(new Set(sent.map((event) => event.uuid)).size).toBe(8);
    expect(new Set(sent.map((event) => event.distinct_id))).toEqual(
      new Set([sent[0]?.distinct_id]),
    );
    expect(JSON.stringify(capture.payloads)).not.toMatch(/PRIVATE/);
  });

  it("reports an observed transaction or operation only in the consent generation that began it", async () => {
    const { owner, events } = await start();
    owner.setForeground(true);
    await until(() => events.length === 2);
    const favourite = owner.actionObserver("favourite_added");
    const setting = owner.settingObserver("home_rows");
    const download = owner.observeOperation("download_ended");
    await owner.configure(false);
    const disabled = owner.observeOperation("update_check_ended");
    await owner.configure(true);
    favourite();
    setting();
    download("success");
    disabled("success");
    owner.observeOperation("update_check_ended")("success");
    await until(() => events.length === 3);
    await owner.settings();
    expect(events.slice(2).map((event) => event.event)).toEqual(["update_check_ended"]);
  });

  it("stamps each event with the update channel current when it is queued, without ending playback", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    const { owner, events } = await start({ store: memoryStore() });
    owner.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    const token = owner.beginPlayback("live")!;
    const binding = owner.bindPlayback(token, "local")!;
    owner.notePlaybackState(token, binding, 1, "playing");
    await vi.advanceTimersByTimeAsync(1000);
    owner.setUpdateChannel("nightly");
    owner.notePlaybackState(token, binding, 2, "playing");
    await vi.advanceTimersByTimeAsync(1000);
    owner.endPlayback(token);
    await until(() => streams(events).length === 1);
    expect(streams(events)).toEqual(["stopped live 2"]);
    expect(events.at(-1)).toMatchObject({ properties: { started_update_channel: "stable" } });
    expect(events.at(-1)?.properties.update_channel).toBe("nightly");
  });

  it("queues the active run's stop at quit and delivers it within the quit deadline", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    const store = memoryStore();
    const { owner, events } = await start({ store });
    owner.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    const token = owner.beginPlayback("vod")!;
    const binding = owner.bindPlayback(token, "local")!;
    for (let second = 1; second <= 3; second++) {
      owner.notePlaybackState(token, binding, second, "playing");
      await vi.advanceTimersByTimeAsync(1000);
    }
    await owner.close();
    expect(streams(events)).toEqual(["stopped vod 3"]);
    expect((await store.load())?.pending).toEqual([]);
  });
});

describe("persisted state migration", () => {
  const legacy = (event: string, extra: object, attempts: number) => ({
    event: {
      uuid: randomUUID(),
      distinct_id: "f157c0b7-1b97-4a60-a96b-1c2ca9e56904",
      timestamp: new Date(Date.now() - 86_400_000).toISOString(),
      event,
      properties: {
        ...properties,
        profile_origin: "upgrading",
        $process_person_profile: false,
        $geoip_disable: true,
        ...extra,
      },
    },
    attempts,
  });
  const summary = {
    day: "2026-10-12",
    counts: { features: { home: 3 }, saturated: false },
    properties,
    ready: null,
    reportedDay: "2026-10-11",
  };

  it("discards queued daily summaries and their counts, never sending them, and keeps other queued events", async () => {
    const dataDir = await tempDir();
    const install = legacy("installation_observed", {}, 1);
    const day = legacy("app_active_day", { activity_date: "2026-10-11" }, 0);
    const old = legacy("app_summary_day", { summary_date: "2026-10-10", counts: {} }, 2);
    await writeFile(
      join(dataDir, "analytics.json"),
      JSON.stringify({
        format: 1,
        enabled: true,
        installationId: install.event.distinct_id,
        profileOrigin: "upgrading",
        firstSeen: true,
        lastDay: "2026-10-11",
        summary,
        pending: [install, old, day],
      }),
    );
    const { owner, events } = await start({ dataDir });
    owner.setForeground(true);
    await until(() => events.length === 3);
    // Legacy retries keep their UUID and timestamp; today's observation follows them.
    expect(events.slice(0, 2)).toEqual([install.event, day.event]);
    expect(events[2]?.event).toBe("app_active_day");
    const raw = JSON.parse(await readFile(join(dataDir, "analytics.json"), "utf8"));
    expect(raw).not.toHaveProperty("summary");
    expect(raw.format).toBe(2);
    expect((await saved(dataDir)).installationId).toBe(install.event.distinct_id);
    owner.noteAction("search_used");
    await owner.close();
    await until(() => events.length === 4);
    expect(events[3]).toMatchObject({
      event: "usage_window",
      distinct_id: install.event.distinct_id,
    });
    expect(events.some((event) => (event.event as string) === "app_summary_day")).toBe(false);
  });

  it("migrates an opted-out profile without its counts, keeping consent and identity", async () => {
    const dataDir = await tempDir();
    await writeFile(
      join(dataDir, "analytics.json"),
      JSON.stringify({
        format: 1,
        enabled: false,
        installationId: "f157c0b7-1b97-4a60-a96b-1c2ca9e56904",
        profileOrigin: "fresh",
        firstSeen: true,
        lastDay: "2026-10-11",
        summary,
        pending: [],
      }),
    );
    const { owner, events } = await start({ dataDir });
    owner.setForeground(true);
    owner.noteFeature("home");
    expect(await owner.settings()).toEqual({ enabled: false, transport: "local" });
    expect(events).toEqual([]);
    const raw = JSON.parse(await readFile(join(dataDir, "analytics.json"), "utf8"));
    expect(raw).toEqual({
      format: 2,
      enabled: false,
      installationId: "f157c0b7-1b97-4a60-a96b-1c2ca9e56904",
      profileOrigin: "fresh",
      firstSeen: true,
      lastDay: "2026-10-11",
      pending: [],
    });
  });

  it("clears a loaded queue when opt-out is requested during startup and never backfills it", async () => {
    const store = memoryStore();
    const before = await start({
      store,
      transport: { send: () => new Promise(() => {}) },
    });
    before.owner.setForeground(true);
    await until(async () => (await store.load())?.pending.length === 2);
    before.owner.noteFeature("home");
    await until(async () => (await store.load())?.summaries?.usage !== null);
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
          // Version observations have their own complete wire/lifecycle contracts.
          if (event.event !== "app_version_observed") events.push(structuredClone(event));
          return "accepted";
        },
      },
    });
    owners.push(owner);
    const disabled = owner.configure(false);
    loaded?.();
    await disabled;
    expect((await store.load())?.pending).toEqual([]);
    await owner.configure(true);
    owner.noteFeature("settings");
    await owner.close();
    expect(events.map((event) => event.event)).toEqual(["usage_window"]);
    expect(events[0]).toMatchObject({ properties: { counts: { feature_settings: 1 } } });
  });
});

describe("observed playback runs", () => {
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
    await until(() => result.events.length === 2);
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
  /** Waits for the expected facts, then confirms nothing else arrives. */
  async function expectStreams(
    owner: Analytics,
    events: readonly CaptureEvent[],
    expected: string[],
  ) {
    await until(() => streams(events).length >= expected.length);
    await vi.advanceTimersByTimeAsync(0);
    await owner.settings();
    expect(streams(events)).toEqual(expected);
  }

  it("reports a receiver title's pre-observer load failure once, with no start or stop", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const frame = "current-frame";
    const hint = { control: randomUUID(), order: 1, ongoing: false };
    const token = owner.admitPlayback("vod", hint, frame)!;
    const failedLoad = owner.receiverLoadFailureObserver(hint.control, frame);
    failedLoad("network");
    failedLoad("network");
    // A later physical failure is the same incident until receiver-confirmed recovery.
    const physical = owner.remotePlayback("vod", hint.control);
    physical.failure("credentials");
    physical.stop();
    owner.endPlayback(token);
    await expectStreams(owner, events, ["error vod network"]);
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
    owner.receiverLoadFailureObserver(current.control, frame)("network");
    const currentPhysical = owner.remotePlayback("vod", current.control);
    currentPhysical.failure("network");
    currentPhysical.failure("credentials");
    owner.endControlledPlayback(current.control, frame);
    await expectStreams(owner, events, ["error vod network"]);
  });

  it("rejects a pre-reset receiver load callback after consent changes, while the current continuation can fail", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const frame = "current-frame";
    const hint = { control: randomUUID(), order: 1, ongoing: false };
    owner.admitPlayback("vod", hint, frame);
    const stale = owner.receiverLoadFailureObserver(hint.control, frame);
    await owner.configure(false);
    await owner.configure(true);
    await vi.advanceTimersByTimeAsync(0);
    stale("credentials");
    owner.admitPlayback("vod", hint, frame);
    owner.receiverLoadFailureObserver(hint.control, frame)("network");
    owner.endControlledPlayback(hint.control, frame);
    await expectStreams(owner, events, ["error vod network"]);
  });

  it("ends a receiver run at replay with its own watch time and rejects the old load's facts", async () => {
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
    await expectStreams(owner, events, ["stopped vod 20", "error vod network", "stopped vod 20"]);
  });

  it("resolves fresh receiver open failures after a consent reset but rejects callbacks created before it", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const control = owner.beginPlayback("vod")!;
    const remote = owner.remotePlayback("vod", control);
    remote.state("playing");
    const stale = owner.playbackFailureObserver(control);
    await expectStreams(owner, events, []);
    await owner.configure(false);
    await owner.configure(true);
    await vi.advanceTimersByTimeAsync(0);
    remote.state("playing");
    remote.stop();
    stale("credentials");
    owner.playbackFailureObserver(control)("network");
    owner.playbackFailureObserver(control)("network");
    await owner.close();
    // Opt-out dropped the first run without a stop; the continuation has no historical start.
    expect(streams(events)).toEqual(["error vod network"]);
  });

  it.each(["consent", "end"] as const)(
    "rejects a delayed closed-binding failure after %s",
    async (reset) => {
      playbackClock();
      const { owner, events } = await measuring();
      const token = owner.beginPlayback("live")!;
      const closed = new AbortController();
      const binding = owner.bindPlayback(token, "local", "live", closed.signal)!;
      owner.notePlaybackState(token, binding, 1, "playing");
      closed.abort();
      await expectStreams(owner, events, []);
      if (reset === "consent") {
        await owner.configure(false);
        await owner.configure(true);
        await vi.advanceTimersByTimeAsync(0);
      } else owner.endPlayback(token);
      owner.beginPlayback("live", true);
      owner.notePlaybackFailure(token, binding, "credentials");
      await expectStreams(owner, events, reset === "consent" ? [] : ["stopped live 0"]);
    },
  );

  it("exports a late terminal failure once, excluding closed generations after a newer bind and run", async () => {
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
    await expectStreams(owner, events, [
      "error live network",
      "error live unsupported",
      "stopped live 0",
    ]);
  });

  it("admits gameplay hints without advisory registration, keeps reconnects in one run and rejects superseded controls", async () => {
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
    await expectStreams(owner, events, [
      "stopped live 40",
      "error live network",
      "stopped live 10",
    ]);
    expect(JSON.stringify(events)).not.toMatch(/control|order|frame|binding|position/);
  });

  it("keeps a receiver run across frame adoption, and a run continuing across consent reset reports no start or stop", async () => {
    playbackClock();
    const { owner, events } = await measuring();
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
    await expectStreams(owner, events, []);
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
    const binding = owner.bindPlayback(renewed, "local", "vod")!;
    await playing(owner, renewed, binding, 35);
    owner.notePlaybackFailure(renewed, null, "credentials");
    owner.notePlaybackFailure(renewed, binding, "network");
    owner.endPlayback(renewed);
    await expectStreams(owner, events, ["error vod network"]);
  });

  it("starts a promoted preview only once it plays in Watch, and replays a local session as a new run", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    expect(owner.admitPlayback("live", undefined, "frame")).toBeNull();
    const hint = { control: randomUUID(), order: 1, ongoing: false };
    const token = owner.admitPlayback("live", hint, "frame")!;
    const binding = owner.bindPlayback(token, "local", "live")!;
    owner.setPlaybackEligible(token, false);
    await playing(owner, token, binding, 40);
    await expectStreams(owner, events, []);
    owner.setPlaybackEligible(token, true);
    await playing(owner, token, binding, 20, 40);
    owner.endPlayback(token);
    const replay = { control: randomUUID(), order: 2, ongoing: false };
    const renewed = owner.admitPlayback("live", replay, "frame")!;
    const next = owner.bindPlayback(renewed, "local", "live")!;
    await playing(owner, renewed, next, 20);
    owner.endPlayback(renewed);
    await expectStreams(owner, events, ["stopped live 20", "stopped live 20"]);
  });

  it("does not revive an obsolete remote intent after a newer selection ended or consent changed", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const old = { control: randomUUID(), order: 1, ongoing: false };
    const token = owner.admitPlayback("live", old, "frame")!;
    const stale = owner.remotePlayback("live", token);
    stale.state("playing");
    const current = { control: randomUUID(), order: 2, ongoing: false };
    const next = owner.admitPlayback("vod", current, "frame")!;
    owner.endPlayback(next);
    await expectStreams(owner, events, ["stopped live 0"]);
    await owner.configure(false);
    await owner.configure(true);
    await vi.advanceTimersByTimeAsync(0);
    stale.state("playing");
    stale.failure("credentials");
    expect(owner.admitPlayback("live", old, "frame")).toBeNull();
    await expectStreams(owner, events, ["stopped live 0"]);
  });

  it("observes a receiver admitted while consent was off without a historical start", async () => {
    playbackClock();
    const { owner, events } = await measuring();
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
    await owner.close();
    expect(streams(events)).toEqual(["error live network"]);
  });

  it("retires stopped controls while sharing is off so a late advisory or media request cannot revive them", async () => {
    playbackClock();
    const { owner, events } = await measuring();
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
    await expectStreams(owner, events, ["stopped live 35"]);
  });

  it("counts only confirmed playing time across pause, seek and output moves, with one start and stop", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const token = owner.beginPlayback("vod")!;
    let binding = owner.bindPlayback(token, "local")!;
    owner.notePlaybackState(token, binding, 1, "paused");
    await vi.advanceTimersByTimeAsync(90_000);
    for (let run = 0; run < 6; run++) {
      binding = owner.bindPlayback(token, run % 2 ? "remote" : "local")!;
      const sequence = await playing(owner, token, binding, 6);
      owner.notePlaybackState(token, binding, sequence + 1, run % 2 ? "seeking" : "waiting");
      await vi.advanceTimersByTimeAsync(10_000);
    }
    owner.endPlayback(token);
    await expectStreams(owner, events, ["stopped vod 36"]);
    expect(JSON.stringify(events)).not.toMatch(/watch_ms|sessionId|binding|position/);
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
    await expectStreams(owner, events, [
      "error live network",
      "error live credentials",
      "stopped live 60",
    ]);
  });

  it("bounds missing heartbeats and suspend, ends a local run with its renderer and keeps receiver playback", async () => {
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
    owner.notePlaybackState(token, binding, ++sequence, "paused");
    owner.endPlayback(token);
    await expectStreams(owner, events, ["stopped live 5", "stopped vod 60"]);
  });

  it("drops a run at opt-out without a stop, and never backfills disabled time or a historical start", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const old = owner.beginPlayback("live")!;
    const binding = owner.bindPlayback(old, "local")!;
    await playing(owner, old, binding, 40);
    await expectStreams(owner, events, []);
    await owner.configure(false);
    await vi.advanceTimersByTimeAsync(3600_000);
    await owner.configure(true);
    owner.notePlaybackState(old, binding, 100, "playing");
    owner.notePlaybackFailure(old, null, "network");
    const ongoing = owner.beginPlayback("live", true)!;
    const renewed = owner.bindPlayback(ongoing, "local")!;
    await playing(owner, ongoing, renewed, 40);
    owner.endPlayback(ongoing);
    const next = owner.beginPlayback("live")!;
    const fresh = owner.bindPlayback(next, "local")!;
    await playing(owner, next, fresh, 10);
    owner.endPlayback(next);
    await expectStreams(owner, events, ["stopped live 10"]);
  });

  it("drops old binding sequences without creating playback events", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const token = owner.beginPlayback("vod")!;
    const old = owner.bindPlayback(token, "local")!;
    const binding = owner.bindPlayback(token, "local")!;
    owner.notePlaybackState(token, old, 999, "playing");
    owner.notePlaybackState(token, binding, 2, "paused");
    owner.notePlaybackState(token, binding, 1, "playing");
    owner.notePlaybackFailure(token, old, "network");
    await vi.advanceTimersByTimeAsync(60_000);
    owner.endPlayback(token);
    await expectStreams(owner, events, []);
  });

  it("ends a receiver run once at its terminal observation, with no renderer left", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const token = owner.beginPlayback("vod")!;
    const remote = owner.remotePlayback("vod", token);
    for (let second = 0; second < 20; second++) {
      remote.state("playing");
      await vi.advanceTimersByTimeAsync(1000);
    }
    remote.state("stopped");
    remote.end();
    remote.end();
    remote.state("playing");
    remote.failure("network");
    await expectStreams(owner, events, ["stopped vod 20"]);
  });

  it("ends the renderer's run at a receiver's terminal observation, so its control is spent and a fresh one starts anew", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const hint = { control: randomUUID(), order: 1, ongoing: false };
    owner.admitPlayback("vod", hint, "frame");
    const remote = owner.remotePlayback("vod", hint.control);
    for (let second = 0; second < 10; second++) {
      remote.state("playing");
      await vi.advanceTimersByTimeAsync(1000);
    }
    remote.end();
    expect(owner.controlledPlayback(hint.control, "frame")).toBeNull();
    expect(owner.admitPlayback("vod", hint, "frame")).toBeNull();
    owner.endControlledPlayback(hint.control, "frame");
    const again = { control: randomUUID(), order: 2, ongoing: false };
    const token = owner.admitPlayback("vod", again, "frame")!;
    const next = owner.remotePlayback("vod", again.control);
    next.state("playing");
    await vi.advanceTimersByTimeAsync(1000);
    next.end();
    expect(token).not.toBeNull();
    await expectStreams(owner, events, ["stopped vod 10", "stopped vod 1"]);
  });

  it("ignores a terminal observation from a replaced load, a moved output or an older run", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const first = owner.beginPlayback("vod")!;
    const old = owner.remotePlayback("vod", first);
    old.state("playing");
    await vi.advanceTimersByTimeAsync(1000);
    // Another track: a new load takes the binding of the same run before the old one stops.
    const reload = owner.remotePlayback("vod", first);
    old.end();
    reload.state("playing");
    await vi.advanceTimersByTimeAsync(1000);
    // Moved back here: the receiver's load stops reporting and local playback goes on.
    reload.stop();
    reload.end();
    const local = owner.bindPlayback(first, "local")!;
    owner.notePlaybackState(first, local, 1, "playing");
    await vi.advanceTimersByTimeAsync(1000);
    const replay = owner.beginPlayback("vod")!;
    const fresh = owner.remotePlayback("vod", replay);
    fresh.state("playing");
    await vi.advanceTimersByTimeAsync(1000);
    reload.end();
    old.end();
    fresh.state("playing");
    await vi.advanceTimersByTimeAsync(1000);
    fresh.end();
    await expectStreams(owner, events, ["stopped vod 3", "stopped vod 2"]);
  });

  it("reports nothing for a terminal observation after opt-out, and no stop after opting back in", async () => {
    playbackClock();
    const { owner, events } = await measuring();
    const token = owner.beginPlayback("live")!;
    const remote = owner.remotePlayback("live", token);
    remote.state("playing");
    await expectStreams(owner, events, []);
    await owner.configure(false);
    remote.end();
    await owner.configure(true);
    await vi.advanceTimersByTimeAsync(0);
    const continued = owner.remotePlayback("live", token);
    continued.state("playing");
    await vi.advanceTimersByTimeAsync(1000);
    continued.end();
    await expectStreams(owner, events, []);
  });

  it("rejects stale logical request tokens and stopped receiver observations across consent changes", async () => {
    playbackClock();
    const { owner, events } = await measuring();
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
    await expectStreams(owner, events, []);
    await owner.configure(false);
    await owner.configure(true);
    await vi.advanceTimersByTimeAsync(0);
    staleRemote.state("playing");
    staleRemote.failure("network");
    remote.state("playing");
    remote.stop();
    const replacement = owner.remotePlayback("live", current);
    replacement.state("playing");
    replacement.failure("network");
    replacement.stop();
    await owner.close();
    expect(streams(events)).toEqual(["error live network"]);
  });
});
