import { episodeLabel, titleName } from "@mrstreamer/core/ondemand/names";
import { plain, type ProofCase } from "../cases.ts";

export const cases: readonly ProofCase[] = [
  {
    name: "core: title and episode names",
    compare: "same",
    run: async () => {
      return plain({
        movie: titleName("NL | Blow 2001 (NL) [4K]"),
        series: titleName("Formats & Failures (2024)", "2024-01-01"),
        episode: episodeLabel(2, 7),
      });
    },
  },
];
