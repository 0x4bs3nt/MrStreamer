// The prior stable release and this build on one profile, each driven through its own window.
// This build makes a list holding channels of two subscriptions and chooses it in Live TV. The
// prior release, which knows nothing of lists, starts on the same profile: it shows its own
// choice, records its own favourite, removes the second subscription with Also delete, adds the
// same account again and records a watch and a favourite of it. This build starts again: the
// list is chosen still, the first account's channels are in it as they were, nothing of the
// erased account comes back however much the prior release recorded for it since, the prior
// release's viewing shows, and a channel of the account added again goes in the list anew.
//
// What the database holds between the runs is read, never written, as diagnostics apart from
// the user paths: the anchors and channels of each account, and the remembered choice.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  FIRST,
  SECOND,
  addBackup,
  makeList,
  openList,
  rowMenu,
  shownRows,
  tick,
} from "./custom-lists.ts";
import type { Driver } from "./language.ts";

/** A driver that can also start the prior release's app on the run's profile. */
interface RoundTripDriver extends Driver {
  launch(system?: string, which?: "candidate" | "prior"): Promise<void>;
}

const named = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;
const SETTINGS = "document.querySelector('header button[aria-pressed]')";
const HEADING = "document.querySelector('main h1')?.textContent";
const SUBSCRIPTION_ROWS = "document.querySelectorAll('main section > ul > li')";
const row = (name: string) =>
  `[...document.querySelectorAll('main [data-index]')].find(r => r.querySelector('[title=${JSON.stringify(name)}]'))`;
const check = (value: boolean, message: string) => {
  if (!value) throw new Error(message);
};

/** Read-only diagnostics of the profile's database: never a user path, never a write. */
function onDisk(profile: string, account: string) {
  const db = new DatabaseSync(join(profile, "mrstreamer.db"), { readOnly: true });
  try {
    const count = (sql: string, ...params: string[]) =>
      Number(db.prepare(sql).get(...params)?.["n"] ?? 0);
    return {
      lists: count("select count(*) as n from custom_lists"),
      membersOfErased: count(
        "select count(*) as n from custom_list_members where account = ?",
        account,
      ),
      membersOfOthers: count(
        "select count(*) as n from custom_list_members where account <> ?",
        account,
      ),
      anchorsOfErased: count(
        "select count(*) as n from events where account = ? and type = 'list-anchor'",
        account,
      ),
      eventsOfErased: db
        .prepare("select type from events where account = ? order by sequence")
        .all(account)
        .map((each) => String(each["type"])),
    };
  } finally {
    db.close();
  }
}

/** What preferences.json remembers of discovery, read-only. */
async function remembered(profile: string): Promise<unknown> {
  const file = JSON.parse(await readFile(join(profile, "preferences.json"), "utf8")) as Record<
    string,
    unknown
  >;
  return file["rememberedLiveBrowse"] ?? null;
}

/** Removes the second subscription from Settings with Also delete ticked: the same in both builds. */
async function eraseBackup(d: Driver) {
  await d.click("Open Settings to remove a subscription", SETTINGS);
  await d.click("Open Subscriptions", named("nav button", "Subscriptions"));
  const item = `${SUBSCRIPTION_ROWS}[1]`;
  if (!(await d.exists(`${item}.querySelector('[role=region]')`)))
    await d.click("Open the second subscription", `${item}.querySelector('button')`);
  await d.click(
    "Ask to remove it",
    `[...${item}.querySelectorAll('button')].find(e => e.textContent.startsWith('Remove '))`,
  );
  await d.click("Tick Also delete", `${item}.querySelector('[role=checkbox]')`);
  await d.click(
    "Remove with Also delete",
    `[...${item}.querySelectorAll('button')].find(e => e.textContent === 'Remove')`,
  );
  await d.wait(() =>
    d.evaluate<boolean>(
      "(async () => { const r = await window.mrStreamer.invoke('subscription.list'); return r.ok && r.value.length === 1; })()",
    ),
  );
  await d.key("Escape", 27);
}

