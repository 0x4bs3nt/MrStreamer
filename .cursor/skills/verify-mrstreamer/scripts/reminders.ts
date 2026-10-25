// Programme reminders through the built window, on the real clock, with a fake guide of
// three-minute programmes so one comes due within the run. Remind me is pressed from the guide
// grid's details with the keyboard, from a list's schedule line and from a programme in Search;
// the bell in Live TV's header lists them; a second press and the list's cross cancel. A write
// that fails, as reminders.json turned into a folder makes it, says so and changes nothing, and
// the same press works once it can. After a restart the bell still lists them. At its start the
// window's notice shows, and its Watch plays the channel on one provider connection. The rest of
// a day and Search use a channel without catch-up, whose day starts at now.
import { mkdir, readFile, rename, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type { Driver } from "./language.ts";

const GRID = "document.querySelector('[role=grid]')";
const DETAILS = "document.querySelector('[role=grid] [role=region]')";
const SELECTED = "document.querySelector('[role=grid] [role=gridcell][aria-selected=true]')";
const BELL = "document.querySelector('button[aria-label^=\"Reminders\"]')";
const POPUP = "document.querySelector('[role=dialog][aria-label=Reminders]')";
const BANNER =
  "[...document.querySelectorAll('section[aria-label]')].find(s => /^(Starts now|Started )/.test(s.innerText))";
const named = (selector: string, text: string, within = "document") =>
  `[...${within}.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;
const expect = (value: boolean, message: string, seen?: unknown) => {
  if (!value) throw new Error(`${message}${seen === undefined ? "" : `: ${JSON.stringify(seen)}`}`);
};

/** The reminders as the main process lists them, read without changing anything. */
const listed = (d: Driver) =>
  d.evaluate<{
    reminders: {
      id: string;
      title: string;
      start: number;
      status: { kind: string };
      banner: boolean;
    }[];
    notifications: string | null;
  }>(`(async () => {
    const read = await window.mrStreamer.invoke('reminders.list');
    if (!read.ok) throw new Error(read.error.kind);
    return read.value;
  })()`);

const picture = (d: Driver) =>
  d.evaluate<{ time: number; width: number; audio: number; watching: boolean }>(
    `(() => { const v = document.querySelector('video');
      return { time: v?.currentTime ?? 0, width: v?.videoWidth ?? 0,
        audio: v?.webkitAudioDecodedByteCount ?? 0,
        watching: !!document.querySelector('[data-view=watch]') }; })()`,
  );

/** What the fake panel was asked for. */
interface ReminderFixture {
  streams(): { requests: number; active: number };
}

export async function remindersScenario(d: Driver, fixture: ReminderFixture) {
  const file = join(d.profile, "reminders.json");
  await d.click("Open Live TV", named("header button", "Live TV"));
  await d.key("g", 71);
  await d.wait(() => d.exists(GRID));
  await d.wait(() => d.exists(`${GRID}.querySelector('[role=gridcell][data-left]')`));
  const firstRow = await d.evaluate<string>(`${GRID}.querySelector('[role=rowheader]').title`);
  expect(
    firstRow.includes("H.264 + AAC"),
    "The grid doesn't start on the playable channel",
    firstRow,
  );

  // The keys move along the first row to a programme a few minutes ahead.
  const selectedStart = () =>
    d.evaluate<number | null>(
      `(() => { const id = ${SELECTED}?.id; return id ? Number(id.split('-').pop()) : null; })()`,
    );
  for (let i = 0; i < 6; i++) {
    await d.key("ArrowRight", 39);
    await d.wait(() => d.exists(DETAILS));
    const start = await selectedStart();
    if (start !== null && start - Date.now() >= 150_000) break;
  }
  const gridStart = await selectedStart();
  expect(gridStart !== null && gridStart - Date.now() >= 150_000, "No programme ahead", gridStart);
  const remind = named("button", "Remind me", DETAILS);
  await d.wait(() => d.exists(remind));
  // Tab reaches Remind me from the grid, and Enter presses it.
  const tabs: string[] = [];
  for (let i = 0; i < 8; i++) {
    await d.key("Tab", 9);
    const focused = await d.evaluate<string>("document.activeElement?.textContent.trim() ?? ''");
    tabs.push(focused);
    if (focused === "Remind me") break;
  }
  d.observed["tabsToRemindMe"] = tabs;
  expect(tabs.at(-1) === "Remind me", "Tab didn't reach Remind me", tabs);
  await d.key("Enter", 13);
  const set = named("button", "Reminder set", DETAILS);
  await d.wait(() => d.evaluate<boolean>(`${set}?.getAttribute('aria-pressed') === 'true'`));
  const cell = await d.evaluate<string>(`${SELECTED}.getAttribute('aria-label')`);
  expect(cell.includes("Reminder set"), "The cell doesn't say it has a reminder", cell);
  const afterGrid = await listed(d);
  expect(
    afterGrid.reminders.length === 1 && afterGrid.reminders[0]!.start === gridStart,
    "The grid's reminder isn't stored for its programme",
    afterGrid,
  );
  const gridReminder = afterGrid.reminders[0]!;
  d.observed["gridReminder"] = {
    cell,
    reminder: gridReminder,
    startsInMs: gridStart! - Date.now(),
  };
  await d.capture("grid-reminder-set");

  // The header's bell counts it, and lists it.
  await d.wait(() =>
    d.evaluate<boolean>(`${BELL}?.getAttribute('aria-label') === 'Reminders, 1 to come'`),
  );
  await d.click("Open the reminders from the bell", BELL);
  await d.wait(() => d.exists(POPUP));
  d.observed["bellList"] = await d.evaluate<string>(`${POPUP}.innerText`);
  await d.capture("bell-list");
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists(POPUP)));
  expect(
    await d.evaluate<boolean>(`document.activeElement === ${BELL}`),
    "Escape didn't hand the keys back to the bell",
  );

  // A list's schedule: a later programme opens to Remind me, which sets and then cancels. A
  // channel without catch-up, whose day starts at now rather than with every aired programme.
  await d.key("g", 71);
  await d.wait(async () => !(await d.exists(GRID)));
  const row = `[...document.querySelectorAll('[data-index]')].find(r => r.textContent.includes('H.264 + MP2'))`;
  await d.wait(() => d.exists(row));
  await d.click(
    "Open the rest of the day",
    `${row}.querySelector('button[aria-label="Later programmes"]')`,
  );
  const later = `[...${row}.querySelectorAll('button[aria-expanded]')]`;
  await d.wait(() => d.evaluate<boolean>(`${later}.length >= 6`));
  await d.click("Open a later programme", `${later}[3]`);
  const block = `${later}[3].parentElement`;
  await d.click("Remind me on the schedule line", named("button", "Remind me", block));
  await d.wait(() => d.exists(named("button", "Reminder set", block)));
  expect(
    await d.exists(`${later}[3].querySelector('[role=img][aria-label="Reminder set"]')`),
    "The schedule line shows no bell",
  );
  d.observed["scheduleSet"] = (await listed(d)).reminders.length;
  await d.capture("schedule-reminder-set");
  await d.click("Cancel it with a second press", named("button", "Reminder set", block));
  await d.wait(() => d.exists(named("button", "Remind me", block)));
  d.observed["scheduleCancelled"] = (await listed(d)).reminders.length;
  expect(d.observed["scheduleCancelled"] === 1, "The second press didn't cancel", d.observed);

  // A failed save: reminders.json is a folder, so nothing can be written over it.
  await rename(file, `${file}.kept`);
  await mkdir(file);
  await d.click("Open another later programme", `${later}[4]`);
  const other = `${later}[4].parentElement`;
  await d.click("Remind me while it can't be saved", named("button", "Remind me", other));
  await d.wait(() =>
    d.evaluate<boolean>(
      `${other}.querySelector('[role=alert]')?.textContent === "Couldn't save. Try again."`,
    ),
  );
  expect(
    await d.evaluate<boolean>(
      `${named("button", "Remind me", other)}?.getAttribute('aria-pressed') === 'false'`,
    ),
    "A failed save shows as set",
  );
  d.observed["failedSave"] = (await listed(d)).reminders.length;
  await d.capture("save-failed");
  await rmdir(file);
  await d.click("Press again once it can be saved", named("button", "Remind me", other));
  await d.wait(() => d.exists(named("button", "Reminder set", other)));
  d.observed["retried"] = (await listed(d)).reminders.length;
  expect(d.observed["retried"] === 2, "The retry didn't set it", d.observed);
  await d.click("Cancel the retried one", named("button", "Reminder set", other));
  await d.wait(() => d.exists(named("button", "Remind me", other)));

  // Search: a programme still to come opens to Remind me.
  const title = await d.evaluate<string>(
    `${later}[5].querySelector('span.block').textContent.trim()`,
  );
  await d.click("Open global Search", "document.querySelector('button[aria-label=Search]')");
  d.action(`Search ${title}`);
  await d.send("Input.insertText", { text: title });
  const result = `[...document.querySelectorAll('[aria-label="Search results"] [role=treeitem][aria-expanded]')].filter(r => r.textContent.includes('H.264 + MP2')).at(-1)`;
  await d.wait(() => d.exists(result));
  await d.click("Open a programme to come in Search", `${result}.querySelector('button')`);
  await d.click("Remind me in Search", named("button", "Remind me", result));
  await d.wait(() => d.exists(named("button", "Reminder set", result)));
  expect(
    await d.exists(`${result}.querySelector('[role=img][aria-label="Reminder set"]')`),
    "The Search result shows no bell",
  );
  await d.capture("search-reminder-set");
  await d.key("Escape", 27);
  const afterSearch = await listed(d);
  expect(afterSearch.reminders.length === 2, "Search didn't set it", afterSearch);
  const stored = JSON.parse(await readFile(file, "utf8")) as { version: number };
  d.observed["storedVersion"] = stored.version;

  // A restart keeps them.
  await d.quit();
  await d.launch();
  await d.click("Open Live TV", named("header button", "Live TV"));
  await d.wait(() => d.exists(BELL));
  const bell = await d.evaluate<string>(`${BELL}.getAttribute('aria-label')`);
  d.observed["bellAfterRestart"] = bell;
  await d.click("Open the reminders after the restart", BELL);
  await d.wait(() => d.exists(POPUP));
  d.observed["listAfterRestart"] = await d.evaluate<string>(`${POPUP}.innerText`);
  await d.capture("bell-after-restart");
  await d.key("Escape", 27);

  // At its start, the window's notice shows, on any page, whatever the system shows.
  const waitMs = Math.max(0, gridStart! - Date.now()) + 90_000;
  d.action(`Wait for the grid reminder's start, about ${Math.round(waitMs / 1000)} s`);
  await d.wait(() => d.exists(BANNER), waitMs);
  d.observed["banner"] = await d.evaluate<string>(`${BANNER}.innerText`);
  const due = await listed(d);
  d.observed["notifications"] = due.notifications;
  d.observed["dueStatus"] = due.reminders.find((each) => each.id === gridReminder.id);
  await d.capture("banner");

  // Watch on the notice plays the channel, on one provider connection. The notice sits under the
  // top bar at the right, as drawn, over Live TV's bell until it goes.
  const before = fixture.streams();
  await d.click("Watch from the reminder's notice", named("button", "Watch", BANNER));
  await d.wait(async () => {
    const v = await picture(d);
    return v.watching && v.time >= 1 && v.width > 0 && v.audio > 0;
  });
  const after = fixture.streams();
  d.observed["watch"] = { before, after, picture: await picture(d) };
  expect(after.active === 1, "Watch holds more than one provider connection", after);
  expect(!(await d.exists(BANNER)), "The notice stayed after Watch");
  await d.capture("watch-from-banner");
  await d.key("Escape", 27);

  // The one that told is on now; the list's cross, from the keyboard, hands the keys on.
  await d.click("Open Live TV", named("header button", "Live TV"));
  await d.click("Open the reminders while one is on", BELL);
  await d.wait(() => d.exists(POPUP));
  d.observed["listWhileOn"] = await d.evaluate<string>(`${POPUP}.innerText`);
  await d.capture("bell-while-on");
  const crosses = `[...${POPUP}.querySelectorAll('button[data-remove]')]`;
  await d.wait(() => d.evaluate<boolean>(`${crosses}.length === 2`));
  for (let i = 0; i < 4; i++) {
    if (await d.evaluate<boolean>(`document.activeElement === ${crosses}[0]`)) break;
    await d.key("Tab", 9);
  }
  expect(
    await d.evaluate<boolean>(`document.activeElement === ${crosses}[0]`),
    "Tab didn't reach the first cross",
  );
  await d.key("Enter", 13);
  await d.wait(() => d.evaluate<boolean>(`${crosses}.length === 1`));
  d.observed["focusAfterRemove"] = await d.evaluate<string | null>(
    "document.activeElement?.getAttribute('aria-label') ?? null",
  );
  expect(
    await d.evaluate<boolean>(`document.activeElement === ${crosses}[0]`),
    "The keys didn't go on to the next cross",
    d.observed["focusAfterRemove"],
  );
  await d.capture("bell-after-keyboard-remove");
  await d.key("Escape", 27);
  d.observed["finalList"] = await listed(d);
}
