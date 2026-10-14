// @vitest-environment happy-dom
// The system's media controls for a channel take play, pause and stop, never next or previous, so
// a headphone's double tap can't change channel. A view closing after the next one opened, as a
// movie does when a channel is picked over it, leaves the next one's controls in place. What a
// receiver on the network plays is paused and played by what the receiver last said, since
// nothing plays in the window then: a channel paused with the TV's remote shows as paused, and
// play has the receiver play on with the stream it has.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { OutputStatus, RemoteMedia } from "@mrstreamer/contracts/output";

/** Stands in for Chromium's session, keeping what the page set. */
const handlers = new Map<MediaSessionAction, MediaSessionActionHandler>();
const session = {
  metadata: null as { title: string; artist: string } | null,
  playbackState: "none" as MediaSessionPlaybackState,
  setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
    if (handler) handlers.set(action, handler);
    else handlers.delete(action);
  },
  setPositionState() {},
};
Object.defineProperty(navigator, "mediaSession", { value: session, configurable: true });
Object.assign(globalThis, {
  MediaMetadata: class {
    constructor(init: { title: string; artist: string }) {
      return init;
    }
  },
});
const { useLiveSession, useTitleSession } =
  await import("../../src/renderer/src/player/media-session.ts");
const { player } = await import("../../src/renderer/src/player/player.ts");
const { titlePlayer } = await import("../../src/renderer/src/player/title-player.ts");

const channel = (title: string): LiveChannel => ({
  subscriptionId: SUBSCRIPTION,
  id: title,
  name: `NL | ${title}`,
  title,
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  catchupDays: null,
  variants: [],
});

function Watch({ channel }: { channel: LiveChannel }) {
  useLiveSession(channel);
  return null;
}

describe("the system's media controls", () => {
  it("offer a channel play, pause and stop, and outlive a view closing after it", async () => {
    ipc.reset();
    const root = createRoot(document.createElement("div"));
    const client = new QueryClient();
    const render = (...channels: LiveChannel[]) =>
      act(() =>
        root.render(
          createElement(
            QueryClientProvider,
            { client },
            channels.map((each) => createElement(Watch, { key: each.id, channel: each })),
          ),
        ),
      );

    await render(channel("Arena 1"));
    expect([...handlers.keys()].sort()).toEqual(["pause", "play", "stop"]);

    // The second view opens before the first closes.
    await render(channel("Arena 1"), channel("Arena 2"));
    await render(channel("Arena 2"));
    expect(session.metadata?.title).toBe("Arena 2");
    expect([...handlers.keys()].sort()).toEqual(["pause", "play", "stop"]);
    await act(() => root.unmount());
    expect(session.metadata).toBeNull();
  });

  it("pause and play a movie on a receiver by what the receiver said", async () => {
    ipc.reset();
    const tv = { id: "tv", kind: "cast", name: "Living Room TV" } as const;
    const title = { kind: "movie", subscriptionId: SUBSCRIPTION, id: "m1" } as const;
    const media = (state: RemoteMedia["state"]): RemoteMedia => ({
      generation: 1,
      sessionId: "r1",
      item: { kind: "title", title },
      state,
      position: 60,
      at: Date.now(),
      duration: 3600,
      subtitles: false,
    });
    const said = (state: RemoteMedia["state"]): OutputStatus => ({
      offers: ["cast"],
      airplayRoutes: null,
      scanning: false,
      receivers: [tv],
      output: { kind: "receiver", receiver: tv, volume: null, failure: null, media: media(state) },
    });
    const root = createRoot(document.createElement("div"));
    await act(() => root.render(createElement(Title)));
    await act(async () => {
      ipc.emit("output.changed", said("playing"));
      titlePlayer.adopt(
        {
          kind: "provider",
          title,
          name: "Low Tide",
          detail: "2024",
          artworkUrl: null,
          originalLanguage: "en",
        },
        {
          sessionId: "r1",
          duration: 3600,
          audio: [],
          subtitles: [],
          shows: ["text"],
          audioId: null,
          subtitleId: null,
          since: 1,
        },
        media("playing"),
      );
    });
    expect(session.metadata?.title).toBe("Low Tide");
    expect(session.playbackState).toBe("playing");
    const commands = () => ipc.argsOf("output.command");

    handlers.get("play")?.({ action: "play" });
    expect(commands()).toEqual([]);
    handlers.get("pause")?.({ action: "pause" });
    expect(commands()).toEqual([{ generation: 1, command: "pause" }]);

    await act(async () => ipc.emit("output.changed", said("paused")));
    expect(session.playbackState).toBe("paused");
    handlers.get("pause")?.({ action: "pause" });
    handlers.get("play")?.({ action: "play" });
    expect(commands()).toEqual([
      { generation: 1, command: "pause" },
      { generation: 1, command: "play" },
    ]);

    titlePlayer.close();
    await act(() => root.unmount());
  });

  it("show a channel the receiver holds paused, and play has it play on there", async () => {
    ipc.reset();
    const tv = { id: "tv", kind: "cast", name: "Living Room TV" } as const;
    const arena = channel("Arena 1");
    const media = (state: RemoteMedia["state"]): RemoteMedia => ({
      generation: 4,
      sessionId: "r4",
      item: { kind: "channel", channel: { subscriptionId: SUBSCRIPTION, id: arena.id } },
      state,
      position: 0,
      at: Date.now(),
      duration: null,
      subtitles: false,
    });
    const said = (state: RemoteMedia["state"] | null) =>
      act(async () =>
        ipc.emit("output.changed", {
          offers: ["cast"],
          airplayRoutes: null,
          scanning: false,
          receivers: [tv],
          output: {
            kind: "receiver",
            receiver: tv,
            volume: null,
            failure: null,
            media: state && media(state),
          },
        }),
      );
    await said(null);
    const loaded = ipc.hold("output.playChannel");
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(Watch, { channel: arena }),
        ),
      );
      player.play(arena);
    });
    await act(async () => loaded.resolve(media("loading")));
    await said("playing");
    expect(session.playbackState).toBe("playing");
    const commands = () => ipc.argsOf("output.command");

    // Paused with the TV's own remote.
    await said("paused");
    expect(session.playbackState).toBe("paused");
    handlers.get("play")?.({ action: "play" });
    expect(commands()).toEqual([{ generation: 4, command: "play" }]);
    // The receiver plays on with the stream it has: nothing opens again, there or here.
    expect(ipc.argsOf("output.playChannel")).toHaveLength(1);
    expect(ipc.methods()).not.toContain("playback.open");

    // Buffering is on its way to playing, and play has nothing to add to either.
    await said("buffering");
    expect(session.playbackState).toBe("playing");
    await said("playing");
    expect(session.playbackState).toBe("playing");
    handlers.get("play")?.({ action: "play" });
    expect(commands()).toHaveLength(1);

    player.reset();
    await act(() => root.unmount());
  });

  it("leave a channel that opens here alone when play is pressed", async () => {
    ipc.reset();
    await act(async () =>
      ipc.emit("output.changed", {
        offers: [],
        airplayRoutes: null,
        scanning: false,
        receivers: [],
        output: { kind: "local" },
      }),
    );
    const arena = channel("Arena 1");
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(Watch, { channel: arena }),
        ),
      );
      player.play(arena);
    });
    expect(session.playbackState).toBe("playing");

    handlers.get("play")?.({ action: "play" });

    expect(ipc.argsOf("playback.open")).toHaveLength(1);
    expect(ipc.methods()).not.toContain("output.command");

    player.reset();
    await act(() => root.unmount());
  });
});

function Title() {
  useTitleSession();
  return null;
}
