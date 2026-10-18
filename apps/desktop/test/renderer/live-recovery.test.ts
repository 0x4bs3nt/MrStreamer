// @vitest-environment happy-dom
// A live channel that doesn't play says what was observed of it and offers what can help. One that
// breaks off is tried again after 1, 2, 4 and 8 seconds, and those four tries are the channel's
// until it played for half a minute: coming back for a moment earns no more of them. A refusal is
// never tried again by itself, nor answered with another quality. A quality chosen for the channel
// stays chosen. Nothing the provider or an engine said in words reaches the screen. Stop, another
// channel and leaving Watch end a wait, so nothing opens behind the viewer, and no stream is asked
// for while another is open.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { LivePlaying, StreamFailure } from "@mrstreamer/contracts/playback";
import { defaultSubscriptionPreferences } from "@mrstreamer/contracts/preferences";
import { miniPlayer } from "../../src/renderer/src/app/mini-player.ts";
import { closeWatch, openWatch, useUi } from "../../src/renderer/src/app/ui-store.ts";
import { WatchScreen } from "../../src/renderer/src/features/watch/WatchScreen.tsx";
import { player } from "../../src/renderer/src/player/player.ts";

// This computer keeps a window on top of others, so Watch has its mini player.
await vi.hoisted(async () => {
  const { ipc: main } = await import("./support.ts");
  main.hold("window.miniPlayerAvailable").resolve(true);
});

const vrt: LiveChannel = {
  subscriptionId: SUBSCRIPTION,
  id: "vrt",
  name: "BE | VRT 1 FHD",
  title: "VRT 1",
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  catchupDays: null,
  variants: [
    { id: "vrt", name: "BE | VRT 1 FHD", tags: ["FHD"], quality: "fhd" },
    { id: "vrt-hd", name: "BE | VRT 1 HD", tags: ["HD"], quality: "hd" },
    { id: "vrt-sd", name: "BE | VRT 1 SD", tags: ["SD"], quality: "sd" },
  ],
};

const een: LiveChannel = {
  subscriptionId: SUBSCRIPTION,
  id: "een",
  name: "BE | EEN",
  title: "EEN",
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  catchupDays: null,
  variants: [{ id: "een", name: "BE | EEN", tags: [], quality: null }],
};

/** The waits before each reconnect, in order. */
const WAITS = [1000, 2000, 4000, 8000];

/** What the main process says of a stream that stopped arriving, in the provider's own words. */
const DROPPED: StreamFailure = {
  kind: "network",
  detail: "read ECONNRESET http://demo:hunter2@panel.example:8080/live/demo/hunter2/1.ts",
};

const refused = (status: number): StreamFailure => ({ kind: "refused", status });
const noStream: StreamFailure = { kind: "unavailable", status: 404 };

/** What a session says it tried: the streams the provider didn't deliver, and the one it did. */
const tried = (failed: Record<string, StreamFailure>, variantId: string | null = null) =>
  ({
    variantId,
    failed: Object.entries(failed).map(([id, failure]) => ({ variantId: id, failure })),
  }) satisfies LivePlaying;

let container: HTMLDivElement;
let unmount = () => {};
let sessions = 0;

const wait = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));
const text = () => container.textContent ?? "";
/** The streams asked for so far. */
const asked = () => ipc.argsOf("playback.open");
/** What the failed or reconnecting channel offers, in order, besides closing its message. */
const offered = () =>
  [
    ...container.querySelectorAll("[data-playback-state] button:not([aria-label='Close message'])"),
  ].map((each) => each.textContent);
/** What a screen reader is told. */
const announced = () => container.querySelector(".sr-only[role=status]")?.textContent ?? "";

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (each) => each.textContent === label || each.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`No ${label} button in "${text()}"`);
  return found;
}

const press = (label: string) => act(async () => button(label).click());

