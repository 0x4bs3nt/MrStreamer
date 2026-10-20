import type { PreferencePublication } from "../preference-publication.ts";
import type { HandlersFor } from "../ipc.ts";

export function preferenceHandlers({
  preferences,
}: {
  readonly preferences: PreferencePublication;
}): HandlersFor<"preferences"> {
  return {
    "preferences.get": () => preferences.get,
    "preferences.update": (patch) => preferences.update(patch),
  };
}
