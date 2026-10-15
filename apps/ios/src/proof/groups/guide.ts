import { xmltvReader } from "@mrstreamer/core/guide/xmltv";
import { plain, type ProofCase } from "../cases.ts";

export const cases: readonly ProofCase[] = [
  {
    name: "core: XMLTV reader",
    compare: "same",
    run: async () => {
      const names: string[] = [];
      const reader = xmltvReader(
        { channel: (c) => names.push(c.id), programme: () => {} },
        1 << 20,
      );
      reader.push(new TextEncoder().encode('<tv><channel id="a.test"></channel></tv>'));
      return { channels: names, ending: plain(reader.end()) };
    },
  },
];
