import type { ObservedAudioTrack, ObservedSubtitleTrack, ObservedTrackSnapshot } from "expo-video";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { nativePlayer } from "./native-player.ts";
import type { MediaPolicy } from "../src/media-policy.ts";

// The real playback owner queries a native-port stand-in. Labels are display names, not facts.
const port = nativePlayer();
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-video", () => ({ createVideoPlayer: () => port }));
const { play, stop, trackChoices, retry } = await import("../src/playback.ts");
const preferences = await import("../src/media-preferences.ts");
const { native } = await import("./native-files.ts");
const query = port.getObservedTracksAsync.getMockImplementation();
const item = {
  id: "movie",
  subscriptionId: null,
  title: "Movie",
  place: "",
  live: false,
  next: false,
  versions: false,
};
const open = () =>
  play(
    item,
    {
      kind: "file",
      originalLanguage: null,
      open: async () => ({ url: "file:movie.mp4", container: "mp4" }),
    },
    { watch: true, login: [] },
  );
const sheet = async (of: "audio" | "subtitles") =>
  (await trackChoices(of)).map((choice) => `${choice.selected ? "✓ " : ""}${choice.label}`);
const choose = async (of: "audio" | "subtitles", label: string) =>
  (await trackChoices(of)).find((choice) => choice.label === label)?.choose();
let tracks: ObservedTrackSnapshot;

beforeEach(async () => {
  await stop();
  native.sync = null;
  native.undeletable = null;
  preferences.updateMediaPreferences("titleLanguage", "en");
  preferences.updateMediaPreferences("audio", { kind: "follow-title" });
  preferences.updateMediaPreferences("subtitles", { kind: "forced-only" });
  preferences.updateMediaPreferences("liveQuality", "fhd");
  port.getObservedTracksAsync.mockReset();
  if (query) port.getObservedTracksAsync.mockImplementation(query);
  port.tracks = null;
  await open();
  const identity = port.identity();
  const sounds: ObservedAudioTrack[] = [
    { language: "en", label: "English", name: "Stereo 1", isDefault: false },
    { language: "en", label: "English", name: "Surround 2", isDefault: true },
    { language: "nl", label: "Dutch", name: "nld 3", isDefault: false },
  ].map((track, i) => ({
    ...track,
    ...identity,
    revision: 1,
    id: String(i),
    group: "audio",
    isPlayable: true,
  }));
  const subtitles: ObservedSubtitleTrack[] = [0, 1].map((i) => ({
    ...identity,
    revision: 1,
    id: String(i),
    group: "subtitles",
    language: "en",
    label: "English",
    isDefault: false,
    isPlayable: true,
    forcedOnly: i === 1,
  }));
  tracks = {
    ...identity,
    revision: 1,
    audio: { state: "ready", options: sounds },
    subtitles: { state: "ready", options: subtitles },
    subtitleOffAllowed: true,
    selectedAudioId: "1",
    selectedSubtitleId: "1",
  };
  port.tracks = tracks;
  port.selectObservedTrackAsync.mockReset();
  port.selectObservedTrackAsync.mockImplementation(async (_expected, _revision, choice) => {
    tracks = {
      ...tracks,
      ...(choice.kind === "audio"
        ? { selectedAudioId: choice.track.id }
        : { selectedSubtitleId: choice.track?.id ?? null }),
    };
    port.tracks = tracks;
    return { kind: "requested" };
  });
});
afterEach(() => {
  native.sync = null;
  return stop();
});

