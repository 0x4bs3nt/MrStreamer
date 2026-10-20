// @vitest-environment happy-dom
// A window that opens while a receiver plays, as after a reload, takes up what plays there once
// the lists name it: a channel in Watch, a movie or episode in its view, as the receiver has it
// by then. What the receiver let go of, lost or got something else in place of while the lists
// were asked is left alone: nothing shows, no watch is recorded, and a load that is gone is told
// nothing. So is what played when the login form took the pages' place, what played under the
// account before, and what the viewer played something else over.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { Episode, SeriesDetails, Title, TitleRef } from "@mrstreamer/contracts/ondemand";
import type {
  Output,
  OutputStatus,
  Receiver,
  RemoteItem,
  RemoteMedia,
  RemotePlayingTitle,
  RemoteState,
} from "@mrstreamer/contracts/output";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { App } from "../../src/renderer/src/app/App.tsx";
import { resetForAccount, useUi } from "../../src/renderer/src/app/ui-store.ts";
import { TooltipProvider } from "../../src/renderer/src/components/ui/tooltip.tsx";
import { queries } from "../../src/renderer/src/lib/queries.ts";
import { movieNow, playTitle } from "../../src/renderer/src/lib/titles.ts";
import { player } from "../../src/renderer/src/player/player.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

const tv: Receiver = { id: "tv", kind: "cast", name: "Living Room TV" };
const bedroom: Receiver = { id: "bedroom", kind: "cast", name: "Bedroom TV" };

function status(output: Output): OutputStatus {
  return {
    offers: ["cast"],
    airplayRoutes: null,
    scanning: false,
    receivers: [tv, bedroom],
    output,
  };
}

const HERE = status({ kind: "local" });
const LOST = status({ kind: "lost", receiver: tv, failure: { kind: "unreachable" } });

/** `receiver` connected, playing `media` or nothing. */
function connected(media: RemoteMedia | null = null, receiver = tv) {
  return status({
    kind: "receiver",
    receiver,
    volume: { level: 0.5, muted: false },
    media,
    failure: null,
  });
}

function said(
  generation: number,
  item: RemoteItem,
  state: RemoteState,
  position = 0,
  duration: number | null = null,
): RemoteMedia {
  return {
    generation,
    sessionId: `r${generation}`,
    item,
    state,
    position,
    at: Date.now(),
    duration,
    subtitles: false,
  };
}

const subscription: SubscriptionSummary = {
  kind: "xtream",
  id: "https://line.example.tv|demo",
  name: null,
  server: "https://line.example.tv",
  username: "demo",
  account: { state: "active", expiresAt: null, maxConnections: 1, activeConnections: 0 },
  needsSecret: false,
};

const channel = (id: string): LiveChannel => ({
  subscriptionId: SUBSCRIPTION,
  id,
  name: `NL | ${id}`,
  title: id,
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  catchupDays: null,
  variants: [{ id, name: `NL | ${id}`, tags: [], quality: null }],
});
const channelItem: RemoteItem = {
  kind: "channel",
  channel: { subscriptionId: SUBSCRIPTION, id: "a" },
};

const movie: Title = {
  kind: "movie",
  key: "movie:m1",
  subscriptionId: SUBSCRIPTION,
  id: "m1",
  name: "Low Tide (EN)",
  title: "Low Tide",
  originalTitle: null,
  originalLanguage: "en",
  tags: ["EN"],
  year: 2024,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: "1",
  genres: [],
  versions: [{ subscriptionId: SUBSCRIPTION, id: "m1", tags: ["EN"] }],
};
const movieRef: TitleRef = { kind: "movie", subscriptionId: SUBSCRIPTION, id: "m1" };
const movieItem: RemoteItem = { kind: "title", title: movieRef };

function episode(id: string, number: number, title: string): Episode {
  return {
    subscriptionId: SUBSCRIPTION,
    id,
    seriesId: "s",
    season: 1,
    number,
    title,
    plot: null,
    duration: 2700,
    stillUrl: null,
    airDate: null,
  };
}

