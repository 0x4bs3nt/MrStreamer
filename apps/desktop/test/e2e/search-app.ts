// Built-app search acceptance. Linux: xvfb-run -a node apps/desktop/test/e2e/search-app.ts
// --output .local/search-app/run-N. Uses only disposable profiles and fake external services.
// Inspector pauses add an interruptible delay before the actual registered guide work runs.
// This is functional race evidence, not a search latency or rendering benchmark.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  electronExecutable,
  freePort,
  stop,
} from "../../../../.cursor/skills/verify-mrstreamer/scripts/session.ts";
import { startFakeProvider } from "../fake-provider.ts";
import { startFakeTmdb } from "../fake-tmdb.ts";
import { addSubscription, connect, key, MODIFIERS, waitFor, type Page } from "./app.ts";

const { values } = parseArgs({ options: { output: { type: "string" } } });
assert(values.output, "Required: --output NEW_DIRECTORY");
const output = resolve(values.output);
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
const desktop = resolve("apps/desktop");
const bundle = await readFile(join(desktop, "out/main/index.js"), "utf8");
const profile = await mkdtemp(join(tmpdir(), "mrstreamer-search-"));
const events: unknown[] = [];
const cases: { name: string; status: string; error?: string }[] = [];
const logs: string[] = [];
const inspectorErrors: unknown[] = [];
const guideDelayMs = 4500;
let app: ChildProcess | undefined;
let page: Page | undefined;
let inspector: Page | undefined;
let failure = false;
const providers: Awaited<ReturnType<typeof startFakeProvider>>[] = [];
let tmdb: Awaited<ReturnType<typeof startFakeTmdb>> | undefined;
const proof: Record<string, unknown> = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  mainSha256: createHash("sha256").update(bundle).digest("hex"),
  harnessSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  profile,
  guideDelayMs,
  limitations: [
    "Linux Xvfb, software drawing, fake provider/TMDB, source build. No native Mac/Windows, real subscription, installed-package or audible-output acceptance.",
    "Debugger pauses and DOM observations add overhead. A 4500 ms interruptible Effect delay is inserted before real guide work. No fabricated successful response, renderer state write, product DOM setter, database seed or shared helper edit.",
    "Input uses CDP pointer, keyboard and insertText. Insertion represents paste or text entry; operating-system clipboard integration is not covered. No latency percentile claim.",
    "The raw-input guard also receives same-turn DOM keydown/click events after trusted CDP input. These exercise the real UI handlers without a renderer state or DOM value setter.",
  ],
};

