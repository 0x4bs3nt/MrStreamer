// `moved-guide`: the first start after an upgrade from 0.0.12 of a profile whose subscription had
// a guide address of the viewer's own. 0.0.13 moves that address to Settings > Guides with the
// download 0.0.12 kept, and the docs promise it downloads again straight after the update.
//
// The address is added once through Settings > Guides, only to have the app's keychain seal it.
// The app quits, and the profile is put back as 0.0.12 kept it: no sources, the subscription's
// own guide and the address's download as XMLTV documents, the address's a large one, named by
// guide-source.json with a channel mapped against it. Started again, the app indexes those
// documents in the background. Pass means the guide host is asked for the address within
// seconds of the start, while the periodic check comes only after 15 minutes, the row in Settings
// > Guides then reads the new download, and the source's first download lets go of what 0.0.12
// kept for the address.
import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GuideHost } from "../../../../apps/desktop/test/fake-guide-host.ts";
import type { Driver } from "./language.ts";

/** How long after the start the address may take to be asked for. */
const ASKED_WITHIN_MS = 20_000;
/** The guide channel the address lists, mapped by hand to a channel of the provider. */
const MAPPED = "ext.mapped";

interface Source {
  readonly id: string;
  readonly origin: string;
  readonly processing: { readonly state: string; readonly fetchedAt?: number };
}

