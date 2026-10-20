// TV B through the built window, including the shared Watch picker and retained viewing state.
import type { FakeProvider } from "../../../../apps/desktop/test/fake-provider.ts";
import { LANGUAGE_NAMES, type Locale } from "../../../../packages/contracts/src/language.ts";
import { translate } from "../../../../packages/core/src/i18n.ts";
import type { Driver } from "./language.ts";

export const LONG_CATEGORY =
  "TEST | Formats and failures with a deliberately long provider category label";

/** Explicit language facts for the real menu path, alongside a catalogue mostly lacking them. */
export function browseFixtureLanguages(
  categories: FakeProvider["catalogue"]["categories"],
): FakeProvider["catalogue"]["categories"] {
  return categories.map((category) => ({
    ...category,
    name: category.name
      .replace(/^BE \| Sports$/, "BE - FR | Sports")
      .replace(/^UK \| Sports$/, "UK - EN | Sports"),
  }));
}

const named = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;
const PICKER = `(document.querySelector('[data-view=watch] [role=navigation][aria-label="Channel categories"]') ?? document.querySelector('[role=navigation][aria-label="Channel categories"]'))`;
const row = (title: string) => `${PICKER}?.querySelector('button[title=${JSON.stringify(title)}]')`;
const expect = (value: boolean, message: string) => {
  if (!value) throw new Error(message);
};

