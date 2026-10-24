// What `providerFetch` sends where once an address is https. Nothing holding the login goes to an
// http address, whether a redirect leads there or a playlist names it, and a header holding it
// stays with the address it came for. Plain http is a real loopback server that notes everything
// reaching it; https addresses are answered here, as a provider and its CDNs answer.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { providerFetch, type ProviderLogin } from "../src/provider.ts";
import { xtreamProvider } from "../src/xtream.ts";

const USER = "synthetic-user";
const SECRET = "synthetic-secret";
/** A short password, and one with a space. */
const PIN = "k9x";
const SPACED = "open sesame";
/**
 * The login, and the values of a playlist link that can be settings as well as a token: the
 * format words a panel's link carries beside the login, and a longer one.
 */
const LOGIN: ProviderLogin = {
  secrets: [USER, SECRET, PIN, SPACED],
  uncertain: ["ts", "m3u8", "hlsarchive"],
};
const REFERER = `https://site.test/watch?token=${SECRET}`;

let server: Server;
let plain = "";
/** Every request the http server got. */
const reached: { path: string; headers: IncomingHttpHeaders }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    reached.push({ path: request.url ?? "", headers: request.headers });
    // An http hop that leads on to the login, as a relay's load balancer could.
    if (request.url === "/hop")
      return response.writeHead(302, { location: `/media/${SECRET}` }).end();
    response.end("plain");
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  plain = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((closed) => server.close(closed));
});
beforeEach(() => {
  reached.length = 0;
});

/**
 * Fetch where each https address in `redirects` leads where it says, any other answers, and http
 * goes to the loopback server. `asked` notes every https request with its headers.
 */
function world(redirects: Readonly<Record<string, string>> = {}) {
  const asked: { url: string; headers: Headers }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.protocol === "http:") return fetch(url, init);
    asked.push({ url: url.href, headers: new Headers(init?.headers) });
    const location = redirects[url.href];
    return location
      ? new Response(null, { status: 302, headers: { location } })
      : new Response("secure");
  };
  return { asked, fetchImpl, request: providerFetch(fetchImpl, LOGIN) };
}

const START = "https://panel.test/live/stream.ts";

describe("redirects from https to http", () => {
  it.each([
    ["the password as a query value", () => `${plain}/media?token=${SECRET}`],
    ["the password as a path segment", () => `${plain}/media/${SECRET}`],
    ["both in one field", () => `${plain}/media?auth=${USER}%3A${SECRET}`],
    ["both in one field, encoded twice", () => `${plain}/media?auth=${USER}%253A${SECRET}`],
    ["the password encoded twice", () => `${plain}/media?auth=synthetic%252Dsecret`],
    ["the password joined to other text", () => `${plain}/media/x${USER}${SECRET}y.ts`],
    ["the password as a query key", () => `${plain}/media?${SECRET}`],
    ["the user name in a path segment", () => `${plain}/${encodeURIComponent(USER)}/live.ts`],
    ["a short password as a whole part", () => `${plain}/media?auth=guest:${PIN}`],
    ["a short password as a path segment", () => `${plain}/media/${PIN}/live.ts`],
    [
      "a password with a space, form encoded",
      () => `${plain}/media?auth=${SPACED.replace(" ", "+")}`,
    ],
    ["a link's value that can be a token, as a whole part", () => `${plain}/media?auth=hlsarchive`],
  ])("refuses one with %s, sending nothing to http", async (_case, target) => {
    const { request } = world({ [START]: target() });
    await expect(request(START)).rejects.toThrow("unencrypted");
    expect(reached).toEqual([]);
  });

  it.each([
    ["a token of its own", () => `${plain}/relay/live.ts?token=7f3a`],
    ["the link's format words inside names", () => `${plain}/relay/index.m3u8?ts=1700000000`],
    ["a longer one of the link's values inside a name", () => `${plain}/relay/hlsarchive_index.ts`],
  ])("follows one with %s", async (_case, target) => {
    const { request } = world({ [START]: target() });
    expect(await (await request(START)).text()).toBe("plain");
    expect(reached).toHaveLength(1);
  });

  it("refuses the login however many hops lead to http, past another https server or an http one", async () => {
    const edge = "https://edge.test/live/stream.ts";
    const viaEdge = world({ [START]: edge, [edge]: `${plain}/media?auth=${USER}%3A${SECRET}` });
    await expect(viaEdge.request(START)).rejects.toThrow("unencrypted");
    expect(viaEdge.asked.map((each) => each.url)).toEqual([START, edge]);
    expect(reached).toEqual([]);

    const viaHttp = world({ [START]: `${plain}/hop` });
    await expect(viaHttp.request(START)).rejects.toThrow("unencrypted");
    // The http hop held nothing of the login; the one it led to is never asked.
    expect(reached.map((each) => each.path)).toEqual(["/hop"]);
  });
});

