// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderPage } from "../scripts/pages.ts";
import { INGEST_ROUTE, siteAnalyticsConfiguration } from "../scripts/site-analytics.ts";
import { CHOICE, DEADLINE_MS, MAX_EVENTS, startSiteAnalytics } from "../src/analytics.ts";
import { ENTRY } from "../src/referrals.ts";

// Website analytics as a visitor meets them: the real pages' switches, and the requests that
// leave the page. fetch is replaced, so each request's address, options and body are what a
// browser would send. web-vitals is replaced too: happy-dom measures no vitals, so tests report
// metrics shaped as web-vitals reports them, attribution and all.

type Report = (metric: Record<string, unknown>) => void;
const vitals = vi.hoisted(() => ({
  LCP: [] as Report[],
  CLS: [] as Report[],
  INP: [] as Report[],
}));
vi.mock("web-vitals", () => ({
  onLCP: (report: Report) => vitals.LCP.push(report),
  onCLS: (report: Report) => vitals.CLS.push(report),
  onINP: (report: Report) => vitals.INP.push(report),
}));
/** web-vitals reporting a metric to the page that started last. */
const report = (name: "LCP" | "CLS" | "INP", value: number) =>
  vitals[name].at(-1)?.({
    name,
    value,
    delta: value,
    rating: "poor",
    id: "v5-1760000000000-1234567890123",
    navigationType: "navigate",
    navigationURL: "https://mrstreamer.app/?campaign=secret#hero",
    entries: [{ name: "secret-entry" }],
    attribution: { target: "#hero > a.secret", url: "https://mrstreamer.app/secret.webp" },
  });

const root = join(import.meta.dirname, "..");
const home = readFileSync(join(root, "index.html"), "utf8");
const missing = readFileSync(join(root, "404.html"), "utf8");
/** The download page, where every installer link and the Store sit. */
const download = renderPage("download/index.html", null, null);
/** A production build's capture: the site's own route to PostHog. */
const CAPTURE = {
  endpoint: "https://mrstreamer.app/ingest/i/v0/e/",
  token: "phc_test",
  apiHost: "https://mrstreamer.app/ingest",
};

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

