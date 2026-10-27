// The viewer's channel lists through the built window, with two fake providers that number their
// channels alike: made with New list by pointer and by keyboard, channels of both subscriptions
// put in from rows' lists menus, the same channels in the list, the guide grid, Watch's channel
// list and Home's row, an order saved and kept through a restart, renamed, moved and deleted from
// the header, a write refused while the harness holds the database's write lock, then sent
// again with Retry, a new order that ends when another list showing the same channels, or
// Favourites, is chosen, and New list from a row's lists menu while a provider's category is
// chosen or the lists' Find holds text. `custom-lists-sources` covers what the providers and the
// subscriptions do to a list: a lost canonical stream, a dropped channel, removal with and
// without Also delete, and channels for adults.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LANGUAGE_NAMES, type Locale } from "../../../../packages/contracts/src/language.ts";
import { translate } from "../../../../packages/core/src/i18n.ts";
import type { Driver } from "./language.ts";

const named = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;
const PICKER = `document.querySelector('[role=navigation][aria-label="Channel categories"]')`;
/** A list's entry in Live TV's lists, by its name. */
const rail = (title: string) =>
  `${PICKER}?.querySelector('button[title=${JSON.stringify(title)}]')`;
const NEW_LIST = `[...${PICKER}.querySelectorAll('[data-entry]')].find(e => e.textContent.trim() === 'New list')`;
const LIST_FIELD = `${PICKER}?.querySelector('input[aria-label="List name"]')`;
/** A channel's row in Live TV's list, by the provider's name of its first stream. */
const row = (name: string) =>
  `[...document.querySelectorAll('main [data-index]')].find(r => r.querySelector('[data-name=${JSON.stringify(name)}]'))`;
/** The row names Live TV's list shows, in order. */
const ROWS = `[...document.querySelectorAll('main [data-index]')].sort((a, b) => a.dataset.index - b.dataset.index).map(r => r.querySelector('[data-name]')?.dataset.name)`;
const HEADING = "document.querySelector('main h1')?.textContent";
const SETTINGS = "document.querySelector('header button[aria-pressed]')";
const MENU = "document.querySelector('[role=menu]')";
const check = (value: boolean, message: string) => {
  if (!value) throw new Error(message);
};

/** The two TEST channels both providers list under stream id 1000, as each names it. */
export const FIRST = "TEST | H.264 + AAC";
export const SECOND = "TEST | H.264 + AAC BACKUP";

/**
 * The second provider's channels, named apart from the first's so no search folds the two
 * together: the same ids, other names. Separator entries stay as they are.
 */
export function backupChannel<C extends { readonly name: string }>(channel: C): C {
  return channel.name.startsWith("#") ? channel : { ...channel, name: `${channel.name} BACKUP` };
}

/** Adds the second fixture subscription through Settings, as the viewer does. */
export async function addBackup(d: Driver, url: string, label = "Add second fixture subscription") {
  await d.click("Open Settings", SETTINGS);
  await d.click("Open Subscriptions", named("nav button", "Subscriptions"));
  await d.click(label, named("button", "Add subscription"));
  await d.wait(() => d.evaluate<boolean>("document.querySelectorAll('form input').length === 4"));
  for (const [index, text] of ["Backup", url, "demo", "demo"].entries()) {
    await d.click(
      `Fill second fixture field ${index + 1}`,
      `document.querySelectorAll('form input')[${index}]`,
    );
    await d.send("Input.insertText", { text });
  }
  await d.click("Connect second fixture", "document.querySelector('form button[type=submit]')");
  await d.wait(() =>
    d.evaluate<boolean>(
      "[...document.querySelectorAll('main section > ul > li')].some(row => row.innerText.includes('Backup'))",
    ),
  );
  await d.key("Escape", 27);
}

/** Opens Live TV on a list of the viewer's, or another entry of the lists, by its name. */
export async function openList(d: Driver, title: string) {
  if (!(await d.exists(PICKER))) await d.click("Open Live TV", named("header button", "Live TV"));
  await d.click(`Open ${title}`, rail(title));
  await d.wait(async () => (await d.evaluate<string | undefined>(HEADING)) === title);
}

/** Makes a list with New list by pointer: the field, the name, Enter. */
export async function makeList(d: Driver, name: string) {
  await d.click("New list", NEW_LIST);
  await d.wait(() => d.exists(`document.activeElement === ${LIST_FIELD}`));
  await d.send("Input.insertText", { text: name });
  await d.key("Enter", 13);
  await d.wait(async () => (await d.evaluate<string | undefined>(HEADING)) === name);
}

/** Finds a channel in the list shown by its list search, and opens its row's lists menu. */
export async function rowMenu(d: Driver, name: string, search: string) {
  const field = `document.querySelector('main input[aria-label^="Search "]')`;
  const typed = await d.evaluate<string>(`${field}?.value ?? ''`);
  if (typed !== search) {
    if (typed !== "")
      await d.click(
        "Clear the list search",
        "document.querySelector('main button[aria-label=\"Clear search\"]')",
      );
    await d.click("Search the list", field);
    await d.send("Input.insertText", { text: search });
  }
  await d.wait(() => d.exists(row(name)));
  await d.click(
    `Lists menu of ${name}`,
    `${row(name)}.querySelector('button[aria-label^="Lists for "]')`,
  );
  await d.wait(() => d.exists(MENU));
}

/** Ticks or clears a list in the open lists menu by pointer, and closes the menu. */
export async function tick(d: Driver, list: string, member: boolean) {
  const item = named("[role=menuitemcheckbox]", list);
  await d.wait(() => d.exists(item));
  const was = await d.evaluate<string>(`${item}.getAttribute('aria-checked')`);
  if ((was === "true") !== member) await d.click(`${member ? "Tick" : "Clear"} ${list}`, item);
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists(MENU)));
}

