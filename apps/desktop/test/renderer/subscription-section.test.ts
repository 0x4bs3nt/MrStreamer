// @vitest-environment happy-dom
// Settings > Subscriptions: every saved subscription as a row that says how it stands, opened to
// inspect and never to choose; adding one beside the others, renaming one, entering a password or
// link again where the keychain lost it, and retrying one that didn't answer. A playlist's Guide
// row tells a playlist that names no guide, which is no failure, from a guide that couldn't be
// had, and its refresh asks again either way. A subscription's guide can come from an XMLTV
// address of the viewer's own: its row says where from, what it covers and why a download
// failed, and its form checks an address before anything changes.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuideStatus } from "@mrstreamer/contracts/guide";
import type { CatalogueStatus, LiveChannel } from "@mrstreamer/contracts/library";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { SubscriptionSection } from "../../src/renderer/src/features/settings/SubscriptionSection.tsx";
import { formatDate } from "@mrstreamer/core/i18n";
import { clockTime, comingTime, pastTime } from "../../src/renderer/src/lib/format.ts";
import { player } from "../../src/renderer/src/player/player.ts";

let unmount = () => {};
afterEach(() => {
  unmount();
  player.reset();
  useUi.setState({ subscription: null });
});

const DAY_MS = 24 * 60 * 60 * 1000;
/** The day Northline runs to, as this machine writes a date. */
const EXPIRES = "2027-03-12T00:00:00.000Z";
const expiry = formatDate(Date.parse(EXPIRES), "date");
const account = (expiresAt: string | null = null): SubscriptionSummary["account"] => ({
  state: "active",
  expiresAt,
  maxConnections: 2,
  activeConnections: 1,
});

const northline: SubscriptionSummary = {
  kind: "xtream",
  id: "northline",
  name: "Northline",
  server: "https://panel.northline.example",
  username: "viewer01",
  account: account(EXPIRES),
  needsSecret: false,
};
const holiday: SubscriptionSummary = {
  kind: "xtream",
  id: "holiday",
  name: "Holiday house",
  server: "http://tv.sunhouse.example:8080",
  username: "viewer02",
  account: account(new Date(Date.now() + 12 * DAY_MS - 60_000).toISOString()),
  needsSecret: false,
};
const playlist: SubscriptionSummary = {
  kind: "m3u",
  id: "openlist",
  name: null,
  server: "https://lists.openlist.example",
  username: "",
  account: account(),
  needsSecret: false,
};

const guideOf = (subscription: SubscriptionSummary, status: Partial<GuideStatus>): GuideStatus => ({
  subscriptionId: subscription.id,
  source: { kind: "own" },
  channels: 0,
  listed: 0,
  guideChannels: 0,
  fetchedAt: null,
  availability: "none",
  mapped: 0,
  unresolved: 0,
  failure: null,
  failedAt: null,
  ...status,
});

const catalogueOf = (
  subscription: SubscriptionSummary,
  status: Partial<CatalogueStatus> = {},
): CatalogueStatus => ({
  subscriptionId: subscription.id,
  channelCount: 2073,
  fetchedAt: Date.now() - 14 * 60_000,
  failure: null,
  failedAt: null,
  ...status,
});

/**
 * Lets the screen take in what was just answered: on the test's clock where a test runs on one,
 * else in real time, as the Guide rows' tests still do.
 */
const settled = () =>
  act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(20);
    else await new Promise<void>((resolve) => setTimeout(resolve, 20));
  });
/** Runs the tests of a describe block on a fake clock, so settling waits for no real time. */
const onTestClock = () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
};

