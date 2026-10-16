import { type } from "arktype";
import { QUALITIES, type Quality } from "./library.ts";
import { lazy, type Infer } from "./lazy.ts";

/**
 * Viewing preferences that survive restarts and hold whichever subscription plays. What the
 * viewer left one subscription at is `SubscriptionPreferences`. Favourites and recently watched
 * channels live in the viewing record; files from before it may still carry them until imported.
 */
export const Preferences = lazy(() =>
  type({
    /** Stable Home row IDs. Unknown IDs survive an older release; absent uses defaults. */
    "homeRows?": type({ id: "string > 0", visible: "boolean" }).array(),
    volume: "0 <= number <= 1",
    muted: "boolean",
    /**
     * The sound to play: "nl", or ORIGINAL_SOUND for the language a title was made in. Set in
     * Settings, and by the sound track picked last. Absent plays the language for movies and
     * series.
     */
    "audioLanguage?": "string | null",
    /**
     * Subtitles to show: a language, "off" for none, or absent or null for only those forced for
     * the sound's language. Set in Settings, and by the subtitles picked last.
     */
    "subtitleLanguage?": "string | null",
    /**
     * The language for movies and series, an ISO 639-1 code: which version of a film shows and
     * plays first, and the sound until another is picked. English when absent.
     */
    "titleLanguage?": "string",
    /** The viewer's own TMDB key or read access token, used instead of the app's. */
    "tmdbKey?": "string",
    /** Titles the provider marks for adults show, in their own tab. Off when absent. */
    "adultTitles?": "boolean",
    /**
     * A series' next episode plays after a ten-second countdown at the end of one. On when
     * absent.
     */
    "autoplayNext?": "boolean",
    /**
     * Product-use and reliability statistics. On when absent; saved by the analytics
     * owner.
     */
    "analyticsEnabled?": "boolean",
    /**
     * How subtitles look: their size, a box or a shadow behind text, and how high they sit. A new
     * choice needs a new key: a release that meets a value it doesn't know drops the whole file.
     */
    "subtitleLook?": {
      size: "'small' | 'medium' | 'large'",
      background: "'box' | 'shadow'",
      position: "'low' | 'high'",
    },
    /**
     * The quality live channels start in. `DEFAULT_LIVE_QUALITY` when absent. A new quality needs a
     * new key, as for `subtitleLook`.
     */
    "liveQuality?": type.enumerated(...QUALITIES),
    /**
     * How Live TV shows a list: a row per channel, or the guide grid of channels by time. The list
     * when absent. A new view needs a new key, as for `subtitleLook`.
     */
    "liveView?": "'list' | 'grid'",
  }),
);
export type Preferences = Infer<typeof Preferences>;
export type SubtitleLook = NonNullable<Preferences["subtitleLook"]>;
export type LiveView = NonNullable<Preferences["liveView"]>;

/**
 * What the viewer left one subscription at: where Live TV opens, and the versions and streams
 * picked. Every id in it is the provider's own, so none of it holds for another subscription.
 */
export const SubscriptionPreferences = lazy(() =>
  type({
    lastChannelId: "string | null",
    lastCategoryId: "string | null",
    /**
     * The version the viewer picked for a movie or series, by kind and TMDB id: "movie:603" to the
     * version's id. Titles without one play the version that suits them best.
     */
    "titleVersions?": "Record<string, string>",
    /**
     * The stream the viewer chose for a live channel, by the channel's id: the stream's id.
     * Channels without one play `liveQuality` automatically.
     */
    "channelVariants?": "Record<string, string>",
  }),
);
export type SubscriptionPreferences = Infer<typeof SubscriptionPreferences>;

/** Subtitles as Chromium draws text cues: its own size, on a box, at the foot of the picture. */
export const DEFAULT_SUBTITLE_LOOK: SubtitleLook = {
  size: "medium",
  background: "box",
  position: "low",
};

/** `audioLanguage` for the sound in the language a title was made in. */
export const ORIGINAL_SOUND = "original";

/** The quality live channels start in until the viewer picks another: Full HD. */
export const DEFAULT_LIVE_QUALITY: Quality = "fhd";

export const defaultPreferences: Preferences = { volume: 1, muted: false };

export const defaultSubscriptionPreferences: SubscriptionPreferences = {
  lastChannelId: null,
  lastCategoryId: null,
};
