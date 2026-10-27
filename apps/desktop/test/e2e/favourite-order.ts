// Checks putting the favourites in another order in a built app, against the fake provider: what
// the suite can't, because happy-dom lays nothing out, scrolls nothing and moves no real focus.
// It stars forty channels, among them one in three qualities, one for adults that the lists hide
// and one the provider doesn't list, then checks, in order:
//
// - Reorder leaves a search as it is and asks for it to be cleared; the line's link clears it
//   and starts ordering every favourite.
// - R starts ordering in Live TV's Favourites, with the focus on a row.
// - A click on a row's Down moves it one place, and with Shift to the bottom: the list scrolls
//   there, the row keeps the focus, and the list still draws only part of its rows.
// - Up, Down, PageDown, Home and End move the selection, and with Alt the channel, by one place,
//   ten, or to an end, the focus staying on its row and the row in view each time.
// - Scrolled far out of view with the wheel, the selected row still holds the focus, and the
//   next key that moves it brings it back into view.
// - Tab goes from the row to its two buttons, where Space moves the channel and the button
//   keeps the focus.
// - Escape throws the draft away.
// - Enter saves: the record holds the new order, the hidden favourites where they were and the
//   channel in three qualities with every stream.
// - While the database is held by another writer, saving fails and keeps the draft; Retry saves
//   it once the writer lets go.
// - A favourite removed behind the page's back, as another build sharing the file would, makes
//   the next save ask to read the favourites again; Reload starts from them, and saves.
// - A favourite starred while ordering ends the draft.
// - Home's Favourites row and Watch's channel list show the saved order, and channel up and down
//   in Watch follow it.
// - The order holds after the catalogue is fetched again, and after a restart.
// - Nothing in all of this asked the provider for a stream before a channel was watched.
//
//   node test/e2e/favourite-order.ts <app executable> [-- extra app arguments]
//
// The app runs with a throwaway profile and remote debugging on a random port; on macOS pass
// --use-mock-keychain so the test never touches a real keychain.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { QUALITY_STREAM_IDS, startFakeProvider } from "../fake-provider.ts";
import { connect, delay, key, launch, login, MODIFIERS, press, waitFor, type Page } from "./app.ts";

const [executable, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!executable) {
  throw new Error("Usage: node test/e2e/favourite-order.ts <app executable> [-- args]");
}

const profile = mkdtempSync(join(tmpdir(), "mr-streamer-e2e-"));
const provider = await startFakeProvider({ channels: 300, live: true, adultChannels: true });
const randomPort = () => 20000 + Math.floor(Math.random() * 20000);
let port = randomPort();
let app = launch(executable, rest, { port, profile });

/** A channel for adults, which the lists hide, and an id the provider doesn't list. */
const HIDDEN = ["4000", "gone"] as const;
const KEYS = { ArrowUp: 38, ArrowDown: 40, PageUp: 33, PageDown: 34, End: 35, Home: 36 } as const;

let failed = false;
/** Prints how a check went. */
function report(name: string, problems: readonly string[]): void {
  console.log(
    `${problems.length === 0 ? "PASS" : "FAIL"} ${name}${problems.map((each) => `\n     ${each}`).join("")}`,
  );
  failed ||= problems.length > 0;
}

interface Channel extends OwnedId {
  readonly title: string;
  readonly variants: readonly { readonly id: string }[];
}

const invoke = async <T>(page: Page, method: string, input?: unknown): Promise<T> => {
  const result = await page.evaluate<{ ok: boolean; value: T; error?: unknown }>(
    `window.mrStreamer.invoke(${JSON.stringify(method)}, ${JSON.stringify(input)})`,
  );
  if (!result.ok) throw new Error(`${method}: ${JSON.stringify(result.error)}`);
  return result.value;
};
/** The favourites as the record holds them, hidden ones included. */
const favourites = async (page: Page) =>
  (await invoke<{ favourites: OwnedId[] }>(page, "viewing.get")).favourites;
/** The favourites the lists show, in their order. */
const listed = async (page: Page) =>
  invoke<Channel[]>(page, "library.channels", { channels: await favourites(page) });
