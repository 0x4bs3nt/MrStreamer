// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderPage } from "../scripts/pages.ts";
import { siteAnalyticsConfiguration } from "../scripts/site-analytics.ts";
import { CHOICE, DEADLINE_MS, MAX_EVENTS, startSiteAnalytics } from "../src/analytics.ts";

// Website analytics as a visitor meets them: the real pages' switches, and the requests that
// leave the page. fetch is replaced, so each request's address, options and body are what a
// browser would send.

const root = join(import.meta.dirname, "..");
const home = readFileSync(join(root, "index.html"), "utf8");
const missing = readFileSync(join(root, "404.html"), "utf8");
const CAPTURE = { endpoint: "https://eu.i.posthog.com/i/v0/e/", token: "phc_test" };

/** A request that stays open until it is aborted, as a browser's would. */
const pending = (_url: string, init: RequestInit) =>
  new Promise<Response>((_, reject) =>
    init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
  );
let fetchMock = vi.fn(pending);
let stop = (): void => {};

function open(html: string, address = "/"): void {
  history.replaceState(null, "", address);
  document.documentElement.innerHTML = html
    .replace(/<link rel="stylesheet"[^>]*>/g, "")
    .replace(/<script type="module"[^>]*><\/script>/g, "");
}

function start(html: string, address?: string): void {
  stop();
  open(html, address);
  stop = startSiteAnalytics(CAPTURE);
}

const sent = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    url,
    init,
    body: JSON.parse(String(init.body)) as {
      api_key: string;
      event: string;
      distinct_id: string;
      properties: Record<string, unknown>;
    },
  }));
const events = () => sent().map(({ body }) => [body.event, body.properties]);
/** What a visitor reads in a switch: its text without hidden parts. */
const shown = (selector: string) => {
  const copy = document.querySelector(selector)?.cloneNode(true);
  if (!(copy instanceof Element)) return undefined;
  for (const hidden of copy.querySelectorAll("[hidden]")) hidden.remove();
  return copy.textContent?.replace(/\s+/g, " ").trim();
};
const footer = () => shown('[data-site-analytics="footer"]');
const button = () =>
  document.querySelector<HTMLButtonElement>('[data-site-analytics="footer"] button');
const click = (selector: string) =>
  document
    .querySelector<HTMLElement>(selector)
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
/** What every event carries besides its own properties, for a page at `route`. */
const fixed = (route: string) => ({
  $current_url: `https://mrstreamer.app${route}`,
  $pathname: route,
  $host: "mrstreamer.app",
  $raw_user_agent: navigator.userAgent,
  $cookieless_mode: true,
  source: "website",
  $process_person_profile: false,
  $geoip_disable: true,
});

beforeEach(() => {
  localStorage.clear();
  fetchMock = vi.fn(pending);
  vi.stubGlobal("fetch", fetchMock);
  // Links stay on the page under test.
  document.addEventListener("click", (event) => event.preventDefault(), { capture: true });
});

afterEach(() => {
  stop();
  vi.useRealTimers();
  stop = () => {};
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "globalPrivacyControl");
  Reflect.deleteProperty(navigator, "doNotTrack");
});

