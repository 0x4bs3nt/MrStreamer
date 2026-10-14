// Live TV's guide grid through the built window, on the real clock: Guide beside Watch opens it,
// the keys move between programmes and channels and open a programme's details, an aired
// programme on a channel without catch-up only watches live, and one on "TEST | H.264 + AAC",
// which keeps three days, plays from the panel's archive with Enter. Watch live watches, Escape
// goes back to the list, the grid is still the view after a restart, and it fits 1280 and 900 px. `guideGridScrollScenario` scrolls a catalogue of
// 20,000 channels and a guide of two days, in the list and then in the grid, and records frames.
import type { ArchiveRequest } from "../../../../apps/desktop/test/fake-provider.ts";
import type { Driver } from "./language.ts";

const GRID = "document.querySelector('[role=grid]')";
const DETAILS = "document.querySelector('[role=grid] [role=region]')";
const SELECTED = "document.querySelector('[role=grid] [role=gridcell][aria-selected=true]')";
/** A programme's cell, not a stretch without guide. */
const PROGRAMME = '[role=gridcell]:not([aria-label^="No programme information"])';
const named = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;
const expect = (value: boolean, message: string, seen?: unknown) => {
  if (!value) throw new Error(`${message}${seen === undefined ? "" : `: ${JSON.stringify(seen)}`}`);
};

/** What the grid shows: its rows, programmes, stretches without any, and the cursor's details. */
const gridState = (d: Driver) =>
  d.evaluate<{
    rows: string[];
    programmes: number;
    gaps: number;
    nowLine: boolean;
    selected: string | null;
    details: string | null;
    overflow: boolean;
  }>(`(() => {
    const grid = ${GRID};
    return {
      rows: [...grid.querySelectorAll('[role=rowheader]')].map(e => e.title),
      programmes: grid.querySelectorAll(${JSON.stringify(PROGRAMME)}).length,
      gaps: grid.querySelectorAll('[role=gridcell][aria-label^="No programme information"]').length,
      nowLine: !!grid.querySelector('.bg-white.w-px'),
      selected: ${SELECTED}?.getAttribute('aria-label') ?? null,
      details: ${DETAILS}?.innerText ?? null,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  })()`);

const picture = (d: Driver) =>
  d.evaluate<{ time: number; width: number; audio: number; watching: boolean; title: string }>(
    `(() => { const v = document.querySelector('video');
      return { time: v?.currentTime ?? 0, width: v?.videoWidth ?? 0,
        audio: v?.webkitAudioDecodedByteCount ?? 0,
        watching: !!document.querySelector('[data-view=watch]'),
        title: document.querySelector('[data-view=watch]')?.innerText.slice(0, 300) ?? '' }; })()`,
  );

/** What the fake panel was asked for, for the scenario's checks. */
interface GridFixture {
  streams(): { requests: number; active: number };
  archiveRequests(): readonly ArchiveRequest[];
}

