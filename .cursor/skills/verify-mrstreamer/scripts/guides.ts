// Settings > Guides: XMLTV guides of the viewer's own, which every subscription reads after its
// own guide, in their order.
//
// `guides`: two fake guide hosts, North and South, each list a channel the other doesn't and one
// both do; the provider's channel list names those three channels by ids its own guide doesn't
// have. Both are added through the field and Add, and each row is seen moving through its states
// as it downloads and is read. Live TV then shows the merged guide: the provider's own channels
// keep its programmes, North's and South's channels show theirs, and the shared one shows the
// first source's. Moving South up gives the shared channel South's programmes. A download of
// North that fails says why in red and since when, and its last download stays in use. Each
// state is captured at 1280 px wide, and the result at 1280 and 900.
import type { GuideHost } from "../../../../apps/desktop/test/fake-guide-host.ts";
import type { Driver } from "./language.ts";

/** The channels the fake provider names by a source's guide id, by the name it lists them under. */
export const SOURCED = {
  north: { name: "TEST | H.264 + MP2", guideId: "north.src" },
  south: { name: "TEST | H.264 + MP3", guideId: "south.src" },
  shared: { name: "TEST | H.264 + AC-3", guideId: "shared.src" },
} as const;

/** The provider's guide id for a channel named `name`: a source's for those above. */
export const sourcedGuideId = (name: string): string | undefined =>
  Object.values(SOURCED).find((each) => each.name === name)?.guideId;

const SLOT = 30 * 60 * 1000;
const stamp = (at: number) =>
  `${new Date(at).toISOString().slice(0, 19).replace(/[-T:]/g, "")} +0000`;

/**
 * An XMLTV document of half-hour programmes from two hours back to a day ahead, each called after
 * `label` and its channel, for `ids` and `filler` more channels nobody lists, which give it a
 * size that takes a moment to download and read.
 */
function xmltv(label: string, ids: readonly string[], filler: number): string {
  const first = Math.floor(Date.now() / SLOT) * SLOT - 4 * SLOT;
  const all = [...ids, ...Array.from({ length: filler }, (_, at) => `${label}-${at}.filler`)];
  const parts = ['<?xml version="1.0" encoding="utf-8"?><tv>'];
  for (const id of all)
    parts.push(`<channel id="${id}"><display-name>${id}</display-name></channel>`);
  for (const id of all) {
    for (let slot = 0; slot < 52; slot++) {
      const start = first + slot * SLOT;
      parts.push(
        `<programme start="${stamp(start)}" stop="${stamp(start + SLOT)}" channel="${id}"><title>${label} ${id}</title></programme>`,
      );
    }
  }
  parts.push("</tv>");
  return parts.join("\n");
}

/**
 * Puts each host's guide behind its address, with its length. South's is big and sent in small
 * pieces, as a slow link does, so its row is seen downloading and reading for a while.
 */
export function serveGuides(north: GuideHost, south: GuideHost): void {
  for (const [host, label, ids, filler, pieceBytes] of [
    [north, "North", [SOURCED.north.guideId, SOURCED.shared.guideId], 400, 4096],
    [south, "South", [SOURCED.south.guideId, SOURCED.shared.guideId], 3000, 128],
  ] as const) {
    const document = Buffer.from(xmltv(label, ids, filler));
    host.serve("/guide.xml", document, {
      pieceBytes,
      headers: {
        "Content-Type": "application/xml",
        "Content-Length": String(document.length),
      },
    });
  }
}

interface Source {
  readonly id: string;
  readonly origin: string;
  readonly processing: { readonly state: string; readonly total?: number | null };
}

const expect = (ok: boolean, message: string, seen?: unknown) => {
  if (!ok) throw new Error(`${message}${seen === undefined ? "" : `: ${JSON.stringify(seen)}`}`);
};

