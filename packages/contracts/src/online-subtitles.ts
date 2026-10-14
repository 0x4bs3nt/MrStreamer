// Online search is opt-in. Saved account secrets and service download URLs never leave main.
import { type } from "arktype";
import { lazy, type Infer } from "./lazy.ts";

export const SUBTITLE_SERVICES = ["subdl", "opensubtitles"] as const;
export type SubtitleService = (typeof SUBTITLE_SERVICES)[number];

export const SubtitleTiming = lazy(() =>
  type({
    offset: "-600 <= number <= 600",
    /** Subtitle clock multiplied by this ratio, then shifted by offset seconds. */
    speed: "0.9 <= number <= 1.1",
  }),
);
export type SubtitleTiming = Infer<typeof SubtitleTiming>;
export const DEFAULT_SUBTITLE_TIMING: SubtitleTiming = { offset: 0, speed: 1 };

export const OnlineSubtitlePreferences = lazy(() =>
  type({
    enabled: "boolean",
    languages: "string[] <= 10",
    service: "'both' | 'subdl' | 'opensubtitles'",
  }),
);
export type OnlineSubtitlePreferences = Infer<typeof OnlineSubtitlePreferences>;

export interface OnlineSubtitleSettings extends OnlineSubtitlePreferences {
  /** Presence only. Secrets are entered again to replace them, never echoed. */
  readonly configured: Readonly<Record<SubtitleService, boolean>>;
}

export interface SubtitleCredentials {
  readonly subdl?: { readonly apiKey: string } | null;
  readonly opensubtitles?: {
    readonly apiKey: string;
    readonly username: string;
    readonly password: string;
  } | null;
}

/** Input only. Settings responses expose presence, never the saved secrets. */
export const SubtitleCredentialInput = lazy(() =>
  type({
    "subdl?": type({ apiKey: "0 < string <= 4096" }).or("null"),
    "opensubtitles?": type({
      apiKey: "0 < string <= 4096",
      username: "0 < string <= 512",
      password: "0 < string <= 4096",
    }).or("null"),
  }),
);

export interface OnlineSubtitleResult {
  /** Opaque main-owned search result. Choosing it explicitly may consume a service download. */
  readonly id: string;
  readonly service: SubtitleService;
  readonly language: string;
  readonly release: string;
  readonly hearingImpaired: boolean;
  readonly downloads: number | null;
}

export type SubtitleServiceFailure =
  "not-configured" | "credentials" | "quota" | "unavailable" | "unsupported";

export interface OnlineSubtitleSearch {
  readonly results: readonly OnlineSubtitleResult[];
  readonly failures: readonly {
    readonly service: SubtitleService;
    readonly reason: SubtitleServiceFailure;
  }[];
}

/** Actual service allowance, when its download response reports one. */
export interface SubtitleQuota {
  readonly service: SubtitleService;
  readonly remaining: number;
  readonly resetAt: string | null;
}

export interface OnlineSubtitleChoice {
  readonly saved: SavedSubtitle;
  readonly quota: SubtitleQuota | null;
}

export const DownloadedSubtitle = lazy(() =>
  type({
    service: "'subdl' | 'opensubtitles'",
    language: "string <= 64",
    release: "string <= 1024",
    cues: type({
      start: "0 <= number <= 86400",
      end: "0 < number <= 86400",
      text: "string <= 32768",
    })
      .narrow(({ start, end }) => end > start)
      .array()
      .atMostLength(100000)
      .narrow((cues) => cues.reduce((size, cue) => size + cue.text.length, 0) <= 10 * 1024 * 1024),
  }),
);
export type DownloadedSubtitle = Infer<typeof DownloadedSubtitle>;

export const SavedSubtitle = lazy(() =>
  type({
    /** Opaque cached-result identity. Timing writes name the result they edit. */
    "selection?": "0 < string <= 64",
    /**
     * False once the viewer chose Off or a file track over this result in this exact file. It
     * then stays listed with its timing and no longer shows by itself when the file opens.
     * Absent: shown.
     */
    "shown?": "boolean",
    timing: SubtitleTiming(),
    subtitle: DownloadedSubtitle().or("null"),
  }),
);
export type SavedSubtitle = Infer<typeof SavedSubtitle>;
