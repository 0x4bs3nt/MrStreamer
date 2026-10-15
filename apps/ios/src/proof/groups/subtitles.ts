import { subtitleTextFile } from "@mrstreamer/core/subtitles/text-file";
import { plain, type ProofCase } from "../cases.ts";

const SRT =
  "1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hallo</i> wereld\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nTot ziens\r\n";

export const cases: readonly ProofCase[] = [
  {
    name: "core: SubRip text cues",
    compare: "same",
    run: async () => {
      return plain(subtitleTextFile(SRT));
    },
  },
];