/**
 * Finds a channel in All channels by its list search, in whichever build. All channels is picked
 * only when it isn't what shows: picking it is a choice, which takes the remembered one's place.
 */
async function search(d: Driver, name: string, text: string) {
  await d.click("Open Live TV", named("header button", "Live TV"));
  await d.wait(async () => typeof (await d.evaluate<string | undefined>(HEADING)) === "string");
  if ((await d.evaluate<string | undefined>(HEADING)) !== "All channels")
    await d.click(
      "Open All channels",
      "document.querySelector('[role=navigation] button[title=\"All channels\"]')",
    );
  await d.wait(async () => (await d.evaluate<string | undefined>(HEADING)) === "All channels");
  const field = `document.querySelector('main input[aria-label^="Search "]')`;
  if ((await d.evaluate<string>(`${field}?.value ?? ''`)) !== "")
    await d.click(
      "Clear the search",
      "document.querySelector('main button[aria-label=\"Clear search\"]')",
    );
  await d.click("Search All channels", field);
  await d.send("Input.insertText", { text });
  await d.wait(() => d.exists(row(name)));
}

export async function customListRoundTripScenario(
  d: RoundTripDriver,
  fixture: { otherUrl: string; otherOrigin: string },
) {
  const erased = `${fixture.otherUrl}|demo`;
  const HEVC = "TEST | HEVC + AAC";

  // This build: a list holding channels of both subscriptions, chosen in Live TV.
  await addBackup(d, fixture.otherUrl);
  await d.click("Open Live TV", named("header button", "Live TV"));
  await makeList(d, "Round trip");
  await openList(d, "All channels");
  for (const [name, text] of [
    [FIRST, "H.264 + AAC"],
    [SECOND, "H.264 + AAC"],
    [HEVC, "HEVC"],
  ] as const) {
    await rowMenu(d, name, text);
    await tick(d, "Round trip", true);
  }
  await d.click(
    "Clear the list search",
    "document.querySelector('main button[aria-label=\"Clear search\"]')",
  );
  await openList(d, "Round trip");
  await d.wait(async () => (await shownRows(d)).length === 3);
  d.observed["candidateBefore"] = await shownRows(d);
  await d.capture("candidate-before");
  await d.quit();
  d.observed["diskAfterCandidate"] = onDisk(d.profile, erased);
  d.observed["rememberedAfterCandidate"] = await remembered(d.profile);

  // The prior release on the same profile.
  await d.launch("en_US", "prior");
  await d.wait(() => d.exists("document.querySelector('header')"));
  d.observed["priorStatus"] = await d.evaluate<unknown>(
    "(async () => { const r = await window.mrStreamer.invoke('updates.status'); return r.ok ? { installed: r.value.installed ?? r.value.current ?? null, channel: r.value.channel, distribution: r.value.distribution } : r; })()",
  );
  d.observed["priorUserAgent"] = await d.evaluate<string>("navigator.userAgent");
  // The prior release's own files, by hash: the app it runs is the one published.
  const priorDoctor = d.observed["priorDoctor"];
  const executable =
    priorDoctor && typeof priorDoctor === "object" && "executable" in priorDoctor
      ? String(priorDoctor.executable)
      : "";
  const sha256 = async (path: string) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  d.observed["priorFiles"] = {
    executable: await sha256(executable),
    appAsar: await sha256(join(dirname(executable), "resources/app.asar")),
  };
  await d.click("Open Live TV in the prior release", named("header button", "Live TV"));
  await d.wait(async () => typeof (await d.evaluate<string | undefined>(HEADING)) === "string");
  // A list it doesn't know reads as nothing remembered: it shows its own choice.
  d.observed["priorLiveTv"] = await d.evaluate<string | undefined>(HEADING);
  await d.capture("prior-live-tv");
  // Its own viewing still works: a favourite of the first subscription.
  await search(d, "TEST | H.264 + MP2", "MP2");
  await d.click(
    "Star a channel in the prior release",
    `${row("TEST | H.264 + MP2")}.querySelector('button[aria-label="Add to favourites"]')`,
  );
  await d.wait(() =>
    d.exists(
      `${row("TEST | H.264 + MP2")}.querySelector('button[aria-label="Remove from favourites"]')`,
    ),
  );
  // Also delete of the second subscription, then the same account added again.
  await eraseBackup(d);
  d.observed["diskAfterPriorErase"] = onDisk(d.profile, erased);
  await addBackup(d, fixture.otherUrl, "Add the second subscription again in the prior release");
  // New events of that account in the prior release: a watch and a favourite.
  await search(d, SECOND, "H.264 + AAC");
  await d.click("Watch the second subscription's channel", row(SECOND));
  await d.wait(() => d.exists("document.querySelector('[data-view=watch]')"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "(() => { const v = document.querySelector('video'); return !!v && !v.paused && v.currentTime > 0.5; })()",
    ),
  );
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists("document.querySelector('[data-view=watch]')")));
  await d.wait(() => d.exists(row(SECOND)));
  await d.click(
    "Star the second subscription's channel",
    `${row(SECOND)}.querySelector('button[aria-label="Add to favourites"]')`,
  );
  await d.wait(() =>
    d.exists(`${row(SECOND)}.querySelector('button[aria-label="Remove from favourites"]')`),
  );
  await d.capture("prior-after-erase-and-readd");
  await d.quit();
  const prior = onDisk(d.profile, erased);
  d.observed["diskAfterPrior"] = prior;
  d.observed["rememberedAfterPrior"] = await remembered(d.profile);
  // It kept the choice it doesn't know, as it was.
  check(
    JSON.stringify(d.observed["rememberedAfterPrior"]) ===
      JSON.stringify(d.observed["rememberedAfterCandidate"]),
    "The prior release changed the remembered list without being asked to",
  );
  // Diagnostics: the prior release recorded for the account again, wrote it no anchor, and left
  // the channels it doesn't know in the file.
  check(
    prior.eventsOfErased.length > 0 && prior.anchorsOfErased === 0,
    "The prior release wrote no new events, or an anchor",
  );
  check(prior.membersOfErased > 0, "The prior release's erase took channels it doesn't know");

  // This build again.
  await d.launch();
  await d.wait(() => d.exists("document.querySelector('header')"));
  await d.click("Open Live TV again", named("header button", "Live TV"));
  await d.wait(async () => (await d.evaluate<string | undefined>(HEADING)) === "Round trip");
  await d.wait(async () => (await shownRows(d)).length === 2);
  const after = await shownRows(d);
  d.observed["candidateAfter"] = after;
  check(
    JSON.stringify(after) === JSON.stringify([FIRST, HEVC]),
    "The erased account's channel came back, or another went",
  );
  d.observed["awayAfter"] = await d.evaluate<boolean>(
    "[...document.querySelectorAll('main p')].some(p => p.textContent.includes(\"isn't saved\") || p.textContent.includes(\"aren't saved\"))",
  );
  check(d.observed["awayAfter"] === false, "The erased account's channel is still counted");
  await d.capture("candidate-after");
  const candidate = onDisk(d.profile, erased);
  d.observed["diskAfterCandidateStart"] = candidate;
  check(candidate.membersOfErased === 0, "The erased account's channels stayed in the file");
  // The prior release's viewing shows: both favourites it starred.
  d.observed["favouritesAfter"] = await d.evaluate<unknown>(
    "(async () => { const r = await window.mrStreamer.invoke('viewing.get'); return r.ok ? r.value.favourites.length : null; })()",
  );
  check(d.observed["favouritesAfter"] === 2, "The prior release's favourites are gone");
  // A channel of the account added again goes in the list anew, and stays.
  await openList(d, "All channels");
  await rowMenu(d, SECOND, "H.264 + AAC");
  await tick(d, "Round trip", true);
  await d.click(
    "Clear the list search",
    "document.querySelector('main button[aria-label=\"Clear search\"]')",
  );
  await openList(d, "Round trip");
  await d.wait(
    async () => JSON.stringify(await shownRows(d)) === JSON.stringify([FIRST, HEVC, SECOND]),
  );
  d.observed["candidateReadded"] = await shownRows(d);
  await d.capture("candidate-readded");
}
