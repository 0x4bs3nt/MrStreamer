// Shared controls and menus through the real built window: Settings fields at 1440 and 960, its
// rail search, Subscriptions, Guides and Licences, the title filter, version and both download
// menus, Live TV's rail, rows, schedule and filter menu, Watch's channel list and a playing
// title's CC panel. Every surface is captured for before/after comparison with its computed
// shape recorded beside it. Assertions cover public behavior only: each menu opens from its
// trigger, Down highlights a row, another than before where more than one is enabled, and Escape
// closes it, leaving the view under it open.
import type { Driver } from "./language.ts";

const button = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;
const query = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`;
const shown = (selector: string) => query(`main:not([hidden]) ${selector}`);
const poster = (name: string) =>
  `[...document.querySelectorAll('button[title]')].find(b => b.title.includes(${JSON.stringify(name)}))`;
const expect = (value: boolean, message: string) => {
  if (!value) throw new Error(message);
};

interface Shape {
  /** Computed `border-radius`, one value per corner where they differ. */
  readonly radius: string;
  readonly height: number;
  readonly background: string;
}

/** A menu's highlighted row by its place among the rows, -1 for none, and how many are enabled. */
interface Highlight {
  readonly row: number;
  readonly label: string | null;
  readonly enabled: number;
}

export async function controlsScenario(d: Driver): Promise<void> {
  const shapes: Record<string, Shape | null> = {};
  const menus: string[] = [];
  const highlights: Record<string, { before: Highlight; after: Highlight }> = {};
  d.observed["shapes"] = shapes;
  d.observed["menus"] = menus;
  d.observed["highlights"] = highlights;
  const size = async (width: number, height: number) => {
    await d.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await d.wait(() => d.evaluate<boolean>(`innerWidth === ${width} && innerHeight === ${height}`));
  };
  /** Records how `element`, or the field around it, is drawn: an observation, never a check. */
  const shape = async (name: string, element: string, field = false) => {
    shapes[name] = await d.evaluate<Shape | null>(`(() => {
      const found = ${element};
      const e = ${field} ? found?.closest('label') ?? found : found;
      if (!e) return null;
      const style = getComputedStyle(e);
      return {
        radius: style.borderRadius,
        height: Math.round(e.getBoundingClientRect().height * 10) / 10,
        background: style.backgroundColor,
      };
    })()`);
  };
  /** Waits until nothing under `element` still animates, as a popup does while it opens. */
  const settled = (element: string) =>
    d.wait(() =>
      d.evaluate<boolean>(`(() => {
        const e = ${element};
        return !!e && e.getAnimations({ subtree: true }).every(a => a.playState !== 'running');
      })()`),
    );
  /** The row of `popup` Base UI marks highlighted or, in a menu of plain buttons, focus is on. */
  const highlight = (popup: string) =>
    d.evaluate<Highlight>(`(() => {
      const rows = [...(${popup})?.querySelectorAll('[role^=menuitem]') ?? []];
      const marked = rows.findIndex(e => e.matches('[data-highlighted]'));
      const row = marked >= 0 ? marked : rows.findIndex(e => e.matches(':focus'));
      return {
        row,
        label: rows[row]?.getAttribute('aria-label') ?? rows[row]?.textContent.trim() ?? null,
        enabled: rows.filter(e => !e.matches(':disabled, [aria-disabled=true]')).length,
      };
    })()`);
  /**
   * Opens a menu from its trigger and presses Down, which highlights a row: another than before
   * where more than one is enabled, as a single row may keep it. Captures it and closes it with
   * Escape.
   */
  const menu = async (
    name: string,
    trigger: string,
    popup: string,
    { within }: { within?: string } = {},
  ) => {
    await d.click(`Open the ${name} menu`, trigger);
    await d.wait(() => d.exists(popup));
    await settled(popup);
    const before = await highlight(popup);
    await d.key("ArrowDown", 40);
    await d.wait(async () => {
      const { row } = await highlight(popup);
      return row >= 0 && (before.enabled < 2 || row !== before.row);
    });
    highlights[name] = { before, after: await highlight(popup) };
    const item = `${popup}?.querySelector(':is([data-highlighted], :focus)')`;
    await shape(`${name} menu`, popup);
    await shape(`${name} highlighted row`, item);
    await d.capture(`menu-${name.replaceAll(" ", "-")}`);
    await d.key("Escape", 27);
    await d.wait(async () => !(await d.exists(popup)));
    if (within) expect(await d.exists(within), `Escape on the ${name} menu closed its view`);
    menus.push(name);
  };

  // Settings > Subtitles at 1440 x 900 with SubDL's form open, as the selected mockup draws it.
  await size(1440, 900);
  await d.click("Open Settings", query("header button[aria-label=Settings]"));
  await d.wait(() => d.exists(query("[data-view=settings]")));
  await d.click("Open Subtitles", button("nav button", "Subtitles"));
  const online = shown('input[aria-label="Online subtitle search"]');
  await d.click("Turn on online subtitle search", online);
  await d.wait(() => d.evaluate<boolean>(`${online}?.checked === true`));
  await d.click("Set up SubDL", shown("[data-setting=subdl] button"));
  const subdl = shown('input[aria-label="SubDL API key"]');
  await d.wait(() => d.exists(subdl));
  await shape("settings rail current", query('nav button[aria-current="page"]'));
  await shape("settings search", query("nav input[type=search]"), true);
  await shape("settings select", shown('select[aria-label="Subtitles"]'));
  await shape("settings checkbox", online);
  await shape("settings key field", subdl);
  await d.capture("settings-subtitles-1440");

  // Movies and series at the 960 x 600 minimum with TMDB's own key form open.
  await size(960, 600);
  await d.click("Open Movies and series", button("nav button", "Movies and series"));
  await d.click("Open the own TMDB key form", shown("[data-setting=tmdb] button"));
  const tmdb = shown('input[aria-label="Your own TMDB key"]');
  await d.wait(() => d.exists(tmdb));
  await shape("settings TMDB field", tmdb);
  await shape("settings Use button", button("main:not([hidden]) form button", "Use"));
  await d.capture("settings-movies-960");
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists(tmdb)));

  // Local search lists results under the field; Escape empties it.
  const search = query("nav input[type=search]");
  await d.click("Find a setting", search);
  d.action("Type sub into Find a setting");
  await d.send("Input.insertText", { text: "sub" });
  await d.wait(() => d.exists(query("[data-setting-result]")));
  await d.capture("settings-search-results");
  await d.key("Escape", 27);
  await d.wait(() => d.evaluate<boolean>(`${search}.value === ''`));

  // Subscriptions' edit form under its row.
  await d.click("Open Subscriptions", button("nav button", "Subscriptions"));
  await d.click(
    "Edit the subscription",
    `document.querySelector('main:not([hidden]) button[aria-label^="Edit "]')`,
  );
  await d.wait(() => d.exists(shown("form input")));
  await shape("subscription edit field", shown("form input"));
  await shape("subscription Save button", button("main:not([hidden]) form button", "Save"));
  await d.capture("settings-subscription-edit");
  await d.click("Cancel the edit", button("main:not([hidden]) form button", "Cancel"));
  await d.wait(async () => !(await d.exists(shown("form input"))));

  // Guides' add fields, and the licence list's search.
  await d.click("Open Guides", button("nav button", "Guides"));
  const guide = shown('input[aria-label="Address of an XMLTV guide"]');
  await d.wait(() => d.exists(guide));
  await shape("guide address field", guide);
  await d.capture("settings-guides");
  await d.click("Open About", button("nav button", "About"));
  await d.click("Open licences", shown("[data-setting=licences]"));
  const licences = query('[aria-label="Search the licences"]');
  await d.wait(() => d.exists(licences));
  await shape("licence search", licences, true);
  await d.capture("settings-licences");
  await d.key("Escape", 27);
  await d.wait(() => d.exists(shown("[data-setting=licences]")));
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists(query("[data-view=settings]"))));

  // The title filter menu, then a playing title's CC panel with its online search language.
  const dialog = query('[role="dialog"]');
  await size(1440, 900);
  await d.click("Open Movies", button("header button", "Movies"));
  await d.click("Open All movies", button("nav button", "All movies"));
  await menu(
    "title quality filter",
    query('[role=group][aria-label="Quality"] button'),
    query('[role=menu][aria-label="Quality"]'),
  );
  await d.click("Open the long-subtitles movie", poster("Long subtitles"));
  await d.click(
    "Play the movie",
    `[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim().startsWith('Play'))`,
  );
  await d.wait(() =>
    d.evaluate<boolean>(
      "!!document.querySelector('[data-view=title]') && document.querySelector('video')?.currentTime > 0.5",
    ),
  );
  await d.evaluate(
    "document.querySelector('[data-view=title]').dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))",
  );
  await d.click(
    "Open the title's subtitles",
    query("[data-view=title] button[aria-label=Subtitles]"),
  );
  const language = query('select[aria-label="Subtitle search language"]');
  await d.wait(() => d.exists(language));
  await shape("CC panel select", language);
  await d.capture("title-cc-panel");
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists(language)));
  // Back returns to the details the title was opened from, which Escape closes in turn.
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists(query("[data-view=title]"))));
  if (await d.exists(dialog)) await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists(dialog)));

  // The two-version movie's versions, then its downloaded copy's options.
  await d.click("Open Movies", button("header button", "Movies"));
  await d.click("Open All movies", button("nav button", "All movies"));
  await d.click("Open the two-version movie", poster("Two sound tracks"));
  await menu(
    "versions",
    query('[role=dialog] button[aria-label="Versions"]'),
    query("[role=menu]"),
    { within: dialog },
  );
  await d.click("Download the movie", button('[role="dialog"] button', "Download"));
  await d.wait(() => d.exists(button('[role="dialog"] button', "Watch offline")), 60_000);
  await menu(
    "download options",
    query('[role=dialog] button[aria-label="Download options"]'),
    query("[role=menu]"),
    { within: dialog },
  );
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists(dialog)));

  // A series' download menu.
  await d.click("Open Series", button("header button", "Series"));
  await d.click("Open All series", button("nav button", "All series"));
  await d.click("Open the Formats series", poster("Formats"));
  await menu(
    "series download",
    query('[role=dialog] button[aria-label^="Download options: "]'),
    query("[role=menu]"),
    { within: dialog },
  );
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists(dialog)));

  // Live TV: the category rail and its search, a pointed row, an opened day and a filter menu.
  await d.click("Open Live TV", button("header button", "Live TV"));
  const rail = query('[role=navigation][aria-label="Channel categories"]');
  await d.wait(() => d.exists(rail));
  const category = query('input[aria-label="Find a category"]');
  await shape("category search", category, true);
  await shape("category current", `${rail}?.querySelector('[aria-current=true]')`);
  await d.capture("live-list");
  await d.click("Find a category", category);
  d.action("Type TEST into Find a category");
  await d.send("Input.insertText", { text: "TEST" });
  await d.wait(() =>
    d.evaluate<boolean>(
      `[...${rail}.querySelectorAll('[data-entry]')].every(e => e.textContent.includes('TEST'))`,
    ),
  );
  await d.capture("live-category-search");
  await d.key("Escape", 27);
  await d.wait(() => d.evaluate<boolean>(`${category}.value === ''`));
  const row = `[...document.querySelectorAll('[data-index]')].find(r => r.querySelector('button[aria-label="Later programmes"]'))`;
  await d.wait(() => d.exists(row));
  const point = await d.evaluate<{ x: number; y: number }>(`(() => {
    const box = (${row}).querySelector('[role=button]').getBoundingClientRect();
    return { x: box.x + box.width / 3, y: box.y + box.height / 2 };
  })()`);
  d.action("Point at a channel row");
  await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await shape("channel row pointed", `(${row}).querySelector('[role=button]')`);
  await d.capture("live-row-pointed");
  await d.click(
    "Open the row's later programmes",
    `(${row}).querySelector('button[aria-label="Later programmes"]')`,
  );
  const open = `[...document.querySelectorAll('[data-index]')].find(r => r.querySelector('button[aria-label="Hide later programmes"]'))`;
  await d.wait(() => d.exists(open));
  await shape("channel row opened", `(${open}).querySelector('[role=button]')`);
  await shape("opened schedule", `(${open}).querySelector('[role=button]').nextElementSibling`);
  await d.capture("live-schedule-open");
  await d.click(
    "Close the row's later programmes",
    `(${open}).querySelector('button[aria-label="Hide later programmes"]')`,
  );
  await menu(
    "live country filter",
    query('button[data-browse-filter="countries"]'),
    query('[role=menu][aria-label="Country"]'),
  );

  // Watch's channel list over a playing channel.
  await d.click("Open global Search", query("button[aria-label=Search]"));
  d.action("Search TEST | H.264 + AAC");
  await d.send("Input.insertText", { text: "TEST | H.264 + AAC" });
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelector('[aria-label=\"Search results\"] [aria-selected=true]')?.textContent.includes('H.264 + AAC') ?? false",
    ),
  );
  await d.key("Enter", 13);
  await d.wait(() =>
    d.evaluate<boolean>(
      "!!document.querySelector('[data-view=watch]') && document.querySelector('video')?.currentTime >= 1",
    ),
  );
  await d.key("ArrowLeft", 37);
  const playingRow = `[...document.querySelectorAll('[data-view=watch] [aria-label="Playing"]')].map(e => e.closest('[role=button]')).find(Boolean)`;
  await d.wait(() => d.exists(playingRow));
  await shape("Watch playing row", playingRow);
  await d.capture("watch-channel-list");
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists(playingRow)));
}