/** The section for the saved `subscriptions`, with their lists as the main process last said. */
async function section(
  subscriptions: readonly SubscriptionSummary[],
  loaded: { guides?: readonly GuideStatus[]; catalogues?: readonly CatalogueStatus[] } = {},
) {
  ipc.reset();
  const client = new QueryClient();
  client.setQueryData(["subscriptions"], subscriptions);
  client.setQueryData(["guide", "status"], loaded.guides ?? []);
  client.setQueryData(
    ["library", "status"],
    loaded.catalogues ?? subscriptions.map((each) => catalogueOf(each)),
  );
  client.setQueryData(["ondemand", "status"], { lists: [], metadata: null });
  const container = document.createElement("div");
  // In the page, as a field takes focus only there.
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(SubscriptionSection))),
  );
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  const rows = () => [...container.querySelectorAll("li")];
  /** The row of the subscription listed as `name`: its line, its buttons and what stands under it. */
  const row = (name: string) => {
    const found = rows().find((each) =>
      each.querySelector("button")?.textContent?.startsWith(name),
    );
    if (!found) throw new Error(`No row for ${name}`);
    const [toggle, ...buttons] = [...(found.firstElementChild?.querySelectorAll("button") ?? [])];
    return {
      element: found,
      line: toggle?.textContent ?? "",
      open: toggle?.getAttribute("aria-expanded") === "true",
      toggle,
      buttons: buttons.map((each) => each.textContent?.trim()),
      failure: found.querySelector("[aria-live] p")?.textContent ?? null,
    };
  };
  const button = (text: string, within: Element = container) =>
    [...within.querySelectorAll("button")].find((each) => each.textContent?.trim() === text);
  const click = async (element: Element | null | undefined) => {
    await act(async () => (element as HTMLElement | null | undefined)?.click());
    await settled();
  };
  /** Types into the fields of the form that is open, in order. */
  const type = async (values: readonly string[]) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () =>
      container.querySelectorAll("form input").forEach((input, index) => {
        const value = values[index];
        if (value === undefined) return;
        setValue?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }),
    );
  };
  const submit = async () => {
    await act(async () =>
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await settled();
  };
  /**
   * The Guide row: its words, when it last downloaded, its Refresh, which is Retry once a
   * download failed, and the line under it that says why one did.
   */
  const guideRow = () => {
    const refresh = container.querySelector(
      '[aria-label="Refresh guide"], [aria-label="Retry guide"]',
    );
    const line = refresh?.parentElement?.parentElement;
    return {
      refresh,
      text: line?.firstElementChild?.textContent ?? "",
      when: refresh?.parentElement?.firstElementChild?.textContent ?? "",
      failure: line?.nextElementSibling?.querySelector("p")?.textContent ?? null,
    };
  };
  /** What the form that is open says, announces and offers. */
  const form = () => {
    const open = container.querySelector("form");
    return {
      open: open !== null,
      text: open?.textContent ?? "",
      field: open?.querySelector("input") ?? null,
      said: open?.querySelector('[role="status"]')?.textContent ?? null,
      alert: open?.querySelector('[role="alert"]')?.textContent ?? null,
      buttons: [...(open?.querySelectorAll("button") ?? [])].map((each) => ({
        text: each.textContent?.trim(),
        disabled: each.disabled,
      })),
    };
  };
  return { container, client, rows, row, button, click, type, submit, guideRow, form };
}

/** The field the screen put the cursor in, by its label without the few words beside it. */
const focused = () => document.activeElement?.closest("label")?.firstChild?.firstChild?.textContent;

