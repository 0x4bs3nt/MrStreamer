// Settings A acceptance through the real built window. Writes are pointer/keyboard only.
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  LANGUAGE_NAMES,
  LOCALES,
  type Locale,
} from "../../../../packages/contracts/src/language.ts";
import type { Preferences } from "../../../../packages/contracts/src/preferences.ts";
import { translate, type PlainKey } from "../../../../packages/core/src/i18n.ts";
import type { Driver } from "./language.ts";

const button = (selector: string, label: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(label)})`;
const shown = (selector: string) => `document.querySelector('main:not([hidden]) ${selector}')`;
const expect = (value: boolean, message: string) => {
  if (!value) throw new Error(message);
};

export async function settingsScenario(d: Driver): Promise<void> {
  let locale: Locale = "en-US";
  const nav = async (label: PlainKey) =>
    d.click(`Open ${label}`, button("nav button", translate(locale, label)));
  const settings = async () => {
    await d.click("Open Settings", "document.querySelector('header button[aria-label=Settings]')");
    await d.wait(() => d.exists("document.querySelector('[data-view=settings]')"));
  };
  const saved = () =>
    d.evaluate<Preferences>(
      `(async () => { const r = await window.mrStreamer.invoke('preferences.get'); if (!r.ok) throw new Error('Cannot read preferences'); return r.value.preferences; })()`,
    );
  const type = async (field: string, value: string) => {
    await d.click(`Type into ${value ? "setting" : "search"}`, field);
    const modifiers = process.platform === "darwin" ? 4 : 2;
    await d.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      windowsVirtualKeyCode: 65,
      modifiers,
      commands: ["selectAll"],
    });
    await d.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      windowsVirtualKeyCode: 65,
      modifiers,
    });
    await d.send("Input.insertText", { text: value });
  };
  const search = `document.querySelector('nav input[type=search]')`;
  const find = async (query: string, destination: string) => {
    await type(search, query);
    await d.key("Enter", 13);
    await d.wait(() =>
      d.evaluate<boolean>(
        `document.activeElement?.closest('[data-setting]')?.getAttribute('data-setting') === ${JSON.stringify(destination)}`,
      ),
    );
  };
  const size = async (width: number, height: number) => {
    await d.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await d.wait(() => d.evaluate<boolean>(`innerWidth === ${width} && innerHeight === ${height}`));
  };
  // Native select type-ahead commits on macOS too, where CDP ArrowDown does not commit a choice.
  const choose = async (field: string, name: string) => {
    await d.wait(() => d.exists(field));
    await d.evaluate(`${field}.focus()`);
    for (const char of name.slice(0, 2)) {
      await d.send("Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char });
      await d.send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
    }
    await d.wait(() =>
      d.evaluate<boolean>(
        `${field}?.getAttribute('aria-busy') !== 'true' && ${field}?.closest('fieldset')?.getAttribute('aria-busy') !== 'true'`,
      ),
    );
    expect(
      await d.evaluate<boolean>(`document.activeElement === ${field}`),
      "Select save lost keyboard focus",
    );
  };

  await size(960, 600);
  await settings();
  await nav("Live TV");
  const quality = shown('select[aria-label="Quality"]');
  d.action("Focus quality before keyboard save");
  await choose(quality, "HD");
  await d.wait(async () => (await saved()).liveQuality === "hd");
  expect(
    await d.evaluate<boolean>(`document.activeElement === ${quality}`),
    "Quality save lost keyboard focus",
  );
  await d.capture("quality-saved-focused");
  await d.key("Tab", 9);
  expect(
    await d.evaluate<boolean>(
      "document.activeElement?.closest('[data-setting]')?.getAttribute('data-setting') === 'own-quality'",
    ),
    "Tab after quality save lost its row order",
  );
  await d.key("Escape", 27);
  await d.wait(() => d.evaluate<boolean>("!document.querySelector('[data-view=settings]')"));
  expect(
    await d.evaluate<boolean>("document.activeElement?.getAttribute('aria-label') === 'Settings'"),
    "Closing Settings did not restore its opener",
  );
  await settings();
  d.observed["qualityKeyboardSave"] = {
    saved: "hd",
    focusRetained: true,
    tabTo: "own-quality",
    escapeRestoredOpener: true,
  };
  const order = [
    "General",
    "Playback",
    "Live TV",
    "Movies and series",
    "Subtitles",
    "Home",
    "Subscriptions",
    "Guides",
    "Updates",
    "Privacy",
    "About",
  ] as const;
  const rail = await d.evaluate<string[]>(
    "[...document.querySelectorAll('nav button')].map(e => e.textContent.trim())",
  );
  expect(rail.join() === order.join(), "Incorrect Settings section order");
  d.observed["sectionOrder"] = rail;
  for (const section of order) {
    await nav(section);
    await d.wait(() => d.evaluate<boolean>("!!document.querySelector('main:not([hidden])')"));
    await d.capture(`section-${section.toLowerCase().replaceAll(" ", "-")}`);
  }
  await d.click("Open licences", shown("[data-setting=licences]"));
  await d.wait(() => d.exists("document.querySelector('[aria-label=\"Search the licences\"]')"));
  await d.key("Escape", 27);
  await d.wait(() =>
    d.evaluate<boolean>("!!document.querySelector('main:not([hidden]) [data-setting=licences]')"),
  );
  await d.capture("licences-return-about");

  // Local translated labels and synonyms all reach one actual focused delay control.
  const synonyms = {
    "en-US": "countdown",
    "nl-NL": "aftellen",
    "fr-FR": "compte à rebours",
    "de-DE": "Sekunden",
    "es-ES": "cuenta atras",
  };
  const searches: unknown[] = [];
  for (const next of LOCALES) {
    await nav("General");
    if (locale !== next) {
      await choose(shown('select:has(option[value="en-US"])'), LANGUAGE_NAMES[next]);
      await d.key("Tab", 9);
      await d.wait(() =>
        d.evaluate<boolean>(`document.documentElement.lang === ${JSON.stringify(next)}`),
      );
      locale = next;
    }
    await find(synonyms[next], "delay");
    searches.push({
      locale,
      synonym: synonyms[next],
      focused: await d.evaluate("document.activeElement.getAttribute('aria-label')"),
    });
    await d.capture(`search-${locale}`);
    await find(translate(locale, "Interface language"), "interface-language");
  }
  d.observed["translatedSearch"] = searches;
  await choose(shown('select:has(option[value="en-US"])'), LANGUAGE_NAMES["en-US"]);
  await d.key("Tab", 9);
  await d.wait(() => d.evaluate<boolean>("document.documentElement.lang === 'en-US'"));
  locale = "en-US";
  await type(search, "zzzz-setting-missing");
  await d.wait(() => d.evaluate<boolean>("document.body.innerText.includes('No settings found')"));
  await d.capture("search-no-results");
  await d.click("Clear local search", button("nav button", "Clear search"));
  expect(
    await d.evaluate<boolean>(`${search}.value === '' && document.activeElement === ${search}`),
    "No-result recovery lost the search focus",
  );

  await find("countdown", "delay");
  const delay = shown('input[aria-label="Next episode delay"]');
  await type(delay, "37");
  await d.key("Enter", 13);
  await d.wait(async () => (await saved()).nextEpisodeDelaySeconds === 37);
  expect(
    await d.evaluate<boolean>(`document.activeElement === ${delay}`),
    "Delay Enter lost focus",
  );
  await type(delay, "19");
  await d.key("Escape", 27);
  expect(
    await d.evaluate<boolean>(
      `${delay}.value === '37' && !!document.querySelector('[data-view=settings]')`,
    ),
    "Delay Escape failed to cancel its draft inside Settings",
  );
  await d.click("Focus exact seconds", delay);
  await d.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "ArrowUp",
    windowsVirtualKeyCode: 38,
    modifiers: 8,
  });
  await d.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "ArrowUp",
    windowsVirtualKeyCode: 38,
    modifiers: 8,
  });
  await d.key("Enter", 13);
  await d.wait(async () => (await saved()).nextEpisodeDelaySeconds === 42);
  await type(delay, "999");
  await d.key("Enter", 13);
  await d.wait(async () => (await saved()).nextEpisodeDelaySeconds === 60);
  expect(
    await d.evaluate<boolean>(`document.activeElement === ${delay}`),
    "Clamped delay Enter lost focus",
  );
  await d.capture("delay-clamped-60");

  // An actual rename failure on this run's disposable profile. No IPC setter is injected.
  expect(
    basename(d.profile).startsWith("mrstreamer-verify-"),
    "Persistence failure requires an owned verification profile",
  );
  const path = join(d.profile, "preferences.json");
  const backup = join(d.profile, "settings-test-preferences.backup");
  const original = await readFile(path, "utf8");
  await rename(path, backup);
  let restored = false;
  try {
    await mkdir(path);
    d.action("Block preference replacement with a directory at the owned profile file path");
    await type(delay, "29");
    await d.key("Enter", 13);
    await d.wait(() => d.exists("document.querySelector('main:not([hidden]) [role=alert]')"));
    expect(
      await d.evaluate<boolean>(`${delay}.value === '60'`),
      "Failed delay claimed an unsaved value",
    );
    expect(
      (await saved()).nextEpisodeDelaySeconds === 60,
      "Failed save changed acknowledged preferences",
    );
    await d.capture("delay-persistence-failure");
    expect(
      await d.evaluate<boolean>(`document.activeElement === ${delay}`),
      "Delay refusal lost focus",
    );
    await nav("Movies and series");
    await d.click("Edit key for persistence refusal", shown("[data-setting=tmdb] button"));
    const refusedKey = shown('input[aria-label="Your own TMDB key"]');
    await type(refusedKey, "settings-refused-test-key");
    await d.key("Enter", 13);
    await d.wait(() => d.exists("document.querySelector('main:not([hidden]) [role=alert]')"));
    expect(
      await d.evaluate<boolean>(
        `document.activeElement === ${refusedKey} && ${refusedKey}.value === 'settings-refused-test-key'`,
      ),
      "TMDB refusal lost focus or the credential draft",
    );
    await d.capture("tmdb-refused-focused");
    d.observed["tmdbRefusalFocus"] = { focusRetained: true, draftRetained: true };
    await d.key("Escape", 27);
    await nav("Live TV");
    await choose(quality, "SD");
    await d.wait(() => d.exists("document.querySelector('main:not([hidden]) [role=alert]')"));
    expect(
      await d.evaluate<boolean>(
        `${quality}.value === 'hd' && document.activeElement === ${quality}`,
      ),
      "Select refusal lost focus or claimed an unsaved value",
    );
    await d.capture("quality-refused-focused");
    await d.key("Tab", 9);
    expect(
      await d.evaluate<boolean>("document.activeElement?.textContent.trim() === 'Try again'"),
      "Tab after refused quality missed Retry",
    );
    await d.key("Enter", 13);
    await d.wait(() => d.exists("document.querySelector('main:not([hidden]) [role=alert]')"));
    expect(
      await d.evaluate<boolean>(`document.activeElement === ${quality}`),
      "Failed retry lost the quality position",
    );
    await rm(path, { recursive: true });
    await rename(backup, path);
    restored = true;
    expect((await readFile(path, "utf8")) === original, "Failed save damaged the previous file");
    await d.key("Tab", 9);
    await d.key("Enter", 13);
    await d.wait(async () => (await saved()).liveQuality === "sd");
    expect(
      await d.evaluate<boolean>(`document.activeElement === ${quality}`),
      "Successful retry lost the quality position",
    );
    await d.capture("quality-retry-saved-focused");
    await nav("Playback");
    await d.evaluate(`${delay}.focus()`);
    await d.key("Tab", 9);
    expect(
      await d.evaluate<boolean>("document.activeElement?.textContent.trim() === 'Try again'"),
      "Tab after delay Enter missed its Retry",
    );
    await d.key("Enter", 13);
    await d.wait(async () => (await saved()).nextEpisodeDelaySeconds === 29);
    await d.wait(() =>
      d.evaluate<boolean>(`${delay}.value === '29' && document.activeElement === ${delay}`),
    );
    await d.capture("delay-row-retry-saved");
  } finally {
    if (!restored) {
      await rm(path, { recursive: true, force: true });
      await rename(backup, path);
    }
  }
  d.observed["persistenceFailure"] = {
    boundary: "actual rename to directory in owned profile",
    savedBefore: 60,
    refused: 29,
    retrySaved: 29,
    oldFileIntact: true,
    select: {
      before: "hd",
      refused: "sd",
      retried: "sd",
      focusRetained: true,
      keyboardRetry: true,
    },
    delayFocusRetained: true,
  };

  await nav("Movies and series");
  await d.click("Edit own TMDB key", shown("[data-setting=tmdb] button"));
  const key = shown('input[aria-label="Your own TMDB key"]');
  await type(key, "independent-unsaved-draft");
  await nav("Subtitles");
  await choose(shown("select[aria-label=Size]"), "Large");
  await d.key("Tab", 9);
  await d.wait(async () => (await saved()).subtitleLook?.size === "large");
  await nav("Movies and series");
  expect(
    await d.evaluate<boolean>(`${key}.value === 'independent-unsaved-draft'`),
    "Section navigation lost a draft",
  );
  await d.click("Return to the TMDB draft", key);
  await d.key("Escape", 27);
  await nav("Subtitles");
  await d.evaluate("document.querySelector('main:not([hidden])').scrollTop = 180");
  const scroll = await d.evaluate<number>("document.querySelector('main:not([hidden])').scrollTop");
  await nav("Privacy");
  await nav("Subtitles");
  d.observed["sectionScroll"] = {
    before: scroll,
    after: await d.evaluate("document.querySelector('main:not([hidden])').scrollTop"),
  };
  expect(
    (await d.evaluate<number>("document.querySelector('main:not([hidden])').scrollTop")) === scroll,
    "Section navigation lost its scroll position",
  );
  await size(1440, 900);
  await d.capture("subtitles-wide");
  await size(960, 600);
  await d.evaluate("document.documentElement.style.fontSize = '21px'");
  await nav("Privacy");
  await d.capture("privacy-text-scale");
  expect(
    await d.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth"),
    "Text scaling overflows the window",
  );
  await d.evaluate("document.documentElement.style.fontSize = ''");
  await d.quit();
  await d.launch();
  await settings();
  await nav("Playback");
  expect(
    (await saved()).nextEpisodeDelaySeconds === 29 &&
      (await saved()).subtitleLook?.size === "large",
    "Settings choices did not survive restart",
  );
  await d.capture("settings-restart");
  // The retained title-player opener must reach Online search while the video keeps playing.
  await d.key("Escape", 27);
  await d.click("Open Movies", button("header button", "Movies"));
  await d.click("Open All movies", button("nav button", "All movies"));
  await d.click(
    "Open two-track movie",
    "[...document.querySelectorAll('button[title]')].find(e => e.title.includes('Two sound tracks'))",
  );
  await d.click("Play movie", button('[role="dialog"] button', "Play"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "!!document.querySelector('[data-view=title]') && document.querySelector('video').currentTime > 0.5",
    ),
  );
  await d.evaluate(
    "document.querySelector('[data-view=title]').dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))",
  );
  await d.click(
    "Open title subtitles",
    "document.querySelector('[data-view=title] button[aria-label=Subtitles]')",
  );
  const beforeTime = await d.evaluate<number>("document.querySelector('video').currentTime");
  await d.click("Open online subtitle Settings from CC", button("button", "Settings"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.activeElement?.getAttribute('aria-label') === 'Online subtitle search'",
    ),
  );
  await d.wait(() =>
    d.evaluate<boolean>(`document.querySelector('video').currentTime > ${beforeTime + 0.2}`),
  );
  d.observed["onlineSubtitleIntent"] = {
    focused: "Online subtitle search",
    videoBefore: beforeTime,
    videoAfter: await d.evaluate("document.querySelector('video').currentTime"),
  };
  await d.capture("online-subtitles-intent-over-playing-title");
  await nav("General");
  await d.key("Escape", 27);
  await d.wait(() =>
    d.evaluate<boolean>(
      "!document.querySelector('[data-view=settings]') && !!document.querySelector('[data-view=title]')",
    ),
  );
  expect(
    await d.evaluate<boolean>("document.activeElement?.matches('[data-view=title]')"),
    "Closing Settings after its opener disappeared lost player focus",
  );
  await d.capture("return-to-playing-title");
}
