import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { type } from "arktype";
import { CaptureEvent } from "./model.ts";

type CaptureResult = "accepted" | "retry" | "discard";
export interface CaptureTransport {
  readonly kind: "local" | "production";
  send(event: CaptureEvent, signal: AbortSignal): Promise<CaptureResult>;
}

/** Only an explicit release-build configuration may name a PostHog project. No ambient keys. */
export interface ProductionCaptureConfig {
  readonly endpoint: "https://us.i.posthog.com/i/v0/e/" | "https://eu.i.posthog.com/i/v0/e/";
  readonly projectToken: string;
}

/** Isolated, automated and development sessions can only select loopback or no transport. */
export function analyticsTransport(options: {
  readonly production: ProductionCaptureConfig | null;
  readonly releaseBuild: boolean;
  readonly packaged: boolean;
  readonly isolated: boolean;
  readonly automated: boolean;
  readonly localEndpoint: string | undefined;
}): CaptureTransport | null {
  if (options.localEndpoint !== undefined)
    return options.isolated ? localCapture(options.localEndpoint) : null;
  if (
    !options.releaseBuild ||
    !options.packaged ||
    options.isolated ||
    options.automated ||
    !options.production
  )
    return null;
  const { endpoint, projectToken } = options.production;
  if (
    !["https://us.i.posthog.com/i/v0/e/", "https://eu.i.posthog.com/i/v0/e/"].includes(endpoint) ||
    !/^phc_[A-Za-z0-9_-]+$/.test(projectToken)
  )
    return null;
  return capture(new URL(endpoint), projectToken, "production");
}

/**
 * Verification transport only: literal loopback, fixed path, no redirects, DNS or proxy settings.
 * Local mode never reads a production host or project token and cannot fall back to production.
 */
export function localCapture(endpoint: string): CaptureTransport | null {
  let url: URL;
  try {
    url = new URL(endpoint);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.port ||
      url.pathname !== "/i/v0/e/" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
  } catch {
    return null;
  }
  return capture(url, "mrstreamer-local-verification", "local");
}

function capture(url: URL, projectToken: string, kind: CaptureTransport["kind"]): CaptureTransport {
  const sendRequest = url.protocol === "https:" ? httpsRequest : request;
  return {
    kind,
    async send(event, signal) {
      const allowed = CaptureEvent()(event);
      if (allowed instanceof type.errors || signal.aborted) return "discard";
      // Reconstruct the boundary even after validation. No caller-owned object is spread here.
      const properties = {
        app_version: allowed.properties.app_version,
        build_channel: allowed.properties.build_channel,
        update_channel: allowed.properties.update_channel,
        os: allowed.properties.os,
        arch: allowed.properties.arch,
        distribution: allowed.properties.distribution,
        profile_origin: allowed.properties.profile_origin,
        $process_person_profile: false,
        $geoip_disable: true,
        ...(allowed.event === "app_active_day"
          ? { activity_date: allowed.properties.activity_date }
          : {}),
        ...(allowed.event === "app_summary_day"
          ? { summary_date: allowed.properties.summary_date, counts: allowed.properties.counts }
          : {}),
      };
      const body = JSON.stringify({
        api_key: projectToken,
        event: allowed.event,
        uuid: allowed.uuid,
        distinct_id: allowed.distinct_id,
        timestamp: allowed.timestamp,
        properties,
      });
      return new Promise((resolve) => {
        const req = sendRequest(
          url,
          {
            method: "POST",
            agent: false,
            signal,
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
          },
          (response) => {
            // Body content is never needed. Closing also bounds an endless response body.
            response.destroy();
            const status = response.statusCode ?? 0;
            resolve(
              status >= 200 && status < 300
                ? "accepted"
                : status === 429 || status >= 500
                  ? "retry"
                  : "discard",
            );
          },
        );
        const timeout = setTimeout(
          () => req.destroy(new Error("Analytics request deadline.")),
          1000,
        );
        req.once("close", () => clearTimeout(timeout));
        req.once("error", () => resolve("retry"));
        req.end(body);
      });
    },
  };
}