describe("the list of subscriptions", () => {
  onTestClock();
  it("lists each with its kind and how it stands, and opens none of several", async () => {
    const locked = { ...playlist, needsSecret: true };
    const { rows, row, container } = await section([northline, holiday, locked]);

    expect(rows()).toHaveLength(3);
    expect(row("Northline")).toMatchObject({
      line: `Northline · Xtream · ${expiry}`,
      open: false,
      buttons: ["Edit"],
    });
    expect(row("Holiday house")).toMatchObject({
      line: "Holiday house · Xtream · 12 days left",
      buttons: ["Edit"],
    });
    // Without a name, its host; never a username in the list, nor a playlist's link.
    expect(row("lists.openlist.example")).toMatchObject({
      line: "lists.openlist.example · M3U · needs its link again",
      buttons: ["Enter link", "Edit"],
    });
    expect(container.textContent).not.toMatch(/viewer0\d/);
    expect(container.textContent).toContain(
      "Everything from these subscriptions shows together in Home, Live TV, Movies and Series. One stream plays at a time.",
    );
    // Each is asked how its account stands now; no list is fetched again, and none is chosen.
    expect(ipc.argsOf("subscription.recheck")).toEqual(
      [northline, holiday, locked].map(({ id }) => ({ subscriptionId: id })),
    );
    expect(ipc.methods().filter((method) => method.endsWith(".refresh"))).toEqual([]);
  });

  it("opens a row to inspect it, one at a time, and shows a single subscription's at once", async () => {
    const { row, click, container } = await section([northline, holiday]);

    await click(row("Northline").toggle);

    expect(row("Northline").open).toBe(true);
    const details = row("Northline").element.querySelector('[role="region"]');
    expect(details?.textContent).toContain("StatusActive");
    expect(details?.textContent).toContain("Connections1 of 2 in use");
    expect(details?.textContent).toContain("Loginviewer01 @ panel.northline.example");
    expect(details?.textContent).toContain(`Channels · ${(2073).toLocaleString()}14 min ago`);
    expect(details?.textContent).toContain("Remove Northline");
    // The other's login travels over plain http, which its own details say.
    await click(row("Holiday house").toggle);
    expect(row("Northline").open).toBe(false);
    expect(row("Holiday house").element.textContent).toContain(
      "Login · not encryptedviewer02 @ tv.sunhouse.example:8080",
    );
    await click(row("Holiday house").toggle);
    expect(container.querySelector('[role="region"]')).toBeNull();
    // Inspecting chose nothing: no list was fetched again, and Live TV shows what it showed.
    expect(ipc.methods().filter((method) => method.endsWith(".refresh"))).toEqual([]);
    expect(useUi.getState().list).toEqual({ kind: "all" });

    unmount();
    const alone = await section([northline]);
    expect(alone.row("Northline").open).toBe(true);
  });

  it("says which one's stream plays", async () => {
    const { row } = await section([northline, holiday]);
    const channel: LiveChannel = {
      subscriptionId: holiday.id,
      id: "2014",
      name: "BE | VRT 1",
      title: "VRT 1",
      tags: [],
      number: 1,
      logoUrl: null,
      categoryIds: [],
      catchupDays: null,
      variants: [{ id: "2014", name: "BE | VRT 1", tags: [], quality: null }],
    };

    await act(async () => player.watch(channel));

    expect(row("Holiday house").line).toBe("Holiday house · Xtream · 12 days left · playing VRT 1");
    expect(row("Northline").line).toBe(`Northline · Xtream · ${expiry}`);
  });

  it("says under its row when one hasn't answered, since when, and tries it alone", async () => {
    const failedAt = new Date().setHours(14, 2, 0, 0);
    const { row, button, click } = await section([northline, holiday], {
      catalogues: [
        catalogueOf(northline),
        catalogueOf(holiday, {
          failure: { kind: "unreachable", server: holiday.server, detail: "No answer." },
          failedAt,
        }),
      ],
    });

    expect(row("Holiday house")).toMatchObject({
      buttons: ["Retry", "Edit"],
      failure: `tv.sunhouse.example:8080 hasn't answered since ${clockTime(failedAt, Date.now())}. Its lists are from then.`,
    });
    expect(row("Northline")).toMatchObject({ buttons: ["Edit"], failure: null });

    const answer = ipc.hold("library.refresh");
    await click(button("Retry", row("Holiday house").element));
    answer.resolve(catalogueOf(holiday));
    await settled();

    expect(ipc.argsOf("library.refresh")).toEqual([{ subscriptionId: holiday.id }]);
    expect(row("Holiday house")).toMatchObject({ buttons: ["Edit"], failure: null });
  });
});

