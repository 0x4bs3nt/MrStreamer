// Website analytics: a few fixed events per page, sent to the app statistics' PostHog project
// without an SDK, in PostHog's cookieless mode, through the site's own /ingest route
// (scripts/site-analytics.ts). docs/privacy.md#website-analytics is the promise this keeps:
// - On unless the browser sends Global Privacy Control or Do Not Track, the visitor turned them
//   off, or local storage fails. Local storage holds only an explicit "on" or "off".
// - The page holds no identifier. Each event carries posthog-js's cookieless flag and placeholder
//   distinct id, and PostHog's ingestion replaces them with a daily-salted hash of the project,
//   IP address, user agent and host, and its own session id. It then deletes the IP address and
//   user agent from the event.
// - The address sent is the page's canonical one on mrstreamer.app, never location, so no query,
//   fragment or referrer. Where the visit entered the site goes only as three fixed codes from
//   referrals.ts, on page views and download clicks, kept in session storage for the tab. The user
//   agent is sent only as the hash input ingestion requires. No typed text or other device or
//   browser detail is sent, and every other value is fixed here or written into the page by the
//   build.
// - Measurements are numbers only: how far down the page was scrolled, as shares of it, and the
//   Core Web Vitals LCP, INP and CLS as web-vitals reports them. Never an element, address or
//   pixel position.
// - At most MAX_EVENTS requests per page, each aborted after DEADLINE_MS. No retry or queue.
// - Turning off sends nothing more, aborts requests still open, stops measuring and removes the
//   tab's entry. A page that opens off removes it too. Turning on sends nothing until the next page
//   opens, whose entry is then unknown unless it came from a tagged link or another site.

import { enterPage, forgetEntry, tabEntry, type Entry } from "./referrals.ts";
import { onCLS, onINP, onLCP, type CLSMetric, type INPMetric, type LCPMetric } from "web-vitals";

/** Where the build points capture: the site's route to PostHog's EU ingestion, or a loopback. */
export interface SiteCapture {
  readonly endpoint: string;
  readonly token: string;
  /** The site's own PostHog address the endpoint sits under, or null for a loopback check. */
  readonly apiHost: string | null;
}

/** Requests one page may make, however long it stays open or however often it is clicked. */
export const MAX_EVENTS = 64;
/** How long one request may stay open before the page gives up on it. */
export const DEADLINE_MS = 10_000;
/** A vital this long or longer is a broken measurement and goes unsent, as posthog-js does. */
const MAX_VITAL = 15 * 60_000;

/** The one stored key. Absent means on. */
export const CHOICE = "mrstreamer.site-analytics";

type Choice = "on" | "off";
/** What the switch shows. "refused": GPC or Do Not Track. "unavailable": local storage failed. */
type Status = Choice | "refused" | "unavailable";

/** The home page's parts, by the ids index.html gives its sections. */
const HOME_SECTIONS = [
  "movies-and-series",
  "sound-and-subtitles",
  "what-you-need",
  "downloads",
] as const;
type HomeSection = (typeof HOME_SECTIONS)[number];

interface Download {
  /** The system the link installs on, not the visitor's. */
  readonly os_hint: "mac" | "windows" | "linux";
  readonly kind: "dmg" | "exe" | "appimage" | "deb" | "store";
}
/** By the `data-installer` names downloads.ts gives the release's files. */
const INSTALLERS: Readonly<Record<string, Download>> = {
  dmg: { os_hint: "mac", kind: "dmg" },
  exe: { os_hint: "windows", kind: "exe" },
  appImage: { os_hint: "linux", kind: "appimage" },
  deb: { os_hint: "linux", kind: "deb" },
};
const STORE: Download = { os_hint: "windows", kind: "store" };

/** The Core Web Vitals sent, by web-vitals' names. */
type Vital = (CLSMetric | INPMetric | LCPMetric)["name"];

