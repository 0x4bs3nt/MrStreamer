import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../src/main/analytics/service.ts";
import { analyticsStore, profileOrigin } from "../src/main/analytics/storage.ts";
import { localCapture, type CaptureTransport } from "../src/main/analytics/transport.ts";
import {
  type AnalyticsRecord,
  type BuildProperties,
  CaptureEvent,
  SUMMARY_TTL_MS,
} from "../src/main/analytics/model.ts";
import { type } from "arktype";
import { tempDir } from "./support.ts";

const properties: BuildProperties = {
  app_version: "0.0.19",
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
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await pause(5);
  }
  throw new Error("Lifecycle observation did not settle.");
}
function memory(initial: AnalyticsRecord | null = null): ReturnType<typeof analyticsStore> {
  let current = initial;
  return {
    load: async () => structuredClone(current),
    save: async (next) => {
      current = structuredClone(next);
    },
  };
}
async function start(
  options: {
    directory?: string;
    store?: ReturnType<typeof analyticsStore>;
    properties?: Partial<BuildProperties>;
    transport?: CaptureTransport | null;
  } = {},
) {
  const directory = options.directory ?? (await tempDir());
  const store = options.store ?? analyticsStore(directory);
  const events: CaptureEvent[] = [];
  const owner = new Analytics({
    dataDir: directory,
    origin: profileOrigin(directory),
    properties: { ...properties, ...options.properties },
    store,
    transport:
      options.transport === undefined
        ? {
            kind: "local",
            send: async (event) => {
              events.push(structuredClone(event));
              return "accepted";
            },
          }
        : options.transport,
  });
  owners.push(owner);
  await owner.settings();
  return { owner, events, store, directory, properties: { ...properties, ...options.properties } };
}
function versions(events: CaptureEvent[]) {
  return events.filter((event) => event.event === "app_version_observed");
}
async function observed(session: Awaited<ReturnType<typeof start>>) {
  session.owner.setForeground(true);
  await until(
    async () =>
      (await session.store.load())?.lifecycle?.baseline?.app_version ===
        session.properties.app_version &&
      (await session.store.load())?.lifecycle?.baseline?.build_channel ===
        session.properties.build_channel &&
      (await session.store.load())?.lifecycle?.pending.length === 0 &&
      (await session.store.load())?.pending.length === 0,
  );
}

