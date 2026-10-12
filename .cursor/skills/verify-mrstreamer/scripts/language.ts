// The language scenario: the interface language picked in Settings, through the real window, at
// the smallest window the app allows. It changes the app's own text at once, keeps the title,
// sound and subtitle languages, survives a restart, follows the system when set to System
// default, and shows English for a language a later release saved. Expected text comes from the
// catalogue the app ships, so a translation fix doesn't break the check.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LANGUAGE_NAMES,
  type Locale,
  type InterfaceLanguage,
} from "../../../../packages/contracts/src/language.ts";
import { translate } from "../../../../packages/core/src/i18n.ts";

/** What the scenario drives the owned app with; `control.ts` provides it. */
export interface Driver {
  readonly profile: string;
  readonly observed: Record<string, unknown>;
  evaluate<T>(expression: string): Promise<T>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  wait(check: () => Promise<boolean>): Promise<void>;
  exists(expression: string): Promise<boolean>;
  click(label: string, element: string): Promise<void>;
  key(name: string, code: number): Promise<void>;
  capture(name: string): Promise<void>;
  action(label: string): void;
  launch(system?: string): Promise<void>;
  quit(): Promise<void>;
}

const SETTINGS = "document.querySelector('header button[aria-pressed]')";
/** Interface language has locale-valued options; other selects can appear before it loads. */
const LANGUAGE = `document.querySelector('main section select:has(option[value="en-US"])')`;
const NAV = "[...document.querySelectorAll('header button')]";

