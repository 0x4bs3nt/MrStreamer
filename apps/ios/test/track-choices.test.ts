import type { ObservedAudioTrack, ObservedSubtitleTrack, ObservedTrackSnapshot } from "expo-video";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativePlayer } from "./native-player.ts";

// The real playback owner queries a native-port stand-in. Labels are display names, not facts.
const port = nativePlayer();
vi.mock("expo-video", () => ({ createVideoPlayer: () => port }));
const { play, stop, trackChoices } = await import("../src/playback.ts");
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
  play(item, async () => ({ url: "file:movie.mp4", container: "mp4" }), { watch: true, login: [] });
const sheet = async (of: "audio" | "subtitles") =>
  (await trackChoices(of)).map((choice) => `${choice.selected ? "✓ " : ""}${choice.label}`);
const choose = async (of: "audio" | "subtitles", label: string) =>
  (await trackChoices(of)).find((choice) => choice.label === label)?.choose();
let tracks: ObservedTrackSnapshot;

beforeEach(async () => {
  await stop();
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
afterEach(() => stop());

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
    expect(port.selectObservedTrackAsync.mock.calls.map((call) => call[2].track)).toEqual(
      tracks.audio.options,
    );
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
