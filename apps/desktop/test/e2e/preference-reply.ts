import type { PreferenceSnapshot } from "../../../../packages/contracts/src/ipc.ts";
import type { Preferences } from "../../../../packages/contracts/src/preferences.ts";

/** Installed upgrade checks also run old binaries, before the IPC publication envelope existed. */
export function preferenceValues(reply: Preferences | PreferenceSnapshot): Preferences {
  return "preferences" in reply ? reply.preferences : reply;
}