type SiteEvent =
  | { readonly event: "$pageview"; readonly properties: Entry & { readonly route: string } }
  | {
      readonly event: "$pageleave";
      readonly properties: {
        readonly route: string;
        readonly visible: "under_10s" | "10_30s" | "30s_2m" | "2_10m" | "over_10m";
        /** The scroll-depth properties PostHog's Web analytics reads, as posthog-js names them. */
        readonly $prev_pageview_pathname: string;
        /** The deepest scroll, from 0 at the top to 1 at the foot. */
        readonly $prev_pageview_max_scroll_percentage: number;
        /** The deepest bottom edge of the view, as a share of the page's height. */
        readonly $prev_pageview_max_content_percentage: number;
      };
    }
  | {
      /** One vital per event: milliseconds for LCP and INP, a unitless score for CLS. */
      readonly event: "$web_vitals";
      readonly properties: Partial<Readonly<Record<`$web_vitals_${Vital}_value`, number>>>;
    }
  | {
      readonly event: "download_clicked";
      readonly properties: Download &
        Entry & {
          /** Every installer link and the Store carry stable releases. Nightlies are on GitHub. */
          readonly download_type: "stable";
          readonly route: string;
          /** Where on the page. Every installer link now sits in /download's body, as "page". */
          readonly location: "hero" | "page";
        };
    }
  | {
      readonly event: "github_link_clicked";
      readonly properties: {
        readonly route: string;
        readonly link_location: "footer_source" | "footer_bug" | "footer_license" | "page";
      };
    }
  | {
      readonly event: "docs_link_clicked";
      readonly properties: {
        /** "index" for /docs, or a guide's slug. */
        readonly doc_section: string;
        readonly route: string;
        readonly location: "header" | "footer" | "page";
      };
    }
  | {
      readonly event: "guide_section_viewed";
      readonly properties: { readonly guide: string; readonly section: string };
    }
  | {
      readonly event: "feature_section_viewed";
      readonly properties: { readonly feature_name: HomeSection };
    }
  | {
      readonly event: "faq_question_viewed";
      readonly properties: { readonly faq_question: string; readonly via: "scroll" | "anchor" };
    }
  | { readonly event: "changelog_viewed"; readonly properties: { readonly version: string } };

const HOST = "mrstreamer.app";
const SITE = `https://${HOST}`;
/**
 * posthog-js's cookieless placeholder distinct id; `$cookieless_mode: true` is its flag
 * (packages/browser/src/constants.ts). Ingestion hashes only events with the flag, and only in a
 * project with cookieless tracking on.
 */
