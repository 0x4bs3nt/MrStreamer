import { randomUUID } from "node:crypto";
import { seriesEpisodeSeasons } from "@mrstreamer/core/ondemand/details";
import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import type { OnDemand } from "../services/ondemand.ts";
import type { Watchlist } from "../services/watchlist.ts";
import type { ViewingRecord } from "@mrstreamer/core/viewing/service";
import type { Subscriptions } from "../services/subscription.ts";
import type { Roster } from "../services/roster.ts";

export function titleHandlers({
  onDemand,
  watchlist,
  viewing,
  subscriptions,
  roster,
}: {
  readonly onDemand: OnDemand["Service"];
  readonly watchlist: Watchlist["Service"];
  readonly viewing: Pick<ViewingRecord["Service"], "relist">;
  readonly subscriptions: Pick<Subscriptions["Service"], "sourceOf">;
  readonly roster: Pick<Roster["Service"], "refreshPlaylist">;
}): HandlersFor<"ondemand" | "watchlist"> {
  return {
    "ondemand.status": () => onDemand.status,
    "ondemand.refresh": ({ subscriptionId }) =>
      Effect.gen(function* () {
        const source = yield* subscriptions.sourceOf(subscriptionId);
        return source.kind === "m3u"
          ? (yield* roster.refreshPlaylist(subscriptionId)).titles
          : yield* onDemand.refresh(subscriptionId);
      }),
    "ondemand.search": ({ query }) => onDemand.search(query),
    "ondemand.searchKind": ({ kind, query, filters }) => onDemand.searchKind(kind, query, filters),
    "ondemand.filterOptions": ({ kind }) => onDemand.filterOptions(kind),
    "ondemand.details": ({ kind, version }) =>
      Effect.tap(onDemand.details(kind, version), (details) =>
        // What a series lists now says where its marks have it go on, on Home as in the sheet.
        details.kind === "series"
          ? Effect.ignore(viewing.relist(randomUUID(), version, seriesEpisodeSeasons(details)))
          : Effect.void,
      ),
    "ondemand.season": ({ series, season }) => onDemand.season(series, season),
    "ondemand.titles": ({ kind, versions }) => onDemand.titles(kind, versions),
    "ondemand.rows": ({ kind, tab, like }) => onDemand.rows(kind, tab, like),
    "ondemand.related": ({ kind, version }) => onDemand.related(kind, version),
    "ondemand.recommendations": ({ seeds }) => onDemand.recommendations(seeds),
    "ondemand.tiles": ({ kind, of }) => onDemand.tiles(kind, of),
    "ondemand.collection": (query) => onDemand.collection(query),
    "watchlist.list": (query) => watchlist.list(query),
    "watchlist.saved": ({ kind, version }) => watchlist.saved(kind, version),
    "watchlist.save": ({ kind, version }) => watchlist.save(kind, version),
    "watchlist.remove": ({ entry }) => Effect.as(watchlist.remove(entry), null),
  };
}
