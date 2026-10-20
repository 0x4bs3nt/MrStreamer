import { Failed } from "@mrstreamer/core/failure";
import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import type { Guide } from "@mrstreamer/core/guide/service";
import type { Library } from "../services/library.ts";

export function guideHandlers({
  guide,
  library,
}: {
  readonly guide: Guide["Service"];
  readonly library: Pick<Library["Service"], "channels">;
}): HandlersFor<"guide"> {
  return {
    "guide.listings": ({ channels }) => guide.listings(channels),
    "guide.schedule": ({ channel, from, until }) => guide.schedule(channel, from, until),
    "guide.range": ({ channels, from, to }) => guide.range(channels, from, to),
    "guide.programme": ({ channel, guide: guideId, start }) =>
      guide.programme(channel, guideId, start),
    "guide.search": ({ query }) => guide.search(query),
    // The transport owns cancellation and validates sender/frame ownership.
    "guide.cancelSearch": () => Effect.succeed(null),
    "guide.searchList": ({ query, until, request: _request, ...list }) =>
      Effect.flatMap(library.channels(list), (channels) =>
        guide.searchChannels(query, channels, until),
      ),
    "guide.status": () => guide.status,
    "guide.refresh": ({ subscriptionId }) =>
      Effect.gen(function* () {
        yield* guide.refresh(subscriptionId);
        const status = (yield* guide.status).find((each) => each.subscriptionId === subscriptionId);
        // Removed while its guide downloaded.
        return status ?? (yield* new Failed({ error: { kind: "no-subscription" } }));
      }),
    "guide.sources": () => guide.sources,
    "guide.addSource": ({ address, label }) => guide.addSource(address, label),
    "guide.removeSource": ({ id }) => Effect.as(guide.removeSource(id), null),
    "guide.moveSource": ({ id, by }) => Effect.as(guide.moveSource(id, by), null),
    "guide.refreshSource": ({ id }) => guide.refreshSource(id),
    "guide.renameSource": ({ id, label }) => guide.renameSource(id, label),
    "guide.map": ({ subscriptionId, channelId, guide: ref, revision }) =>
      guide.map(subscriptionId, channelId, ref, revision),
    "guide.mapChannels": (query) => guide.mapChannels(query),
    "guide.mapOptions": (query) => guide.mapOptions(query),
  };
}