/** What the list shows in Live TV: its channels by provider name, in order. */
export const shownRows = (d: Driver) => d.evaluate<string[]>(ROWS);

/**
 * Holds the profile database's write lock while `held` runs, as another program would. Taking
 * it waits up to ten seconds for a write of the app's to end, then fails as SQLite says. The lock
 * is let go only once it was taken, the database closes either way, and a failure in letting go
 * never hides an earlier one.
 */
export async function withWriteLock(
  d: Pick<Driver, "profile" | "action">,
  held: () => Promise<void>,
): Promise<void> {
  const db = new DatabaseSync(join(d.profile, "mrstreamer.db"), { timeout: 10_000 });
  let locked = false;
  let failure: { readonly cause: unknown } | null = null;
  try {
    db.exec("begin exclusive");
    locked = true;
    d.action("Harness holds the database write lock (begin exclusive)");
    await held();
  } catch (cause) {
    failure = { cause };
  }
  try {
    if (locked) db.exec("rollback");
  } catch (cause) {
    failure ??= { cause };
  }
  try {
    db.close();
  } catch (cause) {
    failure ??= { cause };
  }
  if (locked) d.action("Harness lets the write lock go");
  if (failure) throw failure.cause;
}

export async function customListsScenario(
  d: Driver,
  fixture: { otherUrl: string; streams(): { requests: number; active: number } },
) {
  await addBackup(d, fixture.otherUrl);
  await d.click("Open Live TV", named("header button", "Live TV"));
  await d.wait(() => d.exists(PICKER));

  // New list by pointer: the field in the row's place, Enter makes the list and selects it.
  await makeList(d, "Late sport");
  await d.wait(() =>
    d.evaluate<boolean>("document.querySelector('main')?.textContent.includes('No channels yet.')"),
  );
  d.observed["madeByPointer"] = await d.evaluate<string[]>(
    `[...${PICKER}.querySelectorAll('[data-entry]')].map(e => e.title || e.textContent.trim())`,
  );
  await d.capture("made-by-pointer");

  // New list by keyboard: Left hands the keys to the lists, Down reaches New list, Enter opens
  // its field, and Enter again makes the list.
  await d.click("Back to All channels", rail("All channels"));
  await d.wait(async () => (await d.evaluate<string | undefined>(HEADING)) === "All channels");
  await d.key("ArrowLeft", 37);
  const highlighted = () =>
    d.evaluate<string | null>(`${PICKER}.querySelector('.ring-2')?.textContent.trim() ?? null`);
  // The lists' keys start on their first entry: Down, one entry at a time, to New list.
  await d.wait(async () => (await highlighted()) !== null);
  for (let step = 0; step < 6 && (await highlighted()) !== "New list"; step++) {
    await d.key("ArrowDown", 40);
    await d.evaluate("new Promise(resolve => requestAnimationFrame(() => resolve(true)))");
  }
  d.observed["keyboardHighlight"] = await highlighted();
  check(d.observed["keyboardHighlight"] === "New list", "Down didn't reach New list");
  await d.key("Enter", 13);
  await d.wait(() => d.exists(`document.activeElement === ${LIST_FIELD}`));
  await d.send("Input.insertText", { text: "Kids weekend" });
  await d.key("Enter", 13);
  await d.wait(async () => (await d.evaluate<string | undefined>(HEADING)) === "Kids weekend");
  d.observed["focusAfterKeyboardMake"] = await d.evaluate<string>(
    "document.activeElement?.title ?? ''",
  );
  await d.capture("made-by-keyboard");

  // A name another list has, apart from case: said in place, nothing made; Escape puts the row back.
  await d.click("New list for a taken name", NEW_LIST);
  await d.wait(() => d.exists(`document.activeElement === ${LIST_FIELD}`));
  await d.send("Input.insertText", { text: "LATE SPORT" });
  await d.key("Enter", 13);
  await d.wait(() =>
    d.evaluate<boolean>(
      `${PICKER}.querySelector('[role=alert]')?.textContent.includes('Another list has this name.') ?? false`,
    ),
  );
  await d.capture("name-taken");
  await d.key("Escape", 27);
  await d.wait(() => d.exists(NEW_LIST));
  d.observed["focusAfterEscape"] = await d.evaluate<string>(
    "document.activeElement?.textContent.trim() ?? ''",
  );
  const listsAfterTaken = await d.evaluate<unknown>(
    "(async()=>{const r=await window.mrStreamer.invoke('customLists.get');return r.ok?r.value.map(l=>l.name):null;})()",
  );
  check(
    JSON.stringify(listsAfterTaken) === JSON.stringify(["Late sport", "Kids weekend"]),
    "A taken name made a list",
  );

  // Channels of both subscriptions, the same provider id in each, from rows' lists menus.
  await openList(d, "All channels");
  await rowMenu(d, FIRST, "H.264");
  await d.capture("row-lists-menu");
  await tick(d, "Late sport", true);
  // The second by keyboard in the menu: Down highlights the first list, Space ticks it.
  await rowMenu(d, SECOND, "H.264");
  await d.key("ArrowDown", 40);
  d.observed["menuHighlight"] = await d.evaluate<string | null>(
    "document.querySelector('[role=menu] [data-highlighted]')?.textContent.trim() ?? null",
  );
  check(d.observed["menuHighlight"] === "Late sport", "Down didn't highlight the first list");
  await d.key(" ", 32);
  await d.wait(() =>
    d.evaluate<boolean>(
      `${named("[role=menuitemcheckbox]", "Late sport")}?.getAttribute('aria-checked') === 'true'`,
    ),
  );
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists(MENU)));
  await rowMenu(d, "TEST | HEVC + AAC", "HEVC");
  await tick(d, "Late sport", true);
  await rowMenu(d, "TEST | HEVC + AAC", "HEVC");
  await tick(d, "Kids weekend", true);
  await d.click(
    "Clear the list search",
    "document.querySelector('main button[aria-label=\"Clear search\"]')",
  );

  await openList(d, "Late sport");
  await d.wait(async () => (await shownRows(d)).length === 3);
  const members = await shownRows(d);
  d.observed["lateSport"] = members;
  check(
    JSON.stringify(members) === JSON.stringify([FIRST, SECOND, "TEST | HEVC + AAC"]),
    "Late sport holds other channels",
  );
  d.observed["railCounts"] = await d.evaluate<string[]>(
    `[...${PICKER}.querySelectorAll('[data-entry]')].slice(3, 6).map(e => e.textContent.trim())`,
  );
  await d.capture("list-two-subscriptions");

  // The same channels in the guide grid, in the same order.
  await d.key("g", 71);
  await d.wait(() => d.exists("document.querySelector('[role=grid][aria-label=Guide]')"));
  const grid = await d.evaluate<string[]>(
    "[...document.querySelectorAll('[role=grid] [role=rowheader]')].map(e => e.title)",
  );
  d.observed["gridRows"] = grid;
  check(JSON.stringify(grid) === JSON.stringify(members), "The guide grid shows other channels");
  await d.capture("list-guide-grid");
  await d.key("g", 71);
  await d.wait(() => d.exists(row(FIRST)));

  // Watch's channel list: the same list, its channels in its order, and channel up follows it.
  await d.click("Watch the first channel", row(FIRST));
  await d.wait(() => d.exists("document.querySelector('[data-view=watch]')"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "(() => { const v = document.querySelector('video'); return !!v && !v.paused && v.currentTime > 0.5; })()",
    ),
  );
  await d.click(
    "Open Watch's channels",
    "document.querySelector('[data-view=watch] button[aria-label=Channels]')",
  );
  await d.wait(() =>
    d.evaluate<boolean>(
      "[...document.querySelectorAll('[data-view=watch] header button')].some(b => b.textContent.includes('Late sport'))",
    ),
  );
  d.observed["watchList"] = await d.evaluate<string[]>(
    "[...document.querySelectorAll('[data-view=watch] [role=button] > span[title]')].sort((a, b) => parseFloat(a.parentElement.style.top) - parseFloat(b.parentElement.style.top)).map(e => e.title)",
  );
  await d.capture("list-watch-overlay");
  check(
    JSON.stringify(d.observed["watchList"]) === JSON.stringify(members),
    "Watch's channel list holds other channels",
  );
  await d.key("Escape", 27);
  // Channel down goes to the list's next channel: the other subscription's.
  await d.key("ArrowDown", 40);
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelector('[data-view=watch]')?.innerText.toLowerCase().includes('backup') ?? false",
    ),
  );
  d.observed["channelDownFollowsList"] = true;
  d.observed["streamsWhileWatching"] = fixture.streams();
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists("document.querySelector('[data-view=watch]')")));

  // Home's category row follows the list chosen in Live TV, at ordinary visibility.
  await d.click("Open Home", named("header button", "Home"));
  await d.wait(() => d.exists("document.querySelector('[data-home-row=category] h2')"));
  d.observed["homeRow"] = await d.evaluate<{ title: string; text: string }>(
    "(() => { const r = document.querySelector('[data-home-row=category]'); return { title: r.querySelector('h2').textContent, text: r.innerText }; })()",
  );
  check(
    (d.observed["homeRow"] as { title: string }).title === "Late sport",
    "Home's row isn't the list",
  );
  await d.capture("list-home-row");

  // Reorder, as Favourites: the keys start on the playing channel, the second subscription's
  // since channel down; Alt with Down moves it, Enter saves.
  const reordered = [FIRST, "TEST | HEVC + AAC", SECOND];
  await openList(d, "Late sport");
  await d.click("Reorder", named("main button", "Reorder"));
  await d.wait(() =>
    d.exists(
      "document.querySelector('[role=list][aria-label=\"Late sport, in the order to save\"]')",
    ),
  );
  await d.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "ArrowDown",
    windowsVirtualKeyCode: 40,
    modifiers: 1,
  });
  await d.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "ArrowDown",
    windowsVirtualKeyCode: 40,
    modifiers: 1,
  });
  d.action("Press Alt+ArrowDown");
  await d.capture("reorder-draft");
  await d.key("Enter", 13);
  await d.wait(
    async () =>
      !(await d.exists(
        "document.querySelector('[role=list][aria-label$=\"in the order to save\"]')",
      )),
  );
  await d.wait(async () => JSON.stringify(await shownRows(d)) === JSON.stringify(reordered));
  d.observed["reordered"] = await shownRows(d);

  // A restart keeps the lists, their channels, the order and the list chosen.
  await d.quit();
  await d.launch();
  await d.wait(() => d.exists("document.querySelector('header')"));
  d.observed["rememberedAfterRestart"] = await d.evaluate<unknown>(
    "(async()=>{const r=await window.mrStreamer.invoke('liveBrowse.get');return r.ok?r.value:null;})()",
  );
  await d.click("Open Live TV after restart", named("header button", "Live TV"));
  await d.wait(async () => (await d.evaluate<string | undefined>(HEADING)) === "Late sport");
  await d.wait(async () => JSON.stringify(await shownRows(d)) === JSON.stringify(reordered));
  d.observed["afterRestart"] = await shownRows(d);
  await d.capture("after-restart");

  // Rename from the header's options, by keyboard in the menu and the field.
  await d.click(
    "Options for Late sport",
    "document.querySelector('main button[aria-label=\"Options for Late sport\"]')",
  );
  await d.wait(() => d.exists(MENU));
  await d.capture("header-options");
  await d.key("ArrowDown", 40);
  await d.key("Enter", 13);
  await d.wait(() =>
    d.exists("document.activeElement?.matches('main input[aria-label=\"List name\"]')"),
  );
  await d.send("Input.insertText", { text: "Late sports" });
  await d.capture("rename-field");
  await d.key("Enter", 13);
  await d.wait(async () => (await d.evaluate<string | undefined>(HEADING)) === "Late sports");

  // Move down from the same menu: the lists' order changes, and the list stays chosen.
  await d.click(
    "Options for Late sports",
    "document.querySelector('main button[aria-label=\"Options for Late sports\"]')",
  );
  await d.click("Move down", named("[role=menuitem]", "Move down"));
  await d.wait(() =>
    d.evaluate<boolean>(
      `(() => { const t = [...${PICKER}.querySelectorAll('[data-entry]')].map(e => e.title); return t.indexOf('Kids weekend') < t.indexOf('Late sports'); })()`,
    ),
  );
  d.observed["movedRail"] = await d.evaluate<string[]>(
    `[...${PICKER}.querySelectorAll('[data-entry]')].slice(3, 6).map(e => e.title || e.textContent.trim())`,
  );

  // A write refused while another program holds the database's write lock: the menu's change says
  // Couldn't save with Retry, and Retry once the lock is let go stores it.
  await withWriteLock(d, async () => {
    await rowMenu(d, "TEST | HEVC + AAC", "HEVC");
    await tick(d, "Late sports", false);
    await d.wait(
      () =>
        d.evaluate<boolean>(
          "[...document.querySelectorAll('main [role=alert]')].some(e => e.textContent.includes(\"Couldn't save.\"))",
        ),
      15_000,
    );
    await d.capture("failed-write");
    // New list while the lock is held: the field says so and keeps the name.
    await d.click("New list while locked", NEW_LIST);
    await d.wait(() => d.exists(`document.activeElement === ${LIST_FIELD}`));
    await d.send("Input.insertText", { text: "News 24" });
    await d.key("Enter", 13);
    await d.wait(
      () =>
        d.evaluate<boolean>(
          `${PICKER}.querySelector('[role=alert]')?.textContent.includes("Couldn't save.") ?? false`,
        ),
      15_000,
    );
    await d.capture("failed-create");
  });
  await d.click("Retry the list's change", named("main [role=alert] button", "Retry"));
  await d.wait(() =>
    d.evaluate<boolean>(`${rail("Late sports")}?.textContent.trim() === 'Late sports2'`),
  );
  // Enter in the field, which kept the focus, sends the same list again: one list, as asked.
  d.observed["focusAfterFailedCreate"] = await d.evaluate<boolean>(
    `document.activeElement === ${LIST_FIELD}`,
  );
  if (!d.observed["focusAfterFailedCreate"])
    await d.click("Back to the New list field", LIST_FIELD);
  await d.key("Enter", 13);
  await d.wait(async () => (await d.evaluate<string | undefined>(HEADING)) === "News 24");
  d.observed["afterRetry"] = await d.evaluate<unknown>(
    "(async()=>{const r=await window.mrStreamer.invoke('customLists.get');return r.ok?r.value.map(l=>[l.name,l.members.length]):null;})()",
  );
  check(
    JSON.stringify(d.observed["afterRetry"]) ===
      JSON.stringify([
        ["Kids weekend", 1],
        ["Late sports", 2],
        ["News 24", 0],
      ]),
    "Retry stored something else",
  );
  // Another list starts without the search typed in this one.
  await openList(d, "Late sports");
  await d.wait(async () => JSON.stringify(await shownRows(d)) === JSON.stringify([FIRST, SECOND]));
  await d.capture("after-retry");

  // Delete asks once, falls back to All channels without a notice, and a new list of its name
  // holds none of its channels.
  await openList(d, "Kids weekend");
  await d.click(
    "Options for Kids weekend",
    "document.querySelector('main button[aria-label=\"Options for Kids weekend\"]')",
  );
  await d.click("Delete list", named("[role=menuitem]", "Delete list"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelector('main [role=group]')?.textContent.includes('Delete Kids weekend?') ?? false",
    ),
  );
  await d.capture("delete-question");
  await d.click("Confirm Delete list", named("main [role=group] button", "Delete list"));
  await d.wait(async () => (await d.evaluate<string | undefined>(HEADING)) === "All channels");
  d.observed["noticeAfterDelete"] = await d.evaluate<boolean>(
    `${PICKER}.textContent.includes('no longer listed')`,
  );
  check(d.observed["noticeAfterDelete"] === false, "Deleting a list said it was no longer listed");
  await makeList(d, "Kids weekend");
  await d.wait(() =>
    d.evaluate<boolean>("document.querySelector('main')?.textContent.includes('No channels yet.')"),
  );
  d.observed["sameNameAfterDelete"] = await d.evaluate<unknown>(
    "(async()=>{const r=await window.mrStreamer.invoke('customLists.get');return r.ok?r.value.map(l=>[l.name,l.members.length]):null;})()",
  );
  await d.capture("same-name-empty");

  // A new order belongs to the list it was made in. Kids weekend gets Late sports' two channels in
  // the same order, so both lists show one answer of the library; a draft of Late sports ends when
  // Kids weekend is chosen, and Kids weekend's own Save changes Kids weekend alone.
  const saved = () =>
    d.evaluate<{ name: string; revision: number; channels: string[] }[]>(
      "(async()=>{const r=await window.mrStreamer.invoke('customLists.get');return r.ok?r.value.map(l=>({name:l.name,revision:l.revision,channels:l.members.map(m=>m.channel?.id??m.kind)})):[];})()",
    );
  const favourites = () =>
    d.evaluate<unknown>(
      "(async()=>{const r=await window.mrStreamer.invoke('viewing.get');return r.ok?r.value.favourites:null;})()",
    );
  const lateSports = async () => (await saved()).find((list) => list.name === "Late sports");
  await openList(d, "All channels");
  for (const name of [FIRST, SECOND]) {
    await rowMenu(d, name, "H.264 + AAC");
    await tick(d, "Kids weekend", true);
  }
  await d.click(
    "Clear the list search",
    "document.querySelector('main button[aria-label=\"Clear search\"]')",
  );
  await openList(d, "Late sports");
  const before = await lateSports();
  await draftFirstDown(d, "Late sports");
  await openList(d, "Kids weekend");
  d.observed["draftAfterListSwitch"] = await d.exists(DRAFT);
  check(d.observed["draftAfterListSwitch"] === false, "Late sports' draft stayed in Kids weekend");
  check(
    JSON.stringify(await shownRows(d)) === JSON.stringify([FIRST, SECOND]),
    "Kids weekend shows another order",
  );
  await d.capture("switched-list-without-draft");
  await draftFirstDown(d, "Kids weekend");
  await d.key("Enter", 13);
  await d.wait(async () => !(await d.exists(DRAFT)));
  await d.wait(async () => JSON.stringify(await shownRows(d)) === JSON.stringify([SECOND, FIRST]));
  check(
    JSON.stringify(await lateSports()) === JSON.stringify(before),
    "Kids weekend's Save changed Late sports",
  );
  await openList(d, "Late sports");
  check(
    JSON.stringify(await shownRows(d)) === JSON.stringify([FIRST, SECOND]),
    "Late sports doesn't show its saved order",
  );
  // The same from Favourites, starred in Late sports' order: its draft ends when Late sports is
  // chosen, and Late sports' own Save changes Late sports alone.
  for (const name of [FIRST, SECOND])
    await d.click(
      `Star ${name}`,
      `${row(name)}.querySelector('button[aria-label="Add to favourites"]')`,
    );
  await openList(d, "Favourites");
  await d.wait(async () => JSON.stringify(await shownRows(d)) === JSON.stringify([FIRST, SECOND]));
  const starred = await favourites();
  await draftFirstDown(d, "Favourites");
  await openList(d, "Late sports");
  d.observed["draftAfterFavouritesSwitch"] = await d.exists(DRAFT);
  check(
    d.observed["draftAfterFavouritesSwitch"] === false,
    "The Favourites draft stayed in Late sports",
  );
  await draftFirstDown(d, "Late sports");
  await d.key("Enter", 13);
  await d.wait(async () => !(await d.exists(DRAFT)));
  await d.wait(async () => JSON.stringify(await shownRows(d)) === JSON.stringify([SECOND, FIRST]));
  check(
    JSON.stringify(await favourites()) === JSON.stringify(starred),
    "Late sports' Save changed the favourites",
  );
  await openList(d, "Favourites");
  check(
    JSON.stringify(await shownRows(d)) === JSON.stringify([FIRST, SECOND]),
    "Favourites doesn't show its saved order",
  );
  d.observed["listsAfterSwitchedDrafts"] = await saved();
  await d.capture("favourites-after-switched-draft");

  // New list in a row's lists menu opens the rail's field, focused, from a provider's category,
  // which stays on screen: Escape makes no list, and Enter makes one with that row's channel.
  const listed = async () =>
    (await saved()).map((list) => [list.name, list.channels.length] as const);
  const newListFromRow = async (name: string) => {
    await d.click(
      `Lists menu of ${name}`,
      `${row(name)}.querySelector('button[aria-label^="Lists for "]')`,
    );
    await d.wait(() => d.exists(MENU));
    await d.click(`New list for ${name}`, named("[role=menu] [role=menuitem]", "New list"));
    await d.wait(() => d.exists(`document.activeElement === ${LIST_FIELD}`));
  };
  const entries = () =>
    d.evaluate<string[]>(`[...${PICKER}.querySelectorAll('[data-entry]')].map(e => e.title)`);
  const openQuality = async () => {
    await d.click("Open Provider lists", rail("Provider lists"));
    await d.click("Open Belgium", rail("Belgium"));
    const quality = (await entries()).find((title) => title.startsWith("Kwaliteit"));
    check(quality !== undefined, "Belgium lists no Kwaliteit");
    await d.click(`Open ${quality}`, rail(quality!));
    await d.wait(async () => (await d.evaluate<string | undefined>(HEADING)) === "Kwaliteit");
    return quality!;
  };
  const quality = await openQuality();
  await d.wait(() => d.exists("document.querySelector('main [data-index=\"0\"] [data-name]')"));
  const firstRow = await d.evaluate<string>(
    "document.querySelector('main [data-index=\"0\"] [data-name]')?.dataset.name ?? ''",
  );
  const listsBefore = await listed();
  await newListFromRow(firstRow);
  const fromCategory = { heading: await d.evaluate<string | undefined>(HEADING) };
  d.observed["fieldFromCategory"] = fromCategory;
  check(fromCategory.heading === "Kwaliteit", "The category left the screen");
  await d.capture("new-list-from-category");
  await d.send("Input.insertText", { text: "Never made" });
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists(LIST_FIELD)));
  const escaped = { heading: await d.evaluate<string | undefined>(HEADING), lists: await listed() };
  d.observed["escapeFromCategory"] = escaped;
  check(
    escaped.heading === "Kwaliteit" &&
      JSON.stringify(escaped.lists) === JSON.stringify(listsBefore),
    "Escape made a list or left the category",
  );
  await openQuality();
  await newListFromRow(firstRow);
  await d.send("Input.insertText", { text: "From Belgium" });
  await d.key("Enter", 13);
  await d.wait(async () => (await d.evaluate<string | undefined>(HEADING)) === "From Belgium");
  await d.wait(async () => (await shownRows(d)).length > 0);
  const made = (await saved()).filter((list) => list.name === "From Belgium");
  const shown = await shownRows(d);
  d.observed["madeFromCategory"] = { from: quality, row: firstRow, shown, stored: made };
  check(
    JSON.stringify(shown) === JSON.stringify([firstRow]) && made.length === 1,
    "The list from the category holds another channel, or was made twice",
  );
  await d.capture("made-from-category");

  // The same over the rail's Find, for a channel of the list on screen.
  await openList(d, "Late sports");
  const find = `${PICKER}.querySelector('input[aria-label="Find a category"]')`;
  await d.click("Find a category", find);
  await d.send("Input.insertText", { text: "kwal" });
  await d.wait(async () => !(await entries()).includes("Late sports"));
  await newListFromRow(FIRST);
  const fromFind = {
    heading: await d.evaluate<string | undefined>(HEADING),
    find: await d.evaluate<string>(`${find}.value`),
  };
  d.observed["fieldFromFind"] = fromFind;
  check(
    fromFind.heading === "Late sports" && fromFind.find === "",
    "Late sports left the screen, or Find kept its text",
  );
  await d.send("Input.insertText", { text: "From Find" });
  await d.key("Enter", 13);
  await d.wait(async () => (await d.evaluate<string | undefined>(HEADING)) === "From Find");
  check(
    JSON.stringify(await shownRows(d)) === JSON.stringify([FIRST]),
    "The list from Find holds another channel",
  );
  d.observed["listsAfterRowNewList"] = await saved();
  await d.capture("made-from-find");
}