const series: SeriesDetails = {
  kind: "series",
  title: { ...movie, kind: "series", id: "s", name: "Canyon Hours (EN)", title: "Canyon Hours" },
  originalTitle: null,
  plot: null,
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: null,
  backdropUrl: null,
  seasons: [
    {
      number: 1,
      name: "Season 1",
      posterUrl: null,
      episodes: [episode("e1", 1, "First Light"), episode("e2", 2, "Low Sun")],
    },
  ],
};
const episodeRef: TitleRef = {
  kind: "episode",
  subscriptionId: SUBSCRIPTION,
  id: "e1",
  seriesId: "s",
  season: 1,
  episode: 1,
};
const episodeItem: RemoteItem = { kind: "title", title: episodeRef };

/** What the main process says of the title load `generation` plays, an hour long. */
function playingTitle(generation: number, title: TitleRef): RemotePlayingTitle {
  return {
    title: {
      sessionId: `r${generation}`,
      title,
      duration: 3600,
      audio: [],
      subtitles: [],
      shows: ["text"],
    },
    since: 1,
    audio: null,
    subtitle: null,
  };
}

let container: HTMLDivElement;
let client: QueryClient;
let unmount = () => {};

const emit = (now: OutputStatus) => act(async () => ipc.emit("output.changed", now));
const wait = (ms = 0) => act(async () => vi.advanceTimersByTimeAsync(ms));
const text = () => container.textContent ?? "";
/** What the receiver was told about what it plays. */
const commands = () => ipc.argsOf("output.command");

function press(label: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find(
    (each) => each.textContent === label || each.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`No ${label} button in "${text()}"`);
  return act(async () => button.click());
}

/**
 * Opens the window while the receiver stands at `now`: the pages show, and ask what it plays.
 * The lists, asked after, answer when the test says.
 */
async function open(now: OutputStatus): Promise<void> {
  // What the window's status holds from its start, before any page shows.
  await emit(now);
  const subscribed = ipc.hold("subscription.list");
  const asked = ipc.hold("output.status");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TooltipProvider, null, createElement(App)),
      ),
    ),
  );
  unmount = () => act(() => root.unmount());
  await act(async () => subscribed.resolve([subscription]));
  await wait();
  await act(async () => asked.resolve(now));
}

beforeEach(() => {
  vi.useFakeTimers();
  ipc.reset();
  ipc.always("liveBrowse.get", { kind: "all" });
  client = new QueryClient();
  useUi.setState(useUi.getInitialState(), true);
  container = document.createElement("div");
});

afterEach(async () => {
  await unmount();
  unmount = () => {};
  titlePlayer.close();
  player.reset();
  await emit(HERE);
  vi.useRealTimers();
});

/**
 * What became of the receiver's load 1 of `item` while the lists were asked, for it not to be
 * taken up. Sent again, as with another sound track, it is another load of the same session.
 */
const gone = (item: RemoteItem) => [
  { how: "the receiver was let go of", now: HERE },
  { how: "the receiver's connection broke", now: LOST },
  { how: "the receiver plays nothing any more", now: connected() },
  {
    how: "the receiver was sent it again",
    now: connected({ ...said(2, item, "loading"), sessionId: "r1" }),
  },
  {
    how: "the receiver plays something else",
    now: connected(
      said(2, { kind: "channel", channel: { subscriptionId: SUBSCRIPTION, id: "b" } }, "playing"),
    ),
  },
  { how: "another TV took its place", now: connected(null, bedroom) },
];

