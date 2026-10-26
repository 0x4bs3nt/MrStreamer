// @vitest-environment happy-dom
import { ipc } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Locale } from "@mrstreamer/contracts/language";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import { setLanguage, t } from "@mrstreamer/core/i18n";
import { PrivacySection } from "../../src/renderer/src/features/settings/GeneralSection.tsx";
import { syncPreferences } from "../../src/renderer/src/lib/preferences.ts";

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
  const detach = syncPreferences(client, () => {});
  const view = queryView(client);
  const { container } = view;
  await view.render(createElement(PrivacySection));
  await settle();
  unmount = () => {
    detach();
    view.unmount();
  };
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
    await act(async () =>
      changed.resolve(ipc.snapshot({ ...defaultPreferences, analyticsEnabled: false })),
    );
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

  it.each([false, true])(
    "clears an obsolete consent save error only when a published value matches the request, initially %s",
    async (initial) => {
      const { container, checkbox } = await render("en-US", initial);
      const changed = ipc.hold("preferences.update");
      await act(() => checkbox.click());
      await act(async () =>
        changed.reject({ kind: "unexpected", detail: "Analytics preference could not be saved." }),
      );
      await settle();
      expect(checkbox.getAttribute("aria-checked")).toBe(String(initial));
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Analytics preference could not be saved.",
      );
      // An unrelated accepted edit cannot claim the rejected consent write succeeded.
      await act(() =>
        ipc.emit(
          "preferences.changed",
          ipc.snapshot({
            ...defaultPreferences,
            analyticsEnabled: initial,
            muted: true,
          }),
        ),
      );
      await settle();
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Analytics preference could not be saved.",
      );
      await act(() =>
        ipc.emit(
          "preferences.changed",
          ipc.snapshot({
            ...defaultPreferences,
            analyticsEnabled: !initial,
            muted: true,
          }),
        ),
      );
      await settle();
      expect(checkbox.getAttribute("aria-checked")).toBe(String(!initial));
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(ipc.argsOf("preferences.get")).toHaveLength(1);
      expect(ipc.argsOf("preferences.update")).toEqual([{ analyticsEnabled: !initial }]);
    },
  );
});