/** A key pressed with `target` in focus; says whether the page took it for itself. */
async function key(name: string, target: EventTarget = window): Promise<boolean> {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

/**
 * Stands ready for the next stream the player asks for. The function it returns gives that
 * request a session, whose picture has yet to move.
 */
function nextStream(): () => Promise<void> {
  const held = ipc.hold("playback.open");
  return () =>
    act(async () => {
      const sessionId = `s${++sessions}`;
      held.resolve({
        sessionId,
        channel: { subscriptionId: SUBSCRIPTION, id: "vrt" },
        url: `http://127.0.0.1/stream/${sessionId}`,
        format: "hls",
      });
    });
}

/**
 * The picture moves for `seconds`, as that of a stream that plays. The screen is drawn once at the
 * end: the player watches the picture each second, and Watch only shows what it concluded.
 */
async function plays(seconds: number): Promise<void> {
  await act(async () => {
    for (let second = 0; second < seconds; second++) {
      player.element.currentTime += 1;
      await vi.advanceTimersByTimeAsync(1000);
    }
  });
}

/**
 * The stream under way stops, before its picture moved or after. The main process says why the
 * provider didn't deliver it, or null when the provider did, and which streams the session tried.
 */
async function stops(why: StreamFailure | null, session: LivePlaying | null = null): Promise<void> {
  const failure = ipc.hold("playback.failure");
  const playing = ipc.hold("playback.playing");
  await act(async () => {
    player.element.dispatchEvent(new Event("error"));
    failure.resolve(why);
    playing.resolve(session);
  });
}

/** Opens Watch on `channel` with its sound on, as the viewer does: its stream is asked for. */
async function watching(channel = vrt): Promise<void> {
  player.setAudible(true);
  openWatch();
  await act(async () => player.play(channel));
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(QueryClientProvider, { client: new QueryClient() }, createElement(WatchScreen)),
    ),
  );
  unmount = () => act(() => root.unmount());
}

/** Watch on a channel whose stream plays for `seconds`. */
async function playing(seconds: number, channel = vrt): Promise<void> {
  const starts = nextStream();
  await watching(channel);
  await starts();
  await plays(seconds);
  expect(player.state().phase.kind).toBe("playing");
}

/** Whether no stream was asked for while the one before it was still open. */
function oneAtATime(): boolean {
  let open = 0;
  for (const method of ipc.methods()) {
    if (method === "playback.close") open--;
    if (method !== "playback.open") continue;
    if (open > 0) return false;
    open++;
  }
  return true;
}

beforeEach(() => {
  vi.useFakeTimers();
  ipc.reset();
  sessions = 0;
  useUi.setState(useUi.getInitialState(), true);
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => {
    player.reset();
    closeWatch();
  });
  await unmount();
  unmount = () => {};
  container.remove();
  vi.useRealTimers();
});

describe("a channel that breaks off", () => {
  it("is tried again four times at most while it only comes back for a moment", async () => {
    await playing(5);

    for (const [index, delay] of WAITS.entries()) {
      const starts = nextStream();
      await stops(DROPPED);
      expect(text()).toContain("Reconnecting");
      expect(text()).toContain(`attempt ${index + 1} of 4`);
      await wait(delay);
      await starts();
      await plays(5);
      expect(player.state().phase.kind).toBe("playing");
    }
    await stops(DROPPED);

    expect(text()).toContain("Keeps dropping");
    expect(text()).toContain("VRT 1 came back 4 times and dropped again within 30 seconds.");
    expect(text()).toContain("4 reconnects");
    await wait(60_000);
    expect(asked()).toHaveLength(5);
    expect(oneAtATime()).toBe(true);
  });

  it("has every reconnect again once it played for half a minute", async () => {
    await playing(5);
    const starts = nextStream();
    await stops(DROPPED);
    await wait(1000);
    await starts();

    await plays(31);
    await stops(DROPPED);

    expect(text()).toContain("attempt 1 of 4");
  });

  it("counts none of the time its picture stood still", async () => {
    await playing(5);
    const starts = nextStream();
    await stops(DROPPED);
    await wait(1000);
    await starts();

    // 25 seconds of picture in 37 on the clock.
    await plays(20);
    await wait(12_000);
    await plays(5);
    await stops(DROPPED);

    expect(text()).toContain("attempt 2 of 4");
  });

  it("says it lost the stream when it played and four reconnects brought nothing, and tells a screen reader once, without the attempts or their seconds", async () => {
    await playing(40);
    expect(announced()).toBe("");

    const reconnecting = "Reconnecting. VRT 1's stream isn't arriving.";
    for (const delay of WAITS) {
      const starts = nextStream();
      await stops(DROPPED);
      expect(announced()).toBe(reconnecting);
      await wait(delay);
      expect(announced()).toBe(reconnecting);
      await starts();
    }
    await stops(DROPPED);

    expect(text()).toContain("Lost the stream");
    expect(text()).toContain("VRT 1 stopped arriving and reconnecting didn't bring it back.");
    expect(text()).toContain("4 reconnects");
    expect(offered()).toEqual(["Retry", "Quality", "Channels"]);
    expect(announced()).toBe(
      "Lost the stream. VRT 1 stopped arriving and reconnecting didn't bring it back.",
    );
  });
});