describe("a channel a receiver plays as the window opens", () => {
  const playing = connected(said(1, channelItem, "playing"));

  it("shows in Watch once the lists name it, watched as it plays", async () => {
    const lists = ipc.hold("library.channels");
    await open(playing);
    expect(useUi.getState().watching).toBe(false);

    await act(async () => lists.resolve([channel("a")]));
    await wait();

    expect(text()).toContain("Playing on Living Room TV");
    expect(player.state().channel?.id).toBe("a");
    expect(ipc.argsOf("viewing.recordWatch")).toMatchObject([
      { channel: { subscriptionId: SUBSCRIPTION, id: "a" } },
    ]);
    expect(ipc.methods()).not.toContain("output.playChannel");
  });

  it("shows as the receiver has it by then: paused there, and not watched", async () => {
    const lists = ipc.hold("library.channels");
    await open(playing);

    // Paused with the TV's own remote while the lists were asked.
    await emit(connected(said(1, channelItem, "paused")));
    await act(async () => lists.resolve([channel("a")]));
    await wait();

    expect(text()).toContain("Paused on Living Room TV");
    expect(ipc.argsOf("viewing.recordWatch")).toEqual([]);

    // From then on it follows the receiver like any channel played there.
    await emit(playing);
    expect(text()).toContain("Playing on Living Room TV");
    expect(ipc.argsOf("viewing.recordWatch")).toHaveLength(1);
  });

  it.each(gone(channelItem))(
    "is left alone when $how before the lists answered",
    async ({ now }) => {
      const lists = ipc.hold("library.channels");
      await open(playing);

      await emit(now);
      await act(async () => lists.resolve([channel("a")]));
      await wait();

      // The answer held was the one to what the receiver played.
      expect(ipc.argsOf("library.channels")[0]).toEqual({
        channels: [{ subscriptionId: SUBSCRIPTION, id: "a" }],
      });
      expect(useUi.getState().watching).toBe(false);
      expect(player.onReceiver()).toBe(false);
      expect(player.state()).toMatchObject({ channel: null, phase: { kind: "idle" } });
      expect(ipc.argsOf("viewing.recordWatch")).toEqual([]);
      expect(commands()).toEqual([]);
    },
  );
});

describe("a movie a receiver plays as the window opens", () => {
  /**
   * Opens the window on the movie as load 1, two minutes in, and has the main process say which
   * file plays: the movie's, unless the test says another. Returns the lists' answer, for the
   * test to give.
   */
  async function opened(file = playingTitle(1, movieRef)) {
    const playing = ipc.hold("output.playingTitle");
    const lists = ipc.hold("ondemand.titles");
    await open(connected(said(1, movieItem, "playing", 120, 3600)));
    await act(async () => playing.resolve(file));
    return lists;
  }

  it("shows in its view where the receiver is by then, and plays that load on", async () => {
    const lists = await opened();
    expect(useUi.getState().playingTitle).toBe(false);

    // Paused with the TV's own remote while the lists were asked.
    await emit(connected(said(1, movieItem, "paused", 300, 3600)));
    await act(async () => lists.resolve([movie]));
    await wait();

    expect(text()).toContain("Low Tide");
    expect(text()).toContain("Paused on Living Room TV");
    expect(titlePlayer.state()).toMatchObject({
      phase: { kind: "paused" },
      position: 300,
      duration: 3600,
    });
    await press("Play");
    expect(commands()).toEqual([{ generation: 1, command: "play" }]);
    expect(ipc.methods()).not.toContain("output.openTitle");
  });

  it.each(gone(movieItem))("is left alone when $how before the lists answered", async ({ now }) => {
    const lists = await opened();

    await emit(now);
    await act(async () => lists.resolve([movie]));
    await wait();

    // The answer held was the one to what the receiver played.
    expect(ipc.argsOf("ondemand.titles")[0]).toEqual({
      kind: "movie",
      versions: [{ subscriptionId: SUBSCRIPTION, id: "m1" }],
    });
    expect(useUi.getState().playingTitle).toBe(false);
    expect(titlePlayer.state().now).toBeNull();
    expect(titlePlayer.onReceiver()).toBe(false);
    // Space, wherever it is pressed, tells the load that is gone nothing.
    titlePlayer.togglePause();
    expect(commands()).toEqual([]);
  });

  it("is left alone when the main process says another title's file plays", async () => {
    const lists = await opened(
      playingTitle(2, { kind: "movie", subscriptionId: SUBSCRIPTION, id: "m2" }),
    );

    await act(async () => lists.resolve([{ ...movie, id: "m2" }]));
    await wait();

    expect(useUi.getState().playingTitle).toBe(false);
    expect(titlePlayer.state().now).toBeNull();
  });
});

