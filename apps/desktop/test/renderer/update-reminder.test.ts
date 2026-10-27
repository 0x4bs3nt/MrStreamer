// @vitest-environment happy-dom
// The launch's update reminder: shown once the viewer browses, only after the main process allows
// it, and never over playback. Not now and Escape leave the top bar's Update and the keyboard
// where they were.
import { ipc } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement, Fragment } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { UpdateStatus } from "@mrstreamer/contracts/updates";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { UpdateNotice } from "../../src/renderer/src/features/updates/UpdateNotice.tsx";
import { UpdateReminder } from "../../src/renderer/src/features/updates/UpdateReminder.tsx";
import { queryView } from "./mount.ts";

const STATUS: UpdateStatus = {
  version: "0.0.21",
  distribution: "direct",
  channel: "stable",
  update: { kind: "available", version: "0.0.23" },
  offer: {
    version: "0.0.23",
    notes:
      "## What's changed\n* Guide opens faster on large lists by @a in https://github.com/o/r/pull/1\n* Subtitles follow the player's controls by @a in https://github.com/o/r/pull/2",
    page: null,
  },
  checked: { at: Date.now(), failure: null },
  nextCheckAt: null,
  // Not now in the panel at an earlier launch: the reminder still shows, and its Update stays.
  dismissed: "0.0.23",
  reminder: { version: "0.0.23" },
};

const views: (() => void)[] = [];
let opener: HTMLButtonElement;
beforeEach(() => {
  ipc.reset();
  ipc.always("updates.downloadVersion", {
    ...STATUS,
    update: { kind: "downloading", version: "0.0.23", percent: 0 },
  });
  opener = document.createElement("button");
  opener.textContent = "Live TV";
  document.body.append(opener);
  opener.focus();
});
afterEach(() => {
  for (const unmount of views.splice(0)) unmount();
  opener.remove();
  useUi.setState({
    updateReminder: null,
    updateDialog: null,
    playingTitle: false,
    watching: false,
  });
});

