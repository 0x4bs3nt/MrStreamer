// @vitest-environment happy-dom
// Where the system's list of receivers is asked to open: at the output button as the view shows
// it at that moment. From the mini player, which has no such button, the window goes back first
// and the list is asked for once it has, full screen again where it was. An O the viewer overtook
// asks for none, and neither does one whose view closed or whose account went, whatever is open
// in its place by then. Where no view shows the button, the list opens in the middle of the
// window, never where it opened before.
//
// A list asked for is its view's from then on. Each goes by a name of its own, and when the view
// closes or its account goes, the page takes back the lists of that view that are still asked
// for, by their names, and tells the main process nothing else.
import { fullScreen, ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, StrictMode, type FunctionComponent } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { Title } from "@mrstreamer/contracts/ondemand";
import type { Output, OutputStatus, Receiver } from "@mrstreamer/contracts/output";

const airplay: Receiver = { id: "airplay", kind: "airplay", name: null };

/** A Mac's outputs: the system's list is the only chooser. */
const status = (output: Output): OutputStatus => ({
  offers: ["airplay"],
  airplayRoutes: true,
  scanning: false,
  receivers: [],
  output,
});

const channel: LiveChannel = {
  subscriptionId: SUBSCRIPTION,
  id: "a",
  name: "NL | a",
  title: "a",
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  catchupDays: null,
  variants: [{ id: "a", name: "NL | a", tags: [], quality: null }],
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

/** Where the output button is in the full window. happy-dom lays nothing out, so this says. */
const BUTTON = { x: 1100, y: 720, width: 44, height: 44 };
/** Where it is once the page fills the screen. */
const FULL_BUTTON = { x: 1740, y: 1000, width: 44, height: 44 };

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The app's modules, loaded once the main process can say that windows stay on top. */
async function loaded() {
  const available = ipc.hold("window.miniPlayerAvailable");
  const { miniPlayer } = await import("../../src/renderer/src/app/mini-player.ts");
  const ui = await import("../../src/renderer/src/app/ui-store.ts");
  const { TitleWatch } = await import("../../src/renderer/src/features/titles/TitleWatch.tsx");
  const { WatchScreen } = await import("../../src/renderer/src/features/watch/WatchScreen.tsx");
  const { movieNow, playTitle } = await import("../../src/renderer/src/lib/titles.ts");
  const { outputs } = await import("../../src/renderer/src/player/output.ts");
  const { player } = await import("../../src/renderer/src/player/player.ts");
  const { titlePlayer } = await import("../../src/renderer/src/player/title-player.ts");
  available.resolve(true);
  await settle();
  return {
    ...ui,
    miniPlayer,
    TitleWatch,
    WatchScreen,
    movieNow,
    playTitle,
    outputs,
    player,
    titlePlayer,
  };
}

let app: Awaited<ReturnType<typeof loaded>>;
let container: HTMLDivElement;
let unmount = () => {};

/** The lists the page asked the system for so far: where each opens, and the name it goes by. */
const lists = () => ipc.argsOf("output.pick");
/** The places the system's list was asked to open at so far. */
const asked = () => lists().map(({ anchor }) => ({ anchor }));
/** The names of the lists the page took back so far. */
const takenBack = () => ipc.argsOf("output.closePicker").map(({ request }) => request);

/** Shows `view` as the window does once `open` asked for it. */
async function show(view: FunctionComponent, open: () => void): Promise<void> {
  const root = createRoot(container);
  unmount = () => act(() => root.unmount());
  await act(async () => {
    open();
    root.render(
      createElement(QueryClientProvider, { client: new QueryClient() }, createElement(view)),
    );
    await settle();
  });
}

/** Watch on channel `a`, which plays here, as the window shows it. */
const watching = () =>
  show(app.WatchScreen, () => {
    app.openWatch();
    app.player.play(channel);
  });

/** The two views with an output button: how the window comes to show each, and how it is left. */
const views = {
  Watch: { show: watching, leave: () => app.closeWatch() },
  "a title": {
    show: () => show(app.TitleWatch, () => app.playTitle(app.movieNow(movie, null), 0)),
    leave: () => {
      app.titlePlayer.close();
      app.useUi.setState({ playingTitle: false });
    },
  },
};

const key = (name: string) =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
    await settle();
  });

