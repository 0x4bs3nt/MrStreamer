import type { AnalyticsFailure } from "@mrstreamer/contracts/analytics";
import type { Failed } from "@mrstreamer/core/failure";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { PlaybackCoordination } from "../services/playback-coordination.ts";
import { appFailure } from "./operations.ts";

/**
 * Admission guards run before a turn or observation. Only a current open's own failure reaches
 * `observe`'s note; success, cancellation and supersession report nothing.
 */
export function observeOpen<A>(
  coordination: Effect.Success<typeof PlaybackCoordination>,
  observe: () => (failure: AnalyticsFailure) => void,
  open: (turn: number) => Effect.Effect<A, Failed>,
  before: Effect.Effect<void, Failed> = Effect.void,
): Effect.Effect<A, Failed> {
  return Effect.gen(function* () {
    yield* before;
    const turn = yield* coordination.begin;
    const failed = observe();
    return yield* Effect.suspend(() => open(turn)).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return;
          if (yield* coordination.passed(turn)) return;
          const error = Cause.findErrorOption(exit.cause);
          failed(error._tag === "Some" ? appFailure(error.value.error) : "app");
        }),
      ),
    );
  });
}
