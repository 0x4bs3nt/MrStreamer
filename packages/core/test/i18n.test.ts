import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCALES } from "@mrstreamer/contracts/language";
import { en } from "../src/i18n/en.ts";
import {
  formatBytes,
  formatDate,
  formatList,
  formatNumber,
  messageParts,
  resolveLanguage,
  setLanguage,
  t,
  translate,
  type MessageKey,
} from "../src/i18n.ts";

// A Dutch catalogue that lost a message, as a hand-edited file could.
vi.mock("../src/i18n/nl.ts", async (original) => {
  const { nl } = await original<typeof import("../src/i18n/nl.ts")>();
  const { Settings: _lost, ...rest } = nl;
  return { nl: rest };
});

afterEach(() => setLanguage({ locale: "en-US", formats: "en-US" }));

it.each([
  ["en-US", "Queued 1 episode.", "Queued 2 episodes."],
  ["de-DE", "1 Folge eingereiht.", "2 Folgen eingereiht."],
  ["es-ES", "1 episodio en cola.", "2 episodios en cola."],
  ["fr-FR", "1 épisode en attente.", "2 épisodes en attente."],
  ["nl-NL", "1 aflevering in wachtrij.", "2 afleveringen in wachtrij."],
] as const)("%s pluralises the number of episodes actually queued", (locale, one, other) => {
  setLanguage({ locale, formats: locale });
  const key = "Queued {count} episodes. {complete} already downloaded, {queued} already queued.";
  expect(t(key, { count: 1, complete: 0, queued: 4 })).toContain(one);
  expect(t(key, { count: 2, complete: 0, queued: 4 })).toContain(other);
});

it.each([
  ["en-US", "1 couldn't be added", "2 couldn't be added"],
  ["de-DE", "1 konnte nicht", "2 konnten nicht"],
  ["es-ES", "No se pudo añadir 1", "No se pudieron añadir 2"],
  ["fr-FR", "1 n’a pas pu être ajouté", "2 n’ont pas pu être ajoutés"],
  ["nl-NL", "1 kon niet", "2 konden niet"],
] as const)("%s pluralises failed additions independently from attempts", (locale, one, other) => {
  setLanguage({ locale, formats: locale });
  const key = "Queued {added} of {attempted}. {count} couldn't be added: {episodes}.";
  expect(t(key, { added: 3, attempted: 5, count: 1, episodes: "S1 E1" })).toContain(one);
  expect(t(key, { added: 3, attempted: 5, count: 2, episodes: "S1 E1, S1 E2" })).toContain(other);
});

it.each([
  ["es-ES", "Descargar 1 nuevo", "Descargar 2 nuevos", "1 fallido", "2 fallidos"],
  ["fr-FR", "Télécharger 1 nouveau", "Télécharger 2 nouveaux", "1 en échec", "2 en échec"],
] as const)(
  "%s agrees with one or several new and failed downloads",
  (locale, one, other, failedOne, failedOther) => {
    setLanguage({ locale, formats: locale });
    expect(t("Download {count} new", { count: 1 })).toBe(one);
    expect(t("Download {count} new", { count: 2 })).toBe(other);
    expect(t("{done} of {total} · {count} failed", { done: 3, total: 5, count: 1 })).toContain(
      failedOne,
    );
    expect(t("{done} of {total} · {count} failed", { done: 3, total: 5, count: 2 })).toContain(
      failedOther,
    );
  },
);

describe("the interface language", () => {
  it("follows the system's first language the app speaks, by its language alone", () => {
    expect(resolveLanguage(undefined, ["ja-JP", "nl-BE", "de-DE"])).toEqual({
      choice: "system",
      system: "nl-NL",
      locale: "nl-NL",
      formats: "nl-BE",
    });
    // Linux names its languages as its environment does.
    expect(resolveLanguage("system", ["de_AT.UTF-8"])).toMatchObject({
      locale: "de-DE",
      formats: "de-AT",
    });
  });

  it("is English when the system speaks nothing the app does", () => {
    expect(resolveLanguage(undefined, ["ja-JP", "C"])).toEqual({
      choice: "system",
      system: "en-US",
      locale: "en-US",
      formats: "en-US",
    });
    expect(resolveLanguage(undefined, [])).toMatchObject({ locale: "en-US" });
  });

  it("keeps what the viewer picked, with dates in the system's own variant of it", () => {
    expect(resolveLanguage("fr-FR", ["en-GB"])).toEqual({
      choice: "fr-FR",
      system: "en-US",
      locale: "fr-FR",
      formats: "fr-FR",
    });
    expect(resolveLanguage("en-US", ["en-GB", "nl-NL"])).toEqual({
      choice: "en-US",
      system: "en-US",
      locale: "en-US",
      formats: "en-GB",
    });
  });

  it("shows English for a language a later release saved", () => {
    expect(resolveLanguage("it-IT", ["nl-NL"])).toEqual({
      choice: "en-US",
      system: "nl-NL",
      locale: "en-US",
      formats: "en-US",
    });
  });
});

