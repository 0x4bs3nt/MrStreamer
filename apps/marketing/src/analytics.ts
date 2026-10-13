// Website analytics: a few fixed events per page, sent to the app statistics' PostHog project
// without an SDK. docs/privacy.md#website-analytics is the promise this keeps:
// - On unless the browser sends Global Privacy Control or Do Not Track, the visitor turned them
//   off, or local storage fails. Local storage holds only an explicit "on" or "off".
// - A random id made when the page opens ties that page's events together. It is never stored,
//   and its `site_` prefix keeps it apart from the app's installation ids.
// - No address, referrer, query, fragment, typed text, device or browser detail is sent. Every
//   value is fixed here or written into the page by the build, and anything else is dropped.
// - At most MAX_EVENTS requests per page, each aborted after DEADLINE_MS. No retry or queue.
// - Turning off sends nothing more and aborts requests still open. Turning on sends nothing until
//   the next page opens.

/** Where the build points capture: PostHog's EU ingestion, or a loopback endpoint for checks. */
export interface SiteCapture {
  readonly endpoint: string;
  readonly token: string;
}

/** Requests one page may make, however long it stays open or however often it is clicked. */
export const MAX_EVENTS = 64;
/** How long one request may stay open before the page gives up on it. */
export const DEADLINE_MS = 10_000;

/** The one stored key. Absent means on. */
export const CHOICE = "mrstreamer.site-analytics";

type Choice = "on" | "off";
/** What the switch shows. "refused": GPC or Do Not Track. "unavailable": local storage failed. */
type Status = Choice | "refused" | "unavailable";

const HOME_SECTIONS = [
  "live-tv",
  "movies-and-series",
  "sound-and-subtitles",
  "what-you-need",
  "questions",
  "downloads",
] as const;
type HomeSection = (typeof HOME_SECTIONS)[number];

interface Download {
  readonly os: "mac" | "windows" | "linux";
  readonly kind: "dmg" | "exe" | "appimage" | "deb" | "store";
}
/** By the `data-installer` names downloads.ts gives the release's files. */
const INSTALLERS: Readonly<Record<string, Download>> = {
  dmg: { os: "mac", kind: "dmg" },
  exe: { os: "windows", kind: "exe" },
  appImage: { os: "linux", kind: "appimage" },
  deb: { os: "linux", kind: "deb" },
};
const STORE: Download = { os: "windows", kind: "store" };

type SiteEvent =
  | { readonly event: "site_page_view"; readonly properties: { readonly route: string } }
  | {
      readonly event: "site_page_leave";
      readonly properties: {
        readonly route: string;
        readonly visible: "under_10s" | "10_30s" | "30s_2m" | "2_10m" | "over_10m";
      };
    }
  | {
      readonly event: "site_download_click";
      readonly properties: Download & {
        /** Every installer link and the Store carry stable releases. Nightlies are on GitHub. */
        readonly release_channel: "stable";
        readonly route: string;
        readonly location: "hero" | "page";
      };
    }
  | {
      readonly event: "site_github_click";
      readonly properties: {
        readonly route: string;
        readonly location: "footer_source" | "footer_bug" | "footer_license" | "page";
      };
    }
  | {
      readonly event: "site_docs_click";
      readonly properties: {
        /** "index" for /docs, or a guide's slug. */
        readonly doc_section: string;
        readonly route: string;
        readonly location: "header" | "footer" | "page";
      };
    }
  | {
      readonly event: "site_guide_section_view";
      readonly properties: { readonly guide: string; readonly section: string };
    }
  | {
      readonly event: "site_home_section_view";
      readonly properties: { readonly section: HomeSection };
    }
  | {
      readonly event: "site_faq_question_view";
      readonly properties: { readonly question: string; readonly via: "scroll" | "anchor" };
    }
  | { readonly event: "site_release_view"; readonly properties: { readonly version: string } };

const SITE = "https://mrstreamer.app";
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

