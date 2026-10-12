import { parseVersion } from "@mrstreamer/contracts/version";
import type { BuildProperties } from "./model.ts";
import type { ProductionCaptureConfig } from "./transport.ts";

/** Optional named release setup. Invalid/missing configuration keeps the bundle disabled. */
export function analyticsReleaseConfiguration(options: {
  releaseBuild: boolean;
  host: string | undefined;
  projectToken: string | undefined;
}): { releaseBuild: boolean; capture: ProductionCaptureConfig | null } {
  const { host, projectToken } = options;
  if (
    !options.releaseBuild ||
    (host !== "https://eu.i.posthog.com" && host !== "https://us.i.posthog.com") ||
    !projectToken ||
    !/^phc_[A-Za-z0-9_-]+$/.test(projectToken)
  )
    return { releaseBuild: false, capture: null };
  return {
    releaseBuild: true,
    capture: {
      endpoint:
        host === "https://eu.i.posthog.com"
          ? "https://eu.i.posthog.com/i/v0/e/"
          : "https://us.i.posthog.com/i/v0/e/",
      projectToken,
    },
  };
}

/** Build identity is independent of the update preference. Unpackaged versions aren't releases. */
export function analyticsBuild(options: {
  version: string;
  packaged: boolean;
  platform: string;
  arch: string;
  store: boolean;
}): Omit<BuildProperties, "update_channel"> {
  const version = parseVersion(options.version);
  return {
    app_version: version ? options.version.replace(/^v/, "") : "unknown",
    build_channel:
      options.packaged && version ? (version.nightly ? "nightly" : "stable") : "unknown",
    os:
      options.platform === "darwin"
        ? "macos"
        : options.platform === "win32"
          ? "windows"
          : options.platform === "linux"
            ? "linux"
            : "unknown",
    arch:
      options.arch === "x64" || options.arch === "arm64" || options.arch === "ia32"
        ? options.arch
        : "unknown",
    distribution: options.store ? "store" : "direct",
  };
}
