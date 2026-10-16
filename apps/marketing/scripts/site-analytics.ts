import type { SiteCapture } from "../src/analytics.ts";

/** The only production ingestion the site may reach: the EU Cloud the privacy policy states. */
const EU = "https://eu.i.posthog.com";
/** PostHog's capture path, kept the same behind the site's own route. */
const CAPTURE = "/i/v0/e/";
/**
 * The site's own address for PostHog, which pages send to and name as `$lib_custom_api_host`, as
 * posthog-js does for a proxy. Only INGEST_ROUTE gives it meaning.
 */
export const INGEST = "https://mrstreamer.app/ingest";
/**
 * The Vercel route package-vercel.ts packs: a POST to exactly /ingest/i/v0/e/ goes on to EU's
 * capture path. Any other method or path under /ingest answers 404. Vercel passes the visitor's
 * IP address on as x-forwarded-for and x-real-ip, which ingestion's cookieless hash needs.
 */
export const INGEST_ROUTE = {
  src: "^/ingest/i/v0/e/$",
  methods: ["POST"],
  dest: `${EU}${CAPTURE}`,
} as const;

/**
 * Where the built site sends website analytics, from these named variables only:
 * - MR_STREAMER_SITE_ANALYTICS_LOCAL_ENDPOINT: a literal loopback `http://127.0.0.1:<port>/i/v0/e/`
 *   for verification. It wins, and then no production host or token is read.
 * - MR_STREAMER_SITE_ANALYTICS_RELEASE_BUILD=1 with _HOST set to PostHog's EU host and _PROJECT_TOKEN
 *   set to the project's public `phc_` capture key: production, for `vite build` only. Pages then
 *   send to the site's own INGEST route, which forwards to that host.
 * Anything else, including a US host, builds a site that sends nothing.
 */
export function siteAnalyticsConfiguration(
  env: Readonly<Record<string, string | undefined>>,
  building: boolean,
): SiteCapture | null {
  const local = env["MR_STREAMER_SITE_ANALYTICS_LOCAL_ENDPOINT"];
  if (local !== undefined) return loopback(local);
  if (!building || env["MR_STREAMER_SITE_ANALYTICS_RELEASE_BUILD"] !== "1") return null;
  const token = env["MR_STREAMER_SITE_ANALYTICS_PROJECT_TOKEN"];
  if (
    env["MR_STREAMER_SITE_ANALYTICS_HOST"] !== EU ||
    !token ||
    !/^phc_[A-Za-z0-9_-]+$/.test(token)
  )
    return null;
  return { endpoint: `${INGEST}${CAPTURE}`, token, apiHost: INGEST };
}

function loopback(endpoint: string): SiteCapture | null {
  try {
    const url = new URL(endpoint);
    return url.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.port &&
      url.pathname === CAPTURE &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? { endpoint: url.href, token: "mrstreamer-local-verification", apiHost: null }
      : null;
  } catch {
    return null;
  }
}
