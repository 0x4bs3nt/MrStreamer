// @vitest-environment happy-dom
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultPreferences,
  defaultSubscriptionPreferences,
} from "@mrstreamer/contracts/preferences";
import { setLanguage } from "@mrstreamer/core/i18n";
import { acceptPreferences } from "../../src/renderer/src/lib/preferences.ts";
import { openOnlineSubtitleSettings, useUi } from "../../src/renderer/src/app/ui-store.ts";
import { SettingsPage } from "../../src/renderer/src/features/settings/SettingsPage.tsx";
import { LiveSettingsSection } from "../../src/renderer/src/features/settings/GeneralSection.tsx";
import { OnlineSubtitlesSection } from "../../src/renderer/src/features/settings/OnlineSubtitlesSection.tsx";
import { findSettings } from "../../src/renderer/src/features/settings/catalogue.ts";

let cleanup = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  ipc.reset();
  useUi.setState({ settings: "general", settingsTarget: null, onlineSubtitles: false });
  vi.stubGlobal("__BUILD_COMMIT__", "abcdef");
  ipc.always("language.get", {
    choice: "system",
    locale: "en-US",
    system: "en-US",
    formats: "en-US",
  });
});
afterEach(() => {
  cleanup();
  setLanguage({ locale: "en-US", formats: "en-US" });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const settle = () => act(() => vi.advanceTimersByTimeAsync(20));
async function render(component = createElement(SettingsPage)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = document.createElement("div");
  document.body.append(view);
  const root = createRoot(view);
  await act(async () => root.render(createElement(QueryClientProvider, { client }, component)));
  await settle();
  cleanup = () => {
    act(() => root.unmount());
    client.clear();
    view.remove();
  };
  return { view, client };
}
async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
async function nav(view: HTMLElement, label: string) {
  await act(async () =>
    [...view.querySelectorAll<HTMLButtonElement>("nav button")]
      .find((b) => b.textContent === label)!
      .click(),
  );
  await settle();
}

it.each([
  ["en-US", "countdown"],
  ["nl-NL", "aftellen"],
  ["fr-FR", "compte à rebours"],
  ["de-DE", "Sekunden"],
  ["es-ES", "cuenta atras"],
] as const)("finds the delay through a translated synonym in %s", (locale, word) => {
  setLanguage({ locale, formats: locale });
  expect(findSettings(word).some((control) => control.id === "delay")).toBe(true);
});

it("search focuses the real control, preserves an independent draft and recovers from no results", async () => {
  const { view, client } = await render();
  const search = view.querySelector<HTMLInputElement>('[aria-label="Find a setting"]')!;
  await type(search, "countdown");
  await act(async () =>
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  await settle();
  const delay = view.querySelector<HTMLInputElement>('[aria-label="Next episode delay"]')!;
  expect(document.activeElement).toBe(delay);
  await type(delay, "43");
  await act(async () =>
    acceptPreferences(client, ipc.snapshot({ ...defaultPreferences, audioLanguage: "fr" })),
  );
  await settle();
  expect(delay.value).toBe("43");
  await nav(view, "Movies and series");
  const ownKey = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Own key…",
  )!;
  await act(async () => ownKey.click());
  const key = view.querySelector<HTMLInputElement>('[aria-label="Your own TMDB key"]')!;
  await type(key, "draft-key");
  await nav(view, "Playback");
  await nav(view, "Movies and series");
  expect(key.value).toBe("draft-key");
  await type(search, "zzzz-no-setting");
  expect(view.textContent).toContain("No settings found");
  await act(async () =>
    [...view.querySelectorAll<HTMLButtonElement>("nav button")]
      .find((b) => b.textContent === "Clear search")!
      .click(),
  );
  expect(search.value).toBe("");
  expect(document.activeElement).toBe(search);
});

it("keeps the online subtitles opener as a focused destination", async () => {
  ipc.always("subtitles.settings", {
    enabled: false,
    service: "both",
    languages: ["en"],
    configured: { subdl: false, opensubtitles: false },
  });
  openOnlineSubtitleSettings();
  const { view } = await render();
  expect(useUi.getState().settings).toBe("subtitles");
  expect(document.activeElement).toBe(view.querySelector('[aria-label="Online subtitle search"]'));
  expect(useUi.getState().onlineSubtitles).toBe(false);
});

it("keeps acknowledged quality after a failed reset and retries only at that row", async () => {
  ipc.always("subscription.list", [SAVED]);
  ipc.always("subscription.preferences", {
    ...defaultSubscriptionPreferences,
    channelVariants: { a: "hd" },
  });
  const failed = ipc.hold("subscription.updatePreferences");
  const { view } = await render(createElement(LiveSettingsSection));
  const reset = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Reset",
  )!;
  await act(async () => reset.click());
  await settle();
  await act(async () => failed.reject({ kind: "unexpected", detail: "reset failed" }));
  await settle();
  expect(view.textContent).toContain("reset failed");
  expect(view.querySelector('[data-setting="own-quality"]')?.textContent).toContain("1");
  ipc.always("subscription.updatePreferences", defaultSubscriptionPreferences);
  await act(async () =>
    [...view.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Try again")!
      .click(),
  );
  await settle();
  expect(ipc.argsOf("subscription.updatePreferences")).toEqual(
    Array.from({ length: 2 }, () => ({
      subscriptionId: SUBSCRIPTION,
      patch: { channelVariants: {} },
    })),
  );
  expect(view.textContent).not.toContain("reset failed");
});

it.each(["", "quality"])("recovers a preference read failure with search %j", async (query) => {
  ipc.refuse("preferences.get", { kind: "unexpected", detail: "read failed" });
  const { view } = await render();
  expect(view.textContent).toContain("Settings could not be read.");
  const search = view.querySelector<HTMLInputElement>('[aria-label="Find a setting"]')!;
  if (query) await type(search, query);
  ipc.always("preferences.get", ipc.snapshot(defaultPreferences));
  const read = ipc.hold("preferences.get");
  const retry = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Try again",
  )!;
  const current = query ? search : view.querySelector('nav button[aria-current="page"]');
  await act(async () => {
    retry.focus();
    retry.click();
  });
  expect(document.activeElement).toBe(current);
  await act(async () => read.resolve(ipc.snapshot(defaultPreferences)));
  await settle();
  expect(view.textContent).not.toContain("Settings could not be read.");
  expect(document.activeElement).toBe(current);
});

it("recovers a subtitle settings read failure without losing keyboard focus", async () => {
  ipc.refuse("subtitles.settings", { kind: "unexpected", detail: "read failed" });
  useUi.setState({ settings: "subtitles" });
  const { view } = await render();
  const alert = [...view.querySelectorAll('[role="alert"]')].find((each) =>
    each.textContent?.includes("Subtitle settings could not be saved or read"),
  )!;
  const retry = [...alert.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Try again",
  )!;
  const current = view.querySelector('nav button[aria-current="page"]');
  const read = ipc.hold("subtitles.settings");
  await act(async () => {
    retry.focus();
    retry.click();
  });
  expect(document.activeElement).toBe(current);
  await act(async () =>
    read.resolve({
      enabled: false,
      service: "both",
      languages: ["en"],
      configured: { subdl: true, opensubtitles: false },
    }),
  );
  await settle();
  expect(alert.isConnected).toBe(false);
  expect(document.activeElement).toBe(current);
});

it("keeps the TMDB credential focused and blocks another submission while saving", async () => {
  const { view } = await render();
  await nav(view, "Movies and series");
  await act(async () =>
    view.querySelector<HTMLButtonElement>('[data-setting="tmdb"] button')!.click(),
  );
  const field = view.querySelector<HTMLInputElement>('[aria-label="Your own TMDB key"]')!;
  await type(field, "test-key");
  const save = ipc.hold("preferences.update");
  await act(async () => field.closest("form")!.requestSubmit());
  await settle();
  expect(document.activeElement).toBe(field);
  expect(field.matches(":disabled")).toBe(false);
  await act(async () => field.closest("form")!.requestSubmit());
  expect(ipc.argsOf("preferences.update")).toEqual([{ tmdbKey: "test-key" }]);
  await act(async () => save.reject({ kind: "unexpected", detail: "key refused" }));
  await settle();
  expect(document.activeElement).toBe(field);
  expect(field.value).toBe("test-key");
  expect(view.textContent).toContain("key refused");
});

it("keeps online credentials focused and blocks another submission until refusal settles", async () => {
  ipc.always("subtitles.settings", {
    enabled: false,
    service: "both",
    languages: ["en"],
    configured: { subdl: false, opensubtitles: false },
  });
  const { view } = await render(createElement(OnlineSubtitlesSection));
  await act(async () =>
    view.querySelector<HTMLButtonElement>('[data-setting="subdl"] button')!.click(),
  );
  const field = view.querySelector<HTMLInputElement>('[aria-label="SubDL API key"]')!;
  await type(field, "test-key");
  const save = ipc.hold("subtitles.configure");
  await act(async () => field.closest("form")!.requestSubmit());
  await settle();
  expect(document.activeElement).toBe(field);
  expect(field.matches(":disabled")).toBe(false);
  await act(async () => field.closest("form")!.requestSubmit());
  expect(ipc.argsOf("subtitles.configure")).toHaveLength(1);
  await act(async () => save.reject({ kind: "unexpected", detail: "key refused" }));
  await settle();
  expect(document.activeElement).toBe(field);
  expect(field.value).toBe("test-key");
  expect(view.textContent).toContain("key refused");
});

it("keeps delay editing keys inside the field and clamps typed whole seconds", async () => {
  const { view } = await render();
  await nav(view, "Playback");
  const delay = view.querySelector<HTMLInputElement>('[aria-label="Next episode delay"]')!;
  const press = async (key: string, shiftKey = false) => {
    await act(async () =>
      delay.dispatchEvent(
        new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }),
      ),
    );
  };
  await type(delay, "10");
  await press("ArrowUp", true);
  expect(delay.value).toBe("15");
  await press("ArrowDown");
  expect(delay.value).toBe("14");
  await press("End");
  expect(delay.value).toBe("60");
  await press("Home");
  expect(delay.value).toBe("0");
  await press("Escape");
  expect(delay.value).toBe("10");
  expect(useUi.getState().settings).toBe("playback");
  expect(ipc.argsOf("preferences.update")).toHaveLength(0);
  const save = ipc.hold("preferences.update");
  await type(delay, "999");
  await press("Enter");
  expect(document.activeElement).toBe(delay);
  expect(ipc.argsOf("preferences.update")).toEqual([{ nextEpisodeDelaySeconds: 60 }]);
  await act(async () =>
    save.resolve(ipc.snapshot({ ...defaultPreferences, nextEpisodeDelaySeconds: 60 })),
  );
  await settle();
  expect(delay.value).toBe("60");
  expect(document.activeElement).toBe(delay);
  await type(delay, "12");
  await press("Escape");
  expect(delay.value).toBe("60");
  expect(useUi.getState().settings).toBe("playback");
});