/** Where the one subscription's channel `id` stands among `channels`, from 0. */
const placeOf = (channels: readonly OwnedId[], id: string) =>
  channels.findIndex((channel) => channel.id === id);

/** What the list draws: each row's place and channel, whether it is in view, and the focus. */
const drawn = (page: Page) =>
  page.evaluate<{
    rows: { index: number; title: string; inView: boolean }[];
    focus: string | null;
    saying: string;
    editing: boolean;
  }>(`(() => {
    const rows = [...document.querySelectorAll("main [data-index]")].map((row) => {
      const box = row.getBoundingClientRect();
      const list = row.closest(".overflow-y-auto").getBoundingClientRect();
      return {
        index: Number(row.dataset.index),
        title: row.querySelector("[data-name]")?.textContent ?? "",
        inView: box.top >= list.top - 1 && box.bottom <= list.bottom + 1,
      };
    });
    const active = document.activeElement;
    return {
      rows,
      focus: active?.getAttribute("role") === "listitem" ? active.getAttribute("aria-label") : null,
      saying: document.querySelector('main [role="status"]')?.textContent ?? "",
      editing: [...document.querySelectorAll("main button")].some((b) => b.textContent.trim() === "Cancel"),
    };
  })()`);

/** What is wrong with the list, if anything, when it should show `order`. */
async function listProblems(
  page: Page,
  order: readonly Channel[],
  focused?: Channel,
): Promise<string[]> {
  await delay(400);
  const now = await drawn(page);
  const problems = now.rows
    .filter((row) => order[row.index]?.title !== row.title)
    .map((row) => `row ${row.index + 1} shows ${row.title}, not ${order[row.index]?.title}`);
  if (now.rows.length < 5) problems.push(`only ${now.rows.length} rows drawn`);
  if (now.rows.length >= order.length) problems.push("every row is drawn: the list isn't virtual");
  if (focused) {
    const row = now.rows.find((each) => each.title === focused.title);
    const at = order.indexOf(focused);
    if (now.focus !== focused.title)
      problems.push(`the focus is on ${now.focus}, not ${focused.title}`);
    if (!row?.inView) problems.push(`${focused.title} is out of view at place ${at + 1}`);
    if (row && row.index !== at)
      problems.push(`${focused.title} stands at ${row.index + 1}, not ${at + 1}`);
  }
  return problems;
}

/** `order` with a channel moved to place `to`, from 0. */
const moved = (order: readonly Channel[], channel: Channel, to: number): Channel[] => {
  const rest = order.filter((each) => each !== channel);
  const at = Math.min(Math.max(to, 0), rest.length);
  return [...rest.slice(0, at), channel, ...rest.slice(at)];
};