describe("a channel that never starts", () => {
  it("is asked for again after 1, 2, 4 and 8 seconds, then says the provider didn't answer", async () => {
    let starts = nextStream();
    await watching();

    for (const delay of WAITS) {
      await starts();
      starts = nextStream();
      await stops(DROPPED);
      const before = asked().length;
      await wait(delay - 1);
      expect(asked()).toHaveLength(before);
      await wait(1);
      expect(asked()).toHaveLength(before + 1);
    }
    await starts();
    await stops(DROPPED, tried({ vrt: DROPPED, "vrt-hd": DROPPED, "vrt-sd": DROPPED }));

    expect(text()).toContain("No answer from the provider");
    expect(text()).toContain("VRT 1's stream never started sending.");
    expect(text()).toContain("Full HD, HD, SD · 4 reconnects");
    // Every quality was tried, so the menu has nothing more to offer.
    expect(offered()).toEqual(["Retry", "Next channel", "Channels"]);
    await wait(60_000);
    expect(asked()).toHaveLength(5);
    expect(oneAtATime()).toBe(true);
  });

  it("says no picture arrived when the provider answered and nothing played", async () => {
    let starts = nextStream();
    await watching();

    for (const delay of WAITS) {
      await starts();
      starts = nextStream();
      // Twenty seconds without a picture, and the main process has nothing to say of it.
      ipc.hold("playback.failure").resolve(null);
      ipc.hold("playback.playing").resolve(tried({}, "vrt"));
      await wait(21_000);
      await wait(delay);
    }
    await starts();
    ipc.hold("playback.failure").resolve(null);
    ipc.hold("playback.playing").resolve(tried({}, "vrt"));
    await wait(21_000);

    expect(text()).toContain("No picture arrived");
    expect(text()).toContain("VRT 1's stream sent no picture or sound.");
    expect(text()).not.toContain("No answer");
    expect(asked()).toHaveLength(5);
  });

  it("starts afresh with Retry, on the same channel", async () => {
    let starts = nextStream();
    await watching();
    for (const delay of WAITS) {
      await starts();
      starts = nextStream();
      await stops(DROPPED);
      await wait(delay);
    }
    await starts();
    await stops(DROPPED);

    starts = nextStream();
    await press("Retry");
    expect(asked().at(-1)).toMatchObject({ channel: { subscriptionId: SUBSCRIPTION, id: "vrt" } });
    await starts();
    await stops(DROPPED);

    expect(text()).toContain("attempt 1 of 4");
  });
});

describe("a stream the provider refuses", () => {
  it("says so with its status, asks for no other quality and isn't tried again by itself", async () => {
    const starts = nextStream();
    await watching();
    await starts();
    await stops(refused(403), tried({ vrt: refused(403) }));

    expect(text()).toContain("Refused by the provider");
    expect(text()).toContain("VRT 1's stream was turned down.");
    expect(text()).toContain("If another device is watching on this subscription");
    expect(text()).toContain("HTTP 403 · Full HD");
    expect(offered()).toEqual(["Retry", "Channels"]);
    await wait(60_000);
    expect(asked()).toHaveLength(1);
  });

  it("names no other device for a playlist, which has no connection to hold", async () => {
    ipc.hold("subscription.list").resolve([
      {
        kind: "m3u",
        id: SUBSCRIPTION,
        name: null,
        server: "https://lists.example",
        username: "",
        account: {
          state: "unknown",
          expiresAt: null,
          maxConnections: null,
          activeConnections: null,
        },
        needsSecret: false,
      },
    ]);
    const starts = nextStream();
    await watching();
    await starts();
    await stops(refused(403));

    expect(text()).toContain("Refused by the provider");
    expect(text()).not.toContain("device");
    expect(text()).not.toContain("subscription");
  });

  it("says the provider limits requests when it answers 429", async () => {
    const starts = nextStream();
    await watching();
    await starts();
    await stops(refused(429));

    expect(text()).toContain("Provider is limiting requests");
    expect(text()).toContain("HTTP 429");
    expect(text()).not.toContain("device");
  });
});

