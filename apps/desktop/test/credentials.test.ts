import { readFile } from "node:fs/promises";
import { connect, Socket } from "node:net";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AppError } from "@mrstreamer/contracts/errors";
import { Failed } from "@mrstreamer/core/failure";
import * as Layer from "effect/Layer";
import { diagnosticsLogLayer } from "../src/main/platform/diagnostics-log.ts";
import type { TcpConnect } from "../src/main/providers/xtream.ts";
import { PlaybackCoordination } from "../src/main/services/playback-coordination.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import type { FakeProvider } from "./fake-provider.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testSecrets, userAgent } from "./support.ts";

const LOGIN = { username: "viewer-7", password: "s3cret-pass" };

/**
 * Subscriptions and playback whose provider requests go through `fetchImpl`, with the log on.
 * `tcpConnect` replaces the connection that tries an https port.
 */
async function app(fetchImpl: typeof fetch, tcpConnect?: TcpConnect) {
  const dataDir = await tempDir();
  const runtime = runtimeFor(
    Playback.layer({ userAgent, ffmpeg: null }).pipe(
      Layer.provide(PlaybackCoordination.layer),
      Layer.provideMerge(
        Subscriptions.layer({
          dataDir,
          secrets: testSecrets,
          providerOptions: { userAgent, fetch: fetchImpl },
          ...(tcpConnect ? { tcpConnect } : {}),
        }),
      ),
      Layer.provideMerge(diagnosticsLogLayer(dataDir)),
    ),
  );
  return {
    dataDir,
    subscriptions: await promised(runtime, Subscriptions),
    playback: await promised(runtime, Playback),
  };
}

/**
 * Fetch as if `https://panel.test` were the fake provider behind https, except where `redirect`
 * names another address, as a panel that serves streams from plain-http servers does. Addresses
 * on `http://relay.test` play the fake provider's channel `/<id>.ts` without the login, like a
 * stream address with a token of its own. `asked` lists every address requested.
 */
function httpsPanel(provider: FakeProvider, redirect: (url: URL) => string | null = () => null) {
  const asked: string[] = [];
  const panel: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    asked.push(url.href);
    if (url.host === "relay.test") {
      return fetch(`${provider.url}/live/${LOGIN.username}/${LOGIN.password}${url.pathname}`, init);
    }
    if (url.host !== "panel.test") return fetch(url, init);
    const location = redirect(url);
    if (location) return new Response(null, { status: 302, headers: { location } });
    return fetch(`${provider.url}${url.pathname}${url.search}`, init);
  };
  return { fetch: panel, asked };
}

function channel(provider: FakeProvider, name: string): string {
  return String(provider.catalogue.channels.find((entry) => entry.name === name)?.streamId);
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  if (!(error instanceof Failed)) throw new Error(`Expected a failure, got ${String(error)}`);
  return error.error;
}

/** The parts of the login `value` holds, as the window or a file would receive it. */
function loginIn(value: unknown): string[] {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return [LOGIN.username, LOGIN.password].filter((secret) => text.includes(secret));
}

