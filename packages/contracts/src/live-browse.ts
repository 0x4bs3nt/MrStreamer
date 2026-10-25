import { type } from "arktype";
import { lazy, type Infer } from "./lazy.ts";
import type { LiveChannel } from "./library.ts";

/** Stable discovery IDs. These never participate in channel identity or trusted joins. */
export const BROWSE_TOPICS = [
  "news",
  "sport",
  "kids",
  "movies",
  "entertainment",
  "music",
  "documentary",
  "regional",
  "other",
] as const;
export type BrowseTopic = (typeof BROWSE_TOPICS)[number];
const owned = () => type({ subscriptionId: "string > 0", id: "string" });
const topic = () => type.enumerated(...BROWSE_TOPICS);

/**
 * What Live TV, Watch and Home browse: every channel, a topic, a provider's category, or one of
 * the viewer's own lists by its id (`CustomList`). Releases before custom lists read a remembered
 * custom one as unknown and fall back to their own choice.
 */
export const LiveDiscovery = lazy(() =>
  type.or(
    { kind: "'all'" },
    { kind: "'topic'", topic: topic() },
    { kind: "'category'", category: owned() },
    { kind: "'custom'", id: "string > 0" },
  ),
);
export type LiveDiscovery = Infer<typeof LiveDiscovery>;

export interface LiveFilters {
  readonly countries: readonly string[];
  readonly languages: readonly string[];
  readonly subscriptions: readonly string[];
}
export const EMPTY_LIVE_FILTERS: LiveFilters = { countries: [], languages: [], subscriptions: [] };

export const LiveBrowseQuery = lazy(() =>
  type({
    scope: type.or(
      { kind: "'all'" },
      { kind: "'category'", category: owned() },
      {
        kind: "'channels'",
        channels: owned().array(),
      },
    ),
    filters: {
      browseTopics: topic().array(),
      countries: "string[]",
      languages: "string[]",
      subscriptions: "string[]",
    },
    visibility: "'viewer' | 'ordinary'",
  }),
);
export type LiveBrowseQuery = Infer<typeof LiveBrowseQuery>;

export interface BrowseMetadata {
  readonly topics: readonly BrowseTopic[];
  /** Only explicit, consistent country/language facts. Null means unknown, never a guess. */
  readonly country: string | null;
  readonly language: string | null;
}
export interface BrowseFacet {
  readonly value: string;
  readonly count: number;
}
/** Membership, totals and facets from one accepted catalogue and one visibility policy. */
export interface LiveBrowseResult {
  readonly channels: readonly LiveChannel[];
  readonly total: number;
  /** Any in each dimension, under the other active dimensions, including unknown facts. */
  readonly counts: Readonly<
    Record<"browseTopics" | "countries" | "languages" | "subscriptions", number>
  >;
  readonly facets: {
    readonly browseTopics: readonly BrowseFacet[];
    readonly countries: readonly BrowseFacet[];
    readonly languages: readonly BrowseFacet[];
    readonly subscriptions: readonly BrowseFacet[];
  };
}

/** Internal stored leaf. Read as unknown first so future versions cannot invalidate the file. */
export const RememberedLiveBrowse = lazy(() =>
  type({
    version: "1",
    selection: LiveDiscovery().exclude({ kind: "'all'" }),
    legacy: owned().or("null"),
  }),
);