/** The page's route from its canonical address, or 404 for a page without one. */
function routeOf(document: Document): string {
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? "";
  const route = canonical.startsWith(`${SITE}/`) ? canonical.slice(SITE.length) : "";
  return /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/.test(route) ? route : "404";
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
  let sending = status === "on" && typeof crypto.randomUUID === "function";
  const page = sending ? `site_${crypto.randomUUID()}` : "";
  let budget = MAX_EVENTS;
  /** Each open request's abort and deadline, cleared as it settles. */
  const open = new Set<{
    readonly controller: AbortController;
    readonly deadline: ReturnType<typeof setTimeout>;
  }>();
  const listeners = new AbortController();
  const on = { signal: listeners.signal };
  let observer: IntersectionObserver | undefined;

  const send = ({ event, properties }: SiteEvent): void => {
    if (!sending || budget === 0) return;
    budget--;
    const body = JSON.stringify({
      api_key: capture.token,
      event,
      distinct_id: page,
      properties: {
        ...properties,
        source: "website",
        $process_person_profile: false,
        $geoip_disable: true,
      },
    });
    // A string body is text/plain, so the browser sends it without a preflight. Events that come
    // as the page closes or follows a link need keepalive to arrive. Chromium doesn't cancel a
    // keepalive request once sent, so every other event goes without it and the signal stops it.
    const keepalive =
      event === "site_page_leave" ||
      event === "site_download_click" ||
      event === "site_github_click" ||
      event === "site_docs_click";
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
    if (status !== "on") stopSending();
    render();
  };

  // A choice made in another tab applies here at once.
  addEventListener(
    "storage",
    ({ key }) => {
      if (status === "refused" || (key !== null && key !== CHOICE)) return;
      status = storedStatus();
      if (status !== "on") stopSending();
      render();
    },
    on,
  );
  render();
  // Announced from here on: a change the visitor makes, not the state the page opened in.
  for (const { control, place } of controls)
    if (place === "footer")
      control.querySelector("[data-site-analytics-status]")?.setAttribute("role", "status");
  if (!sending) return () => listeners.abort();

  send({ event: "site_page_view", properties: { route } });

  let visibleMs = 0;
  let visibleSince = document.visibilityState === "visible" ? performance.now() : null;
  let left = false;
  const leave = (): void => {
    if (left) return;
    left = true;
    if (visibleSince !== null) visibleMs += performance.now() - visibleSince;
    send({ event: "site_page_leave", properties: { route, visible: visibleBucket(visibleMs) } });
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
        send({ event: "site_docs_click", properties: { doc_section, route, location } });
      } else if (download) {
        const location = link.closest(".hero") ? "hero" : "page";
        send({
          event: "site_download_click",
          properties: { ...download, release_channel: "stable", route, location },
        });
      } else if (href.startsWith(REPOSITORY)) {
        const location = !link.closest("footer")
          ? "page"
          : href === REPOSITORY
            ? "footer_source"
            : href.includes("/issues")
              ? "footer_bug"
              : "footer_license";
        send({ event: "site_github_click", properties: { route, location } });
      }
    },
    on,
  );

  // Parts of the page reached, each once. The build wrote every id these read.
  const seen = new Map<Element, () => SiteEvent | undefined>();
  const opened = location.hash.slice(1);
  if (route === "/")
    for (const section of document.querySelectorAll("main > section[id]")) {
      const id = HOME_SECTIONS.find((known) => known === section.id);
      if (id)
        seen.set(section, () => ({ event: "site_home_section_view", properties: { section: id } }));
    }
  const guide = route.startsWith("/docs/") ? route.slice("/docs/".length) : "";
  if (ID.test(guide))
    for (const heading of document.querySelectorAll("article h2[id], article h3[id]"))
      if (ID.test(heading.id))
        seen.set(heading, () => ({
          event: "site_guide_section_view",
          properties: { guide, section: heading.id },
        }));
  if (route === "/faq")
    for (const row of document.querySelectorAll(".faq-rows > div[id]")) {
      if (!ID.test(row.id)) continue;
      const question = row.id;
      // The page opened on this question's address: counted now, as the reason it was read.
      if (opened === question)
        send({ event: "site_faq_question_view", properties: { question, via: "anchor" } });
      else
        seen.set(row, () => ({
          event: "site_faq_question_view",
          properties: { question, via: "scroll" },
        }));
    }
  if (route === "/releases")
    for (const heading of document.querySelectorAll(".release > h2[id]")) {
      const version = heading.id.slice(1);
      if (/^v\d+\.\d+\.\d+$/.test(heading.id))
        seen.set(heading, () => ({ event: "site_release_view", properties: { version } }));
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
