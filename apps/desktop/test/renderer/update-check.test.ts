// @vitest-environment happy-dom
// Settings > Updates: a newer release can come out after the one on offer, so Check now
// stays beside Download. While an update downloads or waits for its restart, there is nothing to
// check. A copy the Microsoft Store installed leaves updates to the Store.
import { ipc } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, describe, expect, it } from "vitest";
import type { Distribution, UpdatePhase, UpdateStatus } from "@mrstreamer/contracts/updates";
import { UpdatesSection } from "../../src/renderer/src/features/updates/UpdatesSection.tsx";

let unmount = () => {};
afterEach(() => unmount());

/** Settings' update rows for `update`, and the names of their buttons. */
async function buttonsFor(
  update: UpdatePhase,
  distribution: Distribution = "direct",
): Promise<HTMLElement> {
  ipc.reset();
  const status: UpdateStatus = {
    version: "0.0.3-nightly.20261001.46",
    distribution,
    channel: "nightly",
    update,
    offer: { version: "0.0.3-nightly.20261002.47", notes: null, page: null },
    checked: { at: Date.now(), failure: null },
    nextCheckAt: null,
    dismissed: null,
  };
  const client = new QueryClient();
  client.setQueryData(["updates"], status);
  const mounted = queryView(client);
  await mounted.render(createElement(UpdatesSection));
  unmount = mounted.unmount;
  return mounted.container;
}

const named = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((button) => button.textContent === text);

describe("checking for updates in Settings", () => {
  it("stays at hand while a release is on offer", async () => {
    const rows = await buttonsFor({ kind: "available", version: "0.0.3-nightly.20261002.47" });

    expect(named(rows, "Download")).toBeDefined();
    await act(async () => named(rows, "Check now")?.click());
    expect(ipc.argsOf("updates.check")).toHaveLength(1);
  });

  it.each([
    { kind: "downloading", version: "0.0.3-nightly.20261002.47", percent: 40 } as const,
    { kind: "ready", version: "0.0.3-nightly.20261002.47" } as const,
  ])("isn't offered while an update is $kind", async (update) => {
    expect(named(await buttonsFor(update), "Check now")).toBeUndefined();
  });
});

describe("updates for a copy the Microsoft Store installed", () => {
  it("only opens the Store", async () => {
    const rows = await buttonsFor({ kind: "idle" }, "store");

    expect([...rows.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Open Store",
    ]);
    expect(rows.querySelector("select")).toBeNull();
    await act(async () => named(rows, "Open Store")?.click());
    expect(ipc.argsOf("updates.openStore")).toHaveLength(1);
  });
});

it("keeps the acknowledged update channel after a failed save and retries that choice", async () => {
  const rows = await buttonsFor({ kind: "idle" });
  ipc.refuse("updates.setChannel", { kind: "unexpected", detail: "channel write failed" });
  const select = rows.querySelector<HTMLSelectElement>("select[aria-label=Channel]")!;
  await act(async () => {
    select.value = "stable";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  expect(select.value).toBe("nightly");
  expect(rows.textContent).toContain("channel write failed");
  ipc.always("updates.setChannel", {
    version: "0.0.15",
    distribution: "direct",
    channel: "stable",
    update: { kind: "idle" },
    offer: null,
    checked: null,
    nextCheckAt: null,
    dismissed: null,
  });
  await act(async () => named(rows, "Try again")!.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  expect(select.value).toBe("stable");
  expect(rows.textContent).not.toContain("channel write failed");
});

it("shows the AUR update route without direct actions, even with stale direct offer state", async () => {
  const rows = await buttonsFor({ kind: "ready", version: "0.0.18" }, "pacman");
  expect(rows.textContent).toContain("Updates come from the AUR. Use an AUR helper or makepkg.");
  expect(rows.querySelector("select")).toBeNull();
  expect(rows.querySelector("button")).toBeNull();
});