/** A new order's rows while one is being made. */
const DRAFT = "document.querySelector('[role=list][aria-label$=\"in the order to save\"]')";

/** Reorder, then Home and Alt+Down: the first channel goes down one place in the draft. */
async function draftFirstDown(d: Driver, list: string) {
  await d.click(`Reorder ${list}`, named("main button", "Reorder"));
  await d.wait(() => d.exists(DRAFT));
  await d.key("Home", 36);
  d.action(`Press Alt+ArrowDown in ${list}'s draft`);
  for (const type of ["rawKeyDown", "keyUp"])
    await d.send("Input.dispatchKeyEvent", {
      type,
      key: "ArrowDown",
      windowsVirtualKeyCode: 40,
      modifiers: 1,
    });
}

/** The first provider's channel in Full HD, HD and SD, by its Full HD stream's name and id. */
const QUALITY = "BE | KWALITEIT 1 FHD";
/** The same channel once the provider no longer lists its Full HD stream. */
const QUALITY_HD = "BE | KWALITEIT 1 HD";
const DROPPED = "TEST | HEVC + AAC";
/** For adults: flagged in an ordinary category, and in a category named for adults. */
const AFTER_HOURS = "AFTER HOURS";
const LATE_SHOW = "LATE SHOW";
const AWAY_ADULT = "AFTER HOURS BACKUP";
const SUBSCRIPTION_ROWS = "document.querySelectorAll('main section > ul > li')";

