// Checks the watchlist in a built app, against two fake providers and the fake TMDB: what the
// suite can't, because happy-dom lays nothing out, moves no real focus and plays nothing. The
// first provider's subscription is saved alone at first. In order:
//
// - The top bar permanently opens Watchlist, whose page says how to save while empty.
// - A real click on Save in a movie's details saves it once the record has it, and the button
//   reads Saved.
// - In a series' details, Tab reaches Save from Play; Space saves, Enter takes it off again and
//   Space saves once more, the focus staying on the button each time.
// - A film in two versions is one entry, whichever version names it.
// - The Watchlist page counts and shows the saved titles newest first, and by name on A to Z; the
//   arrow keys and Enter open the title they are on; Home's Watchlist row leads there with All.
// - A saved movie plays from the page through its details, on one connection to the provider,
//   which it lets go of; opened again it offers Resume, and it is still saved.
// - The arrow keys reach a tile and Tab its cross, Enter takes the title off, and the focus stays
//   on a cross.
// - While another writer holds the database, Save says it couldn't and keeps Save; pressed again
//   once the writer lets go, it saves.
// - Save pressed twice in one task, before the window drew the first press, makes one change,
//   and so does Saved; the focus stays on the button.
// - A title the provider drops stays as Unavailable, with a sheet that only removes; listed
//   again, it opens its details with Play; dropped once more, Enter on the sheet's Remove takes
//   it off.
// - A saved title for adults shows and counts only while Settings shows titles for adults.
// - The sheet of one the provider dropped, left open under Settings, is gone once Settings hides
//   them: its name is drawn nowhere after, and it is still saved.
// - Everything saved is there after a restart, in the same order.
// - With a second provider added in Settings, a film both list is one poster in Movies. A click
//   on Save saves it for both at once, asking nothing, as one change and one tile; Play's menu
//   picks the second's version, which plays from the second's provider alone, on one connection,
//   with how far it got kept for that version alone; the tile's cross takes it off for both.
// - Removing the second subscription leaves what the first saved, with the film both saved,
//   and takes the second's own entry out; added again, its account has that entry back. Removed
//   with its box ticked, nothing of its account stays in the database, and the rest stays.
// - Removing the last subscription keeps its watchlist for when the account connects again, and
//   deletes it when the box is ticked.
//
//   node test/e2e/watchlist-app.ts <app executable> [-- extra app arguments]
//
// The app runs with a throwaway profile and remote debugging on a random port; on macOS pass
// --use-mock-keychain so the test never touches a real keychain. It needs ffmpeg and ffprobe, as
// playing a movie does.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OnDemandStatus, Title } from "@mrstreamer/contracts/ondemand";
import type { OwnedId, SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import type { TitleProgress } from "@mrstreamer/contracts/viewing";
import type { WatchlistPage } from "@mrstreamer/contracts/watchlist";
import { startFakeProvider } from "../fake-provider.ts";
import { startFakeTmdb } from "../fake-tmdb.ts";
import {
  addSubscription,
  connect,
  delay,
  key,
  launch,
  login,
  MODIFIERS,
  openSubscriptions,
  subscriptionRow,
  waitFor,
  type Page,
} from "./app.ts";

const [given, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!given) {
  throw new Error("Usage: node test/e2e/watchlist-app.ts <app executable> [-- args]");
}
const executable: string = given;

// The fake provider's titles, by a part of the name it lists them under and by their ids.
const LONG_MOVIE = { name: "Long subtitles", id: "90007" };
const TWO_VERSIONS = { name: "Two sound tracks and subtitles (MULTI)", ids: ["90000", "90006"] };
const DROPPED = { name: "Index at the end", id: "90001" };
const PRESSED_TWICE = { name: "Caption track" };
const SERIES = { name: "TEST | Formats", id: "80000" };
const ADULT_SERIES = { name: "After Dark", id: "79999" };
/** A film both providers list, under an id of its own at each. */
const SHARED = { id: "91001", there: "91000" };
/** A film only the second lists, under the id the first has the shared film at. */
const THEIRS = { id: "91001" };
/** What the second subscription is called in Settings. */
const SECOND = "Holiday house";

const profile = mkdtempSync(join(tmpdir(), "mr-streamer-e2e-"));
const provider = await startFakeProvider({ channels: 60 });
// Another provider beside it, which numbers its titles as the first does.
const second = await startFakeProvider({ channels: 60, second: true });
const tmdb = await startFakeTmdb();
process.env["MR_STREAMER_TMDB_API"] = tmdb.url;
process.env["MR_STREAMER_TMDB_KEY"] = "test-key";
const randomPort = () => 20000 + Math.floor(Math.random() * 20000);
let port = randomPort();
let app = launch(executable, rest, { port, profile });

let failed = false;
/** Prints how a check went. */
function report(name: string, problems: readonly string[]): void {
  console.log(
    `${problems.length === 0 ? "PASS" : "FAIL"} ${name}${problems.map((each) => `\n     ${each}`).join("")}`,
  );
  failed ||= problems.length > 0;
}

const invoke = async <T>(page: Page, method: string, input?: unknown): Promise<T> => {
  const result = await page.evaluate<{ ok: boolean; value: T; error?: unknown }>(
    `window.mrStreamer.invoke(${JSON.stringify(method)}, ${JSON.stringify(input)})`,
  );
  if (!result.ok) throw new Error(`${method}: ${JSON.stringify(result.error)}`);
  return result.value;
};

/** The watchlist as the record has it, newest first. */
const saved = (page: Page) =>
  invoke<WatchlistPage>(page, "watchlist.list", { sort: "saved", offset: 0, limit: 100 });

/** The saved subscriptions, in their order. */
const subscriptions = (page: Page) => invoke<SubscriptionSummary[]>(page, "subscription.list");

/** Whether every saved subscription's movie and series lists are loaded. */
async function listsLoaded(page: Page): Promise<boolean> {
  const { lists } = await invoke<OnDemandStatus>(page, "ondemand.status");
  return lists.length > 0 && lists.every((each) => each.fetchedAt !== null);
}

/** How many accounts the database holds a watchlist for, read as another program would. */
function accountsSaved(): number {
  const db = new DatabaseSync(join(profile, "mrstreamer.db"), { readOnly: true });
  try {
    return Number(db.prepare("select count(distinct account) as n from watchlist").get()?.["n"]);
  } finally {
    db.close();
  }
}

// Expressions the page evaluates to an element, or nothing.
const withText = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find((each) => each.textContent.trim() === ${JSON.stringify(text)})`;
const pageButton = (label: string) => withText("header button", label);
const sheetButton = (label: string) => withText('[role="dialog"] button', label);
/** A poster, by a part of the name the provider lists its title under. */
const poster = (name: string) =>
  `[...document.querySelectorAll("button[title]")].find((each) => each.title.includes(${JSON.stringify(name)}))`;

/** The sheet over the page: a title's details, or what was kept of a saved one. */
const SHEET = `document.querySelector('[role="dialog"]')`;

const exists = (page: Page, element: string) => page.evaluate<boolean>(`!!${element}`);
const says = (page: Page, words: string, selector = "body") =>
  page.evaluate<boolean>(
    `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? "").includes(${JSON.stringify(words)})`,
  );
/** What has the keyboard: its words, or its label. */
const focused = (page: Page) =>
  page.evaluate<string>(
    `document.activeElement?.textContent?.trim() || document.activeElement?.getAttribute("aria-label") || ""`,
  );

/** Clicks an element with the real pointer, once it is there. */
async function click(page: Page, element: string): Promise<void> {
  await waitFor(() => exists(page, element), 30_000).catch(() => {
    throw new Error(`Nothing to click: ${element}`);
  });
  await page.evaluate(`${element}.scrollIntoView({ block: "nearest" })`);
  await delay(150);
  const point = await page.evaluate<{ x: number; y: number }>(`(() => {
    const box = ${element}.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
  }
  await delay(150);
}

