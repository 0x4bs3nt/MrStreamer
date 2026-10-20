// Settings > Guides with two guides from one host, which only their names tell apart.
//
// `guide-labels`: one fake guide host serves /a.xml and /b.xml, each behind the host's key, and
// each lists a channel of `TEST | Formats and failures` the other doesn't. Both are added
// unnamed, so their rows read as the host with the start of each one's id. A is renamed
// "Netherlands" with Enter, B "Netherlands" too by leaving the field, which tags both again;
// Escape on B keeps that, and Enter renames it "United Kingdom". Every row and button reads
// differently in each of those. Move United Kingdom up keeps the keyboard on its other arrow; the
// subscription's Guide row and the mapping sheet use the same names; a restart keeps them; B
// failing with HTTP 503 says so as Retry United Kingdom. The names are read in all five interface
// languages at 1280 and 900 px. Back in English, A's name is cleared, B is removed, the keyboard
// lands on A's Remove, and B is added again with a name from the add form. Neither the paths nor
// the key show in the page's text, its attributes or its accessibility tree.
import { LANGUAGE_NAMES, type Locale } from "../../../../packages/contracts/src/language.ts";
import {
  translate,
  type MessageArgs,
  type MessageKey,
} from "../../../../packages/core/src/i18n.ts";
import { GUIDE_KEY, type GuideHost } from "../../../../apps/desktop/test/fake-guide-host.ts";
import type { Driver } from "./language.ts";

/** The channels the fake provider names by a guide's id, by the name it lists them under. */
export const LABELLED = {
  a: { name: "TEST | H.264 + MP2", guideId: "a.src" },
  b: { name: "TEST | H.264 + MP3", guideId: "b.src" },
} as const;

/** The provider's guide id for a channel named `name`: a guide's for those above. */
export const labelledGuideId = (name: string): string | undefined =>
  Object.values(LABELLED).find((each) => each.name === name)?.guideId;

const SLOT = 30 * 60 * 1000;
const stamp = (at: number) =>
  `${new Date(at).toISOString().slice(0, 19).replace(/[-T:]/g, "")} +0000`;