export async function movedGuideScenario(d: Driver, host: GuideHost): Promise<void> {
  const status = () =>
    d.evaluate<{ state: string | null; availability: string | null }>(`(async () => {
      const read = await window.mrStreamer.invoke('guide.status');
      const own = read.ok ? read.value[0] : undefined;
      return { state: own?.processing?.state ?? null, availability: own?.availability ?? null };
    })()`);
  // Read-only: what the rows of Settings > Guides are drawn from.
  const sources = () =>
    d.evaluate<Source[]>(`(async () => {
      const read = await window.mrStreamer.invoke('guide.sources');
      return read.ok ? read.value : [];
    })()`);
  const byText = (selector: string, text: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
  const field = `document.querySelector('input[aria-label="Address of an XMLTV guide"]')`;
  const openGuides = async () => {
    await d.click("Open Settings", "document.querySelector('button[aria-label=Settings]')");
    await d.click("Open Guides", byText("nav button", "Guides"));
    await d.wait(() => d.exists(field));
  };

  host.serve("/guide.xml", guide("After", MAPPED, 1));
  await d.wait(async () => (await status()).availability === "available");
  // A channel of the provider without a guide id, to map by hand as the viewer did on 0.0.12.
  const loose = await d.evaluate<string | null>(`(async () => {
    const read = await window.mrStreamer.invoke('guide.mapChannels',
      { subscriptionId: (await window.mrStreamer.invoke('guide.status')).value[0].subscriptionId,
        filter: 'without', query: '', offset: 0, limit: 1 });
    return read.ok ? read.value.channels[0]?.id ?? null : null;
  })()`);
  if (!loose) throw new Error("No channel without programmes to map.");

  await openGuides();
  await d.click("Focus the address field", field);
  d.action("Type the guide's address");
  await d.send("Input.insertText", { text: host.address() });
  await d.click("Add the guide", byText("main form button", "Add"));
  await d.wait(async () => (await sources())[0]?.processing.state === "ready");
  await d.quit();

  // As 0.0.12 kept the profile: no sources, and the documents themselves.
  const guides = join(d.profile, "guides");
  const list = JSON.parse(await readFile(join(guides, "sources.json"), "utf8")) as {
    sources: { origin: string; identity: string; sealedAddress: string }[];
  };
  const [added] = list.sources;
  if (!added) throw new Error("The guide wasn't kept.");
  await rm(guides, { recursive: true });
  const meta = join(d.profile, "guide.json");
  const { key, fetchedAt: ownFetchedAt } = JSON.parse(await readFile(meta, "utf8")) as {
    key: string;
    fetchedAt: number;
  };
  for (const name of await readdir(d.profile))
    if (name.startsWith("guide-index.")) await rm(join(d.profile, name));
  await writeFile(meta, JSON.stringify({ key, fetchedAt: ownFetchedAt }));
  await writeFile(join(d.profile, "guide.xml"), guide("Own", "own.test", 1));
  // Downloaded an hour before the upgrade: recent, so only the move makes it download again.
  const keptAt = Date.now() - 60 * 60 * 1000;
  const document = `guide-external.${randomUUID()}.xml`;
  await writeFile(join(d.profile, document), guide("Before", MAPPED, 20));
  await writeFile(
    join(d.profile, "guide-source.json"),
    JSON.stringify({
      version: 1,
      key,
      external: {
        origin: added.origin,
        identity: added.identity,
        sealedAddress: added.sealedAddress,
        document: { file: document, fetchedAt: keptAt },
      },
      mappings: { [loose]: { guideId: MAPPED, name: "Mapped" } },
    }),
  );

  const asked = host.requests().length;
  const began = performance.now();
  d.action("Start the upgraded profile");
  await d.launch();
  await d
    .wait(async () => host.requests().length > asked, ASKED_WITHIN_MS)
    .catch(async () => {
      // What the move made of it, to tell a source that waits from one that never came over.
      d.observed["movedSourceUnasked"] = await sources();
      throw new Error(`The address wasn't asked for within ${ASKED_WITHIN_MS} ms of the start.`);
    });
  d.observed["addressAskedAfterStartMs"] = Math.round(performance.now() - began);

  await d.wait(async () => {
    const [moved] = await sources();
    return (
      moved?.processing.state === "ready" &&
      moved.processing.fetchedAt !== undefined &&
      moved.processing.fetchedAt > keptAt
    );
  });
  const [moved] = await sources();
  d.observed["movedSource"] = moved;
  d.observed["addressRequests"] = host.requests().length - asked;
  if (host.requests().length - asked !== 1)
    throw new Error(`The address was asked for ${host.requests().length - asked} times.`);
  await openGuides();
  await d.wait(() =>
    d.evaluate<boolean>(`[...document.querySelectorAll('main li')].some(row =>
      row.textContent.includes(${JSON.stringify(new URL(host.origin).host)}) &&
      row.textContent.includes('Ready'))`),
  );
  await d.capture("guides-after-upgrade");
  // The source's own download lets go of what 0.0.12 kept for the address.
  await d.wait(async () => !(await readdir(d.profile)).includes(document));
  d.observed["keptDownloadLetGo"] = true;
  const mapping = await d.evaluate<{ mapped: number; unresolved: number } | null>(`(async () => {
    const read = await window.mrStreamer.invoke('guide.status');
    const own = read.ok ? read.value[0] : undefined;
    return own ? { mapped: own.mapped, unresolved: own.unresolved } : null;
  })()`);
  d.observed["mapping"] = mapping;
  if (mapping?.mapped !== 1 || mapping.unresolved !== 0)
    throw new Error(`The mapping didn't come over: ${JSON.stringify(mapping)}`);
}

/**
 * An XMLTV document of one-minute programmes on `channels` channels from an hour back, each
 * called after `label`: `id`, then fillers nobody lists. Twenty make one large enough to be
 * indexed for a few seconds.
 */
function guide(label: string, id: string, channels: number): string {
  const stamp = (at: number) =>
    `${new Date(at).toISOString().slice(0, 19).replace(/[-T:]/g, "")} +0000`;
  const first = Math.floor(Date.now() / 60_000) * 60_000 - 60 * 60_000;
  const parts = ['<?xml version="1.0" encoding="utf-8"?><tv>'];
  for (let channel = 0; channel < channels; channel++) {
    const named = channel === 0 ? id : `${label.toLowerCase()}-${channel}.filler`;
    parts.push(`<channel id="${named}"><display-name>${named}</display-name></channel>`);
    for (let minute = 0; minute < 10_000; minute++) {
      const start = first + minute * 60_000;
      parts.push(
        `<programme start="${stamp(start)}" stop="${stamp(start + 60_000)}" channel="${named}"><title>${label} ${minute % 97}</title></programme>`,
      );
    }
  }
  parts.push("</tv>");
  return parts.join("\n");
}