/** Settings > Movies and series: For adults, on or off, saved before it goes on. */
async function adults(d: Driver, on: boolean) {
  await d.click("Open Settings for adults", SETTINGS);
  await d.click("Open Movies and series settings", named("nav button", "Movies and series"));
  const toggle = "document.querySelector('[role=checkbox][aria-label=\"For adults\"]')";
  await d.wait(() => d.exists(toggle));
  if ((await d.evaluate<string>(`${toggle}.getAttribute('aria-checked')`)) !== String(on))
    await d.click(`${on ? "Show" : "Hide"} channels for adults`, toggle);
  await d.wait(() =>
    d.evaluate<boolean>(
      `(async () => { const p = await window.mrStreamer.invoke('preferences.get'); return p.ok && p.value.preferences.adultTitles === ${on}; })()`,
    ),
  );
  await d.key("Escape", 27);
}

/** Refreshes a subscription's channels from Settings > Subscriptions, and waits for the fetch. */
async function refreshChannels(d: Driver, index: number) {
  await d.click("Open Settings to refresh channels", SETTINGS);
  await d.click("Open Subscriptions", named("nav button", "Subscriptions"));
  const item = `${SUBSCRIPTION_ROWS}[${index}]`;
  if (!(await d.exists(`${item}.querySelector('button[aria-label="Refresh channels"]')`)))
    await d.click(`Open subscription ${index + 1}`, `${item}.querySelector('button')`);
  const stamp = await d.evaluate<number>(
    `(async () => { const r = await window.mrStreamer.invoke('library.status'); return r.ok ? r.value[${index}].fetchedAt : 0; })()`,
  );
  await d.click(
    `Refresh subscription ${index + 1}`,
    `${item}.querySelector('button[aria-label="Refresh channels"]')`,
  );
  await d.wait(() =>
    d.evaluate<boolean>(
      `(async () => { const r = await window.mrStreamer.invoke('library.status'); return r.ok && r.value[${index}].fetchedAt > ${stamp}; })()`,
    ),
  );
  await d.key("Escape", 27);
}

