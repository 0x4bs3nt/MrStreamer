// Library filters use provider hints and tracks read on this device as separate sources.
import { type } from "arktype";
import { lazy, type Infer } from "./lazy.ts";

export const QUALITY_HINTS = ["4k", "full-hd", "hd", "sd", "unknown"] as const;
export type QualityHint = (typeof QUALITY_HINTS)[number];

export const TitleFilters = lazy(() =>
  type({
    "quality?": "'4k' | 'full-hd' | 'hd' | 'sd' | 'unknown'",
    "language?": "string > 0",
    "verified?": {
      kind: "'audio' | 'subtitles'",
      language: "string > 0",
    },
  }),
);
export type TitleFilters = Infer<typeof TitleFilters>;

export interface FilterOptions {
  readonly qualities: readonly QualityHint[];
  readonly languages: readonly string[];
  readonly verified: readonly { readonly kind: "audio" | "subtitles"; readonly language: string }[];
  /** Current exact files whose tracks have been read, not the number of titles or episodes. */
  readonly files: number;
}
