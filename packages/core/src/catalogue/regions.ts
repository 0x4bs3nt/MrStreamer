// Region names for the codes and country names IPTV catalogues put in front of their names.
// Two-letter ISO 3166 codes resolve through Intl, so every country works without a table of our
// own. The tables below hold only what Intl does not know: codes resellers share across providers
// (AR for Arabic, EXYU, LAT), three-letter codes, and a few common short country names.
import { normalize } from "../text.ts";

/** Reseller conventions that are not in ISO 3166 or mean something else there. They win over ISO. */
// prettier-ignore
const CONVENTIONS: Readonly<Record<string, string>> = {
  AF: "Africa", AFR: "Africa", AR: "Arabic", ARAB: "Arabic", ASIA: "Asia", CAR: "Caribbean",
  EU: "Europe", EXYU: "Ex-Yugoslavia", INT: "World", KU: "Kurdish", KURD: "Kurdish",
  LAT: "Latin America", LATAM: "Latin America", MULTI: "World", WO: "World", WW: "World",
};

/** Reseller language, continent and world labels do not assert a country. */
export function isBroadRegion(region: string): boolean {
  return Object.values(CONVENTIONS).includes(region);
}

/** Three-letter codes as ISO alpha-2: ISO alpha-3, plus the IOC codes sports catalogues use. */
// prettier-ignore
const THREE_LETTER: Readonly<Record<string, string>> = {
  AFG: "AF", ALB: "AL", ALG: "DZ", ARE: "AE", ARG: "AR", ARM: "AM", AUS: "AU", AUT: "AT",
  AZE: "AZ", BAN: "BD", BEL: "BE", BGD: "BD", BGR: "BG", BIH: "BA", BRA: "BR", BUL: "BG",
  CAN: "CA", CHE: "CH", CHN: "CN", COL: "CO", CRO: "HR", CYP: "CY", CZE: "CZ", DEN: "DK",
  DEU: "DE", DNK: "DK", DZA: "DZ", EGY: "EG", ESP: "ES", EST: "EE", FIN: "FI", FRA: "FR",
  GBR: "GB", GEO: "GE", GER: "DE", GRC: "GR", GRE: "GR", HRV: "HR", HUN: "HU", IND: "IN",
  IRL: "IE", IRN: "IR", IRQ: "IQ", ISL: "IS", ISR: "IL", ITA: "IT", JOR: "JO", JPN: "JP",
  KOR: "KR", KSA: "SA", LBN: "LB", LTU: "LT", LVA: "LV", MAR: "MA", MEX: "MX", MKD: "MK",
  MNE: "ME", NED: "NL", NLD: "NL", NOR: "NO", NZL: "NZ", PAK: "PK", POL: "PL", POR: "PT",
  PRT: "PT", ROU: "RO", RSA: "ZA", RUS: "RU", SAU: "SA", SLO: "SI", SRB: "RS", SUI: "CH",
  SVK: "SK", SVN: "SI", SWE: "SE", SYR: "SY", TUN: "TN", TUR: "TR", UAE: "AE", UKR: "UA",
  USA: "US", ZAF: "ZA",
};

/** Short names people use that Intl spells out differently ("Bosnia & Herzegovina"). */
// prettier-ignore
const ALIASES: Readonly<Record<string, string>> = {
  Bosnia: "BA", "Czech Republic": "CZ", England: "GB", "Great Britain": "GB", Holland: "NL",
  "Ivory Coast": "CI", Korea: "KR", Macedonia: "MK", Palestine: "PS", Turkey: "TR",
};

/** Languages whose country names catalogues write out: "Belgium", "België", "Belgique". */
const NAME_LANGUAGES = ["en", "nl", "fr", "de", "es", "it", "pt"];

const english = new Intl.DisplayNames(["en"], { type: "region" });

const byCode = new Map<string, string | null>();

/** "BE", "BEL", "GER", "EXYU" and the like as a display name; null for codes nobody knows. */
export function regionForCode(code: string): string | null {
  const upper = code.toUpperCase();
  let region = byCode.get(upper);
  if (region === undefined) {
    region = CONVENTIONS[upper] ?? countryForCode(THREE_LETTER[upper] ?? upper);
    byCode.set(upper, region);
  }
  return region;
}

/** "Belgium", "België" and "BELGIQUE" all give "Belgium"; anything else gives null. */
export function regionForName(name: string): string | null {
  byName ??= regionNames();
  return byName.get(normalize(name)) ?? null;
}

/** A leading flag emoji: "🇧🇪 VRT 1" gives { region: "Belgium", rest: "VRT 1" }. */
export function leadingFlag(text: string): { region: string; rest: string } | null {
  const match = /^\s*([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])\s*/u.exec(text);
  if (!match?.[1] || !match[2]) return null;
  const letter = (symbol: string) =>
    String.fromCharCode((symbol.codePointAt(0) ?? 0) - 0x1f1e6 + 65);
  const code = letter(match[1]) + letter(match[2]);
  // Flags are always ISO, so they skip the reseller conventions (the AR flag is Argentina).
  return { region: countryForCode(code) ?? code, rest: text.slice(match[0].length) };
}

/**
 * ISO 3166 codes reserved for a country that has another: UK is GB, in ".uk" guide ids and "UK |"
 * catalogues. Node's ICU names them through its own aliases; Hermes on iOS has no such alias.
 */
const RESERVED: Readonly<Record<string, string>> = { UK: "GB" };

/** ISO country metadata, including guide suffixes and flags, never uses reseller aliases. */
export function countryForCode(code: string): string | null {
  code = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  const name = english.of(RESERVED[code] ?? code);
  return name && name !== code ? name : null;
}

let byName: Map<string, string> | undefined;

/** Every country name Intl knows in the name languages, plus the conventions and aliases. */
function regionNames(): Map<string, string> {
  const names = new Map<string, string>();
  const codes: string[] = [];
  for (let first = 65; first <= 90; first++) {
    for (let second = 65; second <= 90; second++) {
      const code = String.fromCharCode(first, second);
      if (countryForCode(code)) codes.push(code);
    }
  }
  for (const language of NAME_LANGUAGES) {
    const local = new Intl.DisplayNames([language], { type: "region" });
    for (const code of codes) {
      const display = countryForCode(code);
      const name = local.of(code);
      if (display && name) names.set(normalize(name), display);
    }
  }
  for (const [alias, code] of Object.entries(ALIASES)) {
    const display = countryForCode(code);
    if (display) names.set(normalize(alias), display);
  }
  for (const display of Object.values(CONVENTIONS)) names.set(normalize(display), display);
  return names;
}
