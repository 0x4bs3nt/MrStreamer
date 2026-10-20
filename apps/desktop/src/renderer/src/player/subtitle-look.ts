import type { QueryClient } from "@tanstack/react-query";
import { DEFAULT_SUBTITLE_LOOK, type SubtitleLook } from "@mrstreamer/contracts/preferences";
import { currentPreferences, readPreferences, updatePreferences } from "../lib/preferences.ts";
import { setSubtitleLook } from "./subtitles.ts";

// Shared by CC and Settings, independent of either editor's mount. The query cache alone owns
// committed preferences; this object holds only the latest unacknowledged whole-look intent.
let pending: SubtitleLook | null = null;

/** Composition applies committed looks only when no newer local edit is awaiting its answer. */
export function hydrateSubtitleLook(look: SubtitleLook): void {
  if (!pending) setSubtitleLook(look);
}

/** Merge against the latest intent across editors. Superseded failures have no feedback. */
export async function updateSubtitleLook(
  patch: Partial<SubtitleLook>,
  { client, onError }: { client?: QueryClient; onError?: (error: unknown) => void } = {},
): Promise<void> {
  const next = {
    ...(pending ?? currentPreferences(client)?.subtitleLook ?? DEFAULT_SUBTITLE_LOOK),
    ...patch,
  };
  pending = next;
  setSubtitleLook(next);
  try {
    const saved = await updatePreferences({ subtitleLook: next }, client);
    if (pending === next) {
      pending = null;
      setSubtitleLook(saved.subtitleLook ?? DEFAULT_SUBTITLE_LOOK);
    }
  } catch (error) {
    if (pending === next) {
      // Partial writes can have committed. Refresh through the same acceptance/cache owner.
      await readPreferences(client).catch(() => {});
      if (pending === next) {
        pending = null;
        setSubtitleLook(currentPreferences(client)?.subtitleLook ?? DEFAULT_SUBTITLE_LOOK);
        onError?.(error);
        throw error;
      }
    }
  }
}
