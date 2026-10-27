import { createSocket } from "node:dgram";
import dnsPacket from "dns-packet";
import protobuf from "protobufjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Receiver } from "@mrstreamer/contracts/output";
import {
  ReceiverFailed,
  type AdapterEvent,
  type ReceiverMedia,
} from "../src/main/receivers/adapter.ts";
import { castAdapter } from "../src/main/receivers/cast/adapter.ts";
import { castDiscovery } from "../src/main/receivers/cast/discovery.ts";
import type { CastTimings } from "../src/main/receivers/cast/session.ts";
import { startFakeCastReceiver, type CastFields } from "./fake-cast-receiver.ts";

const CONNECTION = "urn:x-cast:com.google.cast.tp.connection";
const HEARTBEAT = "urn:x-cast:com.google.cast.tp.heartbeat";
const RECEIVER = "urn:x-cast:com.google.cast.receiver";
const MEDIA = "urn:x-cast:com.google.cast.media";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * Waits no test means to sit through are short, and the ones a busy machine must not run into
 * are long: a test shortens a deadline only where running into it is the point. Nothing asks for
 * the position unless a test turns that on.
 */
const TIMINGS: CastTimings = {
  ping: 1000,
  silence: 10_000,
  request: 3000,
  launch: 3000,
  load: 3000,
  status: 60_000,
  reconnect: [20, 20, 20],
  attempt: 3000,
  close: 200,
};

// What is waited for arrives in milliseconds; a busy machine gets the time it needs.
vi.setConfig({ expect: { poll: { timeout: 4000 } } });

const never = new AbortController().signal;

/** A protobuf field's tag: its number and wire type. */
const tag = (field: number, wire: number) => field * 8 + wire;

/** A fake receiver and an adapter that lists it. */
async function setup(timings: Partial<CastTimings> = {}) {
  const receiver = await startFakeCastReceiver();
  const adapter = castAdapter({
    discovery: receiver.discovery,
    timings: { ...TIMINGS, ...timings },
  });
  const events: AdapterEvent[] = [];
  adapter.listen((event) => events.push(event));
  cleanups.push(async () => {
    await adapter.close();
    await receiver.close();
  });
  return { receiver, adapter, events };
}

/** The same, connected, with the media app running. */
async function connected(timings: Partial<CastTimings> = {}) {
  const context = await setup(timings);
  const request = { kind: "receiver", id: context.receiver.receiver.id } as const;
  const connection = await context.adapter.connect(request, never);
  if (!connection) throw new Error("not connected");
  return { ...context, connection };
}

/** Sends synthetic ASCII status messages within each frame's limit, even with a long sender. */
function sendInParts(
  receiver: Awaited<ReturnType<typeof startFakeCastReceiver>>,
  payload: object,
  fields: CastFields,
) {
  const text = JSON.stringify(payload);
  const overhead = receiver.encode(
    {},
    {
      ...fields,
      payloadUtf8: "",
      continued: true,
      remainingLength: text.length,
    },
  ).length;
  const size = 65_535 - overhead - 4;
  for (let at = 0; at < text.length; at += size) {
    const end = Math.min(at + size, text.length);
    const part = receiver.encode(
      {},
      {
        ...fields,
        payloadUtf8: text.slice(at, end),
        continued: end < text.length,
        remainingLength: text.length - end,
      },
    );
    expect(part.length).toBeLessThanOrEqual(65_535);
    receiver.frame(part);
  }
}

function film(generation: number, overrides: Partial<ReceiverMedia> = {}): ReceiverMedia {
  return {
    generation,
    url: `http://192.168.1.20:41000/r/token-${generation}/master.m3u8`,
    live: false,
    position: 0,
    paused: false,
    duration: 600,
    subtitles: false,
    metadata: { title: "A film", subtitle: null, artworkUrl: null },
    ...overrides,
  };
}

/** The failure a call rejects with, or null when it resolves. */
const failure = (call: Promise<unknown>) =>
  call.then(
    () => null,
    (error: unknown) => (error instanceof ReceiverFailed ? error.failure : error),
  );

/**
 * Waits until `count` stops growing: what was under way when something stopped has arrived, and
 * nothing came after it.
 */
async function settled(count: () => number): Promise<void> {
  let last = -1;
  const unchanged = () => {
    const before = last;
    last = count();
    return last === before;
  };
  await expect.poll(unchanged, { interval: 150 }).toBe(true);
}

const statuses = (events: readonly AdapterEvent[]) =>
  events.flatMap((event) => (event.type === "status" ? [event.status] : []));
const states = (events: readonly AdapterEvent[]) =>
  statuses(events).map((status) => `${status.generation} ${status.state} ${status.position}`);
const ofType = (events: readonly AdapterEvent[], type: AdapterEvent["type"]) =>
  events.filter((event) => event.type === type);

