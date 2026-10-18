// Checks a built app on a playlist subscription, against the fake playlist host: what the suite
// can't, because hls.js plays nothing without a real browser. It connects by an M3U link, then
// checks, in order:
//
// - Settings > Subscriptions says the playlist names no guide, without an error, also after its
//   refresh button; finds the guide once the playlist names one; and drops it again.
// - An HLS channel offers its two sound tracks and declared subtitle languages after observed cues.
//   It plays its own sound and keeps subtitles off despite the stream's default mark.
// - Picking the other sound switches where the stream plays: the same stream goes on, now
//   loading the other rendition's segments, with sound still decoded.
// - An empty declared rendition stays selectable. Picking a working rendition shows
//   its lines at their seconds; C turns them off, and on again
//   with the lines hls.js had read before.
// - A channel whose picture carries closed captions offers them under CC and shows them. After
//   Stop and the same channel again they are still chosen, and show as the new stream brings them,
//   once: a line left from the stream before would show beside it.
// - Back on the first channel, the sound and subtitles in the languages picked come on by
//   themselves; a stream with nothing to choose offers neither Sound in More nor CC.
// - After the keychain loses the link, the app opens on what it had loaded, Settings > Subscriptions
//   says the playlist needs its link again and asks for it there, naming only its host, and the
//   same link is taken for the same account with its favourite.
//
//   node test/e2e/playlist-app.ts <app executable> [-- extra app arguments]
//
// The app runs with a throwaway profile and remote debugging on a random port; on macOS pass
// --use-mock-keychain so the test never touches a real keychain. No sound device is needed:
// sound counts as playing when the element decodes it.
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYLIST_CHANNELS, startFakePlaylist } from "../fake-playlist.ts";
import {
  connect,
  connectPlaylist,
  delay,
  fill,
  key,
  launch,
  openSubscriptions,
  subscriptionRow,
  waitFor,
  type Page,
} from "./app.ts";

const [executable, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!executable) throw new Error("Usage: node test/e2e/playlist-app.ts <app executable> [-- args]");

// A named prefix lets a maintainer keep this run separate from other app checks.
const profile = mkdtempSync(
  process.env["MR_STREAMER_E2E_PROFILE_PREFIX"] ?? join(tmpdir(), "mr-streamer-e2e-"),
);
const host = await startFakePlaylist();
const randomPort = () => 20000 + Math.floor(Math.random() * 20000);
let port = randomPort();
let app = launch(executable, rest, { port, profile });

const morePopup = `document.querySelector('[role="dialog"][aria-label="More"]')`;
const soundRow = `[...${morePopup}?.querySelectorAll("button") ?? []].find((b) => b.getAttribute("aria-label") === "Sound")`;

let failed = false;
/** Prints how a check went. */
function report(name: string, result: { ok: boolean; detail: string }): void {
  console.log(`${result.ok ? "PASS" : "FAIL"} ${name}: ${result.detail}`);
  failed ||= !result.ok;
}