describe("addresses a playlist names", () => {
  const PLAYLIST = "https://cdn.test/live/index.m3u8";

  it("sends nothing to an http one with the login after an https playlist", async () => {
    const { request } = world();
    await expect(request(`${plain}/segment.ts?token=${SECRET}`, {}, PLAYLIST)).rejects.toThrow(
      "unencrypted",
    );
    await expect(request(`${plain}/key?auth=${USER}%3A${SECRET}`, {}, PLAYLIST)).rejects.toThrow(
      "unencrypted",
    );
    expect(reached).toEqual([]);
  });

  it("refuses an https one that redirects to http with the login", async () => {
    const segment = "https://cdn.test/live/segment.ts";
    const { request } = world({ [segment]: `${plain}/segment.ts?token=${SECRET}` });
    await expect(request(segment, {}, PLAYLIST)).rejects.toThrow("unencrypted");
    expect(reached).toEqual([]);
  });

  it("asks an http one without the login, and every one an http playlist names", async () => {
    const { request } = world();
    expect((await request(`${plain}/segment.ts?relay=7f3a`, {}, PLAYLIST)).ok).toBe(true);
    const http = `${plain}/live/index.m3u8`;
    expect((await request(`${plain}/segment.ts?token=${SECRET}`, {}, http)).ok).toBe(true);
    expect(reached.map((each) => each.path)).toEqual([
      "/segment.ts?relay=7f3a",
      `/segment.ts?token=${SECRET}`,
    ]);
  });
});

describe("the headers a stream asks for", () => {
  const headers = { "User-Agent": "SyntheticPlayer/1.0", Referer: REFERER };

  it("go as they are to the stream's own origin", async () => {
    const moved = "https://panel.test/live/moved.ts";
    const { request, asked } = world({ [START]: moved });
    await request(START, { headers });
    expect(asked.map((each) => each.headers.get("referer"))).toEqual([REFERER, REFERER]);
  });

  it.each(["Referer", "referer", "REFERER"])(
    "cut a %s holding the login to its origin on the way to another https server",
    async (name) => {
      const edge = "https://edge.test/live/stream.ts";
      const { request, asked } = world({ [START]: edge });
      await request(START, { headers: { "User-Agent": "SyntheticPlayer/1.0", [name]: REFERER } });
      expect(asked[1]?.url).toBe(edge);
      expect(asked[1]?.headers.get("referer")).toBe("https://site.test/");
      expect(asked[1]?.headers.get("user-agent")).toBe("SyntheticPlayer/1.0");
    },
  );

  it("leave out another header holding the login, and keep the rest, past the origin", async () => {
    const edge = "https://edge.test/live/stream.ts";
    const { request, asked } = world({ [START]: edge });
    await request(START, { headers: { "X-Session": `id ${SECRET}`, "X-Device": "desktop" } });
    expect(asked[0]?.headers.get("x-session")).toBe(`id ${SECRET}`);
    expect(asked[1]?.headers.has("x-session")).toBe(false);
    expect(asked[1]?.headers.get("x-device")).toBe("desktop");
  });

  it("send nothing of the login to http, and an ordinary Referer as it is", async () => {
    const { request } = world({ [START]: `${plain}/relay/live.ts?token=7f3a` });
    await request(START, { headers });
    await request(START, { headers: { Referer: "https://site.test/watch" } });
    expect(reached.map((each) => each.headers.referer)).toEqual([
      "https://site.test/",
      "https://site.test/watch",
    ]);
    expect(reached[0]?.headers["user-agent"]).toBe("SyntheticPlayer/1.0");
    expect(JSON.stringify(reached)).not.toContain(SECRET);
  });

  it("leave a playlist's segment on another origin with the Referer's origin only", async () => {
    const { request } = world();
    await request(`${plain}/segment.ts`, { headers }, "https://cdn.test/live/index.m3u8");
    expect(reached[0]?.headers.referer).toBe("https://site.test/");
  });
});