/** A real press of Space, which a button takes as a click when the key comes up. */
async function space(page: Page): Promise<void> {
  const pressed = { key: " ", code: "Space", windowsVirtualKeyCode: 32 };
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", text: " ", ...pressed });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...pressed });
}

/** A real press of Enter, which a button takes as a click as the key goes down. */
async function enter(page: Page): Promise<void> {
  const pressed = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...pressed });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...pressed });
}

/** Presses Tab until the keyboard is on something `wanted` accepts, a few times at most. */
async function tabTo(page: Page, wanted: (focus: string) => boolean): Promise<boolean> {
  for (let presses = 0; presses < 24; presses++) {
    if (wanted(await focused(page))) return true;
    await key(page, "Tab", 9);
    await delay(100);
  }
  return wanted(await focused(page));
}

/** Opens the details of a title from the All tab of Movies or Series. */
async function openFromLists(page: Page, kind: "Movies" | "Series", name: string): Promise<void> {
  await click(page, pageButton(kind));
  await click(page, withText("nav button", kind === "Movies" ? "All movies" : "All series"));
  await click(page, poster(name));
  await waitFor(() => exists(page, SHEET), 20_000);
}

const closeSheet = async (page: Page) => {
  await key(page, "Escape", 27);
  await waitFor(async () => !(await exists(page, SHEET)), 10_000);
};

/**
 * Opens a movie's details from Movies, found with the page's own search, and clears the search
 * behind it. Says how many posters showed the film.
 */
async function openFound(page: Page, title: Title): Promise<number> {
  await click(page, pageButton("Movies"));
  const field = `document.querySelector('[aria-label="Search movies"]')`;
  await waitFor(() => exists(page, field), 60_000);
  await page.evaluate(`${field}.focus()`);
  await page.send("Input.insertText", { text: title.title });
  const found = `[...document.querySelectorAll("button[title]")].filter((each) => each.title === ${JSON.stringify(title.name)})`;
  await waitFor(() => page.evaluate<boolean>(`${found}.length > 0`), 60_000);
  await delay(500);
  const posters = await page.evaluate<number>(`${found}.length`);
  await click(page, `${found}[0]`);
  await waitFor(() => exists(page, `${SHEET}?.querySelector('[aria-label="Versions"]')`), 30_000);
  return posters;
}

/** Picks the version saying `words` in the menu beside Play, and waits for its details. */
async function pickVersion(page: Page, words: string): Promise<void> {
  await click(page, `${SHEET}.querySelector('[aria-label="Versions"]')`);
  const items = `[...document.querySelectorAll('[role="menuitemradio"]')]`;
  await waitFor(() => page.evaluate<boolean>(`${items}.length > 1`), 10_000);
  await click(page, `${items}.find((item) => item.innerText.includes(${JSON.stringify(words)}))`);
  await waitFor(() => page.evaluate<boolean>(`${items}.length === 0`), 10_000).catch(() => {});
  await delay(800);
}

/**
 * Removes the subscription listed as `name` in Settings > Subscriptions, with the box to delete
 * what its account kept ticked or not, and waits until it is gone.
 */
async function removeSubscription(page: Page, name: string, erase: boolean): Promise<void> {
  const before = (await subscriptions(page)).length;
  await openSubscriptions(page);
  // One subscription alone shows its details already; a row of several opens them.
  if (before > 1) await click(page, `(${subscriptionRow(name)})?.querySelector("button")`);
  await click(page, withText("button", `Remove ${name}`));
  await waitFor(() => says(page, "from this device?"), 10_000);
  if (erase) {
    await click(
      page,
      `${withText("label", "Also delete favourites, watchlist, history, progress and channels in lists")}?.querySelector('[role="checkbox"]')`,
    );
  }
  await click(page, withText("button", "Remove"));
  await waitFor(async () => (await subscriptions(page)).length === before - 1, 20_000);
}

