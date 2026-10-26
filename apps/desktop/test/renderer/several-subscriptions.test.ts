// @vitest-environment happy-dom
// What the viewer sees of several subscriptions shown together: whose a channel is, only where
// another subscription lists one that reads the same; which subscription's channels couldn't be
// fetched, with the others showing; and, for a film two of them list, whose each version is,
// which one's progress resumes, and where a pick is kept.
import { browseChannels, browseResult } from "./browse-support.ts";
import { ipc } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogueStatus, LiveChannel } from "@mrstreamer/contracts/library";
import type { MovieDetails, Title } from "@mrstreamer/contracts/ondemand";
import { defaultSubscriptionPreferences } from "@mrstreamer/contracts/preferences";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import type { TitleProgress } from "@mrstreamer/contracts/viewing";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { GuidePage } from "../../src/renderer/src/features/live/GuidePage.tsx";
import { DetailsView } from "../../src/renderer/src/features/titles/DetailsView.tsx";
import { clockTime } from "../../src/renderer/src/lib/format.ts";
import { queries } from "../../src/renderer/src/lib/queries.ts";

const subscription = (id: string, name: string): SubscriptionSummary => ({
  kind: "xtream",
  id,
  name,
  server: `https://${id}.example`,
  username: "demo",
  account: { state: "active", expiresAt: null, maxConnections: 1, activeConnections: 0 },
  needsSecret: false,
});
const northline = subscription("northline", "Northline");
const holiday = subscription("holiday", "Holiday house");

// happy-dom lays nothing out, and the list draws only the rows that fit: the list gets a height
// and each row its own.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.dataset["index"] === undefined ? 900 : 60;
  },
});

let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
});

/** Lets the page take in what was just answered, on the test's clock. */
const settled = () => act(() => vi.advanceTimersByTimeAsync(20));

const channel = (owner: SubscriptionSummary, id: string, title: string): LiveChannel => ({
  subscriptionId: owner.id,
  id,
  name: `UK | ${title.toUpperCase()}`,
  title,
  tags: [],
  number: Number(id),
  logoUrl: null,
  categoryIds: ["uk"],
  catchupDays: null,
  variants: [{ id, name: `UK | ${title.toUpperCase()}`, tags: [], quality: null }],
});

/** Both list a BBC One, under the same id; only the first has an ITV1. */
const CHANNELS: readonly LiveChannel[] = [
  { ...channel(northline, "1", "BBC One"), ambiguous: true },
  channel(northline, "2", "ITV1"),
  { ...channel(holiday, "1", "BBC One"), ambiguous: true },
];

const loaded = (owner: SubscriptionSummary, channelCount: number): CatalogueStatus => ({
  subscriptionId: owner.id,
  channelCount,
  fetchedAt: 1,
  failure: null,
  failedAt: null,
});