it("the metadata progress opener focuses the TMDB control", async () => {
  ipc.always("ondemand.status", {
    lists: [],
    metadata: { known: 2, wanted: 10, refused: false, fetching: true },
  });
  const { view } = await render();
  await act(async () =>
    view.querySelector<HTMLButtonElement>('button[aria-label^="TMDB ·"]')!.click(),
  );
  await settle();
  expect(useUi.getState().settings).toBe("movies");
  expect(document.activeElement?.closest("[data-setting]")?.getAttribute("data-setting")).toBe(
    "tmdb",
  );
});

it("returns focus to the visible player when the original opener has gone", async () => {
  const opener = document.createElement("button");
  const player = document.createElement("div");
  player.dataset["view"] = "title";
  player.tabIndex = -1;
  document.body.append(opener, player);
  opener.focus();
  await render();
  opener.remove();
  await act(async () => useUi.setState({ settings: null }));
  await settle();
  expect(document.activeElement).toBe(player);
  player.remove();
});

it("closing with Back discards an unavailable destination before a later reopen", async () => {
  const read = ipc.hold("updates.status");
  useUi.setState({ settings: "updates", settingsTarget: "update-channel" });
  const { view } = await render();
  expect(useUi.getState().settingsTarget).toBe("update-channel");
  await act(async () =>
    [...view.querySelectorAll<HTMLButtonElement>("header button")]
      .find((button) => button.textContent?.trim() === "Back")!
      .click(),
  );
  expect(useUi.getState().settingsTarget).toBeNull();
  await act(async () => useUi.setState({ settings: "updates" }));
  await settle();
  const focused = document.activeElement;
  await act(async () =>
    read.resolve({
      version: "0.0.15",
      distribution: "direct",
      channel: "stable",
      update: { kind: "idle" },
      offer: null,
      checked: null,
      nextCheckAt: null,
      dismissed: null,
    }),
  );
  await settle();
  expect(document.activeElement).toBe(focused);
  expect(document.activeElement).not.toBe(view.querySelector('[aria-label="Channel"]'));
});