/**
 * Picks the interface language in Settings > General with the keyboard, as the viewer does: a
 * name typed into the closed select, whole, so "English" can't land on Español. "system" types
 * System default's own name and goes back to the harness's English. The app's own text changes
 * at once.
 */
async function interfaceLanguage(d: Driver, from: Locale, to: Locale | "system") {
  const select = `document.querySelector('main section select:has(option[value="en-US"])')`;
  await d.click("Open Settings for the interface language", SETTINGS);
  if (!(await d.exists(select)))
    await d.click("Open General settings", named("nav button", translate(from, "General")));
  await d.wait(() => d.exists(select));
  const name =
    to === "system"
      ? await d.evaluate<string>(`${select}.options[0].textContent`)
      : LANGUAGE_NAMES[to];
  d.action(`Pick ${name} with the keyboard`);
  await d.evaluate(`${select}.focus()`);
  for (const char of name) {
    await d.send("Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char });
    await d.send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
  }
  const lang = to === "system" ? "en-US" : to;
  await d.wait(() =>
    d.evaluate<boolean>(`document.documentElement.lang === ${JSON.stringify(lang)}`),
  );
  await d.key("Escape", 27);
}

/**
 * The removal question of the second subscription, at the smallest window the app allows, 960 ×
 * 600, in `locale`'s words: its Also delete box with its whole label, Remove and Keep each drawn,
 * in the page's width and the one thing under its own middle. The page is sized, not the window,
 * as the language scenario does.
 */
async function removalQuestion(d: Driver, locale: Locale) {
  await d.send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  });
  d.action("Size the page as the smallest window, 960 × 600");
  await d.wait(() => d.evaluate<boolean>("innerWidth === 960 && innerHeight === 600"));
  const item = `${SUBSCRIPTION_ROWS}[1]`;
  const label = translate(
    locale,
    "Also delete favourites, watchlist, history, progress and channels in lists",
  );
  await d.evaluate(
    `${item}.querySelector('[role=checkbox]').closest('label').scrollIntoView({ block: "center" })`,
  );
  await d.evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  const seen = await d.evaluate<{
    label: string;
    lines: number;
    parts: { part: string; fits: boolean; hit: boolean; box: number[] }[];
  }>(`(() => {
    const item = ${item};
    const box = item.querySelector('[role=checkbox]');
    const label = box.closest('label');
    const buttons = [...item.querySelectorAll('button')];
    const parts = [
      ['label', label],
      ['checkbox', box],
      ['remove', buttons.find(b => b.textContent.trim() === ${JSON.stringify(translate(locale, "Remove"))})],
      ['keep', buttons.find(b => b.textContent.trim() === ${JSON.stringify(translate(locale, "Keep"))})],
    ];
    const text = [...label.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    const lineHeight = parseFloat(getComputedStyle(label).lineHeight) || 22;
    return {
      label: text,
      lines: Math.round(label.getBoundingClientRect().height / lineHeight),
      parts: parts.map(([part, element]) => {
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return {
          part,
          fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && r.width > 0,
          hit: !!hit && (element === hit || element.contains(hit) || (part === 'label' && label.contains(hit))),
          box: [r.left, r.top, r.width, r.height].map(Math.round),
        };
      }),
    };
  })()`);
  d.observed[`removalQuestion:${locale}`] = seen;
  check(seen.label === label, `The Also delete label in ${locale} reads otherwise`);
  check(
    seen.parts.every((part) => part.fits && part.hit),
    `Part of the removal question in ${locale} is clipped or covered`,
  );
  await d.capture(`removal-question-${locale}-960`);
}

