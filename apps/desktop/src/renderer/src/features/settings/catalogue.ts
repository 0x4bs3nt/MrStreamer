import { updatesInApp, type Distribution } from "@mrstreamer/contracts/updates";
import { t, type PlainKey } from "@mrstreamer/core/i18n";

export const SETTINGS_SECTIONS = [
  { id: "general", label: "General" },
  { id: "playback", label: "Playback" },
  { id: "live", label: "Live TV" },
  { id: "movies", label: "Movies and series" },
  { id: "subtitles", label: "Subtitles" },
  { id: "home", label: "Home" },
  { id: "subscriptions", label: "Subscriptions" },
  { id: "guides", label: "Guides" },
  { id: "updates", label: "Updates" },
  { id: "privacy", label: "Privacy" },
  { id: "about", label: "About" },
] as const satisfies readonly { id: string; label: PlainKey }[];
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

/** Destinations name real controls. Forms remain handwritten beside their existing owners. */
const SETTINGS_CONTROLS = [
  {
    id: "interface-language",
    section: "general",
    label: "Interface language",
    synonyms: "settings.search.interface",
  },
  { id: "audio", section: "playback", label: "Audio in", synonyms: "settings.search.audio" },
  {
    id: "autoplay",
    section: "playback",
    label: "Next episode",
    synonyms: "settings.search.autoplay",
  },
  {
    id: "delay",
    section: "playback",
    label: "Next episode delay",
    synonyms: "settings.search.delay",
  },
  { id: "quality", section: "live", label: "Quality", synonyms: "settings.search.quality" },
  {
    id: "own-quality",
    section: "live",
    label: "Channels with their own quality",
    synonyms: "settings.search.quality",
  },
  { id: "titles", section: "movies", label: "Titles in", synonyms: "settings.search.titles" },
  { id: "adult", section: "movies", label: "For adults", synonyms: "settings.search.adult" },
  { id: "tmdb", section: "movies", label: "TMDB", synonyms: "settings.search.tmdb" },
  {
    id: "subtitle-language",
    section: "subtitles",
    label: "Subtitles",
    synonyms: "settings.search.subtitles",
  },
  { id: "subtitle-size", section: "subtitles", label: "Size", synonyms: "settings.search.look" },
  {
    id: "subtitle-background",
    section: "subtitles",
    label: "Background",
    synonyms: "settings.search.look",
  },
  {
    id: "subtitle-position",
    section: "subtitles",
    label: "Position",
    synonyms: "settings.search.look",
  },
  {
    id: "online-subtitles",
    section: "subtitles",
    label: "Online search",
    synonyms: "settings.search.online",
  },
  {
    id: "subtitle-services",
    section: "subtitles",
    label: "Search services",
    synonyms: "settings.search.online",
  },
  {
    id: "subtitle-languages",
    section: "subtitles",
    label: "Languages",
    synonyms: "settings.search.online",
  },
  { id: "subdl", section: "subtitles", label: "SubDL", synonyms: "settings.search.online" },
  {
    id: "opensubtitles",
    section: "subtitles",
    label: "OpenSubtitles",
    synonyms: "settings.search.online",
  },
  { id: "home-rows", section: "home", label: "Customize Home", synonyms: "settings.search.home" },
  {
    id: "home-continue",
    section: "home",
    label: "Continue watching",
    synonyms: "settings.search.home",
  },
  {
    id: "home-recommendations",
    section: "home",
    label: "Recommendations",
    synonyms: "settings.search.home",
  },
  { id: "home-watchlist", section: "home", label: "Watchlist", synonyms: "settings.search.home" },
  { id: "home-favourites", section: "home", label: "Favourites", synonyms: "settings.search.home" },
  {
    id: "home-recent",
    section: "home",
    label: "Recently watched",
    synonyms: "settings.search.home",
  },
  { id: "home-new-movies", section: "home", label: "New movies", synonyms: "settings.search.home" },
  { id: "home-new-series", section: "home", label: "New series", synonyms: "settings.search.home" },
  {
    id: "home-category",
    section: "home",
    label: "Current category",
    synonyms: "settings.search.home",
  },
  {
    id: "home-reset",
    section: "home",
    label: "Reset to defaults",
    synonyms: "settings.search.home",
  },
  {
    id: "subscriptions",
    section: "subscriptions",
    label: "Subscriptions",
    synonyms: "settings.search.subscriptions",
  },
  { id: "guides", section: "guides", label: "Guides", synonyms: "settings.search.guides" },
  { id: "update-check", section: "updates", label: "Updates", synonyms: "settings.search.updates" },
  {
    id: "update-channel",
    section: "updates",
    label: "Channel",
    synonyms: "settings.search.updates",
  },
  {
    id: "statistics",
    section: "privacy",
    label: "Share basic usage statistics",
    synonyms: "settings.search.privacy",
  },
  {
    id: "privacy-policy",
    section: "privacy",
    label: "Privacy policy",
    synonyms: "settings.search.privacy",
  },
  { id: "website", section: "about", label: "Website", synonyms: "settings.search.about" },
  { id: "source", section: "about", label: "Source", synonyms: "settings.search.about" },
  {
    id: "licences",
    section: "about",
    label: "Open-source licences",
    synonyms: "settings.search.about",
  },
  { id: "report", section: "about", label: "Report a bug", synonyms: "settings.search.about" },
  { id: "diagnostics", section: "about", label: "Diagnostics", synonyms: "settings.search.about" },
] as const satisfies readonly {
  id: string;
  section: SettingsSection;
  label: PlainKey;
  synonyms: PlainKey;
}[];
export type SettingsControl = (typeof SETTINGS_CONTROLS)[number]["id"];
export const settingSection = (id: SettingsControl): SettingsSection =>
  SETTINGS_CONTROLS.find((control) => control.id === id)!.section;

const normalize = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
/** Every word must match a translated label, section or synonym. Nothing leaves the window. */
export function findSettings(query: string, distribution: Distribution = "direct") {
  const words = normalize(query).trim().split(/\s+/).filter(Boolean);
  return SETTINGS_CONTROLS.filter((control) => {
    if (control.id === "update-channel" && !updatesInApp(distribution)) return false;
    const section = SETTINGS_SECTIONS.find((section) => section.id === control.section)!;
    const synonyms =
      control.id === "update-check" && distribution === "pacman"
        ? t("settings.search.pacman")
        : t(control.synonyms);
    const text = normalize(`${t(control.label)} ${t(section.label)} ${synonyms}`);
    return words.every((word) => text.includes(word));
  });
}