export async function guideGridScenario(d: Driver, fixture: GridFixture) {
  // A channel plays first, so Live TV has its preview strip with Watch, mute and Guide.
  await d.click("Open global Search", "document.querySelector('button[aria-label=Search]')");
  d.action("Search TEST | H.264 + AAC");
  await d.send("Input.insertText", { text: "TEST | H.264 + AAC" });
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelector('[aria-label=\"Search results\"] [aria-selected=true]')?.textContent.includes('H.264 + AAC') ?? false",
    ),
  );
  await d.key("Enter", 13);
  await d.wait(async () => {
    const v = await picture(d);
    return v.watching && v.time >= 1 && v.width > 0;
  });
  await d.key("Escape", 27);
  await d.click("Open Live TV", named("header button", "Live TV"));
  const guideButton = named("main section button", "Guide");
  await d.wait(() => d.exists(guideButton));
  d.observed["stripButtons"] = await d.evaluate<string[]>(
    "[...document.querySelector('main section').querySelectorAll('button')].map(b => b.textContent.trim() || b.getAttribute('aria-label'))",
  );
  await d.capture("live-list-1280");

  await d.click("Open the guide grid from the strip", guideButton);
  await d.wait(() => d.exists(GRID));
  await d.wait(async () => (await gridState(d)).programmes > 10);
  const opened = await gridState(d);
  expect(opened.nowLine, "No now line");
  expect(opened.gaps > 0, "No stretch without guide drawn");
  expect(
    opened.rows[0]?.includes("H.264 + AAC") ?? false,
    "Grid doesn't start on the list's first channel",
    opened.rows,
  );
  expect(!opened.overflow, "The page overflows at 1280 px");
  d.observed["gridOpened"] = opened;
  expect(
    (await d.exists(named("main section button", "List"))) && !(await d.exists(guideButton)),
    "The strip's switch doesn't read List in the grid",
  );
  await d.capture("grid-1280");

  // The keys: down to a channel without catch-up, two programmes on, then back into the past.
  await d.key("ArrowDown", 40);
  await d.key("ArrowRight", 39);
  await d.key("ArrowRight", 39);
  await d.wait(() => d.exists(DETAILS));
  const moved = await gridState(d);
  expect(
    moved.details?.includes("Watch live") === true && moved.selected !== null,
    "Details didn't open on the programme with the cursor",
    moved,
  );
  d.observed["afterArrows"] = moved;
  // The keys gave the grid the focus, and it names the cell with the cursor as its active one.
  const focus = await d.evaluate<{ focused: boolean; active: string | null; selected: boolean }>(
    `(() => { const grid = ${GRID}; const cell = document.getElementById(grid.getAttribute('aria-activedescendant'));
      return { focused: document.activeElement === grid, active: cell?.getAttribute('aria-label') ?? null,
        selected: cell?.getAttribute('aria-selected') === 'true' }; })()`,
  );
  d.observed["gridFocus"] = focus;
  expect(
    focus.focused && focus.selected && moved.selected === focus.active,
    "The grid doesn't name the cursor's cell as its active one",
    focus,
  );
  await d.capture("grid-details-1280");
  await leftUntilEnded(d);
  const past = await gridState(d);
  d.observed["pastWithoutCatchup"] = past;
  expect(
    (await actions(d)).join() === "Watch live",
    "An aired programme without catch-up offers more than Watch live",
    past,
  );
  await d.capture("grid-past-1280");

  // Up, at the same time, to the channel with three days of catch-up: its sign, and Play from
  // start first for a programme that aired.
  await d.key("ArrowUp", 38);
  await leftUntilEnded(d);
  const catchup = { ...(await gridState(d)), actions: await actions(d) };
  d.observed["pastWithCatchup"] = catchup;
  expect(catchup.actions.join() === "Play from start,Watch live", "No Play from start", catchup);
  expect(
    await d.exists(`${GRID}.querySelector('[role=rowheader] [aria-label="Catch-up"]')`),
    "No catch-up sign beside the channel",
  );
  await d.capture("grid-catchup-1280");

  // Tab to its Watch live: Enter there is the button's, which watches the channel live.
  for (let presses = 0; presses < 4; presses++) {
    await d.key("Tab", 9);
    if (await d.evaluate<boolean>("document.activeElement?.textContent?.trim() === 'Watch live'"))
      break;
  }
  expect(
    await d.evaluate<boolean>("document.activeElement?.textContent?.trim() === 'Watch live'"),
    "Tab didn't reach Watch live",
  );
  await d.capture("grid-focused-watch-live-1280");
  await watchesLive(d, fixture, "Enter on the focused Watch live", () => d.key("Enter", 13));
  await d.key("Escape", 27);
  await d.wait(() => d.exists(GRID));

  // Enter, with the grid's focus, plays it from the panel's archive in Watch, which says it aired.
  await d.key("ArrowRight", 39);
  await d.key("ArrowLeft", 37);
  await playAired(d, fixture, "1280");
  await d.key("Escape", 27);
  await d.wait(() => d.exists(GRID));

  // Watch live on the channel whose recording plays: the recording gives way to the channel live.
  await d.capture("grid-recording-before-watch-live-1280");
  await watchesLive(
    d,
    fixture,
    "Watch live on the channel whose recording plays",
    () =>
      d.click(
        "Click Watch live on the channel whose recording plays",
        named("[role=grid] [role=region] button", "Watch live"),
      ),
    true,
  );
  await d.capture("grid-recording-watch-live-1280");
  await d.key("Escape", 27);
  await d.wait(() => d.exists(GRID));

  // The pointer: a later programme on the second row opens its details, and Watch live watches.
  // The first programme wholly in view that starts after the now line.
  const later = `(() => {
    const grid = ${GRID}.getBoundingClientRect();
    const now = ${GRID}.querySelector('.bg-white.w-px').getBoundingClientRect().x;
    return [...[...${GRID}.querySelectorAll('[role=row]')][1].querySelectorAll(${JSON.stringify(PROGRAMME)})]
      .find(cell => { const b = cell.getBoundingClientRect(); return b.x > now + 4 && b.right < grid.right && b.width > 40; });
  })()`;
  const laterTitle = await d.evaluate<string>(`${later}?.textContent ?? ''`);
  await d.click("Click a later programme on the second channel", later);
  await d.wait(async () => (await gridState(d)).details?.includes(laterTitle) === true);
  d.observed["clickedProgramme"] = await gridState(d);
  await d.capture("grid-click-details-1280");
  const archived = fixture.archiveRequests().length;
  await d.click("Watch live from the details", `${DETAILS}?.querySelector('button')`);
  await d.wait(async () => {
    const v = await picture(d);
    return v.watching && v.time > 1 && v.width > 0 && v.audio > 0 && !v.title.includes("Aired");
  });
  const first = await picture(d);
  await d.wait(async () => (await picture(d)).time > first.time + 0.5);
  d.observed["clickWatch"] = { ...(await picture(d)), streams: fixture.streams() };
  expect(fixture.streams().active === 1, "Watch live didn't own exactly one provider connection");
  expect(fixture.archiveRequests().length === archived, "Watch live asked for the archive");
  await d.capture("grid-click-watch");
  await d.key("Escape", 27);
  await d.wait(() => d.exists(GRID));

  // Escape goes to the list before Home.
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists(GRID)) && (await d.exists(guideButton)));
  d.observed["listRows"] = await d.evaluate<number>(
    "document.querySelectorAll('main [data-index]').length",
  );
  expect((d.observed["listRows"] as number) > 0, "The list didn't come back");
  await d.capture("list-after-grid");

  // The view is kept: G shows the grid, and after a restart Live TV opens on it.
  await d.key("g", 71);
  await d.wait(() => d.exists(GRID));
  d.action("Quit and start the app again on the same profile");
  await d.quit();
  await d.launch();
  await d.click("Open Live TV after the restart", named("header button", "Live TV"));
  await d.wait(() => d.exists(GRID));
  d.observed["gridAfterRestart"] = true;
  await d.wait(async () => (await gridState(d)).programmes > 5);

  // 900 px: smaller than the window allows, so the page's size is set.
  d.action("Size the page to 900 × 800");
  await d.send("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await d.wait(() => d.evaluate<boolean>("innerWidth === 900 && innerHeight === 800"));
  await d.wait(async () => (await gridState(d)).programmes > 5);
  // Home: the first channel, the one with catch-up, at the cursor's time.
  await d.key("Home", 36);
  await d.wait(() => d.exists(DETAILS));
  const narrow = { ...(await gridState(d)), actions: await actions(d) };
  expect(!narrow.overflow, "The page overflows at 900 px", narrow);
  d.observed["narrow"] = narrow;
  await d.capture("grid-900");
  await leftUntilEnded(d);
  await d.capture("grid-catchup-900");
  await playAired(d, fixture, "900");
  await d.key("Escape", 27);
  await d.wait(() => d.exists(GRID));

  // Left past the grid's start hands the keys to the lists, and the grid gives up the focus.
  // Tab back into the grid takes them back: Down moves its cursor, and Enter watches that cell.
  for (let presses = 0; presses < 150; presses++) {
    await d.key("ArrowLeft", 37);
    if (!(await d.evaluate<boolean>(`document.activeElement === ${GRID}`))) break;
  }
  expect(
    !(await d.evaluate<boolean>(`document.activeElement === ${GRID}`)),
    "Left never handed the keys to the lists",
  );
  for (let presses = 0; presses < 60; presses++) {
    await d.key("Tab", 9);
    if (await d.evaluate<boolean>(`document.activeElement === ${GRID}`)) break;
  }
  expect(
    await d.evaluate<boolean>(`document.activeElement === ${GRID}`),
    "Tab didn't reach the grid",
  );
  const cursorRow = `${GRID}.querySelector('[role=gridcell][aria-selected=true]')?.closest('[role=row]')?.querySelector('[role=rowheader]')?.title ?? null`;
  const before = await d.evaluate<string | null>(cursorRow);
  await d.key("ArrowDown", 40);
  const after = await d.evaluate<string | null>(cursorRow);
  d.observed["tabGridDown"] = { before, after };
  expect(!!after && after !== before, "Down on the grid Tab focused didn't move its cursor", {
    before,
    after,
  });
  await d.capture("grid-tab-down-900");
  await d.key("Enter", 13);
  await d.wait(async () => (await picture(d)).watching);
  const watched = await picture(d);
  d.observed["tabGridEnter"] = watched;
  expect(
    !!after &&
      watched.title.includes(after.replace(/^TEST \| /, "")) &&
      !watched.title.includes("Aired"),
    "Enter on the grid Tab focused didn't watch its cell's channel live",
    watched,
  );
  await d.key("Escape", 27);
  await d.wait(() => d.exists(GRID));
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists(GRID)));
  await d.send("Emulation.clearDeviceMetricsOverride");
}