/**
 * Removes the second subscription from Settings, with Also delete ticked or not, in `locale`'s
 * words, after checking its question at the smallest window. `keep` answers Keep instead, which
 * leaves it saved.
 */
async function removeBackup(
  d: Driver,
  erase: boolean,
  { locale = "en-US", keep = false }: { locale?: Locale; keep?: boolean } = {},
) {
  await d.click("Open Settings to remove a subscription", SETTINGS);
  await d.click("Open Subscriptions", named("nav button", translate(locale, "Subscriptions")));
  const item = `${SUBSCRIPTION_ROWS}[1]`;
  if (!(await d.exists(`${item}.querySelector('[role=region]')`)))
    await d.click("Open the second subscription", `${item}.querySelector('button')`);
  const ask = translate(locale, "Remove {name}", { name: "Backup" });
  await d.click(
    "Ask to remove it",
    `[...${item}.querySelectorAll('button')].find(e => e.textContent.trim() === ${JSON.stringify(ask)})`,
  );
  await removalQuestion(d, locale);
  if (keep) {
    await d.click(
      "Keep it",
      `[...${item}.querySelectorAll('button')].find(e => e.textContent.trim() === ${JSON.stringify(translate(locale, "Keep"))})`,
    );
    await d.wait(async () => !(await d.exists(`${item}.querySelector('[role=checkbox]')`)));
  } else {
    if (erase) await d.click("Tick Also delete", `${item}.querySelector('[role=checkbox]')`);
    await d.click(
      erase ? "Remove with Also delete" : "Remove without erasing",
      `[...${item}.querySelectorAll('button')].find(e => e.textContent.trim() === ${JSON.stringify(translate(locale, "Remove"))})`,
    );
    await d.wait(() =>
      d.evaluate<boolean>(
        "(async () => { const r = await window.mrStreamer.invoke('subscription.list'); return r.ok && r.value.length === 1; })()",
      ),
    );
  }
  await d.send("Emulation.clearDeviceMetricsOverride");
  await d.wait(() => d.evaluate<boolean>("innerWidth > 960"));
  await d.key("Escape", 27);
}