export async function languageScenario(d: Driver): Promise<void> {
  const prefsPath = join(d.profile, "preferences.json");
  const savedPreferences = async () =>
    JSON.parse(await readFile(prefsPath, "utf8")) as Record<string, unknown>;

  await smallestWindow(d);
  const contentLanguages = async () =>
    d.evaluate<{ titles?: string; audio?: string; subtitles?: string }>(`(async () => {
      const read = await window.mrStreamer.invoke('preferences.get');
      return read.ok ? { titles: read.value.titleLanguage, audio: read.value.audioLanguage,
        subtitles: read.value.subtitleLanguage } : {};
    })()`);
  const openSettings = async () => {
    await d.click("Open Settings", SETTINGS);
    await d.wait(() => d.exists(LANGUAGE));
  };
  const shown = () =>
    d.evaluate<{
      lang: string;
      heading: string;
      tabs: string[];
      select: { value: string; options: string[]; label: string | null };
      sections: string[];
    }>(`(() => {
      const select = ${LANGUAGE};
      return {
        lang: document.documentElement.lang,
        heading: document.querySelector('nav h1')?.textContent ?? '',
        tabs: [...document.querySelectorAll('nav button')].map(b => b.textContent.trim()),
        select: { value: select?.value ?? '', label: select?.getAttribute('aria-label') ?? null,
          options: [...(select?.options ?? [])].map(o => o.textContent) },
        sections: [...document.querySelectorAll('main h2')].map(h => h.textContent),
      };
    })()`);
  const header = () =>
    d.evaluate<{ nav: string[]; labels: string[] }>(`(() => ({
      nav: ${NAV}.map(b => b.textContent.trim()).filter(Boolean),
      labels: [...document.querySelectorAll('header [aria-label]')].map(b => b.getAttribute('aria-label')),
    }))()`);

  const language = () =>
    d.evaluate<InterfaceLanguage>(`(async () => {
    const read = await window.mrStreamer.invoke('language.get');
    if (!read.ok) throw new Error('Cannot read interface language');
    return read.value;
  })()`);
  const initial = await language();
  if (process.platform === "linux") expect(initial.system === "en-US", "English fixture system");
  await homeControls(d, initial.system);
  await d.capture("home-en-US");

  // The fresh profile follows the actual system, English on the Linux fixture run.
  await openSettings();
  const english = await shown();
  const before = await contentLanguages();
  d.observed["english"] = { ...english, content: before };
  expect(
    english.lang === initial.system && initial.choice === "system",
    "First start follows the system",
  );
  expect(
    english.select.value === "system" &&
      english.select.options[0] ===
        translate(initial.system, "System default ({language})", {
          language: LANGUAGE_NAMES[initial.system],
        }),
    "System default names the actual system language",
  );
  await d.capture("settings-en");

  const pick = async (locale: Locale | "system") => {
    const name = locale === "system" ? null : LANGUAGE_NAMES[locale];
    d.action(`Pick ${name ?? "System default"} with the keyboard`);
    await d.evaluate(`${LANGUAGE}.focus()`);
    // A closed select takes a typed name as a choice: "De" is Deutsch, "Es" Español, and
    // System default goes by its own name in the language shown.
    const typed = name ?? (await d.evaluate<string>(`${LANGUAGE}.options[0].textContent`));
    for (const char of typed.slice(0, 2)) {
      await d.send("Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char });
      await d.send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
    }
  };

  const visits: Record<string, unknown> = {};
  for (const locale of ["fr-FR", "nl-NL", "es-ES", "de-DE"] as const) {
    await pick(locale);
    await d.wait(async () => (await shown()).lang === locale);
    const settings = await shown();
    expect(
      settings.heading === translate(locale, "Settings") &&
        settings.select.label === translate(locale, "Interface language") &&
        settings.select.value === locale &&
        settings.tabs.join() ===
          [
            translate(locale, "General"),
            translate(locale, "Home"),
            translate(locale, "Subscriptions"),
            translate(locale, "About"),
          ].join(),
      `Settings in ${locale}`,
      settings,
    );
    await d.capture(`settings-${locale}`);
    await d.key("Escape", 27);
    await d.wait(async () => !(await d.exists(LANGUAGE)));
    const bar = await header();
    expect(
      bar.nav.includes(translate(locale, "Home")) &&
        bar.nav.includes(translate(locale, "Live TV")) &&
        bar.labels.includes(translate(locale, "Search")) &&
        bar.labels.includes(translate(locale, "Settings")),
      `Window bar in ${locale}`,
      bar,
    );
    await homeControls(d, locale);
    await d.capture(`home-${locale}`);
    visits[locale] = { settings, bar };
    await openSettings();
  }
  d.observed["languages"] = visits;
  const after = await contentLanguages();
  d.observed["contentAfterSwitching"] = after;
  expect(
    JSON.stringify(after) === JSON.stringify(before),
    "Title, sound and subtitle languages kept",
  );

  // German survives a restart, from the first paint.
  await d.quit();
  const file = await savedPreferences();
  d.observed["savedGerman"] = { interfaceLanguage: file["interfaceLanguage"] };
  expect(file["interfaceLanguage"] === "de-DE", "German saved in preferences.json");
  await d.launch("en_US");
  await smallestWindow(d);
  await d.wait(() => d.evaluate<boolean>("document.documentElement.lang === 'de-DE'"));
  await d.wait(() => d.exists("document.querySelector('header')"));
  const restarted = await header();
  d.observed["afterRestart"] = restarted;
  expect(restarted.nav.includes(translate("de-DE", "Home")), "German after restart");
  await d.capture("restart-de-DE");

  await pages(d, "de-DE");
  await liveTv(d, "de-DE");
  await openSettings();
  await pick("fr-FR");
  await d.wait(async () => (await shown()).lang === "fr-FR");
  await d.key("Escape", 27);
  await titles(d, "fr-FR");
  await titleError(d, "fr-FR");
  await downloads(d, "fr-FR");

  // Linux can simulate a Dutch system with per-process environment variables. Native runs
  // retain the host's system language and verify that choice without changing host settings.
  await openSettings();
  await pick("system");
  await d.wait(async () => {
    const active = await language();
    return (
      active.choice === "system" &&
      active.locale === active.system &&
      (await shown()).lang === active.system
    );
  });
  await d.capture("system-en");
  await d.quit();
  await d.launch("nl_NL");
  await smallestWindow(d);
  await d.wait(() => d.exists("document.querySelector('header')"));
  const restartedSystem = await language();
  const expectedSystem = process.platform === "linux" ? "nl-NL" : initial.system;
  await d.wait(() =>
    d.evaluate<boolean>(`document.documentElement.lang === ${JSON.stringify(expectedSystem)}`),
  );
  await openSettings();
  const systemSettings = await shown();
  d.observed[process.platform === "linux" ? "systemDutch" : "systemNative"] = {
    ...systemSettings,
    language: restartedSystem,
  };
  expect(
    restartedSystem.system === expectedSystem &&
      restartedSystem.locale === expectedSystem &&
      restartedSystem.choice === "system" &&
      systemSettings.select.value === "system" &&
      systemSettings.select.options[0] ===
        translate(expectedSystem, "System default ({language})", {
          language: LANGUAGE_NAMES[expectedSystem],
        }),
    "System default follows and names the system after restart",
  );
  if (process.platform !== "linux")
    d.observed["systemSimulationLimit"] =
      "Native system language retained; LANGUAGE/LANG do not simulate a Dutch host. No host settings changed.";
  await d.capture(
    process.platform === "linux" ? "system-nl-NL" : `system-native-${expectedSystem}`,
  );

  // A language a later release saved: English, and nothing else in the file changes.
  await d.quit();
  const saved = await savedPreferences();
  d.action("Save interfaceLanguage it-IT as a later release would");
  await writeFile(prefsPath, JSON.stringify({ ...saved, interfaceLanguage: "it-IT" }));
  await d.launch("nl_NL");
  await smallestWindow(d);
  await d.wait(() => d.evaluate<boolean>("document.documentElement.lang === 'en-US'"));
  await openSettings();
  const unknown = await shown();
  const kept = await savedPreferences();
  d.observed["unknownSaved"] = { shown: unknown, content: await contentLanguages() };
  expect(unknown.select.value === "en-US", "A language this release doesn't know shows English");
  expect(
    kept["interfaceLanguage"] === "it-IT" &&
      JSON.stringify({ ...kept, interfaceLanguage: null }) ===
        JSON.stringify({ ...saved, interfaceLanguage: null }),
    "The rest of preferences.json stays as it was",
  );
  await d.capture("unknown-en");
}

/** The text of every element `selector` finds, trimmed. */
const texts = (selector: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].map(e => e.textContent.trim())`;
const labels = (selector: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].map(e => e.getAttribute('aria-label'))`;
const byText = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;

/** Plays a channel from global search, by the keyboard, and waits for Watch. */
async function watchFromSearch(d: Driver, locale: Locale, name: string) {
  await d.click(
    "Open global Search",
    `document.querySelector('header button[aria-label=${JSON.stringify(translate(locale, "Search"))}]')`,
  );
  d.action(`Search ${name}`);
  await d.send("Input.insertText", { text: name });
  await d.wait(() =>
    d.evaluate<boolean>(
      `document.querySelector('[role=tree] [aria-selected=true]')?.textContent.includes(${JSON.stringify(name.slice(7))}) ?? false`,
    ),
  );
  await d.key("Enter", 13);
  await d.wait(() => d.exists("document.querySelector('[data-view=watch]')"));
}

/**
 * Live TV in `locale`: a channel playing with its controls, the More menu by the keyboard, and a
 * channel that has no stream, whose message is the app's own.
 */
async function liveTv(d: Driver, locale: Locale) {
  await watchFromSearch(d, locale, "TEST | H.264 + AAC");
  await d.wait(() =>
    d.evaluate<boolean>(
      "(() => { const v = document.querySelector('video'); return !!v && v.currentTime > 0.5; })()",
    ),
  );
  await d.evaluate(
    "document.querySelector('[data-view=watch]').dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))",
  );
  const controls = await d.evaluate<string[]>(labels("[data-view=watch] button[aria-label]"));
  d.observed[`player-${locale}`] = controls;
  for (const key of ["Channels", "Stop", "Full screen", "More", "Mute"] as const) {
    expect(
      controls.includes(translate(locale, key)),
      `Player control ${key} in ${locale}`,
      controls,
    );
  }
  await d.capture(`player-${locale}`);

  // More opens from the keyboard, Space on its focused button, and Down walks its rows.
  const moreButton = `document.querySelector('[data-view=watch] button[aria-label=${JSON.stringify(translate(locale, "More"))}]')`;
  await d.evaluate(`${moreButton}.focus()`);
  d.action("Press Space on More");
  await d.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
    text: " ",
  });
  await d.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
  });
  const channelUp = translate(locale, "Channel up");
  await d.wait(() =>
    d.exists(`document.querySelector('[data-item][aria-label=${JSON.stringify(channelUp)}]')`),
  );
  const more = await d.evaluate<string[]>(labels("[data-item][aria-label]"));
  d.observed[`more-${locale}`] = more;
  expect(
    more.includes(channelUp) && more.includes(translate(locale, "Channel down")),
    `More menu in ${locale}`,
    more,
  );
  // Popup rows can exist before its initial-focus effect runs. Send navigation only once
  // keyboard focus has actually entered the open menu.
  await d.wait(() => d.evaluate("!!document.activeElement?.closest('[data-item]')"));
  await d.key("ArrowDown", 40);
  await d.key("ArrowDown", 40);
  d.observed[`moreFocus-${locale}`] = await d.evaluate<string | null>(
    "document.activeElement?.getAttribute('aria-label') ?? null",
  );
  expect(
    more.includes(String(d.observed[`moreFocus-${locale}`])),
    `The keyboard walks More's rows in ${locale}`,
    d.observed[`moreFocus-${locale}`],
  );
  await d.capture(`more-${locale}`);
  await d.key("Escape", 27);
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists("document.querySelector('[data-view=watch]')")));

  // A channel with no stream says why in the app's words.
  await watchFromSearch(d, locale, "TEST | Offline");
  const titles = (
    [
      "No stream right now",
      "No answer from the provider",
      "No picture arrived",
      "Lost the stream",
    ] as const
  ).map((key) => translate(locale, key));
  await d.wait(() =>
    d.evaluate<boolean>(
      `(() => { const t = document.querySelector('[data-view=watch]')?.innerText ?? ''; return ${JSON.stringify(titles)}.some(x => t.includes(x)); })()`,
    ),
  );
  d.observed[`error-${locale}`] = await d.evaluate<string>(
    "document.querySelector('[data-view=watch]')?.innerText ?? ''",
  );
  await d.capture(`error-${locale}`);

  // Its cross is named in the language and is reached with Tab. Enter on it closes the message
  // and hands focus to Watch, and opens no channel list.
  const cross = translate(locale, "Close message");
  const focused = () =>
    d.evaluate<string | null>(
      "document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? null",
    );
  for (let i = 0; i < 25 && (await focused()) !== cross; i++) await d.key("Tab", 9);
  expect((await focused()) === cross, `Tab reaches the message's cross in ${locale}`, cross);
  // The message, with its cross; the window keeps its spoken status line.
  const message = () =>
    d.evaluate<string>(
      "[...document.querySelectorAll('[data-playback-state]')].map(e => e.innerText).join(' ').trim()",
    );
  const open = await message();
  expect(
    titles.some((title) => open.includes(title)),
    `The message is in its place in ${locale}`,
    open,
  );
  d.action("Press Enter on the cross");
  await d.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
  });
  await d.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  const closedState = {
    message: await message(),
    focus: await focused(),
    list: await d.exists(
      `document.querySelector('[data-view=watch] header button[aria-label=${JSON.stringify(translate(locale, "Close"))}]')`,
    ),
  };
  d.observed[`errorClosed-${locale}`] = closedState;
  expect(
    closedState.message === "" &&
      closedState.focus === translate(locale, "Watch") &&
      !closedState.list,
    `Enter on the cross closes the message in ${locale}, focus on Watch, no channel list`,
    closedState,
  );
  await d.capture(`error-closed-${locale}`);
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists("document.querySelector('[data-view=watch]')")));
}

