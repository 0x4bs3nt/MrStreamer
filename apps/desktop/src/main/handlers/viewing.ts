import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import type { ViewingRecord } from "@mrstreamer/core/viewing/service";
import type { Settings } from "../services/preferences.ts";

export function viewingHandlers({
  viewing,
  settings,
}: {
  readonly viewing: ViewingRecord["Service"];
  readonly settings: Pick<Settings["Service"], "updateSubscription">;
}): HandlersFor<"viewing"> {
  return {
    "viewing.get": () => viewing.state,
    "viewing.setFavourite": ({ commandId, channel, favourite }) =>
      viewing.setFavourite(commandId, channel, favourite),
    "viewing.reorderFavourites": ({ commandId, original, order }) =>
      viewing.reorderFavourites(commandId, { original, order }),
    "viewing.recordWatch": ({ commandId, channel }) =>
      Effect.andThen(
        settings.updateSubscription(channel.subscriptionId, { lastChannelId: channel.id }),
        viewing.recordWatch(commandId, channel),
      ),
    "viewing.recordProgress": ({ commandId, title, position, duration, since }) =>
      viewing.recordProgress(commandId, title, position, duration, since),
    "viewing.removeFromContinue": ({ commandId, titles }) =>
      viewing.removeFromContinue(commandId, titles),
    "viewing.finishSeries": ({ commandId, series, since }) =>
      viewing.finishSeries(commandId, series, since),
    "viewing.progress": (titles) => viewing.progress(titles),
    "viewing.episodes": ({ series }) => viewing.episodes(series),
    "viewing.markEpisode": ({ commandId, episode, watched }) =>
      viewing.markEpisode(commandId, episode, watched),
    "viewing.undoMark": ({ commandId, series, revision }) =>
      Effect.as(viewing.undoMark(commandId, series, revision), null),
  };
}