async function mount() {
  const client = new QueryClient();
  client.setQueryData(["updates"], STATUS);
  const view = queryView(client);
  await view.render(
    createElement(Fragment, null, createElement(UpdateNotice), createElement(UpdateReminder)),
  );
  views.push(view.unmount);
  return { ...view, client };
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
const dialog = () => document.querySelector<HTMLElement>("[data-update-reminder]");
const named = (text: string) =>
  [...document.querySelectorAll("button")].find((button) => button.textContent === text);

it("shows the due release with its notes, and Not now keeps Update and the keyboard", async () => {
  ipc.always("updates.showReminder", true);
  const view = await mount();
  await settle();

  expect(ipc.argsOf("updates.showReminder")).toEqual([{ version: "0.0.23" }]);
  expect(ipc.argsOf("updates.reminderShown")).toContainEqual({ version: "0.0.23" });
  expect(dialog()?.textContent).toContain("Update to 0.0.23");
  expect(dialog()?.textContent).toContain("You have 0.0.21 · Stable");
  expect(dialog()?.textContent).toContain("Guide opens faster on large lists");
  expect(dialog()?.textContent).toContain("Subtitles follow the player's controls");

  await act(async () => named("Not now")!.click());
  await settle();
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(view.container.querySelector("[data-update-notice]")).not.toBeNull();
  expect(ipc.argsOf("updates.dismiss")).toEqual([]);

  // Once a launch: a remounted window doesn't ask or show again.
  view.unmount();
  views.length = 0;
  await mount();
  await settle();
  expect(ipc.argsOf("updates.showReminder")).toHaveLength(1);
  expect(dialog()).toBeNull();
});

it("closes on Escape, returning the keyboard", async () => {
  ipc.always("updates.showReminder", true);
  await mount();
  await settle();
  expect(dialog()?.contains(document.activeElement)).toBe(true);

  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  await settle();
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it("returns to Update after playback leaves no connected opener", async () => {
  ipc.always("updates.showReminder", true);
  useUi.setState({ playingTitle: true });
  const view = await mount();
  opener.remove();

  await act(async () => useUi.setState({ playingTitle: false }));
  await settle();
  expect(dialog()?.contains(document.activeElement)).toBe(true);

  await act(async () => named("Not now")!.click());
  await settle();
  expect(document.activeElement).toBe(view.container.querySelector("[data-update-notice]"));
});

it("downloads through the updater and closes", async () => {
  ipc.always("updates.showReminder", true);
  const view = await mount();
  await settle();

  await act(async () => named("Download")!.click());
  await settle();
  expect(ipc.argsOf("updates.downloadVersion")).toEqual([{ version: "0.0.23" }]);
  expect(dialog()).toBeNull();
  expect(view.container.querySelector("[data-update-notice]")?.textContent).toContain("Updating");
});

it("waits for playback to end before asking", async () => {
  ipc.always("updates.showReminder", true);
  useUi.setState({ playingTitle: true });
  await mount();
  await settle();
  expect(ipc.argsOf("updates.showReminder")).toEqual([]);
  expect(dialog()).toBeNull();

  await act(async () => useUi.setState({ playingTitle: false }));
  await settle();
  expect(ipc.argsOf("updates.showReminder")).toHaveLength(1);
  expect(dialog()).not.toBeNull();
});

it("keeps an answer that comes once playback started for the next time the viewer browses", async () => {
  const answer = ipc.hold("updates.showReminder");
  await mount();
  await act(async () => useUi.setState({ watching: true }));
  await act(async () => answer.resolve(true));
  await settle();
  expect(dialog()).toBeNull();
  expect(ipc.argsOf("updates.reminderShown")).toEqual([]);

  await act(async () => useUi.setState({ watching: false }));
  await settle();
  expect(dialog()).not.toBeNull();
  expect(ipc.argsOf("updates.showReminder")).toHaveLength(1);
});

it("shows nothing when the main process doesn't allow it", async () => {
  ipc.always("updates.showReminder", false);
  ipc.always("updates.status", { ...STATUS, reminder: null });
  await mount();
  await settle();
  expect(ipc.argsOf("updates.showReminder")).toHaveLength(1);
  expect(dialog()).toBeNull();
});

it("validates a changed offer again before showing a deferred reminder", async () => {
  const answer = ipc.hold("updates.showReminder");
  ipc.always("updates.showReminder", true);
  const { client } = await mount();
  await act(async () => useUi.setState({ watching: true }));
  await act(async () => answer.resolve(true));
  await settle();
  await act(async () =>
    client.setQueryData(["updates"], {
      ...STATUS,
      reminder: { version: "0.1.0" },
      update: { kind: "available", version: "0.1.0" },
    } satisfies UpdateStatus),
  );
  await act(async () => useUi.setState({ watching: false }));
  await settle();
  expect(ipc.argsOf("updates.showReminder")).toEqual([{ version: "0.0.23" }, { version: "0.1.0" }]);
  expect(dialog()?.textContent).toContain("Update to 0.1.0");
  expect(ipc.argsOf("updates.reminderShown")).toContainEqual({ version: "0.1.0" });
  // A later recheck must not leave Download describing an old target.
  await act(async () =>
    client.setQueryData(["updates"], {
      ...STATUS,
      update: { kind: "checking" },
    } satisfies UpdateStatus),
  );
  await settle();
  expect(dialog()).toBeNull();
});

it("can remind after an in-flight check refused an earlier stale request", async () => {
  const answer = ipc.hold("updates.showReminder");
  ipc.always("updates.status", { ...STATUS, reminder: null });
  ipc.always("updates.showReminder", true);
  const { client } = await mount();
  await act(async () => answer.resolve(false));
  await settle();
  expect(dialog()).toBeNull();
  await act(async () => client.setQueryData(["updates"], STATUS));
  await settle();
  expect(dialog()).not.toBeNull();
  expect(ipc.argsOf("updates.showReminder")).toHaveLength(2);
});
