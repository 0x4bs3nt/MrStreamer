// Catch-up as playlists describe it, in the conventions of Kodi's IPTV Simple Client, which most
// providers and players follow:
//
//   #EXTM3U catchup="shift" catchup-days="7"
//   #EXTINF:-1 catchup="append" catchup-days="3" catchup-source="?utc={utc}&lutc={lutc}",One HD
//   https://example.com/one/index.m3u8
//
// What is read:
// - The mode, from `catchup`, or as `catch-up` or `catchup-type` spell it, the entry's or else the
//   #EXTM3U line's:
//   - `default`: `catchup-source` is the recording's whole http(s) address.
//   - `append`: `catchup-source` goes after the stream's address.
//   - `shift`, or `timeshift`: `utc={utc}&lutc={lutc}` goes after it as a query (SIPTV's way).
//   - `flussonic`, or `fs`: Flussonic's archive addresses beside the stream's. `…/name/mpegts`
//     gives `…/name/timeshift_abs-{utc}.ts`, which plays on from that moment with no end, as
//     Kodi asks for it (playback stops it at the window's end), and `…/name/index.m3u8` (or
//     another playlist name) gives `…/name/index-{utc}-{duration}.m3u8`, with the stream's query.
//   - `xc`: an Xtream Codes stream address, `…/[live/]user/pass/id[.ext]`, gives
//     `…/timeshift/user/pass/{duration:60}/{Y}-{m}-{d}:{H}-{M}/id.ext`, `.ts` without one.
// - The days, from `catchup-days`, else `tvg-rec` or `timeshift`, whole days above zero; the
//   entry's, or else the #EXTM3U line's.
// - The placeholders, in a source and in what a mode makes of the stream's address. Times are Unix
//   seconds: `{utc}` and `${start}` the start, `{utcend}` and `${end}` the end, `{lutc}`, `${now}`
//   and `${timestamp}` the moment asked. `{duration}` and `${duration}` the length in seconds,
//   `{duration:N}` that divided by N; `{offset}`, `{offset:N}` and `${offset}` how long ago the
//   start was, the same way. `{Y}`, `{m}`, `{d}`, `{H}`, `{M}` and `{S}` the start's year, month,
//   day, hour, minute and second, in UTC.
// - The start, which an address has to name completely: by `{utc}` or `${start}`, to the second,
//   or by its date and time, `{Y}`, `{m}`, `{d}`, `{H}` and `{M}`, to the minute, or to the second
//   with `{S}` too. An address named to the minute, as `xc`'s is, starts on the minute before the
//   window's start; the length counts from there, and divisions round up, so the end is never cut
//   short. Offsets and the moment asked can go in an address beside its start. The placeholders
//   are read as the address is written, which is how it is sent: an address with a fragment, a
//   `.` or `..` path segment, a login before its host, a placeholder in its scheme, host or port,
//   whitespace or a backslash, which `new URL` would send otherwise, has no catch-up, whatever
//   its mode made it from; and so has one whose query a provider could read otherwise than it
//   was meant, with a `;`, a second `?` or a key twice, however spelt or encoded, as a `utc` of the stream's
//   own beside the one a mode or source adds.
//
// Not supported, so no catch-up: a mode without days or days without a mode, whose meaning players
// don't agree on; `vod` and modes not named here; a source a mode needs that is missing; a stream
// address a derived mode can't read; an address that doesn't name its start completely, such as
// one that names it only as an offset before the moment it is asked (`{offset}`, `{offset:N}`,
// `${offset}`), which names another start the later it is asked, or by a part of its date alone.
// Ignored: `catchup-correction`, and date formats such as `{(b)YmdHMS}` and `${(b)yyyy-MM-dd}`.
// A playlist doesn't say an `xc` server's time zone, so its times are taken as UTC.
import type { ArchiveWindow } from "@mrstreamer/contracts/playback";
import { wallClock } from "../catchup.ts";
import type { PlaylistEntry } from "./m3u.ts";

/**
 * A stream's catch-up: the days its archive holds, and the address of a recording with the
 * placeholders still in it. It can hold the stream's login, so it stays in the main process.
 */
export interface PlaylistCatchup {
  readonly days: number;
  readonly template: string;
}

/** The entry's catch-up, or null when it has none or none this reads (see above). */
export function playlistCatchup(
  entry: Pick<PlaylistEntry, "attributes" | "header" | "url">,
): PlaylistCatchup | null {
  const read = (...names: string[]) =>
    names.map((name) => entry.attributes[name]).find((value) => value?.trim()) ??
    names.map((name) => entry.header[name]).find((value) => value?.trim());
  const mode = read("catchup", "catch-up", "catchup-type")?.trim().toLowerCase();
  const days = Number(read("catchup-days", "tvg-rec", "timeshift")?.trim());
  if (!mode || !Number.isInteger(days) || days <= 0) return null;
  const source = read("catchup-source")?.trim() ?? null;
  const template = templateOf(mode, entry.url, source);
  // A template whose placeholders can sit elsewhere than its path and query is none, and so is
  // one that doesn't name its start completely there.
  if (!template || !plain(template) || !origin(template)) return null;
  const catchup = { days, template };
  return archiveAddress(catchup, { start: 0, end: 1 }, 1) ? catchup : null;
}

/**
 * The address of the recording in `window`, asked at `now`, with the moment in epoch ms the
 * recording it names starts at: the template with its placeholders filled in. Null when that is
 * no http(s) address.
 */
