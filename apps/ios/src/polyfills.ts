// What the shared rules use that Hermes on iOS lacks or gets wrong, proved by the runtime proof:
// Intl.Locale, PluralRules, ListFormat and DisplayNames are missing (catalogue regions, plurals,
// lists and language names), NumberFormat ignores unit and rounding options (sizes on disk), and
// Array's toSorted and toReversed are missing. Each installs itself only where it is needed.
// Locale data covers the interface languages, and for country names the languages catalogues
// write them in (NAME_LANGUAGES in core's catalogue/regions.ts). Imported before anything else.
import "@formatjs/intl-getcanonicallocales/polyfill.js";
import "@formatjs/intl-locale/polyfill.js";
import "@formatjs/intl-pluralrules/polyfill.js";
import "@formatjs/intl-pluralrules/locale-data/en.js";
import "@formatjs/intl-pluralrules/locale-data/nl.js";
import "@formatjs/intl-pluralrules/locale-data/fr.js";
import "@formatjs/intl-pluralrules/locale-data/de.js";
import "@formatjs/intl-pluralrules/locale-data/es.js";
import "@formatjs/intl-numberformat/polyfill.js";
import "@formatjs/intl-numberformat/locale-data/en.js";
import "@formatjs/intl-numberformat/locale-data/nl.js";
import "@formatjs/intl-numberformat/locale-data/fr.js";
import "@formatjs/intl-numberformat/locale-data/de.js";
import "@formatjs/intl-numberformat/locale-data/es.js";
import "@formatjs/intl-listformat/polyfill.js";
import "@formatjs/intl-listformat/locale-data/en.js";
import "@formatjs/intl-listformat/locale-data/nl.js";
import "@formatjs/intl-listformat/locale-data/fr.js";
import "@formatjs/intl-listformat/locale-data/de.js";
import "@formatjs/intl-listformat/locale-data/es.js";
import "@formatjs/intl-displaynames/polyfill.js";
import "@formatjs/intl-displaynames/locale-data/en.js";
import "@formatjs/intl-displaynames/locale-data/nl.js";
import "@formatjs/intl-displaynames/locale-data/fr.js";
import "@formatjs/intl-displaynames/locale-data/de.js";
import "@formatjs/intl-displaynames/locale-data/es.js";
import "@formatjs/intl-displaynames/locale-data/it.js";
import "@formatjs/intl-displaynames/locale-data/pt.js";
import "core-js/actual/array/to-sorted.js";
import "core-js/actual/array/to-reversed.js";
