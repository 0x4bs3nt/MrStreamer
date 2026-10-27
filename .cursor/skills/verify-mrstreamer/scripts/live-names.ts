// Live TV's row names through the built window, with a second fake provider that lists the same
// channels under the same names and one name too long for its cell. Each row's name owns its
// first line and the line under it starts with the subscription that tells the two copies apart,
// at the unchanged row height. A clipped name shows in full on hover, not a short one, and while
// the keys select its row; Escape then still leaves Live TV. The same rows again at 960 × 600,
// and the playing dot beside the cut name once that channel plays.
import { addBackup } from "./custom-lists.ts";
import type { Driver } from "./language.ts";

/** The H.264 test channel's name in both fixtures, too long for the list's name column. */
const LONG_NAME = "TEST | H.264 + AAC with a name far too long for the list's name column";
const LONG_TITLE = LONG_NAME.slice("TEST | ".length);

/** Renames the H.264 test channel in a fixture to `LONG_NAME`. */
export function longNamed<C extends { readonly name: string }>(channel: C): C {
  return channel.name === "TEST | H.264 + AAC" ? { ...channel, name: LONG_NAME } : channel;
}

const check = (value: boolean, message: string, seen?: unknown) => {
  if (!value) throw new Error(`${message}${seen === undefined ? "" : `: ${JSON.stringify(seen)}`}`);
};
const ROWS = "[...document.querySelectorAll('main [data-index]')]";
/** Each drawn row: its names, metadata, height in rem and which lines are cut. */
const ROW_STATE = `${ROWS}.sort((a, b) => a.dataset.index - b.dataset.index).map(r => {
  const name = r.querySelector('[data-name]');
  const line = name?.parentElement.nextElementSibling ?? null;
  const cut = e => !!e && e.scrollWidth > e.clientWidth;
  return { name: name?.dataset.name ?? '', title: name?.textContent ?? '', line: line?.textContent ?? '',
    height: (r.querySelector('[role=button]')?.getBoundingClientRect().height ?? 0)
      / parseFloat(getComputedStyle(document.documentElement).fontSize),
    nameClipped: cut(name), clipped: cut(name) || cut(line), selected: !!r.querySelector('.ring-2') };
})`;
/** The label under a row's name that holds `text`. */
const label = (text: string) =>
  `[...document.querySelectorAll('[data-side=bottom]')].find(e => e.textContent.includes(${JSON.stringify(text)}))`;
const nameOf = (title: string) =>
  `[...document.querySelectorAll('main [data-name]')].find(e => e.textContent === ${JSON.stringify(title)})`;

interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface Row {
  name: string;
  title: string;
  line: string;
  height: number;
  nameClipped: boolean;
  clipped: boolean;
  selected: boolean;
}