export async function guidesScenario(
  d: Driver,
  hosts: { readonly north: GuideHost; readonly south: GuideHost },
): Promise<void> {
  const hostName = (host: GuideHost) => new URL(host.origin).host;
  const byText = (selector: string, text: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
  const field = `document.querySelector('input[aria-label="Address of an XMLTV guide"]')`;
  // Read-only: what the rows are drawn from.
  const sources = () =>
    d.evaluate<Source[]>(`(async () => {
      const read = await window.mrStreamer.invoke('guide.sources');
      return read.ok ? read.value : [];
    })()`);
  /** Each row of Settings > Guides as drawn: its host, its state line, and whether it is red. */
  const rows = () =>
    d.evaluate<{ host: string; state: string; failing: boolean }[]>(
      `[...document.querySelectorAll('main li')].map(row => {
        const [host, state] = row.firstElementChild?.children ?? [];
        return { host: host?.textContent ?? '', state: state?.textContent ?? '',
          failing: state?.className.includes('text-destructive') ?? false };
      })`,
    );
  const width = async (pixels: number) => {
    d.action(`Size the page ${pixels} px wide`);
    await d.send("Emulation.setDeviceMetricsOverride", {
      width: pixels,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await d.wait(() => d.evaluate<boolean>(`innerWidth === ${pixels}`));
  };

  /**
   * Adds `host`'s guide through the field and Add, and follows its row until it is ready,
   * capturing each state the first time the row shows it.
   */
  const add = async (name: string, host: GuideHost) => {
    await d.click(`Focus the address field for ${name}`, field);
    d.action(`Type ${name}'s address`);
    await d.send("Input.insertText", { text: host.address() });
    await d.click(`Add ${name}`, byText("main form button", "Add"));
    const seen: string[] = [];
    const lines: string[] = [];
    /** What the row said right after each capture, which the screenshot may show instead. */
    const captured: { shot: string; shown: string }[] = [];
    const deadline = Date.now() + 60_000;
    for (;;) {
      const row = (await rows()).find((each) => each.host === hostName(host));
      const state = row?.state.split(" ")[0] ?? "";
      if (row && lines.at(-1) !== row.state) lines.push(row.state);
      // Each state once, and a download once it says how much of how much.
      const shot = row?.state.includes(" of ") ? "Downloading-size" : state;
      if (row && !seen.includes(shot)) {
        seen.push(shot);
        await d.capture(`guides-${name.toLowerCase()}-${shot.toLowerCase()}`);
        const after = (await rows()).find((each) => each.host === hostName(host))?.state ?? "";
        captured.push({ shot, shown: after });
      }
      if (state === "Ready") break;
      expect(Date.now() < deadline, `${name} never became ready`, lines);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    d.observed[`${name.toLowerCase()}States`] = lines;
    d.observed[`${name.toLowerCase()}Captures`] = captured;
    expect(
      lines[0]?.startsWith("Downloading") === true,
      `${name}'s row didn't start downloading`,
      lines,
    );
    expect((await d.evaluate<string>(`${field}.value`)) === "", "The field kept the address");
    return lines;
  };

  /** Live TV's rows of the sourced channels and the provider's own: what each shows on now. */
  /** A channel's name as Live TV's rows draw it, without the "TEST | " its category shares. */
  const drawn = (name: string) => name.replace(/^TEST \| /, "");
  const liveTv = async () => {
    // Settings lies over the app with a header of its own: its Back is the last.
    const back =
      "[...document.querySelectorAll('header button')].findLast(b => b.textContent.trim() === 'Back')";
    if (await d.exists(back)) await d.click("Leave Settings", back);
    await d.click("Open Live TV", byText("header button", "Live TV"));
    await d.click(
      "Open TEST | Formats and failures",
      `[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('TEST | Formats'))`,
    );
    const names = [
      "TEST | H.264 + AAC",
      SOURCED.north.name,
      SOURCED.south.name,
      SOURCED.shared.name,
    ];
    const read = () =>
      d.evaluate<Record<string, string>>(`Object.fromEntries(
        [...document.querySelectorAll('[data-index]')].map(row => [
          row.querySelector('[title]')?.firstElementChild?.textContent.trim() ?? '',
          row.innerText,
        ]))`);
    await d.wait(async () => {
      const shown = await read();
      return names.every((name) => drawn(name) in shown);
    });
    const shown = await read();
    return (name: string) => shown[drawn(name)] ?? "";
  };
  const openGuides = async () => {
    await d.click("Open Settings", "document.querySelector('button[aria-label=Settings]')");
    await d.click("Open Guides", byText("nav button", "Guides"));
    await d.wait(() => d.exists(field));
  };

  await width(1280);
  await openGuides();
  await d.capture("guides-empty");
  await add("North", hosts.north);
  const south = await add("South", hosts.south);
  // South's guide is big enough that its row is seen downloading, with how much of how much,
  // and reading, before it is ready.
  expect(
    south.some((line) => / of /.test(line)) && south.some((line) => line.startsWith("Reading")),
    "South's row wasn't seen downloading with its size and then reading",
    south,
  );
  const listed = await rows();
  d.observed["rows"] = listed;
  expect(
    listed.map((row) => row.host).join() === [hosts.north, hosts.south].map(hostName).join(),
    "The rows aren't in the order added",
    listed,
  );
  expect(
    listed.every((row) =>
      /^Ready · \d+ channels? · .* programmes · until .* · updated /.test(row.state),
    ),
    "A ready row doesn't say what it supplies",
    listed,
  );
  expect(
    hosts.north.requests().length === 1 && hosts.south.requests().length === 1,
    "A source was downloaded more than once",
  );
  await d.capture("guides-ready");

  // The merged guide: the own guide first, then North, then South.
  let now = await liveTv();
  d.observed["liveTvBefore"] = Object.fromEntries(
    [SOURCED.north, SOURCED.south, SOURCED.shared].map(({ name }) => [name, now(name)]),
  );
  expect(/ News \d+/.test(now("TEST | H.264 + AAC")), "The provider's own guide is gone");
  expect(
    now(SOURCED.north.name).includes("North north.src"),
    "North's channel lacks North's guide",
  );
  expect(
    now(SOURCED.south.name).includes("South south.src"),
    "South's channel lacks South's guide",
  );
  expect(
    now(SOURCED.shared.name).includes("North shared.src"),
    "The shared channel isn't North's, the first in order",
  );
  await d.capture("live-tv-north-first");

  await openGuides();
  await d.click(
    "Move South up",
    `document.querySelector('[aria-label="Move ${hostName(hosts.south)} up"]')`,
  );
  await d.wait(
    async () =>
      (await sources()).map((each) => each.origin).join() ===
      [hosts.south.origin, hosts.north.origin].join(),
  );
  await d.wait(async () => (await rows())[0]?.host === hostName(hosts.south));
  await d.capture("guides-south-first");
  now = await liveTv();
  d.observed["liveTvAfter"] = Object.fromEntries(
    [SOURCED.north, SOURCED.south, SOURCED.shared].map(({ name }) => [name, now(name)]),
  );
  expect(
    now(SOURCED.shared.name).includes("South shared.src"),
    "The shared channel didn't move to South",
  );
  expect(now(SOURCED.north.name).includes("North north.src"), "North's channel lost its guide");
  await d.capture("live-tv-south-first");

  // North fails: its row says why, in red, and its last download stays in use.
  hosts.north.serve("/guide.xml", 503);
  await openGuides();
  await d.click(
    "Refresh North",
    `document.querySelector('[aria-label="Refresh ${hostName(hosts.north)}"]')`,
  );
  await d.wait(async () =>
    (await rows()).some((row) => row.host === hostName(hosts.north) && row.failing),
  );
  const failed = (await rows()).find((row) => row.host === hostName(hosts.north));
  d.observed["failedRow"] = failed;
  expect(
    !!failed &&
      failed.state.startsWith("Failed since ") &&
      failed.state.includes(`${hostName(hosts.north)} answered with an error (HTTP 503).`) &&
      failed.state.includes("stay in use"),
    "The failing row doesn't say why, since when, and what stays in use",
    failed,
  );
  await d.capture("guides-failed-1280");
  await width(900);
  await d.capture("guides-failed-900");

  // Each subscription's Guide row says where its programmes come from.
  await d.click("Open Subscriptions", byText("nav button", "Subscriptions"));
  await d.wait(() =>
    d.evaluate<boolean>(
      `[...document.querySelectorAll('main')].at(-1).innerText.includes(${JSON.stringify(`1 ${hostName(hosts.north)}`)})`,
    ),
  );
  d.observed["guideRow"] = await d.evaluate<string>(
    "[...document.querySelectorAll('main')].at(-1).innerText",
  );
  await d.capture("subscriptions-guide-900");
  await width(1280);
  await d.capture("subscriptions-guide-1280");

  now = await liveTv();
  expect(now(SOURCED.north.name).includes("North north.src"), "North's failure dropped its guide");
  await d.capture("live-tv-1280");
  await width(900);
  await d.capture("live-tv-900");
}
