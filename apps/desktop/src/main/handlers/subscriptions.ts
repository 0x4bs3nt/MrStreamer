import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import type { Subscriptions } from "../services/subscription.ts";
import type { Roster } from "../services/roster.ts";
import type { Settings } from "../services/preferences.ts";

export function subscriptionHandlers({
  subscriptions,
  roster,
  settings,
}: {
  readonly subscriptions: Pick<
    Subscriptions["Service"],
    "list" | "playlistGroups" | "playlistOmissions" | "recheck"
  >;
  readonly roster: Pick<Roster["Service"], "add" | "update" | "remove" | "mapPlaylist">;
  readonly settings: Pick<Settings["Service"], "ofSubscription" | "updateSubscription">;
}): HandlersFor<"subscription" | "playlist"> {
  return {
    "subscription.list": () => subscriptions.list,
    "playlist.groups": ({ subscriptionId, query, offset, limit }) =>
      subscriptions.playlistGroups(subscriptionId, query, offset, limit),
    "playlist.omissions": ({ subscriptionId, offset, limit }) =>
      subscriptions.playlistOmissions(subscriptionId, offset, limit),
    "playlist.map": ({ subscriptionId, group, mode }) =>
      roster.mapPlaylist(subscriptionId, group, mode),
    "subscription.add": (login) => roster.add(login),
    "subscription.update": ({ subscriptionId, ...change }) => roster.update(subscriptionId, change),
    "subscription.remove": ({ subscriptionId, eraseViewing }) =>
      Effect.as(roster.remove(subscriptionId, eraseViewing ?? false), null),
    "subscription.recheck": ({ subscriptionId }) => subscriptions.recheck(subscriptionId),
    "subscription.preferences": ({ subscriptionId }) => settings.ofSubscription(subscriptionId),
    "subscription.updatePreferences": ({ subscriptionId, patch }) =>
      settings.updateSubscription(subscriptionId, patch),
  };
}
