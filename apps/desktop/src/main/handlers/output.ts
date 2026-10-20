import { ownedId } from "@mrstreamer/contracts/subscription";
import { observeOpen } from "../analytics/playback.ts";
import { streamsOf } from "./streams.ts";
import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import type { Output } from "../services/output.ts";
import type { PlaybackCoordination } from "../services/playback-coordination.ts";
import type { Library } from "../services/library.ts";
import type { OnDemand } from "../services/ondemand.ts";
import type { Settings } from "../services/preferences.ts";
import type { Analytics } from "../analytics/service.ts";

export function outputHandlers({
  output,
  coordination,
  library,
  onDemand,
  settings,
  analytics,
  pickList,
}: {
  readonly output: Pick<
    Output["Service"],
    | "status"
    | "scan"
    | "connect"
    | "closePicker"
    | "disconnect"
    | "playChannel"
    | "openTitle"
    | "playTitle"
    | "command"
    | "setVolume"
    | "playingTitle"
  >;
  readonly coordination: Pick<PlaybackCoordination["Service"], "begin" | "passed">;
  readonly library: Pick<Library["Service"], "channel">;
  readonly onDemand: Pick<OnDemand["Service"], "file">;
  readonly settings: Pick<Settings["Service"], "get" | "ofSubscription">;
  readonly analytics: Pick<
    Analytics,
    | "admitPlayback"
    | "playbackFailureObserver"
    | "isPlaybackControlCurrent"
    | "receiverLoadFailureObserver"
  >;
  readonly pickList: HandlersFor<"output">["output.pick"];
}): HandlersFor<"output"> {
  return {
    "output.status": () => output.status,
    "output.scan": ({ on }) => Effect.as(output.scan(on), null),
    "output.connect": ({ receiverId }) => output.connect(receiverId),
    "output.pick": pickList,
    "output.closePicker": ({ request }) => Effect.as(output.closePicker(request), null),
    "output.disconnect": () => Effect.as(output.disconnect, null),
    "output.playChannel": (
      { channel: named, variant, audio, audioLanguage, name, measurement },
      frame,
    ) => {
      const token = analytics.admitPlayback("live", measurement, frame);
      const control =
        measurement && analytics.isPlaybackControlCurrent(measurement.control, frame)
          ? measurement.control
          : undefined;
      return observeOpen(
        coordination,
        () => analytics.playbackFailureObserver(token ?? undefined),
        (turn) =>
          Effect.gen(function* () {
            const channel = yield* library.channel(named);
            const variants = yield* streamsOf(settings, channel, variant);
            return yield* output.playChannel(ownedId(channel), {
              variants,
              audio: audio ?? null,
              audioLanguage: audioLanguage ?? null,
              shown: { name },
              turn,
              measurement: control,
            });
          }),
      );
    },
    "output.openTitle": ({ title, since, measurement }, frame) => {
      const token = analytics.admitPlayback("vod", measurement, frame);
      const control =
        measurement && analytics.isPlaybackControlCurrent(measurement.control, frame)
          ? measurement.control
          : undefined;
      return observeOpen(
        coordination,
        () => analytics.playbackFailureObserver(token ?? undefined),
        (turn) =>
          Effect.gen(function* () {
            const { url, revision, headers, listingKey } = yield* onDemand.file(title);
            return yield* output.openTitle(title, url, since, {
              turn,
              measurement: control,
              revision,
              headers,
              listingKey,
            });
          }),
      );
    },
    "output.playTitle": (
      { sessionId, measurement, position, audio, subtitle, paused, name, detail, artworkUrl },
      frame,
    ) => {
      analytics.admitPlayback("vod", measurement, frame);
      const control =
        measurement && analytics.isPlaybackControlCurrent(measurement.control, frame)
          ? measurement.control
          : undefined;
      const failedBeforeLoad = analytics.receiverLoadFailureObserver(control, frame);
      return output.playTitle(sessionId, {
        measurement: control,
        onPreloadFailure: failedBeforeLoad,
        position,
        audio,
        subtitle,
        paused,
        shown: { name, detail, artworkUrl },
      });
    },
    "output.command": ({ generation, ...command }) =>
      Effect.as(output.command(generation, command), null),
    "output.volume": (volume) => Effect.as(output.setVolume(volume), null),
    "output.playingTitle": () => output.playingTitle,
  };
}
