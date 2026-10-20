// Drives a built app over the DevTools protocol, against the fake provider or the fake playlist
// host. Shared by the tests of a built app and the measuring script.
import { spawn, type ChildProcess } from "node:child_process";
import type { FakeProvider } from "../fake-provider.ts";

/** Starts the app with remote debugging on `port` and its data in `profile`. */
export function launch(
  executable: string,
  args: readonly string[],
  options: { port: number; profile: string },
): ChildProcess {
  return spawn(
    executable,
    [`--remote-debugging-port=${options.port}`, `--user-data-dir=${options.profile}`, ...args],
    // No automatic update checks and no TMDB, a closed port unless the caller serves one: both
    // would reach the network in the middle of a measurement.
    {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        MR_STREAMER_UPDATE_CHECKS: "off",
        MR_STREAMER_TMDB_API: process.env["MR_STREAMER_TMDB_API"] ?? "http://127.0.0.1:9/3",
      },
    },
  );
}

export type Page = Awaited<ReturnType<typeof connect>>;

/**
 * A minimal DevTools protocol client for the app's window, or for its main process ("node") when
 * the app was started with `--inspect=<port>`. Polls every `pollMs` for up to 30 s. Given the
 * launched `app`, it gives up as soon as that process has exited, since it can no longer open one.
 */