/**
 * Each page of the window bar in `locale`, at the smallest window: nothing runs past its edge,
 * and every page's name shows whole.
 */
async function pages(d: Driver, locale: Locale) {
  const fits: Record<string, unknown> = {};
  for (const page of ["Live TV", "Movies", "Series", "Watchlist", "Home"] as const) {
    if (page === "Watchlist")
      await d.click(
        "Return Home for Watchlist",
        byText("header button", translate(locale, "Home")),
      );
    await d.click(
      `Open ${page}`,
      byText(page === "Watchlist" ? "button" : "header button", translate(locale, page)),
    );
    await d.wait(() =>
      d.evaluate<boolean>(
        page === "Watchlist"
          ? `${byText("h1", translate(locale, "Watchlist"))} !== undefined`
          : `${byText("header button", translate(locale, page))}?.getAttribute('aria-current') === 'page'`,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const fit = await d.evaluate<{ overflow: boolean; clipped: string[] }>(`(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      clipped: [...document.querySelectorAll('header button, nav button, main button, h1, h2')]
        .filter(e => e.offsetParent && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow !== 'ellipsis')
        .map(e => e.textContent.trim()).filter(Boolean),
    }))()`);
    fits[page] = fit;
    expect(!fit.overflow && fit.clipped.length === 0, `${page} fits in ${locale}`, fit);
    await d.capture(`page-${page.toLowerCase().replace(" ", "-")}-${locale}`);
  }
  d.observed[`pages-${locale}`] = fits;
}

/** Movies and series in `locale`: a movie's details and its player, and a series' episodes. */
async function titles(d: Driver, locale: Locale) {
  await d.click("Open Movies", byText("header button", translate(locale, "Movies")));
  await d.click("Open All movies", byText("nav button", translate(locale, "All movies")));
  await d.click(
    "Open fixture movie details",
    "[...document.querySelectorAll('button[title]')].find(b => b.title.includes('Two sound tracks'))",
  );
  await d.wait(() => d.exists(byText('[role="dialog"] button', translate(locale, "Play"))));
  const details = await d.evaluate<string[]>(texts('[role="dialog"] button'));
  d.observed[`movie-${locale}`] = details;
  expect(details.includes(translate(locale, "Save")), `Movie details in ${locale}`, details);
  await d.capture(`movie-${locale}`);

  await d.click("Play the movie", byText('[role="dialog"] button', translate(locale, "Play")));
  await d.wait(() => d.exists("document.querySelector('[data-view=title]')"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "(() => { const v = document.querySelector('video'); return !!v && v.currentTime > 0.5; })()",
    ),
  );
  await d.evaluate(
    "document.querySelector('[data-view=title]').dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))",
  );
  const controls = await d.evaluate<string[]>(labels("[data-view=title] button[aria-label]"));
  d.observed[`title-player-${locale}`] = controls;
  for (const key of ["Back 10 seconds", "Forward 10 seconds", "Pause", "Full screen"] as const) {
    expect(
      controls.includes(translate(locale, key)),
      `Title control ${key} in ${locale}`,
      controls,
    );
  }
  await d.capture(`title-player-${locale}`);
  await d.click(
    "Open the subtitle panel",
    `document.querySelector('[data-view=title] button[aria-label=${JSON.stringify(translate(locale, "Subtitles"))}]')`,
  );
  await d.wait(() =>
    d.exists(
      `document.querySelector('aside[aria-label=${JSON.stringify(translate(locale, "Subtitle choices"))}]')`,
    ),
  );
  await d.capture(`subtitles-${locale}`);
  await d.key("Escape", 27);
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists("document.querySelector('[data-view=title]')")));
  await d.key("Escape", 27);

  await d.click("Open Series", byText("header button", translate(locale, "Series")));
  await d.click("Open All series", byText("nav button", translate(locale, "All series")));
  await d.click(
    "Open fixture series details",
    "[...document.querySelectorAll('button[title]')].find(b => b.title.includes('Formats'))",
  );
  await d.wait(() =>
    d.evaluate<boolean>(
      `[...document.querySelectorAll('[role=dialog] button')].some(b => b.textContent.trim().startsWith(${JSON.stringify(translate(locale, "Play {episode}", { episode: "" }).trim().split(" ")[0] ?? "")}))`,
    ),
  );
  d.observed[`series-${locale}`] = await d.evaluate<string[]>(texts('[role="dialog"] button'));
  await d.capture(`series-${locale}`);
  await d.key("Escape", 27);
  await d.click("Back to Home", byText("header button", translate(locale, "Home")));
}