/** Clicks a button by its label with the real pointer, where it stands once the list has it in view. */
async function click(page: Page, label: string, modifiers = 0): Promise<void> {
  const where = () =>
    page.evaluate<{ x: number; y: number } | null>(`(() => {
      const button = document.querySelector('button[aria-label=${JSON.stringify(label)}]');
      const box = button?.getBoundingClientRect();
      const list = button?.closest(".overflow-y-auto")?.getBoundingClientRect();
      if (!box || (list && (box.top < list.top || box.bottom > list.bottom))) return null;
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
  await waitFor(async () => (await where()) !== null, 10_000).catch(() => {
    throw new Error(`No button "${label}" in view.`);
  });
  await delay(150);
  const point = await where();
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
      modifiers,
    });
  }
  await delay(150);
}

const says = (page: Page, words: string) =>
  page.evaluate<boolean>(
    `document.querySelector("main").innerText.includes(${JSON.stringify(words)})`,
  );

/** Opens Live TV's Favourites. */
async function openFavourites(page: Page): Promise<void> {
  await press(page, "Live TV");
  await delay(300);
  await press(page, "Favourites");
  await waitFor(async () => (await drawn(page)).rows.length > 0, 20_000);
}

try {
  let page = await connect(port);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await login(page, provider);
  // Every channel is the one subscription's, and is named with it.
  const [saved] = await invoke<{ id: string }[]>(page, "subscription.list");
  if (!saved) throw new Error("The login saved no subscription.");
  const subscriptionId = saved.id;
  const own = (id: string): OwnedId => ({ subscriptionId, id });

  // Thirty-eight channels the lists show, the one in three qualities by its SD stream, with the
  // two hidden favourites among them: after the third channel and at the end.
  const plain = provider.catalogue.channels
    .filter((channel) => !channel.offline && !channel.adult && channel.streamId < 4000)
    .slice(0, 37)
    .map((channel) => String(channel.streamId));
  const starred = [
    ...plain.slice(0, 3),
    HIDDEN[0],
    ...plain.slice(3),
    String(QUALITY_STREAM_IDS + 2),
    HIDDEN[1],
  ];
  for (const channelId of starred) {
    await invoke(page, "viewing.setFavourite", {
      commandId: crypto.randomUUID(),
      channel: own(channelId),
      favourite: true,
    });
  }
  const record = await favourites(page);
  let order = await listed(page);
  const streams = provider.streamRequests();
  await openFavourites(page);

  {
    // "/" goes to the field. The words are in two of the favourites' names.
    await key(page, "/", 191);
    await page.send("Input.insertText", { text: "joined mid" });
    await waitFor(() => says(page, "1 channel · 1 stream"), 10_000);
    await press(page, "Reorder");
    await delay(300);
    const problems: string[] = [];
    const asked = await drawn(page);
    if (!(await says(page, "Clear the search to reorder.")))
      problems.push("no line asked to clear it");
    if (asked.editing || asked.rows.length !== 1) problems.push("the search didn't stay as it was");
    await click(page, "Clear search and reorder");
    problems.push(
      ...(await listProblems(
        page,
        order,
        order.find((channel) => channel.title === asked.rows[0]?.title),
      )),
    );
    if (!(await drawn(page)).editing) problems.push("the link didn't start ordering");
    await key(page, "Escape", 27);
    report("Reorder asks for a search to be cleared, and the link clears it and starts", problems);
  }

  {
    await key(page, "r", 82);
    const problems = await listProblems(page, order);
    const now = await drawn(page);
    if (!now.editing) problems.push("R didn't start ordering");
    if (now.focus === null) problems.push("no row has the focus");
    report("R starts ordering, with the focus on a row", problems);
  }

  {
    const second = order[1]!;
    await click(page, `Move ${second.title} down`);
    order = moved(order, second, 2);
    const problems = await listProblems(page, order, second);
    const said = (await drawn(page)).saying;
    if (said !== `${second.title}, 3 of ${order.length}`) problems.push(`it said "${said}"`);
    await click(page, `Move ${second.title} down`, MODIFIERS.shift);
    order = moved(order, second, order.length - 1);
    problems.push(...(await listProblems(page, order, second)));
    report("A click moves a row one place, and with Shift to the bottom", problems);
  }

  {
    const problems: string[] = [];
    const step = async (name: keyof typeof KEYS, alt: boolean, expect: () => Channel) => {
      await key(page, name, KEYS[name], alt ? MODIFIERS.alt : 0);
      const channel = expect();
      for (const problem of await listProblems(page, order, channel)) {
        problems.push(`${alt ? "Alt " : ""}${name}: ${problem}`);
      }
    };
    await step("Home", false, () => order[0]!);
    await step("ArrowDown", false, () => order[1]!);
    await step("ArrowDown", false, () => order[2]!);
    const third = order[2]!;
    const to = (place: number) => () => {
      order = moved(order, third, place);
      return third;
    };
    await step("ArrowDown", true, to(3));
    await step("PageDown", true, to(13));
    await step("ArrowUp", true, to(12));
    await step("End", true, to(order.length - 1));
    await step("ArrowDown", true, to(order.length - 1));
    await step("PageUp", true, to(order.length - 11));
    await step("Home", true, to(0));
    await step("PageUp", true, to(0));
    await step("End", false, () => order.at(-1)!);
    await step("PageUp", false, () => order.at(-11)!);
    report("The keys move the selection, and with Alt the channel, in view and in focus", problems);
  }

  // The channel the selection is on now.
  const selected = order.at(-11)!;
  {
    // The wheel takes the list to its start, far from the row with the focus near its end.
    const list = await page.evaluate<{ x: number; y: number }>(`(() => {
      const box = document.querySelector("main .overflow-y-auto").getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...list,
      deltaX: 0,
      deltaY: -4000,
    });
    await delay(600);
    const away = await drawn(page);
    const problems: string[] = [];
    if (away.rows.find((row) => row.title === selected.title)?.inView !== false) {
      problems.push("the wheel didn't take the row out of view, or the list no longer draws it");
    }
    if (away.focus !== selected.title) problems.push(`the focus went to ${away.focus}`);
    await key(page, "ArrowUp", KEYS.ArrowUp, MODIFIERS.alt);
    order = moved(order, selected, order.indexOf(selected) - 1);
    problems.push(...(await listProblems(page, order, selected)));
    report("A row scrolled out of view keeps the focus, and its next move shows it", problems);
  }

  {
    const problems: string[] = [];
    const focused = () =>
      page.evaluate<string | null>(`document.activeElement?.getAttribute("aria-label") ?? null`);
    await key(page, "Tab", 9);
    if ((await focused()) !== `Move ${selected.title} up`)
      problems.push(`Tab went to ${await focused()}`);
    // A real press of Space, which a button takes as a click when the key comes up.
    const space = { key: " ", code: "Space", windowsVirtualKeyCode: 32 };
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", text: " ", ...space });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...space });
    order = moved(order, selected, order.indexOf(selected) - 1);
    await delay(400);
    if ((await focused()) !== `Move ${selected.title} up`)
      problems.push(`after Space the focus is on ${await focused()}`);
    const row = (await drawn(page)).rows.find((each) => each.title === selected.title);
    if (row?.index !== order.indexOf(selected) || !row.inView)
      problems.push(`${selected.title} is at ${(row?.index ?? -1) + 1}, in view: ${row?.inView}`);
    await key(page, "Tab", 9);
    if ((await focused()) !== `Move ${selected.title} down`)
      problems.push(`the second Tab went to ${await focused()}`);
    report("Tab reaches a row's buttons, which Space presses and which keep the focus", problems);
  }

  {
    await key(page, "Escape", 27);
    order = await listed(page);
    const problems = await listProblems(page, order);
    const now = await drawn(page);
    if (now.editing) problems.push("still ordering after Escape");
    if (now.focus !== null) problems.push(`a row kept the focus: ${now.focus}`);
    if (JSON.stringify(await favourites(page)) !== JSON.stringify(record))
      problems.push("the record changed");
    report("Escape throws the draft away", problems);
  }

  {
    await key(page, "r", 82);
    await key(page, "End", KEYS.End);
    const last = order.at(-1)!;
    await key(page, "Home", KEYS.Home, MODIFIERS.alt);
    order = moved(order, last, 0);
    const fifth = order[4]!;
    await click(page, `Move ${fifth.title} up`);
    order = moved(order, fifth, 3);
    await key(page, "Enter", 13);
    await waitFor(async () => !(await drawn(page)).editing, 10_000);
    const problems = await listProblems(page, order);
    const saved = await favourites(page);
    const shown = (await listed(page)).map((channel) => channel.id);
    if (JSON.stringify(shown) !== JSON.stringify(order.map((channel) => channel.id))) {
      problems.push(`the record lists ${shown.join(" ")}`);
    }
    // The hidden favourites stand where they stood, counted among every favourite.
    for (const id of HIDDEN) {
      if (placeOf(saved, id) !== placeOf(record, id)) {
        problems.push(
          `${id} moved from place ${placeOf(record, id) + 1} to ${placeOf(saved, id) + 1}`,
        );
      }
    }
    if (saved.length !== record.length)
      problems.push(`${saved.length} favourites, not ${record.length}`);
    const qualities = order[0]!.variants.length;
    if (qualities !== 3) problems.push(`the channel moved first has ${qualities} streams, not 3`);
    report("Enter saves the order, with the hidden favourites where they were", problems);
  }

  {
    // Another writer holds the database, as a second copy of the app can for a moment.
    const other = new DatabaseSync(join(profile, "mrstreamer.db"));
    other.exec("begin immediate");
    await key(page, "r", 82);
    const second = order[1]!;
    await click(page, `Move ${second.title} up`);
    const wanted = moved(order, second, 0);
    await press(page, "Save");
    const problems: string[] = [];
    await waitFor(() => says(page, "Couldn't save the order."), 10_000).catch(() =>
      problems.push("no failure showed"),
    );
    problems.push(...(await listProblems(page, wanted, second)));
    if (
      JSON.stringify((await listed(page)).map((c) => c.id)) !==
      JSON.stringify(order.map((c) => c.id))
    ) {
      problems.push("the record changed though saving failed");
    }
    other.exec("rollback");
    other.close();
    await press(page, "Retry");
    await waitFor(async () => !(await drawn(page)).editing, 10_000).catch(() =>
      problems.push("Retry didn't save"),
    );
    order = wanted;
    problems.push(...(await listProblems(page, order)));
    if (
      JSON.stringify((await listed(page)).map((c) => c.id)) !==
      JSON.stringify(order.map((c) => c.id))
    ) {
      problems.push("the record doesn't hold the order after Retry");
    }
    report("A save that fails keeps the draft, and Retry saves it", problems);
  }

  {
    // A favourite unstarred the way an older build sharing the file does it, which tells this
    // page nothing: an event, and the list without it.
    const gone = order.at(-1)!;
    const other = new DatabaseSync(join(profile, "mrstreamer.db"));
    const state = other.prepare("select account, favourites from state").get();
    const account = String(state?.["account"]);
    const kept = (JSON.parse(String(state?.["favourites"])) as string[]).filter(
      (id) => id !== gone.id,
    );
    other.exec("begin immediate");
    const event = other
      .prepare(
        "insert into events (account, type, version, channel_id, at, command_id) values (?, 'favourite-removed', 1, ?, ?, 'another-build')",
      )
      .run(account, gone.id, Date.now());
    other
      .prepare("update state set favourites = ?, sequence = ? where account = ?")
      .run(JSON.stringify(kept), Number(event.lastInsertRowid), account);
    other.exec("commit");
    other.close();

    await key(page, "r", 82);
    const first = order[0]!;
    await click(page, `Move ${first.title} down`);
    await key(page, "Enter", 13);
    const problems: string[] = [];
    await waitFor(() => says(page, "Your favourites changed."), 10_000).catch(() =>
      problems.push("the save wasn't refused"),
    );
    await press(page, "Reload");
    order = order.filter((channel) => channel !== gone);
    await waitFor(
      async () => (await drawn(page)).editing && !(await says(page, "Your favourites changed.")),
      10_000,
    ).catch(() => problems.push("Reload didn't start over"));
    problems.push(...(await listProblems(page, order, first)));
    await key(page, "ArrowDown", KEYS.ArrowDown, MODIFIERS.alt);
    order = moved(order, first, 1);
    await key(page, "Enter", 13);
    await waitFor(async () => !(await drawn(page)).editing, 10_000).catch(() =>
      problems.push("the order made after Reload didn't save"),
    );
    if (
      JSON.stringify((await listed(page)).map((c) => c.id)) !==
      JSON.stringify(order.map((c) => c.id))
    ) {
      problems.push("the record doesn't hold the order made after Reload");
    }
    report("Favourites changed behind the page are read again before an order saves", problems);
  }

  {
    await key(page, "r", 82);
    await key(page, "End", KEYS.End, MODIFIERS.alt);
    const extra = provider.catalogue.channels.find(
      (channel) =>
        !channel.offline && !starred.includes(String(channel.streamId)) && channel.streamId > 2100,
    );
    await invoke(page, "viewing.setFavourite", {
      commandId: crypto.randomUUID(),
      channel: own(String(extra?.streamId)),
      favourite: true,
    });
    const problems: string[] = [];
    await waitFor(async () => !(await drawn(page)).editing, 10_000).catch(() =>
      problems.push("the draft stayed"),
    );
    order = await listed(page);
    if (order.at(-1)?.id !== String(extra?.streamId)) problems.push("the new favourite isn't last");
    problems.push(...(await listProblems(page, order)));
    report("A favourite starred meanwhile ends the draft, and goes last", problems);
  }

  const asked = provider.streamRequests() - streams;
  report("Ordering asked the provider for no stream", asked === 0 ? [] : [`${asked} requests`]);

  {
    await press(page, "Home");
    await delay(1500);
    const tiles = await page.evaluate<string[]>(`(() => {
      const section = [...document.querySelectorAll("section")].find((each) => each.querySelector("h2")?.textContent === "Favourites");
      return [...(section?.querySelectorAll(".grid > button") ?? [])].map((tile) => tile.innerText);
    })()`);
    const problems = tiles.flatMap((tile, index) =>
      tile.includes(order[index]?.title ?? "\n")
        ? []
        : [`tile ${index + 1} is ${tile.replaceAll("\n", " / ")}, not ${order[index]?.title}`],
    );
    if (tiles.length < 2) problems.push(`${tiles.length} tiles`);
    report("Home's Favourites row follows the order", problems);
  }

  {
    await openFavourites(page);
    const problems: string[] = [];
    const playing = () =>
      page.evaluate<string>(`document.querySelector('[data-view="watch"] h2')?.textContent ?? ""`);
    await page.evaluate(`document.querySelector("main [data-index='1'] [role=button]").click()`);
    await waitFor(async () => (await playing()) === order[1]!.title, 15_000).catch(() =>
      problems.push("the second favourite didn't open"),
    );
    for (const [name, next] of [
      ["ArrowDown", 2],
      ["ArrowDown", 3],
      ["ArrowUp", 2],
      ["ArrowUp", 1],
      ["ArrowUp", 0],
    ] as const) {
      await key(page, name, KEYS[name]);
      await delay(600);
      const title = await playing();
      if (title !== order[next]!.title)
        problems.push(`${name} went to ${title}, not ${order[next]!.title}`);
    }
    await key(page, "Enter", 13);
    await delay(800);
    const rows = await page.evaluate<string[]>(
      `[...document.querySelectorAll('[data-view="watch"] [role=button] [title]')].map((name) => name.getAttribute("title"))`,
    );
    const names = await invoke<{ id: string; name: string }[]>(page, "library.channels", {
      channels: order.map(({ subscriptionId, id }) => ({ subscriptionId, id })),
    });
    rows.slice(0, 6).forEach((name, index) => {
      if (name !== names[index]?.name) problems.push(`Watch's list has ${name} at ${index + 1}`);
    });
    if (rows.length < 3) problems.push(`Watch's list shows ${rows.length} rows`);
    await key(page, "Escape", 27);
    await key(page, "Escape", 27);
    report("Watch's list and channel up and down follow the order", problems);
  }

  {
    await invoke(page, "library.refresh", { subscriptionId });
    await delay(1000);
    const problems: string[] = [];
    if (
      JSON.stringify((await listed(page)).map((c) => c.id)) !==
      JSON.stringify(order.map((c) => c.id))
    ) {
      problems.push("the order changed with the catalogue");
    }
    page.close();
    app.kill("SIGKILL");
    await delay(1500);
    port = randomPort();
    app = launch(executable, rest, { port, profile });
    page = await connect(port);
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await waitFor(() => page.evaluate<boolean>("!!document.querySelector('header')"));
    await openFavourites(page);
    problems.push(...(await listProblems(page, order)));
    if (
      JSON.stringify((await listed(page)).map((c) => c.id)) !==
      JSON.stringify(order.map((c) => c.id))
    ) {
      problems.push("the record lost the order over the restart");
    }
    report("The order holds after a new catalogue and a restart", problems);
  }
  page.close();
} catch (error) {
  console.error(`FAIL ${String(error)}`);
  failed = true;
} finally {
  app.kill("SIGKILL");
  await provider.close();
  await delay(1000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(failed ? 1 : 0);