export async function connect(
  port: number,
  kind: "page" | "node" = "page",
  { pollMs = 200, app }: { pollMs?: number; app?: ChildProcess } = {},
) {
  const target = kind === "page" ? "window" : "inspector";
  let url: string | undefined;
  const until = performance.now() + 30000;
  while (performance.now() < until && !url) {
    await delay(pollMs);
    if (app && (app.exitCode !== null || app.signalCode !== null))
      throw new Error(
        `The app exited (${app.signalCode ?? `code ${app.exitCode}`}) before opening a ${target}.`,
      );
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
        type: string;
        url: string;
        webSocketDebuggerUrl: string;
      }[];
      // Electron exposes its initial blank page before loading the app. Observing that page
      // loses the pending measurement when navigation destroys its execution context.
      url = targets.find(
        (target) =>
          target.type === kind &&
          (kind === "node" || (target.url !== "" && target.url !== "about:blank")),
      )?.webSocketDebuggerUrl;
    } catch {}
  }
  if (!url) throw new Error(`The app opened no ${target} within 30 s.`);
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  const listeners = new Map<string, (params: unknown) => void>();
  const closeListeners = new Set<() => void>();
  let closed = false;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (message.id !== undefined) pending.get(message.id)?.(message);
    else if (message.method) listeners.get(message.method)?.(message.params);
  });
  socket.addEventListener("close", () => {
    closed = true;
    for (const resolve of pending.values()) resolve({ error: "DevTools connection closed" });
    for (const listener of closeListeners) listener();
    closeListeners.clear();
  });
  const send = (method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000) =>
    new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      if (closed) {
        resolve({ error: "DevTools connection closed" });
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: `${method} timed out` });
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(message);
      });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ error: String(error) });
      }
    });
  return {
    send,
    /** Calls `listener` with each event of this name, as `Fetch.requestPaused`. */
    on(method: string, listener: (params: unknown) => void): () => void {
      listeners.set(method, listener);
      return () => {
        if (listeners.get(method) === listener) listeners.delete(method);
      };
    },
    /** Reports session closure, including a session that closed before registration. */
    onClose(listener: () => void): () => void {
      if (closed) listener();
      else closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
    async evaluate<T>(expression: string, timeoutMs = 10_000): Promise<T> {
      const reply = await send(
        "Runtime.evaluate",
        {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
        timeoutMs,
      );
      if (reply.error) throw new Error(JSON.stringify(reply.error));
      const result = reply.result as { result: { value: T }; exceptionDetails?: unknown };
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    },
    close: () => socket.close(),
  };
}

/** Connects the fake provider through the login form and waits for the channels. */
export async function login(page: Page, provider: FakeProvider): Promise<void> {
  await waitFor(() =>
    page.evaluate<boolean>("document.querySelectorAll('form input').length >= 3"),
  );
  await submit(page, [provider.url, "demo", "demo"]);
}

/**
 * Connects a playlist by its link, through the Connect screen's M3U link field, and waits for
 * the channels. The screen may already ask for the link alone, as when its keychain lost it.
 */
export async function connectPlaylist(page: Page, link: string): Promise<void> {
  await waitFor(() => page.evaluate<boolean>("!!document.querySelector('form input')"));
  await page.evaluate(
    `[...document.querySelectorAll("form button")].find((b) => b.textContent.trim() === "Use an M3U link")?.click()`,
  );
  await waitFor(() =>
    page.evaluate<boolean>("document.querySelectorAll('form input').length === 1"),
  );
  await submit(page, [link]);
}

/** Types `fields` into the Connect screen's fields, in order, connects, and waits for the app. */
async function submit(page: Page, fields: readonly string[]): Promise<void> {
  await fill(page, fields);
  await waitFor(() =>
    page.evaluate<boolean>(
      "!!document.querySelector('header') && !document.body.innerText.includes('Loading channels')",
    ),
  );
}

/**
 * Types `fields` into the fields of the form the window shows, in order, and sends it. A field
 * past the last of them is left as it is.
 */
export async function fill(page: Page, fields: readonly string[]): Promise<void> {
  await page.evaluate(`(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    const fields = ${JSON.stringify(fields)};
    document.querySelectorAll("form input").forEach((input, index) => {
      if (fields[index] === undefined) return;
      setValue.call(input, fields[index]);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    document.querySelector('form button[type="submit"]').click();
  })()`);
}

/** Opens Settings > Subscriptions, where the saved subscriptions are listed. */
export async function openSubscriptions(page: Page): Promise<void> {
  await press(page, "Settings");
  const tab = `[...document.querySelectorAll("nav button")].find((b) => b.textContent.trim() === "Subscriptions")`;
  await waitFor(() => page.evaluate<boolean>(`!!${tab}`), 20_000);
  await page.evaluate(`${tab}.click()`);
}

/** The row of the subscription listed as `name` in Settings > Subscriptions, for the page. */
export const subscriptionRow = (name: string): string =>
  `[...document.querySelectorAll("li")].find((row) => row.querySelector("button")?.textContent.trim().startsWith(${JSON.stringify(`${name} · `)}))`;

/**
 * Adds the fake provider beside the saved subscriptions, through Settings > Subscriptions and
 * under `name`, and waits for its row. Settings stays open on the list.
 */
export async function addSubscription(
  page: Page,
  provider: FakeProvider,
  name: string,
): Promise<void> {
  await openSubscriptions(page);
  await press(page, "Add subscription");
  await waitFor(
    () => page.evaluate<boolean>("document.querySelectorAll('form input').length >= 4"),
    20_000,
  );
  await fill(page, [name, provider.url, "demo", "demo"]);
  await waitFor(() => page.evaluate<boolean>(`!!${subscriptionRow(name)}`), 30_000);
}

/** The DevTools protocol's bits for the keys held with another, or with a click. */
/** `main` is the one the app's shortcuts take: ⌘ on macOS, Ctrl elsewhere. */
export const MODIFIERS = {
  alt: 1,
  shift: 8,
  main: process.platform === "darwin" ? 4 : 2,
} as const;

/** Presses a key in the window, with `modifiers` held: a sum of `MODIFIERS`. */
export async function key(page: Page, name: string, code: number, modifiers = 0): Promise<void> {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key: name,
      code: name,
      windowsVirtualKeyCode: code,
      modifiers,
    });
  }
}

/** Whether the window shows `words`, in the element `selector` names or anywhere. */
export const says =
  (page: Page, words: string, selector = "body") =>
  async () =>
    (
      await page.evaluate<string>(
        `document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`,
      )
    ).includes(words);

/** Clicks the button whose text starts with `label`, or that has it as its label, once there is one. */
export async function press(page: Page, label: string): Promise<void> {
  const button = `[...document.querySelectorAll("button")].find((b) =>
    b.textContent.trim().startsWith(${JSON.stringify(label)}) ||
    b.getAttribute("aria-label") === ${JSON.stringify(label)})`;
  await waitFor(() => page.evaluate<boolean>(`!!${button}`), 20_000);
  await page.evaluate(`${button}.click()`);
}

