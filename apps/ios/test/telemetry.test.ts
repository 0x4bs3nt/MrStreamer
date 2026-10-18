import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Analytics, type AnalyticsPorts } from "../src/telemetry/analytics.ts";
import type { AnalyticsRecord, CaptureEvent } from "../src/telemetry/model.ts";
import { analyticsTransport, type CaptureTransport } from "../src/telemetry/transport.ts";

// The iOS app's statistics as PostHog would receive them: the app's own telemetry and player run
// against a loopback capture server, with the native player, app state and files as stand-ins
// whose events are what iOS would report.

const files = new Map<string, string>();
vi.mock("../src/files.ts", () => ({
  readJson: (name: string) => {
    const text = files.get(name);
    return text === undefined ? null : (JSON.parse(text) as unknown);
  },
  writeJson: (name: string, value: unknown) => files.set(name, JSON.stringify(value)),
}));

const listeners = new Map<string, (payload: never) => void>();
const fakePlayer = {
  muted: true,
  timeUpdateEventInterval: 0,
  staysActiveInBackground: false,
  currentTime: 0,
  duration: 600,
  addListener: (event: string, listener: (payload: never) => void) => {
    listeners.set(event, listener);
  },
  replaceAsync: async () => undefined,
  play: () => undefined,
  pause: () => undefined,
  seekBy: () => undefined,
};
const emit = (event: string, payload: unknown) => listeners.get(event)?.(payload as never);
vi.mock("expo-video", () => ({ createVideoPlayer: () => fakePlayer }));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { version: "0.1.0" }, platform: { ios: { buildNumber: "2" } } },
}));

const native = { state: "active", listeners: [] as Array<(state: string) => void> };
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return native.state;
    },
    addEventListener: (_: string, listener: (state: string) => void) => {
      native.listeners.push(listener);
    },
  },
  Platform: { Version: "26.1" },
}));
const appState = (state: "active" | "inactive" | "background") => {
  native.state = state;
  for (const listener of native.listeners) listener(state);
};

Object.assign(globalThis, { __DEV__: true });

// Canaries for everything that must stay on the phone.
const USERNAME = "cnry Usr7Kq";
const PASSWORD = "cnry+Pw@9&Zq";
const CHANNEL = "cnry Channel Name";
const SEARCH = "cnry search words";

/** The loopback PostHog: every capture body, in order. */
let server: Server;
const captured: Array<Record<string, unknown>> = [];
const raw: string[] = [];
let respond: "ok" | "hang" = "ok";
const hung: ServerResponse[] = [];
let aborted = 0;