describe("an Xtream account's login, however short", () => {
  // Its username and password are the login for certain, as its addresses carry them.
  const ACCOUNT = { server: "https://panel.test", username: "viewer7", password: "q7x" };
  const STREAM = "https://panel.test/live/viewer7/q7x/1.ts";
  const account = (redirects: Readonly<Record<string, string>> = {}) => {
    const { asked, fetchImpl } = world(redirects);
    return {
      asked,
      request: xtreamProvider(ACCOUNT, { userAgent: "fixture", fetch: fetchImpl }).request,
    };
  };
  /** `text` with each character percent-encoded, then encoded `times` more times. */
  const encoded = (text: string, times: number) =>
    Array.from({ length: times }).reduce<string>(
      (each) => encodeURIComponent(each),
      [...text].map((character) => `%${character.charCodeAt(0).toString(16)}`).join(""),
    );

  it.each([
    [
      "the password joined to other text in a query value",
      () => `${plain}/live.ts?auth=x${ACCOUNT.password}y`,
    ],
    [
      "the password joined to other text in a path segment",
      () => `${plain}/x${ACCOUNT.password}y/live.ts`,
    ],
    [
      "the password joined and encoded twice",
      () => `${plain}/live.ts?auth=x${encoded(ACCOUNT.password, 1)}y`,
    ],
    ["the password as a query key", () => `${plain}/live.ts?${ACCOUNT.password}`],
    ["the username joined to other text", () => `${plain}/live/${ACCOUNT.username}0/live.ts`],
    ["text still encoded after four decodings", () => `${plain}/live.ts?auth=${encoded("x", 4)}`],
  ])("refuses a redirect to http with %s, sending nothing there", async (_case, target) => {
    const { request } = account({ [STREAM]: target() });
    await expect(request(STREAM)).rejects.toThrow("unencrypted");
    expect(reached).toEqual([]);
  });

  it("refuses an http address an https playlist names with the password in it, past another hop", async () => {
    const playlist = "https://cdn.test/live/index.m3u8";
    const segment = "https://edge.test/live/segment.ts";
    const { request, asked } = account({
      [segment]: `${plain}/segment.ts?auth=x${ACCOUNT.password}y`,
    });
    await expect(
      request(`${plain}/segment.ts?auth=x${ACCOUNT.password}y`, {}, playlist),
    ).rejects.toThrow("unencrypted");
    await expect(request(segment, {}, playlist)).rejects.toThrow("unencrypted");
    expect(asked.map((each) => each.url)).toEqual([segment]);
    expect(reached).toEqual([]);
  });

  it("leaves a header holding the password at the account's origin, on a redirect and a playlist's child alike", async () => {
    const { request } = account({ [STREAM]: `${plain}/relay/live.ts?token=7f3a` });
    const headers = {
      Referer: `https://site.test/view?auth=x${ACCOUNT.password}y`,
      "X-Session": `x${ACCOUNT.password}y`,
      Range: "bytes=0-3",
    };
    await request(STREAM, { headers });
    await request(`${plain}/segment.ts`, { headers }, "https://panel.test/live/index.m3u8");
    expect(reached).toHaveLength(2);
    for (const each of reached) {
      expect(each.headers).toMatchObject({ referer: "https://site.test/", range: "bytes=0-3" });
      expect(each.headers).not.toHaveProperty("x-session");
    }
    expect(JSON.stringify(reached)).not.toContain(ACCOUNT.password);
  });

  it("follows a redirect to http that holds neither", async () => {
    const { request } = account({ [STREAM]: `${plain}/relay/live.ts?token=7f3a` });
    expect(await (await request(STREAM)).text()).toBe("plain");
    expect(reached.map((each) => each.path)).toEqual(["/relay/live.ts?token=7f3a"]);
  });
});