/** Reveal the same benchmark list in stable's rail or the topic rail's Provider lists branch. */
export async function revealFixtureList(
  page: Page,
  label: "All channels" | "TEST | Formats and failures",
): Promise<boolean> {
  const picker = `document.querySelector('[role="navigation"][aria-label="Channel categories"]')`;
  const target = `[...(${picker}?.querySelectorAll('button') ?? [])].find(b => b.title === ${JSON.stringify(label)} || b.textContent.trim().startsWith(${JSON.stringify(label)}))`;
  if (await page.evaluate<boolean>(`!!${target}`)) return false;
  const navigation =
    label === "All channels"
      ? `${picker}?.querySelector('button[aria-label="Back to topics"]')`
      : `${picker}?.querySelector('button[title="Provider lists"]')`;
  await page.evaluate(`(() => {
    const button = ${navigation};
    if (!button) throw new Error('No navigation to fixture list ' + ${JSON.stringify(label)});
    button.click();
  })()`);
  await waitFor(() => page.evaluate<boolean>(`!!${target}`));
  return true;
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return;
    await delay(250);
  }
  throw new Error(`Timed out: ${check.toString()}`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Observe completion in the renderer, where DOM mutations occur. The bounded 5 ms probe also
 * covers video clocks and other state that does not mutate the DOM. Always tears both down. */
export function observe(
  page: Page,
  condition: string,
  action = "",
  mutations = true,
): Promise<number> {
  return page.evaluate<number>(
    `new Promise((resolve, reject) => {
    const started = performance.now();
    const check = () => (${condition});
    let timer, deadline, observer;
    const cleanup = () => { clearInterval(timer); clearTimeout(deadline); observer?.disconnect(); };
    const probe = () => {
      try { if (check()) { cleanup(); resolve(performance.now() - started); } }
      catch (error) { cleanup(); reject(error); }
    };
    timer = setInterval(probe, 5);
    deadline = setTimeout(() => { cleanup(); reject(new Error("Renderer observation timed out")); }, 60000);
    try {
      if (${mutations}) {
        observer = new MutationObserver(probe);
        // The Document exists before its root element during a cold start.
        observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      }
      ${action}; probe();
    } catch (error) { cleanup(); reject(error); }
  })`,
    65000,
  );
}

/** Observe initial loading only, with one rearm for either exact initial-navigation CDP error.
 * There is deliberately no action argument: user actions must never run twice. */
export async function observeAcrossLoad(page: Page, condition: string, started: number) {
  let navigationObserved = false;
  for (;;) {
    try {
      await observe(page, condition);
      return { elapsedMs: performance.now() - started, navigationObserved };
    } catch (error) {
      if (
        navigationObserved ||
        !(error instanceof Error) ||
        ![
          '{"code":-32000,"message":"Execution context was destroyed."}',
          '{"code":-32000,"message":"Inspected target navigated or closed"}',
        ].includes(error.message)
      )
        throw error;
      navigationObserved = true;
    }
  }
}

/** Known short delays distinguish timer scheduling from observation error, on this renderer. */
export async function calibrate(page: Page) {
  const samples: {
    method: string;
    knownDelayMs: number;
    actualDelayMs: number;
    observationErrorMs: number;
    overheadMs: number;
  }[] = [];
  for (const mutations of [true, false]) {
    for (const knownDelayMs of [5, 10, 20, 50]) {
      for (let run = 0; run < 3; run++) {
        await page.evaluate(`(() => {
          document.querySelector("#measurement-calibration")?.remove();
          const marker = document.createElement("div"); marker.id = "measurement-calibration";
          marker.hidden = true; document.documentElement.append(marker);
        })()`);
        const elapsed = await observe(
          page,
          `document.querySelector("#measurement-calibration").dataset.ready === "yes"`,
          `window.__calibrationStarted = performance.now();
           setTimeout(() => { window.__calibrationActual = performance.now() - window.__calibrationStarted;
             document.querySelector("#measurement-calibration").dataset.ready = "yes"; }, ${knownDelayMs})`,
          mutations,
        );
        const actualDelayMs = await page.evaluate<number>("window.__calibrationActual");
        samples.push({
          method: mutations ? "mutation-and-probe" : "probe-only",
          knownDelayMs,
          actualDelayMs,
          observationErrorMs: Math.max(0, elapsed - actualDelayMs),
          overheadMs: await observe(page, "true", "", mutations),
        });
      }
    }
  }
  await page.evaluate('document.querySelector("#measurement-calibration").remove()');
  return samples;
}
