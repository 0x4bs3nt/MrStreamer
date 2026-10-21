import "./support.ts";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { LiveBrowseResult } from "@mrstreamer/contracts/live-browse";
import { ownedId, type OwnedId } from "@mrstreamer/contracts/subscription";
import { queries } from "../../src/renderer/src/lib/queries.ts";

/** Service replies for renderer fixtures; classification and visibility are tested in Library. */
export const browseResult = (channels: readonly LiveChannel[]): LiveBrowseResult => ({
  channels,
  total: channels.length,
  counts: { browseTopics: 0, countries: 0, languages: 0, subscriptions: 0 },
  facets: { browseTopics: [], countries: [], languages: [], subscriptions: [] },
});
export const browseChannels = (category: OwnedId | null) =>
  queries.browse({
    scope: category ? { kind: "category", category } : { kind: "all" },
    filters: { browseTopics: [], countries: [], languages: [], subscriptions: [] },
    visibility: "ordinary",
  });
export const browseChannelsOf = (channels: readonly OwnedId[]) =>
  queries.browse({
    scope: { kind: "channels", channels: channels.map(ownedId) },
    filters: { browseTopics: [], countries: [], languages: [], subscriptions: [] },
    visibility: "ordinary",
  });