describe("adding a subscription", () => {
  onTestClock();
  it("checks the login and puts it beside the others, under the name given", async () => {
    const { row, rows, button, click, type, submit, container } = await section([northline]);

    await click(button("Add subscription"));

    expect(container.querySelector("h2")?.textContent).toBe("Add subscription");
    expect(focused()).toBe("Name");
    expect(container.textContent).toContain("Its channels, movies and series join the lists.");
    await type(["Holiday house", "tv.sunhouse.example:8080", "viewer02", "s3cret"]);
    const answer = ipc.hold("subscription.add");
    await submit();

    expect(ipc.argsOf("subscription.add")).toEqual([
      {
        name: "Holiday house",
        server: "tv.sunhouse.example:8080",
        username: "viewer02",
        password: "s3cret",
      },
    ]);
    await act(async () => answer.resolve(holiday));
    await settled();

    // Back at the list, with the new row in its place and the form gone.
    expect(rows()).toHaveLength(2);
    expect(row("Holiday house").line).toContain("Holiday house · Xtream");
    expect(container.querySelector("form")).toBeNull();
  });

  it("asks before sending a login over http, and goes back to the list on Cancel", async () => {
    const { button, click, type, submit, container, rows } = await section([northline]);
    await click(button("Add subscription"));
    await type(["", "tv.sunhouse.example:8080", "viewer02", "s3cret"]);
    const answer = ipc.hold("subscription.add");
    await submit();
    await act(async () =>
      answer.reject({ kind: "unencrypted-only", server: "https://tv.sunhouse.example:8080" }),
    );
    await settled();

    expect(container.textContent).toContain("tv.sunhouse.example has no encrypted connection.");
    // No name given: none is sent, and its host stands for it.
    expect(ipc.argsOf("subscription.add")).toEqual([
      { server: "tv.sunhouse.example:8080", username: "viewer02", password: "s3cret" },
    ]);

    await click(button("Cancel"));
    await click(button("Cancel"));

    expect(container.querySelector("form")).toBeNull();
    expect(rows()).toHaveLength(1);
    expect(button("Add subscription")).toBeDefined();
  });

  it("offers neither Cancel nor its other fields while a login is checked", async () => {
    const { button, click, type, submit, container, rows } = await section([northline]);
    await click(button("Add subscription"));
    await type(["", "tv.sunhouse.example:8080", "viewer02", "s3cret"]);
    /** Whether Cancel and the switch to the form's other fields wait for an answer. */
    const waiting = () => ["Cancel", "Use an M3U link"].map((text) => button(text)?.disabled);

    const first = ipc.hold("subscription.add");
    await submit();

    expect(button("Checking…")?.disabled).toBe(true);
    expect(waiting()).toEqual([true, true]);

    await act(async () =>
      first.reject({ kind: "unencrypted-only", server: "https://tv.sunhouse.example:8080" }),
    );
    await settled();
    const second = ipc.hold("subscription.add");
    await click(button("Connect without encryption"));

    // The question went with the viewer's answer, and the login sent since can't be called back.
    expect(container.textContent).not.toContain("has no encrypted connection");
    expect(waiting()).toEqual([true, true]);

    await act(async () => second.reject({ kind: "invalid-login" }));
    await settled();

    expect(container.textContent).toContain("The provider rejected this username or password.");
    expect(waiting()).toEqual([false, false]);
    await click(button("Cancel"));
    expect(container.querySelector("form")).toBeNull();
    expect(rows()).toHaveLength(1);
  });

  it.each([
    {
      fields: "server and login",
      link: false,
      typed: ["Holiday house", "tv.sunhouse.example:8080", "viewer02", "s3cret"],
      since: ["Elsewhere", "tv.elsewhere.example", "viewer09", "0ther"],
      sent: { server: "tv.sunhouse.example:8080", username: "viewer02", password: "s3cret" },
    },
    {
      fields: "M3U link",
      link: true,
      typed: [
        "Holiday house",
        "tv.sunhouse.example:8080/get.php?username=viewer02&password=s3cret",
      ],
      since: ["Elsewhere", "tv.elsewhere.example/get.php?username=viewer09&password=0ther"],
      sent: {
        server: "tv.sunhouse.example:8080/get.php?username=viewer02&password=s3cret",
        username: "",
        password: "",
      },
    },
  ])(
    "connects the $fields it asked about without encryption, whatever was typed since",
    async ({ link, typed, since, sent }) => {
      const { button, click, type, submit, container } = await section([northline]);
      await click(button("Add subscription"));
      if (link) await click(button("Use an M3U link"));
      await type(typed);
      const first = ipc.hold("subscription.add");
      await submit();
      // Typed while the login is checked: another name, another address, another login.
      await type(since);
      await act(async () =>
        first.reject({ kind: "unencrypted-only", server: "https://tv.sunhouse.example:8080" }),
      );
      await settled();
      expect(container.textContent).toContain("tv.sunhouse.example has no encrypted connection.");

      ipc.hold("subscription.add");
      await click(button("Connect without encryption"));

      // The login the question was about goes again, whole, with only its address made http.
      expect(ipc.argsOf("subscription.add")).toEqual([
        { name: "Holiday house", ...sent },
        { name: "Holiday house", ...sent, server: `http://${sent.server}` },
      ]);
    },
  );
});

describe("editing a subscription", () => {
  onTestClock();
  it("renames it, and leaves its password alone unless one is typed", async () => {
    const { row, button, click, type, submit, container } = await section([northline, holiday]);

    await click(button("Edit", row("Northline").element));

    const fields = [...container.querySelectorAll("form input")] as HTMLInputElement[];
    expect(fields.map((field) => field.value)).toEqual(["Northline", ""]);
    // The login shows, and is no field: another one is another subscription.
    expect(container.querySelector("form")?.textContent).toContain(
      "Loginviewer01 @ panel.northline.example",
    );
    expect(container.querySelector("form")?.textContent).toContain(
      "Another server, username or playlist? Add it as a new subscription.",
    );
    await type(["North"]);
    const answer = ipc.hold("subscription.update");
    await submit();

    expect(ipc.argsOf("subscription.update")).toEqual([
      { subscriptionId: northline.id, name: "North" },
    ]);
    await act(async () => answer.resolve({ ...northline, name: "North" }));
    await settled();
    expect(row("North").line).toBe(`North · Xtream · ${expiry}`);
    expect(container.querySelector("form")).toBeNull();

    // A password typed is checked and saved with it; a name taken away leaves the host.
    await click(button("Edit", row("Holiday house").element));
    await type(["", "n3w-pass"]);
    ipc.hold("subscription.update");
    await submit();
    expect(ipc.argsOf("subscription.update").at(-1)).toEqual({
      subscriptionId: holiday.id,
      name: null,
      secret: "n3w-pass",
    });
  });

  it("says why a password wasn't saved, and keeps the form", async () => {
    const { row, button, click, type, submit, container } = await section([northline]);
    await click(button("Edit", row("Northline").element));
    await type(["Northline", "wrong"]);
    const answer = ipc.hold("subscription.update");
    await submit();
    // With the provider, the change can't be called back.
    expect(button("Cancel")?.disabled).toBe(true);

    await act(async () => answer.reject({ kind: "invalid-login" }));
    await settled();

    expect(container.querySelector("form")?.textContent).toContain(
      "The provider rejected this username or password.",
    );
    await click(button("Cancel"));
    expect(container.querySelector("form")).toBeNull();
  });
});

