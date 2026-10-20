// Saved delays through Settings and actual media-ended events in an isolated built app.
import type { Preferences } from "../../../../packages/contracts/src/preferences.ts";
import {
  LANGUAGE_NAMES,
  LOCALES,
  type Locale,
} from "../../../../packages/contracts/src/language.ts";
import { translate } from "../../../../packages/core/src/i18n.ts";
import type { Driver } from "./language.ts";

const named = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;
const AUTOPLAY = `document.querySelector('[role=checkbox][aria-label="Next episode"]')`;
const LANGUAGE = `document.querySelector('main section select:has(option[value="en-US"])')`;
const expect = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

export async function nextEpisodeScenario(
  d: Driver,
  files: () => { requests: number; mostAtOnce: number; streams: number; active: number },
): Promise<void> {
  let locale: Locale = "en-US";
  const delay = () =>
    `document.querySelector(${JSON.stringify(`input[aria-label="${translate(locale, "Next episode delay")}"]`)})`;
  const preferences = () =>
    d.evaluate<Preferences>(`(async () => {
      const reply = await window.mrStreamer.invoke('preferences.get');
      if (!reply.ok) throw new Error('Preferences read failed');
      return reply.value.preferences;
    })()`);
  const endText = () => d.evaluate<string>("document.body.innerText");
  const media = () =>
    d.evaluate(`(() => {
      const video = document.querySelector('video');
      return { position: video.currentTime, duration: video.duration, width: video.videoWidth,
        decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames,
        decodedAudioBytes: video.webkitAudioDecodedByteCount };
    })()`);
  const remaining = async () => /Plays in (\d+)/.exec(await endText())?.[1] ?? null;
  const openSettings = async () => {
    d.action("Open Settings with the application shortcut");
    const modifiers = process.platform === "darwin" ? 4 : 2;
    await d.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: ",",
      windowsVirtualKeyCode: 188,
      modifiers,
    });
    await d.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: ",",
      windowsVirtualKeyCode: 188,
      modifiers,
    });
    await d.click("Open Playback settings", named("nav button", translate(locale, "Playback")));
    await d.wait(() => d.exists(delay()));
  };
  const setDelay = async (seconds: number) => {
    await d.wait(() => d.evaluate<boolean>(`!!${delay()} && !${delay()}.disabled`));
    await d.click(`Edit the delay to ${seconds}`, delay());
    await d.wait(() => d.evaluate<boolean>(`document.activeElement === ${delay()}`));
    // Select the field text through the native editing shortcut.
    await d.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      windowsVirtualKeyCode: 65,
      modifiers: process.platform === "darwin" ? 4 : 2,
      // CDP's macOS key injection needs the native editing command as well as Command-A.
      commands: ["selectAll"],
    });
    await d.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      windowsVirtualKeyCode: 65,
      modifiers: process.platform === "darwin" ? 4 : 2,
    });
    await d.send("Input.insertText", { text: String(seconds) });
    d.observed[`delay-input-${seconds}`] = await d.evaluate(`({
      value: ${delay()}.value, focused: document.activeElement === ${delay()}
    })`);
    await d.key("Enter", 13);
    await d.wait(async () => (await preferences()).nextEpisodeDelaySeconds === seconds);
    await d.wait(() =>
      d.evaluate<boolean>(`(() => {
        const field = ${delay()};
        return field?.value === ${JSON.stringify(String(seconds))} && !field.disabled &&
          field.closest('section').innerText.includes(${JSON.stringify(translate(locale, "Instant"))}) === ${seconds === 0};
      })()`),
    );
  };
  const closeSettings = async () => {
    await d.key("Escape", 27);
    if (await d.exists(delay()))
      await d.click(
        "Close Settings with Back after cancelling delay editing",
        named('[data-view="settings"] header button', translate(locale, "Back")),
      );
    await d.wait(async () => !(await d.exists(delay())));
  };
  const pickLocale = async (next: Locale) => {
    await d.click("Open General settings", named("nav button", translate(locale, "General")));
    d.action(`Pick ${next} through Interface language`);
    await d.evaluate(`${LANGUAGE}.focus()`);
    // Native select type-ahead commits a single choice without intermediate language writes.
    for (const char of LANGUAGE_NAMES[next].slice(0, 2)) {
      await d.send("Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char });
      await d.send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
    }
    await d.wait(() =>
      d.evaluate<boolean>(`document.documentElement.lang === ${JSON.stringify(next)}`),
    );
    locale = next;
    await d.click(
      "Return to Playback settings",
      named("nav button", translate(locale, "Playback")),
    );
    await d.wait(() => d.exists(delay()));
  };
  const playEpisode = async (episode: string) => {
    // Leaving playback returns to its still-open details, whose modal hides top navigation.
    if (!(await d.exists("document.querySelector('[role=dialog]')"))) {
      await d.click("Open Series", named("header button", "Series"));
      await d.click("Open All series", named("nav button", "All series"));
      await d.click(
        "Open Formats details",
        `[...document.querySelectorAll('button[title]')].find(e => e.title.includes('Formats'))`,
      );
    }
    // Automatic prefers English, whose fixture has only one season. Choose the complete
    // Dutch version through the same menu a viewer uses, keeping the cross-season path real.
    await d.click(
      "Open series versions",
      `document.querySelector('[role=dialog] button[aria-label=Versions]')`,
    );
    await d.click(
      "Choose the two-season Dutch fixture",
      `[...document.querySelectorAll('[role=menuitemradio]')].find(e => e.getAttribute('aria-label')?.includes('Formats (NL)'))`,
    );
    const season = Number(/^S(\d+)/.exec(episode)?.[1]);
    // The provider supplies season one's Dutch name and omits season two's name.
    await d.click(
      `Open season ${season}`,
      named("[role=dialog] button", season === 1 ? "Seizoen 1" : `Season ${season}`),
    );
    await d.click(
      `Play ${episode}`,
      `document.querySelector('[aria-label="More for ${episode}"]')?.closest('.group')?.querySelector('button')`,
    );
    await d.wait(() =>
      d.evaluate<boolean>(`(() => {
      const video = document.querySelector('video');
      return video?.videoWidth > 0 && video.currentTime > 0 &&
        document.querySelector('[data-view=title]')?.innerText.includes(${JSON.stringify(episode)});
    })()`),
    );
    d.observed[`playing-${episode}`] = {
      media: await media(),
      files: files(),
    };
  };
  const seekEnd = async () => {
    const focused = () =>
      d.evaluate<boolean>(
        `document.activeElement?.matches('input[type=range][aria-label=Position]') ?? false`,
      );
    // Base UI's native range has an implicit slider role. Pointer release deliberately blurs
    // it, so reach it with Tab before using its End key, as a keyboard viewer does.
    for (let tabs = 0; tabs < 24 && !(await focused()); tabs++) await d.key("Tab", 9);
    expect(await focused(), "Keyboard could not reach the Position scrubber");
    await d.key("End", 35);
  };
  const waitEnded = (episode: string) =>
    d.wait(async () => (await endText()).includes(`Finished ${episode}`));
  const waitNext = async (episode: string) => {
    await d.wait(() =>
      d.evaluate<boolean>(`(() => {
        const video = document.querySelector('video');
        const text = document.querySelector('[data-view=title]')?.innerText ?? '';
        return text.includes(${JSON.stringify(episode)}) && !text.includes('Finished') &&
          !text.includes('Starting') && video?.videoWidth > 0 && video.currentTime > 0 &&
          !video.paused && video.getVideoPlaybackQuality().totalVideoFrames > 0;
      })()`),
    );
    d.observed[`next-playing-${episode}`] = {
      media: await media(),
      files: files(),
    };
  };

  await openSettings();
  await setDelay(0);
  await d.capture("instant-settings");
  await closeSettings();
  await playEpisode("S1 E1");
  await seekEnd();
  await openSettings();
  await waitEnded("S1 E1");
  const instantFiles = files();
  // The real video ended behind Settings. Its next episode must wait for release.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(files().requests === instantFiles.requests, "Instant opened behind Settings");
  expect((await endText()).includes("Next episode"), "Held Instant has no Next episode action");
  expect(!(await endText()).includes("Plays in 0"), "Held Instant displays a zero countdown");
  await d.capture("instant-held");
  const releasedAt = Date.now();
  await closeSettings();
  await d.wait(() =>
    d.evaluate<boolean>(
      `document.querySelector('[data-view=title]')?.innerText.includes('S1 E2') && !document.body.innerText.includes('Finished')`,
    ),
  );
  const releaseToNextUiMs = Date.now() - releasedAt;
  await waitNext("S1 E2");
  expect(files().requests > instantFiles.requests, "Instant never opened the next provider file");
  d.observed["instant"] = {
    releaseToNextUiMs,
    releaseToPlayingMs: Date.now() - releasedAt,
    before: instantFiles,
    after: files(),
  };
  await d.capture("instant-next");
  await d.key("Escape", 27);

  await openSettings();
  await setDelay(37);
  await closeSettings();
  await playEpisode("S1 E2");
  await seekEnd();
  await waitEnded("S1 E2");
  await d.wait(async () => (await remaining()) !== null);
  const customInitial = Number(await remaining());
  expect(customInitial <= 37 && customInitial >= 35, "Custom delay is not 37 seconds");
  await d.capture("custom-37-countdown");
  await openSettings();
  const held = await remaining();
  await setDelay(60);
  await d.click("Turn autoplay off while held", AUTOPLAY);
  await d.wait(async () => (await preferences()).autoplayNext === false);
  await d.click("Turn autoplay back on while held", AUTOPLAY);
  await d.wait(async () => (await preferences()).autoplayNext === true);
  expect((await remaining()) === held, "Settings changed the saved remaining seconds");
  await d.capture("custom-held-edited-to-60");
  await closeSettings();
  expect((await remaining()) === held, "Release replaced the saved delay");
  await d.wait(async () => Number(await remaining()) < Number(held));
  await d.click("Cancel the countdown", named("button", "Cancel"));
  const cancelledFiles = files();
  await openSettings();
  await closeSettings();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect((await remaining()) === null, "Cancelled countdown restarted");
  expect(files().requests === cancelledFiles.requests, "Cancel opened the next file");
  await d.capture("custom-cancelled");
  await d.key("n", 78);
  await waitNext("S1 E3");
  expect(
    files().requests > cancelledFiles.requests,
    "Manual N never opened the next provider file",
  );
  await d.capture("manual-next-playing");
  d.observed["custom37"] = {
    initial: customInitial,
    held,
    cancelledFiles,
    manualNextFiles: files(),
  };
  await d.key("Escape", 27);

  await playEpisode("S2 E1");
  await seekEnd();
  await waitEnded("S2 E1");
  await d.wait(async () => (await remaining()) !== null);
  const maximumInitial = Number(await remaining());
  expect(maximumInitial <= 60 && maximumInitial >= 58, "The next countdown did not use 60 seconds");
  await d.capture("maximum-60-countdown");
  await openSettings();
  const languages: Record<string, unknown> = {};
  for (const next of LOCALES) {
    await pickLocale(next);
    await setDelay(0);
    const instant = await d.evaluate<string>(`${delay()}.closest('section').innerText`);
    expect(instant.includes(translate(locale, "Instant")), `Missing Instant in ${locale}`);
    expect(instant.includes(translate(locale, "seconds")), `Missing seconds in ${locale}`);
    await d.capture(`instant-settings-${locale}`);
    await setDelay(60);
    await d.capture(`maximum-settings-${locale}`);
    await closeSettings();
    const labels = await d.evaluate<string[]>(
      `[...document.querySelectorAll('[data-view=title] span')].map(e => e.textContent.trim())`,
    );
    const countdown = Array.from({ length: 60 }, (_, index) =>
      translate(locale, "Plays in {seconds}", { seconds: index + 1 }),
    ).find((label) => labels.includes(label));
    expect(countdown !== undefined, `Missing localized countdown in ${locale}`);
    await d.capture(`countdown-${locale}`);
    languages[locale] = {
      instant,
      countdown,
      nextDelay: (await preferences()).nextEpisodeDelaySeconds,
    };
    await openSettings();
  }
  await pickLocale("en-US");
  d.observed["languages"] = languages;
  await d.click("Turn autoplay off for final release", AUTOPLAY);
  await d.wait(async () => (await preferences()).autoplayNext === false);
  await closeSettings();
  await d.wait(async () => (await remaining()) === null);
  const offFiles = files();
  await openSettings();
  await d.click("Enable autoplay after cancellation", AUTOPLAY);
  await d.wait(async () => (await preferences()).autoplayNext === true);
  await closeSettings();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect((await remaining()) === null, "Final Off cancellation restarted after On");
  expect(files().requests === offFiles.requests, "Final Off opened another file");
  await d.capture("maximum-final-off");
  d.observed["maximum60"] = {
    initial: maximumInitial,
    finalOffFiles: offFiles,
    afterOnFiles: files(),
  };

  // Exercise the shared-media handoff through real controls, including a held next episode.
  await d.key("Escape", 27);
  await playEpisode("S1 E1");
  await seekEnd();
  await openSettings();
  await waitEnded("S1 E1");
  const handoffHeld = files();
  await d.capture("handoff-countdown-held");
  await closeSettings();
  d.action("Open global Search over the ended episode");
  for (const type of ["rawKeyDown", "keyUp"])
    await d.send("Input.dispatchKeyEvent", {
      type,
      key: "k",
      windowsVirtualKeyCode: 75,
      modifiers: process.platform === "darwin" ? 4 : 2,
    });
  await d.wait(() =>
    d.evaluate<boolean>("document.activeElement?.getAttribute('role') === 'combobox'"),
  );
  await d.send("Input.insertText", { text: "TEST | H.264 + AAC" });
  await d.wait(() =>
    d.evaluate<boolean>(
      `document.querySelector('[aria-label="Search results"] [aria-selected=true]')?.textContent.includes('H.264 + AAC') ?? false`,
    ),
  );
  await d.key("Enter", 13);
  await d.wait(() =>
    d.evaluate<boolean>(`!!document.querySelector('[data-view=watch]') &&
      !document.querySelector('[data-view=title]') && document.querySelector('video')?.videoWidth > 0 &&
      document.querySelector('video').currentTime > 0.5`),
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(
    files().requests === handoffHeld.requests,
    "The cancelled episode opened after live takeover",
  );
  const handoffLive = files();
  await d.capture("handoff-title-to-live");
  // Retain DOM references only to observe identity as Picture moves the existing nodes.
  await d.evaluate(`(() => {
    window.__handoffNodes = { video: document.querySelector('video'),
      subtitles: document.querySelector('[data-subtitles]') };
  })()`);
  await d.key("Escape", 27);
  if (await d.exists("document.querySelector('[role=dialog]')")) await d.key("Escape", 27);
  await d.click("Return to Home's live preview", named("header button", "Home"));
  await d.wait(() =>
    d.evaluate<boolean>(`document.querySelector('video')?.muted &&
      !document.querySelector('video').paused && document.querySelector('video').currentTime > 0.5`),
  );
  // Escape returned to Series, where previews are suspended. Home starts the retained channel again.
  const homePreview = files();
  expect(homePreview.active === 1, "Home did not resume one preview reader");
  await d.capture("handoff-home-preview");
  await d.click("Open Movies from the preview", named("header button", "Movies"));
  await d.click("Open All movies", named("nav button", "All movies"));
  await d.click(
    "Open the two-track movie",
    `[...document.querySelectorAll('button[title]')].find(e => e.title.includes('Two sound tracks'))`,
  );
  await d.click("Play the movie over the preview", named('[role="dialog"] button', "Play"));
  await d.wait(() =>
    d.evaluate<boolean>(`!!document.querySelector('[data-view=title]') &&
      document.querySelector('video')?.videoWidth > 0 && document.querySelector('video').currentTime > 0.5`),
  );
  await d.capture("handoff-preview-to-movie");
  const movieMedia = await media();
  const normalWidth = await d.evaluate<number>("innerWidth");
  await d.key("p", 80);
  await d.wait(() => d.exists("document.querySelector('[data-view=title][data-mini]')"));
  await d.capture("handoff-movie-mini");
  await d.key("Escape", 27);
  await d.wait(
    async () => !(await d.exists("document.querySelector('[data-view=title][data-mini]')")),
  );
  await d.wait(() => d.evaluate<boolean>(`innerWidth === ${normalWidth}`));
  await d.evaluate(`(() => {
    window.__handoffFullScreen = { value: false, events: [] };
    window.__handoffStopFullScreen = window.mrStreamer.on('window.fullScreen', value => {
      window.__handoffFullScreen.value = value;
      window.__handoffFullScreen.events.push({ value, at: Date.now() });
    });
  })()`);
  await d.key("f", 70);
  await d.wait(() => d.evaluate<boolean>("!!document.fullscreenElement"));
  // macOS reports DOM fullscreen before its native window transition has finished.
  if (process.platform === "darwin")
    await d.wait(() => d.evaluate<boolean>("window.__handoffFullScreen.value"));
  await d.capture("handoff-movie-fullscreen");
  await d.key("Escape", 27);
  await d.wait(() => d.evaluate<boolean>("!document.fullscreenElement"));
  if (process.platform === "darwin")
    await d.wait(() => d.evaluate<boolean>("!window.__handoffFullScreen.value"));
  d.observed["handoff-fullscreen-events"] = await d.evaluate("window.__handoffFullScreen.events");
  await d.evaluate(`(() => {
    window.__handoffStopFullScreen();
    delete window.__handoffStopFullScreen;
    delete window.__handoffFullScreen;
  })()`);
  const sameNodes =
    await d.evaluate<boolean>(`window.__handoffNodes.video === document.querySelector('video') &&
    window.__handoffNodes.subtitles === document.querySelector('[data-subtitles]')`);
  expect(sameNodes, "The handoff or window movement replaced a media node");
  await d.key("Escape", 27);
  if (await d.exists("document.querySelector('[role=dialog]')")) await d.key("Escape", 27);
  await d.click("Return to preview after closing the movie", named("header button", "Home"));
  await d.wait(() =>
    d.evaluate<boolean>(`!document.querySelector('[data-view=title]') &&
      document.querySelector('video')?.muted && !document.querySelector('video').paused &&
      document.querySelector('video').currentTime > 0.5`),
  );
  await d.capture("handoff-movie-to-preview");
  expect(
    files().active === 1,
    "Returning to the preview did not leave exactly one provider reader",
  );
  d.observed["handoff"] = {
    held: handoffHeld,
    live: handoffLive,
    homePreview,
    movieMedia,
    sameNodes,
    final: files(),
  };
  await d.evaluate("delete window.__handoffNodes");
  d.observed["limits"] =
    "Source-build fake-provider UI proof. Native receivers, audible output and installed acceptance are separate. Session ordering and exact timings use the focused public controller tests; file requests include probing and ranges.";
}
