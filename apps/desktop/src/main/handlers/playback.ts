import { ownedId } from "@mrstreamer/contracts/subscription";
import { Failed } from "@mrstreamer/core/failure";
import { t } from "@mrstreamer/core/i18n";
import { observeOpen } from "../analytics/playback.ts";
import { streamsOf } from "./streams.ts";
import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import type { Playback } from "../services/playback.ts";
import type { PlaybackCoordination } from "../services/playback-coordination.ts";
import type { Library } from "../services/library.ts";
import type { OnDemand } from "../services/ondemand.ts";
import type { Downloads } from "../services/downloads.ts";
import type { Output } from "../services/output.ts";
import type { Settings } from "../services/preferences.ts";
import type { Analytics } from "../analytics/service.ts";

export function playbackHandlers({
  playback,
  coordination,
  library,
  onDemand,
  downloads,
  output,
  settings,
  analytics,
}: {
  readonly playback: Playback["Service"];
  readonly coordination: Pick<PlaybackCoordination["Service"], "begin" | "passed">;
  readonly library: Pick<Library["Service"], "channel">;
  readonly onDemand: Pick<OnDemand["Service"], "file">;
  readonly downloads: Pick<Downloads["Service"], "copy">;
  readonly output: Pick<Output["Service"], "remote">;
  readonly settings: Pick<Settings["Service"], "get" | "ofSubscription">;
  readonly analytics: Pick<Analytics, "admitPlayback" | "playbackFailureObserver">;
}): HandlersFor<"playback"> {
  return {
    "playback.open": (
      {
        channel: named,
        variant,
        archive,
        decoders,
        repair,
        audio,
        audioLanguage,
        preview,
        measurement,
      },
      frame,
    ) => {
      const token = analytics.admitPlayback("live", preview ? undefined : measurement, frame);
      return observeOpen(
        coordination,
        () => analytics.playbackFailureObserver(token ?? undefined),
        (turn) =>
          Effect.gen(function* () {
            const channel = yield* library.channel(named);
            const variants = yield* streamsOf(settings, channel, variant, archive);
            return yield* playback.open(ownedId(channel), decoders, {
              variants,
              archive: archive ?? null,
              repair: repair ?? false,
              audio: audio ?? null,
              audioLanguage: audioLanguage ?? null,
              preview: preview ?? false,
              turn,
            });
          }),
        Effect.gen(function* () {
          // A page's preview never takes the provider's connection from a receiver. Refused
          // here while one is the output, also one that is gone with nothing open; the playback
          // service looks again when the open takes its turn, for one that began meanwhile.
          if (preview && (yield* output.remote)) {
            return yield* new Failed({
              error: { kind: "unexpected", detail: t("A receiver has playback.") },
            });
          }
        }),
      );
    },
    "playback.openTitle": ({ title, decoders, measurement }, frame) => {
      const token = analytics.admitPlayback("vod", measurement, frame);
      return observeOpen(
        coordination,
        () => analytics.playbackFailureObserver(token ?? undefined),
        (turn) =>
          Effect.gen(function* () {
            // What plays goes first, whichever subscription it is of, so no provider sees a
            // connection beside the one about to open.
            yield* playback.closeAll;
            const { url, revision, headers, listingKey } = yield* onDemand.file(title);
            return yield* playback.openTitle(title, url, decoders, {
              turn,
              revision,
              headers,
              listingKey,
            });
          }),
      );
    },
    "playback.openCopy": ({ copy, decoders, measurement }, frame) => {
      const token = analytics.admitPlayback("vod", measurement, frame);
      return observeOpen(
        coordination,
        () => analytics.playbackFailureObserver(token ?? undefined),
        (turn) =>
          Effect.gen(function* () {
            return yield* playback.openCopy(yield* downloads.copy(copy), decoders, turn);
          }),
      );
    },
    "playback.close": ({ sessionId }) => Effect.as(playback.close(sessionId), null),
    "playback.closeAll": () =>
      Effect.andThen(coordination.begin, Effect.as(playback.closeAll, null)),
    "playback.diagnostic": ({ sessionId }) => playback.diagnostic(sessionId),
    "playback.failure": ({ sessionId, selector }) => playback.failure(sessionId, selector),
    "playback.tracks": ({ sessionId }) => playback.tracks(sessionId),
    "playback.playing": ({ sessionId }) => playback.playing(sessionId),
  };
}
