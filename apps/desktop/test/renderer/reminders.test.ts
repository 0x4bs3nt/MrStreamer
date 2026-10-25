// @vitest-environment happy-dom
// The reminders' bell in Live TV's header and the notice a reminder that told shows on every page:
// what each says, the cross that takes one out and where the keys go then, whether main's word of
// the change or its answer comes first and when rows go together, what a failed save, an empty
// list and a list that can't be read say, and Watch and Dismiss.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { Reminder, ReminderList } from "@mrstreamer/contracts/reminders";
import { formatDate } from "@mrstreamer/core/i18n";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { ReminderBanners } from "../../src/renderer/src/features/reminders/ReminderBanners.tsx";
import { RemindersMenu } from "../../src/renderer/src/features/reminders/RemindersMenu.tsx";
import { syncReminders } from "../../src/renderer/src/lib/reminders.ts";
import { player } from "../../src/renderer/src/player/player.ts";

// 21:00 on a day without a clock change, running on in real time.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 9, 14, 21, 0, 0));
});
afterAll(() => vi.useRealTimers());

const MINUTE = 60_000;
const NOW = new Date(2026, 9, 14, 21, 0, 0).getTime();

const channel: LiveChannel = {
  subscriptionId: SUBSCRIPTION,
  id: "11",
  name: "Eurosport 1 HD",
  title: "Eurosport 1",
  tags: [],
  number: 11,
  logoUrl: null,
  categoryIds: [],
  variants: [{ id: "11", name: "Eurosport 1 HD", tags: [], quality: null }],
  catchupDays: null,
};

const reminder = (id: string, minutes: number, changes: Partial<Reminder> = {}): Reminder => ({
  id,
  channel: { subscriptionId: SUBSCRIPTION, id: "11" },
  streams: ["11"],
  channelName: "Eurosport 1",
  start: NOW + minutes * MINUTE,
  stop: NOW + (minutes + 60) * MINUTE,
  title: id,
  status: { kind: "upcoming" },
  banner: false,
  ...changes,
});

let unmount = () => {};
afterEach(() => {
  unmount();
  player.reset();
});

const ready = (check: () => void) =>
  vi.waitFor(
    async () => {
      await act(async () => {});
      check();
    },
    { interval: 10 },
  );

/**
 * The bell and the notices, over a main process whose reminders are `list` and change with it.
 * `before` sets up what else it answers, before anything asks.
 */
async function shown(list: ReminderList, before: () => void = () => {}) {
  ipc.reset();
  before();
  let current = list;
  ipc.answer("reminders.list", () => current);
  ipc.answer("reminders.cancel", ({ id }) => {
    current = { ...current, reminders: current.reminders.filter((each) => each.id !== id) };
    return null;
  });
  ipc.answer("reminders.dismiss", ({ id }) => {
    current = {
      ...current,
      reminders: current.reminders.map((each) =>
        each.id === id ? { ...each, banner: false } : each,
      ),
    };
    return null;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stop = syncReminders(client);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const tree = (bell: boolean) =>
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        Fragment,
        null,
        bell && createElement(RemindersMenu),
        createElement(ReminderBanners),
      ),
    );
  await act(async () => root.render(tree(true)));
  unmount = () => {
    act(() => root.unmount());
    container.remove();
    stop();
    client.clear();
  };
  const bell = () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.getAttribute("aria-label")?.startsWith("Reminders"),
    )!;
  const cross = (title: string) =>
    document.querySelector<HTMLButtonElement>(
      `button[aria-label="Remove the reminder for ${title}"]`,
    )!;
  return {
    bell,
    /** The main process's list is now `next`, and it hasn't said so yet. */
    serve: (next: ReminderList) => {
      current = next;
    },
    /** The main process's list changes, and it says so. */
    change: (next: ReminderList) =>
      act(async () => {
        current = next;
        ipc.emit("reminders.changed", null);
      }),
    open: async () => {
      await act(async () => bell().click());
      await ready(() =>
        expect(
          document.querySelector(
            '[aria-label="Reminders"][role="dialog"], [aria-label="Reminders"][tabindex="-1"]',
          ),
        ).not.toBeNull(),
      );
    },
    /** Each line of the open list, its title then the rest. */
    rows: () =>
      [...document.querySelectorAll("li")].map((row) =>
        [...row.querySelectorAll("div > div")].map((line) => line.textContent),
      ),
    cross,
    /** The open list itself, which takes the keys when no cross is left. */
    popup: () => document.querySelector<HTMLElement>('[aria-label="Reminders"][tabindex="-1"]'),
    /** Takes `title` out with its cross from the keyboard. Main's answer waits for the test. */
    takeOut: async (title: string) => {
      const answer = ipc.hold("reminders.cancel");
      cross(title).focus();
      await act(async () => cross(title).click());
      await ready(() => expect(ipc.argsOf("reminders.cancel").at(-1)).toEqual({ id: title }));
      return answer;
    },
    press: (key: string) =>
      act(async () => {
        (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      }),
    /** Goes to another page, which has no bell. The notices and the list's reads stay. */
    leave: () => act(async () => root.render(tree(false))),
    /** Once nothing is being changed or read. */
    settled: () =>
      ready(() => {
        expect(client.isMutating()).toBe(0);
        expect(client.isFetching()).toBe(0);
      }),
    banner: () => container.querySelector("section"),
    click: (label: string, within: ParentNode = document) =>
      act(async () =>
        [...within.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.trim() === label)
          ?.click(),
      ),
  };
}