/** What the list shows: its rows, the not-listed channels at its end, and the away line. */
const shownList = (d: Driver) =>
  d.evaluate<{
    rows: string[];
    unlisted: string[];
    away: string | null;
    rail: string | null;
  }>(`(() => ({
    rows: ${ROWS},
    unlisted: [...document.querySelectorAll('main [role=list][aria-label="Not listed now"] [role=listitem]')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()),
    away: [...document.querySelectorAll('main p')].find(p => p.textContent.includes("isn't saved") || p.textContent.includes("aren't saved"))?.textContent ?? null,
    rail: ${rail("Mixed")}?.textContent.trim() ?? null,
  }))()`);

export async function customListSourcesScenario(
  d: Driver,
  fixture: { otherUrl: string; drop(): void },
) {
  await addBackup(d, fixture.otherUrl);
  await adults(d, true);
  await d.click("Open Live TV", named("header button", "Live TV"));
  await d.wait(() => d.exists(PICKER));
  await makeList(d, "Mixed");
  await openList(d, "All channels");
  for (const [name, search] of [
    [FIRST, "H.264 + AAC"],
    [QUALITY, "Kwaliteit"],
    [DROPPED, "HEVC"],
    [AFTER_HOURS, "After Hours"],
    [LATE_SHOW, "Late Show"],
    [SECOND, "H.264 + AAC"],
    [AWAY_ADULT, "After Hours"],
  ] as const) {
    await rowMenu(d, name, search);
    await tick(d, "Mixed", true);
  }
  await d.click(
    "Clear the list search",
    "document.querySelector('main button[aria-label=\"Clear search\"]')",
  );
  await openList(d, "Mixed");
  const all = [FIRST, QUALITY, DROPPED, AFTER_HOURS, LATE_SHOW, SECOND, AWAY_ADULT];
  await d.wait(async () => JSON.stringify((await shownList(d)).rows) === JSON.stringify(all));
  d.observed["made"] = await shownList(d);
  await d.capture("sources-made");

  // The provider stops listing the Full HD stream the channel went by, one channel, and one for
  // adults: the first goes on by its HD stream, the others show by name with Remove.
  fixture.drop();
  await refreshChannels(d, 0);
  await openList(d, "Mixed");
  await d.wait(async () => (await shownList(d)).unlisted.length === 2);
  const dropped = await shownList(d);
  d.observed["afterProviderChange"] = dropped;
  check(
    JSON.stringify(dropped.rows) ===
      JSON.stringify([FIRST, QUALITY_HD, AFTER_HOURS, SECOND, AWAY_ADULT]),
    "The list lost a channel the provider still lists, or kept one it dropped",
  );
  check(
    dropped.unlisted.every((each) => each.includes("Not listed by")),
    "Dropped channels aren't said to be unlisted",
  );
  await d.capture("sources-provider-changed");

  // Adults hidden: nothing for adults shows or counts, listed or not.
  await adults(d, false);
  await openList(d, "Mixed");
  await d.wait(async () => (await shownList(d)).rows.length === 3);
  const hidden = await shownList(d);
  d.observed["adultsHidden"] = hidden;
  check(
    JSON.stringify(hidden.rows) === JSON.stringify([FIRST, QUALITY_HD, SECOND]) &&
      hidden.unlisted.length === 1 &&
      hidden.rail === "Mixed4",
    "Adults hidden still shows or counts one for adults",
  );
  await d.capture("sources-adults-hidden");

  // Remove takes out the dropped channel.
  await d.click(
    "Remove the dropped channel",
    "document.querySelector('main [role=list][aria-label=\"Not listed now\"] button')",
  );
  await d.wait(async () => (await shownList(d)).unlisted.length === 0);
  d.observed["afterRemove"] = await shownList(d);

  // The second subscription removed without erasing: its channels are counted, not shown, and
  // the one for adults isn't counted while adults are hidden.
  await removeBackup(d, false);
  await openList(d, "Mixed");
  await d.wait(async () => (await shownList(d)).away !== null);
  const away = await shownList(d);
  d.observed["awayAdultsHidden"] = away;
  check(
    away.away?.startsWith("1 channel is from") === true,
    "The away count shows a channel for adults, or none",
  );
  await d.capture("sources-away-adults-hidden");
  await adults(d, true);
  await openList(d, "Mixed");
  await d.wait(async () => (await shownList(d)).away?.startsWith("2 channels are from") === true);
  d.observed["awayAdultsShown"] = await shownList(d);
  await d.capture("sources-away");

  // Added again: its channels are back, in their places.
  await addBackup(d, fixture.otherUrl, "Add the second subscription again");
  await openList(d, "Mixed");
  await d.wait(
    async () =>
      JSON.stringify((await shownList(d)).rows) ===
      JSON.stringify([FIRST, QUALITY_HD, AFTER_HOURS, SECOND, AWAY_ADULT]),
  );
  d.observed["readded"] = await shownList(d);
  await d.capture("sources-readded");

  // Removed with Also delete, its label in the two longest languages at the smallest window:
  // French, then Keep, and Dutch, ticked. Added again, nothing of its account is in the list,
  // and the database keeps none of its channels.
  await interfaceLanguage(d, "en-US", "fr-FR");
  await removeBackup(d, true, { locale: "fr-FR", keep: true });
  await interfaceLanguage(d, "fr-FR", "nl-NL");
  await removeBackup(d, true, { locale: "nl-NL" });
  await interfaceLanguage(d, "nl-NL", "system");
  await addBackup(d, fixture.otherUrl, "Add the second subscription after erasing");
  await openList(d, "Mixed");
  await d.wait(
    async () =>
      JSON.stringify((await shownList(d)).rows) ===
      JSON.stringify([FIRST, QUALITY_HD, AFTER_HOURS]),
  );
  const erased = await shownList(d);
  d.observed["afterErase"] = erased;
  check(erased.away === null, "An erased account's channels are still counted");
  await d.capture("sources-erased");
  // Diagnostic only, not a user path: what the file keeps of the erased account.
  const db = new DatabaseSync(join(d.profile, "mrstreamer.db"), { readOnly: true });
  try {
    const kept = db
      .prepare("select account, count(*) as n from custom_list_members group by account")
      .all();
    d.observed["diagnosticMembersByAccount"] = kept.map((each) => ({
      account: String(each["account"]).includes("|demo") ? "fixture account" : "other",
      backup: String(each["account"]).startsWith(fixture.otherUrl),
      n: each["n"],
    }));
    check(
      !kept.some((each) => String(each["account"]).startsWith(fixture.otherUrl)),
      "The erased account's channels stayed in the file",
    );
  } finally {
    db.close();
  }

  // A restart keeps what is left as it is.
  await d.quit();
  await d.launch();
  await d.wait(() => d.exists("document.querySelector('header')"));
  await openList(d, "Mixed");
  await d.wait(
    async () =>
      JSON.stringify((await shownList(d)).rows) ===
      JSON.stringify([FIRST, QUALITY_HD, AFTER_HOURS]),
  );
  d.observed["afterRestart"] = await shownList(d);
  await d.capture("sources-after-restart");
}
