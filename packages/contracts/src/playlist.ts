// Public playlist import settings and reports. Stream addresses and headers stay in main.
import { type } from "arktype";
import { lazy, type Infer } from "./lazy.ts";

export const PlaylistMode = lazy(() => type("'live' | 'movie' | 'series' | 'skip'"));
export type PlaylistMode = Infer<typeof PlaylistMode>;
export const PlaylistMapping = lazy(() =>
  type({
    version: "1",
    groups: type({ group: "string <= 512", mode: PlaylistMode() }).array().atMostLength(10_000),
  }),
);
export type PlaylistMapping = Infer<typeof PlaylistMapping>;

export type PlaylistOmissionReason =
  | "unmapped"
  | "conflicting-groups"
  | "unsupported-address"
  | "missing-name"
  | "invalid-episode"
  | "skip";

export interface PlaylistOmission {
  readonly name: string;
  readonly groups: readonly string[];
  readonly reason: PlaylistOmissionReason;
}

export interface PlaylistSample {
  readonly name: string;
  readonly groups: readonly string[];
  readonly reason: PlaylistOmissionReason | null;
}

export interface PlaylistGroup {
  /** Opaque mapping key, including the key for entries without a group. */
  readonly group: string;
  readonly name: string;
  readonly mode: PlaylistMode | null;
  readonly entries: number;
  readonly samples: readonly PlaylistSample[];
}

export interface PlaylistImportStatus {
  readonly explicit: boolean;
  readonly groups: number;
  readonly live: number;
  readonly movies: number;
  readonly series: number;
  readonly episodes: number;
  readonly omitted: number;
}

export interface PlaylistGroupPage {
  readonly status: PlaylistImportStatus;
  readonly total: number;
  readonly groups: readonly PlaylistGroup[];
}

export interface PlaylistOmissionPage {
  readonly total: number;
  readonly entries: readonly PlaylistOmission[];
}