describe("a form the viewer left while its answer was on the way", () => {
  onTestClock();
  it("keeps the form opened since when a change to another row is saved after all", async () => {
    const { row, button, click, type, submit, container } = await section([northline, holiday]);
    await click(button("Edit", row("Northline").element));
    await type(["North", "n3w-pass"]);
    const answer = ipc.hold("subscription.update");
    await submit();
    await click(button("Add subscription"));
    await type(["Openlist", "lists.openlist.example", "viewer03", "s3cret"]);

    await act(async () => answer.resolve({ ...northline, name: "North" }));
    await settled();

    // What the main process saved shows on its row, and the form being filled in stays.
    expect(row("North").line).toContain("North · Xtream");
    const fields = [...container.querySelectorAll("form input")] as HTMLInputElement[];
    expect(fields.map((field) => field.value)).toEqual([
      "Openlist",
      "lists.openlist.example",
      "viewer03",
      "s3cret",
    ]);
  });

  it("keeps the form opened since when a subscription is added after all", async () => {
    const { row, rows, button, click, type, submit, container } = await section([northline]);
    await click(button("Add subscription"));
    await type(["Holiday house", "tv.sunhouse.example:8080", "viewer02", "s3cret"]);
    const answer = ipc.hold("subscription.add");
    await submit();
    await click(button("Edit", row("Northline").element));
    await type(["North"]);

    await act(async () => answer.resolve(holiday));
    await settled();

    // The one the main process saved is listed, and the form being filled in stays.
    expect(rows()).toHaveLength(2);
    const fields = [...container.querySelectorAll("form input")] as HTMLInputElement[];
    expect(fields.map((field) => field.value)).toEqual(["North", ""]);
  });
});

describe("a subscription whose keychain lost its secret", () => {
  onTestClock();
  it("asks for a playlist's link again on its row, naming only the host it came from", async () => {
    const locked = { ...playlist, needsSecret: true };
    const { row, button, click, type, submit, container } = await section([northline, locked]);

    await click(button("Enter link", row("lists.openlist.example").element));

    expect(row("lists.openlist.example").buttons).toEqual(["Cancel"]);
    expect(container.querySelector("form")?.textContent).toContain(
      "Your keychain no longer gives Mr. Streamer the saved link from lists.openlist.example.",
    );
    expect(container.querySelector("form")?.textContent).not.toContain("password");
    // One field, for the link, empty and ready to paste into.
    const fields = [...container.querySelectorAll("form input")] as HTMLInputElement[];
    expect(fields.map((field) => field.value)).toEqual([""]);
    expect(focused()).toBe("M3U link");

    await type(["https://lists.openlist.example/all.m3u?token=t0k3n"]);
    const answer = ipc.hold("subscription.update");
    await submit();

    expect(ipc.argsOf("subscription.update")).toEqual([
      { subscriptionId: locked.id, secret: "https://lists.openlist.example/all.m3u?token=t0k3n" },
    ]);
    // With the provider, the link can't be called back.
    expect(button("Cancel", row("lists.openlist.example").element)?.disabled).toBe(true);
    await act(async () => answer.resolve(playlist));
    await settled();
    expect(row("lists.openlist.example")).toMatchObject({
      line: "lists.openlist.example · M3U",
      buttons: ["Edit"],
    });
  });

  it("asks for a login's password again, and opens on that row when sent there", async () => {
    const locked = { ...holiday, needsSecret: true };
    // As from a channel of it that didn't play: Settings opens on its row, asking.
    useUi.setState({ subscription: { id: locked.id, show: "secret" } });
    const { row, button, click, container } = await section([northline, locked]);
    await settled();

    expect(row("Holiday house").line).toBe("Holiday house · Xtream · needs its password again");
    expect(container.querySelector("form")?.textContent).toContain(
      "Your keychain no longer gives Mr. Streamer the saved password.",
    );
    expect(focused()).toBe("Password");
    expect(useUi.getState().subscription).toBeNull();

    await click(button("Cancel", row("Holiday house").element));

    expect(container.querySelector("form")).toBeNull();
    expect(row("Holiday house").buttons).toEqual(["Enter password", "Edit"]);
    expect(ipc.argsOf("subscription.update")).toEqual([]);
  });

  it.each([
    { kind: "m3u", note: "needs your playlist link again" },
    { kind: "xtream", note: "needs your password again" },
  ] as const)("says in its details that a $kind subscription $note", async ({ kind, note }) => {
    const { container } = await section([{ ...playlist, kind, needsSecret: true }]);

    expect(container.textContent).toContain(`Status · ${note}`);
  });
});