describe("foreground version lifecycle", () => {
  it("observes a fresh baseline once, retains identity on reinstall/copy, and creates identity after clearing", async () => {
    const first = await start();
    expect(first.events).toEqual([]);
    await observed(first);
    expect(first.events.map((event) => event.event)).toEqual([
      "installation_observed",
      "app_active_day",
      "app_version_observed",
    ]);
    expect(versions(first.events)[0]?.properties).toMatchObject({
      observation_kind: "new_profile",
      profile_origin: "fresh",
    });
    const id = (await first.store.load())?.installationId;
    first.owner.setForeground(false);
    first.owner.setForeground(true);
    await first.owner.close();
    const retained = await start({ directory: first.directory });
    await observed(retained);
    expect(retained.events).toEqual([]);
    expect((await retained.store.load())?.installationId).toBe(id);
    await retained.owner.close();
    const copy = await tempDir();
    await cp(join(first.directory, "analytics.json"), join(copy, "analytics.json"));
    const copied = await start({ directory: copy });
    await observed(copied);
    expect(copied.events).toEqual([]);
    expect((await copied.store.load())?.installationId).toBe(id);
    const cleared = await start();
    await observed(cleared);
    expect((await cleared.store.load())?.installationId).not.toBe(id);
  });

  it("observes same-day upgrades, downgrades, re-upgrades and build/prerelease changes without recounting activity", async () => {
    const store = memory();
    const history: CaptureEvent[] = [];
    const sequence = [
      { app_version: "0.0.18" },
      { app_version: "0.0.19" },
      { app_version: "0.0.18" },
      { app_version: "0.0.19" },
      { app_version: "0.0.19-nightly.20261023.1", build_channel: "nightly" as const },
      { app_version: "0.0.19-nightly.20261023.1", build_channel: "unknown" as const },
    ];
    for (const build of sequence) {
      const session = await start({ store, properties: build });
      await observed(session);
      await session.owner.close();
      history.push(...session.events);
    }
    expect(history.filter((event) => event.event === "app_active_day")).toHaveLength(1);
    expect(new Set(history.map((event) => event.distinct_id)).size).toBe(1);
    const arrivals = versions(history);
    expect(arrivals).toHaveLength(sequence.length);
    for (let i = 1; i < arrivals.length; i++)
      expect(arrivals[i]?.properties).toMatchObject({
        observation_kind: "transition",
        previous_app_version: sequence[i - 1]?.app_version,
        previous_build_channel: sequence[i - 1]?.build_channel ?? "stable",
      });
    // Repeated target arrival is real history; reports select one first arrival per identity/version.
    expect(arrivals.filter((event) => event.properties.app_version === "0.0.19")).toHaveLength(2);
  });

  it.each(["fresh", "upgrading", "unknown"] as const)(
    "does not infer prior versions from a %s profile with a missing baseline",
    async (origin) => {
      const store = memory({
        format: 2,
        enabled: true,
        installationId: randomUUID(),
        profileOrigin: origin,
        firstSeen: true,
        lastDay: new Date().toISOString().slice(0, 10),
        pending: [],
      });
      const session = await start({ store });
      await observed(session);
      expect(session.events).toHaveLength(1);
      expect(versions(session.events)[0]?.properties).toMatchObject({
        observation_kind: "unknown_history",
        profile_origin: origin,
      });
      expect(versions(session.events)[0]?.properties).not.toHaveProperty("previous_app_version");
    },
  );

  it("clears all work and baseline on opt-out, stays off through restart, and observes only the re-enabled version", async () => {
    const store = memory();
    const first = await start({ store });
    await observed(first);
    const id = (await store.load())?.installationId;
    await first.owner.configure(false);
    await first.owner.close();
    const disabled = await start({ store, properties: { app_version: "0.0.20" } });
    disabled.owner.setForeground(true);
    expect(await disabled.owner.settings()).toEqual({ enabled: false, transport: "local" });
    await disabled.owner.close();
    const enabled = await start({ store, properties: { app_version: "0.0.21" } });
    enabled.owner.setForeground(true);
    await enabled.owner.configure(true);
    await observed(enabled);
    expect(enabled.events).toHaveLength(1);
    expect(versions(enabled.events)[0]?.properties).toMatchObject({
      app_version: "0.0.21",
      observation_kind: "unknown_history",
    });
    expect(versions(enabled.events)[0]?.properties).not.toHaveProperty("previous_app_version");
    expect((await store.load())?.installationId).toBe(id);
  });

  it("uses unknown history after opt-out before the first observation, including restart", async () => {
    const store = memory();
    const first = await start({ store });
    await first.owner.configure(false);
    await first.owner.close();
    const next = await start({ store, properties: { app_version: "0.0.20" } });
    next.owner.setForeground(true);
    await next.owner.configure(true);
    await observed(next);
    expect(versions(next.events)[0]?.properties).toMatchObject({
      observation_kind: "unknown_history",
      profile_origin: "fresh",
    });
    expect(versions(next.events)[0]?.properties).not.toHaveProperty("previous_app_version");
    expect(next.events.filter((event) => event.event === "installation_observed")).toHaveLength(1);
  });

  it("aborts an active version body and clears it permanently when Privacy is disabled", async () => {
    const store = memory();
    let active: AbortSignal | undefined;
    const session = await start({
      store,
      transport: {
        kind: "local",
        send: async (event, signal) => {
          if (event.event !== "app_version_observed") return "accepted";
          active = signal;
          return new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve("retry"), { once: true }),
          );
        },
      },
    });
    session.owner.setForeground(true);
    await until(() => active !== undefined);
    await session.owner.configure(false);
    expect(active?.aborted).toBe(true);
    expect(await store.load()).toMatchObject({ enabled: false, pending: [] });
    expect(await store.load()).not.toHaveProperty("lifecycle");
    await session.owner.close();
    const next = await start({ store });
    next.owner.setForeground(true);
    await next.owner.close();
    expect(next.events).toEqual([]);
  });

  it("fails closed without sending an uncommitted baseline when its first storage write fails", async () => {
    const store: ReturnType<typeof analyticsStore> = {
      load: async () => null,
      save: async () => {
        throw new Error("private storage detail");
      },
    };
    const session = await start({ store });
    session.owner.setForeground(true);
    await until(async () => (await session.owner.settings()).transport === "unavailable");
    expect(session.events).toEqual([]);
    await expect(session.owner.configure(true)).rejects.toThrow(
      "Analytics preference could not be saved.",
    );
    expect(session.events).toEqual([]);
  });

  it("treats an unknown build version as unknown history at the next known observation", async () => {
    const store = memory();
    const unknown = await start({ store, properties: { app_version: "unknown" } });
    await observed(unknown);
    await unknown.owner.close();
    const known = await start({ store });
    await observed(known);
    expect(versions(known.events)[0]?.properties).toMatchObject({
      observation_kind: "unknown_history",
    });
  });

  it.each([undefined, { version: 2 }, { version: 1, pending: "bad" }])(
    "isolates absent/malformed/future optional state from base consent and legacy queue",
    async (lifecycle) => {
      const directory = await tempDir();
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      const event = {
        uuid: randomUUID(),
        distinct_id: id,
        timestamp,
        event: "installation_observed",
        properties: {
          ...properties,
          profile_origin: "upgrading",
          $process_person_profile: false,
          $geoip_disable: true,
        },
      };
      await writeFile(
        join(directory, "analytics.json"),
        JSON.stringify({
          format: 2,
          enabled: true,
          installationId: id,
          profileOrigin: "upgrading",
          firstSeen: true,
          lastDay: timestamp.slice(0, 10),
          pending: [{ event, attempts: 1 }],
          lifecycle,
        }),
      );
      const loaded = await analyticsStore(directory).load();
      expect(loaded).toMatchObject({
        enabled: true,
        installationId: id,
        pending: [{ event, attempts: 1 }],
      });
      expect(loaded).not.toHaveProperty("lifecycle");
      const session = await start({ directory });
      await observed(session);
      expect(session.events[0]).toEqual(event);
      expect(versions(session.events)[0]?.properties).toMatchObject({
        observation_kind: "unknown_history",
      });
    },
  );

  it("bounds offline lifecycle work by shared count and bytes and expires it after seven days", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = memory();
    for (let i = 0; i < 70; i++) {
      const session = await start({
        store,
        properties: { app_version: `0.0.${i}` },
        transport: { kind: "local", send: async () => "not_sent" },
      });
      session.owner.setForeground(true);
      await until(
        async () => (await store.load())?.lifecycle?.baseline?.app_version === `0.0.${i}`,
      );
      await session.owner.close();
    }
    const kept = await store.load();
    expect(kept!.pending.length + kept!.lifecycle!.pending.length).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(128 * 1024);
    expect(kept!.pending.some((item) => item.event.event === "installation_observed")).toBe(true);
    vi.setSystemTime(Date.now() + SUMMARY_TTL_MS + 1);
    const next = await start({ store, properties: { app_version: "0.0.69" } });
    await observed(next);
    expect(next.events.map((event) => event.event)).toEqual(["app_active_day"]);
  });
});

