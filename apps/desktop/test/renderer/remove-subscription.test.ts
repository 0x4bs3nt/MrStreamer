// @vitest-environment happy-dom
// Remove in Settings > Subscriptions names the subscription and says what stops and what stays.
// It keeps the account's favourites, history and progress, unless the viewer ticks the box to
// delete them too, and takes only that subscription out of what the app shows. A title that
// plays from it has how far it got saved before the subscription goes.
import { ipc } from "./support.ts";
import { browseChannels, browseResult } from "./browse-support.ts";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Download } from "@mrstreamer/contracts/downloads";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { SubscriptionSection } from "../../src/renderer/src/features/settings/SubscriptionSection.tsx";
import { player } from "../../src/renderer/src/player/player.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  titlePlayer.close();
  player.reset();
  useUi.setState({ details: null, settings: null, watching: false });
  vi.useRealTimers();
});

/** Lets the section take in what was just answered, on the test's clock. */
const settled = () => act(() => vi.advanceTimersByTimeAsync(20));

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
const openlist = subscription("openlist", "Openlist playlist");

const channelOf = (owner: SubscriptionSummary): LiveChannel => ({
  subscriptionId: owner.id,
  id: "2014",
  name: "BE | VRT 1",
  title: "VRT 1",
  tags: [],
  number: 1,
  logoUrl: null,
  categoryIds: [],
  catchupDays: null,
  variants: [{ id: "2014", name: "BE | VRT 1", tags: [], quality: null }],
});

/**
 * Holds what the section reads of the saved subscriptions and their lists, as it opens and again
 * once one of them went. What it returns answers that: `left` as the ones saved, with none of
 * their lists loaded.
 */
function reads() {
  const subscriptions = ipc.hold("subscription.list");
  const channels = ipc.hold("library.status");
  const guides = ipc.hold("guide.status");
  const titles = ipc.hold("ondemand.status");
  return async (left: readonly SubscriptionSummary[]) => {
    await act(async () => {
      subscriptions.resolve(left);
      channels.resolve([]);
      guides.resolve([]);
      titles.resolve({ lists: [], metadata: null });
    });
    await settled();
  };
}

/** The section with `saved` subscriptions, and the question Remove asks about `removed`. */
async function removing(
  saved: readonly SubscriptionSummary[],
  removed: SubscriptionSummary,
  downloads: readonly Download[] = [],
) {
  ipc.reset();
  // The question reads the downloads, for whether any end with the subscription.
  ipc.always("downloads.list", { items: downloads, bytes: 0, free: null, ended: 0 });
  const opened = reads();
  const client = new QueryClient();
  client.setQueryData(["subscriptions"], saved);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(SubscriptionSection))),
  );
  unmount = () => act(() => root.unmount());
  await opened(saved);
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((each) => each.textContent?.trim() === text);
  const click = async (element: Element | undefined | null) => {
    await act(async () => (element as HTMLElement | undefined | null)?.click());
    await settled();
  };
  const row = [...container.querySelectorAll("li")].find((each) =>
    each.textContent?.startsWith(removed.name ?? ""),
  );
  // Its details hold Remove, at their foot; one subscription alone shows them already.
  if (saved.length > 1) await click(row?.querySelector("button"));
  await click(button(`Remove ${removed.name}`));
  return { container, client, button, click };
}

