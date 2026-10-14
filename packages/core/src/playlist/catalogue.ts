// A playlist's entries as a live catalogue, with where each channel streams from. Mapped entries
// have bounded, address-stripped names, guide ids and groups; the catalogue module reads quality and
// annotations such as "(720p)" or "[Geo-blocked]" from the names, as it does for every provider.
import type { StreamFormat } from "@mrstreamer/contracts/playback";
import type {
  LiveCatalogue,
  OnDemandCatalogue,
  ProviderDetails,
  ProviderCategory,
  ProviderChannel,
} from "../provider.ts";
import type {
  PlaylistImportStatus,
  PlaylistOmission,
  PlaylistSample,
} from "@mrstreamer/contracts/playlist";
import { playlistCatchup, type PlaylistCatchup } from "./catchup.ts";
import type { PlaylistEntry } from "./m3u.ts";

/** Where a channel streams from. The address can hold a login, so it stays in the main process. */
export interface PlaylistStream {
  readonly url: string;
  readonly format: StreamFormat;
  /** The User-Agent and Referer the playlist asks for. */
  readonly headers: Readonly<Record<string, string>>;
  /** Where its recordings play from, when its entry describes catch-up (see ./catchup.ts). */
  readonly catchup?: PlaylistCatchup;
}

export interface PlaylistCatalogue extends LiveCatalogue {
  /** By channel id. */
  readonly streams: ReadonlyMap<string, PlaylistStream>;
}

/**
 * The channels of a playlist, in its order, each in the categories its group-title names: several
 * separated by ";", as iptv-org writes "Animation;Kids". A channel's id is its tvg-id, else its
 * name, so favourites and history survive a reordered or refreshed playlist; a second entry with
 * the same id adds its name, and a third a number. Entries no player here plays, DASH and
 * addresses other than http and https, are left out.
 */
export function playlistCatalogue(entries: Iterable<PlaylistEntry>): PlaylistCatalogue {
  const categories = new Map<string, ProviderCategory>();
  const channels: ProviderChannel[] = [];
  const streams = new Map<string, PlaylistStream>();
  for (const entry of entries) {
    const format = streamFormat(entry.url);
    if (!format) continue;
    const guideId = entry.attributes["tvg-id"] || null;
    const name = entry.name || entry.attributes["tvg-name"] || `Channel ${channels.length + 1}`;
    const id = unusedId(streams, guideId ?? name, name);
    const groups = (entry.attributes["group-title"] || entry.group || "")
      .split(";")
      .map((group) => group.trim())
      .filter(Boolean);
    for (const group of groups) {
      if (!categories.has(group)) categories.set(group, { id: group, name: group });
    }
    const logo = entry.attributes["tvg-logo"];
    const number = Number(entry.attributes["tvg-chno"]);
    const catchup = playlistCatchup(entry);
    channels.push({
      id,
      name,
      number: Number.isInteger(number) && number > 0 ? number : null,
      logoUrl: logo && /^https?:\/\//i.test(logo) ? logo : null,
      categoryIds: [...new Set(groups)],
      guideId,
      catchupDays: catchup?.days ?? null,
    });
    streams.set(id, {
      url: entry.url,
      format,
      headers: {
        ...(entry.userAgent ? { "User-Agent": entry.userAgent } : {}),
        ...(entry.referrer ? { Referer: entry.referrer } : {}),
      },
      ...(catchup ? { catchup } : {}),
    });
  }
  return { categories: [...categories.values()], channels, streams };
}

/**
 * How a stream is delivered, from its address: HLS for .m3u8 playlists, MPEG-TS otherwise, as
 * IPTV servers send it. Null for what neither plays: DASH, and addresses other than http(s).
 */
export function streamFormat(url: string): StreamFormat | null {
  const parsed = URL.parse(url);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return null;
  const path = parsed.pathname.toLowerCase();
  if (path.endsWith(".mpd")) return null;
  return path.endsWith(".m3u8") || path.endsWith(".m3u") || /m3u8/i.test(parsed.search)
    ? "hls"
    : "mpegts";
}

function unusedId(taken: ReadonlyMap<string, unknown>, base: string, name: string): string {
  if (!taken.has(base)) return base;
  const named = `${base}|${name}`;
  if (!taken.has(named)) return named;
  for (let count = 2; ; count++) {
    if (!taken.has(`${named}|${count}`)) return `${named}|${count}`;
  }
}

export interface PlaylistFile extends PlaylistStream {
  readonly container: string;
  readonly kind: "movie" | "episode";
}

export interface ImportedPlaylist {
  readonly live: PlaylistCatalogue;
  readonly catalogue: OnDemandCatalogue;
  readonly files: ReadonlyMap<string, PlaylistFile>;
  readonly details: ReadonlyMap<string, ProviderDetails>;
  readonly groups: ReadonlyMap<string, readonly PlaylistSample[]>;
  readonly omissions: readonly PlaylistOmission[];
  readonly status: PlaylistImportStatus;
}