it("blocks repeated quality writes while pending, preserves acknowledgement on refusal and moves retry focus back to its select", async () => {
  const first = ipc.hold("preferences.update");
  const { view } = await render();
  await nav(view, "Live TV");
  const quality = view.querySelector<HTMLSelectElement>('select[aria-label="Quality"]')!;
  const choose = async (value: string) =>
    act(async () => {
      quality.focus();
      quality.value = value;
      quality.dispatchEvent(new Event("change", { bubbles: true }));
    });
  await choose("hd");
  await settle();
  await choose("sd");
  expect(ipc.argsOf("preferences.update")).toEqual([{ liveQuality: "hd" }]);
  expect(quality.value).toBe("fhd");
  await act(async () => first.reject({ kind: "unexpected", detail: "quality refused" }));
  await settle();
  const retry = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Try again",
  )!;
  const save = ipc.hold("preferences.update");
  await act(async () => {
    retry.focus();
    retry.click();
  });
  expect(document.activeElement).toBe(quality);
  await act(async () => save.resolve(ipc.snapshot({ ...defaultPreferences, liveQuality: "hd" })));
  await settle();
  expect(quality.value).toBe("hd");
  expect(view.textContent).not.toContain("quality refused");
});

it("keeps the acknowledged interface language and update channel while rejecting repeated pending choices", async () => {
  const status = {
    version: "0.0.15",
    distribution: "direct",
    channel: "stable",
    update: { kind: "idle" },
    offer: null,
    checked: null,
    nextCheckAt: null,
    dismissed: null,
  } as const;
  ipc.always("updates.status", status);
  const { view } = await render();
  const change = async (label: string, value: string) =>
    act(async () => {
      const control = view.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
      control.value = value;
      control.dispatchEvent(new Event("change", { bubbles: true }));
    });
  const language = ipc.hold("language.set");
  await change("Interface language", "en-US");
  await settle();
  await change("Interface language", "nl-NL");
  expect(ipc.argsOf("language.set")).toEqual([{ choice: "en-US" }]);
  expect(view.querySelector<HTMLSelectElement>('[aria-label="Interface language"]')?.value).toBe(
    "system",
  );
  await act(async () =>
    language.resolve({ choice: "en-US", locale: "en-US", system: "en-US", formats: "en-US" }),
  );
  await settle();
  await nav(view, "Updates");
  const channel = ipc.hold("updates.setChannel");
  await change("Channel", "nightly");
  await settle();
  await change("Channel", "stable");
  expect(ipc.argsOf("updates.setChannel")).toEqual([{ channel: "nightly" }]);
  expect(view.querySelector<HTMLSelectElement>('[aria-label="Channel"]')?.value).toBe("stable");
  await act(async () => channel.resolve({ ...status, channel: "nightly" }));
  await settle();
  expect(view.querySelector<HTMLSelectElement>('[aria-label="Channel"]')?.value).toBe("nightly");
});
