import { isDeepStrictEqual } from "node:util";
import type { PreferenceSnapshot } from "@mrstreamer/contracts/ipc";
import type { Preferences } from "@mrstreamer/contracts/preferences";
import type { Failed } from "@mrstreamer/core/failure";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";

/** Composes the two committed owners. Writes and worker shutdown never hold the snapshot lock. */
export const preferencePublication = (owners: {
  read: Effect.Effect<Preferences, Failed>;
  write: (patch: Partial<Preferences>) => Effect.Effect<unknown, Failed>;
  consent: (enabled: boolean) => Effect.Effect<unknown, Failed>;
  reconfigure: Effect.Effect<unknown, Failed>;
  publish: (snapshot: PreferenceSnapshot) => void;
  stale: () => void;
}) =>
  Effect.gen(function* () {
    const snapshots = yield* Semaphore.make(1);
    let current: PreferenceSnapshot | undefined;
    const get = snapshots.withPermits(1)(
      Effect.gen(function* () {
        const preferences = yield* owners.read;
        if (!current || !isDeepStrictEqual(current.preferences, preferences)) {
          current = { revision: (current?.revision ?? 0) + 1, preferences };
          owners.publish(current);
        }
        return current;
      }),
    );
    return {
      get,
      update: (patch: Partial<Preferences>) =>
        Effect.gen(function* () {
          const written = yield* Effect.exit(
            Effect.gen(function* () {
              const { analyticsEnabled, ...viewing } = patch;
              if (analyticsEnabled !== undefined) yield* owners.consent(analyticsEnabled);
              if (Object.keys(viewing).length > 0) yield* owners.write(viewing);
              if ("tmdbKey" in patch) yield* owners.reconfigure;
            }),
          );
          // A store can commit before a later write/reconfigure defects. Read back reality even
          // then, and preserve the original cause rather than replacing it with a read failure.
          const composed = yield* Effect.exit(get);
          if (Exit.isFailure(composed)) owners.stale();
          if (Exit.isFailure(written)) return yield* Effect.failCause(written.cause);
          if (Exit.isFailure(composed)) return yield* Effect.failCause(composed.cause);
          return composed.value;
        }),
    };
  });