/** Opens a page, from `referrer` as a browser reports it: "" for none. */
function start(html: string, address?: string, referrer = ""): void {
  stop();
  open(html, address);
  Object.defineProperty(document, "referrer", { value: referrer, configurable: true });
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
/** A leave's scroll depth: its deepest scroll and view as shares of the page. */
const depth = (route: string, scroll: number, content: number) => ({
  $prev_pageview_pathname: route,
  $prev_pageview_max_scroll_percentage: scroll,
  $prev_pageview_max_content_percentage: content,
});
/** Hides the page as a browser does when it is switched away from or closed. */
const hide = () => {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
};
/** Where a visit entered when nothing says: a typed address, a bookmark or a hidden referrer. */
const unknown = { entry_source: "unknown", entry_medium: "unknown", entry_campaign: "none" };
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
  $lib_custom_api_host: "https://mrstreamer.app/ingest",
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  for (const reports of Object.values(vitals)) reports.length = 0;
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
  Reflect.deleteProperty(document, "visibilityState");
  Reflect.deleteProperty(document, "referrer");
  for (const name of ["scrollHeight", "clientHeight"])
    Reflect.deleteProperty(document.documentElement, name);
  Reflect.deleteProperty(window, "scrollY");
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
      properties: { route: "/", ...unknown, ...fixed("/") },
    });
    expect(String(view?.init.body)).not.toMatch(/secret|hero|campaign=/);
    expect(localStorage.length).toBe(0);
  });

  it("count downloads, GitHub links and how long the page was in view, once", () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    // The home page's Download links lead to /download and count as nothing but its page view.
    start(home);
    click(".hero .cta");
    click('#downloads a[href="/download"]');
    expect(events()).toEqual([["$pageview", { route: "/", ...unknown, ...fixed("/") }]]);
    start(download, "/download");
    click('.mine a[data-installer="dmg"]');
    click('.rows a[data-installer="exe"]');
    click('.rows a[href^="https://apps.microsoft.com/"]');
    click('footer a[href="https://github.com/Mr-Streamer-OSS/MrStreamer"]');
    click('footer a[href$="/issues/new/choose"]');
    click('footer a[href="/faq"]');
    now = 46_000;
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    dispatchEvent(new Event("pagehide"));
    Reflect.deleteProperty(document, "visibilityState");
    const page = fixed("/download");
    expect(events().slice(1)).toEqual([
      ["$pageview", { route: "/download", ...unknown, ...page }],
      [
        "download_clicked",
        {
          os_hint: "mac",
          kind: "dmg",
          download_type: "stable",
          route: "/download",
          location: "page",
          ...unknown,
          ...page,
        },
      ],
      [
        "download_clicked",
        {
          os_hint: "windows",
          kind: "exe",
          download_type: "stable",
          route: "/download",
          location: "page",
          ...unknown,
          ...page,
        },
      ],
      [
        "download_clicked",
        {
          os_hint: "windows",
          kind: "store",
          download_type: "stable",
          route: "/download",
          location: "page",
          ...unknown,
          ...page,
        },
      ],
      ["github_link_clicked", { route: "/download", link_location: "footer_source", ...page }],
      ["github_link_clicked", { route: "/download", link_location: "footer_bug", ...page }],
      [
        "$pageleave",
        { route: "/download", visible: "30s_2m", ...depth("/download", 1, 1), ...page },
      ],
    ]);
    // Only what comes as the page closes or follows a link outlives the page.
    expect(sent().map(({ init }) => init.keepalive)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("send how far down the page was scrolled as it is left, measured once a frame after a scroll or resize", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    /** A page `height` tall seen through a view `view` tall, scrolled to `top`. */
    const page = (height: number, view: number, top: number) => {
      Object.defineProperty(document.documentElement, "scrollHeight", {
        value: height,
        configurable: true,
      });
      Object.defineProperty(document.documentElement, "clientHeight", {
        value: view,
        configurable: true,
      });
      Object.defineProperty(window, "scrollY", { value: top, configurable: true });
    };
    start(home);
    page(3000, 1000, 0);
    expect(frames).toHaveLength(0);
    page(3000, 1000, 1000);
    for (let wheel = 0; wheel < 5; wheel++) dispatchEvent(new Event("scroll"));
    expect(frames).toHaveLength(1);
    frames.shift()?.(0);
    page(3000, 1000, 400);
    dispatchEvent(new Event("resize"));
    expect(frames).toHaveLength(1);
    frames.shift()?.(0);
    hide();
    expect(events().at(-1)).toEqual([
      "$pageleave",
      { route: "/", visible: "under_10s", ...depth("/", 0.5, 0.67), ...fixed("/") },
    ]);
    // Left once, measured no more.
    dispatchEvent(new Event("scroll"));
    expect(frames).toHaveLength(0);
    // A page shorter than its view counts as read to the foot.
    start(home);
    page(800, 1000, 0);
    hide();
    expect(events().at(-1)?.[1]).toMatchObject(depth("/", 1, 1));
  });

  it("send each Core Web Vital as a number alone, kept alive only as the page hides", () => {
    start(home);
    report("LCP", 1234.56);
    hide();
    report("CLS", 0.123456);
    report("INP", 208);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 15 * 60_000])
      report("LCP", value);
    const measured = sent().filter(({ body }) => body.event === "$web_vitals");
    expect(measured.map(({ body }) => body.properties)).toEqual([
      { $web_vitals_LCP_value: 1235, ...fixed("/") },
      { $web_vitals_CLS_value: 0.123, ...fixed("/") },
      { $web_vitals_INP_value: 208, ...fixed("/") },
    ]);
    expect(measured.map(({ init }) => init.keepalive)).toEqual([false, true, true]);
    expect(
      measured.every(
        ({ init }) => !/secret|attribution|entries|rating|navigat|v5-/.test(String(init.body)),
      ),
    ).toBe(true);
  });

  it("stop measuring when turned off, here or in a restored page that missed the choice", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    start(home);
    button()?.click();
    report("LCP", 900);
    dispatchEvent(new Event("scroll"));
    hide();
    report("CLS", 0.2);
    expect(frames).toHaveLength(0);
    expect(events().map(([event]) => event)).toEqual(["$pageview"]);
    localStorage.clear();
    start(home);
    // Turned off in another tab while this page waited in the back-forward cache.
    localStorage.setItem(CHOICE, "off");
    dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    report("LCP", 120);
    expect(footer()).toBe("Site analytics: off. Turn on What's counted");
    expect(events().map(([event]) => event)).toEqual(["$pageview", "$pageview"]);
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
      expect(vitals.LCP).toHaveLength(0);
      expect(localStorage.setItem).not.toHaveBeenCalled();
    },
  );

  it("send nothing after a stored off, and turning on waits for the next page", () => {
    localStorage.setItem(CHOICE, "off");
    start(download, "/download");
    expect(footer()).toBe("Site analytics: off. Turn on What's counted");
    button()?.click();
    expect(localStorage.getItem(CHOICE)).toBe("on");
    expect(footer()).toBe("Site analytics: on. Turn off What's counted");
    click('.rows a[data-installer="dmg"]');
    dispatchEvent(new Event("pagehide"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vitals.LCP).toHaveLength(0);
    start(home);
    expect(events()).toEqual([["$pageview", { route: "/", ...unknown, ...fixed("/") }]]);
  });

  it("abort what is on its way when turned off, and send nothing after", () => {
    start(download, "/download");
    const signal = sent()[0]?.init.signal;
    expect(signal?.aborted).toBe(false);
    button()?.click();
    expect(signal?.aborted).toBe(true);
    expect(localStorage.getItem(CHOICE)).toBe("off");
    expect(footer()).toBe("Site analytics: off. Turn on What's counted");
    click('.rows a[data-installer="dmg"]');
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
    expect(vitals.LCP).toHaveLength(0);
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
      ["$pageview", { route: "/faq", ...unknown, ...fixed("/faq") }],
      ["faq_question_viewed", { faq_question: "free", via: "anchor", ...fixed("/faq") }],
      ["$pageview", { route: "/faq", ...unknown, ...fixed("/faq") }],
    ]);
    start(missing, "/private/address?q=secret#words");
    expect(events().at(-1)).toEqual(["$pageview", { route: "/404", ...unknown, ...fixed("/404") }]);
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

describe("where a visit entered the site", () => {
  /** The entry codes on each page view and download click, in order. */
  const entries = () =>
    sent()
      .filter(({ body }) => body.event === "$pageview" || body.event === "download_clicked")
      .map(({ body: { event, properties } }) => [
        event,
        properties["entry_source"],
        properties["entry_medium"],
        properties["entry_campaign"],
      ]);
  const bodies = () => sent().map(({ init }) => String(init.body));

  it("take a listed campaign's codes and nothing else from the address", () => {
    start(
      home,
      "/?utm_source=GitHub&utm_medium=readme&utm_campaign=release&utm_content=jane%40example.com&utm_term=iptv&gclid=Cj0secret",
      "https://github.com/Mr-Streamer-OSS/MrStreamer",
    );
    click(".hero .cta");
    start(download, "/download", "https://mrstreamer.app/");
    click('.rows a[data-installer="dmg"]');
    expect(entries()).toEqual([
      ["$pageview", "github", "readme", "release"],
      ["$pageview", "github", "readme", "release"],
      ["download_clicked", "github", "readme", "release"],
    ]);
    expect(sent()[0]?.body.properties).toMatchObject({
      $current_url: "https://mrstreamer.app/",
      $pathname: "/",
    });
    expect(sent()[0]?.body.properties).not.toHaveProperty("$referrer");
    expect(sent()[0]?.body.properties).not.toHaveProperty("utm_source");
    expect(
      bodies().every((body) => !/jane|example|iptv|gclid|secret|utm_|Mr-Streamer/.test(body)),
    ).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(ENTRY) ?? "")).toEqual({
      entry_source: "github",
      entry_medium: "readme",
      entry_campaign: "release",
    });
    expect(sessionStorage.length).toBe(1);
  });

  it.each([
    ["an unlisted source", "?utm_source=jane.doe%40example.com&utm_campaign=release", "google"],
    ["a repeated source", "?utm_source=github&utm_source=reddit", "google"],
    ["an empty source", "?utm_source=&utm_medium=readme", "google"],
    ["a source with spaces", "?utm_source=%20github", "google"],
  ])("ignore every tag with %s and fall back to the referrer", (_, query) => {
    start(home, `/${query}`, "https://www.google.de/");
    expect(entries()).toEqual([["$pageview", "google", "search", "none"]]);
    expect(bodies().join()).not.toMatch(/jane|example|release|readme|reddit|google\.de/);
  });

  it("give a listed source its own medium, and no campaign, when the other tags are unlisted", () => {
    start(home, "/?utm_source=reddit&utm_medium=paid_jane&utm_campaign=spring-sale-jane");
    expect(entries()).toEqual([["$pageview", "reddit", "social", "none"]]);
    expect(bodies().join()).not.toMatch(/jane|spring|paid/);
  });

  it.each([
    ["https://www.google.com/", "google", "search"],
    ["https://www.google.co.uk/", "google", "search"],
    ["https://www.bing.com/", "bing", "search"],
    ["https://duckduckgo.com/", "duckduckgo", "search"],
    ["https://search.brave.com/", "brave", "search"],
    ["https://github.com/Mr-Streamer-OSS/MrStreamer/releases", "github", "referral"],
    ["https://apps.microsoft.com/detail/9N45GG76ZP4T", "microsoft_store", "referral"],
    ["https://chatgpt.com/", "ai_assistant", "referral"],
    ["https://old.reddit.com/r/IPTV/comments/abc/jane/", "reddit", "social"],
    ["https://news.ycombinator.com/item?id=1", "hacker_news", "social"],
    ["https://t.co/xyz", "x", "social"],
    ["https://www.youtube.com/", "youtube", "social"],
    ["https://jane-doe.example.net/my-post?user=jane", "other", "referral"],
    ["https://notgoogle.com/", "other", "referral"],
    ["https://www.google.com.jane.example/", "other", "referral"],
    ["https://mail.google.com/", "other", "referral"],
    ["android-app://com.slack/", "other", "referral"],
    ["not an address", "other", "referral"],
    ["", "unknown", "unknown"],
    ["https://mrstreamer.app/faq", "unknown", "unknown"],
  ])("count a first page from %j as %s", (referrer, source, medium) => {
    start(home, "/", referrer);
    expect(entries()).toEqual([["$pageview", source, medium, "none"]]);
    expect(bodies().join()).not.toMatch(/jane|slack|example|xyz|IPTV|item|releases/);
  });

  it("keep the tab's entry across its pages until a tagged link or another site opens one", () => {
    start(home, "/", "https://www.bing.com/");
    start(download, "/download", "https://mrstreamer.app/");
    click('a[data-installer="deb"]');
    // A typed address or bookmark in the same tab has no referrer, like a page from a site that
    // hides it: neither says the visit began again.
    start(home, "/");
    start(home, "/?utm_source=mastodon&utm_campaign=launch", "https://mastodon.social/");
    start(download, "/download", "https://mrstreamer.app/");
    start(download, "/download", "https://news.ycombinator.com/");
    click('.rows a[data-installer="dmg"]');
    expect(entries()).toEqual([
      ["$pageview", "bing", "search", "none"],
      ["$pageview", "bing", "search", "none"],
      ["download_clicked", "bing", "search", "none"],
      ["$pageview", "bing", "search", "none"],
      ["$pageview", "mastodon", "social", "launch"],
      ["$pageview", "mastodon", "social", "launch"],
      ["$pageview", "hacker_news", "social", "none"],
      ["download_clicked", "hacker_news", "social", "none"],
    ]);
    // A closed tab takes its entry with it.
    sessionStorage.clear();
    start(download, "/download", "https://mrstreamer.app/");
    expect(entries().at(-1)).toEqual(["$pageview", "unknown", "unknown", "none"]);
  });

  it("ignore a stored entry that isn't made of listed codes", () => {
    sessionStorage.setItem(
      ENTRY,
      JSON.stringify({ entry_source: "jane", entry_medium: "email", entry_campaign: "none" }),
    );
    start(download, "/download", "https://mrstreamer.app/");
    sessionStorage.setItem(ENTRY, "not json");
    start(download, "/download", "https://mrstreamer.app/");
    expect(entries()).toEqual([
      ["$pageview", "unknown", "unknown", "none"],
      ["$pageview", "unknown", "unknown", "none"],
    ]);
    expect(bodies().join()).not.toMatch(/jane|email/);
  });

  it("remove the entry when turned off, and start again from unknown when turned on", () => {
    start(home, "/?utm_source=github&utm_medium=readme", "https://github.com/");
    button()?.click();
    expect(sessionStorage.getItem(ENTRY)).toBeNull();
    // Off, a tagged page neither sends nor keeps its codes.
    start(home, "/?utm_source=reddit", "https://www.reddit.com/");
    expect(sessionStorage.getItem(ENTRY)).toBeNull();
    button()?.click();
    start(download, "/download", "https://mrstreamer.app/");
    expect(entries()).toEqual([
      ["$pageview", "github", "readme", "none"],
      ["$pageview", "unknown", "unknown", "none"],
    ]);
  });

  it.each([
    ["Global Privacy Control", "globalPrivacyControl", true],
    ["Do Not Track", "doNotTrack", "1"],
  ])("keep and send no entry with %s, and remove one kept before", (_, name, value) => {
    sessionStorage.setItem(
      ENTRY,
      JSON.stringify({ entry_source: "github", entry_medium: "readme", entry_campaign: "none" }),
    );
    Object.defineProperty(navigator, name, { value, configurable: true });
    start(home, "/?utm_source=github", "https://github.com/");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });

  it("remove the entry when another tab turns analytics off", () => {
    start(home, "/", "https://www.google.com/");
    localStorage.setItem(CHOICE, "off");
    dispatchEvent(new StorageEvent("storage", { key: CHOICE }));
    expect(sessionStorage.getItem(ENTRY)).toBeNull();
  });

  it("stop and remove the entry when another tab's off arrives after it turned on again", () => {
    start(home, "/", "https://github.com/");
    const signal = sent()[0]?.init.signal;
    // The page was frozen while another tab turned off and on, and hears both late.
    localStorage.setItem(CHOICE, "on");
    dispatchEvent(new StorageEvent("storage", { key: CHOICE, oldValue: null, newValue: "off" }));
    dispatchEvent(new StorageEvent("storage", { key: CHOICE, oldValue: "off", newValue: "on" }));
    expect(signal?.aborted).toBe(true);
    expect(sessionStorage.getItem(ENTRY)).toBeNull();
    expect(footer()).toBe("Site analytics: on. Turn off What's counted");
    click('footer a[href="https://github.com/Mr-Streamer-OSS/MrStreamer"]');
    dispatchEvent(new Event("pagehide"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    start(download, "/download", "https://mrstreamer.app/");
    expect(entries().at(-1)).toEqual(["$pageview", "unknown", "unknown", "none"]);
  });

  it("give a page restored from the back-forward cache the tab's entry as it is now", () => {
    start(download, "/download", "https://github.com/");
    // A later page in the tab came from Google, then the visitor went back.
    sessionStorage.setItem(
      ENTRY,
      JSON.stringify({ entry_source: "google", entry_medium: "search", entry_campaign: "none" }),
    );
    dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    click('.rows a[data-installer="dmg"]');
    sessionStorage.clear();
    dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    click('.rows a[data-installer="dmg"]');
    expect(entries()).toEqual([
      ["$pageview", "github", "referral", "none"],
      ["download_clicked", "google", "search", "none"],
      ["download_clicked", "unknown", "unknown", "none"],
    ]);
  });

  it("not keep an older entry when a new one can't be written", () => {
    start(home, "/", "https://github.com/");
    const storage = sessionStorage;
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => storage.getItem(key),
      setItem: () => {
        throw new Error("Full");
      },
      removeItem: (key: string) => storage.removeItem(key),
    });
    start(home, "/", "https://www.google.com/");
    start(download, "/download", "https://mrstreamer.app/");
    expect(entries()).toEqual([
      ["$pageview", "github", "referral", "none"],
      ["$pageview", "google", "search", "none"],
      ["$pageview", "unknown", "unknown", "none"],
    ]);
  });

  it("still count the first page's entry when session storage fails", () => {
    const fail = () => {
      throw new Error("Storage unavailable");
    };
    vi.stubGlobal("sessionStorage", { getItem: fail, setItem: fail, removeItem: fail });
    start(home, "/?utm_source=github", "https://github.com/");
    start(download, "/download", "https://mrstreamer.app/");
    expect(entries()).toEqual([
      ["$pageview", "github", "referral", "none"],
      ["$pageview", "unknown", "unknown", "none"],
    ]);
    button()?.click();
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
      endpoint: "https://mrstreamer.app/ingest/i/v0/e/",
      token: "phc_abc_123",
      apiHost: "https://mrstreamer.app/ingest",
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

  it("sends production only to the site's route, which the package forwards to EU capture alone", () => {
    const endpoint = new URL(siteAnalyticsConfiguration(release, true)?.endpoint ?? "");
    const route = new RegExp(INGEST_ROUTE.src);
    expect(endpoint.origin).toBe("https://mrstreamer.app");
    expect(route.test(endpoint.pathname)).toBe(true);
    expect(INGEST_ROUTE.methods).toEqual(["POST"]);
    expect(INGEST_ROUTE.dest).toBe("https://eu.i.posthog.com/i/v0/e/");
    for (const path of [
      "/ingest/i/v0/e",
      "/ingest/i/v0/e/x",
      "/ingest/flags",
      "/ingest/decide",
      "/ingest/static/array.js",
      "/ingest/s/",
      "/i/v0/e/",
    ])
      expect(route.test(path)).toBe(false);
  });

  it("names no proxy on a loopback check's events", () => {
    const local = siteAnalyticsConfiguration(
      { MR_STREAMER_SITE_ANALYTICS_LOCAL_ENDPOINT: "http://127.0.0.1:4555/i/v0/e/" },
      false,
    );
    open(home);
    stop = startSiteAnalytics(local);
    expect(sent()[0]?.url).toBe("http://127.0.0.1:4555/i/v0/e/");
    expect(sent()[0]?.body.properties).not.toHaveProperty("$lib_custom_api_host");
  });

  it("lets an explicit loopback endpoint replace production, without its key", () => {
    const local = {
      ...release,
      MR_STREAMER_SITE_ANALYTICS_LOCAL_ENDPOINT: "http://127.0.0.1:4555/i/v0/e/",
    };
    expect(siteAnalyticsConfiguration(local, true)).toEqual({
      endpoint: "http://127.0.0.1:4555/i/v0/e/",
      token: "mrstreamer-local-verification",
      apiHost: null,
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
