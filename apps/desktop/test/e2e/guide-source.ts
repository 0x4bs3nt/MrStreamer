// Checks a guide from an address of the viewer's own in a built app, against the fake provider
// and a fake host for guides: what the suite can't, because the window, the player and the main
// process meet only there. It connects, plays a channel, then checks, in order:
//
// - In Settings > Subscriptions, Guide takes an address, Check reads it without changing the
//   guide, and Use this guide switches to it. The channel that plays keeps the one connection
//   it had meanwhile, and nothing shows or is saved of the address but its host.
// - The channels the new guide lists show its programmes.
// - Map opens the sheet, and the keyboard maps a channel without programmes to the guide channel
//   picked: its programmes show at once, on the same connection still, and it leaves the
//   channels without programmes for those mapped by hand.
// - A download that fails keeps the guide, says why under the Guide row, and asks the provider
//   for nothing in its place.
// - After a restart the address, the mapping, the listings and the failure are as they were,
//   with nothing asked of the guide's host.
// - Use provider guide goes back: the provider's programmes show, and the address, its guide and
//   the mapping are gone from the profile.
//
//   node test/e2e/guide-source.ts <app executable> [-- extra app arguments]
//
// The app runs with a throwaway profile and remote debugging on a random port; on macOS pass
// --use-mock-keychain so the test never touches a real keychain.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GuideStatus, Listing, MapChannelPage } from "@mrstreamer/contracts/guide";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { GUIDE_KEY, startGuideHost } from "../fake-guide-host.ts";
import { startFakeProvider } from "../fake-provider.ts";
import {
  connect,
  delay,
  key,
  launch,
  login,
  openSubscriptions,
  waitFor,
  type Page,
} from "./app.ts";

const [executable, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!executable) throw new Error("Usage: node test/e2e/guide-source.ts <app executable> [-- args]");

/** A channel that plays a picture, which the provider's guide and the other one both list. */
const CHANNEL = { id: "1000", name: "TEST | H.264 + AAC", guideId: "aac.test" };
/** A guide channel no channel of the provider names: one to map to by hand. */
const SPARE = { id: "canalnord.ex", name: "Canal Nord" };

const profile = mkdtempSync(join(tmpdir(), "mr-streamer-e2e-"));
const provider = await startFakeProvider({ channels: 300, live: true });
const host = await startGuideHost();
/** A guide whose every programme is called after `label` and its channel, an hour each. */
function guide(label: string): string {
  const stamp = (at: number) =>
    `${new Date(at).toISOString().slice(0, 19).replace(/[-T:]/g, "")} +0000`;
  const hour = 60 * 60 * 1000;
  const first = Math.floor(Date.now() / hour) * hour - hour;
  const channels = [
    { id: CHANNEL.guideId, name: "AAC" },
    SPARE,
    { id: "canalnordsport.ex", name: "Canal Nord Sport" },
  ];
  const listed = channels.map(
    ({ id, name }) => `<channel id="${id}"><display-name>${name}</display-name></channel>`,
  );
  const programmes = channels.flatMap(({ id, name }) =>
    Array.from({ length: 24 }, (_, slot) => {
      const start = first + slot * hour;
      return `<programme start="${stamp(start)}" stop="${stamp(start + hour)}" channel="${id}"><title>${label} ${name}</title></programme>`;
    }),
  );
  return `<?xml version="1.0"?><tv>${listed.join("")}${programmes.join("")}</tv>`;
}
host.serve("/guide.xml", guide("Elsewhere"));

const randomPort = () => 20000 + Math.floor(Math.random() * 20000);
let port = randomPort();
let app = launch(executable, rest, { port, profile });

let failed = false;
/** Prints how a check went. */
function report(name: string, problems: readonly string[]): void {
  console.log(
    `${problems.length === 0 ? "PASS" : "FAIL"} ${name}${problems.map((each) => `\n     ${each}`).join("")}`,
  );
  failed ||= problems.length > 0;
}