const live = () => {
  assert(page);
  return page;
};
async function send(method: string, params: Record<string, unknown> = {}) {
  const reply = await live().send(method, params);
  assert(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
}
const exists = (expression: string) => live().evaluate<boolean>(`!!(${expression})`);
const button = (text: string, selector = "button") =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(text)} || b.getAttribute('aria-label') === ${JSON.stringify(text)})`;
const combo = `document.querySelector('[role="combobox"]')`;
const liveInput = `document.querySelector('input[aria-label^="Search "]:not([role="combobox"])')`;
const treeRows = `[...document.querySelectorAll('[role="treeitem"]')]`;
const liveRows = `[...document.querySelectorAll('[data-search-row]')]`;
async function click(expression: string) {
  await waitFor(() => exists(expression), 15000);
  await live().evaluate(`(${expression}).scrollIntoView({block:'nearest'})`);
  await pointer(await position(expression));
}
async function position(expression: string) {
  return live().evaluate<{ x: number; y: number }>(
    `(() => { const r=(${expression}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
  );
}
async function pointer(point: { x: number; y: number }, move = true) {
  for (const type of [...(move ? ["mouseMoved"] : []), "mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
}
async function type(expression: string, text: string) {
  await click(expression);
  await key(live(), "a", 65, MODIFIERS.main);
  await send("Input.insertText", { text });
}
async function capture(name: string) {
  await live().evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  const shot = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
  await writeFile(join(output, `${name}.png`), Buffer.from(shot.data, "base64"));
  await writeFile(
    join(output, `${name}.json`),
    JSON.stringify(
      {
        text: await live().evaluate<string>("document.body.innerText"),
        tree: await send("Accessibility.getFullAXTree"),
        state: await state(),
      },
      null,
      2,
    ),
  );
}
async function state() {
  return live().evaluate<{
    input: string | null;
    selected: string | null;
    selectedIndex: number;
    rows: string[];
    statuses: string[];
    inert: boolean;
  }>(`(() => {
    const input=${combo} ?? ${liveInput};
    const rows=${combo} ? ${treeRows} : ${liveRows};
    const selected=${combo} ? document.querySelector('[role="treeitem"][aria-selected="true"]') : document.querySelector('[data-search-row][tabindex="0"]');
    return {input:input?.value ?? null, selected:selected?.innerText ?? null,selectedIndex:rows.indexOf(selected),
      rows:rows.map(r=>r.innerText), statuses:[...document.querySelectorAll('[role="status"]')].map(r=>r.innerText),
      inert:rows.some(r=>r.closest('[inert]'))};
  })()`);
}
async function palette(query: string) {
  if (!(await exists(combo))) await key(live(), "k", 75, MODIFIERS.main);
  await type(combo, query);
  await waitFor(async () => {
    const current = await state();
    return current.input === query && current.rows.length > 0 && !current.inert;
  }, 15000);
}
async function closePalette() {
  if (await exists(combo)) await key(live(), "Escape", 27);
  await waitFor(async () => !(await exists(combo)), 10000);
}
async function check(name: string, run: () => Promise<void>) {
  console.log(`RUN ${name}`);
  events.push({ action: name, at: new Date().toISOString() });
  try {
    await run();
    cases.push({ name, status: "pass" });
    console.log(`PASS ${name}`);
  } catch (error) {
    failure = true;
    cases.push({ name, status: "fail", error: String(error) });
    console.error(`FAIL ${name}: ${String(error)}`);
    await capture(`failure-${cases.length}`).catch(() => undefined);
    throw error;
  }
}
async function guideTrace() {
  assert(inspector);
  return inspector.evaluate<
    {
      method: string;
      query: string;
      phase: string;
      view?: string;
      id?: string;
      success?: boolean;
    }[]
  >("globalThis.__searchProbe.events");
}
async function pending(method: string, query: string) {
  await waitFor(async () => {
    const trace = await guideTrace();
    const started = trace.filter(
      (e) => e.method === method && e.query === query && e.phase === "start",
    );
    return started.some(
      (s) => !trace.some((e) => e.phase === "end" && e.view === s.view && e.id === s.id),
    );
  }, 10000);
}
async function settled() {
  await waitFor(async () => !(await state()).statuses.some((s) => /Searching/.test(s)), 15000);
}
/** Same-turn UI events keep the inertness observation and attempted action before debounce. */
async function staleActions(input: string, rows: string) {
  return live().evaluate<{ input: string; rows: number; inert: boolean }>(`(() => {
    const input=${input}; const rows=${rows};
    const observed={input:input.value,rows:rows.length,inert:rows.some(r=>r.closest('[inert]'))};
    if(!observed.inert || !rows.length) throw Error('Missed old-row inert window');
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    const target=rows[0].querySelector('button') ?? rows[0]; target.click();
    return observed;
  })()`);
}
/** Read trusted event timestamps in the renderer so CDP reply overhead cannot decide the window. */
async function armPointerProbe(input: string, rows: string) {
  await live().evaluate(`(() => {
    const probe={}; globalThis.__rawPointerProbe=probe;
    (${input}).addEventListener('input',()=>{probe.inputAt=performance.now()},{once:true});
    const clicked=event=>{
      if(!event.isTrusted) return;
      probe.clickMs=performance.now()-probe.inputAt;
      probe.inert=${rows}.some(r=>r.closest('[inert]'));
      probe.target=event.target.tagName;
      document.removeEventListener('click',clicked,true);
    };
    document.addEventListener('click',clicked,true);
  })()`);
}
async function pointerProbe() {
  const observed = await live().evaluate<{ clickMs: number; inert: boolean; target: string }>(
    "globalThis.__rawPointerProbe",
  );
  assert(
    observed.clickMs < 120 && observed.inert,
    `Native stale click missed inert debounce window: ${JSON.stringify(observed)}`,
  );
  return observed;
}
async function watchFrom(providerIndex: number, before: readonly number[]) {
  await waitFor(() => live().evaluate<boolean>("!!document.querySelector('video')"), 15000);
  await waitFor(
    async () => providers[providerIndex]!.streamRequests() > before[providerIndex]!,
    15000,
  );
  assert.equal(providers[1 - providerIndex]!.streamRequests(), before[1 - providerIndex]);
  await waitFor(
    () =>
      live().evaluate<boolean>(
        "!![...document.querySelectorAll('video')].find(v=>v.videoWidth>0 && v.currentTime>0.3)",
      ),
    15000,
  );
  const first = await live().evaluate<number>("document.querySelector('video').currentTime");
  await waitFor(
    () => live().evaluate<boolean>(`document.querySelector('video').currentTime > ${first + 0.2}`),
    10000,
  );
  await waitFor(
    () =>
      live().evaluate<boolean>(
        "!document.body.innerText.includes('Tuning') && !document.body.innerText.includes('Waiting for data')",
      ),
    15000,
  );
}

try {
  // The first catalogue row is programme-only for Earth. Its delayed arrival prepends a Live
  // result before the selected Earth copy. Both providers reuse stream id 1001.
  for (let i = 0; i < 2; i++) {
    const provider = await startFakeProvider({
      channels: 30,
      titles: 15,
      live: true,
      channelOf: (channel) =>
        channel.streamId === 1000
          ? { ...channel, name: "Bulletin", guideId: "bulletin.test" }
          : channel.streamId === 1001
            ? { ...channel, name: "Earth", fixture: "h264-aac.mpegts", guideId: "earth.test" }
            : channel,
    });
    provider.serveTitles((all) => ({
      ...all,
      movies: all.movies.map((movie) =>
        movie.id === 90001 ? { ...movie, name: "Earth (1995)" } : movie,
      ),
    }));
    provider.serveCategories((all) =>
      all.map((category) => (category.id === "1" ? { ...category, name: "BE | News" } : category)),
    );
    providers.push(provider);
  }
  tmdb = await startFakeTmdb();
  const port = await freePort();
  const inspectorPort = await freePort();
  const executable = await electronExecutable();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith("MR_STREAMER_") &&
        ![
          "ELECTRON_RUN_AS_NODE",
          "NODE_OPTIONS",
          "LANGUAGE",
          "LANG",
          "LC_ALL",
          "LC_MESSAGES",
        ].includes(name),
    ),
  );
  app = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--inspect=127.0.0.1:${inspectorPort}`,
      `--user-data-dir=${profile}`,
      "--enable-automation",
      "--use-mock-keychain",
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      desktop,
    ],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...env,
        LANG: "en_US.UTF-8",
        LANGUAGE: "en_US",
        MR_STREAMER_UPDATE_CHECKS: "off",
        MR_STREAMER_TMDB_API: tmdb.url,
        MR_STREAMER_TMDB_KEY: "test-key",
      },
    },
  );
  for (const stream of [app.stdout, app.stderr])
    stream?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  page = await connect(port, "page", { app });
  inspector = await connect(inspectorPort, "node", { app });
  const command = (await send("Browser.getBrowserCommandLine")) as { arguments: string[] };
  for (const arg of [
    desktop,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--inspect=127.0.0.1:${inspectorPort}`,
  ])
    assert(command.arguments.includes(arg));
  assert(
    (await live().evaluate<string>("location.href")).startsWith(
      pathToFileURL(join(desktop, "out/renderer/")).href,
    ),
  );
  assert.equal(await inspector.evaluate<number>("process.pid"), app.pid);
  proof.instance = { pid: app.pid, port, inspectorPort, executable, desktop };
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Network.enable");
  await send("Network.setBlockedURLs", { urls: ["*image.example*", "*image.tmdb.org*"] });
  await waitFor(() => exists("document.querySelector('form input')"), 15000);
  const fields = [providers[0]!.url, "demo", "demo"];
  for (const [index, text] of fields.entries())
    await type(`document.querySelectorAll('form input')[${index}]`, text);
  await click("document.querySelector('form button[type=submit]')");
  await waitFor(() => exists("document.querySelector('header')"), 30000);
  await addSubscription(live(), providers[1]!, "South");
  await key(live(), "Escape", 27);

  await inspector.evaluate("globalThis.__searchProbe = {events:[]}");
  // Observe the original handlers' public replies, including typed cancellations, unchanged.
  await inspector.evaluate(`(() => {
    const ipc=process.getBuiltinModule('node:module').createRequire(${JSON.stringify(join(desktop, "package.json"))})('electron').ipcMain;
    if(!(ipc._invokeHandlers instanceof Map)) throw Error('Registered IPC handlers unavailable');
    for(const method of ['guide.search','guide.searchList','guide.cancelSearch']) {
      const original=ipc._invokeHandlers.get(method);
      if(typeof original!=='function') throw Error('Missing registered '+method);
      ipc._invokeHandlers.set(method,async(event,input)=>{
        const reply=await original(event,input);
        globalThis.__searchProbe.events.push({phase:'reply',method,query:input?.query,
          ...(method==='guide.cancelSearch'?input:input?.request),at:Date.now(),
          ok:reply.ok,...(reply.ok?{}:{error:reply.error})});
        return reply;
      });
    }
  })()`);
  await inspector.send("Debugger.enable");
  const lines = bundle.split("\n");
  const injectionLine =
    lines.findIndex((line) => line.includes("let work = suspend(() => handler(input, frame));")) +
    1;
  const completionLine = lines.findIndex(
    (line, i) =>
      i > injectionLine &&
      line.includes("if (isSuccess(exit2)) return { ok: true, value: exit2.value }"),
  );
  assert(
    injectionLine > 0 && completionLine > injectionLine,
    "Registered IPC handler locations unavailable",
  );
  inspector.on("Debugger.paused", (params) => {
    void (async () => {
      const paused = params as {
        callFrames: { callFrameId: string; location: { lineNumber: number } }[];
      };
      const frame = paused.callFrames[0]!;
      const expression =
        frame.location.lineNumber === injectionLine
          ? `(() => { globalThis.__searchProbe.events.push({phase:'start', method, query:input.query, ...input.request, at:Date.now()}); work=andThen(sleep(${guideDelayMs}),work); return true; })()`
          : `globalThis.__searchProbe.events.push({phase:'end', method, query:input.query, ...input.request, at:Date.now(), success:isSuccess(exit2), interrupted:!isSuccess(exit2)&&closing(exit2), count:isSuccess(exit2)?(Array.isArray(exit2.value)?exit2.value.length:Object.keys(exit2.value).length):null})`;
      const reply = await inspector!.send("Debugger.evaluateOnCallFrame", {
        callFrameId: frame.callFrameId,
        expression,
        returnByValue: true,
      });
      if (reply.error || (reply.result as { exceptionDetails?: unknown })?.exceptionDetails)
        inspectorErrors.push(reply);
    })()
      .catch((error) => inspectorErrors.push(String(error)))
      .finally(() => inspector!.send("Debugger.resume"));
  });
  for (const lineNumber of [injectionLine, completionLine]) {
    const reply = await inspector.send("Debugger.setBreakpointByUrl", {
      url: pathToFileURL(join(desktop, "out/main/index.js")).href,
      lineNumber,
      condition: `method === 'guide.search' || method === 'guide.searchList'`,
    });
    assert(!reply.error, JSON.stringify(reply));
    events.push({ breakpoint: reply.result });
  }

  await check("Global title opens while real guide is pending", async () => {
    await palette("Earth");
    await pending("guide.search", "Earth");
    await waitFor(
      () => live().evaluate<boolean>(`${treeRows}.some(r=>r.innerText.includes('Movie'))`),
      15000,
    );
    const before =
      tmdb!.aboutRequests() + providers.reduce((sum, p) => sum + p.detailRequests(), 0);
    await capture("global-local-pending");
    await click(`${treeRows}.find(r=>r.innerText.includes('Movie'))`);
    await waitFor(() => exists(button("Play")), 15000);
    assert(
      tmdb!.aboutRequests() + providers.reduce((sum, p) => sum + p.detailRequests(), 0) > before,
    );
    events.push({
      titleOpen: await live().evaluate<string>("document.body.innerText"),
      guide: await guideTrace(),
    });
    await capture("global-title-open");
    await closePalette();
    await key(live(), "Escape", 27);
  });

  await check("Global channel plays while real guide is pending", async () => {
    await palette("earth");
    await pending("guide.search", "earth");
    assert((await state()).statuses.some((s) => /Guide: Searching/.test(s)));
    const requests = providers.map((p) => p.streamRequests());
    await key(live(), "Enter", 13);
    await watchFrom(0, requests);
    await capture("global-channel-pending-playing");
    events.push({
      pendingChannelRequestsBefore: requests,
      after: providers.map((p) => p.streamRequests()),
      guide: await guideTrace(),
    });
    await key(live(), "Escape", 27);
  });

  await check(
    "Global selected South copy survives programme arrival and Enter plays South",
    async () => {
      await palette("Earth");
      await pending("guide.search", "Earth");
      await key(live(), "ArrowRight", 39);
      await waitFor(
        () =>
          live().evaluate<boolean>(
            `${treeRows}.some(r=>r.getAttribute('aria-level')==='2' && r.innerText.includes('South'))`,
          ),
        10000,
      );
      await key(live(), "ArrowDown", 40);
      await key(live(), "ArrowDown", 40);
      const before = await state();
      assert(before.selected?.includes("South"), JSON.stringify(before));
      assert(before.statuses.some((s) => /Guide: Searching/.test(s)));
      await capture("global-copy-pending");
      await settled();
      const after = await state();
      assert.equal(after.selected, before.selected);
      assert(after.rows.length > before.rows.length, "Real programmes must arrive");
      await capture("global-copy-settled");
      const requests = providers.map((p) => p.streamRequests());
      await key(live(), "Enter", 13);
      await watchFrom(1, requests);
      await capture("global-south-playing");
      events.push({
        before,
        after,
        streamRequestsBefore: requests,
        streamRequestsAfter: providers.map((p) => p.streamRequests()),
      });
      await key(live(), "Escape", 27);
    },
  );

  await check(
    "Global raw edit makes old rows inert before debounce and blocks Enter and click",
    async () => {
      await palette("Earth");
      const before = providers.map((p) => p.streamRequests());
      const details =
        tmdb!.aboutRequests() + providers.reduce((sum, p) => sum + p.detailRequests(), 0);
      await click(combo);
      const point = await position(`${treeRows}[0]`);
      await armPointerProbe(combo, treeRows);
      const editedAt = performance.now();
      await send("Input.insertText", { text: " " });
      const changed = await staleActions(combo, treeRows);
      assert.equal(changed.input, "Earth ");
      assert(changed.inert && changed.rows > 0, JSON.stringify(changed));
      await pointer(point, false);
      const nativeClick = await pointerProbe();
      await key(live(), "Enter", 13);
      const actionMs = performance.now() - editedAt;
      assert(await exists(combo));
      assert.deepEqual(
        providers.map((p) => p.streamRequests()),
        before,
      );
      assert.equal(
        tmdb!.aboutRequests() + providers.reduce((sum, p) => sum + p.detailRequests(), 0),
        details,
      );
      events.push({ rawEdit: changed, actionMs, nativeClick });
      await capture("global-edited");
    },
  );

  await check(
    "Global rapid typing, paste, erase, close and reopen abandon old requests",
    async () => {
      const before = providers.map((p) => p.streamRequests());
      for (const text of ["E", "Ea", "Ear", "Earth N", "Earth News"]) {
        await type(combo, text);
        await key(live(), "Enter", 13);
        events.push({ rapidInput: text, state: await state() });
        assert(await exists(combo));
      }
      await pending("guide.search", "Earth News");
      await key(live(), "a", 65, MODIFIERS.main);
      await key(live(), "Backspace", 8);
      await key(live(), "Enter", 13);
      assert.equal((await state()).rows.length, 0);
      await type(combo, "Earth News");
      await pending("guide.search", "Earth News");
      await closePalette();
      await key(live(), "k", 75, MODIFIERS.main);
      await waitFor(() => exists(combo), 10000);
      assert.equal((await state()).input, "");
      await type(combo, "zz-no-current-result");
      await settled();
      assert.equal((await state()).rows.length, 0);
      assert(await live().evaluate<boolean>("document.body.innerText.includes('No matches')"));
      assert.deepEqual(
        providers.map((p) => p.streamRequests()),
        before,
      );
      await capture("global-reopened-empty");
      await closePalette();
    },
  );

  await check("Live channel plays while real guide is pending", async () => {
    await click(button("Live TV", "header button"));
    if (!(await exists(liveInput))) await click(button("All channels"));
    await type(liveInput, "earth");
    await pending("guide.searchList", "earth");
    await waitFor(async () => (await state()).rows.length > 0 && !(await state()).inert, 10000);
    assert((await state()).statuses.some((s) => /Searching/.test(s)));
    await capture("live-name-pending");
    const requests = providers.map((p) => p.streamRequests());
    await click(`${liveRows}[0]`);
    await watchFrom(0, requests);
    await capture("live-channel-pending-playing");
    events.push({
      livePendingChannelRequestsBefore: requests,
      after: providers.map((p) => p.streamRequests()),
      guide: await guideTrace(),
    });
    await key(live(), "Escape", 27);
  });

  await check("Live name copy remains selected when programme-only rows prepend", async () => {
    await click(button("Live TV", "header button"));
    if (!(await exists(liveInput))) await click(button("All channels"));
    await type(liveInput, "Earth");
    await pending("guide.searchList", "Earth");
    await waitFor(
      () =>
        live().evaluate<boolean>(
          `${liveRows}.some(r=>r.innerText.includes('Earth')) && !${liveRows}[0]?.closest('[inert]')`,
        ),
      15000,
    );
    await key(live(), "ArrowDown", 40);
    await key(live(), "ArrowRight", 39);
    await waitFor(
      () => live().evaluate<boolean>(`${liveRows}.some(r=>r.innerText.includes('South'))`),
      10000,
    );
    await key(live(), "ArrowDown", 40);
    await key(live(), "ArrowDown", 40);
    const before = await state();
    assert(before.selected?.includes("South"), JSON.stringify(before));
    assert(before.statuses.some((s) => /Searching/.test(s)));
    assert(!before.rows.some((r) => r.split("\n").includes("Bulletin")));
    await capture("live-copy-pending");
    await settled();
    const after = await state();
    assert(
      after.rows.some((r) => r.split("\n").includes("Bulletin")),
      JSON.stringify(after),
    );
    assert.equal(after.selected, before.selected);
    assert(
      after.selectedIndex > before.selectedIndex,
      "Programme-only row must prepend before the selected copy",
    );
    await capture("live-copy-settled");
    const requests = providers.map((p) => p.streamRequests());
    await key(live(), "Enter", 13);
    await watchFrom(1, requests);
    await capture("live-south-playing");
    events.push({ before, after, streamRequests: providers.map((p) => p.streamRequests()) });
    await key(live(), "Escape", 27);
  });

  await check(
    "Live raw edit blocks stale keyboard and pointer action, then clear restores list",
    async () => {
      await click(button("Live TV", "header button"));
      await waitFor(() => exists(liveInput), 10000);
      await type(liveInput, "Earth");
      await waitFor(async () => (await state()).rows.length > 0 && !(await state()).inert, 10000);
      const before = providers.map((p) => p.streamRequests());
      await click(liveInput);
      const point = await position(`${liveRows}[0]`);
      await armPointerProbe(liveInput, liveRows);
      const editedAt = performance.now();
      await send("Input.insertText", { text: " " });
      const changed = await staleActions(liveInput, liveRows);
      assert(changed.inert && changed.rows > 0, JSON.stringify(changed));
      await pointer(point, false);
      const nativeClick = await pointerProbe();
      await key(live(), "Enter", 13);
      const actionMs = performance.now() - editedAt;
      assert(await exists(liveInput));
      assert.deepEqual(
        providers.map((p) => p.streamRequests()),
        before,
      );
      await type(liveInput, "zz-no-current-result");
      await settled();
      assert.equal((await state()).rows.length, 0);
      await click(liveInput);
      await key(live(), "a", 65, MODIFIERS.main);
      await key(live(), "Backspace", 8);
      await waitFor(
        () => live().evaluate<boolean>("document.body.innerText.includes('Bulletin')"),
        10000,
      );
      assert.equal((await state()).input, "");
      assert.deepEqual(
        providers.map((p) => p.streamRequests()),
        before,
      );
      events.push({ rawEdit: changed, actionMs, nativeClick });
      await capture("live-cleared");
    },
  );
  assert.deepEqual(inspectorErrors, []);
  proof.guide = await guideTrace();
  assert(
    (
      proof.guide as { phase: string; ok?: boolean; error?: { kind: string; detail: string } }[]
    ).some(
      (e) =>
        e.phase === "reply" &&
        e.ok === false &&
        e.error?.kind === "unexpected" &&
        e.error.detail === "Closing.",
    ),
    "Observe the original registered handler's real typed cancellation reply",
  );
  assert.equal(app.exitCode, null);
  proof.status = "pass";
} catch (error) {
  failure = true;
  proof.status = "fail";
  proof.error = String(error);
  if (page) await capture("failure").catch(() => undefined);
} finally {
  if (inspector) {
    proof.guide = await guideTrace().catch((error) => String(error));
    await inspector.send("Debugger.disable");
    inspector.close();
  }
  try {
    if (app) await stop(app, page);
    await rm(profile, { recursive: true, force: true });
    proof.cleanup = { exitCode: app?.exitCode, signal: app?.signalCode, profileRemoved: true };
  } catch (error) {
    failure = true;
    proof.cleanup = { error: String(error), profileRetained: true };
  }
  page?.close();
  for (const provider of providers) await provider.close();
  await tmdb?.close();
  proof.fixturesClosed = true;
  proof.streamRequests = providers.map((p) => p.streamRequests());
  proof.cases = cases;
  proof.events = events;
  proof.inspectorErrors = inspectorErrors;
  await writeFile(join(output, "proof.json"), JSON.stringify(proof, null, 2));
  await writeFile(join(output, "electron.log"), logs.join(""));
  console.log(output);
}
process.exitCode = failure ? 1 : 0;