describe("the Guide row of a playlist", () => {
  const NONE = guideOf(playlist, {});
  const single = () => section([playlist], { guides: [NONE] });

  it("says a playlist names none, and stays that way when a refresh finds none again", async () => {
    const { guideRow } = await single();
    expect(guideRow().text).toBe("Guide · none in this playlist");

    const answer = ipc.hold("guide.refresh");
    await act(async () => (guideRow().refresh as HTMLElement).click());
    answer.resolve(NONE);
    await settled();

    expect(ipc.argsOf("guide.refresh")).toEqual([{ subscriptionId: playlist.id }]);
    expect(guideRow()).toMatchObject({ text: "Guide · none in this playlist", failure: null });
  });

  it("shows the guide a refresh found", async () => {
    const { guideRow } = await single();

    const answer = ipc.hold("guide.refresh");
    await act(async () => (guideRow().refresh as HTMLElement).click());
    answer.resolve(
      guideOf(playlist, { channels: 8310, fetchedAt: Date.now(), availability: "available" }),
    );
    await settled();

    expect(guideRow()).toMatchObject({
      text: `Guide · ${(8310).toLocaleString()} channels`,
      when: pastTime(Date.now(), Date.now()),
      failure: null,
    });
  });

  it("says why under the row when the playlist can't be read, and keeps what it said", async () => {
    const { guideRow } = await single();

    const answer = ipc.hold("guide.refresh");
    await act(async () => (guideRow().refresh as HTMLElement).click());
    answer.reject({
      kind: "unreachable",
      server: "https://lists.openlist.example",
      detail: "The server did not answer.",
    });
    await settled();

    expect(guideRow()).toEqual({
      refresh: expect.anything(),
      text: "Guide · none in this playlist",
      when: "",
      failure: "Can't reach lists.openlist.example. The server did not answer.",
    });
  });

  it("says a guide isn't loaded yet while nothing says the playlist has none", async () => {
    const { guideRow } = await section([playlist], {
      guides: [guideOf(playlist, { availability: "unknown" })],
    });

    expect(guideRow().text).toBe("Guide · not loaded yet");
  });
});

