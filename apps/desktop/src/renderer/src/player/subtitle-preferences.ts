import type { SubtitleTrack } from "@mrstreamer/contracts/playback";
import { t } from "@mrstreamer/core/i18n";
import { flashNote } from "../features/watch/flash-state.ts";
import { appError, describeError } from "../lib/errors.ts";
import { updatePreferences } from "../lib/preferences.ts";

/** Remembers a channel/title subtitle language, or Off. A track without a language keeps it. */
export function rememberSubtitles(track: SubtitleTrack | null): void {
  const language = track ? track.language : "off";
  if (language === null) return;
  void updatePreferences({ subtitleLanguage: language }).catch((error: unknown) => {
    flashNote(`${t("Subtitles")}: ${describeError(appError(error))}`, true);
  });
}