try {
  let page = await connect(port);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await connectPlaylist(page, host.link);
  report("The Guide row follows the playlist", await guideRow(page));
  report("An HLS channel lists its tracks", await listsTracks(page));
  report("Sound switches in place", await switchesSound(page));
  report("Subtitles show, and C toggles them", await showsSubtitles(page));
  report("Captions in the picture show", await showsCaptions(page));
  report("The picked languages carry over", await carriesOver(page));
  report("A stream without tracks has no buttons", await plainStream(page));
  await favourite(page);
  page.close();
  await quit();
  await delay(1500);

  loseLink();
  port = randomPort();
  app = launch(executable, rest, { port, profile });
  page = await connect(port);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  report("A lost link is asked for again", await asksForLink(page));
  page.close();
} catch (error) {
  console.error(`FAIL ${String(error)}`);
  failed = true;
} finally {
  await quit();
  await host.close();
  await delay(1000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(failed ? 1 : 0);

/** Waits for this app to exit before restarting it or removing its throwaway profile. */
async function quit(): Promise<void> {
  if (app.exitCode !== null || app.signalCode !== null) return;
  const exited = once(app, "exit");
  app.kill("SIGKILL");
  await exited;
}

/** A button by its exact words, as an expression for the page. */
function buttonNamed(text: string, within = "document"): string {
  return `[...${within}.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
}

/** Clicks what `expression` finds in the page, once it is there. */
async function click(page: Page, expression: string): Promise<void> {
  await waitFor(() => page.evaluate<boolean>(`!!(${expression})`), 15_000);
  await page.evaluate(`(${expression}).click()`);
}

/** What the Guide row of Settings > Subscriptions says, and the line under it when one shows. */
async function guideRow(page: Page): Promise<{ ok: boolean; detail: string }> {
  await openSubscriptions(page);
  const refresh = `document.querySelector('[aria-label^="Refresh guide of "]')`;
  const read = () =>
    page.evaluate<{ row: string; under: string | null; busy: boolean }>(`(() => {
      const button = ${refresh};
      const row = button?.parentElement?.parentElement;
      return {
        // Its name and what it covers, without the time and the buttons beside them.
        row: [...(row?.firstElementChild?.childNodes ?? [])]
          .map(node => node.textContent.trim()).filter(Boolean).join(" · "),
        under: row?.nextElementSibling?.querySelector("p")?.textContent ?? null,
        busy: !!button?.disabled,
      };
    })()`);
  /** Presses Refresh and waits for the row to settle on `wanted`. */
  const refreshed = async (wanted: RegExp) => {
    await click(page, refresh);
    await waitFor(async () => {
      const now = await read();
      return !now.busy && wanted.test(now.row);
    }, 20_000).catch(() => {});
    return read();
  };
  await waitFor(async () => (await read()).row.includes("none in this playlist"), 20_000).catch(
    () => {},
  );
  const first = await read();
  const again = await refreshed(/none in this playlist/);
  host.nameGuide(true);
  const found = await refreshed(/1 own · 2 without/);
  host.nameGuide(false);
  const dropped = await refreshed(/none in this playlist/);
  await key(page, "Escape", 27);
  const none = "Guide · none in this playlist · 3 without";
  const ok =
    first.row === none &&
    again.row === none &&
    found.row === "Guide · 1 own · 2 without" &&
    dropped.row === none &&
    [first, again, found, dropped].every((each) => each.under === null);
  return {
    ok,
    detail: `"${first.row}", after Refresh "${again.row}", once named "${found.row}", once dropped "${dropped.row}", ${[first, again, found, dropped].filter((each) => each.under).length} error lines`,
  };
}

/** Picks a channel through search and waits for its picture to move. */
async function play(page: Page, channel: string): Promise<void> {
  await click(page, `document.querySelector('[aria-label="Search"]')`);
  await delay(500);
  await page.send("Input.insertText", { text: channel });
  await delay(800);
  await key(page, "Enter", 13);
  await waitFor(
    () =>
      page.evaluate<boolean>(`(() => {
        const video = document.querySelector("video");
        return !!document.querySelector('[data-view="watch"]') && !!video &&
          video.currentTime > 0.3 && video.videoWidth > 0;
      })()`),
    30_000,
  );
}

interface Playing {
  readonly time: number;
  readonly paused: boolean;
  /** Bytes of sound the element decoded so far. */
  readonly sound: number;
  /** The lines of text the viewer reads over the picture, top to bottom. */
  readonly lines: readonly string[];
  /** Whether the CC button is there, and lit. */
  readonly cc: "on" | "off" | "absent";
}

function playing(page: Page): Promise<Playing> {
  return page.evaluate<Playing>(`(() => {
    const video = document.querySelector("video");
    const cc = document.querySelector('[data-view="watch"] [aria-label^="Subtitles"]');
    return {
      time: video.currentTime,
      paused: video.paused,
      sound: video.webkitAudioDecodedByteCount ?? 0,
      // What a style hides isn't part of a line's text, so a place left empty counts for nothing.
      lines: [...document.querySelectorAll("[data-subtitle-text] > div")]
        .map((line) => line.innerText)
        .filter((text) => text !== "")
        .reverse(),
      cc: !cc ? "absent" : cc.getAttribute("aria-pressed") === "true" ? "on" : "off",
    };
  })()`);
}

/** Opens the Sound or CC menu and reads its choices, the chosen one marked, then closes it. */
async function choices(page: Page, menu: "Sound" | "Subtitles"): Promise<string[]> {
  const items = await openMenu(page, menu);
  await key(page, "Escape", 27);
  await delay(300);
  return items;
}

/** Opens Live TV's More menu through its visible trigger. */
async function openMore(page: Page): Promise<void> {
  await click(page, `document.querySelector('[data-view="watch"] [aria-label="More"]')`);
  await waitFor(
    () => page.evaluate<boolean>(`!!${morePopup}?.querySelector("[data-item]")`),
    10_000,
  );
}

/** Checks the actual Sound row, so a trackless stream cannot pass with a broken old trigger probe. */
async function hasSound(page: Page): Promise<boolean> {
  await openMore(page);
  const offered = await page.evaluate<boolean>(`!!(${soundRow})`);
  await key(page, "Escape", 27);
  await delay(300);
  return offered;
}

function menuPopup(menu: "Sound" | "Subtitles"): string {
  return menu === "Sound"
    ? morePopup
    : `document.querySelector('[role="dialog"][aria-label^="Subtitles"]')`;
}

async function openMenu(page: Page, menu: "Sound" | "Subtitles"): Promise<string[]> {
  if (menu === "Sound") {
    await openMore(page);
    await click(page, soundRow);
  } else {
    await click(page, `document.querySelector('[data-view="watch"] [aria-label^="Subtitles"]')`);
  }
  const popup = menuPopup(menu);
  await waitFor(
    () => page.evaluate<boolean>(`!!${popup}?.querySelector("[aria-pressed]")`),
    10_000,
  );
  return page.evaluate<string[]>(
    `[...${popup}.querySelectorAll("[data-item][aria-pressed]")].map((item) =>
      (item.getAttribute("aria-pressed") === "true" ? "*" : "") + item.textContent.trim())`,
  );
}

/** Chooses `label` in the Sound or CC menu. */
async function choose(page: Page, menu: "Sound" | "Subtitles", label: string): Promise<void> {
  await openMenu(page, menu);
  const popup = menuPopup(menu);
  await click(
    page,
    `[...${popup}.querySelectorAll("[data-item][aria-pressed]")].find((item) => item.textContent.trim().startsWith(${JSON.stringify(label)}))`,
  );
  await delay(300);
}

/** Holds the picture at `seconds`, where the stream's lines are known. */
async function holdAt(page: Page, seconds: number): Promise<void> {
  await page.evaluate(`(() => {
    const video = document.querySelector("video");
    video.pause();
    video.currentTime = ${seconds};
  })()`);
  await waitFor(
    () =>
      page.evaluate<boolean>(`(() => {
        const video = document.querySelector("video");
        return !video.seeking && Math.abs(video.currentTime - ${seconds}) < 0.05;
      })()`),
    10_000,
  );
  await delay(300);
}

function resume(page: Page): Promise<void> {
  return page.evaluate(`void document.querySelector("video").play()`);
}

/** How often the host was asked for a path matching `pattern`. */
function asked(pattern: RegExp): number {
  return host.requests().filter((path) => pattern.test(path)).length;
}

async function listsTracks(page: Page): Promise<{ ok: boolean; detail: string }> {
  await play(page, PLAYLIST_CHANNELS.tracks.name);
  await waitFor(async () => (await playing(page)).sound > 0, 20_000).catch(() => {});
  await waitFor(async () => (await playing(page)).cc !== "absent", 15_000);
  await waitFor(async () => asked(/subtitles-fr\.vtt$/) > 0, 15_000);
  const sound = await choices(page, "Sound");
  const subtitles = await choices(page, "Subtitles");
  // Where "English line 3" of the stream's default subtitles would show.
  await holdAt(page, 5);
  const now = await playing(page);
  await resume(page);
  const ok =
    sound.join() === "*English,Español" &&
    subtitles.join() === "*Off,English,Deutsch,Français" &&
    now.cc === "off" &&
    now.lines.length === 0 &&
    now.sound > 0 &&
    asked(/subtitles-.*\.vtt$/) > 0 &&
    asked(/subtitles-.*\.vtt$/) <= 3 &&
    asked(/sound-es/) === 0;
  return {
    ok,
    detail: `Sound [${sound}], CC [${subtitles}], CC ${now.cc}, ${now.lines.length} lines at 5 s, ${now.sound} bytes of sound decoded, ${asked(/subtitles-/)} subtitle requests`,
  };
}

async function switchesSound(page: Page): Promise<{ ok: boolean; detail: string }> {
  const before = await playing(page);
  const opened = asked(/master\.m3u8$/);
  await choose(page, "Sound", "Español");
  await waitFor(async () => asked(/sound-es-\d+\.mpegts$/) > 0, 15_000).catch(() => {});
  await waitFor(async () => (await playing(page)).sound > before.sound, 15_000).catch(() => {});
  const after = await playing(page);
  const sound = await choices(page, "Sound");
  const ok =
    asked(/sound-es-\d+\.mpegts$/) > 0 &&
    asked(/master\.m3u8$/) === opened &&
    after.time > before.time &&
    after.sound > before.sound &&
    sound.join() === "English,*Español";
  return {
    ok,
    detail: `Sound [${sound}], ${asked(/sound-es-\d+\.mpegts$/)} Spanish segments loaded, the stream opened ${asked(/master\.m3u8$/) - opened} more times, clock ${before.time.toFixed(1)} to ${after.time.toFixed(1)} s, sound ${before.sound} to ${after.sound} bytes`,
  };
}

async function showsSubtitles(page: Page): Promise<{ ok: boolean; detail: string }> {
  // "English line 3" shows from 4.25 to 5.75 s.
  await holdAt(page, 5);
  await choose(page, "Subtitles", "English");
  await waitFor(async () => (await playing(page)).lines.length > 0, 15_000).catch(() => {});
  const english = await playing(page);
  const row = async () =>
    (await choices(page, "Subtitles")).find((choice) => choice.startsWith("*")) ?? "";
  const listed = await choices(page, "Subtitles");
  await choose(page, "Subtitles", "Deutsch");
  await waitFor(async () => (await playing(page)).lines.join().includes("Deutsche"), 15_000).catch(
    () => {},
  );
  const german = await playing(page);
  await key(page, "c", 67);
  await delay(500);
  const off = await playing(page);
  await key(page, "c", 67);
  await delay(500);
  // The lines read before come back, and nothing is left to load.
  const on = { row: await row(), ...(await playing(page)) };
  const between = await (async () => {
    // Between two lines nothing shows.
    await holdAt(page, 6);
    return playing(page);
  })();
  await resume(page);
  const ok =
    english.lines.join() === "English line 3" &&
    english.cc === "on" &&
    listed.join() === "Off,*English,Deutsch,Français" &&
    asked(/subtitles-fr\.vtt$/) > 0 &&
    german.lines.join() === "Deutsche Zeile 3" &&
    off.cc === "off" &&
    off.lines.length === 0 &&
    on.cc === "on" &&
    on.row === "*Deutsch" &&
    on.lines.join() === "Deutsche Zeile 3" &&
    between.lines.length === 0;
  return {
    ok,
    detail: `at 5 s "${english.lines}", CC [${listed}] after reading the empty French rendition, then "${german.lines}"; C: ${off.cc} with ${off.lines.length} lines, C: ${on.cc} "${on.row}" with "${on.lines}"; at 6 s ${between.lines.length} lines`,
  };
}

async function showsCaptions(page: Page): Promise<{ ok: boolean; detail: string }> {
  await play(page, PLAYLIST_CHANNELS.captions.name);
  // hls.js finds the captions as it reads the picture; CC shows from then on.
  await waitFor(async () => (await playing(page)).cc !== "absent", 15_000).catch(() => {});
  const soundOffered = await hasSound(page);
  const before = await playing(page);
  const listed = before.cc === "absent" ? [] : await choices(page, "Subtitles");
  // "HELLO CAPTIONS" shows from 1 to 3 s.
  await holdAt(page, 2);
  if (listed.length > 0) await choose(page, "Subtitles", "Captions");
  await waitFor(async () => (await playing(page)).lines.length > 0, 10_000).catch(() => {});
  const shown = await playing(page);
  await holdAt(page, 3.5);
  const after = await playing(page);
  // Stop, then the same channel: a new stream, whose picture tells of its captions only at their
  // first line.
  const stop = `document.querySelector('[data-view="watch"] [aria-label="Stop"]')`;
  await click(page, stop);
  await waitFor(() => page.evaluate<boolean>(`!${stop}`), 10_000);
  await play(page, PLAYLIST_CHANNELS.captions.name);
  await waitFor(async () => (await playing(page)).cc !== "absent", 15_000).catch(() => {});
  const reopened = await playing(page);
  const kept = reopened.cc === "absent" ? [] : await choices(page, "Subtitles");
  await holdAt(page, 2);
  await waitFor(async () => (await playing(page)).lines.length > 0, 10_000).catch(() => {});
  const again = await playing(page);
  const said = (lines: readonly string[]) => lines.join(" ").replace(/\s+/g, " ").trim();
  const ok =
    listed.join() === "*Off,Captions" &&
    !soundOffered &&
    shown.cc === "on" &&
    said(shown.lines) === "HELLO CAPTIONS" &&
    after.lines.length === 0 &&
    reopened.cc === "on" &&
    kept.join() === "Off,*Captions" &&
    // Said once: a line the stream before left behind would show beside the new one.
    said(again.lines) === "HELLO CAPTIONS";
  return {
    ok,
    detail: `CC [${listed}], at 2 s "${shown.lines.join(" | ")}", at 3.5 s ${after.lines.length} lines, Sound ${soundOffered ? "shown" : "hidden"}; after Stop and the same channel CC ${reopened.cc} [${kept}], at 2 s "${again.lines.join(" | ")}"`,
  };
}

async function carriesOver(page: Page): Promise<{ ok: boolean; detail: string }> {
  const english = asked(/sound-en-\d+\.mpegts$/);
  await play(page, PLAYLIST_CHANNELS.tracks.name);
  await waitFor(async () => (await playing(page)).cc === "on", 15_000).catch(() => {});
  // "Deutsche Zeile 5" shows from 8.25 to 9.75 s.
  await holdAt(page, 9);
  await waitFor(async () => (await playing(page)).lines.length > 0, 15_000).catch(() => {});
  const now = await playing(page);
  const sound = await choices(page, "Sound");
  const subtitles = await choices(page, "Subtitles");
  await choose(page, "Subtitles", "English");
  await waitFor(async () => (await playing(page)).lines.join() === "English line 5", 15_000).catch(
    () => {},
  );
  const switched = await playing(page);
  await resume(page);
  const ok =
    sound.join() === "English,*Español" &&
    subtitles.join() === "Off,English,*Deutsch,Français" &&
    switched.lines.join() === "English line 5" &&
    now.lines.join() === "Deutsche Zeile 5" &&
    asked(/sound-en-\d+\.mpegts$/) === english;
  return {
    ok,
    detail: `Sound [${sound}], CC [${subtitles}], at 9 s "${now.lines}", then English "${switched.lines}", ${asked(/sound-en-\d+\.mpegts$/) - english} English segments loaded`,
  };
}

async function plainStream(page: Page): Promise<{ ok: boolean; detail: string }> {
  await play(page, PLAYLIST_CHANNELS.plain.name);
  await delay(1500);
  const now = await playing(page);
  const soundOffered = await hasSound(page);
  return {
    ok: !soundOffered && now.cc === "absent" && now.lines.length === 0,
    detail: `Sound ${soundOffered ? "shown" : "hidden"}, CC ${now.cc}, ${now.lines.length} lines`,
  };
}

/** The account's favourite channels, by the playlist's ids, as the main process keeps them. */
function favourites(page: Page): Promise<string[]> {
  return page.evaluate<string[]>(
    `window.mrStreamer.invoke("viewing.get").then((viewing) => viewing.ok ? viewing.value.favourites.map((channel) => channel.id) : [])`,
  );
}

/** Stars the channel on screen, for the account to be recognised by later. */
async function favourite(page: Page): Promise<void> {
  await key(page, "s", 83);
  await waitFor(async () => (await favourites(page)).length === 1, 10_000);
}

/** Has the profile hold a link its keychain can't open, as after a reset keychain. */
function loseLink(): void {
  const path = join(profile, "subscription.json");
  const stored = JSON.parse(readFileSync(path, "utf8")) as { sealedLink: string };
  writeFileSync(path, JSON.stringify({ ...stored, sealedLink: "bm90IGEgc2VhbGVkIGxpbms=" }));
}

async function asksForLink(page: Page): Promise<{ ok: boolean; detail: string }> {
  const { host: from } = new URL(host.origin);
  // The app opens on the channels it had loaded, and says in Settings what it lacks.
  await waitFor(() => page.evaluate<boolean>("!!document.querySelector('header')"), 30_000);
  const kept = await favourites(page);
  await openSubscriptions(page);
  const row = subscriptionRow(from);
  const line = () =>
    page.evaluate<string>(`(${row})?.querySelector("button")?.textContent.trim() ?? ""`);
  await waitFor(async () => (await line()).includes("needs its link again"), 30_000).catch(
    () => {},
  );
  const listed = await line();
  await click(page, buttonNamed("Enter link", `(${row})`));
  await waitFor(() => page.evaluate<boolean>("!!document.querySelector('form input')"), 10_000);
  const asking = await page.evaluate<{
    line: string;
    fields: string[];
    focused: boolean;
    page: string;
  }>(`(() => {
    const fields = [...document.querySelectorAll("form input")];
    return {
      line: document.querySelector("form p")?.textContent ?? "",
      fields: fields.map((field) => field.value),
      focused: document.activeElement === fields[0],
      page: document.body.innerText,
    };
  })()`);
  await fill(page, [host.link]);
  await waitFor(
    async () => (await line()) !== "" && !(await line()).includes("needs"),
    30_000,
  ).catch(() => {});
  const repaired = await line();
  const after = await favourites(page);
  const ok =
    listed.startsWith(`${from} · M3U · needs its link again`) &&
    asking.line === `Your keychain no longer gives Mr. Streamer the saved link from ${from}.` &&
    asking.fields.join("|") === "" &&
    asking.fields.length === 1 &&
    asking.focused &&
    !/t0k3n|playlist\.m3u|password/i.test(asking.page) &&
    repaired.startsWith(`${from} · M3U`) &&
    !repaired.includes("needs") &&
    kept.length === 1 &&
    after.length === 1;
  return {
    ok,
    detail: `"${listed}", ${asking.fields.length} empty field${asking.focused ? " with the cursor" : ""}, the host named ${asking.line.includes(from) ? "alone" : "wrongly"}, then "${repaired}", ${kept.length} favourite before and ${after.length} after the same link`,
  };
}