describe("credential protection", () => {
  it("never falls back from an https address to http", async () => {
    const provider = await fakeProvider(LOGIN);
    const asked: string[] = [];
    const recording: typeof fetch = (input, init) => {
      asked.push(String(input));
      return fetch(input, init);
    };
    const { subscriptions } = await app(recording);
    const server = provider.url.replace("http:", "https:");

    const error = await failure(subscriptions.add({ server, ...LOGIN }));

    expect(error).toEqual({
      kind: "unreachable",
      server,
      detail: "The server doesn't offer an encrypted connection at this address.",
    });
    expect(asked.filter((address) => address.startsWith("http:"))).toEqual([]);
  });

  it("refuses a redirect from https to an http address with the login in it", async () => {
    const provider = await fakeProvider(LOGIN);
    // The API moved to plain http, keeping its query: the login.
    const moved = httpsPanel(provider, (url) =>
      url.pathname === "/player_api.php" ? `${provider.url}${url.pathname}${url.search}` : null,
    );
    const { subscriptions } = await app(moved.fetch);

    const error = await failure(subscriptions.add({ server: "https://panel.test", ...LOGIN }));

    expect(error).toMatchObject({ kind: "unreachable", server: "https://panel.test" });
    expect(moved.asked.filter((address) => address.startsWith("http:"))).toEqual([]);
  });

  it("plays a stream redirected to http with a token, and refuses one with the login", async () => {
    const provider = await fakeProvider(LOGIN);
    const tokened = channel(provider, "TEST | H.264 + AAC");
    const leaky = channel(provider, "TEST | H.264 + MP3");
    const panel = httpsPanel(provider, (url) => {
      const id = /^\/live\/[^/]+\/[^/]+\/(\d+)\.ts$/.exec(url.pathname)?.[1];
      if (id === tokened) return `http://relay.test/${id}.ts?token=7f3a`;
      if (id === leaky) return `${provider.url}${url.pathname}`;
      return null;
    });
    const { subscriptions, playback } = await app(panel.fetch);
    const { id: subscriptionId } = await subscriptions.add({
      server: "https://panel.test",
      ...LOGIN,
    });
    const own = (id: string) => ({ subscriptionId, id });

    const refused = await playback.open(own(leaky), ["h264", "aac", "mp3"]);
    expect((await fetch(refused.url)).status).toBe(502);
    expect(await playback.failure(refused.sessionId)).toMatchObject({
      kind: "network",
      detail: expect.stringContaining("unencrypted"),
    });
    expect(provider.streamRequests()).toBe(0);

    const played = await playback.open(own(tokened), ["h264", "aac", "mp3"]);
    const bytes = (await (await fetch(played.url)).arrayBuffer()).byteLength;
    expect(bytes).toBeGreaterThan(0);
    expect(provider.streamRequests()).toBe(1);
  });

  it("connects an address without a scheme over https when the server has it", async () => {
    const provider = await fakeProvider(LOGIN);
    const panel = httpsPanel(provider);
    const { subscriptions } = await app(panel.fetch);

    const connected = await subscriptions.add({ server: "panel.test", ...LOGIN });

    expect(connected).toMatchObject({ server: "https://panel.test" });
    expect(panel.asked.every((address) => address.startsWith("https://panel.test/"))).toBe(true);
  });

  it("asks before an address without a scheme gets the login over http", async () => {
    const provider = await fakeProvider(LOGIN);
    const asked: string[] = [];
    const recording: typeof fetch = (input, init) => {
      asked.push(String(input));
      return fetch(input, init);
    };
    const { subscriptions } = await app(recording);
    const address = provider.url.replace("http://", "");

    const error = await failure(subscriptions.add({ server: address, ...LOGIN }));

    expect(error).toEqual({ kind: "unencrypted-only", server: `https://${address}` });
    expect(asked.filter((each) => each.startsWith("http:"))).toEqual([]);
    // What "Connect without encryption" sends.
    const connected = await subscriptions.add({ server: `http://${address}`, ...LOGIN });
    expect(connected).toMatchObject({ server: provider.url });
  });

  it("asks within seconds when the https port leaves the connection unanswered", async () => {
    // Behind a firewall that drops https, the name resolves and nothing accepts or refuses.
    const resolved = Promise.withResolvers<void>();
    const unanswered: TcpConnect = () => {
      const socket = new Socket();
      setImmediate(() => {
        socket.emit("lookup", null, "192.0.2.1", 4, "panel.test");
        resolved.resolve();
      });
      return socket;
    };
    // Fetch waits there until the login's time is up.
    const asked: string[] = [];
    const waiting: typeof fetch = (input, init) => {
      asked.push(String(input));
      return new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    };
    const { subscriptions } = await app(waiting, unanswered);
    // The seconds pass on a fake clock; the app's own work goes on as it does.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let answered = false;
      const error = failure(subscriptions.add({ server: "panel.test", ...LOGIN })).finally(() => {
        answered = true;
      });
      await resolved.promise;

      // Time for a lost packet to be sent again, and far less than the 15 seconds a login gets.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(answered).toBe(false);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await error).toEqual({ kind: "unencrypted-only", server: "https://panel.test" });
    } finally {
      vi.useRealTimers();
    }
    expect(asked.filter((each) => each.startsWith("http:"))).toEqual([]);
    expect(await subscriptions.list()).toEqual([]);
  });

  it("keeps waiting for a slow login once the https port accepted the connection", async () => {
    const provider = await fakeProvider(LOGIN);
    const address = provider.url.replace("http://", "");
    // As if the fake provider were behind https, and answered later than a port gets to accept.
    const slow: typeof fetch = async (input, init) => {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      return fetch(String(input).replace("https:", "http:"), init);
    };
    const accepted = Promise.withResolvers<void>();
    const connecting: TcpConnect = (options) =>
      connect(options).once("connect", () => accepted.resolve());
    const { subscriptions } = await app(slow, connecting);
    // The login's seconds pass on a fake clock, once the port has accepted the connection.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const adding = subscriptions.add({ server: address, ...LOGIN });
      await accepted.promise;
      await vi.advanceTimersByTimeAsync(4_000);

      expect(await adding).toMatchObject({ server: `https://${address}` });
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't ask when https isn't what failed", async () => {
    const provider = await fakeProvider(LOGIN);
    const { subscriptions } = await app(httpsPanel(provider).fetch);

    const refused = await failure(
      subscriptions.add({ server: "panel.test", username: LOGIN.username, password: "wrong" }),
    );
    const nowhere = await failure(subscriptions.add({ server: "nowhere.invalid", ...LOGIN }));

    expect(refused).toEqual({ kind: "invalid-login" });
    expect(nowhere).toMatchObject({ kind: "unreachable", server: "https://nowhere.invalid" });
  });

  it("keeps the login out of the errors the window gets and the diagnostics log", async () => {
    const provider = await fakeProvider(LOGIN);
    // Fetch quotes the address it was given when it can't use it, as it does for one it can't
    // parse or one with a login before the host.
    let failing = "/player_api.php";
    const quoting: typeof fetch = async (input, init) => {
      const address = String(input);
      if (address.includes(failing)) throw new TypeError(`Failed to parse URL from ${address}`);
      return fetch(input, init);
    };
    const { dataDir, subscriptions, playback } = await app(quoting);

    const connectError = await failure(subscriptions.add({ server: provider.url, ...LOGIN }));
    failing = "/live/";
    const { id: subscriptionId } = await subscriptions.add({ server: provider.url, ...LOGIN });
    const session = await playback.open(
      { subscriptionId, id: channel(provider, "TEST | H.264 + AAC") },
      ["h264", "aac"],
    );
    await (await fetch(session.url)).arrayBuffer();
    const streamError = await playback.failure(session.sessionId);

    expect(connectError).toMatchObject({ kind: "unreachable", server: provider.url });
    expect(streamError).toMatchObject({ kind: "network" });
    expect(loginIn(connectError)).toEqual([]);
    expect(loginIn(streamError)).toEqual([]);
    const log = () => readFile(join(dataDir, "diagnostics.log"), "utf8").catch(() => "");
    await vi.waitFor(async () => expect(await log()).toContain('"op":"stream"'));
    expect(loginIn(await log())).toEqual([]);
  });
});
