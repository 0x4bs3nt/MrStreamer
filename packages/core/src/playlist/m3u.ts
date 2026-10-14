// Reads M3U playlists: the "#EXTM3U" lists providers and public collections such as iptv-org
// publish instead of an API. Each channel is an #EXTINF line with its attributes and name, the
// options VLC reads (#EXTVLCOPT), then the stream's address:
//
//   #EXTM3U x-tvg-url="https://example.com/guide.xml.gz"
//   #EXTINF:-1 tvg-id="One.uk@HD" tvg-logo="https://…" group-title="News;General",One HD (720p)
//   #EXTVLCOPT:http-user-agent=Mozilla/5.0
//   https://example.com/one/index.m3u8
//
// Playlists come from many tools, so the reader takes what they send: attributes in either quote
// style or none, commas inside quoted values, any line ending, a byte order mark. Lines it doesn't know
// are skipped, and so is an address without an #EXTINF before it.

/** One channel as the playlist lists it. */
export interface PlaylistEntry {
  /** Exactly as the playlist wrote it, after the #EXTINF's comma: "One HD (720p) [Geo-blocked]". */
  readonly name: string;
  readonly url: string;
  /** The #EXTINF's attributes by lowercase name: "tvg-id", "tvg-logo", "group-title". */
  readonly attributes: Readonly<Record<string, string>>;
  /** The active #EXTGRP groups, which some playlists use instead of group-title. */
  readonly group: string | null;
  /** The User-Agent and Referer the stream wants, from its attributes or #EXTVLCOPT lines. */
  readonly userAgent: string | null;
  readonly referrer: string | null;
  /**
   * The #EXTM3U line's attributes by lowercase name, the same for every entry. Some say what an
   * entry that doesn't say otherwise has, as `catchup` does (see ./catchup.ts).
   */
  readonly header: Readonly<Record<string, string>>;
}

export interface M3uReader {
  /** Reads the next piece of the text; returns the entries it completed. */
  push(text: string): PlaylistEntry[];
  /** Reads what is left once the text ended. */
  end(): PlaylistEntry[];
  /**
   * Whether the text so far is a playlist: its first line is #EXTM3U or an #EXTINF. Null until a
   * line arrived.
   */
  readonly playlist: boolean | null;
  /** The guide the header names (x-tvg-url, url-tvg or tvg-url), the first of a list. */
  readonly guideUrl: string | null;
}

/** Reads a playlist piece by piece, so a long one is never held as one string. */
export function m3uReader(): M3uReader {
  let rest = "";
  let playlist: boolean | null = null;
  let guideUrl: string | null = null;
  let header: Readonly<Record<string, string>> = {};
  let group: string | null = null;
  /** The #EXTINF waiting for its address, with what the lines after it added. */
  let pending: {
    name: string;
    attributes: Record<string, string>;
    group: string | null;
    userAgent: string | null;
    referrer: string | null;
  } | null = null;

  function line(text: string, found: PlaylistEntry[]): void {
    // trim() takes a byte order mark too.
    const trimmed = text.trim();
    if (!trimmed) return;
    if (playlist === null) {
      playlist = /^#EXT(M3U|INF)/i.test(trimmed);
      if (/^#EXTM3U/i.test(trimmed)) {
        header = attributesOf(trimmed.slice("#EXTM3U".length));
        const named = header["x-tvg-url"] ?? header["url-tvg"] ?? header["tvg-url"] ?? "";
        guideUrl =
          named
            .split(",")
            .find((each) => /^https?:\/\//i.test(each.trim()))
            ?.trim() ?? null;
        return;
      }
    }
    if (!playlist) return;
    if (trimmed.startsWith("#")) {
      const [, tag = "", value = ""] = /^#([A-Z0-9-]+):?(.*)$/i.exec(trimmed) ?? [];
      switch (tag.toUpperCase()) {
        case "EXTINF": {
          const comma = nameComma(value);
          const attributes = attributesOf(comma === -1 ? value : value.slice(0, comma));
          // An explicit group, including an empty one, ends an inherited #EXTGRP block.
          if (Object.hasOwn(attributes, "group-title")) group = null;
          pending = {
            name: comma === -1 ? "" : value.slice(comma + 1).trim(),
            attributes,
            group,
            userAgent: headerValue(attributes["http-user-agent"]),
            referrer: headerValue(attributes["http-referrer"] ?? attributes["http-referer"]),
          };
          return;
        }
        case "EXTGRP":
          group = value.trim() || null;
          if (pending) pending.group = group;
          return;
        case "EXTVLCOPT": {
          if (!pending) return;
          const [, option = "", setting = ""] = /^([\w-]+)=(.*)$/.exec(value.trim()) ?? [];
          const lower = option.toLowerCase();
          if (lower === "http-user-agent") pending.userAgent = headerValue(setting);
          else if (lower === "http-referrer" || lower === "http-referer") {
            pending.referrer = headerValue(setting);
          }
          return;
        }
        default:
          return;
      }
    }
    if (!pending) return;
    found.push({ ...pending, url: trimmed, header });
    pending = null;
  }

  return {
    push(text) {
      const found: PlaylistEntry[] = [];
      const lines = (rest + text).split(/\r\n|\r|\n/);
      // The last piece may be a line cut short; it waits for the next text.
      rest = lines.pop() ?? "";
      for (const each of lines) line(each, found);
      return found;
    },
    end() {
      const found: PlaylistEntry[] = [];
      line(rest, found);
      rest = "";
      return found;
    },
    get playlist() {
      return playlist;
    },
    get guideUrl() {
      return guideUrl;
    },
  };
}

/** `key="value"`, `key='value'` or `key=value`, by lowercase key. */
function attributesOf(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of text.matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)'|([^\s"',]+))/g)) {
    const [, key = "", double, single, bare] = match;
    attributes[key.toLowerCase()] = (double ?? single ?? bare ?? "").trim();
  }
  return attributes;
}

/** Where the name starts: the first comma outside a quoted value, or -1. */
function nameComma(text: string): number {
  let quote: string | null = null;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      // An apostrophe inside a word ("Kid's") is no quote.
      if (char === '"' || text[at - 1] === "=") quote = char;
    } else if (char === ",") {
      return at;
    }
  }
  return -1;
}

/** A value that can go in an HTTP header, or null. */
function headerValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  // oxlint-disable-next-line no-control-regex
  return trimmed && !/[\u0000-\u001f\u007f\u0100-\uffff]/.test(trimmed) ? trimmed : null;
}