describe("what a failure shows", () => {
  it("is never the provider's or an engine's own words, nor an address", async () => {
    const starts = nextStream();
    await watching();
    await starts();
    await stops({
      kind: "unsupported",
      detail:
        "The stream could not be converted. http://demo:hunter2@panel.example:8080/1.ts: Invalid data",
    });
    expect(text()).toContain("Can't play this stream");
    for (const leaked of ["hunter2", "panel.example", "Invalid data", "converted"]) {
      expect(text()).not.toContain(leaked);
    }

    // A session that doesn't open at all, with the server named in its error.
    const opened = ipc.hold("playback.open");
    await press("Watch");
    await act(async () =>
      opened.reject({
        kind: "unreachable",
        server: "http://panel.example:8080",
        detail: "getaddrinfo ENOTFOUND panel.example",
      }),
    );
    expect(text()).toContain("Can't open this channel");
    expect(text()).not.toContain("panel.example");
    expect(text()).not.toContain("ENOTFOUND");
  });

  it("says it can't play a stream that arrives and doesn't decode, after one repaired try", async () => {
    let starts = nextStream();
    await watching();
    await starts();
    starts = nextStream();
    // The provider delivered it: the player couldn't decode it.
    await stops(null);
    expect(asked().at(-1)).toMatchObject({ repair: true });
    expect(ipc.argsOf("analytics.playbackFailure")).toEqual([]);
    await starts();
    await stops(null, tried({}, "vrt"));

    expect(text()).toContain("Can't play this stream");
    expect(text()).toContain("VRT 1's stream arrived, but Mr. Streamer couldn't play it");
    // Trying the same stream again changes nothing; another quality may.
    expect(offered()).toEqual(["Quality", "Channels"]);
    expect(ipc.argsOf("analytics.playbackFailure")).toEqual([
      expect.objectContaining({
        failure: "unsupported",
        diagnostic: {
          diagnostic_stage: "decode",
          diagnostic_reason: "decode_rejected",
          diagnostic_container: "hls",
          diagnostic_delivery: "unknown",
          diagnostic_fallback: "repair",
        },
      }),
    ]);
    await wait(60_000);
    expect(asked()).toHaveLength(2);
  });

  it("offers a login update only when the provider rejected the login", async () => {
    const opened = ipc.hold("playback.open");
    await watching();
    await act(async () => opened.reject({ kind: "invalid-login" }));

    expect(text()).toContain("Login not accepted");
    expect(offered()).toEqual(["Update login", "Channels"]);
    await press("Update login");
    expect(useUi.getState()).toMatchObject({
      settings: "subscriptions",
      subscription: { id: SUBSCRIPTION, show: "edit" },
    });
  });

  it("says it waits for data once the picture stood still for three seconds", async () => {
    await playing(5);

    await wait(2000);
    expect(text()).not.toContain("Waiting for data");
    await wait(1000);
    expect(text()).toContain("Waiting for data");

    await plays(1);
    expect(text()).not.toContain("Waiting for data");

    // Fifteen seconds without any is still what counts as a broken stream.
    const failure = ipc.hold("playback.failure");
    ipc.hold("playback.playing").resolve(null);
    await wait(16_000);
    await act(async () => failure.resolve(null));
    expect(text()).toContain("Reconnecting");
    expect(text()).not.toContain("Waiting for data");
  });

  it("says it in a few words in the mini player", async () => {
    await playing(5);
    ipc.hold("window.setMiniPlayer").resolve(null);
    await act(() => miniPlayer.enter());

    let starts = nextStream();
    await stops(DROPPED);
    await wait(1000);
    await starts();
    starts = nextStream();
    await stops(DROPPED);
    expect(text()).toContain("Reconnecting · 2 of 4");

    await wait(2000);
    await starts();
    await stops(refused(403));
    expect(text()).toContain("Refused by the provider");
  });
});

