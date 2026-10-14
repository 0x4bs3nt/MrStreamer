// An XMLTV guide at an address the viewer gave for a subscription, apart from its provider's own.
//
// The address can hold a key, so nothing here quotes more of it than its origin: not an error,
// and not a redirect's target, which can carry the key on. The request is the app's own. It
// carries no login and no header of the subscription's provider, which has nothing to do with
// this server.
import { AppFailure } from "@mrstreamer/contracts/errors";
import type { GuideFailure } from "@mrstreamer/contracts/guide";
import type { ProviderOptions } from "@mrstreamer/core/provider";
import { bodySize, describeNetworkError } from "./xtream.ts";

/**
 * The whole guide download: the answer, every redirect before it and the document itself,
 * before it is indexed.
 */
const GUIDE_TIMEOUT_MS = 15 * 60_000;
/** How many redirects a guide's address may take. A guide is one file, a hop or two away. */
const MAX_REDIRECTS = 5;
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

function refused(failure: GuideFailure): AppFailure {
  return new AppFailure({ kind: "guide", failure });
}

/**
 * Requests the documents at guide addresses, each as it downloads, with its size when the server
 * says. It follows redirects itself, `MAX_REDIRECTS` of them at most, and never from https to
 * http: the key in an address typed with https doesn't travel unencrypted. `signal` and the fifteen
 * minutes a guide gets end the request and the download alike.
 */
export function xmltvFetch(options: ProviderOptions) {
  const fetchImpl = options.fetch ?? fetch;
  return async (
    address: string,
    signal: AbortSignal,
  ): Promise<{ body: AsyncIterable<Uint8Array>; size: number | null }> => {
    const within = AbortSignal.any([signal, AbortSignal.timeout(GUIDE_TIMEOUT_MS)]);
    let target = new URL(address);
    for (let redirects = 0; ; redirects++) {
      let response: Response;
      try {
        response = await fetchImpl(target.href, {
          headers: {
            "User-Agent": options.userAgent,
            Accept: "application/xml, text/xml, application/gzip, */*",
          },
          redirect: "manual",
          signal: within,
        });
      } catch (cause) {
        if (signal.aborted) throw cause;
        throw new AppFailure({
          kind: "unreachable",
          server: target.origin,
          detail: describeNetworkError(cause),
        });
      }
      const location = REDIRECTS.has(response.status) ? response.headers.get("location") : null;
      if (location === null) {
        if (response.ok && response.body) {
          return {
            body: arriving(response.body, target.origin, signal),
            size: bodySize(response),
          };
        }
        void response.body?.cancel().catch(() => {});
        throw new AppFailure({ kind: "provider-error", status: response.status });
      }
      void response.body?.cancel().catch(() => {});
      if (redirects === MAX_REDIRECTS) throw refused({ kind: "redirect", reason: "too-many" });
      const next = URL.parse(location, target.href);
      if (!next || (next.protocol !== "https:" && next.protocol !== "http:")) {
        throw refused({ kind: "not-xmltv" });
      }
      if (target.protocol === "https:" && next.protocol === "http:") {
        throw refused({ kind: "redirect", reason: "unencrypted" });
      }
      target = next;
    }
  };
}

/**
 * The document as it arrives. A connection lost on the way, or the time running out, fails as a
 * server that can't be reached, by its origin.
 */
async function* arriving(
  body: ReadableStream<Uint8Array>,
  server: string,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  try {
    yield* body;
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new AppFailure({ kind: "unreachable", server, detail: describeNetworkError(cause) });
  }
}