const COOKIELESS_DISTINCT_ID = "$posthog_cookieless";
const REPOSITORY = "https://github.com/Mr-Streamer-OSS/MrStreamer";
/** A link to the guides: /docs or /docs/<slug>, with any fragment left unread. */
const DOCS = /^\/docs(?:\/([a-z0-9-]+))?\/?(?:#.*)?$/;
/** Build-written ids: lowercase words and hyphens, as pages.ts makes them. */
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

const TEXT: Record<"footer" | "policy", Record<Status, string>> = {
  footer: {
    on: "Site analytics: on.",
    off: "Site analytics: off.",
    refused: "Site analytics: off, because your browser asks sites not to track.",
    unavailable: "Site analytics: off.",
  },
  policy: {
    on: "Website analytics are on in this browser.",
    off: "Website analytics are off in this browser.",
    refused: "Website analytics are off, because your browser asks sites not to track.",
    unavailable: "Website analytics are off in this browser.",
  },
};

declare global {
  interface Navigator {
    /** Global Privacy Control, where the browser supports it. */
    readonly globalPrivacyControl?: boolean;
  }
}

/** The page's route from its canonical address, or /404 for a page without one. */
function routeOf(document: Document): string {
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? "";
  const route = canonical.startsWith(`${SITE}/`) ? canonical.slice(SITE.length) : "";
  return /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/.test(route) ? route : "/404";
}

/** The stored choice, with absent meaning on. Any storage failure means off. */
function storedStatus(): Status {
  try {
    const stored = localStorage.getItem(CHOICE);
    // A choice must be savable, or Turn off couldn't last beyond this page.
    localStorage.setItem(`${CHOICE}.probe`, "1");
    localStorage.removeItem(`${CHOICE}.probe`);
    return stored === "off" ? "off" : "on";
  } catch {
    return "unavailable";
  }
}

function visibleBucket(ms: number): "under_10s" | "10_30s" | "30s_2m" | "2_10m" | "over_10m" {
  return ms < 10_000
    ? "under_10s"
    : ms < 30_000
      ? "10_30s"
      : ms < 120_000
        ? "30s_2m"
        : ms < 600_000
          ? "2_10m"
          : "over_10m";
}

/** `part` of `whole` from 0 to 1, in hundredths. A page that can't scroll is wholly seen. */
const share = (part: number, whole: number): number =>
  whole <= 1 ? 1 : Math.round(Math.min(Math.max(part / whole, 0), 1) * 100) / 100;

/**
 * Follows how far down the page is scrolled, as posthog-js measures it: after a scroll or
 * resize, at most once a frame, until `signal` aborts. Nothing runs while the page sits still.
 * The returned read measures once more and gives the deepest scroll and view so far.
 */
function followScrollDepth(signal: AbortSignal): () => { scroll: number; content: number } {
  let deepest = 0;
  let scrollable = 0;
  let viewBottom = 0;
  let height = 0;
  let frame = 0;
  const measure = (): void => {
    frame = 0;
    const { scrollHeight, clientHeight } = document.documentElement;
    const top = Math.max(window.scrollY, 0);
    deepest = Math.max(deepest, Math.ceil(top));
    scrollable = Math.max(scrollable, Math.ceil(scrollHeight - clientHeight));
    viewBottom = Math.max(viewBottom, Math.ceil(top + clientHeight));
    height = Math.max(height, Math.ceil(scrollHeight));
  };
  const queue = (): void => {
    frame ||= requestAnimationFrame(measure);
  };
  const options = { passive: true, signal };
  addEventListener("scroll", queue, options);
  addEventListener("resize", queue, options);
  signal.addEventListener("abort", () => cancelAnimationFrame(frame), { once: true });
  return () => {
    cancelAnimationFrame(frame);
    measure();
    return { scroll: share(deepest, scrollable), content: share(viewBottom, height) };
  };
}

/**
 * Starts the page's switches and, when analytics are on as the page opens, its events. Without a
 * build configuration the switches keep their static "off" text and nothing runs. Returns a stop
 * that aborts requests and removes every listener.
 */
export function startSiteAnalytics(capture: SiteCapture | null): () => void {
  if (!capture) return () => {};
  const route = routeOf(document);
  const refused = navigator.globalPrivacyControl === true || navigator.doNotTrack === "1";
  let status: Status = refused ? "refused" : storedStatus();
  // Only a page that opened with analytics on sends, and only until they are turned off.
  let sending = status === "on";
  /** Web Analytics' address properties, built from the route alone. */
  const address = { $current_url: `${SITE}${route}`, $pathname: route, $host: HOST };
  let budget = MAX_EVENTS;
  /** Each open request's abort and deadline, cleared as it settles. */
  const open = new Set<{
    readonly controller: AbortController;
    readonly deadline: ReturnType<typeof setTimeout>;
  }>();
  const listeners = new AbortController();
  const on = { signal: listeners.signal };
  /** Scroll depth's listeners and frame, stopped as the page is left or analytics turn off. */
  const measuring = new AbortController();
  let observer: IntersectionObserver | undefined;

  const send = ({ event, properties }: SiteEvent): void => {
    if (!sending || budget === 0) return;
    budget--;
    const body = JSON.stringify({
      api_key: capture.token,
      event,
      distinct_id: COOKIELESS_DISTINCT_ID,
      properties: {
        ...properties,
        ...address,
        // Required by ingestion's cookieless hash, which drops an event without it. Ingestion
        // deletes it, with the IP address, before storing the event.
        $raw_user_agent: navigator.userAgent,
        $cookieless_mode: true,
        source: "website",
        $process_person_profile: false,
        $geoip_disable: true,
        // What posthog-js sends behind a proxy, so PostHog's Web analytics sees the site's route.
        ...(capture.apiHost && { $lib_custom_api_host: capture.apiHost }),
      },
    });
    // A string body is text/plain, so the browser sends it without a preflight. Events that come
    // as the page is hidden, closes or follows a link need keepalive to arrive. Chromium doesn't
    // cancel a keepalive request once sent, so every other event goes without it and the signal
    // stops it.
    const keepalive =
      document.visibilityState === "hidden" ||
      event === "$pageleave" ||
      event === "download_clicked" ||
      event === "github_link_clicked" ||
      event === "docs_link_clicked";
    const controller = new AbortController();
    const request = {
      controller,
      deadline: setTimeout(() => controller.abort(), DEADLINE_MS),
    };
    open.add(request);
    void fetch(capture.endpoint, {
      method: "POST",
      body,
      keepalive,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: controller.signal,
    })
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(request.deadline);
        open.delete(request);
      });
  };

  const stopSending = (): void => {
    sending = false;
    for (const { controller, deadline } of open) {
      clearTimeout(deadline);
      controller.abort();
    }
    open.clear();
    observer?.disconnect();
    measuring.abort();
  };
  /** Analytics went off: nothing more is sent and the tab forgets where the visit entered. */
  const turnedOff = (): void => {
    stopSending();
    forgetEntry();
  };

  const controls = [...document.querySelectorAll<HTMLElement>("[data-site-analytics]")].map(
    (control) => {
      const button = document.createElement("button");
      button.type = "button";
      button.addEventListener("click", () => choose(status === "on" ? "off" : "on"), on);
      control.querySelector("[data-site-analytics-status]")?.after(" ", button);
      return {
        control,
        button,
        place: control.dataset["siteAnalytics"] === "policy" ? "policy" : "footer",
      } as const;
    },
  );

  const render = (): void => {
    for (const { control, button, place } of controls) {
      const text = control.querySelector("[data-site-analytics-status]");
      if (text) text.textContent = TEXT[place][status];
      button.hidden = status !== "on" && status !== "off";
      button.textContent = status === "on" ? "Turn off" : "Turn on";
    }
  };

  const choose = (choice: Choice): void => {
    try {
      localStorage.setItem(CHOICE, choice);
      status = choice;
    } catch {
      status = "unavailable";
    }
    if (status !== "on") turnedOff();
    render();
  };

  const reread = (): void => {
    status = storedStatus();
    if (status !== "on") turnedOff();
    render();
  };
  // A choice made in another tab applies here at once. An off applies even when it arrives late,
  // after the choice is on again: this page stops and the tab forgets its entry. An on never
  // restarts this page.
  addEventListener(
    "storage",
    ({ key, newValue }) => {
      if (status === "refused" || (key !== null && key !== CHOICE)) return;
      if (key === CHOICE && newValue === "off") turnedOff();
      reread();
    },
    on,
  );
  // So it does on a page restored from the back-forward cache, which can report vitals again.
  addEventListener(
    "pageshow",
    ({ persisted }) => {
      if (persisted && status !== "refused") reread();
    },
    on,
  );
  render();
  // Announced from here on: a change the visitor makes, not the state the page opened in.
  for (const { control, place } of controls)
    if (place === "footer")
      control.querySelector("[data-site-analytics-status]")?.setAttribute("role", "status");
  if (!sending) {
    forgetEntry();
    return () => listeners.abort();
  }

  let entry = enterPage(location.search, document.referrer, location.origin);
  send({ event: "$pageview", properties: { route, ...entry } });
  // A page restored from the back-forward cache takes the tab's entry as it is now: a later page
  // may have replaced or removed it.
  addEventListener(
    "pageshow",
    ({ persisted }) => {
      if (persisted && sending) entry = tabEntry();
    },
    on,
  );

  // Core Web Vitals as web-vitals reports them: LCP once it is final, CLS and INP as the page is
  // hidden, and again at a later hide if they grew. A page without an interaction has no INP, and
  // a browser that can't measure a vital reports none. web-vitals has no stop, so after turning
  // off its reports go unsent.
  const vital = ({ name, value }: CLSMetric | INPMetric | LCPMetric): void => {
    const rounded = name === "CLS" ? Math.round(value * 1000) / 1000 : Math.round(value);
    if (Number.isFinite(rounded) && rounded >= 0 && rounded < MAX_VITAL)
      send({ event: "$web_vitals", properties: { [`$web_vitals_${name}_value`]: rounded } });
  };
  onLCP(vital);
  onCLS(vital);
  onINP(vital);

  const scrollDepth = followScrollDepth(measuring.signal);
  let visibleMs = 0;
  let visibleSince = document.visibilityState === "visible" ? performance.now() : null;
  let left = false;
  const leave = (): void => {
    if (left) return;
    left = true;
    if (visibleSince !== null) visibleMs += performance.now() - visibleSince;
    const { scroll, content } = scrollDepth();
    measuring.abort();
    send({
      event: "$pageleave",
      properties: {
        route,
        visible: visibleBucket(visibleMs),
        $prev_pageview_pathname: route,
        $prev_pageview_max_scroll_percentage: scroll,
        $prev_pageview_max_content_percentage: content,
      },
    });
  };
  addEventListener("pagehide", leave, on);
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") leave();
      else visibleSince = performance.now();
    },
    on,
  );

  document.addEventListener(
    "click",
    ({ target }) => {
      const link = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link) return;
      const href = link.getAttribute("href") ?? "";
      const docs = DOCS.exec(href);
      const installer = link.dataset["installer"];
      const download =
        installer && Object.hasOwn(INSTALLERS, installer)
          ? INSTALLERS[installer]
          : href.startsWith("https://apps.microsoft.com/")
            ? STORE
            : undefined;
      if (docs) {
        const doc_section = docs[1] ?? "index";
        if (!ID.test(doc_section)) return;
        const location = link.closest("header")
          ? "header"
          : link.closest("footer")
            ? "footer"
            : "page";
        send({ event: "docs_link_clicked", properties: { doc_section, route, location } });
      } else if (download) {
        const location = link.closest(".hero") ? "hero" : "page";
        send({
          event: "download_clicked",
          properties: { ...download, ...entry, download_type: "stable", route, location },
        });
      } else if (href.startsWith(REPOSITORY)) {
        const link_location = !link.closest("footer")
          ? "page"
          : href === REPOSITORY
            ? "footer_source"
            : href.includes("/issues")
              ? "footer_bug"
              : "footer_license";
        send({ event: "github_link_clicked", properties: { route, link_location } });
      }
    },
    on,
  );

  // Parts of the page reached, each once. The build wrote every id these read.
  const seen = new Map<Element, () => SiteEvent | undefined>();
  const opened = location.hash.slice(1);
  if (route === "/")
    for (const section of document.querySelectorAll("main section[id]")) {
      const id = HOME_SECTIONS.find((known) => known === section.id);
      if (id)
        seen.set(section, () => ({
          event: "feature_section_viewed",
          properties: { feature_name: id },
        }));
    }
  const guide = route.startsWith("/docs/") ? route.slice("/docs/".length) : "";
  if (ID.test(guide))
    for (const heading of document.querySelectorAll("article h2[id], article h3[id]"))
      if (ID.test(heading.id))
        seen.set(heading, () => ({
          event: "guide_section_viewed",
          properties: { guide, section: heading.id },
        }));
  if (route === "/faq")
    for (const row of document.querySelectorAll(".faq-rows > div[id]")) {
      if (!ID.test(row.id)) continue;
      const faq_question = row.id;
      // The page opened on this question's address: counted now, as the reason it was read.
      if (opened === faq_question)
        send({ event: "faq_question_viewed", properties: { faq_question, via: "anchor" } });
      else
        seen.set(row, () => ({
          event: "faq_question_viewed",
          properties: { faq_question, via: "scroll" },
        }));
    }
  if (route === "/releases")
    for (const heading of document.querySelectorAll(".release > h2[id]")) {
      const version = heading.id.slice(1);
      if (/^v\d+\.\d+\.\d+$/.test(heading.id))
        seen.set(heading, () => ({ event: "changelog_viewed", properties: { version } }));
    }
  if (seen.size && typeof IntersectionObserver === "function") {
    observer = new IntersectionObserver((entries) => {
      for (const { isIntersecting, target } of entries) {
        if (!isIntersecting) continue;
        observer?.unobserve(target);
        const event = seen.get(target)?.();
        if (event) send(event);
      }
    });
    for (const element of seen.keys()) observer.observe(element);
  }

  return () => {
    stopSending();
    listeners.abort();
  };
}
