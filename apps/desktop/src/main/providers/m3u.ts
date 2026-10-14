// M3U playlists with optional explicit group mapping for live and on-demand entries;
// the guide is the XMLTV document the playlist's first line names, when it names one, and a
// channel's recordings play from where its entry's catch-up attributes say.
import { AppFailure } from "@mrstreamer/contracts/errors";
import { streamFormat, type PlaylistStream } from "@mrstreamer/core/playlist/catalogue";
import { archiveAddress } from "@mrstreamer/core/playlist/catchup";
import {
  importPlaylist,
  inspectPlaylist,
  type ImportedPlaylist,
} from "@mrstreamer/core/playlist/import";
import type { PlaylistMapping } from "@mrstreamer/contracts/playlist";
import { m3uReader, type PlaylistEntry } from "@mrstreamer/core/playlist/m3u";
import { providerFetch, type Provider, type ProviderOptions } from "@mrstreamer/core/provider";
import { t } from "@mrstreamer/core/i18n";
import { describeNetworkError } from "./xtream.ts";

export interface PlaylistAccount {
  /** The playlist's address as the user gave it. It can hold a token, so it is sealed on disk. */
  readonly link: string;
  readonly mapping?: PlaylistMapping;
}

/** Reading the playlist's first line, to check it is one or for the guide it names. */
const CHECK_TIMEOUT_MS = 15_000;
/** The whole playlist: a few megabytes for iptv-org's 11,000 channels. */
const PLAYLIST_TIMEOUT_MS = 90_000;
/** The whole guide download. */
const GUIDE_TIMEOUT_MS = 5 * 60_000;
/** Mapping is bounded; existing unmapped Live playlists keep their original load limits. */
const MAPPING_BYTES = 64 * 1024 * 1024;

interface PlaylistRead {
  readonly snapshot: ImportedPlaylist;
  /** Mapping reports are built only when Settings asks for them. */
  inspect(): ImportedPlaylist;
}

/** Raw entries are retained only while a bounded mapping inspection can still use them. */
function playlistRead(
  snapshot: ImportedPlaylist,
  entries?: readonly PlaylistEntry[],
  limit?: AppFailure,
): PlaylistRead {
  let pending = entries;
  let inspected = entries ? undefined : snapshot;
  let failure = limit;
  return {
    snapshot,
    inspect() {
      if (failure) throw failure;
      if (inspected) return inspected;
      if (!pending) return snapshot;
      try {
        inspected = inspectPlaylist(pending);
        return inspected;
      } catch (cause) {
        if (cause instanceof AppFailure) failure = cause;
        throw cause;
      } finally {
        pending = undefined;
      }
    },
  };
}

/**
 * Creates a provider for a playlist link. It reads the playlist as it downloads, so a long one is
 * never parsed in one go, and keeps the last successful read for exact stream versions.
 */