/**
 * `act` opens Watch on the channel live: no archive asked for, Watch not saying it aired, one
 * connection. From a recording, a new live stream from the panel, whose picture and sound
 * advance; otherwise the live stream already open, whose fake recording may have played out.
 */
async function watchesLive(
  d: Driver,
  fixture: GridFixture,
  label: string,
  act: () => Promise<void>,
  fromRecording = false,
) {
  const before = { streams: fixture.streams(), archive: fixture.archiveRequests().length };
  await act();
  await d.wait(async () => {
    const v = await picture(d);
    return v.watching && v.width > 0 && !v.title.includes("Aired");
  });
  if (fromRecording) {
    await d.wait(async () => {
      const v = await picture(d);
      return v.time >= 1 && v.audio > 0;
    });
    const first = await picture(d);
    await d.wait(async () => (await picture(d)).time > first.time + 0.5);
  }
  const after = {
    ...(await picture(d)),
    streams: fixture.streams(),
    archiveRequests: fixture.archiveRequests().length - before.archive,
    before: before.streams,
  };
  d.observed[label] = after;
  expect(
    after.archiveRequests === 0 &&
      (!fromRecording || after.streams.requests > before.streams.requests) &&
      after.streams.active === 1,
    `${label} didn't play the channel live on one connection`,
    after,
  );
}

