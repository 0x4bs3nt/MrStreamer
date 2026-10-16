// Where a visit entered the site, for website analytics (analytics.ts): three fixed codes, never
// an address. The page reads its own query and document.referrer only to pick codes from the
// lists below. A referrer is reduced to its host, and a host that isn't listed is "other". UTM
// tags count only when utm_source is listed; any other tag, value or parameter is ignored.
//
// The codes last for the tab, in session storage under ENTRY, so a download clicked pages later
// still says where the visit began. A page opened from a tagged link or another site starts a new
// entry; a page opened from this site, or with no referrer, keeps the tab's entry. Without one
// the entry is "unknown": a typed address, a bookmark, the app and a site that hides its address
// all look the same.

/** Session storage key for the tab's entry. Removed whenever analytics are off. */
export const ENTRY = "mrstreamer.site-entry";

/** The medium each source implies when a link's tags don't name one. */
const SOURCES = {
  google: "search",
  bing: "search",
  duckduckgo: "search",
  yahoo: "search",
  yandex: "search",
  ecosia: "search",
  brave: "search",
  startpage: "search",
  qwant: "search",
  kagi: "search",
  baidu: "search",
  github: "referral",
  microsoft_store: "referral",
  ai_assistant: "referral",
  reddit: "social",
  hacker_news: "social",
  x: "social",
  bluesky: "social",
  mastodon: "social",
  youtube: "social",
  app: "app",
  other: "referral",
  unknown: "unknown",
} as const;
type Source = keyof typeof SOURCES;

/** The utm_source values a link may carry: where we post or link the site ourselves. */
const TAGGED_SOURCES = [
  "github",
  "microsoft_store",
  "app",
  "reddit",
  "hacker_news",
  "x",
  "bluesky",
  "mastodon",
  "youtube",
] as const satisfies readonly Source[];

/** The utm_medium values a link may carry. */
const TAGGED_MEDIUMS = [
  "readme",
  "release_notes",
  "docs",
  "store_listing",
  "app",
  "social",
  "referral",
] as const;
type Medium = (typeof SOURCES)[Source] | (typeof TAGGED_MEDIUMS)[number];

/** The utm_campaign values a link may carry. Anything else is "none". */
const CAMPAIGNS = ["none", "release", "launch"] as const;
type Campaign = (typeof CAMPAIGNS)[number];

export interface Entry {
  readonly entry_source: Source;
  readonly entry_medium: Medium;
  readonly entry_campaign: Campaign;
}

/** Hosts a referrer is recognised by, matched on the whole lowercase host. */
const HOSTS: ReadonlyArray<readonly [RegExp, Source]> = [
  [/^(?:www\.)?google\.(?:com|com?\.[a-z]{2}|[a-z]{2})$/, "google"],
  [/^(?:www\.|cn\.)?bing\.com$/, "bing"],
  [/^(?:html\.|lite\.)?duckduckgo\.com$/, "duckduckgo"],
  [/^(?:[a-z]{2}\.)?search\.yahoo\.com$/, "yahoo"],
  [/^(?:www\.)?yandex\.(?:com|ru)$/, "yandex"],
  [/^(?:www\.)?ecosia\.org$/, "ecosia"],
  [/^search\.brave\.com$/, "brave"],
  [/^(?:www\.)?startpage\.com$/, "startpage"],
  [/^(?:www\.)?qwant\.com$/, "qwant"],
  [/^(?:www\.)?kagi\.com$/, "kagi"],
  [/^(?:www\.)?baidu\.com$/, "baidu"],
  [/^(?:gist\.)?github\.com$/, "github"],
  [/^apps\.microsoft\.com$/, "microsoft_store"],
  [
    /^(?:chatgpt\.com|chat\.openai\.com|(?:www\.)?perplexity\.ai|claude\.ai|gemini\.google\.com|copilot\.microsoft\.com)$/,
    "ai_assistant",
  ],
  [/^(?:[a-z]+\.)?reddit\.com$/, "reddit"],
  [/^news\.ycombinator\.com$/, "hacker_news"],
  [/^(?:t\.co|(?:www\.)?x\.com|(?:www\.|mobile\.)?twitter\.com)$/, "x"],
  [/^(?:www\.)?bsky\.app$/, "bluesky"],
  [/^(?:(?:www\.|m\.)?youtube\.com|youtu\.be)$/, "youtube"],
];

