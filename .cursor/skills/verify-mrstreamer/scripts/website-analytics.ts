#!/usr/bin/env -S node
// Website analytics in a production-configured build, against an isolated loopback capture.
// The browser reaches eu.i.posthog.com only through a loopback proxy that hands it to a local TLS
// fixture with a certificate this run made; every other external request is blocked. Nothing
// reaches PostHog. Build first with the EU host and a verification key, as --help says.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { connect, type Page } from "../../../../apps/desktop/test/e2e/app.ts";
import { electronExecutable, freePort, record, stop } from "./session.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const marketing = join(root, "apps/marketing");
const ENDPOINT = "https://eu.i.posthog.com/i/v0/e/";
const CHOICE = "mrstreamer.site-analytics";
const PRIVATE = ["private-query", "private-fragment", "campaign"];
const SITE = "https://mrstreamer.app";
/** posthog-js's cookieless placeholder distinct id. */
const COOKIELESS = "$posthog_cookieless";
/** The long guide whose measurements the run causes and checks. */
const MEASURED = "/docs/movies-and-series";

if (process.argv.includes("--help")) {
  console.log(
    "Usage: MR_STREAMER_SITE_ANALYTICS_RELEASE_BUILD=1 MR_STREAMER_SITE_ANALYTICS_HOST=https://eu.i.posthog.com MR_STREAMER_SITE_ANALYTICS_PROJECT_TOKEN=phc_mrstreamer_verification pnpm build:marketing, then xvfb-run -a node .cursor/skills/verify-mrstreamer/scripts/website-analytics.ts. Proof stays in .local/verification/website-analytics-<unique>/.",
  );
} else {
  await run();
}

interface Capture {
  readonly at: string;
  readonly method: string;
  readonly path: string;
  readonly host: string;
  readonly origin: string | null;
  readonly referer: string | null;
  readonly cookie: boolean;
  readonly userAgent: string | null;
  readonly contentType: string | null;
  readonly raw: string;
  answered: boolean;
  aborted: boolean;
}

