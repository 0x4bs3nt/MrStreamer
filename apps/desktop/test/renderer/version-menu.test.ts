// @vitest-environment happy-dom
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { VersionMenu } from "../../src/renderer/src/features/titles/VersionMenu.tsx";

const GREEN = "849e1969-a047-4f37-9171-b09ae2c87a13";
const film: Title = {
  kind: "movie",
  key: "movie:603",
  subscriptionId: SUBSCRIPTION,
  id: "hd",
  name: "Harbour HD",
  title: "Harbour",
  originalTitle: null,
  originalLanguage: "en",
  tags: ["HD"],
  year: null,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: "603",
  genres: [],
  versions: [
    { subscriptionId: SUBSCRIPTION, id: "hd", tags: ["HD"], name: "Harbour HD", container: "mp4" },
    {
      subscriptionId: SUBSCRIPTION,
      id: "first",
      tags: ["4K"],
      name: "Harbour UHD release A",
      container: "mkv",
      addedAt: 1700000000000,
      listedOrder: 1,
      observed: { files: 1, audio: ["en"], subtitles: [] },
    },
    {
      subscriptionId: SUBSCRIPTION,
      id: "second",
      tags: ["UHD"],
      name: "Harbour UHD release B",
      container: "mp4",
      listedOrder: 2,
    },
    { subscriptionId: GREEN, id: "first", tags: ["4K", "NL"], name: "Harbour 4K (NL)" },
    { subscriptionId: GREEN, id: "unknown", tags: ["HD", "HQ"], name: "Harbour HQ" },
  ],
};
let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
});
const settle = () => act(() => vi.advanceTimersByTimeAsync(20));
const radios = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];

async function mount(title = film) {
  ipc.reset();
  const client = new QueryClient();
  client.setQueryData(
    ["subscriptions"],
    [
      { ...SAVED, name: "Blue" },
      { ...SAVED, id: GREEN, name: "Green" },
    ],
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const picked = vi.fn();
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(VersionMenu, {
          title,
          picked: null,
          automatic: { subscriptionId: SUBSCRIPTION, id: "hd" },
          onPick: picked,
          children: "Versions",
        }),
      ),
    ),
  );
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Versions"]')?.click(),
  );
  await settle();
  return { picked, container };
}

describe("the movie version menu", () => {
  it("announces listed hints and locally read tracks separately", async () => {
    await mount({
      ...film,
      versions: film.versions.map((version) =>
        version.subscriptionId === SUBSCRIPTION && ["first", "second"].includes(version.id)
          ? { ...version, tags: ["4K", "NL"] }
          : version,
      ),
    });
    const listed = radios().find((item) => item.textContent?.includes("Harbour 4K (NL)"));
    expect(listed?.getAttribute("aria-label")).toContain("as listed");
    const group = document.querySelector<HTMLElement>('[role="menuitem"][aria-expanded]');
    expect(group?.getAttribute("aria-label")).toContain("as listed");
    await act(async () => group?.click());
    await settle();
    const read = radios().find((item) => item.textContent?.includes("release A"));
    const unread = radios().find((item) => item.textContent?.includes("release B"));
    expect(read?.getAttribute("aria-label")).toContain("Tracks read locally");
    expect(read?.getAttribute("aria-label")).not.toContain("as listed");
    expect(unread?.getAttribute("aria-label")).toContain("as listed");
    expect(unread?.getAttribute("aria-label")).not.toContain("Tracks read locally");
  });

  it("shows one quality-first list with provider names and preserves unfamiliar hints", async () => {
    await mount();
    const choices = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].map(
      (item) => item.textContent ?? "",
    );
    expect(choices[0]).toContain("Automatic");
    expect(choices[1]).toContain("4K");
    expect(choices[1]).toContain("Nederlands subtitles");
    expect(choices[1]).toContain("Green");
    expect(choices[2]).toContain("4K");
    expect(choices[2]).toContain("2 versions");
    expect(choices[2]).toContain("Blue");
    expect(choices.at(-1)).toContain("HQ");
    expect(choices.at(-1)).toContain("as listed");
    expect(ipc.methods()).not.toContain("ondemand.details");
    expect(ipc.methods()).not.toContain("playback.openTitle");
  });

  it("discloses distinct exact files and their metadata without borrowing observed tracks", async () => {
    await mount();
    const group = document.querySelector<HTMLElement>('[role="menuitem"][aria-expanded]');
    expect(group?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => group?.click());
    await settle();
    const first = radios().find((item) => item.textContent?.includes("release A"));
    const second = radios().find((item) => item.textContent?.includes("release B"));
    expect(first?.textContent).toContain("MKV");
    expect(first?.textContent).toContain("2023");
    expect(first?.getAttribute("aria-label")).toContain("Harbour UHD release A");
    expect(first?.getAttribute("aria-label")).toContain("MKV");
    expect(first?.getAttribute("aria-label")).toContain("2023");
    expect(first?.textContent).toContain("English sound · No subtitles");
    expect(first?.querySelector('[aria-label="Tracks read locally"]')).not.toBeNull();
    expect(second?.textContent).toContain("MP4");
    expect(second?.textContent).toContain("Standard");
    expect(second?.textContent).not.toContain("No subtitles");
    expect(second?.querySelector('[aria-label="Tracks read locally"]')).toBeNull();
    expect(radios()).toHaveLength(6);
  });

  it("picks the disclosed exact file and saves it with its provider, without playing it", async () => {
    const page = await mount();
    await act(async () =>
      document.querySelector<HTMLElement>('[role="menuitem"][aria-expanded]')?.click(),
    );
    await settle();
    await act(async () =>
      radios()
        .find((item) => item.textContent?.includes("release B"))
        ?.click(),
    );
    await settle();
    expect(page.picked).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: SUBSCRIPTION, id: "second" }),
    );
    expect(ipc.argsOf("subscription.updatePreferences")).toContainEqual({
      subscriptionId: SUBSCRIPTION,
      patch: { titleVersions: { "movie:603": "second" } },
    });
    expect(ipc.methods()).not.toContain("playback.openTitle");
  });

  it("supports keyboard disclosure and closes back to its trigger with Escape", async () => {
    const page = await mount();
    const group = document.querySelector<HTMLElement>('[role="menuitem"][aria-expanded]');
    await act(async () => {
      group?.focus();
      group?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      );
    });
    expect(group?.getAttribute("aria-expanded")).toBe("true");
    await act(async () =>
      group?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
      ),
    );
    expect(group?.getAttribute("aria-expanded")).toBe("false");
    await act(async () =>
      group?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(page.container.querySelector('[aria-label="Versions"]'));
  });

  it("counts read files and collapses repeated track languages without promising every episode's tracks", async () => {
    await mount({
      ...film,
      kind: "series",
      versions: [
        {
          ...film.versions[1]!,
          observed: { files: 2, audio: ["en", "eng"], subtitles: ["nl", "nld"] },
        },
        film.versions[2]!,
      ],
    });
    await act(async () =>
      document.querySelector<HTMLElement>('[role="menuitem"][aria-expanded]')?.click(),
    );
    await settle();
    expect(radios().find((item) => item.textContent?.includes("release A"))?.textContent).toContain(
      "Read 2 files · English sound · Nederlands subtitles",
    );
    expect(
      radios().find((item) => item.textContent?.includes("release B"))?.textContent,
    ).not.toContain("Read 2 files");
  });
});