describe("loopback lifecycle delivery", () => {
  it("retains first/day/version and actual old queued observations through refused connections and restart with identical bodies", async () => {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      bodies.push(Buffer.concat(chunks).toString());
      res.end("ok");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback port.");
    const transport = localCapture(`http://127.0.0.1:${address.port}/i/v0/e/`)!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const directory = await tempDir();
    const store = analyticsStore(directory);
    const first = await start({ directory, store, transport });
    first.owner.setForeground(true);
    await until(
      async () =>
        (await store.load())?.lifecycle?.legacyRetries.length === 2 &&
        (await store.load())?.lifecycle?.pending[0]?.failures === 1,
    );
    const before = await store.load();
    await first.owner.close();
    expect(before!.pending.every((item) => item.attempts === 0)).toBe(true);
    expect(before!.lifecycle!.pending[0]?.attempts).toBe(0);
    const bodies: string[] = [];
    const expected: string[] = [];
    const recorder: CaptureTransport = {
      kind: "local",
      send: async (event, signal) => {
        // Capture the actual transport's raw serialization without accepting the original outbox.
        return transport.send(event, signal);
      },
    };
    await new Promise<void>((resolve) => server.listen(address.port, "127.0.0.1", resolve));
    for (const event of [
      ...before!.pending.map((item) => item.event),
      ...before!.lifecycle!.pending.map((item) => item.event),
    ]) {
      await recorder.send(event, new AbortController().signal);
      expected.push(bodies.at(-1)!);
    }
    bodies.length = 0;
    const restarted = await start({ directory, store, transport });
    await until(
      async () =>
        bodies.length === 3 &&
        (await store.load())?.pending.length === 0 &&
        (await store.load())?.lifecycle?.pending.length === 0,
    );
    expect(bodies).toEqual(expected);
    expect((await store.load())?.installationId).toBe(before?.installationId);
    await restarted.owner.close();
    // A legacy record with no optional retry metadata must recover too.
    const { lifecycle: _lifecycle, ...legacy } = before!;
    await store.save(legacy);
    bodies.length = 0;
    const oldQueue = await start({ directory, store, transport });
    await until(() => bodies.length === 2);
    expect(bodies).toEqual(expected.slice(0, 2));
    await oldQueue.owner.close();
  }, 15000);

  it("allows at most three ambiguous body deliveries per UUID, retaining exact bytes across restart", async () => {
    const bodies: string[] = [];
    const server = createServer(async (req) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      bodies.push(Buffer.concat(chunks).toString());
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port.");
    const transport = localCapture(`http://127.0.0.1:${address.port}/i/v0/e/`)!;
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = memory();
    for (let attempt = 0; attempt < 3; attempt++) {
      const session = await start({ store, transport });
      session.owner.setForeground(true);
      await until(
        async () =>
          ((await store.load())?.pending.length === 0 &&
            (await store.load())?.lifecycle?.pending.length === 0) ||
          ((await store.load())?.lifecycle?.pending[0]?.attempts === attempt + 1 &&
            (await store.load())?.lifecycle?.pending[0]?.failures === attempt + 1),
      );
      await session.owner.close();
      vi.setSystemTime(Date.now() + 310000);
    }
    const grouped = new Map<string, string[]>();
    for (const body of bodies) {
      const event = CaptureEvent()(JSON.parse(body));
      if (event instanceof type.errors) throw new Error("Invalid wire.");
      grouped.set(event.uuid, [...(grouped.get(event.uuid) ?? []), body]);
    }
    expect(grouped.size).toBe(3);
    for (const copies of grouped.values()) {
      expect(copies).toHaveLength(3);
      expect(new Set(copies).size).toBe(1);
    }
    expect((await store.load())?.pending).toEqual([]);
    expect((await store.load())?.lifecycle?.pending).toEqual([]);
  }, 20000);
});
