// What scripts/fixture-server.ts's channel lists leave out, for checking Live favourites: a
// channel's quality going from its list, the whole channel going, and coming back. Only streams
// the panel listed when it started can be left out, so every stream's playlist and segments keep
// the media the server made for them; one left out answers 404, as a provider no longer serving it
// does. The panel's one channel in three qualities is stream ids 100000 (Full HD, off air), 100001
// (HD) and 100002 (SD), on the second provider (FIXTURE_SECOND=1) under the same ids.
//
// Its control routes, on the control port beside the others:
//   POST /live-lists?unlist=100000,100001   later channel lists leave out these streams; an empty
//                                           unlist lists every one again; an unknown id is refused
//   GET  /live-lists                        the streams left out, and how many the lists name
import type { FakeProvider } from "../../desktop/test/fake-provider.ts";

/** Controls over which of `provider`'s streams its channel lists name. */
export function liveLists(provider: Pick<FakeProvider, "catalogue" | "serveChannels">) {
  const known = new Set(provider.catalogue.channels.map((each) => String(each.streamId)));
  let unlisted = new Set<string>();
  const state = () => ({
    unlisted: [...unlisted].toSorted(),
    listed: known.size - unlisted.size,
  });

  return {
    /** Whether the lists leave out stream `id`, whose playlist then answers 404. */
    unlisted: (id: string) => unlisted.has(id),
    control(method: string, url: URL): { status: number; body: unknown } | undefined {
      if (url.pathname !== "/live-lists") return undefined;
      if (method === "GET") return { status: 200, body: state() };
      if (method !== "POST") return undefined;
      const asked = url.searchParams.get("unlist");
      if (asked === null) return { status: 400, body: null };
      const ids = asked.split(",").filter(Boolean);
      if (ids.some((id) => !known.has(id))) return { status: 400, body: null };
      unlisted = new Set(ids);
      const left = unlisted;
      provider.serveChannels((all) => all.filter((each) => !left.has(String(each.streamId))));
      return { status: 200, body: state() };
    },
  };
}