/**
 * A movie whose file the provider doesn't have, in `locale`: its message closes with its cross,
 * named in the language, and Play stays there to try again.
 */
async function titleError(d: Driver, locale: Locale) {
  await d.click("Open Movies", byText("header button", translate(locale, "Movies")));
  await d.click("Open All movies", byText("nav button", translate(locale, "All movies")));
  await d.click(
    "Open the missing-file movie",
    "[...document.querySelectorAll('button[title]')].find(b => b.title.includes('Missing file'))",
  );
  await d.click("Play it", byText('[role="dialog"] button', translate(locale, "Play")));
  const cross = "document.querySelector('[data-view=title] [data-close-message]')";
  await d.wait(() => d.exists(cross));
  const failed = await d.evaluate<{ message: string; cross: string | null }>(`({
    message: document.querySelector('[data-view=title]')?.innerText ?? '',
    cross: ${cross}?.getAttribute('aria-label') ?? null,
  })`);
  d.observed[`titleError-${locale}`] = failed;
  expect(
    failed.cross === translate(locale, "Close message"),
    `The title's message has its cross in ${locale}`,
    failed,
  );
  await d.capture(`title-error-${locale}`);
  await d.click("Close the message with its cross", cross);
  await d.wait(async () => !(await d.exists(cross)));
  const closed = await d.evaluate<{ crosses: number; retry: string | null }>(`({
    crosses: document.querySelectorAll('[data-view=title] [data-close-message]').length,
    retry: document.querySelector('[data-view=title] [data-retry]')?.getAttribute('aria-label') ?? null,
  })`);
  d.observed[`titleErrorClosed-${locale}`] = closed;
  expect(
    closed.retry === translate(locale, "Play"),
    `Closing the title's message in ${locale} leaves Play to try again`,
    closed,
  );
  await d.capture(`title-error-closed-${locale}`);
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists("document.querySelector('[data-view=title]')")));
  await d.key("Escape", 27);
}