const SITE_HOSTS = new Set(["mrstreamer.app", "www.mrstreamer.app"]);

/** `value` if it is one of `codes`, typed as that code. */
const pick = <Code extends string>(codes: readonly Code[], value: string | undefined) =>
  codes.find((code) => code === value);

/** A tag's one value, lowercase. A missing or repeated tag has none. */
function tag(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  return values.length === 1 ? values[0]?.toLowerCase() : undefined;
}

/** The entry a tagged link names, if its utm_source is listed. */
function tagged(search: string): Entry | undefined {
  const params = new URLSearchParams(search);
  const source = pick(TAGGED_SOURCES, tag(params, "utm_source"));
  if (!source) return undefined;
  return {
    entry_source: source,
    entry_medium: pick(TAGGED_MEDIUMS, tag(params, "utm_medium")) ?? SOURCES[source],
    entry_campaign: pick(CAMPAIGNS, tag(params, "utm_campaign")) ?? "none",
  };
}

/** The source a referrer names: "site" for this site, undefined for none. */
function referred(referrer: string, origin: string): Source | "site" | undefined {
  if (!referrer) return undefined;
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return "other";
  }
  if (url.origin === origin || SITE_HOSTS.has(url.hostname)) return "site";
  if (url.protocol !== "https:" && url.protocol !== "http:") return "other";
  const host = url.hostname.replace(/\.$/, "");
  return HOSTS.find(([pattern]) => pattern.test(host))?.[1] ?? "other";
}

const UNKNOWN: Entry = { entry_source: "unknown", entry_medium: "unknown", entry_campaign: "none" };

const MEDIUMS: readonly Medium[] = [...Object.values(SOURCES), ...TAGGED_MEDIUMS];

/** The tab's stored entry, if it holds only listed codes. */
function stored(): Entry | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(ENTRY) ?? "null");
    if (typeof value !== "object" || value === null) return undefined;
    const codes: Partial<Record<keyof Entry, unknown>> = value;
    const entry_source = pick(Object.keys(SOURCES) as Source[], String(codes.entry_source));
    const entry_medium = pick(MEDIUMS, String(codes.entry_medium));
    const entry_campaign = pick(CAMPAIGNS, String(codes.entry_campaign));
    return entry_source && entry_medium && entry_campaign
      ? { entry_source, entry_medium, entry_campaign }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The entry of the page at `search` opened from `referrer`, kept for the tab. Called only on a
 * page that counts. Storage failing leaves this page's own entry, and later pages unknown.
 */
export function enterPage(search: string, referrer: string, origin: string): Entry {
  const source = referred(referrer, origin);
  const entry: Entry =
    tagged(search) ??
    (source && source !== "site"
      ? { entry_source: source, entry_medium: SOURCES[source], entry_campaign: "none" }
      : (stored() ?? UNKNOWN));
  try {
    sessionStorage.setItem(ENTRY, JSON.stringify(entry));
  } catch {
    // Session storage is blocked or full: this page still knows its entry, and an older one
    // mustn't outlive it.
    forgetEntry();
  }
  return entry;
}

/** The tab's entry as stored now, for a page restored from the back-forward cache. */
export function tabEntry(): Entry {
  return stored() ?? UNKNOWN;
}

/** Removes the tab's entry, so turning analytics on again starts from unknown. */
export function forgetEntry(): void {
  try {
    sessionStorage.removeItem(ENTRY);
  } catch {
    // Nothing could be stored either.
  }
}