/** Live TV on every channel of both, with their catalogues as the main process last said. */
async function liveTv(statuses: readonly CatalogueStatus[]) {
  ipc.reset();
  useUi.setState({ view: "live", list: { kind: "all" }, watching: false, searchOpen: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["subscriptions"], [northline, holiday]);
  // Both file their channels under a category of the same name, which shows as one.
  client.setQueryData(queries.categories().queryKey, [
    {
      subscriptionId: northline.id,
      id: "uk",
      members: [northline, holiday].map(({ id }) => ({ subscriptionId: id, id: "uk" })),
      name: "UK | NEWS",
      group: null,
      title: "News",
      channelCount: CHANNELS.length,
    },
  ]);
  client.setQueryData(browseChannels(null).queryKey, browseResult(CHANNELS));
  client.setQueryData(["library", "status"], statuses);
  client.setQueryData(queries.viewing().queryKey, {
    favourites: [],
    recent: [],
    continueWatching: [],
    marked: [],
    sequence: 1,
  });
  const mounted = queryView(client);
  const { container } = mounted;
  await mounted.render(createElement(GuidePage, { active: true }));
  unmount = mounted.unmount;
  await settled();
  return {
    container,
    /** Each channel's row as the viewer reads it, top to bottom. */
    rows: () => [...container.querySelectorAll("[data-index]")].map((row) => row.textContent ?? ""),
    text: () => container.querySelector("main")?.textContent ?? "",
  };
}

describe("Live TV with several subscriptions", () => {
  it("names the subscription on a channel another one lists by the same name, and on no other", async () => {
    const page = await liveTv([loaded(northline, 2), loaded(holiday, 1)]);

    const [first, only, second] = page.rows();
    expect(first).toContain("BBC One");
    expect(first).toContain("Northline");
    expect(second).toContain("BBC One");
    expect(second).toContain("Holiday house");
    expect(only).toContain("ITV1");
    expect(only).not.toMatch(/Northline|Holiday house/);
    // Nothing is said of a subscription whose channels arrived.
    expect(page.text()).not.toContain("hasn't answered");
  });

  it("says whose channels couldn't be fetched, shows the others, and retries that one alone", async () => {
    const failedAt = new Date().setHours(14, 2, 0, 0);
    const page = await liveTv([
      loaded(northline, 2),
      {
        ...loaded(holiday, 1),
        failure: { kind: "unreachable", server: holiday.server, detail: "No answer." },
        failedAt,
      },
    ]);

    expect(page.text()).toContain(
      `Holiday house hasn't answered since ${clockTime(failedAt, Date.now())}. Its channels show as they were then.`,
    );
    expect(page.text()).not.toContain("Northline hasn't");
    expect(page.rows()).toHaveLength(3);

    await act(async () =>
      page.container.querySelector<HTMLElement>('[aria-label="Retry Holiday house"]')?.click(),
    );

    expect(ipc.argsOf("library.refresh")).toEqual([{ subscriptionId: holiday.id }]);
  });
});

/** A film both list: the first as its 91001, in Dutch, the second as its 91000, in English. */
const film: Title = {
  kind: "movie",
  key: "movie:tmdb:603",
  subscriptionId: holiday.id,
  id: "91000",
  name: "Night Harbour (EN)",
  title: "Night Harbour",
  originalTitle: null,
  originalLanguage: "en",
  tags: ["EN"],
  year: 2024,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: "603",
  genres: [],
  versions: [
    { subscriptionId: holiday.id, id: "91000", tags: ["EN"] },
    { subscriptionId: northline.id, id: "91001", tags: ["NL"] },
  ],
};

const detailsOf = (version: Title["versions"][number]): MovieDetails => ({
  kind: "movie",
  title: { ...film, subscriptionId: version.subscriptionId, id: version.id },
  originalTitle: null,
  plot: null,
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: 6000,
  backdropUrl: null,
});

/** The film's details, opened on the second's version, with how far `played` got. */
async function filmSheet(played: readonly TitleProgress[], picks: Record<string, string> = {}) {
  ipc.reset();
  const listed = ipc.hold("ondemand.titles");
  const progress = ipc.hold("viewing.progress");
  const client = new QueryClient();
  client.setQueryData(["subscriptions"], [northline, holiday]);
  for (const { id } of [northline, holiday]) {
    client.setQueryData(queries.subscriptionPreferences(id).queryKey, {
      ...defaultSubscriptionPreferences,
      ...(picks[id] ? { titleVersions: { "movie:603": picks[id] } } : {}),
    });
  }
  const mounted = queryView(client);
  await mounted.render(
    createElement(DetailsView, {
      target: { kind: "movie", subscriptionId: holiday.id, id: "91000" },
    }),
  );
  unmount = mounted.unmount;
  const opened = ipc.hold("ondemand.details");
  await act(async () => listed.resolve([film]));
  await act(async () => progress.resolve(played));
  await settled();
  const [asked] = ipc.argsOf("ondemand.details").slice(-1);
  const version = film.versions.find(
    (each) => each.subscriptionId === asked?.version.subscriptionId,
  );
  if (!version) throw new Error("The sheet asked for no version's details.");
  await act(async () => opened.resolve(detailsOf(version)));
  await settled();
  const button = (label: string) =>
    [...document.body.querySelectorAll("button")].find(
      (each) => each.textContent?.trim() === label || each.getAttribute("aria-label") === label,
    );
  return { asked: asked?.version, button, text: () => document.body.textContent ?? "" };
}

describe("a film two subscriptions list", () => {
  it("says whose version plays, and names each one's subscription in Play's menu", async () => {
    const sheet = await filmSheet([]);

    expect(sheet.asked).toEqual({ subscriptionId: holiday.id, id: "91000" });
    // Under Play: what the version sounds like, and whose it is.
    expect(sheet.text()).toContain("English sound · Holiday house");

    await act(async () => sheet.button("Versions")?.click());
    await settled();
    const offered = [...document.body.querySelectorAll('[role="menuitemradio"]')].map(
      (item) => item.textContent ?? "",
    );
    expect(offered).toHaveLength(3);
    expect(offered[0]).toContain("Automatic");
    expect(
      offered.filter((each) => each.includes("Holiday house") && !each.includes("Automatic")),
    ).toHaveLength(1);
    expect(offered.filter((each) => each.includes("Northline"))).toHaveLength(1);
  });

  it("resumes only where the subscription that plays stopped, never where another did", async () => {
    const halfway = (owner: SubscriptionSummary, id: string): TitleProgress => ({
      title: { kind: "movie", subscriptionId: owner.id, id },
      position: 3000,
      duration: 6000,
      finished: false,
      at: 1,
      since: 1,
    });
    // Stopped halfway in the first's file, and the viewer picked the second's version since.
    const other = await filmSheet([halfway(northline, "91001")], { [holiday.id]: "91000" });
    expect(other.asked).toEqual({ subscriptionId: holiday.id, id: "91000" });
    expect(other.button("Play")).toBeDefined();
    expect(other.button("Resume")).toBeUndefined();

    unmount();
    const own = await filmSheet([halfway(holiday, "91000")], { [holiday.id]: "91000" });
    expect(own.button("Resume")).toBeDefined();
  });

  it("keeps a pick with the subscription of the version picked, and takes it out of the other", async () => {
    // The first's version was picked before.
    const sheet = await filmSheet([], { [northline.id]: "91001" });
    expect(sheet.asked).toEqual({ subscriptionId: northline.id, id: "91001" });

    await act(async () => sheet.button("Versions")?.click());
    await settled();
    const theirs = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (item) =>
        item.textContent?.includes("Holiday house") && !item.textContent.includes("Automatic"),
    );
    await act(async () => theirs?.click());
    await settled();

    expect(ipc.argsOf("subscription.updatePreferences")).toEqual(
      expect.arrayContaining([
        { subscriptionId: holiday.id, patch: { titleVersions: { "movie:603": "91000" } } },
        { subscriptionId: northline.id, patch: { titleVersions: {} } },
      ]),
    );
    expect(ipc.argsOf("subscription.updatePreferences")).toHaveLength(2);
  });
});