describe("an episode a receiver plays as the window opens", () => {
  it.each([true, false])(
    "takes up the exact alternate file only while it remains listed: %s",
    async (listed) => {
      const ref = { ...episodeRef, id: "e1-4k" };
      const playing = ipc.hold("output.playingTitle");
      const lists = ipc.hold("ondemand.details");
      await open(connected(said(1, { kind: "title", title: ref }, "paused", 600, 2700)));
      await act(async () => playing.resolve(playingTitle(1, ref)));
      await act(async () =>
        lists.resolve({
          ...series,
          exactVersions: true,
          seasons: [
            {
              ...series.seasons[0]!,
              episodes: [
                {
                  ...episode("e1", 1, "First Light"),
                  exactVersion: true,
                  versions: [
                    { id: "e1", name: "Standard", tags: [], duration: 2700 },
                    ...(listed ? [{ id: ref.id, name: "4K", tags: ["4K"], duration: 2700 }] : []),
                  ],
                },
                episode("e2", 2, "Low Sun"),
              ],
            },
          ],
        }),
      );
      await wait();

      expect(useUi.getState().playingTitle).toBe(listed);
      if (listed) {
        expect(titlePlayer.state()).toMatchObject({
          now: { title: ref },
          phase: { kind: "paused" },
          position: 600,
          next: { id: "e2" },
        });
        await press("Play");
        expect(commands()).toEqual([{ generation: 1, command: "play" }]);
      } else {
        expect(titlePlayer.state().now).toBeNull();
        expect(commands()).toEqual([]);
      }
    },
  );

  it("shows in its view, with the one after it to come", async () => {
    const playing = ipc.hold("output.playingTitle");
    const lists = ipc.hold("ondemand.details");
    await open(connected(said(1, episodeItem, "paused", 600, 2700)));
    await act(async () => playing.resolve(playingTitle(1, episodeRef)));

    await act(async () => lists.resolve(series));
    await wait();

    expect(text()).toContain("First Light");
    expect(titlePlayer.state()).toMatchObject({
      phase: { kind: "paused" },
      position: 600,
      next: { id: "e2" },
    });
  });
});

describe("what a receiver plays as the window opens, once the viewer went on", () => {
  const playing = connected(said(1, channelItem, "playing"));

  it("is left alone behind Connect, which ends it once no subscription is saved", async () => {
    const lists = ipc.hold("library.channels");
    await open(playing);

    // The last subscription was removed, as Settings says once the main process did it.
    await act(async () => client.setQueryData(queries.subscriptions().queryKey, []));
    await wait();
    expect(commands()).toEqual([{ generation: 1, command: "stop" }]);
    await act(async () => lists.resolve([channel("a")]));
    await wait();

    expect(useUi.getState().watching).toBe(false);
    expect(player.onReceiver()).toBe(false);
    expect(ipc.argsOf("viewing.recordWatch")).toEqual([]);
  });

  it("is left alone under another account, whose lists answered", async () => {
    const lists = ipc.hold("library.channels");
    await open(playing);

    // The account went, as when Settings removes the subscription: the pages are still there.
    await act(async () => resetForAccount());
    await act(async () => lists.resolve([channel("a")]));
    await wait();

    expect(useUi.getState().watching).toBe(false);
    expect(player.onReceiver()).toBe(false);
    expect(ipc.argsOf("viewing.recordWatch")).toEqual([]);
  });

  it("is left alone under a movie the viewer plays there before the lists answered", async () => {
    const lists = ipc.hold("library.channels");
    await open(playing);

    // The receiver hasn't taken the movie yet: its last word is still of the channel.
    await act(async () => playTitle(movieNow(movie, null), 0));
    await act(async () => lists.resolve([channel("a")]));
    await wait();

    expect(useUi.getState()).toMatchObject({ watching: false, playingTitle: true });
    expect(player.onReceiver()).toBe(false);
    expect(titlePlayer.state().now?.name).toBe("Low Tide");
    expect(ipc.argsOf("viewing.recordWatch")).toEqual([]);
  });

  it("is left alone under a channel the viewer plays there before the lists answered", async () => {
    const file = ipc.hold("output.playingTitle");
    const lists = ipc.hold("ondemand.titles");
    await open(connected(said(1, movieItem, "playing", 120, 3600)));
    await act(async () => file.resolve(playingTitle(1, movieRef)));

    // The receiver hasn't taken the channel yet: its last word is still of the movie.
    await act(async () => player.play(channel("b")));
    await act(async () => lists.resolve([movie]));
    await wait();

    expect(useUi.getState().playingTitle).toBe(false);
    expect(titlePlayer.state().now).toBeNull();
    expect(player.state().channel?.id).toBe("b");
    expect(ipc.argsOf("output.playChannel")).toMatchObject([
      { channel: { subscriptionId: SUBSCRIPTION, id: "b" } },
    ]);
  });
});