export async function liveCategoriesScenario(
  d: Driver,
  fixture: {
    otherUrl: string;
    streams(): { requests: number; active: number };
    refresh(kind: "reorder" | "remove"): void;
  },
) {
  await d.click("Open Settings", "document.querySelector('header button[aria-pressed]')");
  await d.click("Open Subscriptions", named("nav button", "Subscriptions"));
  await d.click("Add second fixture subscription", named("button", "Add subscription"));
  await d.wait(() => d.evaluate<boolean>("document.querySelectorAll('form input').length === 4"));
  for (const [index, text] of ["Backup", fixture.otherUrl, "demo", "demo"].entries()) {
    await d.click(
      `Fill second fixture field ${index + 1}`,
      `document.querySelectorAll('form input')[${index}]`,
    );
    await d.send("Input.insertText", { text });
  }
  await d.click("Connect second fixture", "document.querySelector('form button[type=submit]')");
  await d.wait(() =>
    d.evaluate<boolean>(
      "[...document.querySelectorAll('li')].some(row => row.innerText.includes('Backup'))",
    ),
  );
  await d.key("Escape", 27);
  await d.click("Open Live TV", named("header button", "Live TV"));
  await d.wait(() => d.exists(PICKER));
  const root = await d.evaluate<{ titles: string[]; all: string }>(
    `(() => ({ titles: [...${PICKER}.querySelectorAll('[data-entry]')].map(e => e.title), all: ${PICKER}.querySelector('[title="All channels"]').textContent }))()`,
  );
  expect(
    root.titles.includes("Favourites") &&
      root.titles.includes("Recently watched") &&
      root.titles.includes("Sports") &&
      root.titles.includes("Regional") &&
      root.titles.includes("Provider lists"),
    "Shortcuts and fixed topics missing",
  );
  expect(
    Number(root.all.replace(/[^0-9]/g, "")) >= 63000,
    "Large catalogue has fewer than 63,000 channels",
  );
  d.observed["root"] = root;
  await d.capture("categories-root-wide");
  await d.click("Open Sports topic", row("Sports"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelector('main h1')?.textContent === 'Sports' && !!document.querySelector('[data-index]')",
    ),
  );
  await d.click("Open country filter", "document.querySelector('[data-browse-filter=countries]')");
  await d.click(
    "Choose Belgium in Sports",
    "[...document.querySelectorAll('[role=menu] button')].find(e=>e.textContent.startsWith('Belgium'))",
  );
  await d.key("Escape", 27);
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelector('[data-browse-filter=countries]')?.textContent.includes('Belgium') ?? false",
    ),
  );
  await d.click(
    "Open explicit Language filter",
    "document.querySelector('[data-browse-filter=languages]')",
  );
  await d.click(
    "Choose French in Sports",
    "[...document.querySelectorAll('[role=menu] button')].find(e=>e.textContent.startsWith('French'))",
  );
  await d.key("Escape", 27);
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelector('[data-browse-filter=languages]')?.textContent.includes('French') ?? false",
    ),
  );
  d.observed["topicFilters"] = await d.evaluate<string>(
    "document.querySelector('[aria-label=\"Channel filters\"]').innerText",
  );
  await d.capture("browse-sports-belgium-list");
  await d.click("Sports guide grid", named("button", "Guide"));
  await d.wait(() => d.exists("document.querySelector('[role=grid]')"));
  await d.capture("browse-sports-belgium-grid");
  await d.click("Return to list", named("button", "List"));
  await d.click("Open Home with filtered Sports", named("header button", "Home"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "[...document.querySelectorAll('h2')].some(e=>e.textContent.includes('Sports'))",
    ),
  );
  await d.capture("browse-filtered-sports-home");
  await d.click(
    "Browse Home's exact Sports descriptor",
    "[...document.querySelectorAll('h2')].find(e=>e.textContent.includes('Sports'))?.parentElement.querySelector('button')",
  );
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelector('main h1')?.textContent === 'Sports' && document.querySelector('[data-browse-filter=countries]')?.textContent.includes('Belgium') && document.querySelector('[data-browse-filter=languages]')?.textContent.includes('French')",
    ),
  );
  await d.quit();
  await d.launch();
  await d.wait(() => d.exists("document.querySelector('header')"));
  await d.click("Open restored topic", named("header button", "Live TV"));
  await d.wait(() =>
    d.evaluate<boolean>("document.querySelector('main h1')?.textContent === 'Sports'"),
  );
  expect(
    await d.evaluate<boolean>(
      "document.querySelector('[data-browse-filter=countries]')?.textContent.includes('Any') ?? false",
    ),
    "Session filters survived startup",
  );
  expect(
    await d.evaluate<boolean>(
      "document.querySelector('[data-browse-filter=languages]')?.textContent.includes('Any') ?? false",
    ),
    "Language filter survived startup",
  );
  await d.capture("browse-topic-restored");
  await d.click("Choose All channels", row("All channels"));
  await d.wait(() =>
    d.evaluate<boolean>("document.querySelector('main h1')?.textContent === 'All channels'"),
  );
  await d.quit();
  await d.launch();
  await d.wait(() => d.exists("document.querySelector('header')"));
  await d.click("All remains All after restart", named("header button", "Live TV"));
  await d.wait(() =>
    d.evaluate<boolean>("document.querySelector('main h1')?.textContent === 'All channels'"),
  );
  await d.capture("browse-all-restored");
  await d.click("Open Provider lists", row("Provider lists"));
  await d.click("Open Belgium", row("Belgium"));
  await d.wait(() => d.exists(`${PICKER}.querySelector('button[aria-label="Back to countries"]')`));
  const country = await d.evaluate<string[]>(
    `[...${PICKER}.querySelectorAll('[data-entry]')].map(e => e.title)`,
  );
  expect(
    country.length > 1 && !country.includes("Belgium") && !country.includes("All channels"),
    "Country expanded inline",
  );
  d.observed["belgium"] = country;
  await d.capture("categories-belgium");
  await d.key("ArrowLeft", 37);
  await d.wait(() => d.evaluate<boolean>("document.activeElement?.title === 'Belgium'"));
  d.observed["countryReturnFocus"] = "Belgium";

  const find = `${PICKER}.querySelector("input")`;
  await d.click("Find sports categories", find);
  await d.send("Input.insertText", { text: "sports" });
  await d.wait(() => d.evaluate<boolean>(`${PICKER}.querySelectorAll('[data-entry]').length > 1`));
  d.observed["sportsResults"] = await d.evaluate<string[]>(
    `[...${PICKER}.querySelectorAll('[data-entry]')].map(e => e.title)`,
  );
  await d.capture("categories-search");
  await d.key("Escape", 27);
  await d.click("Find no matching categories", find);
  await d.send("Input.insertText", { text: "xyzzy" });
  await d.wait(() => d.evaluate<boolean>(`${PICKER}.textContent.includes('No categories match.')`));
  await d.capture("categories-no-match");
  await d.key("Escape", 27);
  await d.click("Find the playable fixture category", find);
  await d.send("Input.insertText", { text: "formats" });
  await d.wait(() =>
    d.evaluate<boolean>(`${PICKER}.querySelectorAll('[data-entry]').length === 2`),
  );
  await d.key("ArrowDown", 40);
  await d.key("Enter", 13);
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelector('main h1')?.textContent.includes('Formats') ?? false",
    ),
  );
  await d.click(
    "Star the first fixture channel",
    'document.querySelector(\'[data-index="0"] button[aria-label="Add to favourites"]\')',
  );
  const channelSearch = "document.querySelector('main input')";
  await d.click("Search channels within the chosen category", channelSearch);
  await d.send("Input.insertText", { text: "H.264 + AAC" });
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelectorAll('[data-index]').length >= 1 && document.querySelectorAll('[data-index]').length <= 2",
    ),
  );
  await d.key("ArrowDown", 40);
  if (await d.exists("document.querySelector('button[aria-label=\"Show copies\"]')")) {
    await d.key("ArrowRight", 39);
    await d.key("ArrowDown", 40);
  }
  await d.key("ArrowRight", 39);
  await d.wait(() =>
    d.evaluate<boolean>("!!document.querySelector('button[aria-label=\"Hide later programmes\"]')"),
  );
  d.observed["guideAndChannelSearch"] = await d.evaluate<string>(
    "document.querySelector('main')?.innerText",
  );
  await d.capture("categories-selected-guide");
  await d.key("ArrowLeft", 37);
  await d.click(
    "Filter exact native list to primary source",
    "document.querySelector('[data-browse-filter=subscriptions]')",
  );
  await d.click(
    "Choose primary source",
    "[...document.querySelectorAll('[role=menu] button')].find(e=>!e.textContent.startsWith('Any') && !e.textContent.startsWith('Backup'))",
  );
  await d.key("Escape", 27);
  await d.click("Return keyboard to channel search", channelSearch);
  await d.key("ArrowDown", 40);
  await d.key("Enter", 13);
  const picture = () =>
    d.evaluate<{ time: number; width: number; audio: number }>(
      "(() => { const v=document.querySelector('[data-view=watch] video'); return { time:v?.currentTime ?? 0, width:v?.videoWidth ?? 0, audio:v?.webkitAudioDecodedByteCount ?? 0 }; })()",
    );
  await d.wait(async () => {
    const v = await picture();
    return v.time > 1 && v.width > 0 && v.audio > 0;
  });
  const before = await picture();
  await d.wait(async () => (await picture()).time > before.time + 0.5);
  d.observed["playback"] = await picture();
  expect(fixture.streams().active === 1, "Playback did not own exactly one provider connection");
  await d.capture("categories-playback");
  await d.key("Enter", 13);
  await d.key("ArrowLeft", 37);
  await d.wait(() => d.exists(PICKER));
  expect(
    await d.evaluate<boolean>(
      "document.querySelector('[data-view=watch] [aria-label=\"Channel filters\"]')?.textContent.includes('Source') ?? false",
    ),
    "Watch hid active source filter",
  );
  await d.capture("categories-watch-picker");
  await d.click(
    "Reset Watch filters",
    "[...document.querySelectorAll('[data-view=watch] button')].find(e=>e.textContent === 'Reset filters')",
  );
  await d.click("Watch picker Find", find);
  await d.send("Input.insertText", { text: "belgium" });
  await d.key("ArrowDown", 40);
  await d.key("Enter", 13);
  await d.wait(() =>
    d.evaluate<boolean>(
      "[...document.querySelectorAll('[data-view=watch] header')].some(header => header.textContent.includes('Entertainment'))",
    ),
  );
  expect(fixture.streams().active === 1, "Browsing categories opened another stream");
  await d.key("Escape", 27);
  await d.key("Escape", 27);
  await d.click("Return to Live TV", named("header button", "Live TV"));
  await d.click(
    "Return to countries",
    `${PICKER}.querySelector('button[aria-label="Back to countries"]')`,
  );
  await d.click(
    "Return to topics",
    `${PICKER}.querySelector('button[aria-label="Back to topics"]')`,
  );
  await d.click("Open Favourites", row("Favourites"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelector('main')?.textContent.includes('H.264 + AAC') ?? false",
    ),
  );
  await d.capture("categories-favourites");
  await d.click("Open Recently watched", row("Recently watched"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelector('main')?.textContent.includes('H.264 + AAC') ?? false",
    ),
  );
  await d.click("Provider lists for refresh", row("Provider lists"));
  await d.click("Reopen Belgium", row("Belgium"));
  let first = await d.evaluate<string>(`${PICKER}.querySelector('[data-entry]').title`);
  await d.click("Select a saved category", row(first));
  const refresh = async (kind: "reorder" | "remove") => {
    fixture.refresh(kind);
    await d.click(
      `Open Settings to ${kind} the fixture categories`,
      "document.querySelector('header button[aria-pressed]')",
    );
    await d.click("Subscriptions for catalogue refresh", named("nav button", "Subscriptions"));
    for (let index = 0; index < 2; index++) {
      const item = `document.querySelectorAll('main section > ul > li')[${index}]`;
      const before = await d.evaluate<string>(`${item}.innerText`);
      if (!(await d.exists(`${item}.querySelector('button[aria-label="Refresh channels"]')`)))
        await d.click(`Open subscription ${index + 1}`, `${item}.querySelector('button')`);
      const stamp = await d.evaluate<number>(
        `(async () => { const result=await window.mrStreamer.invoke('library.status'); return result.ok ? result.value[${index}].fetchedAt : 0; })()`,
      );
      await d.click(
        `Refresh subscription ${index + 1}`,
        `${item}.querySelector('button[aria-label="Refresh channels"]')`,
      );
      await d.wait(() =>
        d.evaluate<boolean>(
          `(async () => { const result=await window.mrStreamer.invoke('library.status'); return result.ok && result.value[${index}].fetchedAt > ${stamp}; })()`,
        ),
      );
      expect(before.length > 0, "Subscription row absent during refresh");
    }
    await d.key("Escape", 27);
  };
  await refresh("reorder");
  await d.wait(() =>
    d.evaluate<boolean>(
      `${PICKER}.querySelector('[aria-current=true]')?.title === ${JSON.stringify(first)}`,
    ),
  );
  d.observed["selectionAfterReorderedRefresh"] = first;
  await refresh("remove");
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelector('main h1')?.textContent === 'All channels' && document.querySelector('[role=navigation] [role=status]')?.textContent.includes('is no longer listed')",
    ),
  );
  d.observed["removedCategoryFallback"] = await d.evaluate<string>(
    "document.querySelector('[role=navigation] [role=status]').textContent",
  );
  await d.capture("categories-removed-refresh");
  await d.click("Provider lists after removed category", row("Provider lists"));
  await d.click("Reopen Belgium after refresh", row("Belgium"));
  first = await d.evaluate<string>(`${PICKER}.querySelector('[data-entry]').title`);
  await d.click("Save another category after removal", row(first));
  await d.quit();
  await d.launch();
  await d.wait(() => d.exists("document.querySelector('header')"));
  await d.click("Open remembered Live TV category", named("header button", "Live TV"));
  await d.wait(() => d.exists(`${PICKER}.querySelector('button[aria-label="Back to countries"]')`));
  expect(
    await d.evaluate<boolean>(
      `${PICKER}.querySelector('[aria-current=true]')?.title === ${JSON.stringify(first)}`,
    ),
    "Saved category was not restored inside its country",
  );
  d.observed["restartCategory"] = first;
  await d.capture("categories-restart");
  const retained = await d.evaluate<{ favourites: number; recent: number }>(
    `(async () => { const result=await window.mrStreamer.invoke('viewing.get'); if (!result.ok) throw new Error('Viewing read failed'); return { favourites: result.value.favourites.length, recent: result.value.recent.length }; })()`,
  );
  expect(
    retained.favourites === 1 && retained.recent === 1,
    "Favourites/history were lost on restart",
  );
  d.observed["restartViewingCounts"] = retained;

  await d.click(
    "Show all countries before narrow checks",
    `${PICKER}.querySelector('button[aria-label="Back to countries"]')`,
  );
  // The page CDP session supports viewport emulation, not native window bounds.
  d.action("Size the page to the supported minimum window, 960 × 600");
  await d.send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await d.wait(() => d.evaluate<boolean>("innerWidth === 960 && innerHeight === 600"));
  for (const locale of [
    "en-US",
    "nl-NL",
    "fr-FR",
    "de-DE",
    "es-ES",
  ] as const satisfies readonly Locale[]) {
    await d.click(
      "Open Settings for category locale",
      "document.querySelector('header button[aria-pressed]')",
    );
    const select = "document.querySelector('select:has(option[value=\"en-US\"])')";
    await d.wait(() => d.exists(select));
    await d.click("Focus interface language", select);
    for (const char of LANGUAGE_NAMES[locale].slice(0, 2)) {
      await d.send("Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char });
      await d.send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
    }
    await d.key("Enter", 13);
    await d.wait(() =>
      d.evaluate<boolean>(`document.documentElement.lang === ${JSON.stringify(locale)}`),
    );
    await d.key("Escape", 27);
    await d.wait(() =>
      d.exists(
        `document.querySelector('input[aria-label=${JSON.stringify(translate(locale, "Find a category"))}]')`,
      ),
    );
    const geometry = await d.evaluate<{ width: number; overflow: boolean; find: string }>(
      `(() => { const p=document.querySelector('[role=navigation][aria-label=${JSON.stringify(translate(locale, "Channel categories"))}]'); return { width: innerWidth, overflow: p.scrollWidth > p.clientWidth, find: p.querySelector('input').placeholder }; })()`,
    );
    expect(
      !geometry.overflow && geometry.find === translate(locale, "Find"),
      `Category layout overflow or wrong language ${locale}`,
    );
    d.observed[`narrow-${locale}`] = geometry;
    await d.capture(`categories-narrow-${locale}`);
  }
  await d.click(
    "Return to English for source-removal checks",
    "document.querySelector('header button[aria-pressed]')",
  );
  const language = "document.querySelector('select:has(option[value=\"en-US\"])')";
  await d.click("Interface language", language);
  for (const char of "En") {
    await d.send("Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char });
    await d.send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
  }
  await d.key("Enter", 13);
  await d.wait(() => d.evaluate<boolean>("document.documentElement.lang === 'en-US'"));
  await d.key("Escape", 27);
  await d.click(
    "Return to topic rail",
    `${PICKER}.querySelector('button[aria-label="Back to topics"]')`,
  );
  await d.click("Remember News before removing added source", row("News"));
  const removeSource = async (index: number, remaining: number) => {
    await d.click(
      "Settings for source removal",
      "document.querySelector('header button[aria-pressed]')",
    );
    await d.click("Subscriptions for source removal", named("nav button", "Subscriptions"));
    const item = `document.querySelectorAll('main section > ul > li')[${index}]`;
    if (!(await d.exists(`${item}.querySelector('[role=region]')`)))
      await d.click("Expand source to remove", `${item}.querySelector('button')`);
    await d.click(
      "Ask to remove source",
      `[...${item}.querySelectorAll('button')].find(e=>e.textContent.startsWith('Remove '))`,
    );
    await d.click(
      "Confirm removal without erasing viewing",
      `[...${item}.querySelectorAll('button')].find(e=>e.textContent === 'Remove')`,
    );
    await d.wait(() =>
      d.evaluate<boolean>(
        `(async()=>{const r=await window.mrStreamer.invoke('subscription.list');return r.ok && r.value.length === ${remaining};})()`,
      ),
    );
    await d.key("Escape", 27);
  };
  await removeSource(1, 1);
  await d.quit();
  await d.launch();
  await d.wait(() => d.exists("document.querySelector('header')"));
  await d.click("News survives added source removal", named("header button", "Live TV"));
  await d.wait(() =>
    d.evaluate<boolean>("document.querySelector('main h1')?.textContent === 'News'"),
  );
  await d.capture("browse-added-source-removed");
  await d.click(
    "Add replacement second source",
    "document.querySelector('header button[aria-pressed]')",
  );
  await d.click("Replacement source subscriptions", named("nav button", "Subscriptions"));
  await d.click("Add subscription", named("button", "Add subscription"));
  await d.wait(() => d.evaluate<boolean>("document.querySelectorAll('form input').length === 4"));
  for (const [index, text] of ["Backup", fixture.otherUrl, "demo", "demo"].entries()) {
    await d.click(
      `Replacement source field ${index}`,
      `document.querySelectorAll('form input')[${index}]`,
    );
    await d.send("Input.insertText", { text });
  }
  await d.click("Connect replacement source", "document.querySelector('form button[type=submit]')");
  await d.wait(() =>
    d.evaluate<boolean>("document.querySelectorAll('main section > ul > li').length === 2"),
  );
  await d.key("Escape", 27);
  await removeSource(0, 1);
  await d.quit();
  await d.launch();
  await d.wait(() => d.exists("document.querySelector('header')"));
  await d.click("News survives original source removal", named("header button", "Live TV"));
  await d.wait(() =>
    d.evaluate<boolean>("document.querySelector('main h1')?.textContent === 'News'"),
  );
  d.observed["rememberedAfterBothRemovalPaths"] = await d.evaluate<unknown>(
    "(async()=>{const r=await window.mrStreamer.invoke('liveBrowse.get');return r.ok?r.value:null;})()",
  );
  await d.capture("browse-original-source-removed");
}
