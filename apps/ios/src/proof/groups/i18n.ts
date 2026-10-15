import {
  formatBytes,
  formatDate,
  formatLanguageName,
  formatList,
  setLanguage,
  t,
} from "@mrstreamer/core/i18n";
import { type Observed, type ProofCase } from "../cases.ts";

export const cases: readonly ProofCase[] = [
  {
    name: "core: i18n plurals, dates and lists",
    compare: "same",
    run: async () => {
      const key =
        "Queued {count} episodes. {complete} already downloaded, {queued} already queued.";
      const out: Record<string, Observed> = {};
      for (const locale of ["en-US", "nl-NL", "de-DE", "fr-FR", "es-ES"] as const) {
        setLanguage({ locale, formats: locale });
        out[locale] = [
          t(key, { count: 1, complete: 0, queued: 4 }),
          t(key, { count: 2, complete: 0, queued: 4 }),
          formatBytes(1_536_000),
          formatDate(Date.UTC(2026, 9, 15, 12), "date"),
          formatList(["A", "B", "C"]),
          formatLanguageName("nl"),
        ];
      }
      setLanguage({ locale: "en-US", formats: "en-US" });
      return out;
    },
  },
];
