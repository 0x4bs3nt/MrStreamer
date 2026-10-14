// `remove-during-guide`: the only subscription removed in Settings while its guide takes its time,
// as the installed upgrade check's last start does after an upgrade from 0.0.12. The app quits,
// its guide goes back to the document 0.0.12 kept, a large one, and the provider stops answering
// for its guide. Started again, the app indexes that document in the background while the
// subscription is removed through Settings > Subscriptions. Pass means Connect is back within
// seconds while the indexing was under way, no guide was asked for after the removal began, and
// nothing of the guide is left in the profile.
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Driver } from "./language.ts";

/** What the scenario needs of the fake provider's guide. */
export interface ProviderGuide {
  /** Leaves every later guide request unanswered, as a server that hangs. */
  hold(): void;
  /** How many guide requests it answered or holds. */
  requests(): number;
}

/** How long Connect may take to come back once the removal is confirmed. */
const BACK_WITHIN_MS = 10_000;

const ROW = `[...document.querySelectorAll('li')].find(r => r.querySelector('button')?.textContent.includes(' · '))`;

export async function removeDuringGuideScenario(d: Driver, guide: ProviderGuide): Promise<void> {
  const status = () =>
    d.evaluate<{ state: string | null; availability: string | null }>(`(async () => {
      const read = await window.mrStreamer.invoke('guide.status');
      const own = read.ok ? read.value[0] : undefined;
      return { state: own?.processing?.state ?? null, availability: own?.availability ?? null };
    })()`);
  await d.wait(async () => (await status()).availability === "available");
  await d.quit();

  // What 0.0.12 kept: the document itself, named by a guide.json without an index.
  const meta = join(d.profile, "guide.json");
  const { key, fetchedAt } = JSON.parse(await readFile(meta, "utf8")) as {
    key: string;
    fetchedAt: number;
  };
  for (const name of await readdir(d.profile))
    if (name.startsWith("guide-index.")) await rm(join(d.profile, name));
  await writeFile(meta, JSON.stringify({ key, fetchedAt }));
  await writeFile(join(d.profile, "guide.xml"), largeGuide());
  guide.hold();

  await d.launch();
  await d.wait(async () => (await status()).state === "reading");
  d.observed["indexingAtStart"] = true;
  await d.click("Open Settings", "document.querySelector('header button[aria-pressed]')");
  await d.click(
    "Open Subscriptions",
    `[...document.querySelectorAll('nav button')].find(b => b.textContent.trim() === 'Subscriptions')`,
  );
  // As the installed check does: a press while the list settles can go unseen.
  for (let attempt = 1; ; attempt++) {
    await d.click(
      `Open the subscription (attempt ${attempt})`,
      `(${ROW})?.querySelector('button')`,
    );
    const opened = await d
      .wait(() => d.exists(`(${ROW})?.querySelector('[role=region]')`), 3000)
      .then(
        () => true,
        () => false,
      );
    if (opened) break;
    if (attempt === 3) throw new Error("The subscription's row didn't open.");
  }
  await d.click(
    "Ask to remove it",
    `[...(${ROW})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim().startsWith("Remove "))`,
  );
  await d.wait(() => d.evaluate<boolean>(`document.body.innerText.includes("from this device?")`));
  await d.capture("removal-question");
  const indexing = (await status()).state;
  if (indexing !== "reading") throw new Error(`The guide was no longer being indexed: ${indexing}`);
  const asked = guide.requests();
  const began = performance.now();
  await d.click(
    "Confirm removal",
    `[...(${ROW})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim() === "Remove")`,
  );
  await d.wait(() => d.exists("document.querySelector('form input')"), BACK_WITHIN_MS);
  d.observed["connectBackMs"] = Math.round(performance.now() - began);
  await d.capture("connect-after-removal");

  d.observed["guideRequestsAfterRemoval"] = guide.requests() - asked;
  if (guide.requests() !== asked) throw new Error("A guide was asked for after the removal.");
  const left = (await readdir(d.profile)).filter((name) => /^guide[-.]/.test(name));
  d.observed["guideFilesLeft"] = left;
  if (left.length > 0) throw new Error(`The guide left ${left.join(", ")}.`);
}

/**
 * An XMLTV document of 600,000 one-minute programmes on 20 channels, from now on: large enough to
 * be indexed for several seconds, as on a slow disk.
 */
function largeGuide(): string {
  const stamp = (at: number) =>
    `${new Date(at).toISOString().slice(0, 19).replace(/[-T:]/g, "")} +0000`;
  const first = Math.floor(Date.now() / 60_000) * 60_000;
  const parts = ['<?xml version="1.0" encoding="utf-8"?><tv>'];
  for (let channel = 0; channel < 20; channel++) {
    const id = `slow-${channel}.test`;
    parts.push(`<channel id="${id}"><display-name>${id}</display-name></channel>`);
    for (let minute = 0; minute < 30_000; minute++) {
      const start = first + minute * 60_000;
      parts.push(
        `<programme start="${stamp(start)}" stop="${stamp(start + 60_000)}" channel="${id}"><title>Slow ${minute % 97}</title></programme>`,
      );
    }
  }
  parts.push("</tv>");
  return parts.join("\n");
}
