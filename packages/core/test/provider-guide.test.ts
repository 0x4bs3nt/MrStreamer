import { describe, expect, it } from "vitest";
import { nextProviderRedirect, providerFetch } from "../src/provider.ts";
import { xtreamProvider } from "../src/xtream.ts";

const login = ["fixture user", "p/w"];
const original = "https://panel.test/xmltv.php?username=fixture+user&password=p%2Fw";
const decide = (location: string, followed = 0, current = original) =>
  nextProviderRedirect({ original, current, location, followed, login });

describe("provider guide transport", () => {
  it("builds the descriptor without HTTP and reuses its exact endpoint and headers for the body API", async () => {
    const requests: { url: string; headers: Headers; redirect: RequestInit["redirect"] }[] = [];
    const provider = xtreamProvider(
      { server: "https://panel.test", username: login[0]!, password: login[1]! },
      {
        userAgent: "fixture",
        fetch: async (input, init) => {
          requests.push({
            url: String(input),
            headers: new Headers(init?.headers),
            redirect: init?.redirect,
          });
          return new Response("<tv/>", { headers: { "Content-Length": "5" } });
        },
      },
    );
    const descriptor = await provider.liveGuideRequest?.();
    expect(requests).toEqual([]);
    expect(descriptor?.kind).toBe("request");
    const body = await provider.liveGuide();
    if (descriptor?.kind !== "request" || body.kind !== "document")
      throw new Error("missing document");
    expect(requests[0]?.url).toBe(descriptor.url);
    expect(Object.fromEntries(requests[0]!.headers)).toEqual(
      Object.fromEntries(new Headers(descriptor.headers)),
    );
    expect(requests[0]?.redirect).toBe("manual");
    expect(await new Response(body.body).text()).toBe("<tv/>");
  });
  it.each([
    "http://other.test/live/p%2Fw/1",
    "http://fixture%20user@other.test/file",
    "http://other.test/?user=fixture+user",
    "http://other.test/?password=p%2Fw",
  ])("refuses original HTTPS login exposure at %s", (url) => {
    expect(() => decide(url)).toThrow("unencrypted");
    expect(() => decide(url, 1, "http://token.test/file?token=safe")).toThrow("unencrypted");
  });
  it("preserves token-only HTTP redirects and relative hops, with the same 20-hop ceiling", () => {
    expect(decide("../guide")).toBe("https://panel.test/guide");
    expect(decide("http://token.test/?token=fixture-user")).toBe(
      "http://token.test/?token=fixture-user",
    );
    expect(() => decide("/again", 19)).not.toThrow();
    expect(() => decide("/again", 20)).toThrow("too many");
    expect(() => decide("file:///tmp/no")).toThrow();
  });
  it("closes every redirect body before following, retaining the original headers", async () => {
    let closed = 0;
    const seen: string[] = [];
    const request = providerFetch(async (input, init) => {
      seen.push(String(input));
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("User-Agent")).toBe("fixture");
      return seen.length === 1
        ? new Response(
            new ReadableStream({
              cancel() {
                closed++;
              },
            }),
            { status: 302, headers: { Location: "/next" } },
          )
        : new Response("ok");
    }, login);
    expect(await (await request(original, { headers: { "User-Agent": "fixture" } })).text()).toBe(
      "ok",
    );
    expect(closed).toBe(1);
    expect(seen).toEqual([original, "https://panel.test/next"]);
  });
  it.each([401, 403])("keeps desktop HTTP %i login classification", async (status) => {
    const provider = xtreamProvider(
      { server: "https://panel.test", username: "user", password: "pw" },
      { userAgent: "fixture", fetch: async () => new Response(null, { status }) },
    );
    await expect(provider.liveGuide()).rejects.toMatchObject({ error: { kind: "invalid-login" } });
  });
});

it.each(["http://[private-canary", "file:///fixture-user/private-canary"])(
  "providerFetch reports an accurate safe refusal for %s",
  async (location) => {
    const request = providerFetch(
      async () => new Response(null, { status: 302, headers: { Location: location } }),
      login,
    );
    const failure = await request(original).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(TypeError);
    if (!(failure instanceof Error)) throw new Error("missing safe failure");
    expect(failure.message).not.toMatch(/too many/);
    expect(failure.message).toMatch(/valid URL|http or https/);
    expect(failure.message).not.toContain("private-canary");
    expect(failure.message).not.toContain(location);
  },
);