describe("actual native track choices", () => {
  it("checks one sound and hands back each exact observed record, in both directions", async () => {
    expect(await sheet("audio")).toEqual(["English · Stereo 1", "✓ English · Surround 2", "Dutch"]);
    for (const [label, checked] of [
      ["English · Stereo 1", 0],
      ["English · Surround 2", 1],
      ["Dutch", 2],
    ] as const) {
      await choose("audio", label);
      expect((await trackChoices("audio"))[checked]?.selected).toBe(true);
    }
    expect(
      port.selectObservedTrackAsync.mock.calls
        .filter((call) => call[2].kind === "audio")
        .map((call) => call[2].track),
    ).toEqual(tracks.audio.options);
    expect(port.selectObservedTrackAsync.mock.calls[0]?.[2].track).toBe(tracks.audio.options[0]);
  });

  it("numbers unnamed subtitles, checks readback and offers allowed Off first", async () => {
    expect(await sheet("subtitles")).toEqual(["Off", "English · 1", "✓ English · 2"]);
    await choose("subtitles", "English · 1");
    expect(await sheet("subtitles")).toEqual(["Off", "✓ English · 1", "English · 2"]);
    await choose("subtitles", "Off");
    expect(await sheet("subtitles")).toEqual(["✓ Off", "English · 1", "English · 2"]);
    expect(port.selectObservedTrackAsync.mock.calls.map((call) => call[2].track)).toEqual([
      tracks.subtitles.options[0],
      null,
    ]);
  });

  it("uses actual IDs with missing language and treats names only as labels", async () => {
    const { language: _language, ...track } = tracks.audio.options[0]!;
    port.tracks = {
      ...tracks,
      audio: { state: "ready", options: [{ ...track, label: "Forced by label only" }] },
      selectedAudioId: track.id,
    };
    expect(await sheet("audio")).toEqual(["✓ Forced by label only"]);
    expect(port.selectObservedTrackAsync).not.toHaveBeenCalled();
  });

  it("refuses unplayable options and Off when native forbids it", async () => {
    port.tracks = {
      ...tracks,
      subtitleOffAllowed: false,
      audio: {
        state: "ready",
        options: tracks.audio.options.map((track) => ({ ...track, isPlayable: false })),
      },
    };
    expect(await sheet("audio")).toEqual([]);
    expect(await sheet("subtitles")).toEqual(["English · 1", "✓ English · 2"]);
  });

  it("does not optimistically check a requested selection", async () => {
    port.selectObservedTrackAsync.mockResolvedValue({ kind: "requested" });
    await choose("audio", "English · Stereo 1");
    expect(await sheet("audio")).toEqual(["English · Stereo 1", "✓ English · Surround 2", "Dutch"]);
  });

  it("held choices cannot write after replacement or a revision change", async () => {
    const first = (await trackChoices("audio"))[0]!;
    port.tracks = { ...tracks, revision: 2 };
    await trackChoices("audio");
    await first.choose();
    expect(port.selectObservedTrackAsync).not.toHaveBeenCalled();
    const second = (await trackChoices("audio"))[0]!;
    await open();
    await second.choose();
    expect(port.selectObservedTrackAsync).not.toHaveBeenCalled();
  });
});

