// @vitest-environment happy-dom
import { ipc } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement, Fragment } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultPreferences, DEFAULT_SUBTITLE_LOOK } from "@mrstreamer/contracts/preferences";
import { acceptPreferences, syncPreferences } from "../../src/renderer/src/lib/preferences.ts";
import { player } from "../../src/renderer/src/player/player.ts";
import { SubtitlesSettingsSection } from "../../src/renderer/src/features/settings/GeneralSection.tsx";
import { Flash } from "../../src/renderer/src/features/watch/Flash.tsx";
import { LookRows } from "../../src/renderer/src/features/watch/SubtitleSettings.tsx";

let cleanup = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  ipc.reset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stop = syncPreferences(client, (preferences) => player.hydrate(preferences));
  acceptPreferences(client, { revision: 1, preferences: defaultPreferences });
  const mounted = queryView(client);
  const host = mounted.container;
  const mount = async (settings = false, cc = true) => {
    await mounted.render(
      createElement(
        Fragment,
        null,
        cc ? createElement(LookRows, { text: true }) : null,
        createElement(Flash),
        settings ? createElement(SubtitlesSettingsSection) : null,
      ),
    );
    await act(() => vi.advanceTimersByTimeAsync(20));
  };
  cleanup = () => {
    stop();
    mounted.unmount();
  };
  await mount();
  const pick = async (label: string) => {
    await act(async () =>
      host.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${label}"]`)!.click(),
    );
  };
  return { host, client, mount, pick };
}
const snapshot = (revision: number, look = DEFAULT_SUBTITLE_LOOK) => ({
  revision,
  preferences: { ...defaultPreferences, subtitleLook: look },
});

it("retains pending CC fields across an older committed acknowledgement and ignores an obsolete failure after success", async () => {
  const { host, pick } = await render();
  const first = ipc.hold("preferences.update");
  const second = ipc.hold("preferences.update");
  const third = ipc.hold("preferences.update");
  await pick("Large");
  await pick("Higher");
  expect(ipc.argsOf("preferences.update").at(-1)).toEqual({
    subtitleLook: { size: "large", background: "box", position: "high" },
  });
  await act(async () => {
    const saved = snapshot(2, { size: "large", background: "box", position: "low" });
    ipc.emit("preferences.changed", saved);
    first.resolve(saved);
  });
  await pick("Shadow");
  const intended = { size: "large", background: "shadow", position: "high" } as const;
  expect(ipc.argsOf("preferences.update").at(-1)).toEqual({ subtitleLook: intended });
  await act(async () => third.resolve(snapshot(4, intended)));
  await act(async () => second.reject({ kind: "unexpected", detail: "obsolete look failure" }));
  expect(host.textContent).not.toContain("obsolete look failure");
  expect(host.querySelector('[aria-label="Higher"]')?.getAttribute("aria-checked")).toBe("true");
});

it("merges Settings and remounted CC edits against shared pending intent while showing only acknowledged Settings values", async () => {
  const { host, mount, pick } = await render();
  const first = ipc.hold("preferences.update");
  const second = ipc.hold("preferences.update");
  const third = ipc.hold("preferences.update");
  await pick("Large");
  // Mount another editor while the first CC save is outstanding.
  await mount(true, false);
  const position = host.querySelector<HTMLSelectElement>('select[aria-label="Position"]')!;
  await act(async () => {
    position.value = "high";
    position.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(position.value).toBe("low");
  await act(async () =>
    first.resolve(snapshot(2, { size: "large", background: "box", position: "low" })),
  );
  // Unmount/remount the controls without settling the newer intent.
  await act(async () => mount(false));
  await pick("Shadow");
  const intended = { size: "large", background: "shadow", position: "high" } as const;
  expect(ipc.argsOf("preferences.update").at(-1)).toEqual({ subtitleLook: intended });
  await act(async () => third.resolve(snapshot(4, intended)));
  await act(async () => second.reject({ kind: "unexpected", detail: "obsolete Settings refusal" }));
  await mount(true);
  expect(host.textContent).not.toContain("obsolete Settings refusal");
});

it("keeps a mounted Settings row free of a superseded failure after CC saves its intent", async () => {
  const { host, mount, pick } = await render();
  await mount(true);
  const first = ipc.hold("preferences.update");
  const position = host.querySelector<HTMLSelectElement>('select[aria-label="Position"]')!;
  await act(async () => {
    position.value = "high";
    position.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const second = ipc.hold("preferences.update");
  await pick("Shadow");
  await act(async () =>
    second.resolve(snapshot(3, { size: "medium", background: "shadow", position: "high" })),
  );
  await act(async () =>
    first.reject({ kind: "unexpected", detail: "obsolete mounted Settings refusal" }),
  );
  await act(() => vi.advanceTimersByTimeAsync(20));
  expect(position.value).toBe("high");
  expect(host.textContent).not.toContain("obsolete mounted Settings refusal");
});

it("a failed look readback cannot erase an edit made while that read was pending", async () => {
  const { host, pick } = await render();
  const first = ipc.hold("preferences.update");
  const readback = ipc.hold("preferences.get");
  await pick("Large");
  await act(async () => first.reject({ kind: "unexpected", detail: "old refusal" }));
  const second = ipc.hold("preferences.update");
  await pick("Higher");
  await act(async () => readback.resolve(snapshot(2)));
  expect(host.textContent).not.toContain("old refusal");
  expect(host.querySelector('[aria-label="Higher"]')?.getAttribute("aria-checked")).toBe("true");
  await act(async () =>
    second.resolve(snapshot(3, { size: "large", background: "box", position: "high" })),
  );
  const failed = ipc.hold("preferences.update");
  ipc.always(
    "preferences.get",
    snapshot(3, { size: "large", background: "box", position: "high" }),
  );
  await pick("Shadow");
  await act(async () => failed.reject({ kind: "unexpected", detail: "latest refusal" }));
  expect(host.textContent).toContain("latest refusal");
  expect(host.querySelector('[aria-label="Box"]')?.getAttribute("aria-checked")).toBe("true");
});

it("does not report an obsolete volume refusal after a newer save succeeds", async () => {
  const { host } = await render();
  const first = ipc.hold("preferences.update");
  player.setVolume(0.25);
  await act(() => vi.advanceTimersByTimeAsync(500));
  const second = ipc.hold("preferences.update");
  player.setVolume(0.75);
  await act(() => vi.advanceTimersByTimeAsync(500));
  await act(async () =>
    second.resolve({ revision: 3, preferences: { ...defaultPreferences, volume: 0.75 } }),
  );
  await act(async () => first.reject({ kind: "unexpected", detail: "obsolete volume refusal" }));
  expect(host.textContent).not.toContain("obsolete volume refusal");
  expect(player.state().volume).toBe(0.75);
});
