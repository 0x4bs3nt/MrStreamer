import { regionForCode, regionForName } from "@mrstreamer/core/catalogue/regions";
import { plain, type ProofCase } from "../cases.ts";

export const cases: readonly ProofCase[] = [
  {
    name: "core: region codes and country names",
    compare: "same",
    run: () =>
      plain({
        codes: ["UK", "GB", "BE", "GER", "EXYU", "AR", "ZZ"].map(regionForCode),
        names: ["Italia", "België", "Deutschland", "Brasil", "Belgique", "Nowhere"].map(
          regionForName,
        ),
      }),
  },
];
