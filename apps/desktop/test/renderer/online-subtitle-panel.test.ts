// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedSubtitle } from "@mrstreamer/contracts/online-subtitles";
import type { SubtitleTrack } from "@mrstreamer/contracts/playback";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { SubtitlePanel } from "../../src/renderer/src/features/titles/SubtitlePanel.tsx";
import { onlineSubtitles } from "../../src/renderer/src/player/online-subtitles.ts";
import { player } from "../../src/renderer/src/player/player.ts";
import { setSubtitleDelay, subtitleDelay } from "../../src/renderer/src/player/subtitles.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

const saved: SavedSubtitle = {
  timing: { offset: 0, speed: 1 },
  selection: "opaque-result",
  subtitle: {
    service: "subdl",
    language: "en",
    release: "Night.Harbour.Cinema",
    cues: [{ start: 1, end: 3, text: "Hello." }],
  },
};
const results = [
  {
    id: "first-result",
    service: "subdl" as const,
    language: "en",
    release: "Night.Harbour.Cinema",
    hearingImpaired: true,
    downloads: 12,
  },
  {
    id: "second-result",
    service: "opensubtitles" as const,
    language: "en",
    release: "Night.Harbour.TV",
    hearingImpaired: false,
    downloads: null,
  },
];
const english: SubtitleTrack = {
  id: 3,
  page: null,
  format: "text",
  language: "en",
  label: "English",
  forced: false,
  default: false,
};
let root: Root | null = null;
let container: HTMLDivElement | null = null;
/** Lets the panel, the player and React Query catch up, on the fake clock every test runs on. */
const settle = () => vi.advanceTimersByTimeAsync(20);
function offered(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (each) => each.textContent?.includes(text) || each.getAttribute("aria-label") === text,
  );
}
function button(text: string) {
  const found = offered(text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function press(key: string, target: Element = document.activeElement ?? document.body) {
  await act(async () => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    // happy-dom does not perform a button's native Enter activation.
    if (key === "Enter" && !event.defaultPrevented && target instanceof HTMLButtonElement)
      target.click();
    await settle();
  });
}
async function opened(tracks: readonly SubtitleTrack[] = []) {
  ipc.reset();
  onlineSubtitles.bind(null);
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream()));
  ipc.always("subtitles.saved", null);
  ipc.always("subtitles.settings", {
    enabled: true,
    service: "both",
    languages: ["en"],
    configured: { subdl: true, opensubtitles: true },
  });
  ipc.always("subtitles.search", { results, failures: [] });
  ipc.always("subtitles.choose", {
    saved,
    quota: { service: "opensubtitles", remaining: 3, resetAt: "tomorrow" },
  });
  ipc.always("subtitles.cancel", null);
  ipc.always("subtitles.show", null);
  ipc.always("subtitles.hide", null);
  ipc.always("playback.openTitle", {
    sessionId: "movie",
    title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "4k" },
    url: "http://127.0.0.1/title/movie.mp4",
    duration: 600,
    audio: [],
    subtitles: tracks,
  });
  void titlePlayer.open(
    {
      kind: "provider",
      title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "4k" },
      name: "Night Harbour",
      detail: null,
      artworkUrl: null,
      originalLanguage: null,
    },
    0,
  );
  await settle();
}
async function render(node: ReturnType<typeof createElement>) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(createElement(QueryClientProvider, { client }, node));
    await settle();
  });
  await act(async () => {
    await settle();
  });
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  onlineSubtitles.bind(null);
  titlePlayer.close();
  setSubtitleDelay(player.element, 0);
  useUi.setState({ settings: null, onlineSubtitles: false });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("subtitle choices while the picture plays", () => {
  it("does not search on open, shows complete results, keeps the panel after choosing and cancels a pending request on close", async () => {
    await opened();
    const closed = vi.fn();
    await render(createElement(SubtitlePanel, { open: true, onClose: closed }));
    expect(ipc.argsOf("subtitles.search")).toHaveLength(0);
    await act(async () => {
      button("Search subtitles").click();
      await settle();
    });
    expect(container?.textContent).toContain("Hearing impaired");
    expect(container?.textContent).toContain("12 downloads");
    await act(async () => {
      button("Night.Harbour.Cinema").click();
      await settle();
    });
    expect(titlePlayer.state().downloadedOn).toBe(true);
    expect(container?.querySelector("aside")).not.toBeNull();
    expect(container?.textContent).toContain("3 service downloads remain");
    const held = ipc.hold("subtitles.search");
    await act(async () => {
      button("Search again").click();
      await settle();
    });
    expect(container?.textContent).toContain("Searching");
    await act(async () =>
      root!.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(SubtitlePanel, { open: false, onClose: closed }),
        ),
      ),
    );
    expect(ipc.argsOf("subtitles.cancel").length).toBeGreaterThan(0);
    held.resolve({ results, failures: [] });
  });
  it("lets typed timing fields own edit keys and offers all six drift presets", async () => {
    await opened();
    titlePlayer.acceptDownloaded("movie", saved);
    await render(createElement(SubtitlePanel, { open: true, onClose: () => {} }));
    // Drift and the frame rates are one row down.
    expect(container!.querySelector("#subtitle-speed")).toBeNull();
    await act(async () => button("Drift and frame rate").click());
    const field = container!.querySelector<HTMLInputElement>("#subtitle-offset")!;
    expect(field).not.toBeNull();
    await act(async () => field.focus());
    for (const key of ["Backspace", "ArrowLeft", "ArrowUp", "Home"]) {
      field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      expect(document.activeElement).toBe(field);
      expect(container?.querySelector("#subtitle-offset")).not.toBeNull();
    }
    ipc.always("subtitles.timing", { ...saved, timing: { offset: -2.5, speed: 1 } });
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    for (const text of ["", "-", "-2", "-2.", "-2.5"]) {
      await act(async () => {
        setValue.call(field, text);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(field.value).toBe(text);
    }
    await act(async () => field.blur());
    expect(field.value).toBe("-2.5");
    expect(ipc.argsOf("subtitles.timing").at(-1)?.timing.offset).toBe(-2.5);
    expect(
      [...container!.querySelectorAll("button")].filter((each) =>
        each.textContent?.includes(" fps"),
      ),
    ).toHaveLength(6);

    // A preset stores its exact ratio. The field reads it rounded, and reading it changes nothing.
    const drift = container!.querySelector<HTMLInputElement>("#subtitle-speed")!;
    await act(async () => {
      button("25 → 23.976 fps").click();
      await settle();
    });
    expect(ipc.argsOf("subtitles.timing").at(-1)?.timing.speed).toBe(25 / 23.976);
    expect(drift.value).toBe("1.04271");
    const writes = ipc.argsOf("subtitles.timing").length;
    await act(async () => drift.focus());
    expect(drift.value).toBe("1.04271");
    await act(async () => drift.blur());
    expect(ipc.argsOf("subtitles.timing")).toHaveLength(writes);
    expect(titlePlayer.state().savedSubtitle?.timing.speed).toBe(25 / 23.976);
    await act(async () => drift.focus());
    for (const text of ["1.0", "1.", "1.04"]) {
      await act(async () => {
        setValue.call(drift, text);
        drift.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(drift.value).toBe(text);
    }
    expect(ipc.argsOf("subtitles.timing").at(-1)?.timing.speed).toBe(1.04);
  });

  it("opens on the saved result, walks the timing in reading order with Down, and leaves drift alone", async () => {
    await opened();
    titlePlayer.acceptDownloaded("movie", saved);
    ipc.always("subtitles.timing", saved);
    await render(createElement(SubtitlePanel, { open: true, onClose: () => {} }));
    expect(document.activeElement?.textContent).toContain("Saved for this version");
    const walked: string[] = [];
    for (let step = 0; step < 10; step++) {
      await press("ArrowDown");
      const at = document.activeElement;
      walked.push(at?.getAttribute("aria-label") ?? at?.textContent ?? "");
    }
    expect(walked).toEqual([
      "Forget downloaded subtitles",
      "Reset",
      "-1 s",
      "-0.1 s",
      "+0.1 s",
      "+1 s",
      "Drift and frame rate1.00000",
      "Medium",
      "Box",
      "Low",
    ]);
    await act(async () => button("-1 s").focus());
    expect(ipc.argsOf("subtitles.timing")).toEqual([]);
    await press("Enter");
    expect(ipc.argsOf("subtitles.timing").map(({ timing }) => timing)).toEqual([
      { offset: -1, speed: 1 },
    ]);
    expect(container?.textContent).toContain("−1.0 s");
    expect(titlePlayer.state().savedSubtitle?.timing).toEqual({ offset: -1, speed: 1 });
    // A step beside a field being typed in: the field reads what the step set.
    const field = container!.querySelector<HTMLInputElement>("#subtitle-offset")!;
    await act(async () => field.focus());
    await act(async () => {
      button("+0.1 s").click();
      await settle();
    });
    expect(field.value).toBe("-0.9");
    await act(async () => {
      button("Reset").click();
      await settle();
    });
    expect(titlePlayer.state().savedSubtitle?.timing).toEqual({ offset: 0, speed: 1 });
  });

  it("times a file's own track and sets the look, each shown only for what takes it", async () => {
    await opened([english]);
    await render(createElement(SubtitlePanel, { open: true, onClose: () => {} }));
    // Off: no timing, and the look of what the file could show.
    expect(offered("Later")).toBeUndefined();
    expect(offered("Large")).toBeDefined();
    await act(async () => {
      button("English").click();
      await settle();
    });
    expect(button("Reset").disabled).toBe(true);
    await act(async () => button("Later").click());
    await act(async () => button("Later").click());
    expect(subtitleDelay()).toBe(0.2);
    expect(container?.textContent).toContain("+0.2 s");
    await act(async () => button("Earlier").click());
    expect(subtitleDelay()).toBe(0.1);
    await act(async () => button("Reset").click());
    expect(subtitleDelay()).toBe(0);
    // A file track has no drift to set.
    expect(offered("Drift and frame rate")).toBeUndefined();

    await act(async () => button("Large").click());
    await act(async () => button("Shadow").click());
    await act(async () => button("Higher").click());
    expect(ipc.argsOf("preferences.update").at(-1)).toEqual({
      subtitleLook: { size: "large", background: "shadow", position: "high" },
    });
    await press("ArrowLeft", button("Higher"));
    expect(button("Low").getAttribute("aria-checked")).toBe("true");
    expect(titlePlayer.state().subtitle).toEqual(english);
    await act(async () => button("Medium").click());
    await act(async () => button("Box").click());
  });

  it("offers nothing to time or style for a file with no subtitles, until a download shows", async () => {
    await opened();
    await render(createElement(SubtitlePanel, { open: true, onClose: () => {} }));
    expect(offered("Large")).toBeUndefined();
    expect(offered("-1 s")).toBeUndefined();
    await act(async () => {
      titlePlayer.acceptDownloaded("movie", saved);
      await settle();
    });
    expect(offered("-1 s")).toBeDefined();
    expect(offered("Shadow")).toBeDefined();
  });

  it("tries the next result from beside the results, and forgets the downloads", async () => {
    await opened();
    ipc.always("subtitles.forget", null);
    await render(createElement(SubtitlePanel, { open: true, onClose: () => {} }));
    await act(async () => {
      button("Search subtitles").click();
      await settle();
    });
    // Nothing downloaded shows yet, so there is no result to step from.
    expect(offered("Try the next result")).toBeUndefined();
    await act(async () => {
      button("Night.Harbour.Cinema").click();
      await settle();
    });
    await act(async () => {
      button("Try the next result").click();
      await settle();
    });
    expect(ipc.argsOf("subtitles.choose").map(({ resultId }) => resultId)).toEqual([
      "first-result",
      "second-result",
    ]);
    await act(async () => {
      button("Forget downloaded subtitles").click();
      await settle();
    });
    expect(ipc.argsOf("subtitles.forget")).toEqual([{ sessionId: "movie" }]);
    expect(container?.textContent).not.toContain("Saved for this version");
    expect(offered("-1 s")).toBeUndefined();
  });

  it("closes on Escape from anywhere, also once a picked result took focus out of the panel", async () => {
    await opened();
    const closed = vi.fn();
    await render(createElement(SubtitlePanel, { open: true, onClose: closed }));
    await act(async () => {
      button("Search subtitles").click();
      await settle();
    });
    // A pointer pick: the result goes disabled while it downloads and focus falls to the page.
    const held = ipc.hold("subtitles.choose");
    await act(async () => {
      button("Night.Harbour.TV").click();
      await vi.waitFor(() => expect(ipc.argsOf("subtitles.choose")).toHaveLength(1));
    });
    await act(async () => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    expect(container?.querySelector("aside")?.contains(document.activeElement)).toBe(false);
    await press("Escape", document.body);
    expect(closed).toHaveBeenCalledTimes(1);
    held.resolve({ saved, quota: null });
    await act(async () => {
      await settle();
    });

    // From a field too, and from a row.
    const field = container!.querySelector<HTMLInputElement>("#subtitle-offset")!;
    await act(async () => field.focus());
    await press("Escape");
    await act(async () => button("Off").focus());
    await press("Escape");
    expect(closed).toHaveBeenCalledTimes(3);

    // Settings over the title keeps its own Escape.
    await act(async () => useUi.setState({ settings: "general" }));
    await press("Escape", document.body);
    expect(closed).toHaveBeenCalledTimes(3);
  });

  it("moves focus into the panel when it opens and hands it back when it closes", async () => {
    await opened([english]);
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    await render(createElement(SubtitlePanel, { open: true, onClose: () => {} }));
    expect(document.activeElement?.textContent).toBe("Off");
    const field = () => container!.querySelector<HTMLSelectElement>("select")!;
    await act(async () => field().focus());
    await act(async () =>
      root!.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(SubtitlePanel, { open: false, onClose: () => {} }),
        ),
      ),
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("opens Settings on Online subtitles from its link, which is all there is while search is off", async () => {
    await opened();
    ipc.always("subtitles.settings", {
      enabled: false,
      service: "both",
      languages: ["en"],
      configured: { subdl: false, opensubtitles: false },
    });
    const closed = vi.fn();
    await render(createElement(SubtitlePanel, { open: true, onClose: closed }));
    expect(offered("Search subtitles")).toBeUndefined();
    expect(container?.querySelector("select")).toBeNull();
    await act(async () => button("Settings").click());
    expect(closed).toHaveBeenCalledTimes(1);
    expect(useUi.getState()).toMatchObject({
      settings: "subtitles",
      settingsTarget: "online-subtitles",
      onlineSubtitles: true,
    });
  });

  it("names the region of a result's language, and takes a replaced file's saved result away", async () => {
    await opened();
    ipc.always("subtitles.search", {
      results: [
        { ...results[1]!, id: "brazil", language: "pt-BR", release: "Harbour.BR" },
        { ...results[1]!, id: "portugal", language: "pt-PT", release: "Harbour.PT" },
      ],
      failures: [],
    });
    titlePlayer.acceptDownloaded("movie", {
      ...saved,
      subtitle: { ...saved.subtitle!, language: "pt-BR" },
    });
    await render(createElement(SubtitlePanel, { open: true, onClose: () => {} }));
    await act(async () => {
      button("Search subtitles").click();
      await settle();
    });
    expect(button("Harbour.BR").textContent).toContain("Português (Brasil)");
    expect(button("Harbour.PT").textContent).toContain("Português (Portugal)");
    expect(button("Night.Harbour.Cinema").textContent).toContain(
      "Português (Brasil) · Saved for this version",
    );

    await act(async () => {
      ipc.emit("playback.fileReplaced", { sessionId: "movie" });
      await settle();
    });
    expect(container?.textContent).not.toContain("Saved for this version");
    expect(container?.textContent).not.toContain("Harbour.BR");
    expect(button("Search subtitles").disabled).toBe(true);
    expect(button("Off").getAttribute("aria-pressed")).toBe("true");
  });

  it.each(["Cancel", "closing the panel"] as const)(
    "tells main what still shows after %s ends a download main may have saved",
    async (how) => {
      await opened();
      titlePlayer.acceptDownloaded("movie", saved);
      const panel = (open: boolean) =>
        createElement(
          QueryClientProvider,
          { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          createElement(SubtitlePanel, { open, onClose: () => {} }),
        );
      await render(createElement(SubtitlePanel, { open: true, onClose: () => {} }));
      await act(async () => {
        button("Search subtitles").click();
        await settle();
      });
      const held = ipc.hold("subtitles.choose");
      await act(async () => {
        button("Night.Harbour.TV").click();
        await vi.waitFor(() => expect(ipc.argsOf("subtitles.choose")).toHaveLength(1));
      });
      await act(async () => {
        if (how === "Cancel") button("Cancel").click();
        else root!.render(panel(false));
        await settle();
      });
      await titlePlayer.downloadedEditsSaved();
      const told = ipc.methods().filter((method) => /^subtitles\.(cancel|show|hide)$/.test(method));
      expect(told).toEqual(["subtitles.cancel", "subtitles.show"]);
      expect(ipc.argsOf("subtitles.show")).toEqual([
        { sessionId: "movie", selection: "opaque-result" },
      ]);
      held.resolve({ saved: { ...saved, selection: "late-result" }, quota: null });
      await act(async () => {
        await settle();
      });
      expect(titlePlayer.state().savedSubtitle).toEqual(saved);
    },
  );

  it.each(
    (["Off", "file track", "C off", "C without a track", "saved result"] as const).flatMap(
      (choice) => (["success", "failure"] as const).map((reply) => ({ choice, reply })),
    ),
  )("keeps $choice when a pending download returns $reply", async ({ choice, reply }) => {
    await opened(choice === "C without a track" ? [] : [english]);
    if (choice === "C off" || choice === "saved result")
      titlePlayer.acceptDownloaded("movie", saved);
    await render(createElement(SubtitlePanel, { open: true, onClose: () => {} }));
    await act(async () => {
      button("Search subtitles").click();
      await settle();
    });
    const held = ipc.hold("subtitles.choose");
    await act(async () => {
      button("Night.Harbour.TV").click();
      await vi.waitFor(() => expect(ipc.argsOf("subtitles.choose")).toHaveLength(1));
    });
    await act(async () => {
      if (choice === "Off") button("Off").click();
      else if (choice === "file track") button("English").click();
      else if (choice === "saved result") button("Night.Harbour.Cinema").click();
      else titlePlayer.toggleSubtitles();
    });
    await act(async () => {
      if (reply === "success")
        held.resolve({
          saved: { ...saved, subtitle: { ...saved.subtitle!, release: "Late release" } },
          quota: { service: "opensubtitles", remaining: 3, resetAt: null },
        });
      else held.reject({ kind: "unexpected", detail: "The download was cancelled." });
      await settle();
    });
    expect(titlePlayer.state().downloadedOn).toBe(choice === "saved result");
    expect(titlePlayer.state().subtitle).toEqual(choice === "file track" ? english : null);
    expect(titlePlayer.state().savedSubtitle).toEqual(
      choice === "C off" || choice === "saved result" ? saved : null,
    );
    expect(container?.querySelector('[role="alert"]')).toBeNull();
    expect(ipc.argsOf("subtitles.cancel")).toEqual([{ sessionId: "movie" }]);
    // Main may have saved the download before the cancel reached it, so it hears the choice that
    // stands, after the cancel: the held saved result by its key, or that nothing of it shows.
    await titlePlayer.downloadedEditsSaved();
    const told = ipc
      .methods()
      .filter((method) => /^subtitles\.(cancel|show|hide|timing)$/.test(method));
    if (choice === "saved result") {
      ipc.always("subtitles.timing", saved);
      await titlePlayer.setDownloadedTiming({ offset: 1, speed: 25 / 23.976 });
      expect(told).toEqual(["subtitles.cancel", "subtitles.show"]);
      expect(ipc.argsOf("subtitles.show")).toEqual([
        { sessionId: "movie", selection: "opaque-result" },
      ]);
      expect(ipc.argsOf("subtitles.timing")).toEqual([
        {
          sessionId: "movie",
          timing: { offset: 1, speed: 25 / 23.976 },
          selection: "opaque-result",
        },
      ]);
    } else {
      expect(told).toEqual(["subtitles.cancel", "subtitles.hide"]);
      expect(ipc.argsOf("subtitles.hide")).toEqual([{ sessionId: "movie" }]);
    }
    expect(container?.textContent).not.toContain("Downloading");
    expect(container?.textContent).not.toContain("Late release");
    expect(container?.textContent).not.toContain("3 service downloads remain");
    // With nothing saved held yet, Off or a file track is the viewer's language for other titles
    // too. Turning a held saved result off is this file's alone.
    expect(ipc.argsOf("preferences.update")).toEqual(
      choice === "Off"
        ? [{ subtitleLanguage: "off" }]
        : choice === "file track"
          ? [{ subtitleLanguage: "en" }]
          : [],
    );
    expect(ipc.argsOf("output.command")).toEqual([]);
  });
});
