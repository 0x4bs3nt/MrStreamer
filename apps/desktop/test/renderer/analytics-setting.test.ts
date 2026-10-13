// @vitest-environment happy-dom
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Locale } from "@mrstreamer/contracts/language";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import { setLanguage, t } from "@mrstreamer/core/i18n";
import { GeneralSection } from "../../src/renderer/src/features/settings/GeneralSection.tsx";

let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  setLanguage({ locale: "en-US", formats: "en-US" });
  vi.useRealTimers();
});

/** Lets React Query tell the section what a query or mutation answered. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(20));

async function render(locale: Locale = "en-US", enabled = true) {
  ipc.reset();
  ipc.prefer({ analyticsEnabled: enabled });
  setLanguage({ locale, formats: locale });
  const client = new QueryClient();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(GeneralSection))),
  );
  await settle();
  unmount = () =>
    act(() => {
      root.unmount();
      client.clear();
    });
  const checkbox = [...container.querySelectorAll<HTMLElement>('[role="checkbox"]')].find(
    (element) => element.getAttribute("aria-label") === t("Share basic usage statistics"),
  );
  if (!checkbox) throw new Error("No statistics checkbox.");
  return { container, checkbox };
}

describe("Settings statistics preference", () => {
  // In a language other than English, so its copy is shown through the catalog, whose every
  // language packages/core/test/i18n.test.ts checks.
  it("shows the privacy control and persists its choice through the preferences mutation in nl-NL", async () => {
    const { container, checkbox } = await render("nl-NL");
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain(
      t(
        "Counts app use, the features you open, whether playback, downloads and update checks work, and how often the window stops unexpectedly. No viewing history or provider details.",
      ),
    );
    const link = container.querySelector<HTMLAnchorElement>(
      'a[href="https://mrstreamer.app/privacy"]',
    );
    expect(link?.textContent).toBe(t("Privacy policy"));
    const changed = ipc.hold("preferences.update");
    await act(() => checkbox.click());
    expect(ipc.argsOf("preferences.update")).toEqual([{ analyticsEnabled: false }]);
    await settle();
    await act(() => checkbox.click());
    expect(ipc.argsOf("preferences.update")).toEqual([{ analyticsEnabled: false }]);
    await act(async () => changed.resolve({ ...defaultPreferences, analyticsEnabled: false }));
    await settle();
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
  });

  it("keeps a saved opt-out visible and shows a failed enable without claiming it was saved", async () => {
    const { container, checkbox } = await render("en-US", false);
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    const changed = ipc.hold("preferences.update");
    await act(() => checkbox.click());
    await act(async () =>
      changed.reject({ kind: "unexpected", detail: "Analytics preference could not be saved." }),
    );
    await settle();
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Analytics preference could not be saved.");
  });
});
