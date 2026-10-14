// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { player } from "../../src/renderer/src/player/player.ts";
import { streams } from "./hls-stand-in.ts";
vi.mock("hls.js", async (original) => {
  const real = await original<typeof import("hls.js")>();
  const { standIn } = await import("./hls-stand-in.ts");
  return { default: standIn(real.default) };
});
const channel = (id: string): LiveChannel => ({
  subscriptionId: SUBSCRIPTION,
  id,
  name: id,
  title: id,
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  catchupDays: null,
  variants: [{ id, name: id, tags: [], quality: null }],
});
const wait = async () => {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise((resolve) => setTimeout(resolve));
};
async function open(id = "one") {
  ipc.always("playback.open", {
    sessionId: id,
    channel: { subscriptionId: SUBSCRIPTION, id },
    format: "hls",
    url: "http://127.0.0.1/fixture",
  });
  player.play(channel(id));
  await wait();
  const stream = streams.latest();
  stream.variant({
    subtitles: [
      { name: "English", lang: "en", default: true },
      { name: "Deutsch", lang: "de" },
    ],
  });
  player.element.dispatchEvent(new Event("playing"));
  await wait();
  return stream;
}
beforeEach(() => {
  player.reset();
  ipc.reset();
  player.element.currentTime = 0;
});
afterEach(() => {
  player.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("hides HLS renditions that have only an empty WebVTT segment", async () => {
  const stream = await open();
  stream.subtitleLines([], "English");
  await wait();
  expect(player.state().tracks?.subtitles).toEqual([]);
  player.toggleSubtitles();
  expect(player.state().subtitle).toBeNull();
});
it("discovers working renditions with CC off, retains all proven choices and draws none until chosen", async () => {
  const stream = await open();
  expect(stream.subtitleTrack).toBe(0);
  stream.subtitleLines([{ start: 0, end: 10, text: "Hello" }]);
  await wait();
  expect(player.state().tracks?.subtitles.map((track) => track.label)).toEqual([
    "English",
    "Deutsch",
  ]);
  expect(player.state().subtitle).toBeNull();
  expect(stream.subtitleTrack).toBe(1);
  stream.subtitleLines([{ start: 0, end: 10, text: "Hallo" }]);
  await wait();
  expect(player.state().tracks?.subtitles.map((track) => track.label)).toEqual([
    "English",
    "Deutsch",
  ]);
  expect(stream.subtitleTrack).toBe(-1);
  expect(ipc.argsOf("playback.open")).toHaveLength(1);
  player.toggleSubtitles();
  expect(player.state().subtitle?.label).toBe("English");
  player.setSubtitle(player.state().tracks!.subtitles[1]!);
  expect(player.state().subtitle?.label).toBe("Deutsch");
  player.toggleSubtitles();
  expect(player.state().subtitle).toBeNull();
});
it("tries the preferred language first and enables it only after a cue", async () => {
  ipc.prefer({ subtitleLanguage: "de" });
  const stream = await open();
  expect(stream.subtitleTrack).toBe(1);
  expect(player.state().subtitle).toBeNull();
  stream.subtitleLines([]);
  await wait();
  expect(player.state().subtitle).toBeNull();
  stream.subtitleLines([{ start: 0, end: 10, text: "Hallo" }], "Deutsch");
  await wait();
  expect(player.state().subtitle?.label).toBe("Deutsch");
  expect(stream.subtitleTrack).toBe(1);
  expect(ipc.argsOf("preferences.update")).toEqual([]);
});
it("keeps captions hidden until their picture data arrives and respects Off", async () => {
  ipc.prefer({ subtitleLanguage: "off" });
  const stream = await open();
  stream.manifest([{ name: "English", lang: "en", instreamId: "CC1" }]);
  stream.variant({});
  await wait();
  expect(player.state().tracks?.subtitles).toEqual([]);
  stream.captionLines(1, 1, 3, ["Hello"]);
  await wait();
  expect(player.state().tracks?.subtitles.map((track) => track.label)).toEqual(["English"]);
  expect(player.state().subtitle).toBeNull();
});
/** Advances a moving picture, so discovery is checked independently of stall recovery. */
async function playingFor(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    player.element.currentTime += 1;
    await vi.advanceTimersByTimeAsync(Math.min(1000, ms - elapsed));
  }
}
it("bounds stalled discovery to three probes per burst, retries later, and cancels on channel release", async () => {
  vi.useFakeTimers();
  const stream = await open();
  stream.variant({
    subtitles: Array.from({ length: 5 }, (_, id) => ({ name: `Language ${id}`, lang: `x${id}` })),
  });
  await wait();
  const before = stream.subtitlesLoaded.length;
  await playingFor(30_100);
  expect(stream.subtitleTrack).toBe(-1);
  expect(stream.subtitlesLoaded.length - before).toBeLessThanOrEqual(2);
  const atRest = stream.subtitlesLoaded.length;
  await playingFor(29_000);
  expect(stream.subtitlesLoaded).toHaveLength(atRest);
  await playingFor(1000);
  expect(stream.subtitlesLoaded.length).toBe(atRest + 1);
  player.reset();
  const atStop = stream.subtitlesLoaded.length;
  await playingFor(60_000);
  expect(stream.destroyed).toBe(true);
  expect(stream.subtitlesLoaded).toHaveLength(atStop);
});
it("never interrupts a selected rendition for discovery, and resumes when the viewer turns it off", async () => {
  vi.useFakeTimers();
  const stream = await open();
  stream.subtitleLines([{ start: 0, end: 10, text: "Hello" }]);
  await wait();
  player.setSubtitle(player.state().tracks!.subtitles[0]!);
  const before = stream.subtitlesLoaded.length;
  await playingFor(45_000);
  expect(stream.subtitleTrack).toBe(0);
  expect(stream.subtitlesLoaded).toHaveLength(before);
  player.toggleSubtitles();
  await wait();
  expect(stream.subtitleTrack).toBe(1);
  expect(player.state().subtitle).toBeNull();
});
it("accepts later cues without reopening and forgets proof on a different channel", async () => {
  const first = await open("first");
  first.subtitleLines([]);
  await wait();
  first.subtitleLines([{ start: 1, end: 3, text: "Later" }], "English");
  await wait();
  expect(player.state().tracks?.subtitles.map((track) => track.label)).toEqual([
    "English",
    "Deutsch",
  ]);
  expect(ipc.argsOf("playback.open")).toHaveLength(1);
  await open("second");
  first.subtitleLines([{ start: 1, end: 3, text: "Cancelled" }], "Deutsch");
  await wait();
  expect(player.state().tracks?.subtitles).toEqual([]);
  expect(player.state().subtitle).toBeNull();
});

it.each(["subtitle-playlist", "subtitle-segment"] as const)(
  "abandons a failed %s probe and keeps another declared language reachable",
  async (kind) => {
    vi.useFakeTimers();
    const stream = await open();
    stream.error(kind);
    await wait();
    expect(stream.loading).toBe(true);
    expect(stream.subtitleTrack).toBe(1);
    stream.subtitleLines([{ start: 0, end: 60, text: "Hallo" }]);
    await wait();
    expect(player.state().tracks?.subtitles.map((track) => track.label)).toEqual([
      "English",
      "Deutsch",
    ]);
    player.setSubtitle(player.state().tracks!.subtitles[0]!);
    stream.error(kind);
    await wait();
    expect(player.state().subtitle?.label).toBe("English");
    await playingFor(16_000);
    expect(player.state().subtitle).toBeNull();
    expect(player.state().subtitleLoading).toBe(false);
    player.setSubtitle(player.state().tracks!.subtitles[1]!);
    expect(player.state().subtitle?.label).toBe("Deutsch");
    await playingFor(2000);
    expect(player.state().phase.kind).toBe("playing");
    expect(ipc.argsOf("playback.open")).toHaveLength(1);
  },
);
it("keeps all HLS languages reachable while a remembered language is on", async () => {
  ipc.prefer({ subtitleLanguage: "de" });
  const stream = await open();
  stream.subtitleLines([{ start: 0, end: 60, text: "Hallo" }]);
  await wait();
  expect(player.state().subtitle?.label).toBe("Deutsch");
  expect(player.state().tracks?.subtitles.map((track) => track.label)).toEqual([
    "English",
    "Deutsch",
  ]);
  player.setSubtitle(player.state().tracks!.subtitles[0]!);
  stream.subtitleLines([{ start: 0, end: 60, text: "Hello" }]);
  await wait();
  expect(player.state().subtitle?.label).toBe("English");
});

it("waits for picture before discovery, permits a six-second reload, and retries a timed-out language", async () => {
  vi.useFakeTimers();
  ipc.prefer({ subtitleLanguage: "en" });
  // happy-dom fires playing from play() without decoding. Hold that event for this slow start.
  vi.spyOn(player.element, "play").mockResolvedValue();
  ipc.always("playback.open", {
    sessionId: "slow",
    channel: { subscriptionId: SUBSCRIPTION, id: "slow" },
    format: "hls",
    url: "http://127.0.0.1/fixture",
  });
  player.play(channel("slow"));
  await wait();
  const stream = streams.latest();
  stream.variant({ subtitles: [{ name: "English", lang: "en" }] });
  await vi.advanceTimersByTimeAsync(6000);
  expect(stream.subtitleTrack).toBe(-1);
  expect(player.state().subtitle).toBeNull();
  player.element.dispatchEvent(new Event("playing"));
  player.element.currentTime = 1;
  stream.subtitlePlaylist(6);
  await playingFor(6000);
  expect(stream.subtitleTrack).toBe(0);
  stream.subtitleDeferred();
  expect(stream.subtitleTrack).toBe(0);
  await playingFor(11_100);
  await playingFor(64_000);
  expect(stream.subtitlesLoaded.length).toBeGreaterThan(3);
  stream.subtitleLines([{ start: 0, end: 200, text: "Recovered" }], "English");
  await wait();
  expect(player.state().subtitle?.label).toBe("English");
  stream.subtitleDeferred(true);
  await playingFor(18_000);
  expect(player.state().subtitle?.label).toBe("English");
  expect(ipc.argsOf("playback.open")).toHaveLength(1);
});
it("ignores internal abort notices on Off, language switches and replaced probes", async () => {
  const stream = await open();
  stream.subtitleLines([{ start: 0, end: 60, text: "Hello" }], "English");
  await wait();
  player.setSubtitle(player.state().tracks!.subtitles[0]!);
  stream.subtitleAborted("Deutsch");
  expect(player.state().subtitle?.label).toBe("English");
  player.setSubtitle(player.state().tracks!.subtitles[1]!);
  stream.subtitleAborted("English");
  expect(player.state().subtitle?.label).toBe("Deutsch");
  player.toggleSubtitles();
  stream.subtitleAborted("Deutsch");
  expect(player.state().subtitle).toBeNull();
  expect(stream.loading).toBe(true);
  expect(ipc.argsOf("playback.open")).toHaveLength(1);
});

it("keeps a selected language through one nonfatal failure, but bounds repeated unreadable data", async () => {
  vi.useFakeTimers();
  const stream = await open();
  stream.subtitleLines([{ start: 0, end: 60, text: "Hello" }]);
  await wait();
  player.setSubtitle(player.state().tracks!.subtitles[0]!);
  stream.error("subtitle-segment", false);
  stream.subtitleUnreadable();
  expect(player.state().subtitle?.label).toBe("English");
  stream.subtitleLines([{ start: 0, end: 60, text: "Recovered" }]);
  await playingFor(16_000);
  expect(player.state().subtitle?.label).toBe("English");
  stream.subtitleUnreadable();
  await playingFor(16_000);
  expect(player.state().subtitle).toBeNull();
  expect(ipc.argsOf("playback.open")).toHaveLength(1);
});

it("ends real failed discovery for the stream, while a manual pick may retry it", async () => {
  vi.useFakeTimers();
  const stream = await open();
  stream.error("subtitle-segment");
  await wait();
  stream.subtitleLines([{ start: 0, end: 200, text: "Hallo" }]);
  await wait();
  const loaded = stream.subtitlesLoaded.length;
  await playingFor(70_000);
  expect(stream.subtitlesLoaded).toHaveLength(loaded);
  expect(player.state().subtitle).toBeNull();
  expect(player.state().phase.kind).toBe("playing");
  player.setSubtitle(player.state().tracks!.subtitles[0]!);
  expect(stream.subtitleTrack).toBe(0);
  stream.subtitleLines([{ start: 70, end: 90, text: "Manual retry" }]);
  expect(player.state().subtitle?.label).toBe("English");
});

it("keeps a selected language through a real fatal 404 and cancels recovery on Off", async () => {
  vi.useFakeTimers();
  const stream = await open();
  stream.subtitleLines([{ start: 0, end: 60, text: "Hello" }]);
  await wait();
  player.setSubtitle(player.state().tracks!.subtitles[0]!);
  stream.subtitlePlaylist(6);
  stream.error("subtitle-segment");
  expect(player.state().subtitle?.label).toBe("English");
  expect(stream.subtitleTrack).toBe(-1);
  expect(stream.loading).toBe(true);
  await playingFor(5900);
  expect(stream.subtitleTrack).toBe(-1);
  await playingFor(100);
  expect(stream.subtitleTrack).toBe(0);
  stream.subtitleLines([{ start: 6, end: 200, text: "Recovered" }]);
  await playingFor(18_000);
  expect(player.state().subtitle?.label).toBe("English");
  stream.error("subtitle-segment");
  player.toggleSubtitles();
  await playingFor(7000);
  expect(player.state().subtitle).toBeNull();
  expect(stream.subtitleTrack).not.toBe(0);
  expect(ipc.argsOf("playback.open")).toHaveLength(1);
});

it("preserves a selected language through an outage that reconnects within its allowance", async () => {
  vi.useFakeTimers();
  player.setAudible(true);
  const stream = await open();
  stream.subtitleLines([{ start: 0, end: 60, text: "Hello" }]);
  await wait();
  player.setSubtitle(player.state().tracks!.subtitles[0]!);
  stream.subtitlePlaylist(6);
  stream.error("subtitle-segment");
  await playingFor(2000);
  ipc.always("playback.failure", null);
  ipc.always("playback.playing", null);
  stream.error("video");
  await wait();
  expect(player.state().phase.kind).toBe("reconnecting");
  expect(player.state().subtitle?.label).toBe("English");
  await playingFor(6000);
  const reopened = streams.latest();
  reopened.variant({ subtitles: [{ name: "English", lang: "en", default: true }] });
  player.element.dispatchEvent(new Event("playing"));
  await wait();
  reopened.subtitleLines([{ start: 0, end: 200, text: "Back" }]);
  expect(player.state().subtitle?.label).toBe("English");
  expect(player.state().phase.kind).toBe("playing");
});

/** The selected rendition's 17s allowance expires before the picture fails at +27s. */
async function expiredSelection() {
  player.setAudible(true);
  const stream = await open();
  ipc.always("playback.failure", null);
  ipc.always("playback.playing", null);
  stream.subtitleLines([{ start: 0, end: 600, text: "Hello" }]);
  await wait();
  player.setSubtitle(player.state().tracks!.subtitles[0]!);
  stream.subtitlePlaylist(6);
  for (const _ of [0, 6, 12]) {
    stream.error("subtitle-segment", true, "English");
    await playingFor(6000);
  }
  expect(player.state().subtitle).toBeNull();
  expect(player.state().phase.kind).toBe("playing");
  return stream;
}

it.each(["restore", "off", "other language"] as const)(
  "after a segment-only outage expires the choice, reconnect respects %s",
  async (choice) => {
    vi.useFakeTimers();
    const first = await expiredSelection();
    if (choice === "off") player.setSubtitle(null);
    if (choice === "other language") player.setSubtitle(player.state().tracks!.subtitles[1]!);
    await playingFor(9000);
    first.error("video");
    await wait();
    expect(player.state().phase.kind).toBe("reconnecting");
    await playingFor(6000);
    const reopened = streams.latest();
    reopened.variant({
      subtitles: [
        { name: "English", lang: "en", default: true },
        { name: "Deutsch", lang: "de" },
      ],
    });
    player.element.dispatchEvent(new Event("playing"));
    await wait();
    reopened.subtitleLines([{ start: 0, end: 600, text: "Back" }], "English");
    reopened.subtitleLines([{ start: 0, end: 600, text: "Zurück" }], "Deutsch");
    await wait();
    expect(player.state().subtitle?.label ?? null).toBe(
      choice === "off" ? null : choice === "other language" ? "Deutsch" : "English",
    );
    expect(player.state().phase.kind).toBe("playing");
    expect(ipc.argsOf("playback.open")).toHaveLength(2);
  },
);

it("a channel change clears an expired subtitle choice and the old outage", async () => {
  vi.useFakeTimers();
  const first = await expiredSelection();
  const second = await open("two");
  first.error("video");
  second.subtitleLines([{ start: 0, end: 600, text: "Another channel" }]);
  await wait();
  await playingFor(6000);
  expect(player.state().channel?.id).toBe("two");
  expect(player.state().subtitle).toBeNull();
  expect(player.state().phase.kind).toBe("playing");
  expect(ipc.argsOf("playback.open")).toHaveLength(2);
});

it.each(["timestamp domain", "malformed"] as const)(
  "discovery distinguishes %s rejection from a failed rendition",
  async (failure) => {
    vi.useFakeTimers();
    const stream = await open();
    if (failure === "timestamp domain") stream.subtitleDiscontinuityMismatch();
    else stream.subtitleUnreadable();
    await wait();
    stream.subtitleLines([{ start: 0, end: 600, text: "Hallo" }], "Deutsch");
    await wait();
    const before = stream.subtitlesLoaded.filter((name) => name === "English").length;
    await playingFor(70_000);
    const after = stream.subtitlesLoaded.filter((name) => name === "English").length;
    if (failure === "timestamp domain") expect(after).toBeGreaterThan(before);
    else expect(after).toBe(before);
    expect(player.state().subtitle).toBeNull();
    expect(player.state().phase.kind).toBe("playing");
    expect(ipc.argsOf("playback.open")).toHaveLength(1);
  },
);
