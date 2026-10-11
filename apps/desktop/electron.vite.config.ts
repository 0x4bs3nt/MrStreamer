import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { thirdPartyNotices } from "./scripts/licences.ts";
import { analyticsReleaseConfiguration } from "./src/main/analytics/build.ts";

const root = fileURLToPath(new URL(".", import.meta.url));

// Notes the modules in each bundle; after the last, writes out/licences/third-party.json.
const notices = thirdPartyNotices(root, ["main", "preload", "renderer"]);

// `__BUILD_COMMIT__` in the main and renderer bundles: the commit the build comes from, which
// Settings > About links to as the build's source.
const commit = JSON.stringify(buildCommit());

export default defineConfig(({ command }) => {
  const analytics = analyticsReleaseConfiguration({
    releaseBuild: command === "build" && process.env["MR_STREAMER_ANALYTICS_RELEASE_BUILD"] === "1",
    host: process.env["MR_STREAMER_ANALYTICS_HOST"],
    projectToken: process.env["MR_STREAMER_ANALYTICS_PROJECT_TOKEN"],
  });
  return {
    main: {
      plugins: [notices("main")],
      define: {
        // The app's TMDB key, from the release's secret; builds without it fetch no metadata.
        __TMDB_KEY__: JSON.stringify(process.env["MR_STREAMER_TMDB_KEY"] ?? ""),
        __BUILD_COMMIT__: commit,
        // Only the explicitly named release configuration is read. No ambient PostHog keys.
        __ANALYTICS_CAPTURE__: JSON.stringify(analytics.capture),
        __ANALYTICS_RELEASE_BUILD__: JSON.stringify(analytics.releaseBuild),
      },
    },
    preload: {
      plugins: [notices("preload")],
      // Sandboxed preload scripts must be CommonJS.
      build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
    },
    renderer: {
      plugins: [react(), tailwindcss(), notices("renderer")],
      define: { __BUILD_COMMIT__: commit },
    },
  };
});

/**
 * HEAD of the repository this app folder is in: the release workflow checks out the commit it
 * releases before it builds. Empty outside a git checkout of the repository, such as an unpacked
 * source archive, rather than the commit of some other repository around it.
 */
function buildCommit(): string {
  try {
    const [top = "", head = ""] = execFileSync("git", ["rev-parse", "--show-toplevel", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split("\n");
    const ours = realpathSync(top) === realpathSync(join(root, "..", ".."));
    return ours && /^[0-9a-f]{40}$/.test(head) ? head : "";
  } catch {
    return "";
  }
}