/** The details' buttons, in order. */
const actions = (d: Driver) =>
  d.evaluate<string[]>(
    `[...(${DETAILS})?.querySelectorAll('button') ?? []].map(b => b.textContent.trim())`,
  );

/** Left until the programme with the cursor ended before the now line, a few presses at most. */
async function leftUntilEnded(d: Driver) {
  const ended = () =>
    d.evaluate<boolean>(
      `!!${SELECTED} && ${SELECTED}.getBoundingClientRect().right <= ${GRID}.querySelector('.bg-white.w-px').getBoundingClientRect().x + 1`,
    );
  for (let presses = 0; presses < 4 && !(await ended()); presses++) await d.key("ArrowLeft", 37);
  expect(await ended(), "Left didn't reach a programme that has ended", await gridState(d));
}

/**
 * Enter on the programme with the cursor, which aired on a channel with catch-up: Watch plays it
 * from the panel's archive, says it aired, and its picture and sound advance on one connection.
 */
async function playAired(d: Driver, fixture: GridFixture, width: string) {
  const title = await d.evaluate<string>(`${SELECTED}.textContent`);
  const asked = fixture.archiveRequests().length;
  await d.key("Enter", 13);
  await d.wait(async () => {
    const v = await picture(d);
    return v.watching && v.time >= 1 && v.width > 0 && v.audio > 0;
  });
  const first = await picture(d);
  await d.wait(async () => (await picture(d)).time > first.time + 0.5);
  const playing = {
    ...(await picture(d)),
    title,
    archiveRequests: fixture.archiveRequests().slice(asked),
    streams: fixture.streams(),
  };
  d.observed[`catchupPlayback-${width}`] = playing;
  expect(
    playing.archiveRequests.length >= 1 && playing.streams.active === 1,
    "The programme didn't play from the archive on one connection",
    playing,
  );
  const shown = await d.evaluate<string>(
    "document.querySelector('[data-view=watch]')?.innerText ?? ''",
  );
  expect(
    shown.includes(title) && shown.includes("Aired"),
    "Watch doesn't say the programme aired",
    shown,
  );
  // The pointer wakes Watch's controls, so the picture shows what plays.
  for (const x of [600, 640])
    await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: 400 });
  await d.capture(`grid-catchup-playing-${width}`);
}

