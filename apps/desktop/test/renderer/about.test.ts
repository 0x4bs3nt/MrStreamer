// @vitest-environment happy-dom
// About exports only on request. Save refers to the inspected snapshot, and cancelling the
// native dialog must not claim a file was saved. Rating is available only for Store copies.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DiagnosticsPreview } from "@mrstreamer/contracts/diagnostics";
import type { Distribution, UpdateStatus } from "@mrstreamer/contracts/updates";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { SettingsPage } from "../../src/renderer/src/features/settings/SettingsPage.tsx";

let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function about(distribution: Distribution = "direct") {
  ipc.reset();
  vi.stubGlobal("__BUILD_COMMIT__", "abcdef0123456789");
  useUi.setState({ settings: "about" });
  const client = new QueryClient();
  const status: UpdateStatus = {
    version: "0.0.9",
    distribution,
    channel: "stable",
    update: { kind: "idle" },
    offer: null,
    checked: null,
    nextCheckAt: null,
    dismissed: null,
  };
  client.setQueryData(["updates"], status);
  ipc.always("updates.status", status);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(SettingsPage))),
  );
  unmount = () => {
    act(() => root.unmount());
    client.clear();
    container.remove();
  };
  return container;
}
function button(container: HTMLElement, name: string) {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent === name);
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}
async function click(container: HTMLElement, name: string) {
  await act(async () => {
    button(container, name).click();
    await vi.advanceTimersByTimeAsync(20);
  });
}

it.each(["direct", "store"] as const)(
  "offers rating only for Store copies (%s)",
  async (distribution) => {
    const view = await about(distribution);
    const rating = [...view.querySelectorAll("button")].find(
      (item) => item.textContent === "Rate in the Microsoft Store",
    );
    expect(Boolean(rating)).toBe(distribution === "store");
    if (rating) {
      ipc.always("updates.rateStore", null);
      await click(view, "Rate in the Microsoft Store");
      expect(ipc.argsOf("updates.rateStore")).toHaveLength(1);
    }
  },
);

it("previews on request and saves the inspected text without treating dialog cancellation as success", async () => {
  const view = await about();
  expect(ipc.methods()).not.toContain("diagnostics.preview");
  const report: DiagnosticsPreview = {
    id: "snapshot-one",
    version: "0.0.9",
    commit: "abcdef0123456789",
    channel: "stable",
    platform: "linux x64",
    distribution: "direct",
    subscriptions: { xtream: 1, m3u: 2 },
    entries: 1,
    failures: 0,
    acceleratedVideoDecodeDisabled: false,
    checked: "none",
    text: "The inspected text",
  };
  ipc.always("diagnostics.preview", report);
  await click(view, "Diagnostics…");
  expect(document.activeElement?.textContent).toBe("Diagnostics export");
  expect(view.textContent).toContain("1 recent entry");
  await click(view, "Show the text");
  expect(view.querySelector("pre")?.textContent).toBe(report.text);
  ipc.always("diagnostics.save", false);
  await click(view, "Save…");
  expect(ipc.argsOf("diagnostics.save")).toEqual([{ id: report.id }]);
  expect(view.querySelector('[role="status"]')).toBeNull();
  ipc.refuse("diagnostics.save", { kind: "unexpected", detail: "Write failed" });
  await click(view, "Save…");
  expect(view.querySelector('[role="alert"]')?.textContent).toContain("could not be saved");
  ipc.always("diagnostics.save", true);
  await click(view, "Save…");
  expect(view.querySelector('[role="status"]')?.textContent).toBe("Diagnostics saved.");
  await click(view, "Cancel");
  expect(view.querySelector('[aria-label="Diagnostics export"]')).toBeNull();
  expect(document.activeElement).toBe(button(view, "Diagnostics…"));
});
