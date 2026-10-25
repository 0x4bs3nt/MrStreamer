// Declaration probe for native groupFacts records and the public guarded-selection consumer.
// This checks the TS contract only. It does not execute or prove native media selection.
import type {
  AudioTrack,
  ObservedAudioTrack,
  ObservedSubtitleTrack,
  ObservedTrackSnapshot,
  SubtitleTrack,
  VideoPlayer,
} from "expo-video";

const nativeAudioWithoutLanguage = {
  id: "0",
  group: "audio",
  label: "Track 1",
  isDefault: true,
  isPlayable: true,
  autoSelect: true,
  attemptId: 1,
  itemId: 1,
  revision: 1,
} as const;
const nativeSubtitleWithoutLanguage = {
  ...nativeAudioWithoutLanguage,
  group: "subtitles",
  forcedOnly: true,
} as const;

export const audio: ObservedAudioTrack = nativeAudioWithoutLanguage;
export const subtitle: ObservedSubtitleTrack = nativeSubtitleWithoutLanguage;
export const knownAudio = {
  ...nativeAudioWithoutLanguage,
  language: "en",
} satisfies ObservedAudioTrack;
export const knownSubtitle = {
  ...nativeSubtitleWithoutLanguage,
  language: "nl",
} satisfies ObservedSubtitleTrack;
export const knownLanguages = [
  knownAudio.language.toLowerCase(),
  knownSubtitle.language.toLowerCase(),
];

export function normalizedNativeLanguage(track: ObservedAudioTrack | ObservedSubtitleTrack) {
  return track.language?.toLowerCase();
}

export function uncheckedNativeLanguage(track: ObservedAudioTrack | ObservedSubtitleTrack) {
  // @ts-expect-error A missing native tag cannot be assigned to a definite string.
  const language: string = track.language;
  // @ts-expect-error Consumers must handle native absence before using string methods.
  const lowered = track.language.toLowerCase();
  return { language, lowered };
}

// @ts-expect-error This correction does not relax the legacy audio declaration.
export const legacyAudio: AudioTrack = nativeAudioWithoutLanguage;
// @ts-expect-error This correction does not relax the legacy subtitle declaration.
export const legacySubtitle: SubtitleTrack = nativeSubtitleWithoutLanguage;
// @ts-expect-error Native item identity remains mandatory even when language is absent.
export const missingItem: ObservedAudioTrack = { ...knownAudio, itemId: undefined };
// @ts-expect-error The exact record still requires its snapshot revision.
export const missingRevision: ObservedSubtitleTrack = { ...knownSubtitle, revision: undefined };

export function requestNativeRecords(player: VideoPlayer, snapshot: ObservedTrackSnapshot) {
  return [
    player.selectObservedTrackAsync(snapshot, snapshot.revision, { kind: "audio", track: audio }),
    player.selectObservedTrackAsync(snapshot, snapshot.revision, {
      kind: "subtitles",
      track: subtitle,
    }),
  ];
}