describe("removing a subscription", () => {
  it("says its unfinished downloads end and its copies stay", async () => {
    const of = (id: string, status: Download["status"], subscriptionId: string): Download => ({
      id,
      title: { kind: "movie", id },
      subscription: { id: subscriptionId, name: "" },
      name: id,
      episodeName: null,
      year: null,
      duration: null,
      originalLanguage: null,
      posterUrl: null,
      wideUrl: null,
      size: null,
      status,
      progress: null,
    });
    const { container } = await removing([northline, holiday], holiday, [
      of("queued", { kind: "queued" }, holiday.id),
      of("waiting", { kind: "waiting" }, holiday.id),
      of("copy", { kind: "complete" }, holiday.id),
      of("other", { kind: "queued" }, northline.id),
    ]);
    expect(container.textContent).toContain(
      "Its 2 unfinished downloads end. Downloaded copies stay.",
    );
  });

  it.each([
    { ticked: false, eraseViewing: false },
    { ticked: true, eraseViewing: true },
  ])(
    "asks to delete the viewing record only when ticked: $ticked",
    async ({ ticked, eraseViewing }) => {
      const { container, button, click } = await removing([northline, holiday], holiday);
      expect(container.textContent).toContain(
        "Remove Holiday house, and the lists loaded with it, from this device?",
      );
      const box = container.querySelector('[role="checkbox"]');
      expect(box?.getAttribute("aria-checked")).toBe("false");
      // The label, as the viewer clicks its text or the box inside it.
      if (ticked) await click(box?.closest("label"));

      await click(button("Remove"));

      expect(ipc.argsOf("subscription.remove")).toEqual([
        { subscriptionId: holiday.id, eraseViewing },
      ]);
    },
  );

  it("says what stops and what stays when its stream plays, and stops that stream first", async () => {
    await act(async () => player.watch(channelOf(northline)));
    useUi.setState({ details: { kind: "movie", subscriptionId: holiday.id, id: "91001" } });
    const { container, client, button, click } = await removing(
      [northline, holiday, openlist],
      northline,
    );

    expect(container.textContent).toContain(
      "VRT 1 is playing from it and stops. Holiday house and Openlist playlist stay.",
    );

    const answer = ipc.hold("subscription.remove");
    await click(button("Remove"));
    expect(player.current()).toBeNull();
    await act(async () => answer.resolve(null));
    await settled();

    // The others are still listed, and what was open of another subscription stays open.
    expect(client.getQueryData(["subscriptions"])).toEqual([holiday, openlist]);
    expect(container.textContent).not.toContain("Northline");
    expect(useUi.getState().details).toMatchObject({ subscriptionId: holiday.id });
  });

  it("has how far its title got saved before it asks for the subscription to go", async () => {
    const { container, button, click } = await removing([northline, holiday], holiday);
    const film = { kind: "movie", subscriptionId: holiday.id, id: "91001" } as const;
    const opened = ipc.hold("playback.openTitle");
    await act(
      async () =>
        void titlePlayer.open(
          {
            kind: "provider",
            title: film,
            name: "Blow",
            detail: "2001",
            artworkUrl: null,
            originalLanguage: "en",
          },
          600,
        ),
    );
    await act(async () =>
      opened.resolve({
        sessionId: "s1",
        title: film,
        url: "http://127.0.0.1/title/s1.mp4",
        duration: 6000,
        audio: [],
        subtitles: [],
      }),
    );
    expect(container.textContent).toContain("Blow is playing from it and stops.");

    const saved = ipc.hold("viewing.recordProgress");
    await click(button("Remove"));

    // The title closed, and the removal waits for the answer about where it stopped.
    expect(titlePlayer.state().now).toBeNull();
    expect(ipc.argsOf("viewing.recordProgress")).toMatchObject([
      { title: film, position: 600, duration: 6000 },
    ]);
    expect(ipc.argsOf("subscription.remove")).toEqual([]);

    await act(async () =>
      saved.resolve({ favourites: [], recent: [], continueWatching: [], marked: [], sequence: 1 }),
    );

    expect(ipc.argsOf("subscription.remove")).toEqual([
      { subscriptionId: holiday.id, eraseViewing: false },
    ]);
  });

  it("leaves what plays from another subscription, and says nothing of it", async () => {
    const playing = channelOf(northline);
    await act(async () => player.watch(playing));
    const { container, button, click } = await removing([northline, holiday], holiday);

    expect(container.textContent).not.toContain("is playing from it");

    const answer = ipc.hold("subscription.remove");
    await click(button("Remove"));
    await act(async () => answer.resolve(null));
    await settled();

    expect(player.current()).toEqual(playing);
    // The one left is alone now, and shows its details as a single subscription does.
    expect(container.querySelector('[role="region"]')?.textContent).toContain("Remove Northline");
  });

  it("forgets a channel of it the page tried meanwhile, once what stays is read again", async () => {
    const gone = channelOf(northline);
    await act(async () => player.watch(gone));
    const { button, click } = await removing([northline, holiday], northline);

    const answer = ipc.hold("subscription.remove");
    const again = reads();
    await click(button("Remove"));
    // The page under Settings previews the channel watched last, which its record still says is
    // this one, and the main process refuses a channel of a subscription that went.
    const refused = ipc.hold("playback.open");
    await act(async () => player.preview(gone));
    await act(async () => refused.reject({ kind: "no-subscription" }));
    expect(player.state()).toMatchObject({ channel: gone, phase: { kind: "failed" } });

    await act(async () => answer.resolve(null));
    await again([holiday]);

    // Nothing of it is left to stand failed where the page previews what was watched before it.
    expect(player.current()).toBeNull();
  });

  it("leaves a channel of another subscription that started meanwhile", async () => {
    await act(async () => player.watch(channelOf(northline)));
    const { button, click } = await removing([northline, holiday], northline);

    const answer = ipc.hold("subscription.remove");
    const again = reads();
    await click(button("Remove"));
    const other = channelOf(holiday);
    await act(async () => player.watch(other));
    await act(async () => answer.resolve(null));
    await again([holiday]);

    expect(player.current()).toEqual(other);
  });

  it("leaves a channel of it the page started again when the removal failed", async () => {
    const kept = channelOf(northline);
    await act(async () => player.watch(kept));
    const { container, button, click } = await removing([northline, holiday], northline);

    const answer = ipc.hold("subscription.remove");
    await click(button("Remove"));
    await act(async () => player.preview(kept));
    await act(async () => answer.reject({ kind: "unexpected", detail: "The disk is full." }));
    await settled();

    expect(container.textContent).toContain("Something went wrong: The disk is full.");
    expect(player.current()).toEqual(kept);
  });

  it("restores a source read as absent while its removal was later refused", async () => {
    const { container, client, button, click } = await removing([northline, holiday], northline);
    const answer = ipc.hold("subscription.remove");
    await click(button("Remove"));
    // Main temporarily excludes the source before an erase or login deletion can be refused.
    ipc.always("subscription.list", [holiday]);
    await act(async () => client.refetchQueries({ queryKey: ["subscriptions"] }));
    await settled();
    expect(container.textContent).not.toContain("Northline");
    ipc.always("subscription.list", [northline, holiday]);
    ipc.always("library.status", []);
    ipc.always("guide.status", []);
    ipc.always("ondemand.status", { lists: [], metadata: null });
    await act(async () => answer.reject({ kind: "unexpected", detail: "Login deletion refused." }));
    await settled();
    expect(container.textContent).toContain("Northline");
    expect(container.textContent).toContain("Holiday house");
  });

  it.each([
    { cached: false, held: true, inactive: false },
    { cached: true, held: true, inactive: false },
    { cached: false, held: false, inactive: false },
    { cached: false, held: true, inactive: true },
  ])(
    "restores browse membership after refused removal, cached=$cached held=$held inactive=$inactive",
    async ({ cached, held, inactive }) => {
      const { container, client, button, click } = await removing([northline, holiday], northline);
      const answer = ipc.hold("subscription.remove");
      await click(button("Remove"));
      const options = browseChannels(null);
      const result = (owners: readonly SubscriptionSummary[]) =>
        browseResult(owners.map(channelOf));
      if (cached) client.setQueryData(options.queryKey, result([northline, holiday]));
      const during = ipc.hold("library.browse");
      const observer = new QueryObserver(client, { ...options, refetchOnMount: "always" });
      const asked = inactive ? client.fetchQuery(options) : undefined;
      let stop = inactive ? () => {} : observer.subscribe(() => {});
      try {
        expect(ipc.argsOf("library.browse")).toHaveLength(1);
        if (!held) {
          await act(async () => during.resolve(result([holiday])));
          await settled();
        }
        // Main restores the source before refusing. An older first browse read may still finish
        // afterward, captured while main temporarily excluded it, without a cached answer to replace.
        ipc.always("library.browse", result([northline, holiday]));
        ipc.always("subscription.list", [northline, holiday]);
        ipc.always("library.status", []);
        ipc.always("guide.status", []);
        ipc.always("ondemand.status", { lists: [], metadata: null });
        await act(async () =>
          answer.reject({ kind: "unexpected", detail: "Login deletion refused." }),
        );
        await settled();
        expect(container.textContent).toContain("Login deletion refused.");
        if (held) await act(async () => during.resolve(result([holiday])));
        await settled();
        await settled();
        if (inactive) {
          await expect(asked).resolves.toEqual(result([holiday]));
          expect(client.getQueryState(options.queryKey)?.isInvalidated).toBe(true);
          stop = observer.subscribe(() => {});
          await settled();
        }
        expect(
          observer.getCurrentResult().data?.channels.map(({ subscriptionId }) => subscriptionId),
        ).toEqual([northline.id, holiday.id]);
        expect(ipc.argsOf("library.browse")).toHaveLength(2);
      } finally {
        stop();
        client.clear();
      }
    },
  );

  it("says the only subscription's removal returns to Connect, and keeps it on Keep", async () => {
    const { container, button, click } = await removing([northline], northline);

    expect(container.textContent).toContain(
      "It's your only subscription, so Mr. Streamer returns to Connect.",
    );

    await click(button("Keep"));

    expect(container.textContent).not.toContain("from this device?");
    expect(ipc.argsOf("subscription.remove")).toEqual([]);
  });

  it("offers neither Keep nor the box while a removal is on its way, and both when it failed", async () => {
    const { container, button, click } = await removing([northline, holiday], holiday);
    const box = () => container.querySelector('[role="checkbox"]');

    const answer = ipc.hold("subscription.remove");
    await click(button("Remove"));
    await click(box()?.closest("label"));

    expect(button("Keep")?.disabled).toBe(true);
    expect(box()?.getAttribute("aria-checked")).toBe("false");

    await act(async () => answer.reject({ kind: "unexpected", detail: "The disk is full." }));
    await settled();

    expect(container.textContent).toContain("Something went wrong: The disk is full.");
    await click(box()?.closest("label"));
    expect(box()?.getAttribute("aria-checked")).toBe("true");
    await click(button("Keep"));
    expect(container.textContent).not.toContain("from this device?");
    expect(ipc.argsOf("subscription.remove")).toEqual([
      { subscriptionId: holiday.id, eraseViewing: false },
    ]);
  });
});
