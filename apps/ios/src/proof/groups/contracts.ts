import { Preferences } from "@mrstreamer/contracts/preferences";
import { TitleFilters } from "@mrstreamer/contracts/title-filters";
import { plain, type ProofCase } from "../cases.ts";

export const cases: readonly ProofCase[] = [
  {
    name: "contracts: preferences schema",
    compare: "same",
    run: async () => {
      const schema = Preferences();
      return {
        good: plain(schema({ volume: 0.5, muted: true })),
        badRejected: !schema.allows({ volume: "loud", muted: false }),
      };
    },
  },
  {
    name: "contracts: title filters schema",
    compare: "same",
    run: async () => {
      const schema = TitleFilters();
      return {
        good: plain(schema({ quality: "4k", verified: { kind: "audio", language: "nl" } })),
        badRejected: !schema.allows({ quality: "8k" }),
      };
    },
  },
];
