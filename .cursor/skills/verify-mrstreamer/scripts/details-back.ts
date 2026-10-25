// `details-back`: Back through related titles' details, across two fixture providers. TEST |
// Formats (the first provider) leads to the second's drama series English 100002, given a second
// season, which leads to its Original 100004. Back in the sheet's own top bar returns to English
// 100002 on Season 2, scrolled as it was, with the keyboard on Original 100004, then to TEST |
// Formats, then to the page. Close and Escape leave a chain at once, and a title opened again
// starts over. A title played and Settings over the details keep the way back and add no step to
// it. A title the second provider stops listing opens as the sheet shows such a title, and Back
// goes on past it. Removing that provider leaves only the first's titles to return through.
// Opened by keyboard from a poster, keyboard Back returns to the related title and Escape to the
// poster, also after search opened and closed over the details. Hiding titles for adults closes an
// adult title's details, which head a chain at most. Removing the last subscription starts over.
import type { FakeTitles } from "../../../../apps/desktop/test/fake-provider.ts";
import { tmdbName } from "../../../../apps/desktop/test/fake-tmdb.ts";
import type { Driver } from "./language.ts";

/** What the scenario needs of the two fixture providers. */
export interface DetailsBackFixture {
  /** The second provider's address, for the form that adds it. */
  readonly otherUrl: string;
  /** The first provider's address, to connect again once the last subscription went. */
  readonly providerUrl: string;
  /** Requests for a title's details at each provider so far. */
  details(): { readonly first: number; readonly second: number };
  /** Whether the second provider lists English 100002, as a panel update changes. */
  listB(listed: boolean): void;
  /** Movie and episode file requests at both providers so far. */
  fileRequests(): number;
}

/** The second provider's series 80002, English 100002 to TMDB, with a second season. */
export const B_SERIES = 80_002;

/** `all` with English 100002 given a second season of one episode, for the season tabs. */
export function withSecondSeason(all: FakeTitles): FakeTitles {
  return {
    ...all,
    series: all.series.map((series) => {
      const first = series.seasons[0]?.[0];
      return series.id === B_SERIES && first
        ? { ...series, seasons: [series.seasons[0]!, [{ ...first, id: first.id + 1 }]] }
        : series;
    }),
  };
}

const A = "Origineel 90000";
const B = "English 100002";
const C = "Original 100004";

const named = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;
const SHEET = `document.querySelector('[role=dialog]')`;
/** The details' name, as the sheet is called. */
const NAME = `(() => { const id = ${SHEET}?.getAttribute('aria-labelledby'); return id ? document.getElementById(id)?.textContent ?? null : null; })()`;
const RELATED = `[...document.querySelectorAll('[role=dialog] [aria-label="Also in your subscriptions"] button')]`;
const tile = (name: string) =>
  `${RELATED}.find(b => b.textContent.includes(${JSON.stringify(name)}))`;
const BACK = named("[role=dialog] header button", "Back");
const CLOSE = `document.querySelector('[role=dialog] button[aria-label="Close"]')`;
const PLAY = `[...document.querySelectorAll('[role=dialog] button')].find(b => /^(Play|Resume)\\b/.test(b.textContent.trim()))`;
const SCROLLER = `[...document.querySelectorAll('[role=dialog] div')].find(e => getComputedStyle(e).overflowY === 'auto')`;
const season = (number: number) => named("[role=dialog] button[aria-pressed]", `Season ${number}`);
const SETTINGS_PAGE = `document.querySelector('[data-view="settings"]')`;
const ROW = (who: string) =>
  `[...document.querySelectorAll('[data-view="settings"] li')].find(r => r.querySelector('button')?.textContent.includes(${JSON.stringify(who)}))`;
