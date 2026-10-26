// @vitest-environment happy-dom
// A film's details play the version they were opened on when the opener named one, as the 4K tab
// names a film's 4K version, even when it is the version the film shows first and another has
// progress, unless the viewer picked a version for the film.
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { defaultSubscriptionPreferences } from "@mrstreamer/contracts/preferences";
import type { TitleProgress } from "@mrstreamer/contracts/viewing";
import { DetailsView } from "../../src/renderer/src/features/titles/DetailsView.tsx";
import { queries } from "../../src/renderer/src/lib/queries.ts";

/** A film in two versions: HD, shown first, and 4K, added earlier. */
const film: Title = {
  kind: "movie",
  key: "movie:hd",
  subscriptionId: SUBSCRIPTION,
  id: "hd",
  name: "Night Harbour 1080p (EN)",
  title: "Night Harbour",
  originalTitle: null,
  originalLanguage: "en",
  tags: ["EN", "1080p"],
  year: 2024,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: "603",
  genres: [],
  versions: [
    { subscriptionId: SUBSCRIPTION, id: "hd", tags: ["EN", "1080p"] },
    { subscriptionId: SUBSCRIPTION, id: "4k", tags: ["EN", "4K"] },
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

/** Lets the sheet's timers and answers run on the fake clock. */
const settled = (ms = 10) => act(() => vi.advanceTimersByTimeAsync(ms));

/** Runs the fake clock on until `check` passes. */
const until = (check: () => void) =>
  vi.waitFor(
    async () => {
      await settled();
      check();
    },
    { interval: 1 },
  );

/**
 * Opens the details on version `id`, with `picks` as what the viewer left its subscription at,
 * and says which version's details they ask for.
 */
async function opened(
  id: string,
  picks = defaultSubscriptionPreferences,
  { title = film, asked = false, played = [] as readonly TitleProgress[] } = {},
): Promise<string | undefined> {
  // A second open in one test replaces the first, so its page and requests are its own.
  unmount();
  ipc.reset();
  ipc.always("ondemand.details", {
    kind: "movie",
    title,
    originalTitle: null,
    plot: null,
    genres: [],
    cast: [],
    directors: [],
    releaseDate: null,
    duration: null,
    backdropUrl: null,
  });
  const listed = ipc.hold("ondemand.titles");
  const progress = ipc.hold("viewing.progress");
  const client = new QueryClient();
  client.setQueryData(["subscriptions"], [SAVED]);
  client.setQueryData(queries.subscriptionPreferences(SUBSCRIPTION).queryKey, picks);
  const view = queryView(client);
  await view.render(
    createElement(DetailsView, {
      target: { kind: "movie", subscriptionId: SUBSCRIPTION, id, asked },
    }),
  );
  unmount = view.unmount;
  await act(async () => listed.resolve([title]));
  await act(async () => progress.resolve(played));
  // Wait for the public request and rendered answer, rather than guessing React Query's timing.
  await until(() => expect(ipc.argsOf("ondemand.details").at(-1)).toBeDefined());
  await until(() => expect(document.body.textContent).not.toContain("Loading…"));
  const requested = ipc.argsOf("ondemand.details").at(-1);
  // Asked of the subscription that lists the film, and of no other.
  expect(requested?.version.subscriptionId ?? SUBSCRIPTION).toBe(SUBSCRIPTION);
  return requested?.version.id;
}

describe("a film's details", () => {
  it.each(["4K", "HD"])("keeps the Play line minimal for a single %s file", async (quality) => {
    const version = { subscriptionId: SUBSCRIPTION, id: "plain", tags: [quality] };
    expect(
      await opened("plain", defaultSubscriptionPreferences, {
        title: { ...film, id: "plain", tags: [quality], versions: [version] },
      }),
    ).toBe("plain");
    expect(document.body.textContent).toContain(quality);
    expect(document.body.textContent).not.toContain("Standard");
  });
  it("names the selected same-hint file by the menu's source order even when ranked newest first", async () => {
    const versions = [
      {
        subscriptionId: SUBSCRIPTION,
        id: "newer",
        tags: ["4K"],
        name: "Night Harbour second release",
        listedOrder: 1,
        addedAt: 2,
      },
      {
        subscriptionId: SUBSCRIPTION,
        id: "older",
        tags: ["UHD"],
        name: "Night Harbour first release",
        listedOrder: 0,
        addedAt: 1,
      },
    ];
    expect(
      await opened("newer", defaultSubscriptionPreferences, {
        title: { ...film, id: "newer", tags: ["4K"], versions },
      }),
    ).toBe("newer");
    expect(document.body.textContent).toContain("4K · Version 2");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Versions"]')?.click(),
    );
    await settled(20);
    await act(async () =>
      document.querySelector<HTMLElement>('[role="menuitem"][aria-expanded]')?.click(),
    );
    await settled(20);
    const newer = [...document.querySelectorAll('[role="menuitemradio"]')].find((row) =>
      row.textContent?.includes("second release"),
    );
    expect(newer?.textContent).toContain("Version 2");
  });

  it("play the 4K version when opened from the 4K tab", async () => {
    expect(await opened("4k")).toBe("4k");
  });

  it("play the version that suits best when opened on it", async () => {
    expect(await opened("hd")).toBe("hd");
  });

  it("play the 4K version from the 4K tab when it is the one shown first, though HD has progress", async () => {
    const fourKFirst: Title = { ...film, id: "4k", versions: film.versions.toReversed() };
    const halfway: TitleProgress = {
      title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "hd" },
      position: 3000,
      duration: 6000,
      finished: false,
      at: 1,
      since: 1,
    };

    expect(
      await opened("4k", defaultSubscriptionPreferences, {
        title: fourKFirst,
        asked: true,
        played: [halfway],
      }),
    ).toBe("4k");
    // Opened anywhere else, it carries on where the viewer stopped.
    expect(
      await opened("4k", defaultSubscriptionPreferences, { title: fourKFirst, played: [halfway] }),
    ).toBe("hd");
  });

  it("play the remembered version on an ordinary unasked open", async () => {
    const picked = { ...defaultSubscriptionPreferences, titleVersions: { "movie:603": "hd" } };
    expect(await opened("4k", picked)).toBe("hd");
  });
});
