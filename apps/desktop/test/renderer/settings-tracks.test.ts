// @vitest-environment happy-dom
// Settings > Playback shows the languages as last saved, though a player saved them since the UI
// last read the preferences, as picking a sound or subtitle track does.
import { ipc } from "./support.ts";
import { acceptPreferences, syncPreferences } from "../../src/renderer/src/lib/preferences.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import { PlaybackSection } from "../../src/renderer/src/features/settings/GeneralSection.tsx";

let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
});

describe("Settings > Playback", () => {
  it("shows a player language snapshot when Settings opens, without another read", async () => {
    ipc.reset();
    const client = new QueryClient();
    const detach = syncPreferences(client, () => {});
    acceptPreferences(client, {
      revision: 0,
      preferences: { ...defaultPreferences, audioLanguage: "es" },
    });
    ipc.emit("preferences.changed", { revision: 1, preferences: defaultPreferences });
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(createElement(QueryClientProvider, { client }, createElement(PlaybackSection))),
    );
    unmount = () => {
      detach();
      act(() => root.unmount());
    };
    await act(() => vi.advanceTimersByTimeAsync(20));

    const audio = container.querySelector<HTMLSelectElement>('select[aria-label="Audio in"]');
    expect(audio?.value).toBe("en");
    expect(ipc.argsOf("preferences.get")).toEqual([]);
  });

  it("saves custom seconds and Instant separately from autoplay, retaining the acknowledged delay on failure", async () => {
    ipc.reset();
    ipc.prefer({ nextEpisodeDelaySeconds: 10 });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(PlaybackSection),
        ),
      ),
    );
    unmount = () =>
      act(() => {
        root.unmount();
        container.remove();
      });
    await act(() => vi.advanceTimersByTimeAsync(20));
    const field = () =>
      container.querySelector<HTMLInputElement>('[aria-label="Next episode delay"]')!;
    const enter = async (value: string) => {
      await act(async () => {
        field().focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          field(),
          value,
        );
        field().dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => field().blur());
      await act(() => vi.advanceTimersByTimeAsync(20));
    };
    const saving = ipc.hold("preferences.update");
    await enter("37");
    expect(ipc.argsOf("preferences.update")).toEqual([{ nextEpisodeDelaySeconds: 37 }]);
    await act(async () =>
      saving.resolve(ipc.snapshot({ ...defaultPreferences, nextEpisodeDelaySeconds: 37 })),
    );
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(field().value).toBe("37");
    const failed = ipc.hold("preferences.update");
    await enter("60");
    await act(async () => failed.reject({ kind: "unexpected", detail: "write failed" }));
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(field().value).toBe("37");
    await enter("");
    expect(ipc.argsOf("preferences.update")).toHaveLength(2);
    const instant = ipc.hold("preferences.update");
    await enter("0");
    await act(async () =>
      instant.resolve(ipc.snapshot({ ...defaultPreferences, nextEpisodeDelaySeconds: 0 })),
    );
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(field().value).toBe("0");
    expect(container.textContent).toContain("Instant");
    expect(ipc.argsOf("preferences.update").at(-1)).toEqual({ nextEpisodeDelaySeconds: 0 });
  });
});