describe("website analytics", () => {
  it("count a fresh visitor's page by default as a cookieless pageview of its canonical address", () => {
    start(home, "/?campaign=secret#hero");
    expect(footer()).toBe("Site analytics: on. Turn off What's counted");
    expect(localStorage.length).toBe(0);
    const [view] = sent();
    expect(view?.url).toBe(CAPTURE.endpoint);
    expect(view?.init).toMatchObject({
      method: "POST",
      keepalive: false,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    expect(view?.body).toEqual({
      api_key: "phc_test",
      event: "$pageview",
      distinct_id: "$posthog_cookieless",
      properties: { route: "/", ...fixed("/") },
    });
    expect(String(view?.init.body)).not.toMatch(/secret|hero|campaign/);
    expect(localStorage.length).toBe(0);
  });

  it("count downloads, GitHub links and how long the page was in view, once", () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    start(home);
    click('.hero a[data-installer="dmg"]');
    click('#downloads a[data-installer="exe"]');
    click('#downloads a[href^="https://apps.microsoft.com/"]');
    click('footer a[href="https://github.com/Mr-Streamer-OSS/MrStreamer"]');
    click('footer a[href$="/issues/new/choose"]');
    click('footer a[href="/faq"]');
    now = 46_000;
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    dispatchEvent(new Event("pagehide"));
    Reflect.deleteProperty(document, "visibilityState");
    expect(events()).toEqual([
      ["$pageview", { route: "/", ...fixed("/") }],
      [
        "download_clicked",
        {
          os_hint: "mac",
          kind: "dmg",
          download_type: "stable",
          route: "/",
          location: "hero",
          ...fixed("/"),
        },
      ],
      [
        "download_clicked",
        {
          os_hint: "windows",
          kind: "exe",
          download_type: "stable",
          route: "/",
          location: "page",
          ...fixed("/"),
        },
      ],
      [
        "download_clicked",
        {
          os_hint: "windows",
          kind: "store",
          download_type: "stable",
          route: "/",
          location: "page",
          ...fixed("/"),
        },
      ],
      ["github_link_clicked", { route: "/", link_location: "footer_source", ...fixed("/") }],
      ["github_link_clicked", { route: "/", link_location: "footer_bug", ...fixed("/") }],
      ["$pageleave", { route: "/", visible: "30s_2m", ...fixed("/") }],
    ]);
    // Only what comes as the page closes or follows a link outlives the page.
    expect(sent().map(({ init }) => init.keepalive)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("count links to the guides by guide and place, never their address", () => {
    start(home);
    click('header a[href="/docs"]');
    click('footer a[href="/docs"]');
    start(renderPage("faq/index.html", null, null), "/faq");
    click('main a[href="/docs/subscriptions#mapping-mixed-playlists"]');
    click('main a[href="/download"]');
    expect(events().filter(([event]) => event === "docs_link_clicked")).toEqual([
      [
        "docs_link_clicked",
        { doc_section: "index", route: "/", location: "header", ...fixed("/") },
      ],
      [
        "docs_link_clicked",
        { doc_section: "index", route: "/", location: "footer", ...fixed("/") },
      ],
      [
        "docs_link_clicked",
        { doc_section: "subscriptions", route: "/faq", location: "page", ...fixed("/faq") },
      ],
    ]);
    expect(sent().every(({ init }) => !String(init.body).includes("mapping"))).toBe(true);
  });

  it("send at most a fixed number of requests from one page", () => {
    start(home);
    for (let attempt = 0; attempt < MAX_EVENTS + 10; attempt++)
      click('footer a[href="https://github.com/Mr-Streamer-OSS/MrStreamer"]');
    expect(fetchMock).toHaveBeenCalledTimes(MAX_EVENTS);
    start(home);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_EVENTS + 1);
  });

  it("give up on a request at its deadline and leave no timer behind", async () => {
    vi.useFakeTimers();
    start(home);
    const signal = sent()[0]?.init.signal;
    vi.advanceTimersByTime(DEADLINE_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    fetchMock.mockImplementation(() => Promise.resolve(new Response(null)));
    click('footer a[href="https://github.com/Mr-Streamer-OSS/MrStreamer"]');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clear every open request and deadline when turned off", () => {
    vi.useFakeTimers();
    start(home);
    click('footer a[href="https://github.com/Mr-Streamer-OSS/MrStreamer"]');
    click('header a[href="/docs"]');
    expect(vi.getTimerCount()).toBe(3);
    button()?.click();
    expect(sent().every(({ init }) => init.signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(DEADLINE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["Global Privacy Control", "globalPrivacyControl", true],
    ["Do Not Track", "doNotTrack", "1"],
  ])(
    "stay off with no switch when the browser sends %s, even after a stored on",
    (_, name, value) => {
      Object.defineProperty(navigator, name, { value, configurable: true });
      vi.stubGlobal("localStorage", {
        getItem: () => "on",
        setItem: vi.fn(),
        removeItem: vi.fn(),
      });
      start(home);
      expect(footer()).toBe(
        "Site analytics: off, because your browser asks sites not to track. What's counted",
      );
      expect(button()?.hidden).toBe(true);
      dispatchEvent(new Event("pagehide"));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(localStorage.setItem).not.toHaveBeenCalled();
    },
  );

  it("send nothing after a stored off, and turning on waits for the next page", () => {
    localStorage.setItem(CHOICE, "off");
    start(home);
    expect(footer()).toBe("Site analytics: off. Turn on What's counted");
    button()?.click();
    expect(localStorage.getItem(CHOICE)).toBe("on");
    expect(footer()).toBe("Site analytics: on. Turn off What's counted");
    click('.hero a[data-installer="dmg"]');
    dispatchEvent(new Event("pagehide"));
    expect(fetchMock).not.toHaveBeenCalled();
    start(home);
    expect(events()).toEqual([["$pageview", { route: "/", ...fixed("/") }]]);
  });

  it("abort what is on its way when turned off, and send nothing after", () => {
    start(home);
    const signal = sent()[0]?.init.signal;
    expect(signal?.aborted).toBe(false);
    button()?.click();
    expect(signal?.aborted).toBe(true);
    expect(localStorage.getItem(CHOICE)).toBe("off");
    expect(footer()).toBe("Site analytics: off. Turn on What's counted");
    click('.hero a[data-installer="dmg"]');
    dispatchEvent(new Event("pagehide"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follow a choice made in another tab", () => {
    start(home);
    localStorage.setItem(CHOICE, "off");
    dispatchEvent(new StorageEvent("storage", { key: CHOICE }));
    expect(sent()[0]?.init.signal?.aborted).toBe(true);
    expect(footer()).toBe("Site analytics: off. Turn on What's counted");
    dispatchEvent(new Event("pagehide"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stay off when local storage fails, before or at the choice", () => {
    const fail = () => {
      throw new Error("Storage unavailable");
    };
    vi.stubGlobal("localStorage", { getItem: fail, setItem: fail, removeItem: fail });
    start(home);
    expect(footer()).toBe("Site analytics: off. What's counted");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", fetchMock);
    start(home);
    const storage = localStorage;
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.getItem(key),
      setItem: () => {
        throw new Error("Full");
      },
      removeItem: (key: string) => storage.removeItem(key),
    });
    button()?.click();
    expect(sent()[0]?.init.signal?.aborted).toBe(true);
    expect(footer()).toBe("Site analytics: off. What's counted");
  });

  it("count an FAQ question opened by its address, and never an unknown fragment", () => {
    const faq = renderPage("faq/index.html", null, null);
    start(faq, "/faq#free");
    start(faq, "/faq#private-words");
    expect(events()).toEqual([
      ["$pageview", { route: "/faq", ...fixed("/faq") }],
      ["faq_question_viewed", { faq_question: "free", via: "anchor", ...fixed("/faq") }],
      ["$pageview", { route: "/faq", ...fixed("/faq") }],
    ]);
    start(missing, "/private/address?q=secret#words");
    expect(events().at(-1)).toEqual(["$pageview", { route: "/404", ...fixed("/404") }]);
    expect(sent().every(({ init }) => !/private|secret|words/.test(String(init.body)))).toBe(true);
  });

  it("show the policy's own switch, and static off text in a build without capture", () => {
    const policy = renderPage("privacy/index.html", null, null);
    open(policy, "/privacy");
    const text = () => shown('[data-site-analytics="policy"]');
    expect(document.querySelector("#website-analytics + [data-site-analytics]")).not.toBeNull();
    expect(text()).toBe("Website analytics are off in this browser.");
    expect(footer()).toBe("Site analytics: off. What's counted");
    stop = startSiteAnalytics(null);
    expect(footer()).toBe("Site analytics: off. What's counted");
    expect(fetchMock).not.toHaveBeenCalled();
    stop();
    stop = startSiteAnalytics(CAPTURE);
    expect(text()).toBe("Website analytics are on in this browser. Turn off");
    document.querySelector<HTMLButtonElement>('[data-site-analytics="policy"] button')?.click();
    expect(footer()).toBe("Site analytics: off. Turn on What's counted");
  });
});

describe("website analytics build configuration", () => {
  const release = {
    MR_STREAMER_SITE_ANALYTICS_RELEASE_BUILD: "1",
    MR_STREAMER_SITE_ANALYTICS_HOST: "https://eu.i.posthog.com",
    MR_STREAMER_SITE_ANALYTICS_PROJECT_TOKEN: "phc_abc_123",
  };

  it("names EU production only for a release build with a public project key", () => {
    expect(siteAnalyticsConfiguration(release, true)).toEqual({
      endpoint: "https://eu.i.posthog.com/i/v0/e/",
      token: "phc_abc_123",
    });
    expect(siteAnalyticsConfiguration(release, false)).toBeNull();
    expect(
      siteAnalyticsConfiguration(
        { ...release, MR_STREAMER_SITE_ANALYTICS_RELEASE_BUILD: "0" },
        true,
      ),
    ).toBeNull();
    expect(
      siteAnalyticsConfiguration(
        { ...release, MR_STREAMER_SITE_ANALYTICS_HOST: "https://us.i.posthog.com" },
        true,
      ),
    ).toBeNull();
    expect(
      siteAnalyticsConfiguration(
        { ...release, MR_STREAMER_SITE_ANALYTICS_PROJECT_TOKEN: "phx_personal" },
        true,
      ),
    ).toBeNull();
    expect(siteAnalyticsConfiguration({}, true)).toBeNull();
  });

  it("lets an explicit loopback endpoint replace production, without its key", () => {
    const local = {
      ...release,
      MR_STREAMER_SITE_ANALYTICS_LOCAL_ENDPOINT: "http://127.0.0.1:4555/i/v0/e/",
    };
    expect(siteAnalyticsConfiguration(local, true)).toEqual({
      endpoint: "http://127.0.0.1:4555/i/v0/e/",
      token: "mrstreamer-local-verification",
    });
    for (const endpoint of [
      "http://example.com:4555/i/v0/e/",
      "http://127.0.0.1/i/v0/e/",
      "https://127.0.0.1:4555/i/v0/e/",
      "http://127.0.0.1:4555/other",
    ])
      expect(
        siteAnalyticsConfiguration(
          { ...local, MR_STREAMER_SITE_ANALYTICS_LOCAL_ENDPOINT: endpoint },
          true,
        ),
      ).toBeNull();
  });
});