/** Values for every placeholder of `key`, and `count` for a message with forms. */
function valuesFor(key: MessageKey, count: number): Record<string, string | number> {
  const names = [...key.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "");
  return Object.fromEntries(names.map((name) => [name, name === "count" ? count : `<${name}>`]));
}

describe("every message in every language", () => {
  const keys = Object.keys(en) as MessageKey[];

  it.each(LOCALES)("%s says each one with all of its values in place", (locale) => {
    setLanguage({ locale, formats: locale });
    for (const key of keys) {
      for (const count of [1, 2, 5, 1_000_000]) {
        const values = valuesFor(key, count);
        // Every key's placeholders are its parameters; a cast stands in for the typed call.
        const said = (translate as (l: string, k: string, v: object) => string)(
          locale,
          key,
          values,
        );
        expect(said.trim(), `${locale} ${key}`).not.toBe("");
        expect(said, `${locale} ${key}`).not.toMatch(/\{\w+\}/);
        // A form for one may say "one" in words; every other names each value.
        if (count === 1) continue;
        for (const [name, value] of Object.entries(values)) {
          const shown = typeof value === "number" ? formatNumber(value) : value;
          expect(said, `${locale} ${key} {${name}}`).toContain(shown);
        }
      }
    }
  });
});

describe("messages", () => {
  it("put values where their placeholders are, numbers as counts in the language", () => {
    expect(t("{known} of {wanted} titles", { known: 1200, wanted: 40000 })).toBe(
      "1,200 of 40,000 titles",
    );
    setLanguage({ locale: "de-DE", formats: "de-DE" });
    expect(t("{known} of {wanted} titles", { known: 1200, wanted: 40000 })).toBe(
      "1.200 von 40.000 Titeln",
    );
  });

  it("in a language other than the process's, write counts as that language does", () => {
    expect(translate("de-DE", "{known} of {wanted} titles", { known: 1200, wanted: 40000 })).toBe(
      "1.200 von 40.000 Titeln",
    );
    // The process's own language keeps its system variant.
    setLanguage({ locale: "de-DE", formats: "de-CH" });
    expect(translate("de-DE", "{count} titles", { count: 1200 })).toBe(
      `${formatNumber(1200)} Titel`,
    );
    expect(translate("en-US", "{count} titles", { count: 1200 })).toBe("1,200 titles");
  });

  it("pick the form a count takes in the language", () => {
    expect(translate("en-US", "{count} titles", { count: 1 })).toBe("1 title");
    expect(translate("en-US", "{count} titles", { count: 0 })).toBe("0 titles");
    // French counts none as one, and a round million as many.
    setLanguage({ locale: "fr-FR", formats: "fr-FR" });
    expect(t("{count} titles", { count: 0 })).toBe("0 titre");
    expect(t("{count} titles", { count: 3 })).toBe("3 titres");
    expect(t("{count} titles", { count: 1_000_000 })).toBe(`${formatNumber(1_000_000)} de titres`);
  });

  it("show English for one a language lacks", () => {
    expect(translate("nl-NL", "Settings")).toBe("Settings");
    expect(translate("nl-NL", "Subscriptions")).toBe("Abonnementen");
  });

  it("split at their placeholders for a caller that puts elements there", () => {
    setLanguage({ locale: "de-DE", formats: "de-DE" });
    expect(messageParts("Where titles stream comes from {justWatch}.")).toEqual([
      "Wo Titel gestreamt werden, stammt von ",
      { placeholder: "justWatch" },
      ".",
    ]);
  });
});

describe("dates, numbers and lists", () => {
  const at = Date.UTC(2026, 9, 2, 19, 5);

  it("are written in the interface language's own way", () => {
    setLanguage({ locale: "de-DE", formats: "de-DE" });
    expect(formatNumber(1234.5)).toBe("1.234,5");
    expect(formatBytes(4_100_000_000)).toMatch(/^4,1\sGB$/);
    expect(formatList(["A", "B", "C"])).toBe("A, B und C");
    expect(formatDate(at, "date")).toMatch(/^2\. Okt\. 2026$/);
    setLanguage({ locale: "en-US", formats: "en-US" });
    expect(formatList(["A", "B", "C"])).toBe("A, B, and C");
  });

  it("follow the system's variant of the language", () => {
    setLanguage({ locale: "en-US", formats: "en-GB" });
    expect(formatList(["A", "B", "C"])).toBe("A, B and C");
    expect(formatDate(at, "date")).toBe("2 Oct 2026");
  });
});