/** Main answers a cancel after saying its list changed; the list read on that can come back first. */
const orders = ["the change first", "the answer first"] as const;

describe("reminders", () => {
  it("counts those still to come on the bell, and lists each with how it stands", async () => {
    const page = await shown({
      notifications: null,
      reminders: [
        reminder("Missed one", -120, { status: { kind: "missed" } }),
        reminder("On one", -10, { status: { kind: "told", at: NOW - 10 * MINUTE } }),
        reminder("Upcoming", 30),
        reminder("Changed", 60, { status: { kind: "changed", was: "Masters Final" } }),
        reminder("Gone", 24 * 60, { status: { kind: "gone" } }),
      ],
    });
    await ready(() => expect(page.bell().getAttribute("aria-label")).toBe("Reminders, 3 to come"));
    expect(page.bell().textContent).toBe("3");
    await page.open();
    const time = (minutes: number) => formatDate(NOW + minutes * MINUTE, "time");
    expect(page.rows()).toEqual([
      ["Missed one", `Today ${time(-120)} · Eurosport 1 · Missed`],
      ["On one", `Today ${time(-10)} · Eurosport 1 · On now`],
      ["Upcoming", `Today ${time(30)} · Eurosport 1`],
      ["Changed", `Today ${time(60)} · Eurosport 1 · was Masters Final`],
      ["Gone", `Tomorrow ${time(24 * 60)} · Eurosport 1 · Not in the guide now`],
    ]);
  });

  it("takes one out with its cross, handing the keys to the next, and says when that fails", async () => {
    const page = await shown({
      notifications: null,
      reminders: [reminder("First", 30), reminder("Second", 60)],
    });
    await page.open();
    await ready(() => expect(page.rows()).toHaveLength(2));
    page.cross("First").focus();
    await act(async () => page.cross("First").click());
    await ready(() => expect(page.rows().map(([title]) => title)).toEqual(["Second"]));
    expect(ipc.argsOf("reminders.cancel")).toEqual([{ id: "First" }]);
    expect(document.activeElement).toBe(page.cross("Second"));
    await ready(() => expect(page.bell().getAttribute("aria-label")).toBe("Reminders, 1 to come"));

    ipc.refuse("reminders.cancel", { kind: "unexpected", detail: "disk full" });
    await act(async () => page.cross("Second").click());
    await ready(() =>
      expect(document.querySelector('li [role="alert"]')?.textContent).toBe(
        "Couldn't remove. Try again.",
      ),
    );
    expect(page.rows().map(([title]) => title)).toEqual(["Second"]);
  });

  it("says how to set one when there are none, and why when they can't be read", async () => {
    const page = await shown({ notifications: null, reminders: [] });
    await page.open();
    await ready(() =>
      expect(document.body.textContent).toContain(
        "No reminders yet.Set one on a programme still to come. Mr. Streamer reminds you while it's open.",
      ),
    );
    expect(page.bell().getAttribute("aria-label")).toBe("Reminders");

    ipc.refuse("reminders.list", { kind: "reminder", reason: "unreadable" });
    await page.change({ notifications: null, reminders: [] });
    await ready(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Couldn't read your reminders.",
      ),
    );
    ipc.always("reminders.list", { notifications: null, reminders: [reminder("Back", 30)] });
    await page.click("Retry");
    await ready(() => expect(page.rows().map(([title]) => title)).toEqual(["Back"]));
  });

  it("says when the system didn't show the last notice, and that they show here meanwhile", async () => {
    const page = await shown({ notifications: "failed", reminders: [reminder("Upcoming", 30)] });
    await page.open();
    await ready(() =>
      expect(document.body.textContent).toContain(
        "The system didn't show the last reminder. Reminders still show here while the app is open.",
      ),
    );
  });

  it("shows the notice of one that told, which watches the channel live or goes", async () => {
    const page = await shown(
      {
        notifications: null,
        reminders: [
          reminder("Ski Jumping", 0, { banner: true, status: { kind: "told", at: NOW } }),
        ],
      },
      () => ipc.answer("library.channel", () => channel),
    );
    await ready(() =>
      expect(page.banner()?.textContent).toBe("Starts nowSki JumpingEurosport 1WatchDismiss"),
    );
    expect(page.banner()?.querySelector('[role="status"]')).not.toBeNull();
    await ready(() =>
      expect(
        [...page.banner()!.querySelectorAll("button")].find((b) => b.textContent === "Watch")
          ?.disabled,
      ).toBe(false),
    );
    await page.click("Watch", page.banner()!);
    expect(player.state().channel).toMatchObject({ subscriptionId: SUBSCRIPTION, id: "11" });
    expect(useUi.getState().watching).toBe(true);
    expect(ipc.argsOf("reminders.dismiss")).toEqual([{ id: "Ski Jumping" }]);
    await page.change({
      notifications: null,
      reminders: [reminder("Ski Jumping", 0, { status: { kind: "told", at: NOW } })],
    });
    await ready(() => expect(page.banner()).toBeNull());
  });

  it("says how late one told, and that a channel the lists no longer show can't be watched", async () => {
    const page = await shown(
      {
        notifications: null,
        reminders: [
          reminder("Late Film", -12, { banner: true, status: { kind: "told", at: NOW } }),
        ],
      },
      () => ipc.refuse("library.channel", { kind: "channel-not-found", channelId: "11" }),
    );
    await ready(() =>
      expect(page.banner()?.textContent).toBe(
        "Started 12 min agoLate FilmEurosport 1 · Not available nowWatchDismiss",
      ),
    );
    const watch = [...page.banner()!.querySelectorAll("button")].find(
      (button) => button.textContent === "Watch",
    );
    expect(watch?.disabled).toBe(true);
    await page.click("Dismiss", page.banner()!);
    expect(ipc.argsOf("reminders.dismiss")).toEqual([{ id: "Late Film" }]);
  });
});

