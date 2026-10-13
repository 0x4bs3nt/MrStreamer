import type { SiteCapture } from "../src/analytics.ts";

/** The only production ingestion the site may name: the EU Cloud the privacy policy states. */
const EU = "https://eu.i.posthog.com";

/**
 * Where the built site sends website analytics, from these named variables only:
 * - MR_STREAMER_SITE_ANALYTICS_LOCAL_ENDPOINT: a literal loopback `http://127.0.0.1:<port>/i/v0/e/`
 *   for verification. It wins, and then no production host or token is read.
 * - MR_STREAMER_SITE_ANALYTICS_RELEASE_BUILD=1 with _HOST set to PostHog's EU host and _PROJECT_TOKEN
 *   set to the project's public `phc_` capture key: production, for `vite build` only.
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
  return { endpoint: `${EU}/i/v0/e/`, token };
}

function loopback(endpoint: string): SiteCapture | null {
  try {
    const url = new URL(endpoint);
    return url.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.port &&
      url.pathname === "/i/v0/e/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? { endpoint: url.href, token: "mrstreamer-local-verification" }
      : null;
  } catch {
    return null;
  }
}