export function playlistProvider(account: PlaylistAccount, options: ProviderOptions): Provider {
  const fetchImpl = providerFetch(options.fetch ?? fetch, loginIn(account.link));
  let last: PlaylistRead | null = null;
  let titleAddresses = new Set<string>();
  /** The read in progress, shared by every call that needs one. */
  let reading: { readonly inspecting: boolean; readonly promise: Promise<PlaylistRead> } | null =
    null;

  /** Opens `url` and gives its body, turning network and HTTP failures into typed errors. */
  async function open(
    url: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { "User-Agent": options.userAgent },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new AppFailure({
        kind: "unreachable",
        server: new URL(url).origin,
        detail: describeNetworkError(cause),
      });
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw new AppFailure({ kind: "provider-error", status: response.status });
    }
    return response.body;
  }

  /** A timeout or a connection lost while the playlist arrived, as the error the UI explains. */
  function lost(cause: unknown): AppFailure {
    if (cause instanceof AppFailure) return cause;
    return new AppFailure({
      kind: "unreachable",
      server: new URL(account.link).origin,
      detail: describeNetworkError(cause),
    });
  }

  /** The playlist, read again. Calls while a read runs share it; none of them can stop it. */
  function fresh(inspecting = false): Promise<PlaylistRead> {
    if (reading) {
      // An inspection can stop at its mapping cap. Live then retries under its original policy.
      if (!account.mapping && !inspecting && reading.inspecting)
        return reading.promise.catch((cause: unknown) => {
          if (cause instanceof AppFailure && cause.error.kind === "unexpected") return fresh();
          throw cause;
        });
      return reading.promise;
    }
    const promise = (async () => {
      try {
        const text = (await open(account.link, PLAYLIST_TIMEOUT_MS)).pipeThrough(
          new TextDecoderStream(),
        );
        const reader = m3uReader();
        const entries: PlaylistEntry[] = [];
        let bytes = 0;
        for await (const piece of text) {
          bytes += Buffer.byteLength(piece);
          if ((account.mapping || inspecting) && bytes > MAPPING_BYTES) {
            throw new AppFailure({
              kind: "unexpected",
              detail: t("Playlist exceeds the {size} MiB mapping limit.", { size: 64 }),
            });
          }
          for (const entry of reader.push(piece)) {
            entries.push(entry);
            if ((account.mapping || inspecting) && entries.length > 100_000)
              throw new AppFailure({
                kind: "unexpected",
                detail: t("Playlist exceeds the {count} entry mapping limit.", { count: 100_000 }),
              });
          }
          if (reader.playlist === false) {
            void text.cancel().catch(() => {});
            throw notAPlaylist(account.link);
          }
        }
        for (const entry of reader.end()) entries.push(entry);
        if (!reader.playlist) throw notAPlaylist(account.link);
        const snapshot =
          inspecting && !account.mapping
            ? inspectPlaylist(entries)
            : importPlaylist(entries, account.mapping);
        const limit =
          bytes > MAPPING_BYTES
            ? new AppFailure({
                kind: "unexpected",
                detail: t("Playlist exceeds the {size} MiB mapping limit.", { size: 64 }),
              })
            : entries.length > 100_000
              ? new AppFailure({
                  kind: "unexpected",
                  detail: t("Playlist exceeds the {count} entry mapping limit.", {
                    count: 100_000,
                  }),
                })
              : undefined;
        last = playlistRead(
          snapshot,
          account.mapping || inspecting || limit ? undefined : entries,
          limit,
        );
        titleAddresses = new Set([...snapshot.files.values()].map((file) => file.url));
        return last;
      } catch (cause) {
        throw lost(cause);
      } finally {
        reading = null;
      }
    })();
    reading = { inspecting, promise };
    return promise;
  }

  /**
   * The playlist's first line, read alone and afresh: whether the link answers with a playlist,
   * and the guide it names.
   */
  async function firstLine(
    signal?: AbortSignal,
  ): Promise<{ readonly playlist: boolean; readonly guideUrl: string | null }> {
    const text = (await open(account.link, CHECK_TIMEOUT_MS, signal)).pipeThrough(
      new TextDecoderStream(),
    );
    const reader = m3uReader();
    let characters = 0;
    try {
      for await (const piece of text) {
        // Only complete lines up to the first meaningful header are parsed, even when a fetch
        // supplies the whole playlist in one chunk. Leading blank lines count against the cap.
        for (const line of piece.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
          const part = line[0];
          characters += part.length;
          if (characters > 65_536)
            throw new AppFailure({
              kind: "unexpected",
              detail: t("Playlist header exceeds {count} characters.", { count: 65_536 }),
            });
          reader.push(part);
          if (reader.playlist !== null) break;
        }
        if (reader.playlist !== null) break;
      }
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw lost(cause);
    }
    void text.cancel().catch(() => {});
    if (reader.playlist === null) reader.end();
    return { playlist: reader.playlist === true, guideUrl: reader.guideUrl };
  }

  /** A channel's stream, from the last read or, for one it doesn't have, a fresh one. */
  async function streamOf(channelId: string, signal?: AbortSignal): Promise<PlaylistStream> {
    const known = last?.snapshot.live.streams.get(channelId);
    if (known) return known;
    // Channels loaded from disk after a restart, or added since the last read.
    const stream = (await abortable(fresh(), signal)).snapshot.live.streams.get(channelId);
    if (!stream) throw new AppFailure({ kind: "channel-not-found", channelId });
    return stream;
  }

  return {
    /** Checks that the link answers with a playlist, reading no more than its first line. */
    async authenticate(signal) {
      if (!(await firstLine(signal)).playlist) {
        throw new AppFailure({
          kind: "incomplete-login",
          detail: t(
            "This address isn't a playlist. A server address needs a username and password.",
          ),
        });
      }
      return { state: "active", expiresAt: null, maxConnections: null, activeConnections: null };
    },

    async liveCatalogue(signal) {
      const {
        snapshot: {
          live: { categories, channels },
        },
      } = await abortable(fresh(), signal);
      return { categories, channels };
    },

    liveStream: streamOf,

    async archiveStream(channelId, window, signal) {
      const stream = await streamOf(channelId, signal);
      const recording = stream.catchup && archiveAddress(stream.catchup, window, Date.now());
      if (!recording) throw new AppFailure({ kind: "catch-up", reason: "none" });
      const { url, start } = recording;
      return {
        url,
        start,
        format: streamFormat(url) ?? stream.format,
        headers: stream.headers,
      };
    },

    request(url, init) {
      // Title credentials belong to exact imported files. Live keeps its existing redirect policy.
      return titleAddresses.has(url)
        ? providerFetch(options.fetch ?? fetch, [...loginIn(account.link), ...loginIn(url)])(
            url,
            init,
          )
        : fetchImpl(url, init);
    },

    /**
     * The guide the playlist's first line names now, or that it names none. The line is read
     * again each time: an earlier read says nothing about a guide added, moved or dropped since.
     */
    async liveGuide(signal) {
      const { playlist, guideUrl } = await firstLine(signal);
      if (!playlist) throw notAPlaylist(account.link);
      if (!guideUrl) return { kind: "none" };
      // As it comes: the guide service unpacks one that is gzip, as guides named .xml.gz are.
      return { kind: "document", body: await open(guideUrl, GUIDE_TIMEOUT_MS, signal) };
    },

    async onDemandCatalogue(signal) {
      return (await abortable(fresh(), signal)).snapshot.catalogue;
    },

    async playlistImport(signal, refresh) {
      const read = refresh
        ? await abortable(fresh(), signal)
        : (last ?? (await abortable(fresh(true), signal)));
      signal?.throwIfAborted();
      return refresh ? read.snapshot : read.inspect();
    },

    async movieDetails(id, signal) {
      const imported = (last ?? (await abortable(fresh(), signal))).snapshot;
      const details = imported.details.get(id);
      if (!details || !imported.catalogue.movies.some((each) => each.id === id)) {
        throw new AppFailure({ kind: "title-not-found", titleId: id });
      }
      return details;
    },

    async seriesDetails(id, signal) {
      const imported = (last ?? (await abortable(fresh(), signal))).snapshot;
      const details = imported.details.get(id);
      if (!details || !imported.catalogue.series.some((each) => each.id === id))
        throw new AppFailure({ kind: "title-not-found", titleId: id });
      return details;
    },

    async titleFile(kind, id, _container, signal) {
      const imported = (last ?? (await abortable(fresh(), signal))).snapshot;
      const file = imported.files.get(id);
      if (!file || kind !== file.kind)
        throw new AppFailure({ kind: "title-not-found", titleId: id });
      return file;
    },
  };
}

/**
 * What in a playlist link can be a login: the user and password before the host and every query
 * value, such as a token. Redirects never carry them from https to http.
 */
function loginIn(link: string): string[] {
  const url = new URL(link);
  return [decoded(url.username), decoded(url.password), ...url.searchParams.values()].filter(
    Boolean,
  );
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function notAPlaylist(link: string): AppFailure {
  return new AppFailure({
    kind: "unreachable",
    server: new URL(link).origin,
    detail: t("The address answered, but not with a playlist."),
  });
}

/** Waits for `promise` until `signal` aborts. */
function abortable<A>(promise: Promise<A>, signal: AbortSignal | undefined): Promise<A> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
