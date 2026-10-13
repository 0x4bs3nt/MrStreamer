// @vitest-environment happy-dom
// Settings > General shows the languages as last saved, though a player saved them since the UI
// last read the preferences, as picking a sound or subtitle track does.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import { openOnlineSubtitleSettings, useUi } from "../../src/renderer/src/app/ui-store.ts";
import { GeneralSection } from "../../src/renderer/src/features/settings/GeneralSection.tsx";

let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
});

describe("Settings > General", () => {
  it("shows the languages saved since the UI last read them", async () => {
    ipc.reset();
    const client = new QueryClient();
    // What the UI read before: Español. The main process now holds the defaults, as after a pick.
    client.setQueryData(["preferences"], { ...defaultPreferences, audioLanguage: "es" });
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(createElement(QueryClientProvider, { client }, createElement(GeneralSection))),
    );
    unmount = () => act(() => root.unmount());
    await act(() => vi.advanceTimersByTimeAsync(20));

    const audio = container.querySelector<HTMLSelectElement>('select[aria-label="Audio in"]');
    expect(audio?.value).toBe("en");
  });

  it("comes into view on Online subtitles when a title's CC panel opened it, once", async () => {
    ipc.reset();
    ipc.always("subtitles.settings", {
      enabled: false,
      service: "both",
      languages: ["en"],
      configured: { subdl: false, opensubtitles: false },
    });
    const shown: (string | null)[] = [];
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (
      this: HTMLElement,
    ) {
      shown.push(this.querySelector("h2")?.textContent ?? null);
    });
    openOnlineSubtitleSettings();
    expect(useUi.getState().settings).toBe("general");
    const render = async () => {
      const container = document.createElement("div");
      const root = createRoot(container);
      await act(async () =>
        root.render(
          createElement(
            QueryClientProvider,
            { client: new QueryClient() },
            createElement(GeneralSection),
          ),
        ),
      );
      await act(() => vi.advanceTimersByTimeAsync(20));
      return () => act(() => root.unmount());
    };
    const close = await render();
    expect(shown).toEqual(["Online subtitles"]);
    close();
    // Opened the usual way afterwards, General starts at its top.
    unmount = await render();
    expect(shown).toEqual(["Online subtitles"]);
    useUi.setState({ settings: null });
    vi.restoreAllMocks();
  });
});