const invoke = async <T>(page: Page, method: string, input?: unknown): Promise<T> => {
  const result = await page.evaluate<{ ok: boolean; value: T; error?: unknown }>(
    `window.mrStreamer.invoke(${JSON.stringify(method)}, ${JSON.stringify(input)})`,
  );
  if (!result.ok) throw new Error(`${method}: ${JSON.stringify(result.error)}`);
  return result.value;
};

/** Clicks what `expression` finds in the page, once it is there. */
async function click(page: Page, expression: string): Promise<void> {
  await waitFor(() => page.evaluate<boolean>(`!!(${expression})`), 20_000);
  await page.evaluate(`(${expression}).click()`);
}

/** A button by its exact words, as an expression for the page. */
const buttonNamed = (text: string): string =>
  `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;

/** What the page shows, within the element `selector` names. */
const shown = (page: Page, selector = "body") =>
  page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`);

/** Types `text` into the field `expression` finds, as the viewer would. */
const type = (page: Page, expression: string, text: string) =>
  page.evaluate(`(() => {
    const field = ${expression};
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setValue.call(field, ${JSON.stringify(text)});
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.focus();
  })()`);

/** The one subscription's guide, as Settings is told. */
const status = async (page: Page) => {
  const [only] = await invoke<GuideStatus[]>(page, "guide.status");
  if (!only) throw new Error("No subscription is saved");
  return only;
};

/** The programme a channel of the subscription shows as on now, by its title. */
async function nowOn(page: Page, subscriptionId: string, id: string): Promise<string | undefined> {
  const channel = { subscriptionId, id };
  const listings = await invoke<Record<string, Listing>>(page, "guide.listings", {
    channels: [channel],
  });
  return listings[ownedKey(channel)]?.now?.title;
}

/** Plays `CHANNEL` through search, and waits for its picture. */
async function play(page: Page): Promise<void> {
  await page.evaluate(`document.querySelector('[aria-label="Search"]').click()`);
  await waitFor(
    () => page.evaluate<boolean>(`document.activeElement?.closest('[role="dialog"]') !== null`),
    10_000,
  );
  await page.send("Input.insertText", { text: CHANNEL.name });
  await waitFor(
    () => page.evaluate<boolean>(`!!document.querySelector('[role="dialog"] [data-index="0"]')`),
    15_000,
  );
  // What was typed last is searched for after a pause.
  await delay(800);
  await page.evaluate(`document.querySelector('[role="dialog"] [data-index="0"] button').click()`);
  await waitFor(
    () =>
      page.evaluate<boolean>(`(() => {
        const video = document.querySelector("video");
        return !!document.querySelector('[data-view="watch"]') && !!video &&
          video.currentTime > 0.3 && video.videoWidth > 0;
      })()`),
    30_000,
  );
}

/** What is kept of guides in the profile, by name, each index's id as "*". */
const guideFiles = () =>
  readdirSync(profile)
    .filter((name) => name.startsWith("guide"))
    .map((name) => name.replace(/\.[0-9a-f-]{36}\./, ".*."))
    .sort();

const hostName = new URL(host.origin).host;
const guideButton = `document.querySelector('[aria-label^="Guide for"]')`;

