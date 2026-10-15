import * as Effect from "effect/Effect";
import { diagnosed, Diagnostics } from "@mrstreamer/core/diagnostics";
import { type ProofCase } from "../cases.ts";

export const cases: readonly ProofCase[] = [
  {
    name: "core: Effect program with diagnostics",
    compare: "same",
    run: async () => {
      const recorded: string[] = [];
      const program = Effect.succeed(41).pipe(
        Effect.map((value) => value + 1),
        diagnosed("catalogue"),
        Effect.provideService(Diagnostics, {
          record: (entry) =>
            recorded.push(`${entry.op}:${"outcome" in entry ? entry.outcome : ""}`),
        }),
      );
      const failure = await Effect.runPromiseExit(Effect.fail("boom" as const));
      return { value: await Effect.runPromise(program), recorded, failed: failure._tag };
    },
  },
];
