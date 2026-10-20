import type { SubtitleLook } from "@mrstreamer/contracts/preferences";
import type { PlainKey } from "@mrstreamer/core/i18n";

/** Each choice's word on its button, and its whole name for assistive technology. */
export const SUBTITLE_SIZES = [
  { value: "small", short: "S", label: "Small" },
  { value: "medium", short: "M", label: "Medium" },
  { value: "large", short: "L", label: "Large" },
] as const satisfies readonly Segment<SubtitleLook["size"]>[];
export const SUBTITLE_BACKGROUNDS = [
  { value: "box", short: "Box", label: "Box" },
  { value: "shadow", short: "Shadow", label: "Shadow" },
] as const satisfies readonly Segment<SubtitleLook["background"]>[];
export const SUBTITLE_POSITIONS = [
  { value: "low", short: "Low", label: "Low" },
  { value: "high", short: "Higher", label: "Higher" },
] as const satisfies readonly Segment<SubtitleLook["position"]>[];

export interface Segment<V extends string> {
  readonly value: V;
  readonly short: PlainKey;
  readonly label: PlainKey;
}
