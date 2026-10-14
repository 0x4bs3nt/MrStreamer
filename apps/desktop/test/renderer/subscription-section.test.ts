// @vitest-environment happy-dom
// Settings > Subscriptions: every saved subscription as a row that says how it stands, opened to
// inspect and never to choose; adding one beside the others, renaming one, entering a password or
// link again where the keychain lost it, and retrying one that didn't answer. A playlist's Guide
// row tells a playlist that names no guide, which is no failure, from a guide that couldn't be
// had, and its refresh asks again either way. A subscription's Guide row says where its channels'
// programmes come from, its own guide and each XMLTV source of Settings > Guides, why its own
// guide's download failed, and leads to the sources.
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
import { clockTime, pastTime } from "../../src/renderer/src/lib/format.ts";
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
  channels: 0,
  supplied: [],
  listed: 0,
  guideChannels: 0,
  fetchedAt: null,
  availability: "none",
  mapped: 0,
  unresolved: 0,
  processing: { state: "empty" },
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
   * The Guide row: its name and the line under it, as "Guide · …", its Refresh, and the line
   * under the row that says why a download failed.
   */
  const guideRow = () => {
    const refresh = container.querySelector('[aria-label^="Refresh guide of"]');
    const line = refresh?.parentElement?.parentElement;
    return {
      refresh,
      text: [...(line?.firstElementChild?.childNodes ?? [])]
        .map((each) => each.textContent)
        .join(" · "),
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
      guideOf(playlist, {
        channels: 8310,
        supplied: [{ source: null, channels: 8310 }],
        listed: 9000,
        fetchedAt: Date.now(),
        availability: "available",
      }),
    );
    await settled();

    expect(guideRow()).toMatchObject({
      text: `Guide · ${(8310).toLocaleString()} own · 690 without`,
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
  /** Holiday house: 25 channels from its own guide, 9 from a source, 3 without. */
  const combined = guideOf(holiday, {
    listed: 37,
    channels: 34,
    supplied: [
      { source: null, channels: 25 },
      { source: { id: "source-1", origin: ORIGIN }, channels: 9 },
    ],
    guideChannels: 1204,
    availability: "available",
    fetchedAt: Date.now() - 2 * HOUR,
    mapped: 2,
    processing: {
      state: "ready",
      channels: 25,
      programmes: 4000,
      until: Date.now() + 40 * HOUR,
      fetchedAt: Date.now() - 2 * HOUR,
    },
  });
  const single = (guide: GuideStatus, subscription = holiday) =>
    section([subscription], { guides: [{ ...guide, subscriptionId: subscription.id }] });

  it("says where its channels' programmes come from, its own guide first, and leads to the sources", async () => {
    const { guideRow, button, click, container } = await single(combined);

    expect(guideRow()).toEqual({
      refresh: expect.anything(),
      text: "Guide · 25 own · 9 guide.example.org · 3 without",
      failure: null,
    });
    expect(container.textContent).toContain("Mapped channels · 2 by hand");
    // No address of its own to give: the sources are in Settings > Guides.
    expect(container.querySelector("form")).toBeNull();
    await click(button("Guides"));
    expect(useUi.getState().settings).toBe("guides");
  });

  it("says why its own guide's download failed, since when, and from when the listings are, and tries again alone", async () => {
    const since = Date.now() - 3 * HOUR;
    const kept = Date.now() - 30 * HOUR;
    const { guideRow, click } = await single({
      ...combined,
      processing: {
        state: "failed",
        reason: {
          kind: "unreachable",
          server: holiday.server,
          detail: "The server did not answer in time.",
        },
        since,
        kept,
      },
    });

    expect(guideRow().failure).toBe(
      `Can't reach tv.sunhouse.example:8080. The server did not answer in time. Since ${pastTime(since, Date.now())}. Listings are from ${pastTime(kept, Date.now())}.`,
    );

    const answer = ipc.hold("guide.refresh");
    await click(guideRow().refresh);
    expect(ipc.argsOf("guide.refresh")).toEqual([{ subscriptionId: holiday.id }]);
    answer.resolve(combined);
    await settled();

    expect(guideRow().failure).toBeNull();
    expect(guideRow().text).toBe("Guide · 25 own · 9 guide.example.org · 3 without");
  });
});