const tick = async () => {
  for (let turn = 0; turn < 60; turn++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
const sound = (
  id: string,
  language: string,
  facts: Partial<Pick<ObservedAudioTrack, "isDefault" | "isPlayable" | "label" | "name">> = {},
): ObservedAudioTrack => ({
  ...port.identity(),
  revision: 1,
  id,
  language,
  label: language,
  group: "audio",
  isDefault: false,
  isPlayable: true,
  ...facts,
});
const text = (id: string, language: string, forcedOnly = false): ObservedSubtitleTrack => ({
  ...port.identity(),
  revision: 1,
  id,
  language,
  label: language,
  group: "subtitles",
  isDefault: false,
  isPlayable: true,
  forcedOnly,
});
/** Retag the actual menu records for this attempt and revision, as the native producer does. */
function snapshot(
  revision: number,
  parts: Partial<ObservedTrackSnapshot> = {},
): ObservedTrackSnapshot {
  const identity = port.identity();
  const audio: ObservedTrackSnapshot["audio"] = parts.audio ?? {
    state: "ready",
    options: [sound("en", "en", { isDefault: true }), sound("de", "de"), sound("nl", "nl")],
  };
  const subtitles: ObservedTrackSnapshot["subtitles"] = parts.subtitles ?? {
    state: "ready",
    options: [text("en", "en", true), text("nl", "nl", true), text("plain-nl", "nl")],
  };
  return {
    subtitleOffAllowed: true,
    selectedAudioId: "en",
    selectedSubtitleId: null,
    ...parts,
    ...identity,
    revision,
    audio: {
      ...audio,
      options: audio.options.map((track) => ({ ...track, ...identity, revision })),
    },
    subtitles: {
      ...subtitles,
      options: subtitles.options.map((track) => ({ ...track, ...identity, revision })),
    },
  };
}
function publish(next: ObservedTrackSnapshot) {
  tracks = next;
  port.tracks = next;
  port.observation({ kind: "tracks", tracks: next });
}
const requests = () =>
  port.selectObservedTrackAsync.mock.calls.map(
    ([, , choice]) => `${choice.kind}:${choice.track?.id ?? "off"}`,
  );
const soundsRequested = () =>
  port.selectObservedTrackAsync.mock.calls
    .filter(([, , choice]) => choice.kind === "audio")
    .map(([, , choice]) => choice.track?.id);
const captionsRequested = () =>
  port.selectObservedTrackAsync.mock.calls
    .filter(([, , choice]) => choice.kind === "subtitles")
    .map(([, , choice]) => choice.track?.id ?? "off");
async function choosing(
  audio: MediaPolicy["audio"],
  subtitles: MediaPolicy["subtitles"] = { kind: "off" },
) {
  preferences.updateMediaPreferences("audio", audio);
  preferences.updateMediaPreferences("subtitles", subtitles);
  await open();
  port.selectObservedTrackAsync.mockClear();
}

describe("automatic policy in the one playback owner", () => {
  it("reconsiders ready-empty, late options and playability, using the target default and no first guess", async () => {
    await choosing({ kind: "language", language: "nl" });
    publish(snapshot(1, { audio: { state: "ready", options: [] }, selectedAudioId: null }));
    await tick();
    expect(soundsRequested()).toEqual([]);
    const options = [
      sound("en", "en", { isDefault: true }),
      sound("nl", "nl"),
      sound("main", "nl", { isDefault: true }),
    ];
    publish(snapshot(2, { audio: { state: "ready", options } }));
    await tick();
    expect(soundsRequested()).toEqual(["main"]);
    publish(
      snapshot(3, {
        audio: {
          state: "ready",
          options: options.map((track) => ({ ...track, isPlayable: track.id !== "main" })),
        },
        selectedAudioId: "main",
      }),
    );
    await tick();
    expect(soundsRequested()).toEqual(["main", "nl"]);
    publish(
      snapshot(4, {
        audio: { state: "ready", options: [options[0]!, sound("de", "de")] },
        selectedAudioId: "de",
      }),
    );
    await tick();
    expect(soundsRequested()).toEqual(["main", "nl", "en"]);
    publish(
      snapshot(5, {
        audio: { state: "ready", options: [sound("de", "de"), sound("en", "en")] },
        selectedAudioId: "de",
      }),
    );
    await tick();
    expect(soundsRequested()).toEqual(["main", "nl", "en"]);
  });

  it("does not restart automatic audio for a selection-only snapshot", async () => {
    await choosing({ kind: "language", language: "nl" });
    publish(snapshot(1));
    await tick();
    expect(soundsRequested()).toEqual(["nl"]);
    publish(snapshot(1, { selectedAudioId: "en" }));
    await tick();
    expect(soundsRequested()).toEqual(["nl"]);
  });

  it("waits for actual sound, distinguishes absent audio and follows sound when it later becomes ready", async () => {
    await choosing({ kind: "follow-title" }, { kind: "forced-only" });
    publish(
      snapshot(1, {
        audio: { state: "unavailable", options: [] },
        selectedAudioId: null,
        selectedSubtitleId: "nl",
      }),
    );
    await tick();
    expect(captionsRequested()).toEqual([]);
    publish(
      snapshot(2, {
        audio: { state: "absent", options: [] },
        selectedAudioId: null,
        selectedSubtitleId: "nl",
      }),
    );
    await tick();
    expect(captionsRequested()).toEqual(["off"]);
    publish(
      snapshot(3, {
        audio: { state: "ready", options: [sound("nl", "nl", { isDefault: true })] },
        selectedAudioId: "nl",
      }),
    );
    await tick();
    expect(captionsRequested()).toEqual(["off", "nl"]);
  });

  it("records a waited unknown sound and redecides once when audio restores the preceding language without another event", async () => {
    await choosing({ kind: "follow-title" }, { kind: "forced-only" });
    publish(snapshot(1, { selectedSubtitleId: "en" }));
    await tick();
    expect(requests()).toEqual([]);
    publish(snapshot(2, { selectedAudioId: "nl", selectedSubtitleId: "nl" }));
    await tick();
    expect(requests()).toEqual(["audio:en", "subtitles:en"]);
    expect(port.tracks?.selectedSubtitleId).toBe("en");
  });

  it.each(["keep", "unavailable", "stale", "rejected"] as const)(
    "settles actual sound after %s audio work without another tracks event",
    async (outcome) => {
      await choosing({ kind: "follow-title" }, { kind: "forced-only" });
      publish(snapshot(1, { selectedSubtitleId: "en" }));
      await tick();
      const select = port.selectObservedTrackAsync.getMockImplementation();
      port.selectObservedTrackAsync.mockImplementation(async (...args) => {
        if (args[2].kind === "audio") {
          if (outcome === "rejected") throw new Error("bridge refused");
          return { kind: outcome === "keep" ? "requested" : outcome };
        }
        if (!select) throw new Error("No native selection port");
        return select(...args);
      });
      publish(
        snapshot(2, {
          selectedAudioId: outcome === "keep" ? "en" : "nl",
          selectedSubtitleId: outcome === "keep" ? "nl" : "en",
        }),
      );
      await tick();
      expect(captionsRequested()).toEqual([outcome === "keep" ? "en" : "nl"]);
    },
  );

  it("settles from an event accepted while the post-request query is pending, even if that query loses the race", async () => {
    await choosing({ kind: "language", language: "nl" }, { kind: "forced-only" });
    const ack = deferred<{ kind: "requested" }>();
    const readback = deferred<ObservedTrackSnapshot>();
    onTestFinished(() => {
      ack.resolve({ kind: "requested" });
      readback.resolve(tracks);
    });
    const select = port.selectObservedTrackAsync.getMockImplementation();
    let reading = false;
    port.selectObservedTrackAsync.mockImplementation(async (...args) => {
      if (args[2].kind === "audio") return ack.promise;
      if (!select) throw new Error("No native selection port");
      return select(...args);
    });
    publish(snapshot(1, { selectedSubtitleId: "en" }));
    await tick();
    port.getObservedTracksAsync.mockImplementationOnce(async () => {
      reading = true;
      return readback.promise;
    });
    ack.resolve({ kind: "requested" });
    await tick();
    expect(reading).toBe(true);
    const old = tracks;
    publish(snapshot(1, { selectedAudioId: "nl", selectedSubtitleId: "en" }));
    expect(captionsRequested()).toEqual([]);
    readback.resolve(old);
    await tick();
    expect(captionsRequested()).toEqual(["nl"]);
  });

  it("finishes post-request readback when a newer stale row supersedes the group operation", async () => {
    await choosing({ kind: "follow-title" }, { kind: "forced-only" });
    const subtitles = {
      state: "ready" as const,
      options: [text("en", "en", true), text("de", "de", true)],
    };
    publish(snapshot(1, { subtitles, selectedSubtitleId: "en" }));
    await tick();
    const rows = await trackChoices("audio");
    const german = rows.find((row) => row.label === "de");
    const dutch = rows.find((row) => row.label === "nl");
    if (!german || !dutch) throw new Error("Missing native rows");
    const acknowledgement = deferred<{ kind: "requested" }>();
    const earlierQuery = deferred<ObservedTrackSnapshot>();
    onTestFinished(() => {
      acknowledgement.resolve({ kind: "requested" });
      earlierQuery.resolve(tracks);
    });
    port.selectObservedTrackAsync.mockImplementationOnce(() => acknowledgement.promise);
    const first = german.choose();
    await tick();
    port.getObservedTracksAsync.mockImplementationOnce(() => earlierQuery.promise);
    const menu = trackChoices("audio");
    await tick();
    acknowledgement.resolve({ kind: "requested" });
    await tick();
    publish(snapshot(2, { subtitles, selectedSubtitleId: "en" }));
    const newer = dutch.choose(); // Its revision is old, but it supersedes the pending operation now.
    const before = port.getObservedTracksAsync.mock.calls.length;
    port.getObservedTracksAsync.mockImplementationOnce(async () => {
      // The actual sound changed; only this post-request query observes it, with no new event.
      tracks = snapshot(2, { subtitles, selectedAudioId: "de", selectedSubtitleId: "en" });
      port.tracks = tracks;
      return tracks;
    });
    earlierQuery.resolve(snapshot(1, { subtitles, selectedSubtitleId: "en" }));
    await Promise.all([first, newer, menu]);
    await tick();
    expect(port.getObservedTracksAsync.mock.calls.length).toBeGreaterThan(before);
    expect(captionsRequested()).toEqual(["de"]);
    expect(preferences.getMediaPreferences().audio).toEqual({ kind: "follow-title" });
  });

  it("keeps frozen automatic policy and descriptor holds across Live fallback and reconnect", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    preferences.updateMediaPreferences("audio", { kind: "language", language: "en" });
    preferences.updateMediaPreferences("subtitles", { kind: "off" });
    const live = { ...item, live: true };
    const open = async () => ({ url: "file:live.m3u8", container: "m3u8" });
    await play(
      live,
      {
        kind: "live",
        explicit: false,
        candidates: [
          { variantId: "a", open },
          { variantId: "b", open },
        ],
      },
      { watch: true, login: [] },
    );
    publish(snapshot(1));
    await tick();
    port.selectObservedTrackAsync.mockClear();
    await choose("audio", "de");
    preferences.updateMediaPreferences("audio", { kind: "language", language: "nl" });
    port.failure({ kind: "missing", evidence: null });
    await tick();
    publish(
      snapshot(1, {
        audio: {
          state: "ready",
          options: [sound("en", "en", { isDefault: true }), sound("nl", "nl")],
        },
        selectedAudioId: "nl",
      }),
    );
    await tick();
    expect(soundsRequested()).toEqual(["de", "en"]);
    publish(
      snapshot(2, {
        audio: {
          state: "ready",
          options: [
            sound("en", "en", { isDefault: true }),
            sound("german", "de"),
            sound("nl", "nl"),
          ],
        },
      }),
    );
    await tick();
    expect(soundsRequested()).toEqual(["de", "en", "german"]);
    port.state(true);
    port.failure();
    await vi.advanceTimersByTimeAsync(1000);
    await tick();
    publish(
      snapshot(1, {
        audio: {
          state: "ready",
          options: [
            sound("en", "en", { isDefault: true }),
            sound("again", "de"),
            sound("nl", "nl"),
          ],
        },
      }),
    );
    await tick();
    expect(soundsRequested()).toEqual(["de", "en", "german", "again"]);
    expect(preferences.getMediaPreferences().audio).toEqual({ kind: "language", language: "nl" });
  });

  it("stops one group's automatic requests after three consecutive stale answers", async () => {
    await choosing({ kind: "follow-title" });
    port.selectObservedTrackAsync.mockResolvedValue({ kind: "stale" });
    for (let revision = 1; revision <= 5; revision++) {
      publish(snapshot(revision, { selectedAudioId: "nl" }));
      await tick();
    }
    expect(soundsRequested()).toEqual(["en", "en", "en"]);
  });

  it("freezes title and track policies across Settings changes and Try again, taking new globals on a new play", async () => {
    await choosing({ kind: "follow-title" });
    preferences.updateMediaPreferences("titleLanguage", "nl");
    preferences.updateMediaPreferences("audio", { kind: "language", language: "de" });
    preferences.updateMediaPreferences("subtitles", { kind: "language", language: "nl" });
    publish(snapshot(1, { selectedAudioId: "nl", selectedSubtitleId: "plain-nl" }));
    await tick();
    expect(soundsRequested()).toEqual(["en"]);
    expect(captionsRequested()).toEqual(["off"]);
    retry();
    await tick();
    publish(snapshot(1, { selectedAudioId: "nl", selectedSubtitleId: "plain-nl" }));
    await tick();
    expect(soundsRequested()).toEqual(["en", "en"]);
    expect(captionsRequested()).toEqual(["off", "off"]);
    await open();
    publish(snapshot(1, { selectedAudioId: "en" }));
    await tick();
    expect(soundsRequested()).toEqual(["en", "en", "de"]);
    expect(captionsRequested()).toEqual(["off", "off", "plain-nl"]);
  });

  it("confirms sound after both the selection event and post-request query land before audio work finishes", async () => {
    await choosing({ kind: "language", language: "nl" }, { kind: "forced-only" });
    const select = port.selectObservedTrackAsync.getMockImplementation();
    port.selectObservedTrackAsync.mockImplementation(async (...args) => {
      if (!select) throw new Error("No native selection port");
      const result = await select(...args);
      if (args[2].kind === "audio") {
        port.observation({ kind: "tracks", tracks });
      }
      return result;
    });
    publish(snapshot(1, { selectedSubtitleId: "en" }));
    await tick();
    expect(requests()).toEqual(["audio:nl", "subtitles:nl"]);
    expect(port.tracks?.selectedSubtitleId).toBe("nl");
  });

  it("uses live language rules, including playable audio availability and no forced fallback to another sound", async () => {
    preferences.updateMediaPreferences("audio", { kind: "original" });
    preferences.updateMediaPreferences("subtitles", { kind: "language", language: "nl" });
    await play(
      { ...item, live: true },
      {
        kind: "live",
        candidates: [
          { variantId: "live", open: async () => ({ url: "live:one", container: "m3u8" }) },
        ],
        explicit: false,
      },
      { watch: true, login: [] },
    );
    port.selectObservedTrackAsync.mockClear();
    publish(snapshot(1, { selectedSubtitleId: "plain-nl" }));
    await tick();
    expect(requests()).toEqual(["subtitles:off"]);
    const audio = {
      state: "ready" as const,
      options: [sound("en", "en", { isDefault: true }), sound("nl", "nl", { isPlayable: false })],
    };
    publish(snapshot(2, { audio }));
    await tick();
    publish(
      snapshot(3, {
        audio,
        subtitles: { state: "ready", options: [text("en", "en", true), text("nl", "nl", true)] },
      }),
    );
    await tick();
    publish(
      snapshot(4, {
        audio,
        subtitles: { state: "ready", options: [text("en", "en", true)] },
        selectedSubtitleId: "en",
      }),
    );
    await tick();
    expect(captionsRequested()).toEqual(["off", "plain-nl", "nl", "off"]);
    expect(soundsRequested()).toEqual([]);
  });
});

describe("confirmed manual choices and Retry holds", () => {
  it("waits after an old first readback, then remembers once on a later selection-only confirmation", async () => {
    await choosing({ kind: "follow-title" });
    publish(snapshot(1));
    await tick();
    port.selectObservedTrackAsync.mockResolvedValue({ kind: "requested" });
    const remembered: MediaPolicy["audio"][] = [];
    onTestFinished(
      preferences.onMediaPreferences(() =>
        remembered.push(preferences.getMediaPreferences().audio),
      ),
    );
    await choose("audio", "de");
    expect(preferences.getMediaPreferences().audio).toEqual({ kind: "follow-title" });
    expect(await sheet("audio")).toContain("✓ en");
    publish(snapshot(1, { selectedAudioId: "de" }));
    await tick();
    expect(remembered).toEqual([{ kind: "language", language: "de" }]);
    publish(snapshot(1, { selectedAudioId: "de" }));
    await tick();
    expect(remembered).toHaveLength(1);

    retry();
    await tick();
    publish(
      snapshot(1, {
        audio: {
          state: "ready",
          options: [sound("en", "en", { isDefault: true }), sound("moved", "de")],
        },
      }),
    );
    await tick();
    expect(soundsRequested()).toEqual(["de", "moved"]);
    // The held request's first readback is old too; later confirmation makes it manual.
    publish(
      snapshot(1, {
        audio: {
          state: "ready",
          options: [sound("en", "en", { isDefault: true }), sound("moved", "de")],
        },
        selectedAudioId: "moved",
      }),
    );
    await tick();
    publish(
      snapshot(2, {
        audio: {
          state: "ready",
          options: [sound("en", "en", { isDefault: true }), sound("moved", "de")],
        },
        selectedAudioId: "moved",
      }),
    );
    await tick();
    expect(soundsRequested()).toEqual(["de", "moved"]);
    expect(remembered).toHaveLength(1);
  });

  it("confirms a subtitle pick later and leaves manual subtitles alone when actual sound changes", async () => {
    await choosing({ kind: "follow-title" }, { kind: "forced-only" });
    publish(snapshot(1, { selectedSubtitleId: "en" }));
    await tick();
    port.selectObservedTrackAsync.mockResolvedValue({ kind: "requested" });
    await choose("subtitles", "nl · 2");
    expect(preferences.getMediaPreferences().subtitles).toEqual({ kind: "forced-only" });
    publish(snapshot(1, { selectedSubtitleId: "plain-nl" }));
    await tick();
    expect(preferences.getMediaPreferences().subtitles).toEqual({
      kind: "language",
      language: "nl",
    });
    publish(snapshot(2, { selectedAudioId: "nl", selectedSubtitleId: "plain-nl" }));
    await tick();
    expect(captionsRequested()).toEqual(["plain-nl"]);
  });

  it("manual audio makes automatic forced subtitles follow actual readback, not its acknowledged target", async () => {
    await choosing({ kind: "follow-title" }, { kind: "forced-only" });
    publish(snapshot(1, { selectedSubtitleId: "en" }));
    await tick();
    port.selectObservedTrackAsync.mockResolvedValue({ kind: "requested" });
    await choose("audio", "nl");
    await tick();
    expect(captionsRequested()).toEqual([]);
    const select = port.selectObservedTrackAsync.getMockImplementation();
    port.selectObservedTrackAsync.mockImplementation(async (...args) => {
      if (args[2].kind === "subtitles") {
        tracks = { ...tracks, selectedSubtitleId: args[2].track?.id ?? null };
        port.tracks = tracks;
      }
      if (!select) throw new Error("No native selection port");
      return select(...args);
    });
    publish(snapshot(1, { selectedAudioId: "nl", selectedSubtitleId: "en" }));
    await tick();
    expect(captionsRequested()).toEqual(["nl"]);
  });

  it("compares repeated picks with current globals and preserves other Settings fields edited in flight", async () => {
    await choosing({ kind: "follow-title" });
    publish(snapshot(1));
    await tick();
    await choose("audio", "de");
    expect(preferences.getMediaPreferences().audio).toEqual({ kind: "language", language: "de" });
    const ack = deferred<{ kind: "requested" }>();
    onTestFinished(() => ack.resolve({ kind: "requested" }));
    const select = port.selectObservedTrackAsync.getMockImplementation();
    port.selectObservedTrackAsync.mockImplementationOnce(async () => ack.promise);
    const picking = choose("audio", "en");
    await tick();
    preferences.updateMediaPreferences("titleLanguage", "nl");
    preferences.updateMediaPreferences("liveQuality", "sd");
    preferences.updateMediaPreferences("subtitles", { kind: "language", language: "fr" });
    tracks = { ...tracks, selectedAudioId: "en" };
    port.tracks = tracks;
    ack.resolve({ kind: "requested" });
    await picking;
    expect(preferences.getMediaPreferences()).toMatchObject({
      audio: { kind: "language", language: "en" },
      titleLanguage: "nl",
      liveQuality: "sd",
      subtitles: { kind: "language", language: "fr" },
    });
    if (!select) throw new Error("No native selection port");
    port.selectObservedTrackAsync.mockImplementation(select);
    await choose("subtitles", "nl · 2");
    expect(preferences.getMediaPreferences().subtitles).toEqual({
      kind: "language",
      language: "nl",
    });
    await choose("subtitles", "Off");
    expect(preferences.getMediaPreferences().subtitles).toEqual({ kind: "off" });
  });

  it("keeps a reaffirmed pick for Retry without rewriting its global policy", async () => {
    await choosing({ kind: "original" });
    publish(snapshot(1));
    await tick();
    const writes = vi.fn();
    onTestFinished(preferences.onMediaPreferences(writes));
    await choose("audio", "en");
    expect(writes).not.toHaveBeenCalled();
    expect(preferences.getMediaPreferences().audio).toEqual({ kind: "original" });
    retry();
    await tick();
    publish(snapshot(1, { selectedAudioId: "nl" }));
    await tick();
    expect(soundsRequested()).toEqual(["en", "en"]);
    expect(writes).not.toHaveBeenCalled();
  });

  it("retains the accepted preference after a refused remember write while the confirmed pick still holds", async () => {
    await choosing({ kind: "follow-title" });
    publish(snapshot(1));
    await tick();
    native.sync = (operation, path) => {
      if (operation === "write" && path.endsWith("media-preferences.json.next"))
        throw new Error("disk full");
    };
    await choose("audio", "de");
    expect(await sheet("audio")).toContain("✓ de");
    expect(preferences.getMediaPreferences().audio).toEqual({ kind: "follow-title" });
    native.sync = null;
    retry();
    await tick();
    publish(snapshot(1));
    await tick();
    expect(soundsRequested()).toEqual(["de", "de"]);
  });

  it.each(["unavailable", "stale", "rejected"] as const)(
    "a %s manual request never takes automatic authority",
    async (answer) => {
      await choosing({ kind: "follow-title" });
      publish(snapshot(1));
      await tick();
      port.selectObservedTrackAsync.mockImplementationOnce(async () => {
        if (answer === "rejected") throw new Error("bridge refused");
        return { kind: answer };
      });
      await choose("audio", "de");
      publish(snapshot(2, { selectedAudioId: "nl" }));
      await tick();
      expect(soundsRequested()).toEqual(["de", "en"]);
      expect(preferences.getMediaPreferences().audio).toEqual({ kind: "follow-title" });
    },
  );

  it("a stale row drops queued audio work and hands the latest revision back to automatic policy", async () => {
    await choosing({ kind: "follow-title" }, { kind: "forced-only" });
    publish(snapshot(1, { selectedSubtitleId: "en" }));
    await tick();
    const stale = (await trackChoices("audio")).find((row) => row.label === "de");
    if (!stale) throw new Error("No German row");
    publish(snapshot(2, { selectedAudioId: "nl", selectedSubtitleId: "nl" }));
    await stale.choose();
    await tick();
    expect(soundsRequested()).toEqual(["en"]);
    expect(captionsRequested()).toEqual(["en"]);
    expect(preferences.getMediaPreferences().audio).toEqual({ kind: "follow-title" });
  });

  it("a newer refused pick ends an older pending confirmation, even when that older sound arrives later", async () => {
    await choosing({ kind: "follow-title" });
    publish(snapshot(1));
    await tick();
    port.selectObservedTrackAsync.mockResolvedValue({ kind: "requested" });
    await choose("audio", "de");
    port.selectObservedTrackAsync.mockResolvedValueOnce({ kind: "unavailable" });
    await choose("audio", "nl");
    publish(snapshot(1, { selectedAudioId: "de" }));
    await tick();
    expect(preferences.getMediaPreferences().audio).toEqual({ kind: "follow-title" });
  });

  it.each(["stop", "replacement"] as const)(
    "%s ends an older pending confirmation",
    async (ending) => {
      await choosing({ kind: "follow-title" });
      publish(snapshot(1));
      await tick();
      port.selectObservedTrackAsync.mockResolvedValue({ kind: "requested" });
      await choose("audio", "de");
      const old = snapshot(1, { selectedAudioId: "de" });
      if (ending === "stop") await stop();
      else await open();
      port.observation({ kind: "tracks", tracks: old }, old);
      await tick();
      expect(preferences.getMediaPreferences().audio).toEqual({ kind: "follow-title" });
    },
  );

  it("requires a unique descriptor match after reorder rather than trusting a reused native id", async () => {
    await choosing({ kind: "follow-title" });
    publish(snapshot(1));
    await tick();
    port.selectObservedTrackAsync.mockResolvedValue({ kind: "requested" });
    await choose("audio", "de");
    publish(
      snapshot(2, {
        audio: { state: "ready", options: [sound("de", "en"), sound("moved", "de")] },
        selectedAudioId: "de",
      }),
    );
    await tick();
    expect(preferences.getMediaPreferences().audio).toEqual({ kind: "follow-title" });
    publish(
      snapshot(3, {
        audio: { state: "ready", options: [sound("one", "de"), sound("two", "de")] },
        selectedAudioId: "one",
      }),
    );
    await tick();
    expect(preferences.getMediaPreferences().audio).toEqual({ kind: "follow-title" });
    publish(
      snapshot(4, {
        audio: { state: "ready", options: [sound("one", "de")] },
        selectedAudioId: "one",
      }),
    );
    await tick();
    expect(preferences.getMediaPreferences().audio).toEqual({ kind: "language", language: "de" });
  });

  it.each(["disallowed", "absent", "loading", "unavailable"] as const)(
    "null selection in a newer %s subtitle group cannot confirm Off",
    async (state) => {
      await choosing({ kind: "follow-title" }, { kind: "language", language: "nl" });
      publish(snapshot(1, { selectedSubtitleId: "plain-nl" }));
      await tick();
      port.selectObservedTrackAsync.mockResolvedValue({ kind: "requested" });
      await choose("subtitles", "Off");
      publish(
        snapshot(2, {
          selectedSubtitleId: null,
          subtitleOffAllowed: state !== "disallowed",
          subtitles: { state: state === "disallowed" ? "ready" : state, options: [] },
        }),
      );
      await tick();
      expect(preferences.getMediaPreferences().subtitles).toEqual({
        kind: "language",
        language: "nl",
      });
    },
  );

  it.each([0, 1, 2] as const)(
    "Retry rematches a confirmed descriptor with %i matches honestly",
    async (matches) => {
      await choosing({ kind: "follow-title" });
      publish(snapshot(1));
      await tick();
      await choose("audio", "de");
      retry();
      await tick();
      const audio = [
        sound("en", "en", { isDefault: true }),
        sound("nl", "nl"),
        ...Array.from({ length: matches }, (_, index) => sound(`moved-${index}`, "de")),
      ];
      publish(snapshot(1, { audio: { state: "ready", options: audio }, selectedAudioId: "nl" }));
      await tick();
      expect(soundsRequested()).toEqual(["de", matches === 1 ? "moved-0" : "en"]);
      if (matches !== 1) {
        publish(
          snapshot(2, {
            audio: {
              state: "ready",
              options: [sound("en", "en", { isDefault: true }), sound("again", "de")],
            },
          }),
        );
        await tick();
        expect(soundsRequested()).toEqual(["de", "en", "again"]);
      }
    },
  );

  it("serializes queued manual groups and only remembers the newest audio operation", async () => {
    await choosing({ kind: "follow-title" });
    publish(snapshot(1));
    await tick();
    const german = (await trackChoices("audio")).find((row) => row.label === "de");
    const dutch = (await trackChoices("audio")).find((row) => row.label === "nl");
    const subtitles = (await trackChoices("subtitles")).find((row) => row.label === "nl · 2");
    if (!german || !dutch || !subtitles) throw new Error("Missing native rows");
    const ack = deferred<{ kind: "requested" }>();
    onTestFinished(() => ack.resolve({ kind: "requested" }));
    port.selectObservedTrackAsync.mockImplementationOnce(async () => ack.promise);
    const first = german.choose();
    await tick();
    const second = subtitles.choose();
    const newest = dutch.choose();
    await tick();
    expect(requests()).toEqual(["audio:de"]);
    expect(preferences.getMediaPreferences().audio).toEqual({ kind: "follow-title" });
    ack.resolve({ kind: "requested" });
    await Promise.all([first, second, newest]);
    expect(requests()).toEqual(["audio:de", "subtitles:plain-nl", "audio:nl"]);
    expect(preferences.getMediaPreferences().audio).toEqual({ kind: "language", language: "nl" });
    expect(preferences.getMediaPreferences().subtitles).toEqual({
      kind: "language",
      language: "nl",
    });
  });

  it("uses the same request queue for automatic audio and a manual subtitle tap", async () => {
    await choosing({ kind: "language", language: "nl" });
    const ack = deferred<{ kind: "requested" }>();
    onTestFinished(() => ack.resolve({ kind: "requested" }));
    port.selectObservedTrackAsync.mockImplementationOnce(async () => ack.promise);
    tracks = snapshot(1);
    port.tracks = tracks;
    const subtitles = (await trackChoices("subtitles")).find((row) => row.label === "nl · 2");
    if (!subtitles) throw new Error("No Dutch subtitle row");
    const picking = subtitles.choose();
    await tick();
    expect(requests()).toEqual(["audio:nl"]);
    tracks = { ...tracks, selectedAudioId: "nl" };
    port.tracks = tracks;
    ack.resolve({ kind: "requested" });
    await picking;
    expect(requests()).toEqual(["audio:nl", "subtitles:plain-nl"]);
    expect(preferences.getMediaPreferences().subtitles).toEqual({
      kind: "language",
      language: "nl",
    });
  });

  it("lets an unmatched subtitle hold follow sound until its descriptor returns and is confirmed", async () => {
    await choosing({ kind: "follow-title" }, { kind: "forced-only" });
    const german = text("plain-de", "de");
    publish(
      snapshot(1, {
        subtitles: {
          state: "ready",
          options: [text("en", "en", true), text("nl", "nl", true), german],
        },
        selectedSubtitleId: "en",
      }),
    );
    await tick();
    await choose("subtitles", "de");
    retry();
    await tick();
    publish(snapshot(1, { selectedSubtitleId: "en" }));
    await tick();
    await choose("audio", "nl");
    await tick();
    expect(captionsRequested()).toEqual(["plain-de", "nl"]);
    expect(preferences.getMediaPreferences().subtitles).toEqual({
      kind: "language",
      language: "de",
    });
    publish(
      snapshot(2, {
        subtitles: {
          state: "ready",
          options: [text("en", "en", true), text("nl", "nl", true), german],
        },
        selectedAudioId: "nl",
        selectedSubtitleId: "nl",
      }),
    );
    await tick();
    expect(captionsRequested()).toEqual(["plain-de", "nl", "plain-de"]);
    await choose("audio", "en");
    await tick();
    expect(captionsRequested()).toEqual(["plain-de", "nl", "plain-de"]);
  });
});