/** How a view asks for the system's list. */
const ways = {
  O: () => key("o"),
  "its button": async () => {
    const more = container.querySelector<HTMLElement>('[aria-label="More"]');
    if (more) {
      await act(async () => {
        more.click();
        await settle();
      });
      await act(async () => {
        const output = document.querySelector<HTMLButtonElement>('[aria-label="Play on"]');
        if (!output) throw new Error("No Play on row in More");
        output.click();
        await settle();
      });
      await act(async () => {
        const airplay = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "AirPlay",
        );
        if (!airplay) throw new Error("No AirPlay choice in More > Play on");
        airplay.click();
        await settle();
      });
    } else {
      await act(async () =>
        container.querySelector<HTMLElement>('[aria-label="AirPlay"]')?.click(),
      );
    }
  },
};

/** The view closes, as when the viewer leaves it. */
async function close(view: keyof typeof views): Promise<void> {
  await unmount();
  unmount = () => {};
  await act(async () => views[view].leave());
}

/** What `event` leads to, once the page has taken it in. */
const after = (event: () => void) =>
  act(async () => {
    event();
    await settle();
  });

/** The main process says the window fills the screen, or no longer does. */
const windowFills = (fills: boolean) => after(() => ipc.emit("window.fullScreen", fills));

/** The mini player, shrunk from a window that filled the screen where `from` says so. */
async function shrunk(from?: "full screen"): Promise<void> {
  if (from) {
    fullScreen.on = true;
    await windowFills(true);
  }
  ipc.hold("window.setMiniPlayer").resolve(null);
  await act(() => app.miniPlayer.enter());
  // The main process takes the window out of full screen before it shrinks it.
  await windowFills(false);
  // The mini player has no output button for the list to open at.
  expect(container.querySelector("[data-output]")).toBeNull();
}

beforeEach(async () => {
  app ??= await loaded();
  ipc.reset();
  fullScreen.reset();
  container = document.createElement("div");
  document.body.append(container);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const button = fullScreen.on ? FULL_BUTTON : BUTTON;
    const at = this.hasAttribute("data-output") ? button : { x: 0, y: 0, width: 0, height: 0 };
    return new DOMRect(at.x, at.y, at.width, at.height);
  });
  await act(async () => ipc.emit("output.changed", status({ kind: "local" })));
});

afterEach(async () => {
  await unmount();
  unmount = () => {};
  await act(async () => {
    app.closeWatch();
    views["a title"].leave();
    app.player.reset();
    await settle();
  });
  container.remove();
  vi.restoreAllMocks();
  await windowFills(false);
});

