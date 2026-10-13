// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedSubtitle } from "@mrstreamer/contracts/online-subtitles";
import type { SubtitleTrack } from "@mrstreamer/contracts/playback";
import { player } from "../../src/renderer/src/player/player.ts";
import { subtitleLayer } from "../../src/renderer/src/player/subtitles.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

const saved: SavedSubtitle = {
  timing: { offset: 2, speed: 25 / 24 },
  subtitle: {
    service: "subdl",
    language: "en",
    release: "Cinema cut",
    cues: [
      { start: 96, end: 100, text: "Welcome." },
      { start: 10, end: 20, text: "Before." },
    ],
  },
};
/** Lets the player and main's answers catch up, on the fake clock every test runs on. */
const settle = () => vi.advanceTimersByTimeAsync(20);
const english: SubtitleTrack = {
  id: 3,
  page: null,
  format: "text",
  language: "en",
  label: "English",
  forced: false,
  default: false,
};
function shown() {
  return subtitleLayer.querySelector("[data-subtitle-text]")?.textContent ?? "";
}
function at(position: number) {
  player.element.currentTime = position;
  player.element.dispatchEvent(new Event("seeked"));
}
async function open(
  preferred: Parameters<typeof ipc.prefer>[0] = {},
  subtitles: readonly SubtitleTrack[] = [english],
) {
  ipc.reset();
  ipc.prefer(preferred);
  ipc.always("subtitles.show", null);
  ipc.always("subtitles.hide", null);
  const restore = ipc.hold("subtitles.saved");
  const pictureCalls: string[] = [];
  vi.stubGlobal("fetch", async (input: string) => {
    pictureCalls.push(input);
    return new Response(new ReadableStream());
  });
  ipc.always("playback.openTitle", {
    sessionId: "local-movie",
    title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "4k" },
    url: "http://127.0.0.1/title/local-movie.mp4",
    duration: 600,
    audio: [],
    subtitles,
  });
  void titlePlayer.open(
    {
      kind: "provider",
      title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "4k" },
      name: "Night Harbour",
      detail: null,
      artworkUrl: null,
      originalLanguage: null,
    },
    0,
  );
  await settle();
  return { pictureCalls, restore };
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  titlePlayer.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("a downloaded subtitle on the movie picture", () => {
  it("starts the picture while local restore waits, then applies drift and offset without another picture request", async () => {
    const { pictureCalls: calls } = await open();
    expect(calls).toHaveLength(1);
    expect(titlePlayer.acceptDownloaded("other-file", saved)).toBe(false);
    expect(titlePlayer.acceptDownloaded("local-movie", saved)).toBe(true);
    at(103);
    expect(shown()).toBe("Welcome.");
    at(100);
    expect(shown()).toBe("");
    at(15);
    expect(shown()).toBe("Before.");
    titlePlayer.setSubtitle(null);
    expect(shown()).toBe("");
    titlePlayer.toggleSubtitles();
    expect(shown()).toBe("Before.");
    expect(calls).toHaveLength(1);
  });
  it("moves the cue from its original clock on every edit, stores edits in order and rejects a closed session", async () => {
    await open();
    titlePlayer.acceptDownloaded("local-movie", saved);
    ipc.always("subtitles.timing", saved);
    at(100);
    await titlePlayer.setDownloadedTiming({ offset: 0, speed: 1 });
    expect(shown()).toBe("");
    await titlePlayer.setDownloadedTiming({ offset: -1, speed: 1 });
    at(98);
    expect(shown()).toBe("Welcome.");
    await titlePlayer.setDownloadedTiming(saved.timing);
    at(103);
    expect(shown()).toBe("Welcome.");
    expect(ipc.argsOf("subtitles.timing").map((input) => input.timing)).toEqual([
      { offset: 0, speed: 1 },
      { offset: -1, speed: 1 },
      saved.timing,
    ]);
    titlePlayer.close();
    expect(shown()).toBe("");
    expect(titlePlayer.acceptDownloaded("local-movie", saved)).toBe(false);
  });

  it("forgets a downloaded result without changing the global subtitle preference", async () => {
    await open();
    titlePlayer.acceptDownloaded("local-movie", saved);
    at(103);
    expect(shown()).toBe("Welcome.");
    ipc.always("subtitles.forget", null);
    await titlePlayer.forgetDownloaded();
    expect(shown()).toBe("");
    expect(titlePlayer.state().savedSubtitle).toBeNull();
    expect(titlePlayer.state().downloadedOn).toBe(false);
    expect(ipc.argsOf("preferences.update")).toEqual([]);
  });

  it.each(["Off", "a file track"])(
    "keeps the saved result available when %s is chosen while restore waits",
    async (choice) => {
      const { restore } = await open();
      titlePlayer.setSubtitle(choice === "Off" ? null : english);
      restore.resolve(saved);
      await settle();
      expect(titlePlayer.state().savedSubtitle).toEqual(saved);
      expect(titlePlayer.state().downloadedOn).toBe(false);
      expect(titlePlayer.state().subtitle).toEqual(choice === "Off" ? null : english);
      at(103);
      expect(shown()).toBe("");
      titlePlayer.showDownloaded();
      expect(shown()).toBe("Welcome.");
      // Chosen before anything saved was held: an ordinary choice, remembered for other titles.
      expect(ipc.argsOf("preferences.update")).toEqual([
        { subtitleLanguage: choice === "Off" ? "off" : "en" },
      ]);
    },
  );

  it.each(["shows", "is listed but off"])(
    "leaves the subtitle language for other titles alone when Off or a file track is chosen while a saved result %s",
    async (state) => {
      const { restore } = await open({ subtitleLanguage: "nl" });
      restore.resolve({ ...saved, selection: "kept-result", shown: state === "shows" });
      await settle();
      expect(titlePlayer.state().downloadedOn).toBe(state === "shows");
      titlePlayer.setSubtitle(null);
      titlePlayer.setSubtitle(english);
      titlePlayer.toggleSubtitles();
      await titlePlayer.downloadedEditsSaved();
      expect(titlePlayer.state()).toMatchObject({ subtitle: null, downloadedOn: false });
      expect(ipc.argsOf("subtitles.hide")).toHaveLength(3);
      expect(ipc.argsOf("preferences.update")).toEqual([]);
    },
  );

  it("does not replace a newer downloaded choice with an old restore response", async () => {
    const { restore } = await open();
    const newer = { ...saved, subtitle: { ...saved.subtitle!, release: "New cut" } };
    titlePlayer.acceptDownloaded("local-movie", newer);
    restore.resolve(saved);
    await settle();
    expect(titlePlayer.state().savedSubtitle).toEqual(newer);
    expect(titlePlayer.state().downloadedOn).toBe(true);
  });

  it("opens with a result the viewer turned off listed but not showing, and tells main each choice made here", async () => {
    const { restore } = await open();
    const kept = { ...saved, selection: "kept-result" };
    restore.resolve({ ...kept, shown: false });
    await settle();
    expect(titlePlayer.state().downloadedOn).toBe(false);
    expect(titlePlayer.state().savedSubtitle?.subtitle).toEqual(saved.subtitle);
    at(103);
    expect(shown()).toBe("");
    expect(ipc.methods().filter((method) => /^subtitles\.(show|hide)$/.test(method))).toEqual([]);

    titlePlayer.showDownloaded();
    expect(shown()).toBe("Welcome.");
    titlePlayer.setSubtitle(english);
    titlePlayer.toggleSubtitles();
    await titlePlayer.downloadedEditsSaved();
    expect(ipc.methods().filter((method) => /^subtitles\.(show|hide)$/.test(method))).toEqual([
      "subtitles.show",
      "subtitles.hide",
      "subtitles.hide",
    ]);
    expect(ipc.argsOf("subtitles.show")).toEqual([
      { sessionId: "local-movie", selection: "kept-result" },
    ]);
    expect(ipc.argsOf("subtitles.hide")[0]).toEqual({ sessionId: "local-movie" });
    expect(titlePlayer.state().savedSubtitle?.subtitle).toEqual(saved.subtitle);
  });

  it("C shows a reopened file's saved result that was last turned off when the file has no track of its own, and a file track first", async () => {
    const hidden = { ...saved, selection: "kept-result", shown: false };
    const bare = await open({ subtitleLanguage: "nl" }, []);
    bare.restore.resolve(hidden);
    await settle();
    expect(titlePlayer.state().downloadedOn).toBe(false);
    titlePlayer.toggleSubtitles();
    at(103);
    expect(shown()).toBe("Welcome.");
    titlePlayer.toggleSubtitles();
    expect(shown()).toBe("");
    await titlePlayer.downloadedEditsSaved();
    expect(ipc.methods().filter((method) => /^subtitles\.(show|hide)$/.test(method))).toEqual([
      "subtitles.show",
      "subtitles.hide",
    ]);
    expect(ipc.argsOf("subtitles.show")).toEqual([
      { sessionId: "local-movie", selection: "kept-result" },
    ]);
    expect(ipc.argsOf("preferences.update")).toEqual([]);
    titlePlayer.close();

    const tracked = await open({ subtitleLanguage: "off" });
    tracked.restore.resolve(hidden);
    await settle();
    titlePlayer.toggleSubtitles();
    expect(titlePlayer.state()).toMatchObject({ subtitle: english, downloadedOn: false });
    expect(ipc.argsOf("preferences.update")).toEqual([]);
  });

  it("shows a saved result on open even when the subtitle language is Off", async () => {
    const { restore } = await open({ subtitleLanguage: "off" });
    restore.resolve(saved);
    await settle();
    expect(titlePlayer.state().downloadedOn).toBe(true);
    at(103);
    expect(shown()).toBe("Welcome.");
    expect(ipc.argsOf("preferences.update")).toEqual([]);
  });

  it("drops the downloaded result when main says this session's file was replaced, and only then", async () => {
    const { pictureCalls, restore } = await open();
    titlePlayer.acceptDownloaded("local-movie", saved);
    at(103);
    expect(shown()).toBe("Welcome.");
    ipc.emit("playback.fileReplaced", { sessionId: "an-earlier-session" });
    expect(shown()).toBe("Welcome.");
    expect(titlePlayer.state().savedSubtitle).toEqual(saved);

    ipc.emit("playback.fileReplaced", { sessionId: "local-movie" });
    expect(shown()).toBe("");
    expect(titlePlayer.state()).toMatchObject({
      savedSubtitle: null,
      downloadedOn: false,
      subtitleSessionId: null,
      now: { name: "Night Harbour" },
    });
    // The picture goes on as it was, and nothing late brings the old text back.
    expect(pictureCalls).toHaveLength(1);
    expect(titlePlayer.acceptDownloaded("local-movie", saved)).toBe(false);
    restore.resolve(saved);
    await settle();
    titlePlayer.toggleSubtitles();
    titlePlayer.seek(300);
    await settle();
    at(103);
    expect(shown()).toBe("");
    expect(titlePlayer.state().savedSubtitle).toBeNull();
    expect(pictureCalls.length).toBeGreaterThan(1);
  });

  it("keeps a shown file track when the file is replaced, and only takes the saved result off the list", async () => {
    const { pictureCalls, restore } = await open();
    titlePlayer.setSubtitle(english);
    restore.resolve(saved);
    await settle();
    expect(titlePlayer.state().savedSubtitle).toEqual(saved);
    const runs = pictureCalls.length;
    ipc.emit("playback.fileReplaced", { sessionId: "local-movie" });
    expect(titlePlayer.state()).toMatchObject({ subtitle: english, savedSubtitle: null });
    expect(pictureCalls).toHaveLength(runs);
  });

  it("reports a failed timing write once and lets the next correction save", async () => {
    await open();
    titlePlayer.acceptDownloaded("local-movie", saved);
    ipc.refuse("subtitles.timing", { kind: "unexpected", detail: "Timing could not be saved." });
    await expect(titlePlayer.setDownloadedTiming({ offset: 0, speed: 1 })).rejects.toBeDefined();
    await settle();
    await titlePlayer.downloadedEditsSaved();
    ipc.always("subtitles.timing", saved);
    await titlePlayer.setDownloadedTiming({ offset: 1, speed: 1 });
    expect(ipc.argsOf("subtitles.timing").map(({ timing }) => timing.offset)).toEqual([0, 1]);
  });
});
