import { wallClock } from "@mrstreamer/core/catchup";
import { plain, type ProofCase } from "../cases.ts";

export const cases: readonly ProofCase[] = [
  {
    name: "core: catch-up wall clock in provider time zones",
    compare: "same",
    run: async () => {
      const at = Date.UTC(2026, 2, 29, 0, 30);
      return plain({
        amsterdam: wallClock(at, "Europe/Amsterdam"),
        newYork: wallClock(at, "America/New_York"),
        utc: wallClock(at, null),
      });
    },
  },
];