/** The Save button of the open details, by what it reads once it can be pressed. */
async function saveButton(page: Page): Promise<"Save" | "Saved"> {
  const state = () =>
    page.evaluate<string | null>(`(() => {
      const button = [...document.querySelectorAll('[role="dialog"] button[aria-pressed]')]
        .find((each) => !each.disabled && ["Save", "Saved"].includes(each.textContent.trim()));
      return button ? button.textContent.trim() : null;
    })()`);
  await waitFor(async () => (await state()) !== null, 20_000);
  return (await state()) === "Saved" ? "Saved" : "Save";
}

/** What the Watchlist page's tiles say, in order: each name, and the line under it. */
const tiles = (page: Page) =>
  page.evaluate<[name: string, line: string][]>(
    `[...document.querySelectorAll("[data-remove]")].map((cross) =>
       [...cross.parentElement.querySelectorAll("span.truncate")].map((each) => each.textContent))`,
  );

async function openWatchlist(page: Page): Promise<void> {
  await click(page, pageButton("Home"));
  await click(page, pageButton("Watchlist"));
  await waitFor(() => exists(page, withText("h1", "Watchlist")), 10_000);
  await delay(400);
}

/** Starts the app again on the same profile, as after quitting it. */
async function restart(page: Page): Promise<Page> {
  page.close();
  app.kill("SIGKILL");
  await delay(1500);
  port = randomPort();
  app = launch(executable, rest, { port, profile });
  return ready(await connect(port));
}

/** A window that takes the keyboard, and asks no one outside this machine for pictures. */
async function ready(page: Page): Promise<Page> {
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Network.enable");
  await page.send("Network.setBlockedURLs", { urls: ["*image.tmdb.org*", "*image.example*"] });
  return page;
}

