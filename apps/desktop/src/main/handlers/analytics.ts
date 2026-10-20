import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import type { Analytics } from "../analytics/service.ts";
import type { Playback } from "../services/playback.ts";

export function analyticsHandlers({
  analytics,
  playback,
}: {
  readonly analytics: Pick<
    Analytics,
    | "noteAction"
    | "noteFeature"
    | "admitPlayback"
    | "controlledPlayback"
    | "bindPlayback"
    | "notePlaybackState"
    | "notePlaybackFailure"
    | "setPlaybackEligible"
    | "endControlledPlayback"
  >;
  readonly playback: Pick<Playback["Service"], "measurement">;
}): HandlersFor<"analytics"> {
  return {
    "analytics.action": (action) =>
      Effect.sync(() => {
        analytics.noteAction(action);
        return null;
      }),
    // Registration happens at invocation, never when an optional reply later settles.
    "analytics.playbackBegin": ({ kind, measurement }, frame) =>
      Effect.succeed(analytics.admitPlayback(kind, measurement, frame)),
    "analytics.playbackResume": ({ kind, measurement }, frame) =>
      Effect.succeed(analytics.admitPlayback(kind, measurement, frame)),
    "analytics.playbackBind": ({ kind, measurement, sessionId }, frame) => {
      const token = analytics.admitPlayback(kind, measurement, frame);
      return Effect.gen(function* () {
        const session = yield* playback.measurement(sessionId);
        if (
          !token ||
          !session ||
          session.kind !== kind ||
          session.closed.aborted ||
          analytics.controlledPlayback(measurement.control, frame) !== token
        )
          return null;
        return analytics.bindPlayback(token, "local", session.kind, session.closed);
      });
    },
    "analytics.playbackState": ({ token: control, binding, sequence, state }, frame) => {
      const token = analytics.controlledPlayback(control, frame);
      return Effect.sync(() => {
        if (token) analytics.notePlaybackState(token, binding, sequence, state);
        return null;
      });
    },
    "analytics.playbackFailure": ({ token: control, binding, failure, diagnostic }, frame) => {
      const token = analytics.controlledPlayback(control, frame);
      return Effect.sync(() => {
        if (token) analytics.notePlaybackFailure(token, binding, failure, diagnostic);
        return null;
      });
    },
    "analytics.playbackEligible": ({ token: control, eligible }, frame) => {
      const token = analytics.controlledPlayback(control, frame);
      return Effect.sync(() => {
        if (token) analytics.setPlaybackEligible(token, eligible);
        return null;
      });
    },
    "analytics.playbackEnd": ({ token: control }, frame) => {
      analytics.endControlledPlayback(control, frame);
      return Effect.succeed(null);
    },
    "analytics.feature": (feature) =>
      Effect.sync(() => {
        analytics.noteFeature(feature);
        return null;
      }),
  };
}