/** Frame intervals and long tasks while wheels scroll the list, then the grid, both ways. */
export async function guideGridScrollScenario(d: Driver) {
  d.action("Wait for the large guide to be indexed");
  await d.wait(
    () =>
      d.evaluate<boolean>(`(async () => {
        const status = await window.mrStreamer.invoke('guide.status');
        return status.ok && status.value.some(g => g.availability === 'available' && g.processing.state === 'ready');
      })()`),
    // Indexing about half a million programmes.
    600_000,
  );
  d.observed["guideStatus"] = await d.evaluate<unknown>(
    "(async () => (await window.mrStreamer.invoke('guide.status')).value.map(g => ({ channels: g.channels, listed: g.listed, processing: g.processing })))()",
  );
  await d.click("Open Live TV", named("header button", "Live TV"));
  await d.wait(() => d.exists("document.querySelector('main [data-index]')"));

  const measure = async (label: string, area: string, wheels: { x: number; y: number }[]) => {
    await d.evaluate(`(() => {
      window.__frames = []; window.__long = []; window.__run = true;
      window.__observer = new PerformanceObserver(list => window.__long.push(...list.getEntries().map(e => e.duration)));
      window.__observer.observe({ type: 'longtask' });
      let last = 0;
      const tick = t => { if (last) window.__frames.push(t - last); last = t; if (window.__run) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    })()`);
    const point = await d.evaluate<{ x: number; y: number }>(
      `(() => { const b = ${area}.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
    );
    d.action(`Wheel ${label}: ${wheels.length} events, sampling the renderer's CPU`);
    await d.send("Profiler.enable");
    await d.send("Profiler.start");
    for (const wheel of wheels) {
      await d.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...point,
        deltaX: wheel.x,
        deltaY: wheel.y,
      });
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const profile = (await d.send("Profiler.stop")) as { profile: CpuProfile };
    const result = await d.evaluate<{
      frames: number[];
      long: number[];
      top: number;
      left: number;
    }>(
      `(() => { window.__run = false; window.__observer.disconnect();
        const scroller = ${area};
        return { frames: window.__frames, long: window.__long, top: scroller.scrollTop, left: scroller.scrollLeft }; })()`,
    );
    const sorted = result.frames.toSorted((a, b) => a - b);
    const at = (q: number) =>
      Math.round((sorted[Math.floor(q * (sorted.length - 1))] ?? 0) * 10) / 10;
    const summary = {
      frames: sorted.length,
      p50: at(0.5),
      p95: at(0.95),
      max: at(1),
      over50ms: sorted.filter((frame) => frame > 50).length,
      longTasks: result.long.length,
      longTaskMs: Math.round(result.long.reduce((sum, ms) => sum + ms, 0)),
      scrolledTo: { top: result.top, left: result.left },
      busiest: busiest(profile.profile),
    };
    d.observed[`scroll-${label}`] = summary;
    return summary;
  };
  const down = Array.from({ length: 150 }, () => ({ x: 0, y: 120 }));
  // About 18 hours ahead, within the guide's day ahead.
  const across = Array.from({ length: 30 }, () => ({ x: 120, y: 0 }));
  const list = "document.querySelector('main [data-index]').parentElement.parentElement";
  const listScroll = await measure("list-down", list, down);
  expect(listScroll.scrolledTo.top > 0, "The list didn't scroll", listScroll);
  await d.capture("scroll-list");

  await d.key("g", 71);
  await d.wait(() => d.exists(GRID));
  await d.wait(() =>
    d.evaluate<boolean>(`${GRID}.querySelectorAll('[role=gridcell][aria-selected]').length > 20`),
  );
  const gridDown = await measure("grid-down", GRID, down);
  expect(gridDown.scrolledTo.top > 0, "The grid didn't scroll down", gridDown);
  await d.wait(() =>
    d.evaluate<boolean>(`${GRID}.querySelectorAll('[role=gridcell][aria-selected]').length > 20`),
  );
  await d.capture("scroll-grid-down");
  const gridAcross = await measure("grid-across", GRID, across);
  expect(gridAcross.scrolledTo.left > 0, "The grid didn't scroll across", gridAcross);
  await d.wait(() =>
    d.evaluate<boolean>(`${GRID}.querySelectorAll('[role=gridcell][aria-selected]').length > 20`),
  );
  await d.capture("scroll-grid-across");
}

interface CpuProfile {
  readonly nodes: readonly {
    readonly id: number;
    readonly callFrame: { functionName: string; url: string; lineNumber: number };
  }[];
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
}

/** The functions the renderer spent most of its own time in, in milliseconds. */
function busiest(profile: CpuProfile): { name: string; ms: number }[] {
  const frames = new Map(profile.nodes.map((node) => [node.id, node.callFrame]));
  const time = new Map<string, number>();
  for (const [index, id] of profile.samples.entries()) {
    const frame = frames.get(id);
    if (!frame) continue;
    const file = frame.url.split("/").at(-1) || "(native)";
    const name = `${frame.functionName || "(anonymous)"} ${file}:${frame.lineNumber + 1}`;
    time.set(name, (time.get(name) ?? 0) + (profile.timeDeltas[index] ?? 0) / 1000);
  }
  return [...time]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, ms]) => ({ name, ms: Math.round(ms) }));
}
