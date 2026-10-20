import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import type { Library } from "../services/library.ts";
import type { Subscriptions } from "../services/subscription.ts";
import type { Roster } from "../services/roster.ts";
import type { Settings } from "../services/preferences.ts";

export function libraryHandlers({
  library,
  subscriptions,
  roster,
  settings,
}: {
  readonly library: Library["Service"];
  readonly subscriptions: Pick<Subscriptions["Service"], "sourceOf">;
  readonly roster: Pick<Roster["Service"], "refreshPlaylist">;
  readonly settings: Pick<Settings["Service"], "liveBrowse" | "rememberLiveBrowse">;
}): HandlersFor<"library" | "liveBrowse"> {
  return {
    "liveBrowse.get": () => settings.liveBrowse,
    "liveBrowse.remember": (selection) => settings.rememberLiveBrowse(selection),
    "library.browse": (query) => library.browse(query),
    "library.status": () => library.status,
    "library.categories": () => library.categories,
    "library.channels": (filter) => library.channels(filter),
    "library.searchGroups": () => library.searchGroups,
    "library.channel": ({ channel }) => library.channel(channel),
    "library.refresh": ({ subscriptionId }) =>
      Effect.gen(function* () {
        const source = yield* subscriptions.sourceOf(subscriptionId);
        return source.kind === "m3u"
          ? (yield* roster.refreshPlaylist(subscriptionId)).catalogue
          : yield* library.refresh(subscriptionId);
      }),
  };
}
