import type { Failed } from "@mrstreamer/core/failure";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { PlaybackCoordination } from "../services/playback-coordination.ts";
import { appFailure, type OperationObserver } from "./operations.ts";

/** Admission guards run before a turn or observation. Superseded opens keep their public error. */
export function observeOpen<A>(
  coordination: Effect.Success<typeof PlaybackCoordination>,
  observe: OperationObserver,
  open: (turn: number) => Effect.Effect<A, Failed>,
  before: Effect.Effect<void, Failed> = Effect.void,
): Effect.Effect<A, Failed> {
  return Effect.gen(function* () {
    yield* before;
    const turn = yield* coordination.begin;
    const finished = observe();
    return yield* Effect.suspend(() => open(turn)).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (Exit.isSuccess(exit)) return finished("success");
          if (Cause.hasInterruptsOnly(exit.cause) || (yield* coordination.passed(turn)))
            return finished("interrupted");
          const failed = Cause.findErrorOption(exit.cause);
          finished("failed", failed._tag === "Some" ? appFailure(failed.value.error) : "app");
        }),
      ),
    );
  });
}