describe("a quality chosen for the channel", () => {
  // The pick is the channel's subscription's.
  beforeEach(() =>
    ipc
      .hold("subscription.preferences")
      .resolve({ ...defaultSubscriptionPreferences, channelVariants: { vrt: "vrt" } }),
  );

  it("stays chosen when its stream fails, until another is picked", async () => {
    let starts = nextStream();
    await watching();
    await starts();
    await stops(noStream, tried({ vrt: noStream }));

    expect(text()).toContain("No Full HD stream");
    expect(text()).toContain("The provider sent no Full HD stream for VRT 1.");
    expect(text()).toContain("Your choice stays Full HD.");
    expect(text()).toContain("HTTP 404 · Full HD only, as chosen");
    expect(offered()).toEqual(["Retry", "HD", "Automatic"]);

    // Retry asks for the channel again and leaves the choice alone.
    starts = nextStream();
    await press("Retry");
    expect(asked()).toHaveLength(2);
    expect(ipc.methods()).not.toContain("subscription.updatePreferences");
    await starts();
    await stops(noStream, tried({ vrt: noStream }));

    await press("HD");
    expect(ipc.argsOf("subscription.updatePreferences")).toEqual([
      { subscriptionId: SUBSCRIPTION, patch: { channelVariants: { vrt: "vrt-hd" } } },
    ]);
  });

  it("is offered no other quality for a refusal, as nothing shows one would play", async () => {
    const starts = nextStream();
    await watching();
    await starts();
    await stops(refused(403), tried({ vrt: refused(403) }));

    expect(text()).toContain("Refused by the provider");
    expect(offered()).toEqual(["Retry", "Channels"]);
    expect(ipc.methods()).not.toContain("subscription.updatePreferences");
  });
});

describe("what a failed channel offers", () => {
  /** Watch on a channel whose three qualities the provider has no stream for. */
  async function failed(): Promise<void> {
    ipc.hold("library.channels").resolve([vrt, een]);
    const starts = nextStream();
    await watching();
    await starts();
    await stops(noStream, tried({ vrt: noStream, "vrt-hd": noStream }));
    expect(text()).toContain("No stream right now");
  }

  it("opens the quality menu with what became of each stream, and starts nothing", async () => {
    await failed();
    expect(offered()).toEqual(["Retry", "Quality", "Channels"]);

    await press("Quality");

    const rows = [...document.querySelectorAll("[data-item]")].map((each) => each.textContent);
    expect(rows).toContain("Full HDNo stream · 404");
    expect(rows).toContain("HDNo stream · 404");
    expect(rows).toContain("SDNot tried");
    expect(asked()).toHaveLength(1);
  });

  it("opens the channel list with Channels, and changes channel only when asked", async () => {
    await failed();

    await press("Channels");
    expect(useUi.getState().channelsOpen).toBe(true);
    await wait(60_000);
    expect(asked()).toHaveLength(1);
    expect(player.state().channel?.id).toBe("vrt");
  });

  it("tries again with R, only once it failed and not while typing or in a menu", async () => {
    await playing(5);
    await key("r");
    expect(asked()).toHaveLength(1);

    await stops(refused(403));
    const field = container.appendChild(document.createElement("input"));
    await key("r", field);
    expect(asked()).toHaveLength(1);
    await key("q");
    await key("r");
    expect(asked()).toHaveLength(1);
    await key("Escape", document.querySelector("[data-item]") ?? window);
    await wait(500);

    expect(await key("r")).toBe(true);
    expect(asked()).toHaveLength(2);
    expect(asked().at(-1)).toMatchObject({ channel: { subscriptionId: SUBSCRIPTION, id: "vrt" } });
  });

  it("presses what Tab reached with Enter, and keeps Enter and the arrows for channels", async () => {
    await failed();

    // Enter on Retry is the button's own, not the list's.
    button("Retry").focus();
    expect(await key("Enter", button("Retry"))).toBe(false);
    expect(useUi.getState().channelsOpen).toBe(false);

    // Down still goes to the next channel, which is the only thing that changes it.
    const starts = nextStream();
    await key("ArrowDown");
    await wait(400);
    expect(asked().at(-1)).toMatchObject({ channel: { subscriptionId: SUBSCRIPTION, id: "een" } });
    await starts();

    expect(await key("Enter")).toBe(true);
    expect(useUi.getState().channelsOpen).toBe(true);
  });
});