/**
 * Downloads in `locale`: a movie downloaded from its details, then the Downloads page, reached
 * by its name in the bar or, where the bar folds it, by the button of the same name.
 */
async function downloads(d: Driver, locale: Locale) {
  await d.click("Open Movies", byText("header button", translate(locale, "Movies")));
  await d.click("Open All movies", byText("nav button", translate(locale, "All movies")));
  await d.click(
    "Open fixture movie details",
    "[...document.querySelectorAll('button[title]')].find(b => b.title.includes('Two sound tracks'))",
  );
  await d.click(
    "Download the movie",
    byText('[role="dialog"] button', translate(locale, "Download")),
  );
  await d.wait(() =>
    d.exists(byText('[role="dialog"] button', translate(locale, "Watch offline"))),
  );
  await d.capture(`download-done-${locale}`);
  await d.key("Escape", 27);
  const name = translate(locale, "Downloads");
  await d.click(
    "Open Downloads",
    `(${byText("header button", name)} ?? document.querySelector('header button[aria-label=${JSON.stringify(name)}]'))`,
  );
  await d.wait(() =>
    d.evaluate<boolean>(`document.querySelector('h1')?.textContent === ${JSON.stringify(name)}`),
  );
  const page = await d.evaluate<{ headings: string[]; buttons: string[]; overflow: boolean }>(`({
    headings: ${texts("h1, h2")},
    buttons: ${texts("main button, [data-download] button")},
    overflow: document.documentElement.scrollWidth > innerWidth,
  })`);
  d.observed[`downloads-${locale}`] = page;
  expect(
    page.headings.includes(translate(locale, "On this computer")) &&
      page.buttons.includes(translate(locale, "Watch offline")) &&
      !page.overflow,
    `Downloads page in ${locale}`,
    page,
  );
  await d.capture(`downloads-${locale}`);
  await d.click("Back to Home", byText("header button", translate(locale, "Home")));
}

