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
    properties,
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
    let requests = 0;
    const capture = await captureServer(() => (++requests === 1 ? 503 : 200));
    const { owner, dataDir } = await start({ transport: localCapture(capture.endpoint) });
    owner.setForeground(true);
    await until(() => capture.payloads.length === 1);
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

  it("bounds quit and aborts a hung transport without losing its durable retry identity", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let signal: AbortSignal | undefined;
    const { owner, dataDir } = await start({
      transport: {
        send(_event, owned) {
          signal = owned;
          return new Promise(() => {});
        },
      },
    });
    owner.setForeground(true);
    await until(() => signal !== undefined);
    const before = await saved(dataDir);
    const closing = owner.close();
    await vi.advanceTimersByTimeAsync(500);
    await closing;
    expect(signal?.aborted).toBe(true);
    const after = await saved(dataDir);
    expect(after.pending[0]?.event).toEqual(before.pending[0]?.event);
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