describe("a failure's message", () => {
  /** What the picture area says, in the window or the mini player. */
  const message = () =>
    [...container.querySelectorAll("[data-playback-state]")].map((each) => each.textContent).join();

  /** Watch on a channel the provider refused, and its message on screen. */
  async function refusedOnce(): Promise<void> {
    const starts = nextStream();
    await watching();
    await starts();
    await stops(refused(403));
    expect(message()).toContain("Refused by the provider");
  }

  it("closes with its cross, stays closed, and the next failure says its own", async () => {
    await refusedOnce();

    await press("Close message");
    expect(message()).toBe("");
    // Still failed: nothing says it plays, and nothing is asked for by itself.
    expect(player.state().phase.kind).toBe("failed");
    expect(button("Watch")).toBeDefined();
    // The controls waking draws the view again; the message stays closed.
    await act(async () => {
      container.firstElementChild?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    await wait(5000);
    expect(message()).toBe("");
    expect(asked()).toHaveLength(1);

    const starts = nextStream();
    expect(await key("r")).toBe(true);
    await starts();
    await stops(refused(403));
    expect(message()).toContain("Refused by the provider");
  });

  it.each(["Enter", " "])(
    "hands focus to Watch when closed from the keyboard, and %j is the cross's own",
    async (name) => {
      await refusedOnce();
      const close = button("Close message");
      close.focus();
      // Not taken as a shortcut, so the focused button presses itself.
      expect(await key(name, close)).toBe(false);
      expect(useUi.getState().channelsOpen).toBe(false);

      await act(async () => close.click());
      expect(message()).toBe("");
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Watch");
      expect(asked()).toHaveLength(1);
    },
  );

  it("closes in the mini player too", async () => {
    await playing(5);
    ipc.hold("window.setMiniPlayer").resolve(null);
    await act(() => miniPlayer.enter());
    await stops(refused(403));
    expect(message()).toContain("Refused by the provider");

    await press("Close message");
    expect(message()).toBe("");
    expect(player.state().phase.kind).toBe("failed");
  });
});

describe("a wait for the next reconnect", () => {
  /** Watch on a channel that played, broke off and waits two seconds for its second reconnect. */
  async function waitingToReconnect(): Promise<void> {
    await playing(5);
    let starts = nextStream();
    await stops(DROPPED);
    await wait(1000);
    await starts();
    starts = nextStream();
    await stops(DROPPED);
    expect(text()).toContain("attempt 2 of 4");
    // Nothing answers the reconnect that may still come.
    void starts;
  }

  it("ends with Stop", async () => {
    await waitingToReconnect();
    expect(offered()).toEqual(["Stop", "Channels"]);

    await press("Stop");
    await wait(60_000);

    expect(asked()).toHaveLength(2);
    expect(player.state()).toMatchObject({ phase: { kind: "idle" }, stopped: true });
  });

  it("ends with another channel, which is the only one asked for", async () => {
    await waitingToReconnect();

    await act(async () => player.zap(een));
    await wait(60_000);

    expect(asked().map(({ channel }) => channel.id)).toEqual(["vrt", "vrt", "een"]);
  });

  it("ends when the viewer leaves Watch, where what is left is a preview", async () => {
    await waitingToReconnect();

    await act(async () => player.setAudible(false));
    await wait(60_000);

    expect(asked()).toHaveLength(2);
    expect(player.state().phase).toMatchObject({ kind: "failed", problem: { kind: "network" } });
  });

  it("isn't begun by an answer that comes after the viewer stopped", async () => {
    await playing(5);
    const failure = ipc.hold("playback.failure");
    const session = ipc.hold("playback.playing");
    await act(async () => {
      player.element.dispatchEvent(new Event("error"));
    });

    await act(async () => player.stop());
    await act(async () => {
      failure.resolve(DROPPED);
      session.resolve(null);
    });
    await wait(60_000);

    expect(asked()).toHaveLength(1);
    expect(player.state().phase).toEqual({ kind: "idle" });
  });
});