beforeEach(async () => {
  files.clear();
  captured.length = 0;
  raw.length = 0;
  hung.length = 0;
  respond = "ok";
  aborted = 0;
  native.state = "active";
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      if (request.url !== "/i/v0/e/" || request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      raw.push(body);
      captured.push(JSON.parse(body) as Record<string, unknown>);
      if (respond === "hang") {
        hung.push(response);
        response.on("close", () => {
          if (!response.writableEnded) aborted++;
        });
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  process.env["EXPO_PUBLIC_MR_STREAMER_ANALYTICS_LOCAL_ENDPOINT"] =
    `http://127.0.0.1:${port}/i/v0/e/`;
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  vi.setSystemTime(new Date("2026-10-16T10:00:00.000Z"));
});

afterEach(async () => {
  // The launch's owner stops its day timer; a later launch's listeners start afresh.
  appState("background");
  native.listeners.length = 0;
  vi.useRealTimers();
  for (const response of hung) response.end();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
});

/** A launch of the app, in the foreground: fresh modules over the same files. */
async function launch() {
  native.listeners.length = 0;
  native.state = "active";
  vi.resetModules();
  const telemetry = await import("../src/telemetry/index.ts");
  const playback = await import("../src/playback.ts");
  // The launch's own class, which its error handling recognizes.
  const { AppFailure } = await import("@mrstreamer/contracts/errors");
  telemetry.startTelemetry();
  return { ...telemetry, ...playback, AppFailure };
}

/** Real time for the loopback requests to arrive; the app's clocks stay where the test puts them. */
async function until(check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((done) => setTimeout(done, 10));
  expect(check()).toBe(true);
}
/** Lets anything already queued reach the server, so an absence means something. */
const quiet = () => new Promise((done) => setTimeout(done, 150));

const names = () => captured.map((body) => body["event"]);
const ofName = (name: string) =>
  captured
    .filter((body) => body["event"] === name)
    .map((body) => body["properties"] as Record<string, unknown>);
const stored = () => JSON.parse(files.get("analytics.json") ?? "null") as AnalyticsRecord | null;

let position = 0;
/** The player plays on for `seconds`, its position moving each second as AVPlayer reports. */
function plays(seconds: number) {
  for (let i = 0; i < seconds; i++) {
    vi.advanceTimersByTime(1000);
    emit("timeUpdate", { currentTime: ++position });
  }
}
/** Time passes with no position reported. */
const waits = (seconds: number) => vi.advanceTimersByTime(seconds * 1000);
const playing = (isPlaying: boolean) => emit("playingChange", { isPlaying });

const channel = (id = "c1") => ({
  id,
  subscriptionId: "xtream-test",
  title: CHANNEL,
  place: "cnry place",
  live: true,
  next: false,
  versions: false,
});
const opens = async () => ({
  url: `http://panel.example/live/${encodeURIComponent(USERNAME)}/${PASSWORD}/1.m3u8`,
  container: "m3u8",
});
const login = [USERNAME, PASSWORD];

describe("before the viewer chooses", () => {
  it("are on from the first launch of a build with a capture", async () => {
    await launch();
    await until(() => captured.length === 2);
    expect(names()).toEqual(["installation_observed", "app_active_day"]);
    const [first, second] = captured;
    expect(first?.["distinct_id"]).toBe(second?.["distinct_id"]);
    expect(first?.["api_key"]).toBe("mrstreamer-local-verification");
    expect(second?.["properties"]).toEqual({
      app_version: "0.1.0",
      app_build: "2",
      os: "ios",
      os_major: 26,
      $process_person_profile: false,
      $geoip_disable: true,
      activity_date: "2026-10-16",
    });
  });

  it("record and send nothing in a build without a capture", async () => {
    delete process.env["EXPO_PUBLIC_MR_STREAMER_ANALYTICS_LOCAL_ENDPOINT"];
    const app = await launch();
    app.onTelemetryScreen("/");
    await app.play(channel(), opens, { watch: true, login });
    playing(true);
    plays(5);
    app.stop();
    expect(app.setStatistics(true)).toEqual({ enabled: true, transport: "unconfigured" });
    await quiet();
    expect(captured).toEqual([]);
    expect(stored()?.pending ?? []).toEqual([]);
  });
});

describe("playback", () => {
  it("counts the time the viewer watches it playing, and nothing else", async () => {
    const app = await launch();
    app.setStatistics(true);
    await until(() => captured.length === 2);

    // Home's silent preview plays: nothing counts, nothing starts.
    await app.play(channel(), opens, { watch: false, login });
    playing(true);
    plays(10);
    app.openWatch();
    plays(30); // 30
    playing(false);
    waits(20); // paused
    playing(true);
    plays(10); // 40
    waits(60); // stalled: only the playing lease, 5 seconds, counts
    playing(false);
    playing(true);
    plays(10); // 55
    app.closeWatch();
    plays(10); // silent preview again
    app.openWatch();
    plays(5); // 60
    appState("background"); // Watch without Picture in Picture doesn't play on
    plays(20);
    appState("active");
    app.pictureInPicture(true);
    appState("background");
    plays(15); // 75: Picture in Picture plays on in the background
    appState("active");
    app.stop();

    await until(() => names().includes("stream_stopped"));
    expect(ofName("stream_started")).toEqual([expect.objectContaining({ stream_type: "live" })]);
    expect(ofName("stream_stopped")).toEqual([
      expect.objectContaining({ stream_type: "live", watch_duration_seconds: 75 }),
    ]);
  });

  it("reports each failure once per incident, with its category, and never for the preview", async () => {
    const app = await launch();
    app.setStatistics(true);
    await until(() => captured.length === 2);

    await app.play(
      channel("preview"),
      async () => {
        throw new app.AppFailure({
          kind: "unreachable",
          server: "http://panel.example",
          detail: "",
        });
      },
      { watch: false, login },
    );
    let refuse = true;
    const title = { ...channel("m1"), live: false };
    await app.play(
      title,
      async () => {
        if (refuse) throw new app.AppFailure({ kind: "invalid-login" });
        return { url: `http://panel.example/movie/${PASSWORD}/1.mp4`, container: "mp4" };
      },
      { watch: true, login },
    );
    app.retry();
    await quiet();
    refuse = false;
    app.retry();
    await quiet();
    playing(true);
    plays(3);
    emit("statusChange", { status: "error", error: { message: `Cannot Decode ${PASSWORD}` } });
    app.stop();

    await until(() => names().includes("stream_stopped"));
    expect(
      captured
        .filter((body) => String(body["event"]).startsWith("stream_"))
        .map((body) => [body["event"], body["properties"]]),
    ).toEqual([
      ["stream_error", expect.objectContaining({ stream_type: "vod", error_type: "credentials" })],
      ["stream_started", expect.objectContaining({ stream_type: "vod" })],
      ["stream_error", expect.objectContaining({ stream_type: "vod", error_type: "unsupported" })],
      ["stream_stopped", expect.objectContaining({ watch_duration_seconds: 3 })],
    ]);
  });

  it("keeps a failure after playing one incident until playing again", async () => {
    const app = await launch();
    app.setStatistics(true);
    await until(() => captured.length === 2);

    let opening: "fails" | "plays" = "plays";
    await app.play(
      channel(),
      async () => {
        if (opening === "fails") {
          throw new app.AppFailure({
            kind: "unreachable",
            server: "http://panel.example",
            detail: "",
          });
        }
        return opens();
      },
      { watch: true, login },
    );
    playing(true);
    plays(3);
    emit("statusChange", { status: "error", error: { message: "Cannot Decode" } });
    opening = "fails";
    app.retry(); // fails again while opening: the same incident
    await quiet();
    opening = "plays";
    app.retry();
    await quiet();
    playing(true);
    plays(2);
    emit("statusChange", { status: "error", error: { message: "Cannot Decode" } }); // a new one
    app.stop();

    await until(() => names().includes("stream_stopped"));
    expect(
      captured
        .filter((body) => String(body["event"]).startsWith("stream_"))
        .map((body) => [body["event"], body["properties"]]),
    ).toEqual([
      ["stream_started", expect.objectContaining({ stream_type: "live" })],
      ["stream_error", expect.objectContaining({ stream_type: "live", error_type: "unsupported" })],
      ["stream_error", expect.objectContaining({ stream_type: "live", error_type: "unsupported" })],
      ["stream_stopped", expect.objectContaining({ watch_duration_seconds: 5 })],
    ]);
  });

  it("sends the stop of a run iOS ended in the background at the next launch", async () => {
    const first = await launch();
    first.setStatistics(true);
    await first.play(channel(), opens, { watch: true, login });
    playing(true);
    plays(20);
    appState("background");
    await until(() => names().includes("stream_started"));
    await quiet();

    await launch();
    await until(() => names().includes("stream_stopped"));
    expect(ofName("stream_stopped")).toEqual([
      expect.objectContaining({ stream_type: "live", watch_duration_seconds: 20 }),
    ]);
  });
});

describe("the viewer's choice", () => {
  it("off clears what waits, cancels the request, survives a launch and backfills nothing", async () => {
    respond = "hang";
    const first = await launch();
    first.setStatistics(true);
    await until(() => captured.length === 1);
    first.setStatistics(false);
    await until(() => aborted === 1);
    expect(stored()).toMatchObject({ choice: "off", pending: [], unfinished: null });

    respond = "ok";
    await first.play(channel(), opens, { watch: true, login });
    playing(true);
    plays(5);
    first.onTelemetryScreen("/live");
    await quiet();
    expect(captured).toHaveLength(1);

    const second = await launch();
    second.onTelemetryScreen("/");
    await quiet();
    expect(captured).toHaveLength(1);

    // On again while a channel plays: that run reports nothing, the next one does.
    await second.play(channel(), opens, { watch: true, login });
    playing(true);
    plays(5);
    second.setStatistics(true);
    plays(5);
    await second.play(channel("c2"), opens, { watch: true, login });
    playing(true);
    plays(4);
    second.stop();
    await until(() => names().includes("stream_stopped"));
    await quiet();
    // The day and the installation were already observed; the time off isn't sent.
    expect(names().slice(1)).toEqual(["stream_started", "stream_stopped"]);
    expect(ofName("stream_stopped")[0]).toMatchObject({ watch_duration_seconds: 4 });
  });
});

describe("what the app reports of its use", () => {
  it("counts screens on entry and a search once per search, never its words", async () => {
    const app = await launch();
    app.setStatistics(true);
    await until(() => captured.length === 2);
    for (const path of [
      "/",
      "/",
      "/live",
      "/films",
      "/films/collection/new",
      "/films/title/1",
      "/films/title/2",
      "/connect",
      "/search",
    ])
      app.onTelemetryScreen(path);
    for (const text of ["c", SEARCH, "", "x", "xy"]) app.onSearchText(text);
    // Settings pushed on Live, from the top bar there, is Settings.
    app.onTelemetryScreen("/live/settings");
    app.onTelemetryScreen("/search");
    app.onSearchText(SEARCH);

    await until(() => captured.length === 2 + 8 + 3);
    expect(ofName("feature_opened").map((properties) => properties["feature"])).toEqual([
      "home",
      "live_tv",
      "movies",
      "details",
      "details",
      "search",
      "settings",
      "search",
    ]);
    expect(names().filter((name) => name === "search_used")).toHaveLength(3);
  });

  it("sends only the fixed properties, and nothing the viewer typed, watched or signed in with", async () => {
    const app = await launch();
    app.setStatistics(true);
    app.onTelemetryScreen("/search");
    app.onSearchText(SEARCH);
    await app.play(channel(), opens, { watch: true, login });
    playing(true);
    plays(2);
    emit("statusChange", {
      status: "error",
      error: { message: `http://panel.example/live/${USERNAME}/${PASSWORD}/1.m3u8` },
    });
    app.stop();
    await until(() => names().includes("stream_stopped"));
    await quiet();

    for (const text of [...raw, files.get("analytics.json") ?? ""]) {
      for (const secret of [USERNAME, PASSWORD, CHANNEL, SEARCH, "cnry", "panel.example"]) {
        expect(text).not.toContain(secret);
      }
    }
    const common = [
      "app_version",
      "app_build",
      "os",
      "os_major",
      "$process_person_profile",
      "$geoip_disable",
    ];
    const own: Record<string, string[]> = {
      installation_observed: [],
      app_active_day: ["activity_date"],
      feature_opened: ["feature"],
      search_used: [],
      stream_started: ["stream_type"],
      stream_error: ["stream_type", "error_type"],
      stream_stopped: ["stream_type", "watch_duration_seconds"],
    };
    for (const body of captured) {
      expect(Object.keys(body).sort()).toEqual(
        ["api_key", "distinct_id", "event", "properties", "timestamp", "uuid"].sort(),
      );
      const properties = Object.keys(body["properties"] as object).sort();
      expect(properties).toEqual([...common, ...(own[String(body["event"])] ?? ["?"])].sort());
    }
  });
});

describe("which capture a build uses", () => {
  const release = {
    development: false,
    releaseBuild: "1",
    host: "https://eu.i.posthog.com",
    projectToken: "phc_public_project_token",
    localEndpoint: undefined,
  };

  it("uses production only in a release bundle with its flag, an approved host and a project token", () => {
    expect(analyticsTransport(release)?.kind).toBe("production");
    expect(analyticsTransport({ ...release, host: "https://us.i.posthog.com" })?.kind).toBe(
      "production",
    );
    for (const changed of [
      { development: true },
      { releaseBuild: undefined },
      { releaseBuild: "0" },
      { host: undefined },
      { host: "https://eu.posthog.com" },
      { host: "http://eu.i.posthog.com" },
      { host: "https://collector.example" },
      { projectToken: undefined },
      { projectToken: "phx_personal_api_key" },
      { projectToken: "phc_token with spaces" },
      { localEndpoint: "http://127.0.0.1:9/i/v0/e/" },
    ])
      expect(analyticsTransport({ ...release, ...changed })).toBeNull();
  });

  it("uses only a literal loopback capture in development, never production", () => {
    const development = { ...release, development: true };
    expect(
      analyticsTransport({ ...development, localEndpoint: "http://127.0.0.1:8790/i/v0/e/" })?.kind,
    ).toBe("local");
    for (const localEndpoint of [
      "https://127.0.0.1:8790/i/v0/e/",
      "http://localhost:8790/i/v0/e/",
      "http://192.168.1.2:8790/i/v0/e/",
      "http://127.0.0.1/i/v0/e/",
      "http://127.0.0.1:8790/capture",
      "http://user:pass@127.0.0.1:8790/i/v0/e/",
      "http://127.0.0.1:8790/i/v0/e/?next=https://eu.i.posthog.com",
      "not a url",
    ])
      expect(analyticsTransport({ ...development, localEndpoint })).toBeNull();
  });
});

describe("the outbox", () => {
  /** The owner over memory, with a transport that answers as each test says. */
  function owner(answer: () => Promise<"accepted" | "retry" | "discard">) {
    const sent: CaptureEvent[] = [];
    let record: unknown = null;
    let mono = 0;
    let id = 0;
    const transport: CaptureTransport = {
      kind: "local",
      send: (event) => {
        sent.push(event);
        return answer();
      },
    };
    const ports: AnalyticsPorts = {
      store: {
        load: () => record,
        save: (next) => {
          record = structuredClone(next);
        },
      },
      transport,
      build: { app_version: "0.1.0", app_build: "2", os: "ios" },
      monotonic: () => mono,
      uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
      retryMs: 1,
    };
    const analytics = new Analytics(ports);
    analytics.setForeground(true);
    return {
      analytics,
      sent,
      record: () => record as AnalyticsRecord | null,
      advance: (ms: number) => (mono += ms),
    };
  }
  const realWait = (ms: number) => new Promise((done) => setTimeout(done, ms));

  it("tries each event three times, then gives it up", async () => {
    const { analytics, sent, record } = owner(async () => "retry");
    analytics.configure(true);
    await until(() => sent.length === 6);
    await realWait(50);
    expect(sent.map((event) => event.event)).toEqual([
      "installation_observed",
      "installation_observed",
      "installation_observed",
      "app_active_day",
      "app_active_day",
      "app_active_day",
    ]);
    expect(record()?.pending).toEqual([]);
    analytics.setForeground(false);
  });

  it("doesn't try again once statistics are off", async () => {
    const { analytics, sent } = owner(async () => "retry");
    analytics.configure(true);
    await until(() => sent.length === 1);
    analytics.configure(false);
    await realWait(50);
    expect(sent).toHaveLength(1);
    analytics.setForeground(false);
  });

  it("sends nothing when it can't save an attempt", async () => {
    // A launch whose first event waits in the outbox, one attempt made.
    const before = owner(() => new Promise(() => undefined));
    before.analytics.configure(true);
    before.analytics.setForeground(false);
    const saved = structuredClone(before.record());
    expect(saved?.pending[0]?.attempts).toBe(1);

    // The next launch can read the record but not write it.
    const sent: CaptureEvent[] = [];
    const analytics = new Analytics({
      store: {
        load: () => structuredClone(saved),
        save: () => {
          throw new Error("Disk full");
        },
      },
      transport: {
        kind: "local",
        send: async (event) => {
          sent.push(event);
          return "accepted";
        },
      },
      build: { app_version: "0.1.0", app_build: "2", os: "ios" },
      monotonic: () => 0,
      uuid: () => "00000000-0000-4000-8000-000000000099",
      retryMs: 1,
    });
    analytics.setForeground(true);
    await realWait(50);
    expect(sent).toEqual([]);
    expect(analytics.settings.get()).toEqual({ enabled: false, transport: "unavailable" });
    expect(before.record()).toEqual(saved);
    analytics.setForeground(false);
  });

  it("keeps at most 64 events, the first observation among them", () => {
    const { analytics, record, advance } = owner(() => new Promise(() => undefined));
    analytics.configure(true);
    for (let minute = 0; minute < 2; minute++) {
      for (let i = 0; i < 60; i++) analytics.noteFeature("home");
      advance(60_000);
    }
    const pending = record()?.pending ?? [];
    expect(pending).toHaveLength(64);
    expect(pending[0]?.event.event).toBe("installation_observed");
    analytics.setForeground(false);
  });
});