try {
  let page = await connect(port);
  await login(page, provider);
  await play(page);
  const requests = provider.streamRequests();
  /**
   * What became of the stream that plays: nothing, while the provider still holds the one
   * connection it opened for it and was asked for no other.
   */
  const stream = (): string[] => [
    ...(provider.activeStreams() === 1 ? [] : [`${provider.activeStreams()} streams are open`]),
    ...(provider.streamRequests() === requests
      ? []
      : [`the stream was asked for ${provider.streamRequests() - requests} more times`]),
  ];
  await openSubscriptions(page);
  await waitFor(async () => (await status(page)).fetchedAt !== null, 60_000);
  const { subscriptionId } = await status(page);
  const own = await nowOn(page, subscriptionId, CHANNEL.id);

  {
    const problems: string[] = [];
    await click(page, guideButton);
    await waitFor(() => page.evaluate<boolean>(`!!document.querySelector("form input")`), 10_000);
    await type(page, `document.querySelector("form input")`, host.address());
    await click(page, `document.querySelector('form button[type="submit"]')`);
    const said = () => shown(page, 'form [role="status"]');
    await waitFor(async () => (await said()).startsWith("Checked:"), 30_000);
    if (!(await said()).includes("3 channels in this guide, 1 of your")) {
      problems.push(`the check said "${await said()}"`);
    }
    // Checked only: the guide in use is still the provider's.
    const before = await status(page);
    if (before.source.kind !== "own" || (await nowOn(page, subscriptionId, CHANNEL.id)) !== own) {
      problems.push("the guide changed before Use this guide");
    }
    await click(page, buttonNamed("Use this guide"));
    await waitFor(async () => (await status(page)).source.kind === "external", 30_000);
    const after = await status(page);
    if (after.source.kind !== "external" || after.source.origin !== host.origin) {
      problems.push(`the guide's source is ${JSON.stringify(after.source)}`);
    }
    await waitFor(async () => (await shown(page)).includes(`Guide · ${hostName} · `), 10_000).catch(
      () => problems.push("the Guide row doesn't name the address's host"),
    );
    // Nothing of the address but its host: not in the window, and not in what is told or kept.
    const told = `${await shown(page)}\n${JSON.stringify(await invoke(page, "guide.status"))}`;
    const kept = readFileSync(join(profile, "guide-source.json"), "utf8");
    for (const secret of [GUIDE_KEY, "guide.xml?"]) {
      if (told.includes(secret)) problems.push(`the window was told "${secret}"`);
      if (kept.includes(secret)) problems.push(`guide-source.json holds "${secret}"`);
    }
    if (host.requests().length !== 1)
      problems.push(`the host was asked ${host.requests().length} times`);
    problems.push(...stream());
    report("An address is checked first, then used, while the channel plays on", problems);
  }

  {
    const title = await nowOn(page, subscriptionId, CHANNEL.id);
    report(
      "The channels the guide lists show its programmes",
      title === "Elsewhere AAC" ? [] : [`${CHANNEL.name} shows "${title}"`],
    );
  }

  {
    const problems: string[] = [];
    await click(page, `document.querySelector('[aria-label^="Map channels of"]')`);
    const sheet = '[role="dialog"]';
    await waitFor(async () => (await shown(page, sheet)).includes("no id match"), 20_000);
    const without = await invoke<MapChannelPage>(page, "guide.mapChannels", {
      subscriptionId,
      filter: "without",
      query: "",
      offset: 0,
      limit: 1,
    });
    const [picked] = without.channels;
    if (!picked) throw new Error("Every channel has programmes");
    // The first channel is picked. Its guide channels are searched, and one mapped, by the keys.
    await type(page, `document.querySelectorAll('${sheet} input')[1]`, SPARE.name);
    await waitFor(async () => (await shown(page, sheet)).includes(SPARE.id), 20_000);
    await key(page, "ArrowDown", 40);
    await key(page, "ArrowDown", 40);
    await key(page, "Enter", 13);
    await waitFor(async () => (await status(page)).mapped === 1, 20_000).catch(() =>
      problems.push("Enter mapped nothing"),
    );
    // It has programmes now, so the channels without them are read again, and it isn't one.
    const channels = `${sheet} [role="listbox"]`;
    await waitFor(async () => !(await shown(page, channels)).includes(picked.title), 20_000).catch(
      () => problems.push("the channel still shows among those without programmes"),
    );
    await page.evaluate(`(() => {
      const filter = document.querySelector('${sheet} select');
      filter.value = "mapped";
      filter.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await waitFor(
      async () => (await shown(page, channels)).includes(`mapped · ${SPARE.id}`),
      20_000,
    ).catch(() => problems.push("the channel doesn't say what it is mapped to"));
    const title = await nowOn(page, subscriptionId, picked.id);
    if (title !== `Elsewhere ${SPARE.name}`) problems.push(`${picked.title} shows "${title}"`);
    problems.push(...stream());
    await click(page, buttonNamed("Done"));
    await waitFor(() => page.evaluate<boolean>(`!document.querySelector('${sheet}')`), 10_000);
    report("The keyboard maps a channel to the guide channel picked", problems);

    const failures: string[] = [];
    const asked = provider.guideRequests();
    host.serve("/guide.xml", 503);
    await click(page, `document.querySelector('[aria-label="Refresh guide"]')`);
    const line = `${hostName} answered with an error (HTTP 503).`;
    await waitFor(async () => (await shown(page)).includes(line), 30_000).catch(() =>
      failures.push("no line says why the download failed"),
    );
    if (!(await shown(page)).includes("the provider's guide isn't used")) {
      failures.push("nothing says the provider's guide isn't used");
    }
    if ((await nowOn(page, subscriptionId, CHANNEL.id)) !== "Elsewhere AAC") {
      failures.push("the listings changed");
    }
    if (provider.guideRequests() !== asked) failures.push("the provider's guide was asked for");
    report("A download that fails keeps the guide and says why", failures);

    page.close();
    app.kill("SIGKILL");
    await delay(1500);
    const hostAsked = host.requests().length;
    port = randomPort();
    app = launch(executable, rest, { port, profile });
    page = await connect(port);
    await waitFor(() => page.evaluate<boolean>(`!!document.querySelector("header")`), 60_000);
    await openSubscriptions(page);
    await waitFor(async () => (await status(page)).fetchedAt !== null, 60_000);
    const restarted = await status(page);
    const after: string[] = [];
    if (restarted.source.kind !== "external" || restarted.source.origin !== host.origin) {
      after.push(`the guide's source is ${JSON.stringify(restarted.source)}`);
    }
    if (restarted.mapped !== 1) after.push(`${restarted.mapped} channels are mapped`);
    if (restarted.failure?.kind !== "provider-error") {
      after.push(`the failure is ${JSON.stringify(restarted.failure)}`);
    }
    if ((await nowOn(page, subscriptionId, picked.id)) !== `Elsewhere ${SPARE.name}`) {
      after.push("the mapped channel lost its programmes");
    }
    if (host.requests().length !== hostAsked) after.push("the guide's host was asked again");
    report("A restart keeps the address, the mapping, the listings and the failure", after);

    const back: string[] = [];
    await click(page, guideButton);
    await click(page, buttonNamed("Use provider guide"));
    await waitFor(async () => (await status(page)).source.kind === "own", 30_000);
    await waitFor(async () => (await status(page)).fetchedAt !== null, 60_000);
    const restored = await status(page);
    if (restored.mapped !== 0) back.push(`${restored.mapped} channels are still mapped`);
    const again = await nowOn(page, subscriptionId, CHANNEL.id);
    if (!again || again.startsWith("Elsewhere")) back.push(`${CHANNEL.name} shows "${again}"`);
    if ((await nowOn(page, subscriptionId, picked.id)) !== undefined) {
      back.push("the channel that was mapped still shows programmes");
    }
    // The address's index goes once nothing reads it: a few seconds at most.
    const kept = ["guide-index.*.sqlite", "guide.json"].join();
    for (let waited = 0; guideFiles().join() !== kept && waited < 5000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (guideFiles().join() !== kept) back.push(`the profile keeps ${guideFiles().join(", ")}`);
    report("Use provider guide goes back, and drops the address", back);
  }
  page.close();
} catch (error) {
  console.error(`FAIL ${String(error)}`);
  failed = true;
} finally {
  app.kill("SIGKILL");
  await Promise.all([provider.close(), host.close()]);
  await delay(1000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(failed ? 1 : 0);
