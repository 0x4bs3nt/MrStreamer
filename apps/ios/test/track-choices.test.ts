import type { AudioTrack, SubtitleTrack } from "expo-video";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Watch's Audio and Subtitles sheets list the tracks the player reports, check the one it plays
// and hand the chosen track back to it. The records are shaped as the iOS player reports them for
// a Matroska title with English stereo, English surround and Dutch. The native player is a
// stand-in: it keeps what it was handed and then reports that track as its own copy, as the native
// side does. Which option the native setter selects for a track is checked on the device.

const handed: Array<AudioTrack | SubtitleTrack | null> = [];
const fakePlayer = {
  muted: true,
  timeUpdateEventInterval: 0,
  addListener: () => undefined,
  availableAudioTracks: [] as AudioTrack[],
  availableSubtitleTracks: [] as SubtitleTrack[],
  current: { audio: null as AudioTrack | null, subtitles: null as SubtitleTrack | null },
  get audioTrack() {
    return this.current.audio;
  },
  set audioTrack(track: AudioTrack | null) {
    handed.push(track);
    this.current.audio = track && { ...track };
  },
  get subtitleTrack() {
    return this.current.subtitles;
  },
  set subtitleTrack(track: SubtitleTrack | null) {
    handed.push(track);
    this.current.subtitles = track && { ...track };
  },
};
vi.mock("expo-video", () => ({ createVideoPlayer: () => fakePlayer }));

const { trackChoices } = await import("../src/playback.ts");

/** The sheet as the viewer reads it: each row's label, checked or not. */
const sheet = (of: "audio" | "subtitles") =>
  trackChoices(of).map((choice) => `${choice.selected ? "✓ " : ""}${choice.label}`);

const choose = (of: "audio" | "subtitles", label: string) =>
  trackChoices(of)
    .find((choice) => choice.label === label)
    ?.choose();

const sounds = (ids: boolean): AudioTrack[] =>
  [
    { language: "en", label: "English", name: "Stereo 1", isDefault: false },
    { language: "en", label: "English", name: "Surround 2", isDefault: true },
    { language: "nl", label: "Dutch", name: "nld 3", isDefault: false },
  ].map((track, i) => (ids ? { id: String(i), ...track } : track));

beforeEach(() => {
  handed.length = 0;
});

describe("sound tracks of one language", () => {
  it("checks only the track playing and names each apart", () => {
    fakePlayer.availableAudioTracks = sounds(true);
    fakePlayer.current.audio = { ...sounds(true)[1]! };

    expect(sheet("audio")).toEqual(["English · Stereo 1", "✓ English · Surround 2", "Dutch"]);
  });

  it("hands the player the very track chosen, each way", () => {
    fakePlayer.availableAudioTracks = sounds(true);
    fakePlayer.current.audio = { ...sounds(true)[1]! };

    choose("audio", "English · Stereo 1");
    expect(sheet("audio")).toEqual(["✓ English · Stereo 1", "English · Surround 2", "Dutch"]);
    choose("audio", "English · Surround 2");
    expect(sheet("audio")).toEqual(["English · Stereo 1", "✓ English · Surround 2", "Dutch"]);
    choose("audio", "Dutch");
    expect(sheet("audio")).toEqual(["English · Stereo 1", "English · Surround 2", "✓ Dutch"]);

    expect(handed).toEqual([sounds(true)[0], sounds(true)[1], sounds(true)[2]]);
  });

  it("tells them apart by name when the player gives no id", () => {
    fakePlayer.availableAudioTracks = sounds(false);
    fakePlayer.current.audio = { ...sounds(false)[1]! };

    expect(sheet("audio")).toEqual(["English · Stereo 1", "✓ English · Surround 2", "Dutch"]);
  });
});

describe("subtitle tracks of one language", () => {
  const subtitles: SubtitleTrack[] = [
    { id: "0", language: "en", label: "English" },
    { id: "1", language: "en", label: "English" },
  ];

  it("numbers unnamed tracks, checks one, and keeps Off first", () => {
    fakePlayer.availableSubtitleTracks = subtitles;
    fakePlayer.current.subtitles = { ...subtitles[1]! };

    expect(sheet("subtitles")).toEqual(["Off", "English · 1", "✓ English · 2"]);

    choose("subtitles", "English · 1");
    expect(sheet("subtitles")).toEqual(["Off", "✓ English · 1", "English · 2"]);
    choose("subtitles", "Off");
    expect(sheet("subtitles")).toEqual(["✓ Off", "English · 1", "English · 2"]);

    expect(handed).toEqual([subtitles[0], null]);
  });
});