/** The only subscription's row, named by its address and login. */
const ONLY = `[...document.querySelectorAll('[data-view="settings"] li')].find(r => r.querySelector('button')?.textContent.includes(' · '))`;
/** The first poster of For you's first row, beside the row's All. */
const POSTER = `[...document.querySelectorAll('section')].filter(s => s.querySelector('h2')).flatMap(s => [...s.querySelectorAll('button')]).find(b => !/^All\\b/.test(b.textContent.trim()))`;
const ADULTS = `document.querySelector('[role="checkbox"][aria-label="For adults"]')`;

const expect = (value: boolean, message: string) => {
  if (!value) throw new Error(message);
};

export async function detailsBackScenario(d: Driver, fixture: DetailsBackFixture): Promise<void> {
  const name = () => d.evaluate<string | null>(NAME);
  /** Waits for a chosen poster's fixture metadata name before using it as an expected heading. */
  const metadataName = async (poster: string) => {
    let title: string | null = null;
    await d.wait(async () => {
      title = await d.evaluate<string | null>(
        `(${poster})?.querySelector('span.truncate')?.textContent ?? null`,
      );
      const id = /^(?:Original|Origineel|English) (\d+)$/.exec(title ?? "")?.[1];
      return !!id && title === tmdbName(Number(id), "en").name;
    });
    return title!;
  };
  /** Waits for the details of `title`, with their related titles settled. */
  const showing = async (title: string) => {
    await d.wait(async () => (await name()) === title);
    await d.wait(() =>
      d.evaluate<boolean>(
        `!!${SHEET} && !${SHEET}.innerText.includes('Loading related titles') && !${SHEET}.innerText.includes('Loading…')`,
      ),
    );
  };
  const focused = () =>
    d.evaluate<string>(`(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return 'body';
      return (a.getAttribute('aria-label') || a.textContent.trim()).slice(0, 60) + (a.closest('[role=dialog]') ? ' (sheet)' : ' (page)');
    })()`);
  const pressWith = async (key: string, code: string, keyCode: number, modifiers: number) => {
    d.action(`Press ${modifiers === 4 ? "Cmd+" : modifiers === 2 ? "Ctrl+" : ""}${key}`);
    for (const type of ["rawKeyDown", "keyUp"])
      await d.send("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        modifiers,
      });
  };
  /** Presses Tab until `target` has the keyboard, saying where it went when it never does. */
  const tabTo = async (label: string, target: string) => {
    const trail: string[] = [];
    for (let presses = 0; presses < 80; presses++) {
      if (await d.evaluate<boolean>(`document.activeElement === (${target})`)) return;
      trail.push(await focused());
      await d.key("Tab", 9);
    }
    throw new Error(`Tab never reached ${label}: ${trail.join(" > ")}`);
  };
  const back = async (to: string | null) => {
    await d.click(`Back${to ? ` to ${to}` : " to the page"}`, BACK);
    if (to) await showing(to);
    else await d.wait(async () => !(await d.exists(SHEET)));
  };
  /** Settings > Subscriptions, from the bar above the details or the page's. */
  const subscriptions = async () => {
    await d.click(
      "Open Settings from the top bar",
      `(${SHEET}?.querySelector('header button[aria-label="Settings"]') ?? document.querySelector('header button[aria-label="Settings"]'))`,
    );
    await d.wait(() => d.exists(SETTINGS_PAGE));
    await d.click("Open Subscriptions", named("[data-view=settings] nav button", "Subscriptions"));
  };
  const openRow = async (who: string, row: string) => {
    for (let attempt = 1; ; attempt++) {
      await d.click(`Open ${who}'s row (attempt ${attempt})`, `(${row})?.querySelector('button')`);
      const opened = await d
        .wait(() => d.exists(`(${row})?.querySelector('[role=region]')`), 3000)
        .then(
          () => true,
          () => false,
        );
      if (opened) return;
      if (attempt === 3) throw new Error(`${who}'s row didn't open.`);
    }
  };
  const refreshBackup = async () => {
    await subscriptions();
    await openRow("Backup", ROW("Backup"));
    const refresh = `(${ROW("Backup")})?.querySelector('button[aria-label="Refresh movies and series"]')`;
    await d.click("Refresh Backup's movies and series", refresh);
    await d.wait(() => d.evaluate<boolean>(`!(${refresh})?.disabled`), 60_000);
    await leaveSettings();
  };
  const remove = async (who: string, row: string) => {
    await openRow(who, row);
    await d.click(
      `Ask to remove ${who}`,
      `[...(${row})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim().startsWith("Remove "))`,
    );
    await d.click(
      `Confirm the removal of ${who}`,
      `[...(${row})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim() === "Remove")`,
    );
  };
  const leaveSettings = async () => {
    await d.click("Back from Settings", named('[data-view="settings"] header button', "Back"));
    await d.wait(async () => !(await d.exists(SETTINGS_PAGE)));
  };
  const adults = async (shown: boolean) => {
    await d.click(
      "Open Settings from the top bar",
      `(${SHEET}?.querySelector('header button[aria-label="Settings"]') ?? document.querySelector('header button[aria-label="Settings"]'))`,
    );
    await d.click(
      "Open Movies and series",
      named("[data-view=settings] nav button", "Movies and series"),
    );
    await d.click(`${shown ? "Show" : "Hide"} titles for adults`, ADULTS);
    await d.wait(() =>
      d.evaluate<boolean>(
        `(${ADULTS})?.getAttribute('aria-checked') === ${JSON.stringify(String(shown))}`,
      ),
    );
    await leaveSettings();
  };
  const openSeries = async (label: string, provider: string, tab = "All series") => {
    await d.click("Open Series", named("header button", "Series"));
    await d.click(`Open ${tab}`, named("nav button", tab));
    await d.click(
      `Open ${label} from its poster`,
      `[...document.querySelectorAll('button[title]')].find(b => b.title.includes(${JSON.stringify(provider)}))`,
    );
  };
  const openFormats = async () => {
    await openSeries("TEST | Formats", "TEST | Formats");
    await showing(A);
  };
  /**
   * TEST | Formats, then English 100002 on Season 2 and scrolled, then Original 100004. The main
   * process keeps details it read, so only the first time asks the second provider for them.
   */
  const threeDeep = async () => {
    await openFormats();
    const before = fixture.details().second;
    await d.click(`Open related ${B}`, tile(B));
    await showing(B);
    d.observed["secondProviderDetailRequests"] ??= fixture.details().second - before;
    await d.click("Pick Season 2", season(2));
    await d.wait(() =>
      d.evaluate<boolean>(`(${season(2)})?.getAttribute('aria-pressed') === 'true'`),
    );
    await d.evaluate(`(${tile(C)}).scrollIntoView({ block: "center" })`);
    await d.wait(async () => (await d.evaluate<number>(`${SCROLLER}.scrollTop`)) > 0);
    const scroll = await d.evaluate<number>(`${SCROLLER}.scrollTop`);
    await d.click(`Open related ${C}`, tile(C));
    await showing(C);
    return scroll;
  };

  // The second provider, added through Settings as a viewer adds one.
  await d.click("Open Settings", "document.querySelector('header button[aria-pressed]')");
  await d.click("Open Subscriptions", named("nav button", "Subscriptions"));
  await d.click("Add the second fixture subscription", named("button", "Add subscription"));
  await d.wait(() => d.evaluate<boolean>("document.querySelectorAll('form input').length === 4"));
  for (const [index, text] of ["Backup", fixture.otherUrl, "demo", "demo"].entries()) {
    await d.click(
      `Fill second fixture field ${index + 1}`,
      `document.querySelectorAll('form input')[${index}]`,
    );
    await d.send("Input.insertText", { text });
  }
  await d.click("Connect the second fixture", "document.querySelector('form button[type=submit]')");
  await d.wait(() => d.exists(ROW("Backup")), 60_000);
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists(SETTINGS_PAGE)));

  // A to B to C, then Back through B and A to the page.
  const scroll = await threeDeep();
  expect(
    (d.observed["secondProviderDetailRequests"] as number) > 0,
    `${B}'s details never reached the second provider.`,
  );
  await d.capture("c-from-b");
  await back(B);
  const atB = await d.evaluate<{ season: boolean; scroll: number; focus: boolean }>(`({
    season: (${season(2)})?.getAttribute('aria-pressed') === 'true',
    scroll: ${SCROLLER}.scrollTop,
    focus: document.activeElement === (${tile(C)}),
  })`);
  d.observed["backToB"] = { ...atB, scrollBefore: scroll };
  await d.capture("back-to-b");
  expect(atB.season, `Back to ${B} lost Season 2.`);
  expect(
    Math.abs(atB.scroll - scroll) <= 1,
    `Back to ${B} scrolled to ${atB.scroll}, not ${scroll}.`,
  );
  expect(atB.focus, `Back to ${B} left the keyboard on ${await focused()}.`);
  await back(A);
  const atA = await d.evaluate<boolean>(`document.activeElement === (${tile(B)})`);
  d.observed["backToAFocusOnB"] = atA;
  expect(atA, `Back to ${A} left the keyboard on ${await focused()}.`);
  await d.capture("back-to-a");
  await back(null);
  await d.capture("back-to-page");

  // Close leaves the chain at once; a title opened again starts over, and Escape leaves too.
  await threeDeep();
  await d.click("Close the details", CLOSE);
  await d.wait(async () => !(await d.exists(SHEET)));
  await openFormats();
  await back(null);
  d.observed["newChainAfterClose"] = "Back from the reopened title went to the page";
  await openFormats();
  await d.click(`Open related ${B}`, tile(B));
  await showing(B);
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists(SHEET)));
  d.observed["escapeLeavesChain"] = true;

  // A title played over the details, and Settings, keep the way back and add no step to it.
  await threeDeep();
  const files = fixture.fileRequests();
  await d.click(`Play ${C}`, PLAY);
  await d.wait(() => d.exists(`document.querySelector('[data-view=title]')`));
  await d.wait(async () => fixture.fileRequests() > files);
  await d.capture("playing-c");
  await d.key("Escape", 27);
  await showing(C);
  await subscriptions();
  await leaveSettings();
  await showing(C);
  await back(B);
  await back(A);
  await back(null);
  d.observed["playedAndSettingsKeepTheWay"] = { fileRequests: fixture.fileRequests() - files };

  // The second provider stops listing English 100002: Back shows what the sheet shows of a
  // title the lists don't have, and goes on past it.
  await threeDeep();
  fixture.listB(false);
  await refreshBackup();
  await showing(C);
  await d.click(`Back to the delisted ${B}`, BACK);
  await d.wait(async () => (await name()) !== C);
  await d.wait(() => d.evaluate<boolean>(`!${SHEET}?.innerText.includes('Loading…')`), 30_000);
  d.observed["delisted"] = await d.evaluate(
    `({ name: ${NAME}, text: ${SHEET}?.innerText.replace(/\\s+/g, ' ').slice(0, 300) ?? null })`,
  );
  await d.capture("back-to-delisted");
  await back(A);
  await back(null);
  fixture.listB(true);
  await refreshBackup();

  // Removing the second provider: Back passes over its title to the first's.
  await openFormats();
  await d.click(`Open related ${B}`, tile(B));
  await showing(B);
  await d.click(`Open related ${A} from ${B}`, tile(A));
  await showing(A);
  await subscriptions();
  await remove("Backup", ROW("Backup"));
  await d.wait(async () => !(await d.exists(ROW("Backup"))), 30_000);
  await leaveSettings();
  await showing(A);
  await back(A);
  await back(null);
  d.observed["removedProviderPassedOver"] = true;
  await d.capture("after-provider-removal");

  // Opened by keyboard from a poster: keyboard Back returns to the related title, and Escape
  // to the poster, also after search opened and closed over the details.
  await d.click("Open Movies", named("header button", "Movies"));
  await d.click("Open For you", named("nav button", "For you"));
  await d.wait(() => d.exists(POSTER));
  const first = await metadataName(POSTER);
  await tabTo("For you's first poster", POSTER);
  await d.key("Enter", 13);
  await showing(first);
  await d.wait(() => d.evaluate<boolean>(`${RELATED}.length > 0`));
  const second = await metadataName(`${RELATED}[0]`);
  const related = `${RELATED}.find(b => b.querySelector('span.truncate')?.textContent === ${JSON.stringify(second)})`;
  await tabTo("the first related title", related);
  await d.key("Enter", 13);
  await showing(second);
  await tabTo("Back above the details", BACK);
  await d.key("Enter", 13);
  await showing(first);
  const keyboardBack = await d.evaluate<{ focus: boolean; visible: boolean }>(`({
    focus: document.activeElement === (${related}),
    visible: document.activeElement?.matches(':focus-visible') ?? false,
  })`);
  d.observed["keyboardBack"] = { ...keyboardBack, first, second };
  await d.capture("keyboard-back");
  expect(keyboardBack.focus, `Keyboard Back left the keyboard on ${await focused()}.`);
  await d.key("Enter", 13);
  await showing(second);
  await pressWith("k", "KeyK", 75, process.platform === "darwin" ? 4 : 2);
  await d.wait(() => d.evaluate<boolean>(`!!document.querySelector('[role=dialog] input')`));
  await d.key("Escape", 27);
  await d.wait(() => d.evaluate<boolean>(`!document.querySelector('[role=dialog] input')`));
  await d.wait(async () => (await focused()).endsWith("(sheet)"));
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists(SHEET)));
  const returned = await d.evaluate<{ poster: boolean; visible: boolean }>(`({
    poster: document.activeElement === (${POSTER}),
    visible: document.activeElement?.matches(':focus-visible') ?? false,
  })`);
  d.observed["escapeReturnsKeyboard"] = { ...returned, to: await focused() };
  await d.capture("escape-to-poster");
  expect(returned.poster, `Escape left the keyboard on ${await focused()}, not the poster.`);

  // Titles for adults list no related titles and are none, so After Dark only ever heads a
  // chain. Its details close once Settings, opened from the bar above them, hides such titles.
  await adults(true);
  await openSeries("After Dark", "After Dark", "Adults");
  await d.wait(async () => (await name()) !== null);
  const adult = (await name())!;
  await showing(adult);
  const relatedToAdult = await d.evaluate<number>(`${RELATED}.length`);
  await d.capture("adult-details");
  await adults(false);
  await d.wait(async () => !(await d.exists(SHEET)), 10_000);
  d.observed["adultsHidden"] = { opened: adult, relatedToAdult, sheetAfter: await d.exists(SHEET) };
  await d.capture("adults-hidden");

  // The last subscription goes: Connect, and a title opened after connecting again starts over.
  await subscriptions();
  await remove("the last subscription", ONLY);
  await d.wait(
    () => d.evaluate<boolean>("document.querySelectorAll('form input').length >= 3"),
    30_000,
  );
  await d.capture("connect-after-reset");
  for (const [index, value] of [fixture.providerUrl, "demo", "demo"].entries()) {
    await d.click(
      `Fill Connect field ${index + 1} again`,
      `document.querySelectorAll('form input')[${index}]`,
    );
    await d.send("Input.insertText", { text: value });
  }
  await d.click("Connect again", "document.querySelector('form button[type=submit]')");
  await d.wait(
    () =>
      d.evaluate<boolean>(
        "!!document.querySelector('header') && !document.body.innerText.includes('Loading channels')",
      ),
    60_000,
  );
  await openFormats();
  await back(null);
  d.observed["afterResetBackGoesToPage"] = true;
  await d.capture("after-reset");
}