describe("the system's list of receivers", () => {
  it("opens at the output button, from the button and from O", async () => {
    await watching();

    await ways["its button"]();
    expect(asked()).toEqual([{ anchor: BUTTON }]);

    await key("o");
    expect(asked()).toEqual([{ anchor: BUTTON }, { anchor: BUTTON }]);
  });

  it.each([
    { how: "O", keys: ["o"] },
    { how: "O twice", keys: ["o", "o"] },
    { how: "Escape, then O", keys: ["Escape", "o"] },
  ])(
    "opens from the mini player only once the window is back, at the button it then shows: $how",
    async ({ keys }) => {
      await watching();
      await shrunk();

      const back = ipc.hold("window.setMiniPlayer");
      for (const each of keys) await key(each);
      // The window goes back once, whichever key asked first.
      expect(ipc.argsOf("window.setMiniPlayer")).toEqual([{ on: true }, { on: false }]);
      // It is still on its way back: nothing is measured or asked for yet.
      expect(asked()).toEqual([]);

      await after(() => back.resolve(null));
      // Each O asks, as it does in the full window.
      expect(asked()).toEqual(keys.filter((each) => each === "o").map(() => ({ anchor: BUTTON })));
    },
  );

  it.each([
    { how: "O", keys: ["o"] },
    { how: "O twice", keys: ["o", "o"] },
  ])(
    "opens from a mini player that was full screen only once the window fills the screen again: $how",
    async ({ keys }) => {
      await watching();
      await shrunk("full screen");

      const back = ipc.hold("window.setMiniPlayer");
      const granted = fullScreen.hold("request");
      for (const each of keys) await key(each);
      await after(() => back.resolve(null));
      // The window is back at its size, and asked to fill the screen once.
      expect(fullScreen.requests).toBe(1);
      expect(asked()).toEqual([]);

      await after(granted.grant);
      // The page has full screen at once. The window takes its time, changing size on the way.
      expect(fullScreen.on).toBe(true);
      expect(asked()).toEqual([]);

      await windowFills(true);
      expect(asked()).toEqual(keys.map(() => ({ anchor: FULL_BUTTON })));
    },
  );

  it("opens for an O pressed while P still left full screen once the window fills it again, unshrunk", async () => {
    await watching();
    fullScreen.on = true;
    await windowFills(true);

    const left = fullScreen.hold("exit");
    await key("p");
    await key("o");
    await after(left.grant);
    // The page left full screen at once. The window is still on its way out, and it can't be
    // asked back before it is.
    expect(fullScreen.requests).toBe(0);
    expect(asked()).toEqual([]);

    await windowFills(false);
    expect(fullScreen.requests).toBe(1);
    expect(asked()).toEqual([]);

    await windowFills(true);
    expect(asked()).toEqual([{ anchor: FULL_BUTTON }]);
    // O stopped the way in before the window shrank.
    expect(ipc.argsOf("window.setMiniPlayer")).toEqual([]);
  });

  it.each([
    { how: "P shrank the window again", keys: ["p"] },
    { how: "P shrank it and put it back again", keys: ["p", "p"] },
  ])("opens nothing for an O the viewer overtook: $how", async ({ keys }) => {
    await watching();
    await shrunk();

    // O, then P before the main process has put the window back.
    const moves = [ipc.hold("window.setMiniPlayer")];
    await key("o");
    for (const each of keys) {
      moves.push(ipc.hold("window.setMiniPlayer"));
      await key(each);
    }
    // The window's moves end in turn, first the way back O waited for.
    for (const move of moves) {
      await after(() => move.resolve(null));
      expect(asked()).toEqual([]);
    }

    // The next O is its own, and opens the list once the window is back.
    ipc.hold("window.setMiniPlayer").resolve(null);
    await key("o");
    expect(asked()).toEqual([{ anchor: BUTTON }]);
  });

  it("opens nothing once the view that asked has closed", async () => {
    await watching();
    await shrunk();

    const back = ipc.hold("window.setMiniPlayer");
    await key("o");
    await act(async () => app.closeWatch());
    await after(() => back.resolve(null));
    expect(asked()).toEqual([]);
  });

  it.each(["Watch", "a title"] as const)(
    "opens nothing in a view opened in place of the one that asked, until its own O: %s",
    async (view) => {
      await views[view].show();
      await shrunk();

      const back = ipc.hold("window.setMiniPlayer");
      await key("o");
      // The viewer leaves the view and opens it again before the window is back.
      await unmount();
      await act(async () => views[view].leave());
      await views[view].show();
      await after(() => back.resolve(null));
      expect(asked()).toEqual([]);

      await key("o");
      expect(asked()).toEqual([{ anchor: BUTTON }]);
    },
  );

  it("opens nothing once the account changed, with Watch open again by then, until the next O", async () => {
    await watching();
    await shrunk();

    const back = ipc.hold("window.setMiniPlayer");
    await key("o");
    // Another account, and Watch again before the page drew anything: the view never left it.
    await act(async () => {
      app.resetForAccount();
      app.openWatch();
    });
    await after(() => back.resolve(null));
    expect(asked()).toEqual([]);

    await key("o");
    expect(asked()).toEqual([{ anchor: BUTTON }]);
  });

  it("opens all the same when the main process could not put the window back, and for the next O", async () => {
    await watching();
    await shrunk();

    const back = ipc.hold("window.setMiniPlayer");
    await key("o");
    await after(() => back.reject({ kind: "unexpected", detail: "The window closed." }));
    expect(asked()).toEqual([{ anchor: BUTTON }]);

    await key("o");
    expect(asked()).toEqual([{ anchor: BUTTON }, { anchor: BUTTON }]);
  });

  it("opens where the window was put back when full screen is refused, and for the next O", async () => {
    await watching();
    await shrunk("full screen");

    ipc.hold("window.setMiniPlayer").resolve(null);
    const request = fullScreen.hold("request");
    await key("o");
    expect(asked()).toEqual([]);
    // The window stays as it was put back, with nothing more to wait for.
    await after(request.refuse);
    expect(asked()).toEqual([{ anchor: BUTTON }]);

    await key("o");
    expect(asked()).toEqual([{ anchor: BUTTON }, { anchor: BUTTON }]);
  });

  it("opens in the middle of the window where no view shows the button, not where it was", async () => {
    await watching();
    await key("o");
    expect(asked()).toEqual([{ anchor: BUTTON }]);

    // The receiver's connection broke, and no view with the button is on screen any more.
    await unmount();
    unmount = () => {};
    await act(async () =>
      ipc.emit(
        "output.changed",
        status({ kind: "lost", receiver: airplay, failure: { kind: "unreachable" } }),
      ),
    );
    app.outputs.reconnect();

    expect(asked()[1]).toEqual({
      anchor: { x: window.innerWidth / 2, y: window.innerHeight / 2, width: 0, height: 0 },
    });
  });
});