async function run() {
  const executable = await electronExecutable();
  if (process.platform === "linux" && !process.env["DISPLAY"])
    throw new Error("No display. Use xvfb-run -a.");
  const assets = join(marketing, "dist/assets");
  const scripts = await Promise.all(
    (await readdir(assets))
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFile(join(assets, name), "utf8")),
  );
  const bundle = scripts.find((text) => text.includes(ENDPOINT));
  if (!bundle) throw new Error("dist has no production-configured website analytics. See --help.");
  const key = /"(phc_[A-Za-z0-9_-]+)"/.exec(bundle)?.[1] ?? "";
  await mkdir(join(root, ".local/verification"), { recursive: true });
  const evidence = await mkdtemp(join(root, ".local/verification/website-analytics-"));
  const scratch = await mkdtemp(join(tmpdir(), "mrstreamer-website-analytics-"));
  const profile = join(scratch, "profile");
  const logs: string[] = [];
  const actions: { action: string; at: string }[] = [];
  const observed: Record<string, unknown> = {
    bundleSha256: createHash("sha256").update(bundle).digest("hex"),
    endpointInBundle: ENDPOINT,
    // The key itself is never written to evidence.
    verificationKey: key === "phc_mrstreamer_verification",
  };
  const captures: Capture[] = [];
  const refusedTunnels: string[] = [];
  let hold = false;
  const servers: Server[] = [];
  let server: ChildProcess | undefined;
  let browser: ChildProcess | undefined;
  let page: Page | undefined;
  let failure: unknown;
  const act = (action: string) => actions.push({ action, at: new Date().toISOString() });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        name !== "ELECTRON_RUN_AS_NODE" &&
        name !== "GH_TOKEN" &&
        name !== "GITHUB_TOKEN" &&
        !name.startsWith("MR_STREAMER_SITE_ANALYTICS_"),
    ),
  );
  const launch = (
    binary: string,
    args: string[],
    cwd: string,
    extra: Record<string, string> = {},
  ) => {
    const child = spawn(binary, args, {
      cwd,
      env: { ...env, ...extra },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", (error) => logs.push(String(error)));
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
    return child;
  };
  const wait = async (check: () => Promise<boolean> | boolean, what: string, tries = 100) => {
    for (let attempt = 0; attempt < tries; attempt++) {
      if (await Promise.resolve(check()).catch(() => false)) return;
      await delay(100);
    }
    throw new Error(`Timed out: ${what}`);
  };
  try {
    // A certificate for eu.i.posthog.com that only this run's browser trusts.
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        join(scratch, "key.pem"),
        "-out",
        join(scratch, "cert.pem"),
        "-subj",
        "/CN=eu.i.posthog.com",
        "-addext",
        "subjectAltName=DNS:eu.i.posthog.com",
      ],
      { stdio: "ignore" },
    );
    const cert = await readFile(join(scratch, "cert.pem"), "utf8");
    const capture = createHttpsServer(
      { key: await readFile(join(scratch, "key.pem")), cert },
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const entry: Capture = {
            at: new Date().toISOString(),
            method: req.method ?? "",
            path: req.url ?? "",
            host: req.headers.host ?? "",
            origin: req.headers.origin ?? null,
            referer: req.headers.referer ?? null,
            cookie: req.headers.cookie !== undefined,
            userAgent: req.headers["user-agent"] ?? null,
            contentType: req.headers["content-type"] ?? null,
            raw: Buffer.concat(chunks).toString("utf8"),
            answered: false,
            aborted: false,
          };
          captures.push(entry);
          res.on("close", () => {
            if (!entry.answered) entry.aborted = true;
          });
          const answer = () => {
            if (res.destroyed) return;
            entry.answered = true;
            res.writeHead(200, {
              "Access-Control-Allow-Origin": req.headers.origin ?? "*",
              "Content-Type": "application/json",
            });
            res.end('{"status":"Ok"}');
          };
          if (!hold) answer();
        });
      },
    );
    const proxy = createHttpServer((_req, res) => res.writeHead(403).end());
    proxy.on("connect", (req, socket, head) => {
      if (req.url !== "eu.i.posthog.com:443") {
        refusedTunnels.push(req.url ?? "");
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) socket.unshift(head);
      capture.emit("connection", socket);
    });
    servers.push(capture, proxy);
    const proxyPort = await freePort();
    await new Promise<void>((resolve) => proxy.listen(proxyPort, "127.0.0.1", resolve));

    const serverPort = await freePort();
    const origin = `http://127.0.0.1:${serverPort}`;
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
    await wait(
      async () => (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok,
      "preview",
    );
    const shell = join(scratch, "browser.cjs");
    await writeFile(
      shell,
      `const { app, BrowserWindow, session } = require('electron');
const cert = ${JSON.stringify(cert.replace(/\s/g, ""))};
const origin = ${JSON.stringify(origin)};
app.whenReady().then(async () => {
  const own = session.defaultSession;
  // https goes only through the loopback proxy, which answers eu.i.posthog.com and refuses the rest.
  await own.setProxy({ proxyRules: 'https=127.0.0.1:${proxyPort}' });
  own.setCertificateVerifyProc((request, callback) => {
    callback(request.hostname === 'eu.i.posthog.com' && request.certificate.data.replace(/\\s/g, '') === cert ? 0 : -2);
  });
  own.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(origin + '/') || details.url === ${JSON.stringify(ENDPOINT)} || /^(data|blob|devtools):/.test(details.url);
    if (!allowed) console.log('Blocked external request: ' + new URL(details.url).origin);
    callback({ cancel: !allowed });
  });
  const window = new BrowserWindow({ width: 1280, height: 900, backgroundColor: '#000', webPreferences: { nodeIntegration: false, contextIsolation: true } });
  // Outside links stay unfollowed, so their click is observed without leaving the page.
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(origin + '/')) return;
    event.preventDefault();
    console.log('Kept page on outside link: ' + new URL(url).origin);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.loadURL(origin + process.env.VERIFY_START);
});
app.on('window-all-closed', () => app.quit());
`,
    );
    const browserPort = await freePort();
    const open = async (start: string) => {
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
        { VERIFY_START: start },
      );
      page = await connect(browserPort);
      const live = page;
      await wait(
        () =>
          live.evaluate<boolean>(
            `location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete'`,
          ),
        "page load",
      );
      await send("Page.enable");
      const identity = await send("Browser.getBrowserCommandLine");
      const args = record(identity) ? identity["arguments"] : undefined;
      if (
        !Array.isArray(args) ||
        ![shell, `--user-data-dir=${profile}`, `--remote-debugging-port=${browserPort}`].every(
          (arg) => args.includes(arg),
        )
      )
        throw new Error("CDP belongs to another browser.");
    };
    const live = () => {
      if (!page) throw new Error("No page.");
      return page;
    };
    const send = async (method: string, params: Record<string, unknown> = {}) => {
      const reply = await live().send(method, params);
      if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
      return reply.result;
    };
    const evaluate = <T>(expression: string) => live().evaluate<T>(expression);
    const shot = async (name: string) => {
      await evaluate(
        "document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))",
      );
      await delay(400);
      const image = await send("Page.captureScreenshot", { format: "png" });
      if (!record(image) || typeof image["data"] !== "string") throw new Error("No screenshot.");
      await writeFile(join(evidence, `${name}.png`), Buffer.from(image["data"], "base64"));
    };
    const switchText = (place: string) =>
      evaluate<string>(
        `(() => { const c = document.querySelector('[data-site-analytics="${place}"]').cloneNode(true); c.querySelectorAll('[hidden]').forEach(e => e.remove()); return c.textContent.replace(/\\s+/g, ' ').trim(); })()`,
      );
    /** Scrolls an element into view, then presses it with the pointer where it is drawn. */
    const click = async (selector: string) => {
      const point = await evaluate<{ x: number; y: number; hit: boolean } | null>(
        `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.getClientRects().length && getComputedStyle(e).display !== 'none' && !e.hidden); if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); const x = b.x + b.width / 2, y = b.y + b.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, hit: hit === el || el.contains(hit) }; })()`,
      );
      if (!point?.hit) throw new Error(`No visible pointer target: ${selector}`);
      act(`Click ${selector}`);
      // Records which element the page saw clicked, to prove the pointer reached it.
      await evaluate(
        "window.verifyClicked = ''; document.addEventListener('click', e => { window.verifyClicked = e.target.closest('a, button')?.textContent.trim() ?? '?'; }, { capture: true, once: true })",
      );
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
      for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", {
          type,
          x: point.x,
          y: point.y,
          button: "left",
          clickCount: 1,
        });
      const clicked = await evaluate<string>(
        "typeof window.verifyClicked === 'string' ? window.verifyClicked : 'a link to a new page'",
      ).catch(() => "navigated");
      if (!clicked) throw new Error(`The page saw no click on ${selector}`);
      act(`Page saw a click on "${clicked}"`);
    };
    /** Scrolls an element into the middle of the view without pressing it. */
    const reveal = (selector: string) =>
      evaluate(
        `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`,
      );
    const scrollToEnd = async () => {
      act("Scroll with the mouse wheel to the foot of the page");
      for (let step = 0; step < 60; step++) {
        const end = await evaluate<boolean>(
          "innerHeight + scrollY >= document.documentElement.scrollHeight - 2",
        );
        if (end) return;
        await send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: 400,
          y: 400,
          deltaX: 0,
          deltaY: 500,
        });
        await delay(120);
      }
    };
    const pageOf = (entry: Capture) =>
      String(
        (JSON.parse(entry.raw) as { properties: { $pathname?: unknown } }).properties.$pathname,
      );
    /** Nothing at all from `pathname` since `from`: its page was opened, or turned, off. */
    const silent = (from: number, pathname: string, what: string) => {
      const sent = captures.slice(from).filter((entry) => pageOf(entry) === pathname);
      if (sent.length) throw new Error(`${what}: ${sent.length} request(s) from ${pathname}.`);
    };
    const storage = () =>
      evaluate<Record<string, string>>("Object.fromEntries(Object.entries(localStorage))");
    /** Nothing new arrives, except the leave and vitals of a page that was already counting. */
    const quiet = async (from: number, what: string) => {
      await delay(1500);
      // The page holds no id, so a leave is matched to an earlier page view by its address.
      const earlier = new Set(captures.slice(0, from).map(pageOf));
      const unexpected = captures
        .slice(from)
        .filter(
          (entry) =>
            !(
              (entry.raw.includes('"$pageleave"') || entry.raw.includes('"$web_vitals"')) &&
              earlier.has(pageOf(entry))
            ),
        );
      if (unexpected.length)
        throw new Error(`${what}: ${unexpected.length} unexpected request(s).`);
    };
    const narrow = () =>
      send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
    const wide = () => send("Emulation.clearDeviceMetricsOverride");
    const fits = async (name: string) => {
      const size = await evaluate<{ width: number; content: number }>(
        "({ width: innerWidth, content: document.documentElement.scrollWidth })",
      );
      if (size.content > size.width + 1) throw new Error(`${name} overflows at ${size.width}px.`);
      return size;
    };

    // 1. A fresh profile, opened on an address with a private query and fragment.
    act("Open Home with a query and fragment in a fresh profile");
    await open("/?campaign=private-query#private-fragment");
    await wait(() => captures.length >= 1, "page view");
    observed["freshFooter"] = await switchText("footer");
    if (observed["freshFooter"] !== "Site analytics: on. Turn off What's counted")
      throw new Error(`Fresh footer: ${String(observed["freshFooter"])}`);
    observed["freshStorage"] = await storage();
    // web-vitals reports no LCP for a page that loaded while hidden.
    observed["homeOpenedHidden"] = await evaluate<boolean>(
      "performance.getEntriesByType('visibility-state').some(e => e.name === 'hidden')",
    );
    if (Object.keys(observed["freshStorage"] as object).length)
      throw new Error("Fresh visit stored something.");
    const os = await evaluate<string>("document.documentElement.dataset.os ?? 'any'");
    observed["detectedSystem"] = os;
    await click(".hero .cta");
    await wait(() => captures.some((c) => c.raw.includes('"download_clicked"')), "download click");
    await scrollToEnd();
    await wait(
      () => captures.filter((c) => c.raw.includes('"feature_section_viewed"')).length >= 6,
      "home sections",
      50,
    );
    await shot("home-footer-on-1280");
    await click('footer a[href="https://github.com/Mr-Streamer-OSS/MrStreamer"]');
    await wait(() => captures.some((c) => c.raw.includes('"github_link_clicked"')), "GitHub click");
    await narrow();
    await delay(200);
    observed["homeNarrow"] = await fits("Home");
    await scrollToEnd();
    await shot("home-footer-on-390");
    const geometry =
      "({ scrollY, innerHeight, clientHeight: document.documentElement.clientHeight, scrollHeight: document.documentElement.scrollHeight })";
    observed["homeGeometry390"] = await evaluate(geometry);

    await wide();
    await delay(300);
    observed["homeGeometry1280"] = await evaluate(geometry);

    // 1b. Real measurements on a long guide: a slow interaction, a layout shift and part of the
    // page scrolled. The helper adds the slow handler and the shifting block; the browser and
    // web-vitals measure them.
    act(`Open ${MEASURED} from the address bar`);
    await send("Page.navigate", { url: `${origin}${MEASURED}` });
    await wait(() => captures.some((c) => pageOf(c) === MEASURED), "guide view");
    await delay(1000);
    await evaluate(
      "addEventListener('pointerdown', () => { const end = performance.now() + 200; while (performance.now() < end); }, { capture: true })",
    );
    await click("main h1");
    await delay(800);
    act("Insert a 240px block at the top of the page, more than 500ms after any input");
    await evaluate(
      "(() => { const block = document.createElement('div'); block.style.height = '240px'; document.querySelector('main').prepend(block); })()",
    );
    await delay(300);
    act("Scroll down twice with the mouse wheel");
    for (let wheel = 0; wheel < 2; wheel++) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 400,
        y: 400,
        deltaX: 0,
        deltaY: 400,
      });
      await delay(300);
    }
    // The shares the page should send, from the same geometry posthog-js reads.
    observed["measuredDepthExpected"] = await evaluate<{ scroll: number; content: number }>(
      "(() => { const r = document.documentElement, y = Math.ceil(scrollY); return { scroll: Math.round(y / Math.ceil(r.scrollHeight - r.clientHeight) * 100) / 100, content: Math.round(Math.ceil(scrollY + r.clientHeight) / Math.ceil(r.scrollHeight) * 100) / 100 }; })()",
    );
    await shot("guide-scrolled-1280");
    act("Open /about from the address bar");
    await send("Page.navigate", { url: `${origin}/about` });
    await wait(
      () => captures.some((c) => c.raw.includes('"$pageleave"') && pageOf(c) === MEASURED),
      "guide leave",
    );
    await delay(1000);

    // 2. Turning off while a guide's events are held in flight aborts them, and nothing follows.
    hold = true;
    const beforeHeld = captures.length;
    act("Open the Subscriptions guide from the address bar while capture answers nothing");
    await wide();
    await send("Page.navigate", { url: `${origin}/docs/subscriptions` });
    await wait(
      () => captures.slice(beforeHeld).some((c) => c.raw.includes('"guide_section_viewed"')),
      "held guide events",
    );
    await scrollToEnd();
    await shot("guide-footer-on-1280");
    // An earlier page's leave and vitals keep alive past turning off, so only the guide's count.
    const held = () =>
      captures
        .slice(beforeHeld)
        .filter((c) => pageOf(c) === "/docs/subscriptions" && !c.raw.includes('"$pageleave"'));
    const atOff = () => captures.length;
    await click('[data-site-analytics="footer"] button');
    const turnedOff = atOff();
    await wait(() => held().every((c) => c.aborted), "held requests aborted");
    hold = false;
    observed["heldThenAborted"] = held().map((c) => ({
      event: (JSON.parse(c.raw) as { event: string }).event,
      aborted: c.aborted,
    }));
    observed["offFooter"] = await switchText("footer");
    observed["offStorage"] = await storage();
    if ((observed["offStorage"] as Record<string, string>)[CHOICE] !== "off")
      throw new Error("Off was not stored.");
    await narrow();
    await scrollToEnd();
    await shot("guide-footer-off-390");
    const afterOffClicks = captures.length;
    await click('footer a[href="https://github.com/Mr-Streamer-OSS/MrStreamer"]');
    await quiet(afterOffClicks, "GitHub click after turning off");
    const afterOff = captures.length;
    await click('footer a[href="/faq"]');
    await wait(
      () => evaluate<boolean>("location.pathname === '/faq' && document.readyState === 'complete'"),
      "FAQ",
    );
    await quiet(afterOff, "After turning off and leaving the guide");
    // Its leave, scroll depth and vitals stay unsent too.
    silent(turnedOff, "/docs/subscriptions", "Guide after turning off");

    // 3. A restarted browser keeps the stored off.
    act("Restart the browser on the same profile");
    if (browser) await stop(browser, page);
    page?.close();
    await open("/");
    await quiet(afterOff, "After restart with off stored");
    observed["restartFooter"] = await switchText("footer");
    if (observed["restartFooter"] !== "Site analytics: off. Turn on What's counted")
      throw new Error(`Restart footer: ${String(observed["restartFooter"])}`);

    // 4. Turning on sends nothing about the open page. The next page counts.
    await scrollToEnd();
    await click('[data-site-analytics="footer"] button');
    await quiet(afterOff, "After turning on");
    observed["onAgainStorage"] = await storage();
    await shot("home-footer-turned-on-1280");
    act("Open /faq#free from the address bar");
    await send("Page.navigate", { url: `${origin}/faq#free` });
    await wait(() => captures.some((c) => c.raw.includes('"faq_question":"free"')), "FAQ anchor");
    // Home opened off: turning on there sent nothing, at its leave either.
    silent(afterOff, "/", "Home opened off");
    await click('footer a[href="/privacy"]');
    await wait(
      () =>
        evaluate<boolean>("location.pathname === '/privacy' && document.readyState === 'complete'"),
      "privacy",
    );
    await wait(() => captures.some((c) => c.raw.includes('"route":"/faq","visible"')), "FAQ leave");
    observed["policySwitch"] = await switchText("policy");
    if (observed["policySwitch"] !== "Website analytics are on in this browser. Turn off")
      throw new Error(`Policy switch: ${String(observed["policySwitch"])}`);
    await narrow();
    await reveal('[data-site-analytics="policy"]');
    observed["policyNarrow"] = await fits("Privacy");
    await shot("privacy-switch-390");
    await wide();
    await reveal('[data-site-analytics="policy"]');
    await shot("privacy-switch-1280");

    // 5. A guide link is counted by guide and place, and an unanswered request ends at its deadline.
    await click('header a[href="/docs"]');
    await wait(
      () =>
        evaluate<boolean>("location.pathname === '/docs' && document.readyState === 'complete'"),
      "Guides",
    );
    await wait(
      () =>
        captures.some((c) =>
          c.raw.includes('"doc_section":"index","route":"/privacy","location":"header"'),
        ),
      "Guides click",
    );
    hold = true;
    const beforeDeadline = captures.length;
    act("Open the Live TV guide while capture answers nothing, and wait past the deadline");
    await click('a[href="/docs/live-tv"]');
    await wait(
      () => captures.slice(beforeDeadline).some((c) => c.raw.includes('"route":"/docs/live-tv"')),
      "held guide view",
    );
    const opened = Date.now();
    const timed = () =>
      captures
        .slice(beforeDeadline)
        .filter((c) => pageOf(c) === "/docs/live-tv" && !c.raw.includes('"$pageleave"'));
    await wait(() => timed().every((c) => c.aborted), "requests past their deadline", 130);
    hold = false;
    observed["deadline"] = {
      requests: timed().length,
      allAborted: timed().every((c) => c.aborted),
      waitedMs: Date.now() - opened,
    };
    if ((observed["deadline"] as { waitedMs: number }).waitedMs < 8_000)
      throw new Error("Held requests ended before their deadline.");

    // 6. Release notes count each release seen, and an unknown address counts as /404 alone.
    act("Open /releases from the address bar and scroll to its end");
    await send("Page.navigate", { url: `${origin}/releases` });
    await wait(() => captures.some((c) => c.raw.includes('"$pathname":"/releases"')), "releases");
    await scrollToEnd();
    await wait(() => captures.some((c) => c.raw.includes('"changelog_viewed"')), "release seen");
    act("Open an unknown address with a private query and fragment");
    await send("Page.navigate", {
      url: `${origin}/private-route?campaign=private-query#private-fragment`,
    });
    await wait(
      () => captures.some((c) => c.raw.includes('"$pageview"') && c.raw.includes('"/404"')),
      "404 view",
    );
    observed["unknownAddressStatus"] = await evaluate<number>(
      "performance.getEntriesByType('navigation')[0]?.responseStatus ?? 0",
    );

    // 7. GPC, Do Not Track and failing storage keep a stored on from sending.
    const refusals = {
      gpc: "Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true });",
      dnt: "Object.defineProperty(Navigator.prototype, 'doNotTrack', { get: () => '1' });",
      storage:
        "Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });",
    };
    const refusing = captures.length;
    for (const [name, script] of Object.entries(refusals)) {
      const added = await send("Page.addScriptToEvaluateOnNewDocument", { source: script });
      const before = captures.length;
      act(`Open Home with ${name} refusal`);
      await send("Page.navigate", { url: `${origin}/` });
      await wait(
        () =>
          evaluate<boolean>(
            "document.readyState === 'complete' && !!document.querySelector('[data-site-analytics] button')",
          ),
        name,
      );
      await quiet(before, name);
      observed[`${name}Footer`] = await switchText("footer");
      observed[`${name}Emulated`] = await evaluate(
        "({ gpc: navigator.globalPrivacyControl ?? null, dnt: navigator.doNotTrack ?? null, storage: (() => { try { localStorage.length; return 'readable'; } catch { return 'blocked'; } })() })",
      );
      await scrollToEnd();
      await shot(`home-footer-${name}-1280`);
      if (record(added))
        await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: added["identifier"] });
    }
    act("Open /about to leave the last refused page");
    await send("Page.navigate", { url: `${origin}/about` });
    await delay(1500);
    silent(refusing, "/", "Refused pages");
    if (
      !String(observed["gpcFooter"]).includes("asks sites not to track") ||
      !String(observed["dntFooter"]).includes("asks sites not to track")
    )
      throw new Error("GPC or DNT footer is wrong.");
    if (observed["storageFooter"] !== "Site analytics: off. What's counted")
      throw new Error("Storage footer is wrong.");

    // 8. Every request against the allowlist.
    const browserUserAgent = await evaluate<string>("navigator.userAgent");
    const allowed: Record<string, readonly string[]> = {
      $pageview: ["route"],
      $pageleave: [
        "route",
        "visible",
        "$prev_pageview_pathname",
        "$prev_pageview_max_scroll_percentage",
        "$prev_pageview_max_content_percentage",
      ],
      $web_vitals: ["$web_vitals_LCP_value", "$web_vitals_INP_value", "$web_vitals_CLS_value"],
      download_clicked: ["download_type", "os_hint", "kind", "route", "location"],
      github_link_clicked: ["route", "link_location"],
      docs_link_clicked: ["doc_section", "route", "location"],
      feature_section_viewed: ["feature_name"],
      guide_section_viewed: ["guide", "section"],
      faq_question_viewed: ["faq_question", "via"],
      changelog_viewed: ["version"],
    };
    const events = captures.map((entry) => {
      if (entry.method !== "POST" || entry.path !== "/i/v0/e/" || entry.host !== "eu.i.posthog.com")
        throw new Error(`Unexpected request ${entry.method} ${entry.host}${entry.path}`);
      if (entry.referer || entry.cookie) throw new Error("A request carried a Referer or cookie.");
      if (PRIVATE.some((word) => entry.raw.includes(word)))
        throw new Error("A private query or fragment leaked.");
      const body: unknown = JSON.parse(entry.raw);
      if (!record(body) || !record(body["properties"])) throw new Error("Malformed body.");
      const { api_key, event, distinct_id, properties, ...rest } = body;
      if (
        Object.keys(rest).length ||
        api_key !== key ||
        typeof event !== "string" ||
        distinct_id !== COOKIELESS
      )
        throw new Error(`Body outside the allowlist: ${Object.keys(body).join(",")}`);
      const {
        source,
        $process_person_profile,
        $geoip_disable,
        $cookieless_mode,
        $raw_user_agent,
        $current_url,
        $pathname,
        $host,
        ...fields
      } = properties;
      if (
        source !== "website" ||
        $process_person_profile !== false ||
        $geoip_disable !== true ||
        $cookieless_mode !== true
      )
        throw new Error("Fixed properties missing.");
      // The user agent is the one the request's own header already carries, and nothing more.
      if ($raw_user_agent !== browserUserAgent || $raw_user_agent !== entry.userAgent)
        throw new Error("$raw_user_agent differs from the browser's User-Agent header.");
      if (
        typeof $pathname !== "string" ||
        !/^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/.test($pathname) ||
        $current_url !== `${SITE}${$pathname}` ||
        $host !== "mrstreamer.app" ||
        (fields["route"] !== undefined && fields["route"] !== $pathname)
      )
        throw new Error(`Address outside the site's fixed routes: ${String($current_url)}`);
      const names = allowed[event];
      if (!names || Object.keys(fields).some((name) => !names.includes(name)))
        throw new Error(
          `Property outside the allowlist on ${event}: ${Object.keys(fields).join(",")}`,
        );
      // Measurements are bounded numbers in their units, and each leave carries all three.
      const share = (value: unknown) =>
        typeof value === "number" &&
        value >= 0 &&
        value <= 1 &&
        Math.round(value * 100) / 100 === value;
      if (
        event === "$pageleave" &&
        (fields["$prev_pageview_pathname"] !== $pathname ||
          !share(fields["$prev_pageview_max_scroll_percentage"]) ||
          !share(fields["$prev_pageview_max_content_percentage"]))
      )
        throw new Error(`Scroll depth malformed: ${JSON.stringify(fields)}`);
      if (event === "$web_vitals") {
        const vitals = Object.entries(fields);
        const [name, value] = vitals[0] ?? [];
        const whole = name === "$web_vitals_CLS_value" ? 1000 : 1;
        if (
          vitals.length !== 1 ||
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          value < 0 ||
          value >= 15 * 60_000 ||
          Math.round(value * whole) / whole !== value
        )
          throw new Error(`Vital malformed: ${JSON.stringify(fields)}`);
      }
      return {
        event,
        pathname: $pathname,
        properties: fields,
        contentType: entry.contentType,
        origin: entry.origin,
        referer: entry.referer,
        aborted: entry.aborted,
      };
    });
    observed["events"] = events;
    // The measurements PostHog's health checks look for, with values the run caused.
    const leaveOf = (pathname: string) =>
      events.find((e) => e.event === "$pageleave" && e.pathname === pathname)?.properties;
    const vitalOf = (pathname: string, name: string) =>
      events
        .filter((e) => e.event === "$web_vitals" && e.pathname === pathname)
        .map((e) => e.properties[`$web_vitals_${name}_value`])
        .filter((value) => typeof value === "number");
    const expected = observed["measuredDepthExpected"] as { scroll: number; content: number };
    observed["measurements"] = {
      homeLeave: leaveOf("/"),
      measuredLeave: leaveOf(MEASURED),
      releasesLeave: leaveOf("/releases"),
      LCP: Object.fromEntries(
        [...new Set(events.map((e) => e.pathname))].map((path) => [path, vitalOf(path, "LCP")]),
      ),
      measuredCLS: vitalOf(MEASURED, "CLS"),
      measuredINP: vitalOf(MEASURED, "INP"),
    };
    const measured = leaveOf(MEASURED);
    const releases = leaveOf("/releases");
    if (
      releases?.["$prev_pageview_max_scroll_percentage"] !== 1 ||
      releases["$prev_pageview_max_content_percentage"] !== 1
    )
      throw new Error("Release notes were scrolled to their foot but their leave says otherwise.");
    if (
      measured?.["$prev_pageview_max_scroll_percentage"] !== expected.scroll ||
      measured["$prev_pageview_max_content_percentage"] !== expected.content ||
      expected.scroll <= 0 ||
      expected.scroll >= 1
    )
      throw new Error(`Guide scroll depth differs from ${JSON.stringify(expected)}.`);
    if (!vitalOf(MEASURED, "LCP").length) throw new Error("No LCP after the first click.");
    if (!vitalOf(MEASURED, "CLS").some((value) => Number(value) > 0))
      throw new Error("The induced layout shift was not measured.");
    if (!vitalOf(MEASURED, "INP").some((value) => Number(value) >= 150))
      throw new Error("The slow interaction was not measured.");
    observed["cookielessBodies"] = events.length;
    observed["rawUserAgentEqualsHeaderOnEvery"] = true;
    observed["preflights"] = captures.filter((entry) => entry.method === "OPTIONS").length;
    observed["refusedTunnels"] = refusedTunnels;
    observed["blockedExternalRequests"] = [
      ...new Set(logs.join("").match(/Blocked external request: \S+/g) ?? []),
    ];
    observed["keptOnOutsideLinks"] = [
      ...new Set(logs.join("").match(/Kept page on outside link: \S+/g) ?? []),
    ];
  } catch (error) {
    failure = error;
    const image = await page
      ?.send("Page.captureScreenshot", { format: "png" })
      .catch(() => undefined);
    if (record(image?.result) && typeof image.result["data"] === "string")
      await writeFile(join(evidence, "failure.png"), Buffer.from(image.result["data"], "base64"));
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
    for (const owned of servers) owned.close();
    const exited = (child: ChildProcess | undefined) =>
      !child || child.exitCode !== null || child.signalCode !== null;
    if (exited(browser) && exited(server))
      await rm(scratch, { recursive: true, force: true, maxRetries: 5 }).catch((error) =>
        errors.push(String(error)),
      );
    if (errors.length) failure ??= new Error(errors.join("\n"));
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
            "Production-configured local build; eu.i.posthog.com answered by a loopback fixture, never PostHog",
            "PostHog ingestion, dashboards and the project's IP setting not observed",
            "GPC, Do Not Track and blocked storage emulated by page scripts in Electron's Chromium",
            "390px viewport is not a physical phone or Safari",
            "The guide's layout shift and slow interaction are caused by helper scripts; Electron's Chromium and web-vitals measure them. Other browsers' vital support is not observed",
          ],
        },
        null,
        2,
      ),
    );
    console.log(`${failure ? "FAIL" : "PASS"} website analytics: ${evidence}`);
  }
  if (failure) throw failure;
}