describe("the keys as a reminder's row goes", () => {
  const positions = [
    { which: "first", titles: ["First", "Second", "Third"], out: "First", next: "Second" },
    { which: "last", titles: ["First", "Second", "Third"], out: "Third", next: "Second" },
    { which: "only", titles: ["Only"], out: "Only", next: null },
  ];

  it.each(orders.flatMap((order) => positions.map((position) => ({ order, ...position }))))(
    "hands them from the $which row's cross on as the row goes, $order",
    async ({ order, titles, out, next }) => {
      const all = titles.map((title, at) => reminder(title, 30 * (at + 1)));
      const rest = { notifications: null, reminders: all.filter((each) => each.id !== out) };
      const page = await shown({ notifications: null, reminders: all });
      await page.open();
      await ready(() => expect(page.rows()).toHaveLength(all.length));
      const answer = await page.takeOut(out);
      const target = () => (next ? page.cross(next) : page.popup());

      if (order === "the change first") await page.change(rest);
      else {
        page.serve(rest);
        await act(async () => answer.resolve(null));
      }
      await ready(() =>
        expect(page.rows().map(([title]) => title)).toEqual(rest.reminders.map((each) => each.id)),
      );
      expect(document.activeElement).toBe(target());

      // The other one comes as well, and moves nothing.
      if (order === "the change first") await act(async () => answer.resolve(null));
      else await page.change(rest);
      await page.settled();
      expect(document.activeElement).toBe(target());
      expect(ipc.argsOf("reminders.cancel")).toEqual([{ id: out }]);
    },
  );

  /**
   * Five rows, `out` taken out one after the other from the keyboard while main's answers wait,
   * so that one change of main's list takes them all out together.
   */
  async function takingOut(out: readonly string[]) {
    const all = ["A", "B", "C", "D", "E"].map((title, at) => reminder(title, 30 * (at + 1)));
    const page = await shown({ notifications: null, reminders: all });
    await page.open();
    await ready(() => expect(page.rows()).toHaveLength(all.length));
    const answers: Awaited<ReturnType<typeof page.takeOut>>[] = [];
    for (const title of out) answers.push(await page.takeOut(title));
    const rest = { notifications: null, reminders: all.filter((each) => !out.includes(each.id)) };
    const answer = () => act(async () => answers.forEach((each) => each.resolve(null)));
    /** Main's list loses them: the change and the answers in `order`, until all is read. */
    const lose = async (order: (typeof orders)[number]) => {
      if (order === "the change first") await page.change(rest);
      else {
        page.serve(rest);
        await answer();
      }
      const left = rest.reminders.map((each) => each.id).join();
      await ready(() =>
        expect(
          page.popup() === null ||
            page
              .rows()
              .map(([title]) => title)
              .join() === left,
        ).toBe(true),
      );
      if (order === "the change first") await answer();
      else await page.change(rest);
      await page.settled();
    };
    return { page, rest, answer, lose };
  }

  /** Each element the keys land on from now, by its label. */
  const landings = () => {
    const landed: string[] = [];
    const land = ({ target }: FocusEvent) =>
      landed.push((target as Element).getAttribute("aria-label") ?? (target as Element).tagName);
    document.addEventListener("focus", land, true);
    onTestFinished(() => document.removeEventListener("focus", land, true));
    return landed;
  };

  const together = [
    { to: "on to the next row left", out: ["D", "C", "B"], target: "E" },
    { to: "back to the row left before", out: ["C", "E", "D"], target: "B" },
    { to: "to the popup once every row went", out: ["A", "C", "D", "E", "B"], target: null },
  ];

  it.each(orders.flatMap((order) => together.map((shape) => ({ order, ...shape }))))(
    "hands them once, $to, past the rows going in the same change, $order",
    async ({ order, out, target }) => {
      const { page, rest, lose } = await takingOut(out);
      const landed = landings();
      await lose(order);
      expect(page.popup()).not.toBeNull();
      expect(page.rows().map(([title]) => title)).toEqual(rest.reminders.map((each) => each.id));
      expect(document.activeElement).toBe(target ? page.cross(target) : page.popup());
      expect(landed).toEqual([target ? `Remove the reminder for ${target}` : "Reminders"]);
    },
  );

  it.each(orders)("leaves them where the viewer took them meanwhile, %s", async (order) => {
    const { page, lose } = await takingOut(["D", "C", "B"]);
    page.cross("A").focus();
    const landed = landings();
    await lose(order);
    expect(page.popup()).not.toBeNull();
    expect(document.activeElement).toBe(page.cross("A"));
    expect(landed).toEqual([]);
  });

  it("keeps them on a cross whose removal fails, through a change that keeps its row", async () => {
    const all = [reminder("First", 30), reminder("Second", 60)];
    const page = await shown({ notifications: null, reminders: all });
    await page.open();
    await ready(() => expect(page.rows()).toHaveLength(2));
    const answer = await page.takeOut("First");

    await page.change({
      notifications: null,
      reminders: [all[0]!, { ...all[1]!, status: { kind: "changed", was: "Masters Final" } }],
    });
    await ready(() => expect(page.rows()[1]?.[1]).toContain("was Masters Final"));
    await act(async () => answer.reject({ kind: "unexpected", detail: "disk full" }));
    await ready(() =>
      expect(document.querySelector('li [role="alert"]')?.textContent).toBe(
        "Couldn't remove. Try again.",
      ),
    );
    await page.settled();
    expect(page.rows().map(([title]) => title)).toEqual(["First", "Second"]);
    expect(document.activeElement).toBe(page.cross("First"));
  });

  it("hands nothing on once the list closed before the answers came", async () => {
    const { page, rest, answer } = await takingOut(["D", "C", "B"]);
    await page.press("Escape");
    await ready(() => expect(page.popup()).toBeNull());
    expect(document.activeElement).toBe(page.bell());
    const landed = landings();

    await page.change(rest);
    await answer();
    await page.settled();
    await ready(() => expect(page.bell().getAttribute("aria-label")).toBe("Reminders, 2 to come"));
    expect(page.popup()).toBeNull();
    expect(document.activeElement).toBe(page.bell());
    expect(landed).toEqual([]);
  });

  it("hands nothing on once the page went before the answers came", async () => {
    const { page, rest, answer } = await takingOut(["D", "C", "B"]);
    await page.leave();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    onTestFinished(() => elsewhere.remove());
    // The next page has the keys.
    elsewhere.focus();
    const landed = landings();

    await page.change(rest);
    await answer();
    await page.settled();
    expect(ipc.argsOf("reminders.cancel")).toEqual([{ id: "D" }, { id: "C" }, { id: "B" }]);
    expect(document.activeElement).toBe(elsewhere);
    expect(landed).toEqual([]);
  });
});