describe("a subscription's guide", () => {
  const HOUR = 60 * 60 * 1000;
  const ORIGIN = "https://guide.example.org";
  const ADDRESS = "http://guide.example.org/xmltv.gz?key=a81f";
  const listed = { listed: 1180, guideChannels: 1204, availability: "available" as const };
  /** Holiday house on the provider's own guide. */
  const own = guideOf(holiday, { ...listed, channels: 1044, fetchedAt: Date.now() - 2 * HOUR });
  /** Holiday house on a guide from an address of the viewer's own. */
  const external = guideOf(holiday, {
    ...listed,
    source: { kind: "external", origin: ORIGIN, since: Date.now() - 5 * 24 * HOUR, locked: false },
    channels: 412,
    fetchedAt: Date.now() - 30 * HOUR,
    mapped: 9,
  });
  const candidate = {
    id: "check-1",
    origin: ORIGIN,
    guideChannels: 1204,
    matched: 412,
    listed: 1180,
    until: Date.now() + 50 * HOUR,
    sameSource: false,
  };
  const single = (guide: GuideStatus, subscription = holiday) =>
    section([subscription], { guides: [{ ...guide, subscriptionId: subscription.id }] });

  it("says where it comes from, what it covers and since when, and how many channels are mapped", async () => {
    const { guideRow, container } = await single(external);

    expect(guideRow()).toEqual({
      refresh: expect.anything(),
      text: `Guide · guide.example.org · 412 of ${(1180).toLocaleString()} channels`,
      when: pastTime(external.fetchedAt ?? 0, Date.now()),
      failure: null,
    });
    expect(container.textContent).toContain("Mapped channels · 9 by hand · 768 without programmes");
    // The provider's own guide says the same of itself, without a host.
    unmount();
    expect((await single(own)).guideRow().text).toBe(
      `Guide · ${(1044).toLocaleString()} of ${(1180).toLocaleString()} channels`,
    );
  });

  it("says since when its host hasn't answered, what shows meanwhile, and tries again alone", async () => {
    const failedAt = Date.now() - 3 * HOUR;
    const { guideRow, button, click, container } = await single({
      ...external,
      failure: {
        kind: "unreachable",
        server: ORIGIN,
        detail: "The server did not answer in time.",
      },
      failedAt,
    });
    const kept = pastTime(external.fetchedAt ?? 0, Date.now());

    expect(guideRow().failure).toBe(
      `guide.example.org hasn't answered since ${pastTime(failedAt, Date.now())}. Listings are from ${kept}; the provider's guide isn't used.`,
    );
    expect(button("Retry")).toBeDefined();

    const answer = ipc.hold("guide.refresh");
    await click(button("Retry"));
    expect(ipc.argsOf("guide.refresh")).toEqual([{ subscriptionId: holiday.id }]);
    answer.resolve({ ...external, fetchedAt: Date.now() });
    await settled();

    expect(guideRow().failure).toBeNull();
    expect(button("Retry")).toBeUndefined();
    expect(container.querySelector('[aria-label="Refresh guide"]')).not.toBeNull();
    // A host that refuses says how, and a playlist's guide is named as the playlist's.
    unmount();
    const refused = await single(
      { ...external, failure: { kind: "provider-error", status: 403 }, failedAt },
      playlist,
    );
    expect(refused.guideRow().failure).toBe(
      `guide.example.org answered with an error (HTTP 403). Listings are from ${kept}; the playlist's guide isn't used.`,
    );
  });

  it("checks an address before anything changes, and switches only on Use this guide", async () => {
    const { row, button, click, type, submit, form, guideRow, container } = await single(own);
    await click(button("Guide"));

    expect(form().text).toContain("Guide for Holiday house");
    expect(form().text).toContain("In useProvider guide");
    expect(form().field?.value).toBe("");
    expect(document.activeElement).toBe(form().field);
    // Nothing to check yet, and nothing to go back to.
    expect(form().buttons).toEqual([{ text: "Check", disabled: true }]);

    await type([ADDRESS]);
    // Said before anything is sent.
    expect(form().text).toContain(
      "Not encrypted. The address, and any key in it, travels as plain text.",
    );
    const checking = ipc.hold("guide.check");
    await submit();
    expect(form().buttons).toEqual([{ text: "Checking…", disabled: true }]);
    // A check can be called off.
    expect(row("Holiday house").buttons).toEqual(["Cancel"]);
    expect(button("Cancel", row("Holiday house").element)?.disabled).toBe(false);
    checking.resolve(candidate);
    await settled();

    expect(ipc.argsOf("guide.check")).toEqual([{ subscriptionId: holiday.id, address: ADDRESS }]);
    expect(form().said).toBe(
      `Checked: ${(1204).toLocaleString()} channels in this guide, 412 of your ${(1180).toLocaleString()} match by id. Programmes until ${comingTime(candidate.until, Date.now())}.`,
    );
    expect(form().buttons).toEqual([
      { text: "Use this guide", disabled: false },
      { text: "Check again", disabled: false },
    ]);
    expect(ipc.methods()).not.toContain("guide.use");

    const switching = ipc.hold("guide.use");
    await submit();
    expect(form().buttons[0]).toEqual({ text: "Switching…", disabled: true });
    // The switch itself can't be called back.
    expect(button("Cancel", row("Holiday house").element)?.disabled).toBe(true);
    switching.resolve({
      ...external,
      source: { kind: "external", origin: ORIGIN, since: Date.now(), locked: false },
      fetchedAt: Date.now(),
      mapped: 0,
    });
    await settled();

    expect(ipc.argsOf("guide.use")).toEqual([{ subscriptionId: holiday.id, candidate: "check-1" }]);
    // Back to its details, which say where the guide comes from now.
    expect(form().open).toBe(false);
    expect(guideRow().text).toContain("guide.example.org · 412 of");
    // Nothing shows of the address but its host.
    expect(container.textContent).not.toContain("a81f");
    expect(container.textContent).not.toContain("xmltv.gz");
  });

  it("maps no channels while a switch its form was closed on is on its way, then those of the guide switched to", async () => {
    const { row, button, click, type, submit, form } = await single(own);
    await click(button("Guide"));
    await type([ADDRESS]);
    ipc.hold("guide.check").resolve(candidate);
    await submit();
    const switching = ipc.hold("guide.use");
    await submit();
    const sheet = () => document.body.querySelector('[role="dialog"]');

    // The row closes the form over its details; the switch that was sent goes on.
    await click(row("Holiday house").toggle);
    expect(form().open).toBe(false);
    expect(button("Map")?.disabled).toBe(true);
    await click(button("Map"));
    expect(sheet()).toBeNull();
    expect(ipc.methods()).not.toContain("guide.mapChannels");

    switching.resolve({ ...external, fetchedAt: Date.now(), mapped: 0 });
    await settled();
    expect(button("Map")?.disabled).toBe(false);
    await click(button("Map"));

    expect(sheet()?.textContent).toContain(
      "Holiday house · guide.example.org · 768 channels without programmes",
    );
    expect(ipc.argsOf("guide.mapChannels")).toHaveLength(1);
  });

  it("drops what a check found once the field changes, says why one failed, and stops one on Cancel", async () => {
    const { row, button, click, type, submit, form } = await single(own);
    await click(button("Guide"));
    await type([ADDRESS]);
    ipc.hold("guide.check").resolve(candidate);
    await submit();
    expect(form().said).not.toBeNull();

    // Another address: the answer was about the one before.
    await type(["https://other.example.net/guide.xml"]);
    expect(form().said).toBeNull();
    expect(form().buttons).toEqual([{ text: "Check", disabled: false }]);

    ipc.hold("guide.check").reject({ kind: "guide", failure: { kind: "not-xmltv" } });
    await submit();
    expect(form().alert).toBe("The address answered, but not with an XMLTV guide.");
    expect(form().field?.value).toBe("https://other.example.net/guide.xml");
    expect(form().buttons).toEqual([{ text: "Check", disabled: false }]);

    // A check that no longer counts when it is used says so, and has to be made again.
    ipc.hold("guide.check").resolve(candidate);
    await submit();
    ipc.hold("guide.use").reject({ kind: "guide", failure: { kind: "changed" } });
    await submit();
    expect(form().alert).toBe("The guide changed meanwhile, so nothing was changed.");
    expect(form().buttons).toEqual([{ text: "Check", disabled: false }]);

    // By the keyboard, as Tab says: closing the form puts it back on the row.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    const before = ipc.argsOf("guide.cancelCheck").length;
    await click(button("Cancel", row("Holiday house").element));
    expect(form().open).toBe(false);
    expect(ipc.argsOf("guide.cancelCheck").slice(before)).toEqual([{ subscriptionId: holiday.id }]);
    expect(document.activeElement).toBe(row("Holiday house").toggle);
  });

  it("checks the address in use again with nothing typed, and goes back to the own guide when asked", async () => {
    const { button, click, submit, form, guideRow } = await single(external, playlist);
    await click(button("Guide"));

    expect(form().text).toContain("In useguide.example.org · key hidden · since ");
    expect(form().text).toContain("XMLTV address · leave empty to keep");
    expect(form().text).toContain("Use playlist guide also clears your 9 mapped channels.");
    expect(form().buttons).toEqual([
      { text: "Check", disabled: false },
      { text: "Use playlist guide", disabled: false },
    ]);
    ipc.hold("guide.check").resolve({ ...candidate, sameSource: true });
    await submit();
    expect(ipc.argsOf("guide.check")).toEqual([{ subscriptionId: playlist.id }]);
    // The same address keeps its mappings, so nothing is said of losing them.
    expect(form().said).not.toContain("clears");

    const restoring = ipc.hold("guide.restore");
    await click(button("Use playlist guide"));
    expect(form().buttons.at(-1)).toEqual({ text: "Going back…", disabled: true });
    restoring.resolve(guideOf(playlist, {}));
    await settled();

    expect(ipc.argsOf("guide.restore")).toEqual([{ subscriptionId: playlist.id }]);
    expect(form().open).toBe(false);
    expect(guideRow().text).toBe("Guide · none in this playlist");
  });

  it("asks for an address the keychain lost, on its row, and checks nothing until one is typed", async () => {
    const { button, click, type, form, guideRow, container } = await single({
      ...external,
      source: { kind: "external", origin: ORIGIN, since: Date.now(), locked: true },
    });

    expect(container.textContent).toContain("Guide · guide.example.org · needs its address again");
    expect(guideRow().refresh).toBeNull();
    await click(button("Enter address"));

    expect(form().text).toContain(
      "Your keychain no longer gives Mr. Streamer the saved address from guide.example.org.",
    );
    expect(form().text).not.toContain("leave empty to keep");
    expect(form().buttons).toEqual([
      { text: "Check", disabled: true },
      { text: "Use provider guide", disabled: false },
    ]);
    await type([ADDRESS]);
    expect(form().buttons[0]).toEqual({ text: "Check", disabled: false });
  });
});
