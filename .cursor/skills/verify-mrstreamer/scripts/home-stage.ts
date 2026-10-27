import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  liveStreams,
  type FakeChannel,
  type FakeProviderOptions,
} from "../../../../apps/desktop/test/fake-provider.ts";
import type { Driver } from "./language.ts";

const CHANNELS = ["Meridian", "Newsroom", "Orbit", "Harbour", "Fernlight", "Atlas"];

/** Six playable synthetic channels, with both current programmes and a deliberate guide gap. */
export function stageChannel(channel: FakeChannel): FakeChannel {
  const name = CHANNELS[channel.streamId - 1000];
  return name
    ? {
        ...channel,
        name: `STAGE | ${name}`,
        hasLogo: true,
        fixture: "h264-aac.mpegts",
        guideId: channel.streamId === 1001 ? null : `stage${channel.streamId}.test`,
      }
    : channel;
}

/**
 * Stage channels broadcast their clip in a loop at its own rate, as a live channel doesn't run out:
 * the preview must still advance after six plays, the layout measurements and the Watch handoff,
 * where the three-second clip has long ended. Other channels stream as the live fake provider's do.
 * The provider closing the request stops that broadcast's ffmpeg.
 */
export const stageStreams: NonNullable<FakeProviderOptions["streams"]> = (channel, out, signal) => {
  if (!channel.fixture || !channel.name.startsWith("STAGE | "))
    return liveStreams(channel, out, signal);
  const clip = new URL(
    `../../../../apps/desktop/test/fixtures/${channel.fixture}`,
    import.meta.url,
  );
  const broadcast = spawn(
    process.env["MR_STREAMER_FFMPEG"] || "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-re",
      "-stream_loop",
      "-1",
      "-i",
      fileURLToPath(clip),
      ...["-c", "copy", "-f", "mpegts", "pipe:1"],
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  broadcast.once("error", () => out.destroy(new Error("Stage broadcast unavailable.")));
  broadcast.stdout.pipe(out);
  signal.addEventListener("abort", () => broadcast.kill("SIGTERM"), { once: true });
};

/** Tall, tiny, square and wide marks exercise containment with actual loaded SVG images. */
export function stageLogo(channel: FakeChannel): string {
  const sizes = [
    [16, 240],
    [3, 2],
    [80, 80],
    [240, 24],
    [24, 120],
    [120, 60],
  ] as const;
  const [width, height] = sizes[(channel.streamId - 1000) % sizes.length] ?? [80, 40];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" rx="1" fill="white"/><path d="M0 0 L${width} ${height} M0 ${height} L${width} 0" stroke="#2861bd" stroke-width="${Math.min(width, height) / 5}"/></svg>`;
}

const text = (selector: string, name: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(name)})`;
const check = (name: string) =>
  `${text('section[aria-label="Customize Home"] label', name)}.querySelector('input')`;
const move = (name: string, direction: string) =>
  `document.querySelector('button[aria-label="Move ${name} ${direction}"]')`;
const require = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

interface Fixture {
  liveOnly: boolean;
  otherUrl: string | undefined;
  counts(): Record<string, number>;
  streams(): { requests: number; active: number };
}

/** Selected Stage acceptance uses pointer/key navigation and read-only state/geometry evidence. */
export async function homeStageScenario(d: Driver, fixture: Fixture): Promise<void> {
  const row = (id: string) => `document.querySelector('[data-home-row="${id}"]')`;
  const promoted = () =>
    d.evaluate<string | null>(
      "document.querySelector('[data-home-promoted]')?.getAttribute('data-home-row') ?? null",
    );
  const preferences = () =>
    d.evaluate<{ id: string; visible: boolean }[]>(
      "(async () => { const read = await window.mrStreamer.invoke('preferences.get'); return read.ok ? read.value.preferences.homeRows ?? [] : []; })()",
    );
  const customize = async () => {
    await d.click(
      "Open Settings",
      "document.querySelector('header button[aria-label=\"Settings\"]')",
    );
    await d.click("Open Home settings", text("nav button", "Home"));
    await d.wait(() =>
      d.exists("document.querySelector('section[aria-label=\"Customize Home\"]')"),
    );
    const controls = await d.evaluate<{ label: string; radius: number; height: number }[]>(
      "[...document.querySelectorAll('section[aria-label=\"Customize Home\"] [data-slot=button]')].map(b => ({ label:b.getAttribute('aria-label') ?? b.innerText, radius:parseFloat(getComputedStyle(b).borderRadius), height:b.getBoundingClientRect().height }))",
    );
    require(controls.length === 17 &&
      controls.every((c) => c.radius >= c.height / 2), "Customize controls are not rounded");
    d.observed["customizeControls"] = controls;
    await d.capture("home-customize-controls");
  };
  const done = () =>
    d.click(
      "Return from Home settings",
      "[...document.querySelectorAll('header button')].findLast(b => b.textContent.trim() === 'Back')",
    );
  const reset = async () => {
    await d.click("Reset Home rows", text("button", "Reset to defaults"));
    await d.wait(
      async () =>
        (await preferences()).every((r) => r.visible) &&
        (await preferences())[0]?.id === "continue",
    );
  };
  const search = async (name: string) => {
    await d.click(`Search ${name}`, "document.querySelector('button[aria-label=Search]')");
    await d.send("Input.insertText", { text: name });
    await d.wait(() =>
      d.evaluate<boolean>(
        `document.querySelector('[aria-label="Search results"] [aria-selected=true]')?.innerText.includes(${JSON.stringify(name.split(" | ").at(-1))}) ?? false`,
      ),
    );
  };
  const home = async () => {
    await d.click("Return Home", text("header button", "Home"));
    await d.wait(() => d.exists("document.querySelector('[data-home-stage]')"));
  };
  const sizes = [
    [1280, 798],
    [1600, 1000],
    [900, 700],
  ] as const;
  const measure = async (state: string) => {
    const frames: object[] = [];
    for (const [width, height] of sizes) {
      d.action(`Measure ${state} at ${width} by ${height}`);
      await d.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await d.wait(() =>
        d.evaluate<boolean>(`innerWidth === ${width} && innerHeight === ${height}`),
      );
      await d.evaluate("document.querySelector('[data-home-stage]').parentElement.scrollTop = 0");
      await d.wait(() =>
        d.evaluate<boolean>(
          "[...document.querySelectorAll('[data-home-channel-art] img')].filter(i => i.getAttribute('src')?.includes('/logos/')).every(i => i.complete && i.naturalWidth > 0)",
        ),
      );
      await d.capture(`${state}-${width}`);
      const geometry = await d.evaluate<{
        width: number;
        height: number;
        overflow: number;
        preview: { width: number; height: number };
        promoted: string | null;
        rows: string[];
        arts: {
          row: string;
          width: number;
          height: number;
          labelY: number;
          logo: {
            x: number;
            y: number;
            width: number;
            height: number;
            naturalWidth: number;
            naturalHeight: number;
            fit: string;
          } | null;
        }[];
        controls: {
          name: string;
          radius: number;
          width: number;
          height: number;
          x: number;
          right: number;
          bottom: number;
        }[];
        titleArt: { row: string; width: number; height: number }[];
        headings: { text: string; x: number; right: number }[];
        sparseTitles: number;
        video: { time: number; muted: boolean; width: number; paused: boolean };
      }>(`(() => {
        const box = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
        const preview = document.querySelector('[data-home-preview]');
        const v = preview.querySelector('video');
        return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth - innerWidth,
          preview: box(preview), promoted: document.querySelector('[data-home-promoted]')?.dataset.homeRow ?? null,
          rows: [...document.querySelectorAll('[data-home-row]')].map(r => r.dataset.homeRow),
          arts: [...document.querySelectorAll('[data-home-channel-art]')].map(a => {
            const r = a.getBoundingClientRect(), logo = a.querySelector('img'), label = a.nextElementSibling;
            return { row: a.closest('[data-home-row]').dataset.homeRow, width:r.width, height:r.height, labelY:label?.getBoundingClientRect().y - r.y,
              logo: logo ? { x:logo.getBoundingClientRect().x-r.x, y:logo.getBoundingClientRect().y-r.y, width:logo.getBoundingClientRect().width, height:logo.getBoundingClientRect().height, naturalWidth:logo.naturalWidth, naturalHeight:logo.naturalHeight, fit:getComputedStyle(logo).objectFit } : null };
          }),
          controls: [...document.querySelector('[data-home-stage]').parentElement.querySelectorAll('[data-slot=button]')].map(b => ({ name:b.getAttribute('aria-label') ?? b.innerText, radius:parseFloat(getComputedStyle(b).borderRadius), ...box(b) })),
          titleArt: [...document.querySelectorAll('[data-home-title] button[title], [data-home-row] button > span[class*="aspect-"]:not([data-home-channel-art])')].map(a => ({ row:a.closest('[data-home-row]').dataset.homeRow, ...box(a) })),
          headings: [...document.querySelectorAll('[data-home-row] h2, [data-home-preview] h2')].map(h => ({ text:h.innerText, ...box(h) })),
          sparseTitles: document.querySelectorAll('[data-home-title]').length,
          video: { time:v?.currentTime ?? 0, muted:v?.muted ?? true, width:v?.videoWidth ?? 0, paused:v?.paused ?? true },
        };
      })()`);
      require(geometry.overflow <= 1, `${state}/${width} overflowed`);
      require(Math.abs(geometry.preview.width / geometry.preview.height - 16 / 9) <
        0.01, `${state}/${width} preview aspect`);
      require(new Set(geometry.rows).size ===
        geometry.rows.length, `${state}/${width} duplicated promoted row`);
      for (const art of geometry.arts) {
        require(Math.abs(art.width / art.height - 16 / 9) <
          0.01, `${state}/${width} channel art aspect`);
        if (art.logo)
          require(art.logo.fit === "contain" &&
            art.logo.x >= 0 &&
            art.logo.y >= 0 &&
            art.logo.x + art.logo.width <= art.width + 1 &&
            art.logo.y + art.logo.height <= art.height + 1, `${state}/${width} logo escaped`);
      }
      for (const id of geometry.rows) {
        const arts = geometry.arts.filter((a) => a.row === id);
        require(arts.length === 0 ||
          Math.max(...arts.map((a) => a.height)) - Math.min(...arts.map((a) => a.height)) <
            1, `${state}/${width} inconsistent channel heights`);
        if (id !== geometry.promoted)
          require(arts.length === 0 ||
            Math.max(...arts.map((a) => a.labelY)) - Math.min(...arts.map((a) => a.labelY)) <
              1, `${state}/${width} inconsistent label baselines`);
      }
      require(geometry.controls.every(
        (b) => b.radius >= b.height / 2,
      ), `${state}/${width} square control`);
      require(geometry.controls.every(
        (b) => b.x >= 0 && b.right <= width + 1,
      ), `${state}/${width} clipped action`);
      require(geometry.headings.every(
        (h) => h.x >= 0 && h.right <= width + 1,
      ), `${state}/${width} clipped heading`);
      for (const art of geometry.titleArt) {
        require(Math.abs(art.width / art.height - (art.row === "continue" ? 16 / 9 : 2 / 3)) <
          0.01, `${state}/${width} title art aspect`);
      }
      frames.push(geometry);
      if (state === "two-saved" || state === "three-saved") {
        await d.evaluate(
          "document.querySelector('[data-home-row=watchlist]').scrollIntoView({ block: 'center' })",
        );
        await d.capture(`${state}-row-${width}`);
      }
    }
    d.observed[state] = frames;
  };

  await d.wait(async () => (await promoted()) === "category");
  require(!(await d.exists(row("continue"))) &&
    !(await d.exists(row("recommendations"))), "No-history personalized rows");
  await measure(fixture.liveOnly ? "live-only" : "no-history");
  await d.wait(async () => !(await d.exists(text("header button", "Watchlist"))));
  await d.capture("empty-navigation");
  if (fixture.liveOnly) {
    require(!(await d.exists(text("header button", "Movies"))), "Live-only title navigation");
    require(fixture.counts().titleLists === 0 &&
      fixture.counts().details === 0, "Live-only fetched titles");
    await customize();
    await d.click("Hide only channel row", check("Current category"));
    await d.wait(async () => (await promoted()) === null);
    await done();
    await d.capture("live-only-hidden-category");
    require(!(await d.exists(
      text("header button", "Watchlist"),
    )), "Empty Watchlist navigation returned");
    await customize();
    await reset();
    await done();
    await d.wait(async () => (await promoted()) === "category");
    d.observed["liveOnlyCounts"] = fixture.counts();
    return;
  }

  const save = async (name: string, kind: "Movies" | "Series" = "Movies") => {
    await d.click(`Open ${kind}`, text("header button", kind));
    await d.click(
      `Open All ${kind.toLowerCase()}`,
      text("nav button", `All ${kind.toLowerCase()}`),
    );
    await d.click(
      `Open ${name}`,
      `[...document.querySelectorAll('button[title]')].find(b => b.title.includes(${JSON.stringify(name)}))`,
    );
    await d.click(`Save ${name}`, text('[role="dialog"] button', "Save"));
    await d.wait(() => d.exists(text('[role="dialog"] button', "Saved")));
    await d.key("Escape", 27);
    await home();
  };
  await save("Index at the end");
  for (const [index, name] of CHANNELS.entries()) {
    await search(`STAGE | ${name}`);
    await d.key("Enter", 13);
    await d.wait(() =>
      d.evaluate<boolean>(
        "!!document.querySelector('[data-view=watch]') && document.querySelector('video')?.videoWidth > 0 && document.querySelector('video').currentTime > 0.5",
      ),
    );
    await d.wait(() =>
      d.evaluate<boolean>(
        `(async () => { const r = await window.mrStreamer.invoke('viewing.get'); return r.ok && r.value.recent[0]?.id === '${1000 + index}'; })()`,
      ),
    );
    await d.key("Escape", 27);
    await d.wait(() => d.exists("document.querySelector('[data-home-preview] video')"));
  }
  await d.wait(async () => (await promoted()) === "recent");
  await d.wait(() =>
    d.evaluate<boolean>(`${row("recent")}?.querySelectorAll('button[title]').length === 6`),
  );
  require((await d.evaluate<number>(
    `${row("watchlist")}.querySelectorAll('[data-home-title]').length`,
  )) === 1, "Sparse saved count is not one");
  require(!(await d.exists(row("continue"))), "Sparse Continue was populated");
  await measure("sparse");
  const before = fixture.streams();
  const clock = await d.evaluate<number>(
    "document.querySelector('[data-home-preview] video').currentTime",
  );
  await d.wait(() =>
    d.evaluate<boolean>(
      `document.querySelector('[data-home-preview] video').muted && !document.querySelector('[data-home-preview] video').paused && document.querySelector('[data-home-preview] video').currentTime > ${clock + 0.4}`,
    ),
  );
  const muted = await d.evaluate<number>(
    "document.querySelector('[data-home-preview] video').currentTime",
  );
  await d.click("Watch shares the live preview", text("button", "Watch"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "!!document.querySelector('[data-view=watch]') && !document.querySelector('video').muted && !document.querySelector('video').paused",
    ),
  );
  require(fixture.streams().requests === before.requests &&
    fixture.streams().active === 1, "Watch restarted stream");
  d.observed["handoff"] = {
    before,
    after: fixture.streams(),
    previewClock: clock,
    advancedMutedClock: muted,
    watchClock: await d.evaluate<number>("document.querySelector('video').currentTime"),
  };
  await d.capture("shared-watch");
  await d.key("Escape", 27);
  const savedName = await d.evaluate<string>(`${row("watchlist")}.querySelector('h3').innerText`);
  d.observed["sparseSavedName"] = savedName;
  await d.click(
    "Open sparse saved title details",
    text("[data-home-row=watchlist] button", "Details"),
  );
  await d.wait(() => d.exists(text('[role="dialog"] button', "Saved")));
  require(await d.evaluate<boolean>(
    `document.querySelector('[role=dialog]').innerText.includes(${JSON.stringify(savedName)})`,
  ), "Saved details mismatch");
  await d.capture("sparse-saved-details");
  await d.key("Escape", 27);
  await d.click("Play sparse resolved movie", text("[data-home-row=watchlist] button", "Play"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "!!document.querySelector('[data-view=title] video') && document.querySelector('[data-view=title] video').currentTime > 0.5",
    ),
  );
  await d.wait(() =>
    d.evaluate<boolean>(
      "(async () => { const r=await window.mrStreamer.invoke('viewing.get'); return r.ok && r.value.recentTitles.some(p=>p.finished); })()",
    ),
  );
  await d.key("Escape", 27);
  await home();
  await d.wait(() => d.exists(row("recommendations")));
  await save("Old AVI");
  await measure("two-saved");
  await save("Picture subtitles");
  await measure("three-saved");
  await save("Formats", "Series");
  await d.click(
    "Open marked series",
    `${row("watchlist")}.querySelector('button[title*="Formats"]')`,
  );
  await d.click(
    "First episode actions",
    "document.querySelector('[aria-label=\"More for S1 E1\"]')",
  );
  await d.click("Mark first episode watched", text('[role="menuitem"]', "Mark watched"));
  await d.wait(() => d.exists(text('[role="dialog"] button', "Play S1 E2")));
  await d.key("Escape", 27);
  await home();
  await d.wait(() => d.evaluate<boolean>(`${row("continue")}?.innerText.includes('S1 E2')`));
  await measure("continue");

  for (const name of CHANNELS) {
    await search(`STAGE | ${name}`);
    await d.click(
      `Favourite ${name}`,
      'document.querySelector(\'[aria-label="Search results"] button[aria-label="Add to favourites"]\')',
    );
    await d.key("Escape", 27);
  }
  await d.wait(async () => (await promoted()) === "favourites");
  await measure("full");
  const requestCounts = fixture.counts();
  await customize();
  await d.click("Move Continue below Recommendations", move("Continue watching", "down"));
  await d.wait(async () => (await preferences())[0]?.id === "recommendations");
  require((
    await d.evaluate<string[]>(
      "[...document.querySelectorAll('[data-home-row]')].filter(r=>!r.hasAttribute('data-home-promoted')).map(r=>r.dataset.homeRow)",
    )
  )[0] === "continue", "Continue lost its first title-row placement after reorder");
  // Recent starts below Favourites; one keyboard move places it first among channel rows.
  await d.evaluate(`${move("Recently watched", "up")}.focus()`);
  await d.key("Enter", 13);
  await d.wait(async () => (await promoted()) === "recent");
  require((await d.evaluate<number>(
    "document.querySelectorAll('[data-home-row=recent]').length",
  )) === 1, "Reorder duplicated Recent");
  await done();
  require(JSON.stringify(fixture.counts()) ===
    JSON.stringify(requestCounts), "Reorder fetched provider/TMDB data");
  const kept = await preferences();
  await d.quit();
  await d.launch();
  await d.wait(async () => (await promoted()) === "recent");
  require(JSON.stringify(await preferences()) ===
    JSON.stringify(kept), "Promotion order lost after restart");
  await d.capture("promoted-recent-restart");
  await customize();
  await d.click("Hide promoted Recent", check("Recently watched"));
  await d.wait(async () => (await promoted()) === "favourites");
  await d.click("Hide Favourites", check("Favourites"));
  await d.wait(async () => (await promoted()) === "category");
  await d.click("Hide populated Watchlist", check("Watchlist"));
  await done();
  await d.click("Permanent populated Watchlist while hidden", text("header button", "Watchlist"));
  await d.wait(() =>
    d.exists("document.querySelector('button[title*=" + JSON.stringify("Index at the end") + "]')"),
  );
  await d.capture("hidden-full-watchlist");
  await home();
  await customize();
  await reset();
  await done();
  await d.wait(async () => (await promoted()) === "favourites");
  require((
    await d.evaluate<string[]>(
      "[...document.querySelectorAll('[data-home-row]')].filter(r=>!r.hasAttribute('data-home-promoted')).map(r=>r.dataset.homeRow)",
    )
  )[0] === "continue", "Continue is not first among remaining rows");
  await d.capture("promoted-reset");
  d.observed["promotion"] = {
    kept,
    reset: await preferences(),
    promoted: await promoted(),
    reorderRequestCounts: requestCounts,
  };
  await customize();
  while ((await preferences())[0]?.id !== "favourites") {
    const before = (await preferences()).findIndex((r) => r.id === "favourites");
    await d.click("Move Favourites before title rows", move("Favourites", "up"));
    await d.wait(
      async () => (await preferences()).findIndex((r) => r.id === "favourites") < before,
    );
  }
  while ((await preferences())[1]?.id !== "recent") {
    const before = (await preferences()).findIndex((r) => r.id === "recent");
    await d.click("Keep another channel row before title rows", move("Recently watched", "up"));
    await d.wait(async () => (await preferences()).findIndex((r) => r.id === "recent") < before);
  }
  await done();
  const mixedOrder = await d.evaluate<string[]>(
    "[...document.querySelectorAll('[data-home-row]')].map(r=>r.dataset.homeRow)",
  );
  require(mixedOrder[0] === "favourites" &&
    mixedOrder[1] === "recent" &&
    mixedOrder[2] === "continue", "Continue displaced a saved channel-row position");
  d.observed["mixedRowOrder"] = mixedOrder;
  await d.capture("channel-row-before-title-rows");
  await customize();
  await reset();
  await done();
  if (fixture.otherUrl) {
    await d.click(
      "Open subscriptions for owner labels",
      "document.querySelector('button[aria-label=Settings]')",
    );
    await d.click("Subscriptions", text("nav button", "Subscriptions"));
    await d.click("Add a second fixture owner", text("button", "Add subscription"));
    await d.wait(() => d.evaluate<boolean>("document.querySelectorAll('form input').length >= 4"));
    for (const [index, value] of ["Nova TV", fixture.otherUrl, "demo", "demo"].entries()) {
      await d.click(
        `Fill second-owner field ${index + 1}`,
        `document.querySelectorAll('form input')[${index}]`,
      );
      await d.send("Input.insertText", { text: value });
    }
    await d.click("Connect second owner", "document.querySelector('form button[type=submit]')");
    await d.wait(() =>
      d.evaluate<boolean>(
        "[...document.querySelectorAll('li')].some(r => r.innerText.includes('Nova TV'))",
      ),
    );
    await d.key("Escape", 27);
    await home();
    await d.wait(() =>
      d.evaluate<boolean>(
        "document.querySelector('[data-home-promoted]')?.innerText.includes('127.0.0.1')",
      ),
    );
    await d.capture("multiple-owner-channels");
    d.observed["ownerRows"] = await d.evaluate<string>(
      "document.querySelector('[data-home-promoted]').innerText",
    );
  }
  await d.click(
    "Settings for adult channel exclusion",
    "document.querySelector('button[aria-label=Settings]')",
  );
  await d.click("Open Movies and series settings", text("nav button", "Movies and series"));
  await d.click(
    "Enable adult titles",
    "document.querySelector('[role=checkbox][aria-label=\"For adults\"]')",
  );
  await d.wait(() =>
    d.evaluate<boolean>(
      "(async () => { const p=await window.mrStreamer.invoke('preferences.get'); return p.ok && p.value.preferences.adultTitles; })()",
    ),
  );
  await d.capture("adult-setting-settled");
  await d.key("Escape", 27);
  await d.wait(() =>
    d.evaluate<boolean>(
      "!!document.querySelector('[data-home-preview]') && !document.body.innerText.includes('Loading channels')",
    ),
  );
  await d.click(
    "Browse adult channels in Live TV",
    text("[data-home-preview] button", "All channels"),
  );
  await d.click(
    "Search adult channel in Live TV",
    "document.querySelector('main input[aria-label^=Search]')",
  );
  await d.send("Input.insertText", { text: "AFTER HOURS" });
  await d.wait(() =>
    d.exists(
      "document.querySelector('main [data-search-row] button[aria-label=\"Add to favourites\"]')",
    ),
  );
  await d.click(
    "Favourite an adult channel",
    "document.querySelector('main [data-search-row] button[aria-label=\"Add to favourites\"]')",
  );
  await d.click(
    "Watch adult channel through its Live TV row",
    "document.querySelector('main [data-search-row]')",
  );
  await d.wait(() =>
    d.evaluate<boolean>(
      "!!document.querySelector('[data-view=watch] video') && document.querySelector('[data-view=watch] video').currentTime > 0.5",
    ),
  );
  await d.key("Escape", 27);
  await home();
  require(!(await d.evaluate<boolean>(
    "document.body.innerText.toUpperCase().includes('AFTER HOURS')",
  )), "Adult channel leaked into Home");
  await d.capture("home-adult-channel-excluded");
  // A listed channel with no guide, followed by a failed stream, retains usable Watch actions.
  await search("STAGE | Newsroom");
  await d.key("Enter", 13);
  await d.wait(() =>
    d.evaluate<boolean>(
      "!!document.querySelector('[data-view=watch] video') && document.querySelector('[data-view=watch] video').currentTime > 0.5",
    ),
  );
  await d.key("Escape", 27);
  await d.capture("home-no-guide");
  await search("TEST | Offline");
  await d.key("Enter", 13);
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelector('[data-view=watch]')?.innerText.includes('No stream right now') ?? false",
    ),
  );
  await d.capture("offline-watch-failed");
  await d.key("Escape", 27);
  await d.wait(() =>
    d.evaluate<boolean>(
      "!document.querySelector('[data-view=watch]') && document.querySelector('[data-home-preview]')?.checkVisibility()",
    ),
  );
  require(!(await d.exists(
    "document.querySelector('[data-home-preview] button[aria-label=Unmute]')",
  )), "Failed stream offered mute");
  await d.capture("home-no-stream");
}