try {
  let page = await ready(await connect(port));
  await login(page, provider);
  /** The first provider's subscription, which is another once its account is added again. */
  let [one] = await subscriptions(page);
  if (!one) throw new Error("The login saved no subscription.");
  /** What it is listed as: its server's host, as it has no name. */
  const FIRST = new URL(provider.url).host;
  /** A provider's id as a subscription lists it: the first's, unless `of` names another. */
  const own = (id: string, of = one): OwnedId => ({ subscriptionId: of?.id ?? "", id });
  // The movie and series lists load after the channels.
  await waitFor(() => listsLoaded(page), 60_000);

  {
    const problems: string[] = [];
    const pages = await page.evaluate<string[]>(
      `[...document.querySelectorAll("header button")].map((each) => each.textContent.trim()).filter(Boolean)`,
    );
    if (pages.join() !== "Home,Live TV,Movies,Series,Watchlist,Downloads") {
      problems.push(`the top bar has ${pages.join(", ")}`);
    }
    if (await exists(page, withText("h2", "Watchlist"))) problems.push("Home has a Watchlist row");
    await openWatchlist(page);
    if (!(await says(page, "Nothing saved yet. Save a movie or series from its details."))) {
      problems.push("the empty page doesn't say how to save");
    }
    report("The top bar opens the full Watchlist and its empty saving instructions", problems);
  }

  {
    const problems: string[] = [];
    const details = provider.detailRequests();
    await openFromLists(page, "Movies", LONG_MOVIE.name);
    if ((await saveButton(page)) !== "Save") problems.push("a title not saved reads Saved");
    await click(page, sheetButton("Save"));
    await waitFor(() => exists(page, sheetButton("Saved")), 10_000).catch(() =>
      problems.push("the button doesn't read Saved"),
    );
    const pressed = await page.evaluate<string | null>(
      `${sheetButton("Saved")}?.getAttribute("aria-pressed") ?? null`,
    );
    if (pressed !== "true") problems.push(`Saved has aria-pressed ${pressed}`);
    const { entries } = await saved(page);
    if (entries.length !== 1 || entries[0]?.title?.id !== LONG_MOVIE.id) {
      problems.push(
        `the record holds ${entries.map((entry) => entry.title?.id).join() || "nothing"}`,
      );
    }
    // Opening the details asked the provider once; saving asked it nothing.
    if (provider.detailRequests() - details > 1) {
      problems.push(`${provider.detailRequests() - details} detail requests`);
    }
    await closeSheet(page);
    report("A click on Save in a movie's details saves it, and the button reads Saved", problems);
  }

  {
    const problems: string[] = [];
    await openFromLists(page, "Series", SERIES.name);
    await saveButton(page);
    await waitFor(async () => (await focused(page)).startsWith("Play"), 20_000).catch(async () =>
      problems.push(`the details open with the focus on "${await focused(page)}"`),
    );
    if (!(await tabTo(page, (focus) => focus === "Save"))) {
      problems.push(`Tab never reached Save, it stands on ${await focused(page)}`);
    }
    const total = async () => (await saved(page)).entries.length;
    await space(page);
    await waitFor(async () => (await total()) === 2, 10_000).catch(() =>
      problems.push("Space didn't save"),
    );
    await delay(300);
    if ((await focused(page)) !== "Saved") {
      problems.push(`after Space the focus is on ${await focused(page)}`);
    }
    await enter(page);
    await waitFor(async () => (await total()) === 1, 10_000).catch(() =>
      problems.push("Enter didn't remove"),
    );
    await delay(300);
    if ((await focused(page)) !== "Save") {
      problems.push(`after Enter the focus is on ${await focused(page)}`);
    }
    await space(page);
    await waitFor(async () => (await total()) === 2, 10_000).catch(() =>
      problems.push("Space didn't save again"),
    );
    const series = (await saved(page)).entries[0];
    if (series?.kind !== "series" || series.title?.versions.length !== 2) {
      problems.push(`the entry is ${JSON.stringify(series?.title?.versions ?? series?.kind)}`);
    }
    await closeSheet(page);
    report(
      "Tab reaches Save in a series' details; Space and Enter work it and it keeps the focus",
      problems,
    );
  }

  {
    const problems: string[] = [];
    await openFromLists(page, "Movies", TWO_VERSIONS.name);
    await saveButton(page);
    await click(page, sheetButton("Save"));
    await waitFor(() => exists(page, sheetButton("Saved")), 10_000);
    const entries = await Promise.all(
      TWO_VERSIONS.ids.map((id) =>
        invoke<OwnedId | null>(page, "watchlist.saved", { kind: "movie", version: own(id) }),
      ),
    );
    if (!entries[0] || entries[0].id !== entries[1]?.id) {
      problems.push(`its versions are saved as ${JSON.stringify(entries)}`);
    }
    if ((await saved(page)).total !== 3) problems.push("it isn't one more entry");
    await closeSheet(page);
    report("A film in two versions is one entry, whichever version names it", problems);
  }

  // The names the tiles show are TMDB's once it answered, so the checks go by the record.
  const names = async () =>
    (await saved(page)).entries.map((entry) => entry.title?.title ?? entry.name);

  {
    const problems: string[] = [];
    await openWatchlist(page);
    const newest = await names();
    await waitFor(async () => (await tiles(page)).length === 3, 10_000).catch(() => {});
    const shown = await tiles(page);
    if (shown.map(([name]) => name).join("|") !== newest.join("|")) {
      problems.push(
        `the page shows ${shown.map(([name]) => name).join(", ")}, not ${newest.join(", ")}`,
      );
    }
    if (shown.map(([, line]) => line.split(" · ")[0]).join() !== "Movie,Series,Movie") {
      problems.push(`the tiles say ${shown.map(([, line]) => line).join(" | ")}`);
    }
    const heading = await page.evaluate<string>(
      `document.querySelector("h1").parentElement.innerText.replace(/\\s+/g, " ")`,
    );
    if (heading !== "Watchlist 3") problems.push(`the heading reads ${heading}`);

    await click(page, withText("button[aria-pressed]", "A to Z"));
    const sorted = newest.toSorted((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
    await waitFor(
      async () => (await tiles(page)).map(([name]) => name).join("|") === sorted.join("|"),
      10_000,
    ).catch(async () =>
      problems.push(`A to Z shows ${(await tiles(page)).map(([name]) => name).join(", ")}`),
    );
    // The arrow keys move through the posters and Enter opens the one they are on.
    await key(page, "ArrowRight", 39);
    await enter(page);
    await waitFor(() => exists(page, SHEET), 10_000).catch(() =>
      problems.push("Enter opened nothing"),
    );
    if (!(await says(page, sorted[1] ?? "", '[role="dialog"]'))) {
      problems.push(`Enter didn't open ${sorted[1]}`);
    }
    await closeSheet(page);
    await click(page, withText("button[aria-pressed]", "Saved"));

    await click(page, pageButton("Home"));
    await waitFor(() => exists(page, withText("h2", "Watchlist")), 10_000).catch(() =>
      problems.push("Home has no Watchlist row"),
    );
    const all = `${withText("h2", "Watchlist")}?.parentElement.querySelector("button")`;
    const label = await page.evaluate<string>(`${all}?.innerText.replace(/\\s+/g, " ") ?? ""`);
    if (label.trim() !== "All 3") problems.push(`the row's link reads "${label}"`);
    await click(page, all);
    await waitFor(() => exists(page, withText("h1", "Watchlist")), 10_000).catch(() =>
      problems.push("All didn't open the Watchlist"),
    );
    report(
      "The Watchlist page orders, counts and opens what is saved, and Home's row leads to it",
      problems,
    );
  }

  {
    const problems: string[] = [];
    const clock = () =>
      page.evaluate<{ time: number; width: number }>(`(() => {
        const video = document.querySelector("video");
        return { time: video?.currentTime ?? 0, width: video?.videoWidth ?? 0 };
      })()`);
    await openWatchlist(page);
    await click(page, poster(LONG_MOVIE.name));
    await click(page, sheetButton("Play"));
    await waitFor(async () => (await clock()).time >= 4 && (await clock()).width > 0, 40_000).catch(
      async () => problems.push(`the movie didn't play: ${JSON.stringify(await clock())}`),
    );
    if (provider.mostFilesAtOnce() !== 1) {
      problems.push(`${provider.mostFilesAtOnce()} connections for its file at once`);
    }
    await key(page, "Escape", 27);
    await delay(2000);
    if (provider.activeStreams() !== 0) {
      problems.push(`${provider.activeStreams()} connections held after leaving`);
    }
    // Back in its details, it carries on from where it stopped, and is saved as before.
    await waitFor(() => exists(page, sheetButton("Resume")), 20_000).catch(() =>
      problems.push("its details don't offer Resume"),
    );
    if ((await saveButton(page)) !== "Saved") problems.push("playing it took it off the watchlist");
    await click(page, sheetButton("Resume"));
    await waitFor(async () => (await clock()).time >= 1, 40_000).catch(async () =>
      problems.push(`Resume didn't play: ${JSON.stringify(await clock())}`),
    );
    await key(page, "Escape", 27);
    await delay(2000);
    await closeSheet(page);
    if (provider.mostFilesAtOnce() !== 1 || provider.activeStreams() !== 0) {
      problems.push(
        `${provider.mostFilesAtOnce()} connections at once, ${provider.activeStreams()} held`,
      );
    }
    if ((await saved(page)).total !== 3) problems.push("the watchlist changed");
    report("A saved movie plays and resumes on one connection, and stays saved", problems);
  }

  {
    const problems: string[] = [];
    await openWatchlist(page);
    const before = await saved(page);
    const second = before.entries[1];
    const label = `Remove ${second?.title?.title ?? second?.name} from Watchlist`;
    // The grid is one stop in the Tab order: the arrow keys reach the tile, Tab its cross.
    await key(page, "ArrowRight", 39);
    if (!(await tabTo(page, (focus) => focus === label))) {
      problems.push(`Tab never reached "${label}", it stands on ${await focused(page)}`);
    }
    await enter(page);
    await waitFor(async () => (await saved(page)).total === 2, 10_000).catch(() =>
      problems.push("Enter on the cross removed nothing"),
    );
    await delay(500);
    const after = await saved(page);
    if (after.entries.some((entry) => entry.id === second?.id)) problems.push("it is still saved");
    const left = (await tiles(page)).map(([name]) => name);
    if (left.length !== 2) problems.push(`the page shows ${left.join(", ")}`);
    if (!/^Remove .+ from Watchlist$/.test(await focused(page))) {
      problems.push(`the focus went to "${await focused(page)}"`);
    }
    // Saved again for the checks that follow.
    await invoke(page, "watchlist.save", { kind: "series", version: own(SERIES.id) });
    report(
      "The arrow keys reach a tile and Tab its cross, Enter takes the title off, and a cross keeps the focus",
      problems,
    );
  }

  {
    const problems: string[] = [];
    await openFromLists(page, "Movies", DROPPED.name);
    await saveButton(page);
    // Another writer holds the database, as a second copy of the app can for a moment.
    const other = new DatabaseSync(join(profile, "mrstreamer.db"));
    other.exec("begin immediate");
    await click(page, sheetButton("Save"));
    await waitFor(() => says(page, "Couldn't save. Try again.", '[role="dialog"]'), 10_000).catch(
      () => problems.push("no failure showed"),
    );
    if (!(await exists(page, sheetButton("Save"))))
      problems.push("the button no longer reads Save");
    other.exec("rollback");
    if ((await saved(page)).total !== 3) problems.push("the record changed though saving failed");
    other.close();
    await click(page, sheetButton("Save"));
    await waitFor(() => exists(page, sheetButton("Saved")), 10_000).catch(() =>
      problems.push("the second press didn't save"),
    );
    if (await says(page, "Couldn't save", '[role="dialog"]'))
      problems.push("the failure still shows");
    if ((await saved(page)).total !== 4)
      problems.push("the record doesn't hold it after the retry");
    await closeSheet(page);
    report(
      "A save the database refuses says so and keeps Save, and the next press saves",
      problems,
    );
  }

  {
    const problems: string[] = [];
    await openFromLists(page, "Movies", PRESSED_TWICE.name);
    await saveButton(page);
    if (!(await tabTo(page, (focus) => focus === "Save"))) {
      problems.push(`Tab never reached Save, it stands on ${await focused(page)}`);
    }
    const { total } = await saved(page);
    // The main process says `watchlist.changed` after each change it made.
    await page.evaluate(`(() => {
      window.watchlistChanges = 0;
      window.stopCounting = window.mrStreamer.on("watchlist.changed", () => {
        window.watchlistChanges += 1;
      });
    })()`);
    const changes = () => page.evaluate<number>("window.watchlistChanges");
    // Two presses in one task, so the second lands before the window has heard of the first:
    // that is when a second change could start. Real keys and clicks sent from here land later.
    const pressTwice = (label: string) =>
      page.evaluate(`(() => {
        const button = ${sheetButton(label)};
        button.click();
        button.click();
      })()`);
    await pressTwice("Save");
    await waitFor(() => exists(page, sheetButton("Saved")), 10_000).catch(() =>
      problems.push("the button doesn't read Saved"),
    );
    await delay(500);
    if ((await changes()) !== 1)
      problems.push(`Save pressed twice made ${await changes()} changes`);
    if ((await saved(page)).total !== total + 1) problems.push("the record doesn't hold it");
    if ((await focused(page)) !== "Saved") {
      problems.push(`after Save the focus is on ${await focused(page)}`);
    }
    await pressTwice("Saved");
    await waitFor(() => exists(page, sheetButton("Save")), 10_000).catch(() =>
      problems.push("the button doesn't read Save again"),
    );
    await delay(500);
    if ((await changes()) !== 2) {
      problems.push(`Saved pressed twice brought the changes to ${await changes()}`);
    }
    if ((await saved(page)).total !== total) problems.push("the record still holds it");
    if ((await focused(page)) !== "Save") {
      problems.push(`after Saved the focus is on ${await focused(page)}`);
    }
    await page.evaluate("window.stopCounting()");
    await closeSheet(page);
    report("Save pressed twice at once makes one change, and keeps the focus", problems);
  }

  {
    const problems: string[] = [];
    const dropped = (await saved(page)).entries[0];
    const name = dropped?.title?.title ?? "";
    const without = (listed: boolean) => {
      provider.serveTitles((all) =>
        listed
          ? all
          : { ...all, movies: all.movies.filter((movie) => String(movie.id) !== DROPPED.id) },
      );
      return invoke(page, "ondemand.refresh", { subscriptionId: one?.id });
    };
    const tile = `[...document.querySelectorAll("[data-remove]")].find((each) => each.getAttribute("aria-label") === ${JSON.stringify(`Remove ${name} from Watchlist`)})?.parentElement.querySelector("button")`;
    const line = () => page.evaluate<string>(`${tile}?.innerText ?? ""`);
    await openWatchlist(page);

    await without(false);
    await waitFor(async () => (await line()).includes("Unavailable · Movie"), 15_000).catch(
      async () => problems.push(`its tile says ${JSON.stringify(await line())}`),
    );
    await click(page, tile);
    await waitFor(() => exists(page, sheetButton("Remove from Watchlist")), 10_000).catch(() =>
      problems.push("its sheet has no Remove"),
    );
    const actions = await page.evaluate<string[]>(
      `[...document.querySelectorAll('[role="dialog"] button')].map((each) => each.textContent.trim() || each.getAttribute("aria-label"))`,
    );
    if (actions.join() !== "Remove from Watchlist,Close") {
      problems.push(`its sheet offers ${actions.join(", ")}`);
    }
    if (!(await says(page, "Your provider doesn't list it right now.", '[role="dialog"]'))) {
      problems.push("its sheet doesn't say why");
    }
    await closeSheet(page);
    if (!(await saved(page)).entries.some((entry) => entry.id === dropped?.id)) {
      problems.push("it went with the provider's row");
    }

    await without(true);
    await waitFor(async () => !(await line()).includes("Unavailable"), 15_000).catch(() =>
      problems.push("listed again, it still says Unavailable"),
    );
    await click(page, tile);
    await waitFor(() => exists(page, sheetButton("Play")), 20_000).catch(() =>
      problems.push("listed again, its details have no Play"),
    );
    await closeSheet(page);

    await without(false);
    await waitFor(async () => (await line()).includes("Unavailable"), 15_000);
    await click(page, tile);
    await waitFor(async () => (await focused(page)) === "Remove from Watchlist", 10_000).catch(
      async () => problems.push(`its sheet opens with the focus on ${await focused(page)}`),
    );
    await enter(page);
    await waitFor(async () => !(await exists(page, SHEET)), 10_000).catch(() =>
      problems.push("the sheet stays after Remove"),
    );
    if ((await saved(page)).total !== 3) problems.push("Remove took nothing off");
    await without(true);
    report(
      "A title the provider drops stays as Unavailable, comes back, and its sheet removes it",
      problems,
    );
  }

  const FOR_ADULTS = 'document.querySelector(\'[role="checkbox"][aria-label="For adults"]\')';
  /** Ticks or unticks For adults in Settings, which is open, and waits until it is stored. */
  const tickAdults = async (shown: boolean) => {
    await click(page, withText("nav button", "Movies and series"));
    await waitFor(() => exists(page, FOR_ADULTS), 10_000);
    const ticked = await page.evaluate<string>(`${FOR_ADULTS}.getAttribute("aria-checked")`);
    if (ticked !== String(shown)) await click(page, FOR_ADULTS);
    await waitFor(
      async () =>
        (await invoke<{ preferences: { adultTitles?: boolean } }>(page, "preferences.get"))
          .preferences.adultTitles === shown,
      10_000,
    );
  };
  /** Shows or hides titles for adults in Settings, as the viewer does, and leaves Settings. */
  const showAdults = async (shown: boolean) => {
    await click(page, "document.querySelector('button[aria-label=\"Settings\"]')");
    await tickAdults(shown);
    await key(page, "Escape", 27);
    await delay(500);
  };

  {
    const problems: string[] = [];
    await invoke(page, "watchlist.save", { kind: "series", version: own(ADULT_SERIES.id) });
    await openWatchlist(page);
    await delay(500);
    const hidden = { record: (await saved(page)).total, page: (await tiles(page)).length };
    if (hidden.record !== 3 || hidden.page !== 3) {
      problems.push(`hidden, the record counts ${hidden.record} and the page shows ${hidden.page}`);
    }
    if (await says(page, ADULT_SERIES.name)) problems.push("its name shows while hidden");

    await showAdults(true);
    await waitFor(async () => (await tiles(page)).length === 4, 10_000).catch(async () =>
      problems.push(`shown, the page has ${(await tiles(page)).length} tiles`),
    );
    await showAdults(false);
    await waitFor(async () => (await tiles(page)).length === 3, 10_000).catch(async () =>
      problems.push(`hidden again, the page has ${(await tiles(page)).length} tiles`),
    );
    await click(page, pageButton("Home"));
    await waitFor(() => exists(page, withText("h2", "Watchlist")), 10_000);
    if (await says(page, ADULT_SERIES.name)) problems.push("Home shows its name while hidden");
    const all = `${withText("h2", "Watchlist")}?.parentElement.querySelector("button")`;
    const label = await page.evaluate<string>(`${all}?.innerText.replace(/\\s+/g, " ") ?? ""`);
    if (label.trim() !== "All 3") problems.push(`Home's row counts "${label}"`);
    report("A saved title for adults shows and counts only while Settings shows them", problems);
  }

  {
    const problems: string[] = [];
    const listed = (all: boolean) => {
      provider.serveTitles((titles) =>
        all
          ? titles
          : {
              ...titles,
              series: titles.series.filter((series) => String(series.id) !== ADULT_SERIES.id),
            },
      );
      return invoke(page, "ondemand.refresh", { subscriptionId: one?.id });
    };
    await showAdults(true);
    await openWatchlist(page);
    // The provider drops the series for adults, and the viewer opens what was kept of it.
    await listed(false);
    const tile = `[...document.querySelectorAll("[data-remove]")].map((cross) => cross.parentElement.querySelector("button")).find((each) => each.innerText.includes("Unavailable · Series"))`;
    await click(page, tile);
    await waitFor(() => exists(page, sheetButton("Remove from Watchlist")), 10_000).catch(() =>
      problems.push("its sheet doesn't open"),
    );
    const name = await page.evaluate<string>(
      `${SHEET}?.querySelector("h2")?.textContent.trim() ?? ""`,
    );
    if (!name) problems.push("its sheet has no name");

    // Settings opens over the sheet with its shortcut: the page under a sheet takes no click.
    await key(page, ",", 188, MODIFIERS.main);
    await tickAdults(false);
    // Under Settings, the page lets go of its tile.
    await waitFor(async () => !(await says(page, name)), 10_000).catch(() =>
      problems.push("its name stays in the window while hidden"),
    );
    // From here on, nothing may draw its name.
    await page.evaluate(`(() => {
      window.drewHidden = false;
      new MutationObserver(() => {
        window.drewHidden ||= document.body.innerText.includes(${JSON.stringify(name)});
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    })()`);
    await key(page, "Escape", 27);
    await delay(1000);
    if (await exists(page, SHEET)) {
      problems.push("its sheet came back once Settings closed");
      await closeSheet(page);
    }
    if (await page.evaluate<boolean>("window.drewHidden")) {
      problems.push("its name was drawn after Settings hid titles for adults");
    }
    const hidden = { record: (await saved(page)).total, page: (await tiles(page)).length };
    if (hidden.record !== 3 || hidden.page !== 3) {
      problems.push(`hidden, the record counts ${hidden.record} and the page shows ${hidden.page}`);
    }

    // It is still saved: shown again, it is there as it was, and available once listed again.
    await showAdults(true);
    await waitFor(async () => (await tiles(page)).length === 4, 10_000).catch(async () =>
      problems.push(`shown again, the page has ${(await tiles(page)).length} tiles`),
    );
    if (!(await says(page, name))) problems.push("shown again, its name isn't on the page");
    await listed(true);
    await waitFor(async () => !(await exists(page, tile)), 15_000).catch(() =>
      problems.push("listed again, it still says Unavailable"),
    );
    await showAdults(false);
    report(
      "The sheet of a dropped title for adults is gone once Settings hides them, and it stays saved",
      problems,
    );
  }

  {
    const problems: string[] = [];
    const before = (await saved(page)).entries.map((entry) => entry.id);
    page = await restart(page);
    await waitFor(() => exists(page, "document.querySelector('header')"));
    await waitFor(() => listsLoaded(page), 60_000);
    const after = (await saved(page)).entries.map((entry) => entry.id);
    if (after.join() !== before.join()) problems.push(`the record holds ${after.length} entries`);
    await openWatchlist(page);
    await waitFor(async () => (await tiles(page)).length === before.length, 15_000).catch(
      async () => problems.push(`the page shows ${(await tiles(page)).length} tiles`),
    );
    await click(page, poster(LONG_MOVIE.name));
    if ((await saveButton(page)) !== "Saved") problems.push("its details read Save");
    await closeSheet(page);
    report("Everything saved is there after a restart, in the same order", problems);
  }

  // From here on the second provider is saved beside the first.
  await addSubscription(page, second, SECOND);
  await closeSheet(page);
  await waitFor(() => listsLoaded(page), 60_000);
  const [, two] = await subscriptions(page);
  if (!two) throw new Error("The second subscription wasn't saved.");
  const [film] = await invoke<Title[]>(page, "ondemand.titles", {
    kind: "movie",
    versions: [own(SHARED.there, two)],
  });
  if (!film) throw new Error("The film both providers list isn't in the lists.");
  /** The entry the film both list is saved as, or none. */
  const both = async () => (await saved(page)).entries.find((each) => each.title?.key === film.key);

  {
    const problems: string[] = [];
    const before = (await saved(page)).total;
    const posters = await openFound(page, film);
    if (posters !== 1) problems.push(`${posters} posters show the film in Movies`);
    if ((await saveButton(page)) !== "Save") problems.push("the film reads Saved before it is");
    await page.evaluate(`(() => {
      window.watchlistChanges = 0;
      window.stopCounting = window.mrStreamer.on("watchlist.changed", () => {
        window.watchlistChanges += 1;
      });
    })()`);
    await click(page, sheetButton("Save"));
    await waitFor(() => exists(page, sheetButton("Saved")), 10_000).catch(() =>
      problems.push("the button doesn't read Saved"),
    );
    await delay(500);
    // Nothing asked which subscription: the sheet is all that is open, and one change was made.
    const open = await page.evaluate<number>(
      `document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"]').length`,
    );
    if (open !== 1) problems.push(`${open} sheets, questions or menus are open after Save`);
    const changes = await page.evaluate<number>("window.watchlistChanges");
    if (changes !== 1) problems.push(`saving it for both made ${changes} changes`);
    await page.evaluate("window.stopCounting()");
    const entry = await both();
    if (entry?.sources.join() !== [one?.id, two.id].join()) {
      problems.push(`it is saved for ${entry?.sources.length ?? 0} subscriptions`);
    }
    if ((await saved(page)).total !== before + 1) problems.push("it isn't one more entry");
    await closeSheet(page);
    await key(page, "Escape", 27);

    // One tile, which says no subscription: Play's menu offers each one's version.
    await openWatchlist(page);
    const name = entry?.title?.title ?? "";
    await waitFor(async () => (await tiles(page)).length === before + 1, 10_000).catch(() => {});
    const shown = (await tiles(page)).filter(([each]) => each === name);
    if (shown.length !== 1) problems.push(`${shown.length} tiles show it`);
    if (shown.some(([, line]) => line.includes(SECOND) || line.includes(FIRST))) {
      problems.push(`its tile says ${shown.map(([, line]) => line).join()}`);
    }

    // Played in the second's version, it asks the second's provider alone for the file.
    const clock = () => page.evaluate<number>(`document.querySelector("video")?.currentTime ?? 0`);
    const files = { first: provider.fileRequests(), second: second.fileRequests() };
    await click(page, poster(film.name));
    await waitFor(() => exists(page, `${SHEET}?.querySelector('[aria-label="Versions"]')`), 30_000);
    await pickVersion(page, SECOND);
    await click(page, sheetButton("Play"));
    await waitFor(async () => (await clock()) >= 2, 45_000).catch(async () =>
      problems.push(`the second's version didn't play: ${await clock()}`),
    );
    if (second.fileRequests() === files.second || provider.fileRequests() !== files.first) {
      problems.push(
        `${second.fileRequests() - files.second} file requests at the second, ${provider.fileRequests() - files.first} at the first`,
      );
    }
    if (second.mostFilesAtOnce() !== 1) {
      problems.push(`${second.mostFilesAtOnce()} connections for its file at once`);
    }
    await key(page, "Escape", 27);
    await delay(2000);
    if (provider.activeStreams() + second.activeStreams() !== 0) {
      problems.push(
        `${provider.activeStreams()} and ${second.activeStreams()} connections held after leaving`,
      );
    }
    // How far it got is kept for the second's version alone, and it is saved as before.
    const progress = await invoke<TitleProgress[]>(page, "viewing.progress", {
      movies: film.versions.map(({ subscriptionId, id }) => ({ subscriptionId, id })),
    });
    const played = progress.map((each) => each.title.subscriptionId);
    if (played.join() !== two.id || !progress.every((each) => each.position > 0)) {
      problems.push(`progress is kept for ${played.join() || "none"}`);
    }
    if ((await saveButton(page)) !== "Saved") problems.push("playing it took it off the watchlist");
    await pickVersion(page, "Automatic");
    await closeSheet(page);

    // Its cross takes it off for both.
    const cross = `[...document.querySelectorAll("[data-remove]")].find((each) => each.getAttribute("aria-label") === ${JSON.stringify(`Remove ${name} from Watchlist`)})`;
    await click(page, cross);
    await waitFor(async () => (await saved(page)).total === before, 10_000).catch(() =>
      problems.push("the cross took nothing off"),
    );
    const left = await Promise.all(
      [own(SHARED.id), own(SHARED.there, two)].map((version) =>
        invoke<OwnedId | null>(page, "watchlist.saved", { kind: "movie", version }),
      ),
    );
    if (left.some(Boolean)) problems.push(`it is still saved as ${JSON.stringify(left)}`);
    if ((await tiles(page)).some(([each]) => each === name)) problems.push("its tile stays");
    report(
      "A film two subscriptions list is saved for both at once, is one tile, plays from the one picked, and goes for both",
      problems,
    );
  }

  {
    const problems: string[] = [];
    // The film both list again, and a film only the second lists.
    await invoke(page, "watchlist.save", { kind: "movie", version: own(SHARED.id) });
    const theirs = await invoke<OwnedId>(page, "watchlist.save", {
      kind: "movie",
      version: own(THEIRS.id, two),
    });
    const before = await saved(page);
    const firsts = before.entries.filter((each) => each.sources.join() === one?.id);
    /** The ids a list holds, in its order, without the film both list. */
    const others = (list: WatchlistPage) =>
      list.entries.flatMap((each) => (each.title?.key === film.key ? [] : [each.id])).join();

    // Without its box ticked, what its account saved is kept, and leaves the list with it.
    await removeSubscription(page, SECOND, false);
    await closeSheet(page);
    const without = await saved(page);
    if (others(without) !== firsts.map((each) => each.id).join()) {
      problems.push(`with the second gone the list has ${without.total} entries`);
    }
    if ((await both())?.sources.join() !== one?.id) {
      problems.push("the film both saved didn't stay as the first's");
    }
    if (accountsSaved() !== 2)
      problems.push(`${accountsSaved()} accounts are kept in the database`);
    await openWatchlist(page);
    await waitFor(async () => (await tiles(page)).length === without.total, 10_000).catch(
      async () => problems.push(`the page shows ${(await tiles(page)).length} tiles`),
    );

    // Added again, its account has its entries back, under the subscription's new id.
    await addSubscription(page, second, SECOND);
    await closeSheet(page);
    await waitFor(() => listsLoaded(page), 60_000);
    const [, back] = await subscriptions(page);
    const again = await saved(page);
    const returned = again.entries.find((each) => each.id === theirs.id);
    if (back?.id === two.id || returned?.subscriptionId !== back?.id || !returned?.title) {
      problems.push(`added again, its own entry is ${JSON.stringify(returned ?? null)}`);
    }
    if ((await both())?.sources.join() !== [one?.id, back?.id].join()) {
      problems.push("added again, the film both saved isn't saved for both");
    }
    if (again.total !== before.total) problems.push(`the list has ${again.total} entries`);

    // With its box ticked, what its account saved goes for good, and the rest stays.
    await removeSubscription(page, SECOND, true);
    await closeSheet(page);
    const erased = await saved(page);
    if (others(erased) !== firsts.map((each) => each.id).join()) {
      problems.push(`with the second deleted the list has ${erased.total} entries`);
    }
    if ((await both())?.sources.join() !== one?.id) {
      problems.push("deleting the second's took the film both saved from the first");
    }
    if (accountsSaved() !== 1)
      problems.push(`${accountsSaved()} accounts are kept in the database`);
    report(
      "Removing a subscription keeps what it saved for its account, deletes it with the box ticked, and leaves the rest",
      problems,
    );
  }

  {
    const problems: string[] = [];
    const kept = (await saved(page)).entries.map((entry) => entry.id);
    /** Removes the only subscription, which returns to Connect, and connects its account again. */
    const reconnect = async (erase: boolean) => {
      await removeSubscription(page, FIRST, erase);
      await waitFor(() => exists(page, 'document.querySelector("form input")'), 20_000);
      await login(page, provider);
      [one] = await subscriptions(page);
      await waitFor(() => listsLoaded(page), 60_000);
    };
    await reconnect(false);
    const back = (await saved(page)).entries.map((entry) => entry.id);
    if (back.join() !== kept.join()) {
      problems.push(`connected again, the account has ${back.length} of ${kept.length} entries`);
    }
    await reconnect(true);
    if ((await saved(page)).total !== 0) problems.push("its watchlist outlived the delete");
    if (accountsSaved() !== 0)
      problems.push(`${accountsSaved()} accounts are kept in the database`);
    await openWatchlist(page);
    if (!(await says(page, "Nothing saved yet."))) problems.push("the page isn't empty");
    report(
      "Removing the last subscription keeps its watchlist, and deletes it with its box ticked",
      problems,
    );
  }
  page.close();
} catch (error) {
  console.error(`FAIL ${String(error)}`);
  failed = true;
} finally {
  app.kill("SIGKILL");
  await Promise.all([provider.close(), second.close(), tmdb.close()]);
  await delay(1000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(failed ? 1 : 0);