describe("Cast adapter", () => {
  it("connects, starts the Default Media Receiver and joins it", async () => {
    const { receiver, connection, events } = await connected();

    expect(connection.receiver).toEqual(receiver.receiver);
    expect(connection.localAddress).toBe("127.0.0.1");
    expect(connection.decoders).toEqual(["h264", "aac"]);
    expect(connection.volume).toBe(true);

    expect(receiver.requests("LAUNCH")).toMatchObject([{ appId: "CC1AD845" }]);
    await expect
      .poll(() =>
        receiver.received
          .filter((message) => message.namespace === CONNECTION)
          .map((message) => `${message.payload.type} ${message.destinationId}`),
      )
      .toEqual(["CONNECT receiver-0", `CONNECT ${receiver.app?.transportId}`]);
    // Every frame read back with protobufjs, byte for byte, as the fields a sender sets.
    expect(receiver.violations).toEqual([]);
    for (const message of receiver.received) {
      expect(message).toMatchObject({ protocolVersion: 0, sourceId: "sender-0", payloadType: 0 });
      expect(message.payloadBinary).toBeUndefined();
    }

    // The receiver's news starts once connected, with its volume.
    await expect
      .poll(() => ofType(events, "volume"))
      .toEqual([{ type: "volume", level: 0.5, muted: false }]);
  });

  it("keeps the heartbeat going both ways", async () => {
    const { receiver } = await connected({ ping: 20 });

    receiver.send({ type: "PING" }, { sourceId: "receiver-0", namespace: HEARTBEAT });

    await expect.poll(() => receiver.requests("PING").length).toBeGreaterThan(2);
    await expect.poll(() => receiver.requests("PONG")).toHaveLength(1);
    expect(receiver.received.find((message) => message.payload.type === "PONG")).toMatchObject({
      namespace: HEARTBEAT,
      destinationId: "receiver-0",
    });
    expect(receiver.connections).toBe(1);
  });

  it("reconnects when a receiver's heartbeat cannot fit in a reply", async () => {
    const { receiver, connection, events } = await connected();
    await connection.load(film(1), never);
    const fields = { sourceId: "r".repeat(65_000), namespace: HEARTBEAT };
    const size = receiver.encode({ type: "PING" }, fields).length;
    const heartbeat = receiver.encode(
      { type: "PING" },
      { ...fields, sourceId: fields.sourceId + "r".repeat(65_535 - size) },
    );
    expect(heartbeat).toHaveLength(65_535);

    receiver.frame(heartbeat);

    await expect.poll(() => receiver.connections).toBe(2);
    await expect.poll(() => failure(connection.play(1))).toBeNull();
    expect(ofType(events, "lost")).toEqual([]);
  });

  it.each(["stopped", "too large", "unanswered", "explicit disconnect"] as const)(
    "ends a dropped load session when media STOP is too large and app STOP is %s",
    async (outcome) => {
      const { receiver, adapter, events } = await setup();
      receiver.answers.launch = "ignore";
      const request = { kind: "receiver", id: receiver.receiver.id } as const;
      const connecting = adapter.connect(request, never);
      await expect.poll(() => receiver.requests("LAUNCH")).toHaveLength(1);
      const fields = {
        sourceId: "sender-0",
        destinationId: "r".repeat(65_000),
        namespace: CONNECTION,
      };
      const size = receiver.encode({ type: "CONNECT", origin: {} }, fields).length;
      const transportId = fields.destinationId + "r".repeat(65_535 - size);
      const sessionId = outcome === "too large" ? "s".repeat(65_536) : "owned-session";
      receiver.app = { sessionId, transportId: "owned-transport" };
      sendInParts(
        receiver,
        {
          type: "RECEIVER_STATUS",
          requestId: receiver.requests("LAUNCH")[0]!.requestId,
          status: { applications: [{ appId: "CC1AD845", ...receiver.app, transportId }] },
        },
        { sourceId: "receiver-0", namespace: RECEIVER },
      );
      const connection = await connecting;
      if (!connection) throw new Error("not connected");
      expect(await failure(connection.load(film(1), never))).toEqual({
        kind: "unavailable",
        detail: "request too large",
      });

      receiver.media = {
        mediaSessionId: 1,
        playerState: "PLAYING",
        currentTime: 0,
        activeTrackIds: [],
        media: { contentId: film(1).url },
      };
      receiver.silent = outcome === "unanswered" || outcome === "explicit disconnect";
      const disconnecting = outcome === "explicit disconnect" ? connection.disconnect() : null;
      if (disconnecting) {
        await expect.poll(() => receiver.requests("STOP")).toMatchObject([{ sessionId }]);
      }
      sendInParts(
        receiver,
        { type: "MEDIA_STATUS", status: [receiver.media] },
        { sourceId: transportId, namespace: MEDIA },
      );
      if (disconnecting) {
        // Late media news during explicit teardown must not turn it into an automatic loss.
        await disconnecting;
        expect(events).toEqual([]);
      } else {
        // No user disconnect: automatic cleanup must finish and invalidate this connection.
        await expect
          .poll(() => ofType(events, "lost"))
          .toEqual([{ type: "lost", failure: { kind: "unreachable" } }]);
      }
      await expect.poll(() => receiver.sockets.size).toBe(0);
      expect(receiver.connections).toBe(1);
      expect(await failure(connection.setVolume({ muted: true }))).toEqual({ kind: "unreachable" });
      if (outcome === "stopped") {
        expect(receiver.app).toBeNull();
        expect(receiver.media).toBeNull();
        expect(receiver.requests("STOP")).toEqual([expect.objectContaining({ sessionId })]);
      } else {
        // The receiver cannot be forced to stop, but no usable session or reconnect loop remains.
        expect(receiver.media?.playerState).toBe("PLAYING");
      }
      await connection.disconnect();
      expect(ofType(events, "lost")).toHaveLength(disconnecting ? 0 : 1);
      receiver.silent = false;

      receiver.answers.launch = "start";
      const next = await adapter.connect(request, never);
      await next!.load(film(2), never);
    },
  );

  it("closes failed setup even when the receiver's session id cannot be sent back", async () => {
    const { receiver, adapter } = await setup();
    receiver.answers.launch = "ignore";
    const request = { kind: "receiver", id: receiver.receiver.id } as const;
    const connecting = failure(adapter.connect(request, never));
    await expect.poll(() => receiver.requests("LAUNCH")).toHaveLength(1);
    sendInParts(
      receiver,
      {
        type: "RECEIVER_STATUS",
        requestId: receiver.requests("LAUNCH")[0]!.requestId,
        status: { applications: [{ appId: "CC1AD845", sessionId: "s".repeat(65_536) }] },
      },
      { sourceId: "receiver-0", namespace: RECEIVER },
    );
    expect(await connecting).toMatchObject({ kind: "unavailable" });
    await expect.poll(() => receiver.sockets.size).toBe(0);

    receiver.answers.launch = "start";
    const next = await adapter.connect(request, never);
    await next!.load(film(1), never);
  });

  it("refuses the system's picker, an unknown receiver and a receiver that won't start the app", async () => {
    const { receiver, adapter, events } = await setup();
    const id = receiver.receiver.id;

    const anchor = { x: 0, y: 0, width: 10, height: 10 };
    expect(await failure(adapter.connect({ kind: "picker", anchor }, never))).toMatchObject({
      kind: "unavailable",
    });
    expect(await failure(adapter.connect({ kind: "receiver", id: "nobody" }, never))).toEqual({
      kind: "unreachable",
    });
    expect(receiver.connections).toBe(0);

    receiver.answers.launch = "refuse";
    expect(await failure(adapter.connect({ kind: "receiver", id }, never))).toEqual({
      kind: "unavailable",
      detail: "LAUNCH_ERROR NOT_FOUND",
    });
    await expect.poll(() => receiver.sockets.size).toBe(0);
    expect(events).toEqual([]);
  });

  it("leaves nothing connected or running when the connect is given up", async () => {
    const { receiver, adapter, events } = await setup();
    receiver.answers.launch = "ignore";
    const giveUp = new AbortController();
    const request = { kind: "receiver", id: receiver.receiver.id } as const;
    const connecting = adapter.connect(request, giveUp.signal);
    await expect.poll(() => receiver.requests("LAUNCH").length).toBe(1);

    giveUp.abort();
    expect(await failure(connecting)).toEqual({ kind: "unreachable" });

    // The TV was starting the app all along, and says so now.
    receiver.app = { sessionId: "late", transportId: "transport-late" };
    receiver.send(
      {
        type: "RECEIVER_STATUS",
        requestId: receiver.requests("LAUNCH")[0]?.requestId,
        status: { applications: [{ appId: "CC1AD845", ...receiver.app }] },
      },
      { sourceId: "receiver-0", namespace: RECEIVER },
    );
    await expect.poll(() => receiver.requests("STOP")).toMatchObject([{ sessionId: "late" }]);
    await expect.poll(() => receiver.sockets.size).toBe(0);
    expect(receiver.app).toBeNull();
    expect(events).toEqual([]);
  });

  it("starts the next connect only once a connect given up has stopped its app", async () => {
    const { receiver, adapter } = await setup();
    receiver.answers.launch = "ignore";
    const giveUp = new AbortController();
    const request = { kind: "receiver", id: receiver.receiver.id } as const;
    const first = adapter.connect(request, giveUp.signal);
    await expect.poll(() => receiver.requests("LAUNCH").length).toBe(1);
    giveUp.abort();
    await failure(first);

    // Connected to again at once, while the TV still starts the app for the connect before.
    receiver.answers.launch = "start";
    const second = adapter.connect(request, never);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(receiver.requests("LAUNCH")).toHaveLength(1);

    receiver.app = { sessionId: "late", transportId: "transport-late" };
    receiver.send(
      {
        type: "RECEIVER_STATUS",
        requestId: receiver.requests("LAUNCH")[0]?.requestId,
        status: { applications: [{ appId: "CC1AD845", ...receiver.app }] },
      },
      { sourceId: "receiver-0", namespace: RECEIVER },
    );

    // The stop of the first one's app is not the end of the second one's.
    const connection = await second;
    const types = receiver.received.map((message) => message.payload.type);
    expect(types.indexOf("STOP")).toBeLessThan(types.lastIndexOf("LAUNCH"));
    expect(receiver.requests("STOP")).toMatchObject([{ sessionId: "late" }]);
    expect(receiver.app).not.toBeNull();
    await connection?.disconnect();
  });

  it("loads a title at a position, held on its first picture", async () => {
    const { receiver, connection, events } = await connected();
    const title = "Amélie: Le Fabuleux Destin d'Amélie Poulain, version restaurée ".repeat(3);
    const media = film(1, {
      position: 42,
      paused: true,
      metadata: { title, subtitle: "S1 E3", artworkUrl: "https://image.example/poster.jpg" },
    });

    const before = Date.now();
    await connection.load(media, never);

    expect(receiver.requests("LOAD")).toMatchObject([
      {
        sessionId: receiver.app?.sessionId,
        autoplay: false,
        currentTime: 42,
        media: {
          contentId: media.url,
          contentType: "application/x-mpegURL",
          streamType: "BUFFERED",
          hlsSegmentFormat: "ts",
          hlsVideoSegmentFormat: "mpeg2_ts",
          metadata: {
            metadataType: 0,
            title,
            subtitle: "S1 E3",
            images: [{ url: "https://image.example/poster.jpg" }],
          },
        },
      },
    ]);
    expect(receiver.violations).toEqual([]);
    expect(statuses(events)).toMatchObject([
      { generation: 1, state: "paused", position: 42, duration: 600 },
    ]);
    const at = statuses(events)[0]?.at ?? 0;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it("loads a channel at its live edge, without a length", async () => {
    const { receiver, connection, events } = await connected();
    receiver.duration = null;

    await connection.load(film(1, { live: true, duration: null }), never);
    receiver.status({ playerState: "PLAYING", currentTime: 7 });

    const [load] = receiver.requests("LOAD");
    expect(load).toMatchObject({ autoplay: true, media: { streamType: "LIVE" } });
    expect(load).not.toHaveProperty("currentTime");
    // No line under the title and no picture when the service has none.
    expect(load).toHaveProperty("media.metadata", { metadataType: 0, title: "A film" });
    await expect
      .poll(() => statuses(events).at(-1))
      .toMatchObject({ generation: 1, state: "playing", position: 7, duration: null });
  });

  it("reports each state the receiver's media goes through", async () => {
    const { receiver, connection, events } = await connected();
    await connection.load(film(1, { position: 30 }), never);

    receiver.status({ playerState: "BUFFERING", currentTime: 30 });
    receiver.status({ playerState: "PLAYING", currentTime: 31 });
    receiver.status({ playerState: "BUFFERING", currentTime: 35 });
    receiver.status({ playerState: "PLAYING", currentTime: 36 });
    receiver.status({ playerState: "PAUSED", currentTime: 40 });

    // Buffering is still loading until the first picture.
    await expect
      .poll(() => states(events))
      .toEqual([
        "1 loading 30",
        "1 loading 30",
        "1 playing 31",
        "1 buffering 35",
        "1 playing 36",
        "1 paused 40",
      ]);
  });

  it("tells media that played to its end from media that was cancelled or failed", async () => {
    const { receiver, connection, events } = await connected();

    const last = () => states(events).at(-1);

    await connection.load(film(1), never);
    receiver.status({ playerState: "PLAYING", currentTime: 598 });
    receiver.idle("FINISHED");
    await expect.poll(last).toBe("1 ended 598");
    await connection.load(film(2), never);
    receiver.status({ playerState: "PLAYING", currentTime: 12 });
    receiver.idle("CANCELLED");
    await expect.poll(last).toBe("2 stopped 12");
    await connection.load(film(3), never);
    receiver.idle("INTERRUPTED");
    await expect.poll(last).toBe("3 stopped 0");
    await connection.load(film(4), never);
    receiver.idle("ERROR");

    await expect
      .poll(() => ofType(events, "media-failed"))
      .toEqual([
        { type: "media-failed", generation: 4, failure: { kind: "media", detail: "IDLE ERROR" } },
      ]);
    // An idle receiver says nothing of the position: where the media got to stands.
    expect(states(events)).toEqual([
      "1 loading 0",
      "1 playing 598",
      "1 ended 598",
      "2 loading 0",
      "2 playing 12",
      "2 stopped 12",
      "3 loading 0",
      "3 stopped 0",
      "4 loading 0",
    ]);
  });

  it("rejects a load the receiver refuses, and stays connected", async () => {
    const { receiver, connection, events } = await connected();

    receiver.answers.load = "refuse";
    expect(await failure(connection.load(film(1), never))).toEqual({
      kind: "media",
      detail: "LOAD_FAILED 104",
    });
    receiver.answers.load = "take";
    await connection.load(film(2), never);

    expect(states(events)).toEqual(["2 loading 0"]);
    expect(receiver.connections).toBe(1);
  });

  it("never reports a replaced load's late status as the new load's", async () => {
    const { receiver, connection, events } = await connected();
    await connection.load(film(1), never);
    receiver.status({ playerState: "PLAYING", currentTime: 80 });
    await expect.poll(() => states(events).at(-1)).toBe("1 playing 80");
    const first = receiver.media?.mediaSessionId;

    // The receiver says the first load made way before it answers the second, and goes on
    // about the first after.
    await connection.load(film(2), never);
    receiver.send({
      type: "MEDIA_STATUS",
      requestId: 0,
      status: [{ mediaSessionId: first, playerState: "PLAYING", currentTime: 99 }],
    });
    receiver.status({ playerState: "PLAYING", currentTime: 1 });

    await expect.poll(() => states(events).at(-1)).toBe("2 playing 1");
    expect(states(events)).toEqual(["1 loading 0", "1 playing 80", "2 loading 0", "2 playing 1"]);
  });

  it("does nothing for a command of a load the receiver no longer has", async () => {
    const { receiver, connection } = await connected();
    await connection.load(film(1), never);
    await connection.load(film(2), never);

    await connection.play(1);
    await connection.pause(1);
    await connection.seek(1, 50);
    await connection.showSubtitles(1, true);
    await connection.stop(1);
    await connection.pause(3);
    expect(receiver.received.filter((message) => "mediaSessionId" in message.payload)).toEqual([]);

    await connection.pause(2);
    await connection.seek(2, 50);
    await connection.play(2);
    const id = receiver.media?.mediaSessionId;
    expect(receiver.requests("PAUSE")).toMatchObject([{ mediaSessionId: id }]);
    expect(receiver.requests("PLAY")).toMatchObject([{ mediaSessionId: id }]);
    // A seek names no state to resume in, so the receiver keeps the one it has.
    expect(receiver.requests("SEEK")).toMatchObject([{ mediaSessionId: id, currentTime: 50 }]);
    expect(receiver.requests("SEEK")[0]).not.toHaveProperty("resumeState");

    // Once the receiver let go of the media, a command for it is answered with a refusal.
    receiver.idle("FINISHED");
    await connection.play(2);
    await connection.stop(2);
    expect(receiver.requests("PLAY")).toHaveLength(2);
  });

  it("ends a load and keeps the receiver", async () => {
    const { receiver, connection, events } = await connected();
    await connection.load(film(1), never);
    receiver.status({ playerState: "PLAYING", currentTime: 20 });

    await connection.stop(1);

    expect(states(events).at(-1)).toBe("1 stopped 20");
    expect(receiver.app).not.toBeNull();
    expect(receiver.media).toBeNull();
  });

  it("shows and hides the text track once the receiver lists it", async () => {
    const { receiver, connection, events } = await connected();
    receiver.tracks = [
      { trackId: 1, type: "AUDIO" },
      { trackId: 2, type: "TEXT" },
    ];
    const edits = () => receiver.requests("EDIT_TRACKS_INFO").map((edit) => edit.activeTrackIds);

    // Asked for at the load, they are turned on when its answer lists the tracks.
    await connection.load(film(1, { subtitles: true }), never);
    await expect.poll(edits).toEqual([[2]]);

    // The sound track the receiver plays stays chosen.
    receiver.status({ playerState: "PLAYING", currentTime: 3, activeTrackIds: [1, 2] });
    await expect.poll(() => states(events).at(-1)).toBe("1 playing 3");
    await connection.showSubtitles(1, false);
    await connection.showSubtitles(1, true);
    expect(edits()).toEqual([[2], [1], [1, 2]]);

    // A load that doesn't want them asks nothing while the receiver shows none.
    await connection.load(film(2), never);
    receiver.status({ playerState: "PLAYING" });
    await connection.showSubtitles(2, false);
    expect(edits()).toHaveLength(3);
  });

  it("sets the receiver's volume and reports it", async () => {
    const { receiver, connection, events } = await connected();
    await expect.poll(() => ofType(events, "volume")).toHaveLength(1);

    await connection.setVolume({ level: 0.3 });
    await connection.setVolume({ muted: true });
    receiver.setVolume(0.8, false);

    expect(receiver.requests("SET_VOLUME").map((request) => request.volume)).toEqual([
      { level: 0.3 },
      { muted: true },
    ]);
    await expect
      .poll(() => ofType(events, "volume").slice(1))
      .toEqual([
        { type: "volume", level: 0.3, muted: false },
        { type: "volume", level: 0.3, muted: true },
        { type: "volume", level: 0.8, muted: false },
      ]);
  });

  it("fails a request by its deadline when the receiver never answers", async () => {
    const { receiver, connection, events } = await connected({ load: 100 });

    receiver.answers.load = "ignore";

    expect(await failure(connection.load(film(1), never))).toEqual({ kind: "unreachable" });
    expect(receiver.requests("LOAD")).toHaveLength(1);
    expect(receiver.connections).toBe(1);
    expect(ofType(events, "lost")).toEqual([]);
  });

  it("rejects a command the receiver refuses", async () => {
    const { receiver, connection } = await connected();
    await connection.load(film(1), never);

    receiver.answers.command = "refuse";

    expect(await failure(connection.pause(1))).toEqual({
      kind: "media",
      detail: "INVALID_PLAYER_STATE",
    });
    expect(receiver.connections).toBe(1);
  });

  it("stops a load the service gave up on, should the receiver play it after all", async () => {
    const { receiver, connection, events } = await connected();
    receiver.answers.load = "ignore";
    const giveUp = new AbortController();
    const loading = connection.load(film(1), giveUp.signal);
    await expect.poll(() => receiver.requests("LOAD").length).toBe(1);

    giveUp.abort();
    expect(await failure(loading)).toEqual({ kind: "unreachable" });

    receiver.media = {
      mediaSessionId: 7,
      playerState: "PLAYING",
      currentTime: 0,
      activeTrackIds: [],
      media: { contentId: film(1).url },
    };
    receiver.send({
      type: "MEDIA_STATUS",
      requestId: receiver.requests("LOAD")[0]?.requestId,
      status: [receiver.media],
    });

    await expect.poll(() => receiver.requests("STOP")).toMatchObject([{ mediaSessionId: 7 }]);
    expect(statuses(events)).toEqual([]);
  });

  it("asks for the position while media plays, and notices media that went unannounced", async () => {
    const { receiver, connection, events } = await connected({ status: 25 });
    await connection.load(film(1), never);
    receiver.status({ playerState: "PLAYING", currentTime: 10 });
    await expect.poll(() => states(events).at(-1)).toBe("1 playing 10");

    // The TV plays on and tells nobody.
    if (receiver.media) receiver.media.currentTime = 55;
    await expect.poll(() => states(events).at(-1)).toBe("1 playing 55");

    receiver.media = null;
    await expect.poll(() => states(events).at(-1)).toBe("1 stopped 55");
    // Nothing plays any more, so nothing more is asked.
    await settled(() => receiver.requests("GET_STATUS").length);
  });

  it("reopens a connection that dropped and takes the running app up again", async () => {
    const { receiver, connection, events } = await connected();
    await connection.load(film(1), never);
    const transportId = receiver.app?.transportId;

    // The TV plays on while the connection is down.
    if (receiver.media) Object.assign(receiver.media, { playerState: "PLAYING", currentTime: 9 });
    receiver.drop();

    // It asks what plays as soon as it is back, and commands go through again.
    await expect.poll(() => states(events).at(-1)).toBe("1 playing 9");
    expect(receiver.connections).toBe(2);
    await connection.pause(1);
    expect(receiver.requests("LAUNCH")).toHaveLength(1);
    expect(
      receiver.received.filter((message) => message.destinationId === transportId),
    ).toMatchObject([
      { payload: { type: "CONNECT" } },
      { payload: { type: "LOAD" } },
      { payload: { type: "CONNECT" } },
      { payload: { type: "GET_STATUS" } },
      { payload: { type: "PAUSE" } },
    ]);
    expect(ofType(events, "lost")).toEqual([]);
    expect(ofType(events, "released")).toEqual([]);
  });

  it("reports the receiver lost once it went silent and didn't come back", async () => {
    const { receiver, connection, events } = await connected({
      ping: 50,
      silence: 600,
      attempt: 100,
    });

    receiver.silent = true;

    await expect
      .poll(() => ofType(events, "lost"))
      .toEqual([{ type: "lost", failure: { kind: "unreachable" } }]);
    expect(await failure(connection.setVolume({ muted: true }))).toEqual({ kind: "unreachable" });
    await expect.poll(() => receiver.sockets.size).toBe(0);
    expect(ofType(events, "released")).toEqual([]);
  });

  it("reports the receiver lost after three tries at reaching it again", async () => {
    const { receiver, events } = await connected();

    receiver.refusing = true;
    receiver.drop();

    await expect
      .poll(() => ofType(events, "lost"))
      .toEqual([{ type: "lost", failure: { kind: "unreachable" } }]);
    // The connection it had and three it was refused, and no more after that.
    expect(receiver.connections).toBe(4);
    await settled(() => receiver.connections);
    expect(receiver.connections).toBe(4);
  });

  it("reports the receiver released when the app is stopped on it", async () => {
    const { receiver, connection, events } = await connected();
    await connection.load(film(1), never);

    receiver.stopApp();

    await expect.poll(() => ofType(events, "released")).toEqual([{ type: "released" }]);
    await expect.poll(() => receiver.sockets.size).toBe(0);
    expect(ofType(events, "lost")).toEqual([]);
    expect(await failure(connection.play(1))).toEqual({ kind: "unreachable" });
  });

  it("reports the receiver released when the app went while the connection was down", async () => {
    const { receiver, events } = await connected();

    receiver.app = null;
    receiver.drop();

    await expect.poll(() => ofType(events, "released")).toEqual([{ type: "released" }]);
    expect(receiver.requests("LAUNCH")).toHaveLength(1);
    expect(ofType(events, "lost")).toEqual([]);
  });

  it("stops the media and the app when it disconnects, and says nothing more", async () => {
    const { receiver, connection, events } = await connected();
    await connection.load(film(1), never);
    const { app, media } = receiver;
    const told = events.length;

    await connection.disconnect();

    expect(receiver.requests("STOP")).toMatchObject([
      { mediaSessionId: media?.mediaSessionId },
      { sessionId: app?.sessionId },
    ]);
    expect(receiver.app).toBeNull();
    await expect.poll(() => receiver.sockets.size).toBe(0);
    expect(events).toHaveLength(told);
    expect(await failure(connection.play(1))).toEqual({ kind: "unreachable" });
  });

  it("lets go of a receiver that answers nothing, in bounded time", async () => {
    const { receiver, adapter, connection, events } = await connected();
    await connection.load(film(1), never);
    const told = events.length;

    receiver.silent = true;
    const started = performance.now();
    await connection.disconnect();
    await adapter.close();

    expect(performance.now() - started).toBeLessThan(2000);
    await expect.poll(() => receiver.sockets.size).toBe(0);
    expect(events).toHaveLength(told);
  });

  it("reads messages with fields and types a newer receiver adds", async () => {
    const { receiver, connection, events } = await connected();
    await connection.load(film(1), never);
    const status = (currentTime: number) => ({
      type: "MEDIA_STATUS",
      requestId: 0,
      status: [{ ...receiver.media, playerState: "PLAYING", currentTime, liveSeekableRange: {} }],
      extra: { nested: [1, 2, 3] },
    });

    // The schema's newer fields, and fields of every wire type it has never heard of: a varint,
    // 64 bits, bytes, a group with a field inside, and 32 bits.
    const unknown = protobuf.Writer.create()
      .uint32(tag(15, 0))
      .uint64(Number.MAX_SAFE_INTEGER)
      .uint32(tag(16, 1))
      .fixed64(7)
      .uint32(tag(17, 2))
      .bytes(Buffer.alloc(300, 1))
      .uint32(tag(18, 3))
      .uint32(tag(1, 0))
      .uint32(5)
      .uint32(tag(18, 4))
      .uint32(tag(19, 5))
      .fixed32(9)
      .finish();
    receiver.frame(
      Buffer.concat([
        receiver.encode(status(11), { continued: false, remainingLength: 0, protocolVersion: 3 }),
        unknown,
      ]),
    );
    await expect.poll(() => states(events).at(-1)).toBe("1 playing 11");

    // Types and namespaces it doesn't know, a binary payload, and text that isn't JSON.
    receiver.send({ type: "QUEUE_CHANGE", requestId: 0, changeType: "INSERT" });
    receiver.send({ type: "MEDIA_STATUS", requestId: 0, status: "soon" });
    receiver.send({ type: "HELLO" }, { namespace: "urn:x-cast:com.example.custom" });
    receiver.send({}, { payloadType: 1, payloadBinary: Buffer.from([1, 2, 3]) });
    receiver.send({}, { payloadUtf8: "not json" });
    receiver.status({ playerState: "PLAYING", currentTime: 13 });

    await expect.poll(() => states(events).at(-1)).toBe("1 playing 13");
    expect(receiver.connections).toBe(1);
  });

  it("puts together a message the receiver sends in parts", async () => {
    const { receiver, connection, events } = await connected();
    await connection.load(film(1), never);
    const whole = Buffer.from(
      JSON.stringify({
        type: "MEDIA_STATUS",
        requestId: 0,
        status: [{ ...receiver.media, playerState: "PLAYING", currentTime: 21 }],
        note: "é".repeat(40),
      }),
    );
    // Cut where a receiver might, inside a two-byte character, so neither part is text on its
    // own. protobufjs writes the payload's bytes as they are, with `continued` and
    // `remaining_length` on the first part.
    const cut = whole.length - 41;
    const part = (bytes: Uint8Array, remaining: number | null) => {
      const writer = protobuf.Writer.create().uint32(tag(1, 0)).int32(0);
      writer.uint32(tag(2, 2)).string(receiver.app?.transportId ?? "");
      writer.uint32(tag(3, 2)).string("*").uint32(tag(4, 2)).string(MEDIA);
      writer.uint32(tag(5, 0)).int32(0).uint32(tag(6, 2)).bytes(bytes);
      if (remaining !== null) {
        writer.uint32(tag(8, 0)).bool(true).uint32(tag(9, 0)).uint32(remaining);
      }
      return writer.finish();
    };

    receiver.frame(part(whole.subarray(0, cut), whole.length - cut));
    receiver.frame(part(whole.subarray(cut), null));

    await expect.poll(() => states(events).at(-1)).toBe("1 playing 21");
    expect(receiver.connections).toBe(1);
  });

  it("closes the connection on a frame that is too large or isn't the protocol", async () => {
    const { receiver, connection, events } = await connected();
    await connection.load(film(1), never);
    /** Resolves once a command goes through again: the app was taken up after the last break. */
    const back = () => expect.poll(() => failure(connection.play(1))).toBeNull();
    const memory = process.memoryUsage().arrayBuffers;

    // A length of 2 GB, and no intention of sending it: the adapter must not make room.
    receiver.frame(Buffer.alloc(16), 0x7fff_ffff);
    await expect.poll(() => receiver.connections).toBe(2);
    expect(process.memoryUsage().arrayBuffers - memory).toBeLessThan(16 * 1024 * 1024);

    // One byte over the protocol's limit.
    await back();
    receiver.frame(Buffer.alloc(65_536));
    await expect.poll(() => receiver.connections).toBe(3);

    // A length-delimited field that claims more than the frame holds.
    await back();
    receiver.frame(Buffer.from([0x12, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x41]));
    await expect.poll(() => receiver.connections).toBe(4);

    // A varint that never ends.
    await back();
    receiver.frame(Buffer.alloc(12, 0xff));
    await expect.poll(() => receiver.connections).toBe(5);

    // Behind a message that is fine: a field numbered 0, which protobuf has none of, and a
    // group that ends as another field's.
    const fine = receiver.encode({ type: "MEDIA_STATUS" });
    await back();
    receiver.frame(Buffer.concat([fine, Buffer.from([0, 0])]));
    await expect.poll(() => receiver.connections).toBe(6);
    await back();
    receiver.frame(Buffer.concat([fine, Buffer.from([tag(18, 3), 1, tag(17, 4), 1])]));
    await expect.poll(() => receiver.connections).toBe(7);

    // A message in parts that never ends.
    await back();
    for (let part = 0; part < 6; part++) {
      receiver.send({}, { payloadUtf8: "x".repeat(60_000), continued: true });
    }
    await expect.poll(() => receiver.connections).toBe(8);

    // Each time the app was still there to take up again.
    await back();
    expect(receiver.requests("LAUNCH")).toHaveLength(1);
    expect(ofType(events, "lost")).toEqual([]);
    expect(ofType(events, "released")).toEqual([]);
  });

  it("lets go of the receiver it has when asked to connect again", async () => {
    const { receiver, adapter, connection, events } = await connected();
    await connection.load(film(1), never);
    const first = receiver.app;
    const told = events.length;

    const request = { kind: "receiver", id: receiver.receiver.id } as const;
    const second = await adapter.connect(request, never);

    expect(receiver.requests("STOP").at(-1)).toMatchObject({ sessionId: first?.sessionId });
    expect(receiver.requests("LAUNCH")).toHaveLength(2);
    expect(receiver.app).not.toEqual(first);
    expect(await failure(connection.play(1))).toEqual({ kind: "unreachable" });
    await second?.load(film(2), never);
    expect(states(events.slice(told))).toEqual(["2 loading 0"]);
  });

  it("says nothing once it is closed", async () => {
    const { receiver, adapter, connection, events } = await connected();
    await connection.load(film(1), never);
    const told = events.length;

    await adapter.close();
    adapter.scan(true);

    expect(receiver.app).toBeNull();
    await expect.poll(() => receiver.sockets.size).toBe(0);
    expect(events).toHaveLength(told);
    const request = { kind: "receiver", id: receiver.receiver.id } as const;
    expect(await failure(adapter.connect(request, never))).toEqual({ kind: "unreachable" });
  });
});

const SERVICE = "_googlecast._tcp.local";

/** What a receiver answers a browse with: its service, where that listens, and its details. */
function advertisement(
  name: string,
  text: readonly string[],
  port = 8009,
  address = "127.0.0.1",
): { answers: dnsPacket.Answer[]; additionals: dnsPacket.Answer[] } {
  const instance = `${name}.${SERVICE}`;
  const host = `${name}.local`;
  return {
    answers: [{ type: "PTR", name: SERVICE, ttl: 120, data: instance }],
    additionals: [
      { type: "SRV", name: instance, ttl: 120, data: { port, target: host } },
      { type: "TXT", name: instance, ttl: 120, data: [...text] },
      { type: "A", name: host, ttl: 120, data: address },
    ],
  };
}

const response = (...parts: { answers: dnsPacket.Answer[]; additionals?: dnsPacket.Answer[] }[]) =>
  dnsPacket.encode({
    type: "response",
    flags: dnsPacket.AUTHORITATIVE_ANSWER,
    answers: parts.flatMap((part) => part.answers),
    additionals: parts.flatMap((part) => part.additionals ?? []),
  });

/** A responder on loopback that answers each query with what `answer` gives for it. */
async function responder(answer: (query: dnsPacket.DecodedPacket) => readonly Uint8Array[]) {
  const socket = createSocket("udp4");
  const queries: dnsPacket.DecodedPacket[] = [];
  socket.on("message", (packet, from) => {
    const query = dnsPacket.decode(packet);
    queries.push(query);
    for (const reply of answer(query)) socket.send(reply, from.port, from.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => socket.close(() => resolve())));
  return { port: socket.address().port, queries };
}

/**
 * An adapter that browses on loopback, asking the responder at `port` every 25 ms, and the lists
 * it told. A receiver stays listed for `expiry` ms without an answer: long, unless a test is
 * about one that stops answering.
 */
function browsing(port: number, expiry = 10_000) {
  const adapter = castAdapter({
    discovery: castDiscovery({
      group: { address: "127.0.0.1", port },
      addresses: () => ["127.0.0.1"],
      backoff: [25],
      expiry,
    }),
    timings: TIMINGS,
  });
  const lists: (readonly Receiver[])[] = [];
  adapter.listen((event) => {
    if (event.type === "receivers") lists.push(event.receivers);
  });
  cleanups.push(() => adapter.close());
  adapter.scan(true);
  return { adapter, lists };
}

describe("Cast discovery", () => {
  it("lists the receivers that show video, and connects to one it found", async () => {
    const receiver = await startFakeCastReceiver();
    cleanups.push(() => receiver.close());
    const { port, queries } = await responder(() => [
      response(
        advertisement(
          "Chromecast-1",
          ["id=aaaa1111", "fn=Living Room TV", "ca=4101"],
          receiver.port,
        ),
        // A speaker, a group of speakers, and a TV that doesn't say what it is.
        advertisement("Speaker-2", ["id=bbbb2222", "fn=Kitchen speaker", "ca=2052"]),
        advertisement("Group-3", ["id=cccc3333", "fn=Downstairs", "ca=2085"], 32001),
      ),
      response(advertisement("TV-4", ["id=dddd4444", "fn=Bedroom TV"])),
      // One that says it is somewhere on the internet, and one on another local network.
      response(advertisement("TV-5", ["id=eeee5555", "fn=Far TV", "ca=4101"], 8009, "203.0.113.9")),
      response(advertisement("TV-6", ["id=ffff6666", "fn=Wired TV", "ca=4101"], 8009, "10.0.0.9")),
    ]);
    const { adapter, lists } = browsing(port);

    await expect
      .poll(() => lists.at(-1))
      .toEqual([
        { id: "aaaa1111", kind: "cast", name: "Living Room TV" },
        { id: "dddd4444", kind: "cast", name: "Bedroom TV" },
        { id: "ffff6666", kind: "cast", name: "Wired TV" },
      ]);
    // A scan starts by saying what is known, which is nothing yet.
    expect(lists[0]).toEqual([]);
    // dns-packet reads the browse: one question, asking for the answer by unicast, which it
    // shows as class 0x8001.
    expect(queries[0]).toMatchObject({
      type: "query",
      questions: [{ name: SERVICE, type: "PTR", class: "UNKNOWN_32769" }],
    });

    const connection = await adapter.connect({ kind: "receiver", id: "aaaa1111" }, never);
    expect(connection?.receiver).toEqual({ id: "aaaa1111", kind: "cast", name: "Living Room TV" });
    expect(receiver.requests("LAUNCH")).toHaveLength(1);
  });

  it("reads names a receiver compressed", async () => {
    const u16 = (value: number) => Buffer.from([value >> 8, value & 0xff]);
    const label = (text: string) => Buffer.from([Buffer.byteLength(text), ...Buffer.from(text)]);
    const pointer = (offset: number) => u16(0xc000 | offset);
    const record = (name: Buffer, type: number, data: Buffer) =>
      Buffer.concat([name, u16(type), u16(1), u16(0), u16(120), u16(data.length), data]);

    // The service's name is written once, in the question at byte 12; every other name ends
    // in a pointer to it, or to its last label, or is nothing but a pointer.
    const head = dnsPacket.encode({
      type: "response",
      flags: dnsPacket.AUTHORITATIVE_ANSWER,
      questions: [{ name: SERVICE, type: "PTR" }],
    });
    const local = 12 + "_googlecast._tcp.".length;
    const instance = head.length + 2 + 10;
    const text = Buffer.concat([label("id=eeee5555"), label("fn=Café TV"), label("ca=4101")]);
    const ptr = record(pointer(12), 12, Buffer.concat([label("Chromecast-5"), pointer(12)]));
    const srvData = Buffer.concat([u16(0), u16(0), u16(8009), label("host-5"), pointer(local)]);
    const srv = record(pointer(instance), 33, srvData);
    const host = instance + ptr.length - 12 + 2 + 10 + 6;
    const packet = Buffer.concat([
      head,
      ptr,
      srv,
      record(pointer(instance), 16, text),
      record(pointer(host), 1, Buffer.from([127, 0, 0, 1])),
    ]);
    packet.writeUInt16BE(4, 6);

    // dns-packet follows the pointers to the names meant.
    expect(dnsPacket.decode(packet).answers).toMatchObject([
      { type: "PTR", name: SERVICE, data: `Chromecast-5.${SERVICE}` },
      {
        type: "SRV",
        name: `Chromecast-5.${SERVICE}`,
        data: { port: 8009, target: "host-5.local" },
      },
      { type: "TXT", name: `Chromecast-5.${SERVICE}` },
      { type: "A", name: "host-5.local", data: "127.0.0.1" },
    ]);

    const { port } = await responder(() => [packet]);
    const { lists } = browsing(port);

    await expect
      .poll(() => lists.at(-1))
      .toEqual([{ id: "eeee5555", kind: "cast", name: "Café TV" }]);
  });

  it("ignores packets that loop, lie about their size or are too large", async () => {
    const good = response(advertisement("TV-1", ["id=good", "fn=Good TV", "ca=4101"]));
    const bad = (name: string) => advertisement(name, [`id=${name}`, `fn=${name}`, "ca=4101"]);
    // A name that points at itself, where the first record's name starts.
    const loop = Buffer.from(response(bad("loop")));
    loop.writeUInt16BE(0xc000 | 12, 12);
    // A name that points ahead, at a pointer back to it.
    const ahead = Buffer.from(response(bad("ahead")));
    ahead.writeUInt16BE(0xc000 | 14, 12);
    ahead.writeUInt16BE(0xc000 | 12, 14);
    // A name that points ahead at a name that ends: no loop, and still not a name, as names
    // only ever point back. dns-packet refuses it too.
    const plain = response(bad("forward"));
    const name = plain.subarray(12, 12 + SERVICE.length + 2);
    const moved = plain.length - name.length + 2;
    const forward = Buffer.concat([
      plain.subarray(0, 12),
      Buffer.from([0xc0 | (moved >> 8), moved & 0xff]),
      plain.subarray(12 + name.length),
      name,
    ]);
    expect(() => dnsPacket.decode(forward)).toThrow("bad pointer");
    // A record that claims more bytes than the packet has, and a packet cut short.
    const long = Buffer.from(response(bad("long")));
    long.writeUInt16BE(0xffff, 12 + SERVICE.length + 2 + 8);
    const short = response(bad("short")).subarray(0, 60);
    // More records than any receiver sends, and more bytes than mDNS allows.
    const many = response(bad("many"), {
      answers: Array.from({ length: 120 }, (_, host) => ({
        type: "A" as const,
        name: `host-${host}.local`,
        ttl: 120,
        data: "127.0.0.1",
      })),
    });
    const padding = "x".repeat(200);
    const large = response(
      advertisement("large", ["id=large", ...Array<string>(50).fill(padding)]),
    );
    expect(large.length).toBeGreaterThan(9000);

    const bogus = [loop, ahead, forward, long, short, many, large];
    const { port, queries } = await responder(() => [...bogus, good]);
    const { lists } = browsing(port);

    // The good one arrives behind the others each time it asks, and is the only one ever listed.
    await expect.poll(() => lists).toHaveLength(2);
    const asked = queries.length;
    await expect.poll(() => queries.length).toBeGreaterThan(asked + 2);
    expect(lists).toEqual([[], [{ id: "good", kind: "cast", name: "Good TV" }]]);
  });

  it("asks for what a receiver left out of its answer", async () => {
    const whole = advertisement("TV-1", ["id=ffff6666", "fn=Sparse TV", "ca=4101"]);
    const { port, queries } = await responder((query) =>
      (query.questions ?? []).flatMap((asked) => {
        const answers = [...whole.answers, ...whole.additionals].filter(
          (record) => record.type === asked.type && record.name === asked.name,
        );
        return answers.length > 0 ? [response({ answers })] : [];
      }),
    );
    const { lists } = browsing(port);

    await expect
      .poll(() => lists.at(-1))
      .toEqual([{ id: "ffff6666", kind: "cast", name: "Sparse TV" }]);
    const asked = queries.flatMap((query) => query.questions ?? []);
    expect(asked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: `TV-1.${SERVICE}`, type: "SRV" }),
        expect.objectContaining({ name: `TV-1.${SERVICE}`, type: "TXT" }),
        expect.objectContaining({ name: "TV-1.local", type: "A" }),
      ]),
    );
  });

  it("drops a receiver that stopped answering, and asks nothing once the scan ends", async () => {
    let answering = true;
    const { port, queries } = await responder(() =>
      answering ? [response(advertisement("TV-1", ["id=gone", "fn=Gone TV", "ca=4101"]))] : [],
    );
    const { adapter, lists } = browsing(port, 200);
    await expect.poll(() => lists.at(-1)).toHaveLength(1);

    answering = false;
    await expect.poll(() => lists.at(-1)).toEqual([]);

    adapter.scan(false);
    await settled(() => queries.length);
  });
});