/** An XMLTV document of half-hour programmes from an hour back to a day ahead on `id`. */
function xmltv(id: string): string {
  const first = Math.floor(Date.now() / SLOT) * SLOT - 2 * SLOT;
  const programmes = Array.from({ length: 50 }, (_, slot) => {
    const start = first + slot * SLOT;
    return `<programme start="${stamp(start)}" stop="${stamp(start + SLOT)}" channel="${id}"><title>${id} ${slot}</title></programme>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?><tv><channel id="${id}"><display-name>${id}</display-name></channel>${programmes.join("")}</tv>`;
}

/** Puts A's and B's guides behind their paths. */
export function serveLabelled(host: GuideHost): void {
  host.serve("/a.xml", xmltv(LABELLED.a.guideId));
  host.serve("/b.xml", xmltv(LABELLED.b.guideId));
}

const expect = (ok: boolean, message: string, seen?: unknown) => {
  if (!ok) throw new Error(`${message}${seen === undefined ? "" : `: ${JSON.stringify(seen)}`}`);
};

/** The interface language select of Settings > General. */
const LANGUAGE = `document.querySelector('main section select:has(option[value="en-US"])')`;

export async function guideLabelsScenario(d: Driver, host: GuideHost): Promise<void> {
  const hostName = new URL(host.origin).host;
  let locale: Locale = "en-US";
  /** `key` in the language shown. */
  const tr = <K extends MessageKey>(key: K, ...params: MessageArgs<K>) =>
    translate(locale, key, ...params);
  const byText = (selector: string, text: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
  const labelled = (label: string) =>
    `document.querySelector(${JSON.stringify(`[aria-label="${label.replaceAll('"', '\\"')}"]`)})`;
  const addressField = () => labelled(tr("Address of an XMLTV guide"));
  const nameField = () => labelled(tr("Name of the guide"));
  /** Each row as drawn: its first line, its second, whether it is red, and its buttons' names. */
  const rows = () =>
    d.evaluate<{ name: string; state: string; failing: boolean; buttons: string[] }[]>(
      `[...document.querySelectorAll('[data-settings-section=guides] li[data-source]')].map(row => {
        const [name, state] = row.firstElementChild?.children ?? [];
        return { name: name?.textContent ?? '', state: state?.textContent ?? '',
          failing: state?.className.includes('text-destructive') ?? false,
          buttons: [...row.querySelectorAll('button')].map(b => b.getAttribute('aria-label') ?? b.textContent.trim()) };
      })`,
    );
  const focused = () =>
    d.evaluate<string | null>("document.activeElement?.getAttribute('aria-label') ?? null");
  /** The rows' first lines once they read `names`, and every row and button name distinct. */
  const named = async (names: readonly string[], why: string) => {
    await d.wait(async () => (await rows()).map((each) => each.name).join("|") === names.join("|"));
    const all = (await rows()).flatMap((each) => [each.name, ...each.buttons]);
    expect(new Set(all).size === all.length, `${why}: two names read alike`, all);
    return rows();
  };
  const width = async (pixels: number) => {
    d.action(`Size the page ${pixels} px wide`);
    await d.send("Emulation.setDeviceMetricsOverride", {
      width: pixels,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // The viewport takes the width before the page is laid out at it: wait for the fonts, and for
    // the rows to measure the same over two frames, before anything is read or captured.
    await d.wait(() =>
      d.evaluate<boolean>(`(async () => {
        if (innerWidth !== ${pixels}) return false;
        await document.fonts.ready;
        const measure = () => [...document.querySelectorAll('[data-settings-section=guides] li[data-source]')]
          .map(row => { const box = row.getBoundingClientRect(); return box.width + 'x' + box.height; }).join();
        const before = measure();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return measure() === before;
      })()`),
    );
  };
  const openGuides = async () => {
    if (!(await d.exists(byText("nav button", tr("Guides"))))) {
      await d.click(
        "Open Settings",
        `document.querySelector('header button[aria-label="${tr("Settings")}"]')`,
      );
    }
    await d.click("Open Guides", byText("nav button", tr("Guides")));
    await d.wait(() => d.exists(addressField()));
  };
  /**
   * Adds guide A or B through the form, named `name`, and waits for it as the `count`th row,
   * ready. The actions name the guide by its letter: its path stays out of the proof.
   */
  const add = async (guide: "A" | "B", name: string | null, count: number) => {
    await d.click(`Focus the address field for ${guide}`, addressField());
    d.action(`Type ${guide}'s address, with the host's key`);
    await d.send("Input.insertText", { text: host.address(guide === "A" ? "/a.xml" : "/b.xml") });
    if (name !== null) {
      await d.click("Focus the name field", nameField());
      d.action(`Type the name ${name}`);
      await d.send("Input.insertText", { text: name });
    }
    await d.click(`Add ${guide}`, byText("main form button", tr("Add")));
    await d.wait(async () => {
      const shown = await rows();
      return shown.length === count && /Ready/.test(shown.at(-1)?.state ?? "");
    });
    const fields = await d.evaluate<string[]>(`[${addressField()}.value, ${nameField()}.value]`);
    expect(fields.join("") === "", "The add form kept what was typed", fields);
  };
  /**
   * Renames the row called `from` to `to` by typing, ending with `end`, captured as `shot`. It
   * returns once the field closes, which is before the name is saved: wait for the names it brings.
   */
  const rename = async (
    from: string,
    to: string,
    end: "Enter" | "Escape" | "leave",
    shot?: string,
  ) => {
    await d.click(`Rename ${from}`, labelled(tr("Rename {name}", { name: from })));
    await d.wait(async () => (await focused()) === tr("Name of the guide"));
    // The field starts with all of its name selected: typing replaces it.
    if (to === "") await d.key("Backspace", 8);
    else {
      d.action(`Type ${to}`);
      await d.send("Input.insertText", { text: to });
    }
    if (shot) await d.capture(shot);
    if (end === "Enter") await d.key("Enter", 13);
    else if (end === "Escape") await d.key("Escape", 27);
    else
      await d.click(
        "Leave the name field",
        "document.querySelector('[data-settings-section=guides] h2')",
      );
    await d.wait(
      async () =>
        !(await d.exists(`document.querySelector('[data-settings-section=guides] li input')`)),
    );
  };
  /** Neither path nor key in the page's text, attributes or accessibility tree. */
  const private_ = async (where: string) => {
    const page = await d.evaluate<string>(
      `document.body.innerText + [...document.querySelectorAll('*')].flatMap(e => [...e.attributes].map(a => a.value)).join(' ') + [...document.querySelectorAll('input')].map(i => i.value).join(' ')`,
    );
    const tree = JSON.stringify(await d.send("Accessibility.getFullAXTree"));
    for (const secret of [GUIDE_KEY, "/a.xml", "/b.xml"]) {
      expect(!page.includes(secret) && !tree.includes(secret), `${where} shows ${secret}`);
    }
  };

  await width(1280);
  await openGuides();
  // Unnamed, two guides from one host read as the host and the start of each one's id.
  await add("A", null, 1);
  await add("B", null, 2);
  const tag = new RegExp(`^${hostName.replaceAll(".", "\\.")} [0-9a-f]{4,}$`);
  await d.wait(async () => (await rows()).every((row) => tag.test(row.name)));
  const tagged = await named(
    (await rows()).map((each) => each.name),
    "Unnamed",
  );
  d.observed["unnamed"] = tagged;
  const tagA = tagged[0]?.name ?? "";
  await d.capture("labels-unnamed-1280");
  await private_("The unnamed rows");

  await rename(tagA, "Netherlands", "Enter");
  await named(["Netherlands", hostName], "A named");
  expect((await focused()) === "Rename Netherlands", "Enter didn't hand the keyboard back");
  // A name alike another, case aside, tags both again.
  await rename(hostName, "netherlands", "leave");
  await d.wait(async () => {
    const [a, b] = await rows();
    return (
      /^Netherlands [0-9a-f]{4,}$/.test(a?.name ?? "") &&
      /^netherlands [0-9a-f]{4,}$/.test(b?.name ?? "")
    );
  });
  const alike = await named(
    (await rows()).map((each) => each.name),
    "Two named alike",
  );
  expect(
    alike.every((row) => /^[Nn]etherlands [0-9a-f]{4,}$/.test(row.name)),
    "Two guides named alike aren't tagged",
    alike,
  );
  d.observed["namedAlike"] = alike;
  await d.capture("labels-alike-1280");
  const alikeB = alike[1]?.name ?? "";
  await rename(alikeB, "Belgium", "Escape");
  await named([alike[0]?.name ?? "", alikeB], "Escape");
  expect((await focused()) === `Rename ${alikeB}`, "Escape didn't hand the keyboard back");
  await rename(alikeB, "United Kingdom", "Enter", "labels-renaming-1280");
  const both = await named(["Netherlands", "United Kingdom"], "Renamed");
  expect(
    both.every((row) => row.state.startsWith(`${hostName} · Ready`)),
    "A named row's second line doesn't lead with its host",
    both,
  );
  d.observed["named"] = both;
  await d.capture("labels-named-1280");

  await d.click("Move United Kingdom up", labelled("Move United Kingdom up"));
  await named(["United Kingdom", "Netherlands"], "Moved");
  await d.wait(async () => (await focused()) === "Move United Kingdom down");
  d.observed["focusAfterMove"] = await focused();
  await d.capture("labels-moved-1280");

  // The subscription's Guide row and the mapping sheet say the same names.
  await d.click("Open Subscriptions", byText("nav button", "Subscriptions"));
  const guideRow = () =>
    d.evaluate<string>("[...document.querySelectorAll('main:not([hidden])')].at(-1).innerText");
  await d.wait(async () => /1 United Kingdom · 1 Netherlands/.test(await guideRow()));
  d.observed["guideRow"] = (await guideRow())
    .split("\n")
    .find((line) => line.includes("United Kingdom"));
  await d.capture("labels-subscription-1280");
  await d.click(
    "Open Map",
    `[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith('Map channels of'))`,
  );
  const search = `document.querySelector('[role=dialog] input[aria-label="Search guide channels"]')`;
  await d.wait(() => d.exists(search));
  await d.click("Search the guide channels", search);
  await d.evaluate(`${search}.select()`);
  d.action("Type src");
  await d.send("Input.insertText", { text: "src" });
  const options = () =>
    d.evaluate<string[]>(
      `[...(document.querySelectorAll('[role=dialog] [role=listbox]')[1]?.querySelectorAll('[role=option]') ?? [])].map(o => o.textContent)`,
    );
  await d.wait(async () => {
    const shown = (await options()).join("|");
    return shown.includes("United Kingdom · b.src") && shown.includes("Netherlands · a.src");
  });
  d.observed["mapOptions"] = await options();
  await d.capture("labels-map-1280");
  await private_("The mapping sheet");
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists("document.querySelector('[role=dialog]')")));

  // A restart keeps the names and the order.
  await d.quit();
  await d.launch();
  await openGuides();
  await named(["United Kingdom", "Netherlands"], "Restarted");
  await d.capture("labels-restarted-1280");

  // Refreshed, and B failing.
  await d.click("Refresh Netherlands", labelled("Refresh Netherlands"));
  host.serve("/b.xml", 503);
  await d.click("Refresh United Kingdom", labelled("Refresh United Kingdom"));
  await d.wait(async () => (await rows())[0]?.failing === true);
  const failed = await named(["United Kingdom", "Netherlands"], "Failed");
  expect(
    failed[0]?.buttons.includes("Retry United Kingdom") === true &&
      failed[0].state.startsWith(`${hostName} · `) &&
      failed[0].state.includes("HTTP 503"),
    "The failing row doesn't say so by its name",
    failed[0],
  );
  d.observed["failed"] = failed;
  await d.capture("labels-failed-1280");
  await width(900);
  await d.capture("labels-failed-900");
  await private_("The failing rows");

  // Each interface language names the buttons alike, in its own words.
  const pick = async (next: Locale) => {
    await d.click("Open General", byText("nav button", tr("General")));
    await d.wait(() => d.exists(LANGUAGE));
    d.action(`Pick ${LANGUAGE_NAMES[next]} with the keyboard`);
    await d.evaluate(`${LANGUAGE}.focus()`);
    for (const char of LANGUAGE_NAMES[next].slice(0, 2)) {
      await d.send("Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char });
      await d.send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
    }
    await d.wait(async () => (await d.evaluate<string>("document.documentElement.lang")) === next);
    locale = next;
    await openGuides();
  };
  const languages: Record<string, unknown> = {};
  for (const each of ["en-US", "nl-NL", "de-DE", "fr-FR", "es-ES"] as const) {
    if (each !== locale) await pick(each);
    const shown = await named(["United Kingdom", "Netherlands"], each);
    const wanted = [
      tr("Retry {name}", { name: "United Kingdom" }),
      tr("Rename {name}", { name: "United Kingdom" }),
      tr("Move {name} down", { name: "United Kingdom" }),
      tr("Remove {name}", { name: "United Kingdom" }),
      tr("Refresh {name}", { name: "Netherlands" }),
      tr("Rename {name}", { name: "Netherlands" }),
      tr("Move {name} up", { name: "Netherlands" }),
      tr("Remove {name}", { name: "Netherlands" }),
    ];
    const buttons = shown.flatMap((row) => row.buttons);
    expect(
      wanted.every((label) => buttons.includes(label)),
      `${each} doesn't name the buttons`,
      buttons,
    );
    const placeholder = await d.evaluate<string>(`${nameField()}?.placeholder ?? ''`);
    expect(placeholder === tr("Name, optional"), `${each}'s name field isn't labelled`);
    languages[each] = buttons;
    await width(1280);
    await d.capture(`labels-${each}-1280`);
    await width(900);
    await d.capture(`labels-${each}-900`);
  }
  d.observed["languages"] = languages;
  await pick("en-US");
  await width(1280);

  // Cleared, a name gives way to the host; removed, the keyboard goes to the row that took its place.
  await rename("Netherlands", "", "Enter");
  await named(["United Kingdom", hostName], "Cleared");
  await d.click("Remove United Kingdom", labelled("Remove United Kingdom"));
  await named([hostName], "Removed");
  await d.wait(async () => (await focused()) === `Remove ${hostName}`);
  d.observed["focusAfterRemove"] = await focused();
  // Added again with a name from the add form.
  host.serve("/b.xml", xmltv(LABELLED.b.guideId));
  await add("B", "United Kingdom", 2);
  d.observed["final"] = await named([hostName, "United Kingdom"], "Added with a name");
  await d.capture("labels-final-1280");
  await private_("The final rows");
}