export function archiveAddress(
  catchup: PlaylistCatchup,
  window: ArchiveWindow,
  now: number,
): { readonly url: string; readonly start: number } | null {
  const asked = Math.floor(now / 1000);
  const second = Math.floor(window.start / 1000);
  const start = origin(catchup.template) === "minute" ? second - (second % 60) : second;
  const end = Math.ceil(window.end / 1000);
  const duration = end - start;
  const clock = wallClock(start * 1000, null);
  const divided = (seconds: number, by: string | undefined) =>
    String(Math.max(0, Math.ceil(seconds / (by ? Math.max(1, Number(by)) : 1))));
  const filled = catchup.template
    .replaceAll(/\$\{(start|end|now|timestamp|duration|offset)\}/g, (_, name: string) =>
      name === "start"
        ? String(start)
        : name === "end"
          ? String(end)
          : name === "duration"
            ? String(duration)
            : name === "offset"
              ? divided(asked - start, undefined)
              : String(asked),
    )
    .replaceAll(/\{(duration|offset)(?::(\d+))?\}/g, (_, name: string, by: string | undefined) =>
      divided(name === "duration" ? duration : asked - start, by),
    )
    .replaceAll(/\{(utc|utcend|lutc|Y|m|d|H|M|S)\}/g, (_, name: string) => {
      switch (name) {
        case "utc":
          return String(start);
        case "utcend":
          return String(end);
        case "lutc":
          return String(asked);
        case "Y":
          return clock.year;
        case "m":
          return clock.month;
        case "d":
          return clock.day;
        case "H":
          return clock.hour;
        case "M":
          return clock.minute;
        default:
          return clock.second;
      }
    });
  const url = URL.parse(filled);
  return url && (url.protocol === "http:" || url.protocol === "https:")
    ? { url: filled, start: start * 1000 }
    : null;
}

/** The placeholders an address can hold, as `{name}`, `{name:N}` or `${name}`. */
const PLACEHOLDER = /\$\{[a-z]+\}|\{[a-zA-Z]+(?::\d+)?\}/g;

/**
 * Whether a template is an address whose every placeholder is sent, in its path or query, as it
 * is written: an absolute http(s) address, once its placeholders are filled in, with no fragment,
 * which is never sent; no `.` or `..` path segment, which takes the segment before it out; no
 * login before its host; nothing but a host and port, without placeholders, in its authority; and
 * no whitespace or backslash, which addresses read otherwise than they are written; and a query
 * without a `;`, which some providers separate keys by, without a second `?`, where a source's
 * query was joined into a value of the stream's own, and without a key twice, decoded, with `+`
 * as a space and in any case, which a provider could read either of.
 */
function plain(template: string): boolean {
  if (/[#\s\\]/.test(template)) return false;
  const parts = /^https?:\/\/([^/?]*)([^?]*)/i.exec(template);
  if (!parts) return false;
  const [, authority = "", path = ""] = parts;
  if (!authority || /[@{}$]/.test(authority)) return false;
  const dot = (segment: string) => /^(\.|%2e){1,2}$/i.test(segment);
  if (path.split("/").some(dot)) return false;
  const query = template.slice(parts[0].length + 1);
  if (/[;?]/.test(query)) return false;
  const keys = [...new URLSearchParams(query).keys()].map((key) => key.toLowerCase());
  if (new Set(keys).size !== keys.length) return false;
  return URL.canParse(template.replaceAll(PLACEHOLDER, "1"));
}

/**
 * How completely a template names the start of its recording: to the second, by `{utc}`,
 * `${start}` or its date and time with `{S}`; to the minute, by its date and time down to `{M}`;
 * or not at all, null, for anything less.
 */
function origin(template: string): "second" | "minute" | null {
  if (/\{utc\}|\$\{start\}/.test(template)) return "second";
  if (!["{Y}", "{m}", "{d}", "{H}", "{M}"].every((part) => template.includes(part))) return null;
  return template.includes("{S}") ? "second" : "minute";
}

/** The recording address with placeholders that `mode` makes for the stream at `url`. */
function templateOf(mode: string, url: string, source: string | null): string | null {
  switch (mode) {
    case "default":
      return source && /^https?:\/\//i.test(source) ? source : null;
    case "append":
      return source ? url + source : null;
    case "shift":
    case "timeshift":
      return `${url}${url.includes("?") ? "&" : "?"}utc={utc}&lutc={lutc}`;
    case "flussonic":
    case "fs":
      return flussonic(url);
    case "xc":
      return xtreamCodes(url);
    default:
      return null;
  }
}

/** Flussonic's archive address beside a stream's: MPEG-TS from a moment on, or an HLS stretch. */
function flussonic(url: string): string | null {
  const match = /^(https?:\/\/[^/?#]+\/.+)\/([^/?#]+?)(\.m3u8)?(\?[^#]*)?$/i.exec(url);
  if (!match) return null;
  const [, base, name = "", playlist, query = ""] = match;
  if (playlist) return `${base}/${name}-{utc}-{duration}.m3u8${query}`;
  return name === "mpegts" ? `${base}/timeshift_abs-{utc}.ts${query}` : null;
}

/** Xtream Codes' timeshift address of a stream's. */
function xtreamCodes(url: string): string | null {
  const match =
    /^(https?:\/\/[^/?#]+(?:\/[^?#]*?)??)\/(?:live\/)?([^/?#]+)\/([^/?#]+)\/(\d+)(\.\w+)?$/i.exec(
      url,
    );
  if (!match) return null;
  const [, base, user, pass, id, extension = ".ts"] = match;
  return `${base}/timeshift/${user}/${pass}/{duration:60}/{Y}-{m}-{d}:{H}-{M}/${id}${extension}`;
}
