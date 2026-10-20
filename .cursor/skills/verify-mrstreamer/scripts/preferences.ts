import type { Driver } from "./language.ts";

const button = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
const audio = `document.querySelector('select[aria-label="Audio in"]')`;
const subtitles = `document.querySelector('select[aria-label="Subtitles"]')`;

/** Real Settings and player edits on the helper's disposable fake-provider profile. */
export async function preferencesScenario(d: Driver): Promise<void> {
  const openSettings = async () => {
    await d.wait(() => d.exists("document.querySelector('header button[aria-label=Settings]')"));
    await d.evaluate(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
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
    await d.click("Open Playback", button("nav button", "Playback"));
    await d.wait(() => d.exists(audio));
  };
  const pick = async (select: string, name: string) => {
    await d.evaluate(`${select}.focus()`);
    d.action(`Choose ${name} with native select typeahead`);
    for (const char of name.slice(0, 2)) {
      await d.send("Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char });
      await d.send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
    }
    await d.key("Tab", 9);
  };
  const saved = () =>
    d.evaluate<{
      revision: number;
      audio?: string;
      subtitles?: string;
      autoplay?: boolean;
    }>(`(async () => {
    const result = await window.mrStreamer.invoke('preferences.get');
    if (!result.ok) throw new Error('Cannot read fixture preferences');
    const { revision, preferences } = result.value;
    return { revision, audio: preferences.audioLanguage, subtitles: preferences.subtitleLanguage, autoplay: preferences.autoplayNext };
  })()`);

  await openSettings();
  await pick(audio, "Français");
  await d.wait(async () => (await saved()).audio === "fr");
  await d.capture("settings-french-audio");
  await d.key("Escape", 27);
  await d.click("Open Movies", button("header button", "Movies"));
  await d.click("Open All movies", button("nav button", "All movies"));
  await d.click(
    "Open the two-track movie",
    "[...document.querySelectorAll('button[title]')].find(b => b.title.includes('Two sound tracks'))",
  );
  await d.click("Play the movie", button('[role="dialog"] button', "Play"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "!!document.querySelector('[data-view=title]') && document.querySelector('video').currentTime > 0.5",
    ),
  );
  await d.evaluate(
    "document.querySelector('[data-view=title]').dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))",
  );
  await d.click(
    "Open Sound",
    "document.querySelector('[data-view=title] button[aria-label=Sound]')",
  );
  await d.click(
    "Choose the Spanish sound track",
    "[...document.querySelectorAll('button[data-item]')].find(b => b.textContent.includes('Español'))",
  );
  await d.wait(async () => (await saved()).audio === "es");
  await d.wait(() =>
    d.evaluate<boolean>(
      "(() => { const v = document.querySelector('video'); return !!v && !v.paused && v.readyState >= 2 && v.videoWidth > 0 && v.currentTime > 0.5 && v.getVideoPlaybackQuality().totalVideoFrames > 2; })()",
    ),
  );
  await d.capture("player-spanish-track");
  await openSettings();
  await d.wait(() => d.evaluate<boolean>(`${audio}.value === 'es'`));
  await d.capture("settings-player-track-current");

  // Independent controls use separate writes, without replacing the saved sound track.
  await d.click("Open Subtitles", button("nav button", "Subtitles"));
  await pick(subtitles, "Français");
  await d.click("Return to Playback", button("nav button", "Playback"));
  await d.click(
    "Turn next episode off",
    "document.querySelector('[role=checkbox][aria-label=\"Next episode\"]')",
  );
  await d.wait(async () => {
    const current = await saved();
    return current.audio === "es" && current.subtitles === "fr" && current.autoplay === false;
  });
  const before = await saved();
  d.observed["preferenceChoicesBeforeRestart"] = before;
  await d.capture("settings-independent-edits");
  await d.quit();
  await d.launch();
  await openSettings();
  await d.click("Open Subtitles after restart", button("nav button", "Subtitles"));
  await d.wait(() =>
    d.evaluate<boolean>(
      `${audio}.value === 'es' && ${subtitles}.value === 'fr' && document.querySelector('[role=checkbox][aria-label="Next episode"]').getAttribute('aria-checked') === 'false'`,
    ),
  );
  const after = await saved();
  if (
    after.audio !== before.audio ||
    after.subtitles !== before.subtitles ||
    after.autoplay !== before.autoplay
  )
    throw new Error("Independent preference choices did not survive restart");
  d.observed["preferenceChoicesAfterRestart"] = after;
  await d.capture("settings-choices-after-restart");
}