describe("an Xtream password as each part of an address spells it", () => {
  // A path and a header read "+" as a plus; a query reads it as a space as well, as a form spells
  // one, at each decoding. Bytes that are no UTF-8 read as URLSearchParams reads them, and the
  // characters beside them still count.
  /** An account with `password`, its https addresses all redirecting to `target` on http. */
  const redirecting = (password: string, target: string) =>
    xtreamProvider(
      { server: "https://panel.test", username: "viewer7", password },
      {
        userAgent: "fixture",
        fetch: async (input, init) =>
          new URL(String(input)).protocol === "http:"
            ? fetch(input, init)
            : new Response(null, { status: 302, headers: { location: `${plain}${target}` } }),
      },
    );
  /** Asks for the account's live stream. */
  const ask = async (provider: ReturnType<typeof redirecting>, init?: RequestInit) =>
    provider.request((await provider.liveStream("1")).url, init);
  /** `text` with each character percent-encoded, then encoded `times` more times. */
  const encoded = (text: string, times: number) =>
    Array.from({ length: times }).reduce<string>(
      (each) => encodeURIComponent(each),
      [...text].map((character) => `%${character.charCodeAt(0).toString(16)}`).join(""),
    );
  /** A query value as URLSearchParams reads it, as a server reading a form does. */
  const form = (value: string) => new URLSearchParams(`v=${value}`).get("v") ?? "";
  /** The form value "q+ %78" of `q%2B+%2578`, decoded again as code given it can: "q+ x". */
  const MIXED = decodeURIComponent(form("q%2B+%2578"));

  it.each([
    ["q+x", "a path segment, its plus as written and the rest escaped", "/%71+%78/live.ts"],
    ["q+x", "a query value spelled that way", "/live.ts?auth=%71+%78"],
    ["q+x", "a query name spelled that way", "/live.ts?%71+%78"],
    ["open sesame", "a query value, its space a plus", "/live.ts?auth=open+sesame"],
    ["q7x", "a query value beside an escape that is no UTF-8", "/live.ts?auth=x%FF%71%37%78y"],
    ["q7x", "a query name beside one", "/live.ts?%71%37%78%FF"],
    ["q7x", "a path segment after a character cut short", "/%E2%82%71%37%78/live.ts"],
    ["pässwörd", "a path segment in UTF-8 escapes after a stray byte", "/%FF%70%C3%A4ssw%C3%B6rd/"],
    ["q7x", "a query value after a % that encodes nothing", "/live.ts?auth=%%71%37%78"],
    [MIXED, "a query value read as a form, then decoded again", "/live.ts?auth=q%2B+%2578"],
    [form("a%E2%82b"), "a query value with a character cut short", "/live.ts?auth=a%E2%82b"],
    [form("a%F0%9F%92b"), "a query value with a longer one cut short", "/live.ts?auth=a%F0%9F%92b"],
  ])("refuses a redirect to http with the password %s in %s", async (password, _case, target) => {
    await expect(ask(redirecting(password, target))).rejects.toThrow("unencrypted");
    expect(reached).toEqual([]);
  });

  it.each([
    ["open sesame", "a path's plus, which is no space there", "/open+sesame/live.ts"],
    ["q7x", "an escape that is no UTF-8, and no password", "/caf%E9/live.ts"],
    ["q7x", "a % that encodes nothing", "/100%/live.ts?step=%zz"],
    ["q7x", "a value encoded four times, as deep as it is read", `/live.ts?v=${encoded("ok", 3)}`],
    [MIXED, "that spelling in a path, its plus a plus", "/q%2B+%2578/live.ts"],
    ["q7x", "a query value read both ways that holds no password", "/live.ts?auth=q%2B+%2578"],
  ])("follows a redirect to http for the password %s with %s", async (password, _case, target) => {
    expect(await (await ask(redirecting(password, target))).text()).toBe("plain");
    expect(reached.map((each) => each.path)).toEqual([target]);
  });

  it("refuses a value encoded once more than that, as it can't tell what it holds", async () => {
    const target = `/live.ts?v=${encoded("ok", 4)}`;
    await expect(ask(redirecting("q7x", target))).rejects.toThrow("unencrypted");
    expect(reached).toEqual([]);
  });

  it.each([
    ["q+x", "https://site.test/%71+%78/watch", "https://site.test/"],
    ["q7x", "https://site.test/watch/%71%37%78%FF", "https://site.test/"],
    ["open sesame", "https://site.test/watch?auth=open+sesame", "https://site.test/"],
    ["open sesame", "https://site.test/open+sesame/watch", "https://site.test/open+sesame/watch"],
    [MIXED, "https://site.test/watch?auth=q%2B+%2578", "https://site.test/"],
    [MIXED, "https://site.test/q%2B+%2578/watch", "https://site.test/q%2B+%2578/watch"],
  ])("takes the password %s's Referer %s to http as %s", async (password, referer, sent) => {
    await ask(redirecting(password, "/relay/live.ts?token=7f3a"), {
      headers: { Referer: referer },
    });
    expect(reached.map((each) => each.headers.referer)).toEqual([sent]);
  });

  it("leaves another header behind that spells the password with a plus as written", async () => {
    const headers = { "X-Session": "%71+%78", Range: "bytes=0-3" };
    await ask(redirecting("q+x", "/relay/live.ts?token=7f3a"), { headers });
    expect(reached).toHaveLength(1);
    expect(reached[0]?.headers).not.toHaveProperty("x-session");
    expect(reached[0]?.headers.range).toBe("bytes=0-3");
  });
});
