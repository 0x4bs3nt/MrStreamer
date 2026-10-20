import type { Driver } from "./language.ts";

const byText = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
const controls = "document.querySelector('section[aria-label=\"Customize Home\"]')";
const check = (name: string) =>
  `${byText("section[aria-label] li label", name)}?.querySelector('input')`;
const move = (name: string, direction: string) =>
  `document.querySelector('button[aria-label="Move ${name} ${direction}"]')`;

/** Personal Home through real pointer/key input; IPC is read-only evidence. */
export async function homeScenario(d: Driver, counts: () => Record<string, number>): Promise<void> {
  const customize = async () => {
    await d.click(
      "Open Settings",
      "document.querySelector('header button[aria-label=\"Settings\"]')",
    );
    await d.click("Open Home settings", byText("nav button", "Home"));
    await d.wait(() => d.exists(controls));
  };
  const closeSettings = async () => {
    await d.click(
      "Return from Home settings",
      "[...document.querySelectorAll('header button')].findLast(b => b.textContent.trim() === 'Back')",
    );
    await d.wait(async () => !(await d.exists(controls)));
  };
  const prefs = () =>
    d.evaluate<{ id: string; visible: boolean }[]>(`(async () => {
    const read = await window.mrStreamer.invoke('preferences.get');
    return read.ok ? read.value.preferences.homeRows ?? [] : [];
  })()`);
  const titles = () =>
    d.evaluate<string[]>(
      "[...document.querySelectorAll('[data-home-row] h2')].map(h => h.textContent)",
    );
  const expect = (ok: boolean, message: string) => {
    if (!ok) throw new Error(message);
  };
  await d.wait(() =>
    d.evaluate<boolean>("document.querySelectorAll('[data-home-row] button').length > 0"),
  );
  expect(
    !(await titles()).includes("Recommendations"),
    "No history showed personalized recommendations",
  );
  expect(
    await d.exists(byText("header button", "Watchlist")),
    "Watchlist missing from top navigation",
  );
  await d.capture("home-no-history");
  await d.click("Open empty Watchlist from Home", byText("header button", "Watchlist"));
  await d.wait(() => d.exists(byText("h1", "Watchlist")));
  await d.wait(() => d.evaluate<boolean>("document.body.innerText.includes('Nothing saved yet')"));
  await d.capture("watchlist-empty");
  await d.click("Return Home", byText("header button", "Home"));
  await customize();
  await d.wait(() => d.exists(controls));
  expect(
    (await d.evaluate<number>(`${controls}.querySelectorAll('li').length`)) === 8,
    "Empty rows unavailable to edit",
  );
  await d.click("Move Continue watching down with pointer", move("Continue watching", "down"));
  await d.wait(async () => (await prefs())[0]?.id === "recommendations");
  await d.wait(() =>
    d.evaluate<boolean>(
      `${move("Continue watching", "up")}.getAttribute('aria-disabled') === 'false'`,
    ),
  );
  await d.evaluate(`${move("Continue watching", "up")}.focus()`);
  await d.key("Enter", 13);
  await d.wait(async () => (await prefs())[0]?.id === "continue");
  expect(
    (await d.evaluate<string>("document.activeElement?.getAttribute('aria-label')")) ===
      "Move Continue watching up",
    "Keyboard move lost focus",
  );
  await d.wait(() => d.evaluate<boolean>(`!${check("Watchlist")}.disabled`));
  await d.click("Hide empty Watchlist row", check("Watchlist"));
  await d.wait(
    async () => (await prefs()).find((row) => row.id === "watchlist")?.visible === false,
  );
  await d.wait(() =>
    d.evaluate<boolean>(`${move("Watchlist", "up")}.getAttribute('aria-disabled') === 'false'`),
  );
  await d.evaluate(`${move("Watchlist", "up")}.focus()`);
  await d.key("Enter", 13);
  await d.wait(async () => (await prefs())[1]?.id === "watchlist");
  const afterHiddenMove = await prefs();
  expect(afterHiddenMove[1]?.visible === false, "Moving Watchlist restored its hidden row");
  await d.wait(() => d.evaluate<boolean>(`!${check("New movies")}.disabled`));
  await d.evaluate(`${check("New movies")}.focus()`);
  await d.key(" ", 32);
  await d.wait(
    async () => (await prefs()).find((row) => row.id === "new-movies")?.visible === false,
  );
  const kept = await prefs();
  await d.capture("customize-hidden-reordered");
  await d.quit();
  await d.launch();
  await d.wait(() => d.exists(byText("header button", "Home")));
  expect(JSON.stringify(await prefs()) === JSON.stringify(kept), "Home changes lost after restart");
  const afterRestart = await prefs();
  expect(
    afterRestart[1]?.id === "watchlist" && afterRestart[1].visible === false,
    "Hidden reordered Watchlist returned after restart",
  );
  expect(!(await titles()).includes("New movies"), "Hidden row returned after restart");
  await d.click(
    "Open full Watchlist while its row is hidden",
    byText("header button", "Watchlist"),
  );
  await d.wait(() => d.exists(byText("h1", "Watchlist")));
  await d.capture("watchlist-hidden-row-restart");
  await d.click("Return Home", byText("header button", "Home"));
  await customize();
  await d.click("Reset all rows", byText("button", "Reset to defaults"));
  await d.wait(
    async () =>
      (await prefs()).map((row) => row.id).join() ===
        "continue,recommendations,watchlist,favourites,recent,new-movies,new-series,category" &&
      (await prefs()).every((row) => row.visible),
  );
  await d.capture("customize-reset");
  await closeSettings();
  await d.click("Open Movies", byText("header button", "Movies"));
  await d.click("Open All movies", byText("nav button", "All movies"));
  const movie =
    "[...document.querySelectorAll('button[title]')].find(b => b.title.includes('Index at the end'))";
  await d.click("Open fixture movie", movie);
  await d.click("Save fixture movie", byText('[role="dialog"] button', "Save"));
  await d.wait(() => d.exists(byText('[role="dialog"] button', "Saved")));
  await d.click(
    "Play a short fixture to establish real local viewing",
    "[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim().startsWith('Play'))",
  );
  await d.wait(() => d.evaluate<boolean>("!!document.querySelector('video')?.videoWidth"));
  await d.capture("movie-playing-local-seed");
  await d.wait(() =>
    d.evaluate<boolean>(`(async () => {
    const read = await window.mrStreamer.invoke('viewing.get');
    return read.ok && read.value.recentTitles?.some(p => p.finished);
  })()`),
  );
  await d.key("Escape", 27);
  await d.key("Escape", 27);
  await d.click("Return Home for local recommendations", byText("header button", "Home"));
  await d.wait(() => d.exists(byText("h2", "Recommendations")));
  const recs = await d.evaluate<string[]>(
    "[...document.querySelectorAll('[data-home-row=recommendations] [data-home-title], [data-home-row=recommendations] button:not([data-slot])')].filter(b => !b.closest('[data-home-title]') || b.matches('[data-home-title]')).map(b => b.innerText)",
  );
  expect(
    recs.length > 0 && recs.every((line) => line.includes("Because you watched")),
    "Actual seed reasons missing",
  );
  await d.capture("home-local-recommendations-watchlist");
  await customize();
  await d.click("Hide populated Watchlist row", check("Watchlist"));
  await d.wait(() => d.evaluate<boolean>("!document.querySelector('[data-home-row=watchlist]')"));
  await closeSettings();
  await d.click("Open full saved Watchlist while hidden", byText("header button", "Watchlist"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "!![...document.querySelectorAll('button[title]')].find(b => b.title.includes('Index at the end'))",
    ),
  );
  await d.capture("full-watchlist-hidden-populated");
  await d.click("Return Home", byText("header button", "Home"));
  const seeds = await d.evaluate<unknown[]>(`(async () => {
    const read = await window.mrStreamer.invoke('viewing.get');
    return read.ok ? read.value.recentTitles.map(({ title }) => ({
      kind: title.kind === 'movie' ? 'movie' : 'series',
      version: { subscriptionId: title.subscriptionId, id: title.kind === 'movie' ? title.id : title.seriesId },
    })) : [];
  })()`);
  const before = counts();
  const timing = await d.evaluate<{ ms: number; count: number }>(`(async () => {
    const start = performance.now();
    const read = await window.mrStreamer.invoke('ondemand.recommendations', { seeds: ${JSON.stringify(seeds)} });
    if (!read.ok) throw new Error('Recommendation read failed');
    return { ms: performance.now() - start, count: read.value.length };
  })()`);
  expect(
    JSON.stringify(counts()) === JSON.stringify(before),
    "Recommendation read fetched content",
  );
  await d.quit();
  await d.launch();
  await d.wait(() => d.exists(byText("h2", "Recommendations")));
  await d.capture("recommendations-restart");
  await d.click("Open Series for next useful episode", byText("header button", "Series"));
  await d.click("Open All series", byText("nav button", "All series"));
  await d.click(
    "Open fixture series",
    "[...document.querySelectorAll('button[title]')].find(b => b.title.includes('TEST | Formats'))",
  );
  await d.click(
    "Open first episode actions",
    "document.querySelector('[aria-label=\"More for S1 E1\"]')",
  );
  await d.click("Mark first episode watched", byText('[role="menuitem"]', "Mark watched"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "[...document.querySelectorAll('[role=dialog] button')].some(b => b.textContent.trim() === 'Play S1 E2')",
    ),
  );
  await d.key("Escape", 27);
  await d.click("Return Home for next episode", byText("header button", "Home"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelector('[data-home-row=continue]')?.innerText.includes('S1 E2')",
    ),
  );
  await d.capture("home-next-useful-episode");
  await d.click(
    "Play Home next episode",
    "document.querySelector('[data-home-row=continue] button')",
  );
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelector('[data-view=title]') && document.querySelector('video')?.videoWidth > 0 && document.querySelector('video').currentTime > 0.5",
    ),
  );
  await d.capture("home-next-episode-playing");
  await d.key("Escape", 27);
  await d.click(
    "Open Settings for adult safety",
    "document.querySelector('button[aria-label=\"Settings\"]')",
  );
  await d.click("Open Movies and series settings", byText("nav button", "Movies and series"));
  await d.click(
    "Enable adult titles",
    "document.querySelector('[role=checkbox][aria-label=\"For adults\"]')",
  );
  await d.wait(() =>
    d.evaluate<boolean>(
      "(async () => { const p = await window.mrStreamer.invoke('preferences.get'); return p.ok && p.value.preferences.adultTitles === true; })()",
    ),
  );
  await d.key("Escape", 27);
  await d.click("Open Series adult collection", byText("header button", "Series"));
  await d.click("Open Adults", byText("nav button", "Adults"));
  await d.click(
    "Open adult fixture series",
    "[...document.querySelectorAll('button[title]')].find(b => b.title.includes('After Dark'))",
  );
  // The initial series toolbar moves when its episodes arrive. Wait for those controls and
  // capture the painted details before choosing Save with pointer coordinates.
  await d.wait(() =>
    d.exists("document.querySelector('[role=dialog] [aria-label=\"More for S1 E1\"]')"),
  );
  await d.capture("adult-series-details-before-save");
  await d.click("Save adult series", byText('[role="dialog"] button', "Save"));
  await d.wait(() => d.exists(byText('[role="dialog"] button', "Saved")));
  const adultName = await d.evaluate<string>(`(async () => {
    const read = await window.mrStreamer.invoke('watchlist.list', { sort: 'saved', offset: 0, limit: 100 });
    const entry = read.ok && read.value.entries.find(e => e.title?.adult);
    if (!entry) throw new Error('Adult title was not saved');
    return entry.title.title;
  })()`);
  await d.key("Escape", 27);
  await d.click("Return Home with adult titles enabled", byText("header button", "Home"));
  await customize();
  await d.click("Show Watchlist row", check("Watchlist"));
  await d.wait(() => d.exists("document.querySelector('[data-home-row=watchlist]')"));
  await closeSettings();
  expect(
    !(await d.evaluate<boolean>(`document.body.innerText.includes(${JSON.stringify(adultName)})`)),
    "Adult save exposed on Home",
  );
  await d.capture("home-adult-setting-safe");
  await d.click("Full Watchlist retains adult setting", byText("header button", "Watchlist"));
  await d.wait(() =>
    d.evaluate<boolean>(`document.body.innerText.includes(${JSON.stringify(adultName)})`),
  );
  await d.capture("full-watchlist-adult-setting");
  await d.click("Return Home at end", byText("header button", "Home"));
  d.observed["home"] = {
    nextUsefulEpisode: true,
    adultSettingSafe: true,
    noHistory: true,
    emptyRowsEditable: true,
    keyboardFocus: true,
    hiddenFullWatchlist: true,
    hiddenAfterMove: afterHiddenMove,
    hiddenAfterRestart: afterRestart,
    restartPreferences: kept,
    reset: true,
    recommendations: recs,
    timing,
    requestCounts: before,
    noRecommendationRequests: true,
  };
}
