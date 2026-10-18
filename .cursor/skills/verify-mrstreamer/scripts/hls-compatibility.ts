import { airedProgramme } from "./catchup.ts";
import type { Driver } from "./language.ts";

const video = `(() => { const v = document.querySelector('video'); return { time: v?.currentTime ?? 0, width: v?.videoWidth ?? 0, audio: v?.webkitAudioDecodedByteCount ?? 0, frames: v?.webkitDecodedFrameCount ?? 0, dropped: v?.webkitDroppedFrameCount ?? 0, paused: v?.paused ?? true, text: document.querySelector('[data-view=watch]')?.innerText ?? '' }; })()`;
interface Playing {
  time: number;
  width: number;
  audio: number;
  frames: number;
  dropped: number;
  paused: boolean;
  text: string;
}

/** Drive real search and Watch. The baseline observes the unchanged built app's rejected decode. */
export async function hlsCompatibilityScenario(
  d: Pick<
    Driver,
    "observed" | "evaluate" | "send" | "wait" | "exists" | "click" | "key" | "capture"
  >,
  baseline: boolean,
) {
  await d.click("Search channels", "document.querySelector('[aria-label=Search]')");
  await d.send("Input.insertText", { text: "TEST | HLS epochs" });
  await d.wait(() =>
    d.exists(`document.querySelector('[aria-label="Search results"] [aria-selected=true]')`),
  );
  await d.click(
    "Play the searched HLS channel",
    `document.querySelector('[aria-label="Search results"] [aria-selected=true] button[data-group-row]')`,
  );
  if (baseline) {
    await d.wait(
      async () =>
        /cannot|couldn't|could not|can't|unsupported|play/i.test(
          (await d.evaluate<Playing>(video)).text,
        ) && (await d.evaluate<Playing>(video)).width === 0,
    );
    // Retain enough time for the existing single repair progression to finish.
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const state = await d.evaluate<Playing>(video);
    d.observed["incompatibleBaseline"] = state;
    if (state.width || state.audio)
      throw new Error("The incompatible baseline decoded unexpectedly.");
    await d.capture("hls-incompatible-baseline");
    return;
  }
  await d.wait(async () => {
    const v = await d.evaluate<Playing>(video);
    return v.time > 1 && v.width > 0 && v.audio > 0 && !/Tuning|Reconnecting/.test(v.text);
  });
  d.observed["firstEpoch"] = await d.evaluate<Playing>(video);
  await d.capture("hls-first-epoch");
  await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 800, y: 700 });
  await d.click("Open converted HLS subtitles", "document.querySelector('[aria-label=Subtitles]')");
  await d.click(
    "Choose the embedded CEA-608 captions",
    "[...document.querySelectorAll('[data-item]')].find(b => b.textContent.trim() === 'Captions')",
  );
  const caption = "document.querySelector('[data-subtitle-text]')?.innerText?.trim() ?? ''";
  await d.wait(async () => {
    const v = await d.evaluate<Playing>(video);
    return v.time < 6 && (await d.evaluate<string>(caption)) === "HELLO CAPTIONS";
  });
  d.observed["captionBeforeEpoch"] = {
    ...(await d.evaluate<Playing>(video)),
    cue: await d.evaluate<string>(caption),
  };
  await d.capture("hls-captions-before-epoch");
  const samples: Playing[] = [];
  d.observed["epochSamples"] = samples;
  await d.wait(async () => {
    const v = await d.evaluate<Playing>(video);
    samples.push(v);
    return (
      v.time > 8 &&
      v.frames > 175 &&
      v.audio > 0 &&
      (await d.evaluate<string>(caption)) === "HELLO CAPTIONS"
    );
  });
  d.observed["afterEpoch"] = await d.evaluate<Playing>(video);
  await d.capture("hls-after-epoch");
  d.observed["captionAfterEpoch"] = {
    ...(await d.evaluate<Playing>(video)),
    cue: await d.evaluate<string>(caption),
  };
  await d.capture("hls-captions-after-epoch");
  await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 800, y: 700 });
  await d.click("Open More", "document.querySelector('[aria-label=More]')");
  await d.click("Open Sound", "document.querySelector('[role=dialog] [aria-label=Sound]')");
  await d.click(
    "Choose Dutch sound",
    "[...document.querySelectorAll('[data-item]')].find(b => b.textContent.includes('Nederlands'))",
  );
  await d.wait(async () => {
    const v = await d.evaluate<Playing>(video);
    return (
      v.time > 1 && v.time < 7 && v.width > 0 && v.audio > 0 && !/Tuning|Reconnecting/.test(v.text)
    );
  });
  d.observed["switchedSound"] = await d.evaluate<Playing>(video);
  await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 800, y: 700 });
  await d.click("Inspect the selected sound", "document.querySelector('[aria-label=More]')");
  await d.click("Inspect Sound", "document.querySelector('[role=dialog] [aria-label=Sound]')");
  const selectedSound = await d.evaluate<string>(
    "document.querySelector('[role=dialog] [data-item][aria-pressed=true]')?.textContent ?? ''",
  );
  d.observed["selectedSound"] = selectedSound;
  if (!selectedSound.includes("Nederlands")) throw new Error("Dutch sound was not selected.");
  await d.capture("hls-switched-sound");
  await d.key("Escape", 27);
  await d.click("Stop the converted stream", "document.querySelector('[aria-label=Stop]')");
  await d.wait(async () => (await d.evaluate<Playing>(video)).paused);
  d.observed["stopped"] = await d.evaluate<Playing>(video);
  await d.click("Watch the channel again", "document.querySelector('[aria-label=Watch]')");
  await d.wait(async () => {
    const v = await d.evaluate<Playing>(video);
    return (
      v.time > 1 && v.width > 0 && v.audio > 0 && !v.paused && !/Tuning|Reconnecting/.test(v.text)
    );
  });
  d.observed["recovered"] = await d.evaluate<Playing>(video);
  await d.capture("hls-recovered");
}

/** An aired recording crosses changed-PCR epochs and stops at its requested minute. */
export async function hlsCompatibilityCatchupScenario(d: Driver) {
  const aired = await airedProgramme(d, "Test", "HLS archive");
  await aired.play();
  await d.wait(async () => {
    const v = await d.evaluate<Playing>(video);
    return v.time > 6.5 && v.frames > 175 && v.audio > 0;
  });
  d.observed["archiveAfterEpoch"] = await d.evaluate<Playing>(video);
  await aired.wake();
  await d.capture("hls-catchup-after-epoch");
  // Programmes are at least a minute in the guide. Observe ordinary progress through that
  // minute, using the same per-observation deadline as the other real-clock checks.
  for (const until of [15, 30, 45, 58]) {
    await d.wait(async () => (await d.evaluate<Playing>(video)).time >= until);
  }
  await d.wait(() => d.exists("document.querySelector('[data-view=watch] [aria-label=Watch]')"));
  d.observed["archiveStopped"] = await d.evaluate<Playing>(video);
  await aired.wake();
  await d.capture("hls-catchup-ended");
}
