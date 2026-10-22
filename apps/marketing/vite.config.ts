// The same page registry drives local routing, static build inputs and Vercel packaging.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Connect, type UserConfig } from "vite";
import type { SiteCapture } from "./src/analytics.ts";
import { installers, verifiedDownloads, writeDownloads, type Downloads } from "./src/downloads.ts";
import { systemOf } from "./src/system.ts";
import { INDEXNOW_KEY, INDEXNOW_MARKER } from "./scripts/indexnow.ts";
import { PAGES, SITE, renderPage, writePackages } from "./scripts/pages.ts";
import { newestStable, stableReleases, type Release } from "./scripts/releases.ts";
import { siteAnalyticsConfiguration } from "./scripts/site-analytics.ts";

const root = import.meta.dirname;
const addresses = new Map(
  PAGES.flatMap(({ address, file }) =>
    address === "/"
      ? [[address, file]]
      : [
          [address, file],
          [`${address}/`, file],
        ],
  ),
);
const MISSING = "404.html";
const systemScript = `<script>{const os=(${systemOf})(navigator);if(os)document.documentElement.dataset.os=os}</script>`;
interface DownloadResult {
  readonly downloads: Downloads | null;
  /** Fresh history proves release eligibility even when no stable release remains. */
  readonly verifiedAt?: number;
}
let downloads: Promise<DownloadResult> | undefined;
let releases: Promise<Release[] | null> | undefined;

async function resolveDownloads(): Promise<DownloadResult> {
  const history = await (releases ??= resolveReleases());
  const verifiedAt = history ? Date.now() : undefined;
  const found = await verifiedDownloads(fetch, history ? newestStable(history) : undefined);
  const missing = installers.filter((installer) => !found?.installers.includes(installer));
  console.log(
    found && missing.length === 0
      ? `Download links: ${found.version}, every installer.`
      : `::warning::Download links: ${found ? `GitHub didn't answer for ${found.version}'s ${missing.join(", ")}` : "no current stable release could be verified"}. The Releases page is linked instead.`,
  );
  return { downloads: found, ...(verifiedAt === undefined ? {} : { verifiedAt }) };
}

async function resolveReleases(): Promise<Release[] | null> {
  const found = await stableReleases();
  if (!found)
    console.warn(
      "::warning::Release history unavailable. The page links to GitHub Releases instead.",
    );
  return found;
}

/** Known page addresses answer 200; all other non-file addresses and HTML aliases answer 404. */
function pages(read: (file: string) => string | Promise<string>): Connect.NextHandleFunction {
  return async (req, res, next) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const file = addresses.get(path);
    try {
      const html = await read(file ?? MISSING);
      res.statusCode = file ? 200 : 404;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(req.method === "HEAD" ? undefined : html);
    } catch (error) {
      next(error);
    }
  };
}

export default defineConfig(({ command }) => {
  const analytics = siteAnalyticsConfiguration(process.env, command === "build");
  // Names only the origin; the key is never printed.
  if (analytics) console.log(`Website analytics: ${new URL(analytics.endpoint).origin}.`);
  else if (command === "build" && process.env["MR_STREAMER_SITE_ANALYTICS_RELEASE_BUILD"] === "1")
    console.warn(
      "::warning::Website analytics: no valid EU host and public project key, so the site sends nothing.",
    );
  return config(analytics);
});

/** The site's build, with website analytics compiled in only as `analytics` names them. */
const config = (analytics: SiteCapture | null): UserConfig => ({
  appType: "custom",
  define: { __SITE_ANALYTICS__: JSON.stringify(analytics) },
  esbuild: { legalComments: "inline" },
  build: {
    rollupOptions: {
      input: [...PAGES.map(({ file }) => join(root, file)), join(root, MISSING)],
      output: {
        banner:
          "/*! web-vitals 6.2.3 | Copyright 2020 Google LLC | Apache-2.0 | /licenses/web-vitals.txt */",
      },
    },
  },
  plugins: [
    {
      name: "marketing-pages",
      transformIndexHtml: {
        order: "pre",
        async handler(html, context) {
          const file = context.path.replace(/^\//, "");
          const page = PAGES.find((page) => page.file === file);
          const needsDownloads =
            page?.address === "/" || page?.address === "/about" || page?.address === "/download";
          const resolved = needsDownloads ? await (downloads ??= resolveDownloads()) : null;
          const found = resolved?.downloads ?? null;
          const history =
            page?.address === "/releases" ? await (releases ??= resolveReleases()) : null;
          const rendered = page && page.address !== "/" ? renderPage(file, found, history) : html;
          const withSystem = writePackages(rendered).replace("<!-- system -->", () => systemScript);
          return writeDownloads(withSystem, found, resolved?.verifiedAt);
        },
      },
      generateBundle() {
        const urlList = [...new Set(PAGES.map(({ address }) => SITE + address))];
        const revision = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim();
        this.emitFile({ type: "asset", fileName: `${INDEXNOW_KEY}.txt`, source: INDEXNOW_KEY });
        this.emitFile({
          type: "asset",
          fileName: INDEXNOW_MARKER,
          source:
            JSON.stringify({
              site: SITE,
              revision,
              buildId: randomUUID(),
              key: INDEXNOW_KEY,
              urlList,
            }) + "\n",
        });
        this.emitFile({
          type: "asset",
          fileName: "sitemap.xml",
          source:
            '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
            urlList.map((url) => `  <url><loc>${url}</loc></url>`).join("\n") +
            "\n</urlset>\n",
        });
      },
      configureServer(server) {
        for (const page of PAGES)
          if (page.markdown) server.watcher.add(join(root, "../..", page.markdown));
        server.watcher.on("change", (path) => {
          if (path.startsWith(join(root, "../../docs/"))) server.ws.send({ type: "full-reload" });
        });
        const answer = pages((file) =>
          server.transformIndexHtml(`/${file}`, readFileSync(join(root, file), "utf8")),
        );
        server.middlewares.use((req, res, next) => {
          const path = req.url?.split("?")[0] ?? "/";
          return addresses.has(path) || path.endsWith(".html") ? answer(req, res, next) : next();
        });
        return () => server.middlewares.use(answer);
      },
      configurePreviewServer(server) {
        const answer = pages((file) => readFileSync(join(root, "dist", file), "utf8"));
        // Ahead of filesystem handling: directory URLs and HTML aliases must agree with dev/Vercel.
        server.middlewares.use((req, res, next) => {
          const path = req.url?.split("?")[0] ?? "/";
          return addresses.has(path) || path.endsWith(".html") ? answer(req, res, next) : next();
        });
        return () => server.middlewares.use(answer);
      },
    },
  ],
});
