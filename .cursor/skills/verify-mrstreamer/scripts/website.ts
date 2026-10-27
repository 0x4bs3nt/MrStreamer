#!/usr/bin/env -S node
// Real local-site navigation in an isolated browser, for environments without T3 preview.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { connect, type Page } from "../../../../apps/desktop/test/e2e/app.ts";
import { electronExecutable, freePort, record, stop } from "./session.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const marketing = join(root, "apps/marketing");
if (process.argv.includes("--help")) {
  console.log(
    "Usage: pnpm verify:website, after pnpm build:marketing. On headless Linux: xvfb-run -a pnpm verify:website. Proof stays in .local/verification/website-<unique>/.",
  );
} else {
  await run();
}

async function run() {
  const executable = await electronExecutable();
  const html = await readFile(join(marketing, "dist/index.html"));
  if (process.platform === "linux" && !process.env["DISPLAY"])
    throw new Error("No display. Use xvfb-run -a pnpm verify:website.");
  await mkdir(join(root, ".local/verification"), { recursive: true });
  const evidence = await mkdtemp(join(root, ".local/verification/website-"));
  const scratch = await mkdtemp(join(tmpdir(), "mrstreamer-website-"));
  const profile = join(scratch, "profile");
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("Website verification interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let server: ChildProcess | undefined;
  let browser: ChildProcess | undefined;
  let page: Page | undefined;
  let failure: unknown;
  const logs: string[] = [];
  const actions: { action: string; at: string }[] = [];
  const observed: Record<string, unknown> = {
    buildSha256: createHash("sha256").update(html).digest("hex"),
  };
  try {
    const serverPort = await freePort();
    const origin = `http://127.0.0.1:${serverPort}`;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          name !== "ELECTRON_RUN_AS_NODE" && name !== "GH_TOKEN" && name !== "GITHUB_TOKEN",
      ),
    );
    const launch = (binary: string, args: string[], cwd: string) => {
      const child = spawn(binary, args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.on("error", (error) => {
        logs.push(String(error));
      });
      for (const stream of [child.stdout, child.stderr])
        stream?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
      return child;
    };
    server = launch(
      process.execPath,
      [
        join(marketing, "node_modules/vite/bin/vite.js"),
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        String(serverPort),
        "--strictPort",
      ],
      marketing,
    );
    const wait = async (check: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        abort.signal.throwIfAborted();
        if (await check().catch(() => false)) return;
        await delay(100, undefined, { signal: abort.signal });
      }
      throw new Error(`Website readiness timed out: ${check.toString()}`);
    };
    await wait(async () => (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok);
    if (server.exitCode !== null || server.signalCode !== null)
      throw new Error("Owned preview server exited.");
    const browserPort = await freePort();
    const shell = join(scratch, "browser.cjs");
    // Electron's builtin module is resolved by its runtime, not a downloaded browser dependency.
    await writeFile(
      shell,
      `const { app, BrowserWindow, session } = require('electron');
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(${JSON.stringify(origin + "/")}) || /^(data|blob|devtools):/.test(details.url);
    if (!allowed) console.log('Blocked external request: ' + new URL(details.url).origin);
    callback({ cancel: !allowed });
  });
  const window = new BrowserWindow({ width: 1280, height: 900, backgroundColor: '#000', webPreferences: { nodeIntegration: false, contextIsolation: true } });
  window.loadURL(${JSON.stringify(origin)});
});
app.on('window-all-closed', () => app.quit());
`,
    );
    browser = launch(
      executable,
      [
        `--remote-debugging-port=${browserPort}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${profile}`,
        "--enable-automation",
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        shell,
      ],
      root,
    );
    page = await connect(browserPort);
    const livePage = page;
    const send = async (method: string, params: Record<string, unknown> = {}) => {
      abort.signal.throwIfAborted();
      const reply = await livePage.send(method, params);
      if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
      return reply.result;
    };
    const doctor = async () => {
      if (
        browser?.exitCode !== null ||
        browser?.signalCode !== null ||
        server?.exitCode !== null ||
        server?.signalCode !== null
      )
        throw new Error("Owned website session exited.");
      const identity = await send("Browser.getBrowserCommandLine");
      const browserArgs = record(identity) ? identity["arguments"] : undefined;
      if (
        !Array.isArray(browserArgs) ||
        ![shell, `--user-data-dir=${profile}`, `--remote-debugging-port=${browserPort}`].every(
          (arg) => browserArgs.includes(arg),
        )
      )
        throw new Error("Website CDP belongs to another browser.");
      const url = await livePage.evaluate<string>("location.origin");
      if (url !== origin) throw new Error("Browser left our local website.");
      observed["doctor"] = {
        browserPid: browser?.pid,
        serverPid: server?.pid,
        browserPort,
        serverPort,
        profile,
        origin,
      };
    };
    await wait(() =>
      livePage.evaluate<boolean>(
        `location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete'`,
      ),
    );
    await doctor();
    let lastCapture = "";
    let pageScriptsDisabled = false;
    const capture = async (name: string) => {
      // Script-disabled pages cannot schedule the animation-frame callback.
      if (!pageScriptsDisabled)
        await livePage.evaluate(
          "document.fonts.ready.then(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined))); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })",
        );
      await delay(500, undefined, { signal: abort.signal });
      const screenshot = await send("Page.captureScreenshot", { format: "png" });
      if (!record(screenshot) || typeof screenshot["data"] !== "string")
        throw new Error("No website screenshot.");
      await writeFile(join(evidence, `${name}.png`), Buffer.from(screenshot["data"], "base64"));
      await writeFile(
        join(evidence, `${name}.ax.json`),
        JSON.stringify(await send("Accessibility.getFullAXTree"), null, 2),
      );
      lastCapture = name;
    };
    await wait(() =>
      livePage.evaluate<boolean>(
        "document.readyState === 'complete' && !!document.querySelector('h1')",
      ),
    );
    actions.push({ action: "Open local Home at 1280px", at: new Date().toISOString() });
    observed["homeTitle"] = await livePage.evaluate<string>("document.title");
    observed["detectedSystem"] = await livePage.evaluate<string>(
      "document.documentElement.dataset.os ?? 'unknown'",
    );
    await capture("home-desktop");
    actions.push({ action: "View Home at 390px", at: new Date().toISOString() });
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await delay(250, undefined, { signal: abort.signal });
    const mobile = await livePage.evaluate<{ width: number; contentWidth: number }>(
      "({ width: innerWidth, contentWidth: document.documentElement.scrollWidth })",
    );
    observed["mobileHome"] = mobile;
    if (mobile.contentWidth > mobile.width + 1)
      throw new Error("Homepage overflows horizontally at 390px.");
    await capture("home-mobile");
    const visit = async (href: string, expected: string, name: string) => {
      const element = `[...document.querySelectorAll(${JSON.stringify(`a[href="${href}"]`)})].find(a => { const box = a.getBoundingClientRect(); return box.width > 0 && box.height > 0; })`;
      await wait(() => livePage.evaluate<boolean>(`!!${element}`));
      let scrolled = false;
      // Scroll when a requested link is below the current viewport.
      await wait(async () => {
        const box = await livePage.evaluate<{ y: number; height: number }>(
          `(() => { const box = ${element}.getBoundingClientRect(); return { y: box.y, height: box.height }; })()`,
        );
        if (box.y >= 0 && box.y + box.height <= 844) return true;
        const deltaY = Math.max(-650, Math.min(650, box.y + box.height / 2 - 422));
        scrolled = true;
        actions.push({ action: `Scroll ${deltaY}px toward ${href}`, at: new Date().toISOString() });
        await send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: 195,
          y: 422,
          deltaX: 0,
          deltaY,
        });
        return false;
      });
      // Navigation already captured this viewport. Capture again only after user scrolling.
      if (scrolled) await capture(`${name}-before-click`);
      const point = await livePage.evaluate<{ x: number; y: number }>(
        `(() => { const box = ${element}.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`,
      );
      const target = await livePage.evaluate<{ label: string; region: string; hit: boolean }>(
        `(() => { const el = ${element}; const hit = document.elementFromPoint(${point.x}, ${point.y}); return { label: el.textContent.trim(), region: el.closest('footer') ? 'footer' : el.closest('nav') ? 'navigation' : 'content', hit: hit === el || el.contains(hit) }; })()`,
      );
      if (!target.hit) throw new Error(`Pointer target obscured for ${href}`);
      observed[`${name}-before-click`] = { ...target, ...point, capture: lastCapture };
      actions.push({ action: `Click visible ${href}`, at: new Date().toISOString() });
      for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
      await wait(() =>
        livePage.evaluate<boolean>(
          `(location.pathname === ${JSON.stringify(href)} || location.pathname === ${JSON.stringify(href + "/")}) && document.readyState === 'complete' && document.querySelector('h1')?.textContent.includes(${JSON.stringify(expected)})`,
        ),
      );
      const response = await fetch(origin + href);
      if (response.status !== 200) throw new Error(`${href} answered ${response.status}`);
      const route = await livePage.evaluate<{
        path: string;
        title: string;
        heading: string;
        canonical: string;
        width: number;
        height: number;
        contentWidth: number;
      }>(
        "({ path: location.pathname, title: document.title, heading: document.querySelector('h1')?.textContent, canonical: document.querySelector('link[rel=canonical]')?.href, width: innerWidth, height: innerHeight, contentWidth: document.documentElement.scrollWidth })",
      );
      if (route.width !== 390 || route.height !== 844 || route.contentWidth > 391)
        throw new Error(`Route does not fit the 390px viewport: ${JSON.stringify(route)}`);
      observed[name] = { ...route, status: response.status };
      await capture(name);
      await doctor();
    };
    await visit("/faq", "Questions", "faq");
    await visit("/docs/downloads", "Downloads", "downloads-guide");
    await visit("/docs", "Guides", "guides");
    await visit("/docs/subscriptions", "Subscriptions", "subscriptions-guide");
    await visit("/download", "Download", "downloads");
    const downloads = await livePage.evaluate<{
      version: string;
      installers: { kind: string; href: string }[];
      store: string[];
    }>(
      "({ version: document.querySelector('[data-release-selected]')?.dataset.releaseSelected ?? '', installers: [...document.querySelectorAll('a[data-installer]')].map(a => ({ kind: a.dataset.installer, href: a.href })), store: [...document.querySelectorAll('a[href]')].filter(a => a.textContent.trim() === 'Microsoft Store').map(a => a.href) })",
    );
    const release = "https://github.com/Mr-Streamer-OSS/MrStreamer/releases";
    const targets = {
      dmg: "mac-arm64.dmg",
      exe: "win-x64-setup.exe",
      appImage: "linux-x86_64.AppImage",
      deb: "linux-amd64.deb",
    };
    if (downloads.version && !/^\d+\.\d+\.\d+$/.test(downloads.version))
      throw new Error("Download page names an invalid stable version.");
    for (const [kind, filename] of Object.entries(targets)) {
      const links = downloads.installers.filter((link) => link.kind === kind);
      const installer = `${release}/download/v${downloads.version}/Mr-Streamer-${downloads.version}-${filename}`;
      if (
        !links.length ||
        links.some(
          ({ href }) => href !== `${release}/latest` && (!downloads.version || href !== installer),
        )
      )
        throw new Error(`Missing or incorrect ${kind} installer target.`);
    }
    if (
      !downloads.store.length ||
      downloads.store.some(
        (href) => href !== "https://apps.microsoft.com/detail/9N45GG76ZP4T?referrer=appbadge",
      )
    )
      throw new Error("Missing or incorrect Microsoft Store target.");
    observed["downloadTargets"] = downloads;
    await visit("/releases", "Releases", "releases");
    await visit("/privacy", "Privacy", "privacy");
    await send("Emulation.setScriptExecutionDisabled", { value: true });
    pageScriptsDisabled = true;
    await send("Page.navigate", { url: origin + "/faq" });
    await wait(() =>
      livePage.evaluate<boolean>(
        "location.pathname === '/faq' && document.readyState === 'complete' && document.querySelectorAll('.faq-rows > div').length === 15",
      ),
    );
    actions.push({ action: "Read FAQ with page scripts disabled", at: new Date().toISOString() });
    observed["faqWithoutScripts"] = await livePage.evaluate(
      "({ title: document.title, groups: [...document.querySelectorAll('main h2')].map(h => h.textContent), rows: document.querySelectorAll('.faq-rows > div').length, width: innerWidth, contentWidth: document.documentElement.scrollWidth })",
    );
    await capture("faq-without-scripts");
    await doctor();
    await visit("/docs/downloads", "Downloads", "downloads-guide-without-scripts");
    const missing = await fetch(origin + "/verification-missing-page");
    observed["missingRouteStatus"] = missing.status;
    if (missing.status !== 404) throw new Error("Unknown route does not answer 404.");
    observed["blockedExternalRequests"] = logs.filter((line) =>
      line.includes("Blocked external request:"),
    );
  } catch (error) {
    failure = error;
    const screenshot = await page
      ?.send("Page.captureScreenshot", { format: "png" })
      .catch(() => undefined);
    if (record(screenshot?.result) && typeof screenshot.result["data"] === "string")
      await writeFile(
        join(evidence, "failure.png"),
        Buffer.from(screenshot.result["data"], "base64"),
      );
  } finally {
    const errors: string[] = [];
    for (const child of [browser, server]) {
      if (!child) continue;
      try {
        await stop(child, child === browser ? page : undefined);
      } catch (error) {
        errors.push(String(error));
      }
    }
    page?.close();
    const exited = (child: ChildProcess | undefined) =>
      !child || child.exitCode !== null || child.signalCode !== null;
    if (exited(browser) && exited(server))
      await rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch((error) =>
        errors.push(String(error)),
      );
    if (errors.length) failure ??= new Error(errors.join("\n"));
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await writeFile(join(evidence, "session.log"), logs.join(""));
    await writeFile(
      join(evidence, "proof.json"),
      JSON.stringify(
        {
          status: failure ? "failed" : "passed",
          actions,
          observed,
          error: failure ? String(failure) : null,
          cleanup: {
            browserExited: exited(browser),
            serverExited: exited(server),
            scratchRemoved: await access(scratch).then(
              () => false,
              () => true,
            ),
            errors,
          },
          limits: [
            "Local built website, no production deployment check",
            "External browser requests blocked; feed refresh not proved",
            "Installer URLs inspected, no installer downloaded",
            "390px viewport is not a physical mobile device or Safari proof",
            "Fallback browser does not establish GPU performance",
          ],
        },
        null,
        2,
      ),
    );
    console.log(`${failure ? "FAIL" : "PASS"} website: ${evidence}`);
    await access(join(evidence, "proof.json"));
  }
  if (failure) throw failure;
}