describe("the system's list and the view it was asked from", () => {
  it.each(
    (["Watch", "a title"] as const).flatMap((view) =>
      (["O", "its button"] as const).map((way) => ({ view, way })),
    ),
  )(
    "goes with its view, and nothing else does: $view, asked for by $way",
    async ({ view, way }) => {
      await views[view].show();
      await ways[way]();
      const [list] = lists();
      expect(list).toMatchObject({ anchor: BUTTON });
      // Asked for, and its view on screen: it stays.
      expect(takenBack()).toEqual([]);

      await close(view);
      expect(takenBack()).toEqual([list?.request]);
      // Only the list: nobody went back to this computer, and a receiver was told nothing.
      expect(ipc.methods()).not.toContain("output.disconnect");
      expect(ipc.methods()).not.toContain("output.command");
    },
  );

  it("goes with its view when Try again asked for it, as after a TV's connection broke", async () => {
    await watching();
    await act(async () =>
      ipc.emit(
        "output.changed",
        status({ kind: "lost", receiver: airplay, failure: { kind: "unreachable" } }),
      ),
    );
    app.outputs.reconnect();
    const [list] = lists();
    expect(list).toMatchObject({ anchor: BUTTON });

    await close("Watch");
    expect(takenBack()).toEqual([list?.request]);
  });

  it("is nothing to take back once the viewer was done at it", async () => {
    await watching();
    const done = ipc.hold("output.pick");
    await key("o");
    await after(() => done.resolve(status({ kind: "local" })));

    await close("Watch");
    expect(takenBack()).toEqual([]);
  });

  it("goes by a name of its own, so only the one still asked for is taken back", async () => {
    await watching();
    const first = ipc.hold("output.pick");
    await key("o");
    await key("o");
    const [older, newer] = lists().map(({ request }) => request);
    expect(older).not.toBe(newer);
    // The main process answers the first as the second takes its place.
    await after(() => first.resolve(status({ kind: "local" })));

    await close("Watch");
    expect(takenBack()).toEqual([newer]);
  });

  it.each(["Watch", "a title"] as const)(
    "leaves alone the list of a view opened in its place: %s",
    async (view) => {
      await views[view].show();
      const first = ipc.hold("output.pick");
      await key("o");
      await close(view);
      await views[view].show();
      await key("o");
      const [older, newer] = lists().map(({ request }) => request);
      // The view that closed took its own list back, before and after the next one was asked for.
      expect(takenBack()).toEqual([older]);

      // The first list's answer comes late, and takes nothing from the view that is there now.
      await after(() => first.resolve(status({ kind: "local" })));
      expect(takenBack()).toEqual([older]);
      await close(view);
      expect(takenBack()).toEqual([older, newer]);
    },
  );

  it("is the view's that is still on screen, once one that opened over it has closed", async () => {
    // Two views at once, as each says it is on screen.
    const under = new AbortController();
    const over = new AbortController();
    app.outputs.viewShown(under.signal);
    app.outputs.viewShown(over.signal);
    over.abort();
    app.outputs.pick();
    expect(takenBack()).toEqual([]);

    under.abort();
    expect(takenBack()).toEqual(lists().map(({ request }) => request));
  });

  it("goes with its account, with Watch open again by then, and the next one is the view's again", async () => {
    await watching();
    await key("o");
    const [older] = lists().map(({ request }) => request);
    // Another account, and Watch again before the page drew anything: the view never left it.
    await act(async () => {
      app.resetForAccount();
      app.openWatch();
    });
    expect(takenBack()).toEqual([older]);

    await key("o");
    const newer = lists().at(-1)?.request;
    expect(takenBack()).toEqual([older]);
    await close("Watch");
    expect(takenBack()).toEqual([older, newer]);
  });

  it("is its view's all the same where React sets the view up twice, as in development", async () => {
    await show(
      () => createElement(StrictMode, null, createElement(app.WatchScreen)),
      () => {
        app.openWatch();
        app.player.play(channel);
      },
    );
    // The first setup ended with nothing asked for, and took nothing back.
    expect(takenBack()).toEqual([]);
    await key("o");
    // One view, one O, one list.
    expect(asked()).toEqual([{ anchor: BUTTON }]);
    expect(takenBack()).toEqual([]);

    await close("Watch");
    expect(takenBack()).toEqual(lists().map(({ request }) => request));
  });
});