export async function liveNamesScenario(d: Driver, fixture: { otherUrl: string }) {
  await addBackup(d, fixture.otherUrl);
  await d.click(
    "Open Live TV",
    "[...document.querySelectorAll('header button')].find(b => b.textContent.trim() === 'Live TV')",
  );
  await d.click(
    "Open Provider lists",
    "[...document.querySelectorAll('[role=navigation] button')].find(b => b.title === 'Provider lists')",
  );
  await d.click(
    "Open the TEST category",
    "[...document.querySelectorAll('[role=navigation] button')].find(b => b.textContent.trim().startsWith('TEST | Formats and failures'))",
  );
  const rows = () => d.evaluate<Row[]>(ROW_STATE);
  await d.wait(async () => (await rows()).filter((row) => row.name === LONG_NAME).length === 2);
  const browse = await rows();
  d.observed["browse"] = browse;
  const long = browse.filter((row) => row.name === LONG_NAME);
  const sources = long.map((row) => row.line.split(" · ")[0]);
  check(
    long.every((row) => row.title === LONG_TITLE && row.nameClipped),
    "The long name isn't cut short in its cell",
    long,
  );
  check(
    new Set(sources).size === 2 && sources.every(Boolean),
    "The two copies' lines don't lead with their own subscription",
    sources,
  );
  check(
    browse.every((row) => row.height === 3.5),
    "A row isn't 3.5rem high",
    browse.map((row) => row.height),
  );
  await d.capture("names-browse");

  // Hover: the clipped name shows in full under its cell, a short one shows nothing.
  const pointAt = async (title: string) => {
    const box = await d.evaluate<{ x: number; y: number }>(
      `(() => { const b = ${nameOf(title)}.getBoundingClientRect(); return { x: b.x + 20, y: b.y + b.height / 2 }; })()`,
    );
    d.action(`Point at ${title}`);
    await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...box });
  };
  await pointAt(LONG_TITLE);
  await d.wait(() => d.exists(label(LONG_TITLE)), 5_000);
  d.observed["hoverLabel"] = await d.evaluate<string>(`${label(LONG_TITLE)}.innerText`);
  check(
    d.observed["hoverLabel"] === `${LONG_TITLE}\n${long[0]!.line}`,
    "The label doesn't show the full displayed name and its metadata",
    d.observed["hoverLabel"],
  );
  await d.capture("names-hover-long");
  const short = browse.find((row) => !row.clipped && row.name !== LONG_NAME);
  check(short !== undefined, "No row fits its cell");
  await pointAt(short!.title);
  await d.evaluate("new Promise(resolve => setTimeout(() => resolve(true), 1000))");
  const shortLabel = await d.exists(label(short!.title));
  d.observed["hoverShort"] = { title: short!.title, label: shortLabel };
  check(!shortLabel, "A name that fits showed a label");
  d.action("Move the pointer off the list");
  await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 590 });
  await d.wait(async () => !(await d.exists(label(LONG_TITLE))), 5_000);

  // The keys: Down to the long row holds its label up; Escape still leaves Live TV.
  for (let step = 0; step < 30; step++) {
    const drawn = await rows();
    const at = drawn.findIndex((row) => row.selected);
    if (drawn[at]?.name === LONG_NAME) break;
    // The first key only shows the selection; then toward the long rows.
    const up = at > drawn.findIndex((row) => row.name === LONG_NAME);
    await (up ? d.key("ArrowUp", 38) : d.key("ArrowDown", 40));
    await d.evaluate("new Promise(resolve => requestAnimationFrame(() => resolve(true)))");
  }
  const selected = (await rows()).find((row) => row.selected);
  d.observed["keyboardSelected"] = selected;
  check(selected?.name === LONG_NAME, "Down didn't reach the long row", selected);
  await d.wait(() => d.exists(label(LONG_TITLE)), 5_000);
  await d.capture("names-keyboard-long");
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists("document.querySelector('main [data-name]')")));
  check(!(await d.exists(label(LONG_TITLE))), "The label outlived the list");
  d.observed["escapeLeftLiveTv"] = true;

  // The narrowest window keeps both lines in the same cell and row.
  d.action("Size the page as the smallest window, 960 × 600");
  await d.send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await d.wait(() => d.evaluate<boolean>("innerWidth === 960 && innerHeight === 600"));
  await d.click(
    "Open Live TV",
    "[...document.querySelectorAll('header button')].find(b => b.textContent.trim() === 'Live TV')",
  );
  await d.wait(async () => (await rows()).some((row) => row.name === LONG_NAME));
  const narrow = await rows();
  d.observed["narrow"] = narrow;
  check(
    narrow.every((row) => row.height === 3.5),
    "A narrow row isn't 3.5rem high",
    narrow.map((row) => row.height),
  );
  const narrowLong = narrow.filter((row) => row.name === LONG_NAME);
  check(
    narrowLong.length === 2 &&
      narrowLong.every((row) => row.line.trim() && row.nameClipped) &&
      narrowLong
        .map((row) => row.line)
        .sort()
        .join("\n") ===
        long
          .map((row) => row.line)
          .sort()
          .join("\n"),
    "The narrow long rows lost their clipped names or distinct metadata",
    narrowLong,
  );
  const narrowLayout = await d.evaluate<
    {
      name: Bounds;
      cell: Bounds;
      row: Bounds;
      line: (Bounds & { visible: boolean; clipped: boolean; contained: boolean }) | null;
    }[]
  >(`${ROWS}.filter(r => r.querySelector('[data-name]')?.dataset.name === ${JSON.stringify(LONG_NAME)})
    .map(r => {
      const name = r.querySelector('[data-name]');
      const cell = name.parentElement.parentElement;
      const line = name.parentElement.nextElementSibling;
      const style = line && getComputedStyle(line);
      return { name: name.getBoundingClientRect().toJSON(), cell: cell.getBoundingClientRect().toJSON(),
        row: r.querySelector('[role=button]').getBoundingClientRect().toJSON(),
        line: line && { ...line.getBoundingClientRect().toJSON(), visible: line.checkVisibility(),
          clipped: line.scrollWidth > line.clientWidth,
          contained: ['hidden', 'clip'].includes(style.overflowX) && style.whiteSpace === 'nowrap'
            && style.textOverflow === 'ellipsis' } };
    })`);
  d.observed["narrowLayout"] = narrowLayout;
  check(
    narrowLayout.length === 2 &&
      narrowLayout.every(
        ({ name, cell, row, line }) =>
          line !== null &&
          line.visible &&
          line.bottom > line.top &&
          line.right > line.left &&
          line.top >= name.bottom - 1 &&
          line.bottom <= row.bottom + 1 &&
          line.left >= cell.left - 1 &&
          line.right <= cell.right + 1 &&
          line.contained,
      ),
    "The narrow metadata isn't visible below its name and contained in its cell and row",
    narrowLayout,
  );
  await d.capture("names-narrow");

  // Back from watching the long channel, its row keeps the playing dot beside the cut name.
  await d.click("Watch the long channel", nameOf(LONG_TITLE));
  await d.wait(() => d.exists("document.querySelector('[data-view=watch]')"));
  await d.evaluate("new Promise(resolve => setTimeout(() => resolve(true), 1000))");
  check(!(await d.exists(label(LONG_TITLE))), "The label shows over Watch");
  await d.capture("names-watch");
  await d.click(
    "Back to Live TV",
    "[...document.querySelectorAll('header button')].findLast(b => b.textContent.trim() === 'Back')",
  );
  const dot = `${nameOf(LONG_TITLE)}?.nextElementSibling`;
  await d.wait(() => d.exists(dot));
  const playing = await d.evaluate<{ name: Bounds; dot: Bounds; cell: Bounds; gap: number }>(
    `(() => { const n = ${nameOf(LONG_TITLE)};
      return { name: n.getBoundingClientRect().toJSON(), dot: ${dot}.getBoundingClientRect().toJSON(),
        cell: n.parentElement.parentElement.getBoundingClientRect().toJSON(),
        gap: parseFloat(getComputedStyle(n.parentElement).columnGap) }; })()`,
  );
  d.observed["playingDot"] = playing;
  check(playing.dot.right <= playing.cell.right, "The playing dot left the name's cell", playing);
  check(
    Math.abs(playing.dot.left - playing.name.right - playing.gap) <= 1 &&
      Math.abs(
        (playing.dot.top + playing.dot.bottom) / 2 - (playing.name.top + playing.name.bottom) / 2,
      ) <= 1,
    "The playing dot isn't beside the name on its first line",
    playing,
  );
  await d.capture("names-playing");
}