/**
 * The page at the smallest window the app allows, 960 × 600, where long labels are tightest. The
 * window has no frame of its own, so its page is the window. The page's DevTools session can't
 * resize the window, so the page's size is set instead.
 */
async function smallestWindow(d: Driver) {
  d.action("Size the page as the smallest window, 960 × 600");
  await d.send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await d.wait(() => d.evaluate<boolean>("innerWidth === 960 && innerHeight === 600"));
  d.observed["viewport"] = await d.evaluate<object>("({ width: innerWidth, height: innerHeight })");
}

function expect(condition: boolean, what: string, seen?: unknown): asserts condition {
  if (!condition)
    throw new Error(`Expected: ${what}${seen ? `, saw ${JSON.stringify(seen)}` : ""}`);
}

async function homeControls(d: Driver, locale: Locale) {
  await d.click("Open Settings for Home rows", SETTINGS);
  await d.click("Open Home settings", byText("nav button", translate(locale, "Home")));
  const section = `document.querySelector('section[aria-label="${translate(locale, "Customize Home")}"]')`;
  await d.wait(() => d.exists(section));
  const rows = await d.evaluate<string[]>(
    `[...${section}.querySelectorAll('li label')].map(e => e.textContent.trim())`,
  );
  expect(
    rows.length === 8 &&
      rows.includes(translate(locale, "Recommendations")) &&
      rows.includes(translate(locale, "Current category")),
    `Home controls in ${locale}`,
    rows,
  );
  await d.capture(`home-controls-${locale}`);
  await d.key("Escape", 27);
}
