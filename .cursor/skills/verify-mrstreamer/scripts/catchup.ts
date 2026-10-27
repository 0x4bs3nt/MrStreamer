// Catch-up through Live TV's rest of the day.
//
// `catch-up`: a programme that aired plays from the fake panel's timeshift archive in Watch,
// which says it aired earlier. The panel breaks the connection two seconds in and the player
// reconnects to the recording; it ends, and Watch then plays the channel live. The panel's record
// of the timeshift addresses is the proof of the windows asked for.
//
// `catch-up-hls`: the same from a playlist's Flussonic catch-up, whose recording is an HLS
// playlist that names no end yet. The playlist host's record of the parts asked for is the proof
// that it plays from its first part, not from near its newest as a live playlist would.
//
// Both run on the real clock: the fake guides list half hours from a couple of hours back, and the
// guide keeps what aired, so the rest of the day lists programmes that have ended.
import type { ArchiveRequest } from "../../../../apps/desktop/test/fake-provider.ts";
import type { Driver } from "./language.ts";

/** The time zone the fake panel names, whose clock its timeshift addresses tell. */
const PANEL_ZONE = "Europe/Amsterdam";

/** What the fake panel was asked for, for the scenario's checks. */
export interface CatchupFake {
  archiveRequests(): readonly ArchiveRequest[];
  breakNextArchive(pieces: number): void;
  streams(): { readonly requests: number; readonly active: number };
}

const video = `(() => {
  const v = document.querySelector('video');
  return { time: v?.currentTime ?? 0, width: v?.videoWidth ?? 0, ended: v?.ended ?? false,
    audio: v?.webkitAudioDecodedByteCount ?? 0, watching: !!document.querySelector('[data-view=watch]') };
})()`;

/** "2026-10-13:20-00", as the panel's timeshift address writes `time` on its clock. */
function panelTime(time: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: PANEL_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(time)
      .map((part) => [part.type, part.value]),
  );
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}:${parts["hour"]}-${parts["minute"]}`;
}

const expect = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message);
};

/**
 * Opens Live TV's `category` and the rest of the day of the channel whose name has `channel` in
 * it, and gives the first programme that aired, with the steps that play and watch it.
 */
export async function airedProgramme(d: Driver, category: string, channel: string) {
  const row = `[...document.querySelectorAll('[data-index]')].find(r => r.querySelector('[data-name]')?.textContent.includes(${JSON.stringify(channel)}))`;
  const lines = `[...(${row})?.querySelectorAll('.rounded-b-lg > div > button') ?? []]`;
  const playback = () =>
    d.evaluate<{ time: number; width: number; ended: boolean; audio: number; watching: boolean }>(
      video,
    );
  const nowPlaying = () =>
    d.evaluate<string>("document.querySelector('[data-view=watch]')?.innerText ?? ''");
  /** Moves the pointer over the picture, which shows Watch's fading controls for a while. */
  const wake = async () => {
    d.action("Move the pointer over the picture");
    for (const x of [600, 640]) {
      await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: 400 });
    }
  };

  await d.wait(() => d.exists("document.querySelector('header')"));
  await d.click(
    "Open Live TV",
    "[...document.querySelectorAll('header button')].find(b => b.textContent.trim() === 'Live TV')",
  );
  await d.click(
    "Open Provider lists",
    "[...document.querySelectorAll('[role=navigation] button')].find(b=>b.title === 'Provider lists')",
  );
  await d.click(
    `Open the ${category} category`,
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(category)}))`,
  );
  await d.wait(() => d.exists(row));
  await d.click(
    `Open the rest of ${channel}'s day`,
    `(${row})?.querySelector('button[aria-label="Later programmes"]')`,
  );
  await d.wait(() => d.evaluate<boolean>(`${lines}.length > 1`));
  const day = await d.evaluate<{ time: string; title: string; onNow: boolean }[]>(
    `${lines}.map(line => ({ time: line.firstElementChild.textContent,
      title: line.children[1].firstElementChild.textContent,
      onNow: !!line.querySelector('.bg-white\\\\/20') }))`,
  );
  d.observed["schedule"] = day;
  const aired = day[0];
  expect(!!aired && !aired.onNow, "The rest of the day lists no programme that aired.");
  await d.capture("catchup-schedule");

  return {
    title: aired!.title,
    playback,
    nowPlaying,
    wake,
    /** Plays the programme that aired, and waits for its picture and sound to play. */
    async play() {
      await d.click(`Play ${aired!.title}, which aired`, `${lines}[0]`);
      await d.wait(async () => {
        const v = await playback();
        return v.watching && v.time >= 1 && v.width > 0 && v.audio > 0;
      });
      d.observed["archivePlayback"] = await playback();
      const shown = await nowPlaying();
      d.observed["archiveNowPlaying"] = shown;
      expect(
        shown.includes(aired!.title) && shown.includes("Aired"),
        "Watch doesn't say the programme aired.",
      );
    },
  };
}

export async function catchupScenario(d: Driver, fake: CatchupFake): Promise<void> {
  const channel = "H.264 + AAC";
  const aired = await airedProgramme(d, "TEST | Formats", channel);
  const { playback, nowPlaying, wake } = aired;

  // The panel's first answer breaks off two seconds in, as a dropped connection does.
  fake.breakNextArchive(20);
  await aired.play();

  // The player reconnects to the recording where it got to, and it plays again.
  await d.wait(async () => {
    if (fake.archiveRequests().length < 2) return false;
    const v = await playback();
    return v.time >= 1 && v.width > 0 && v.audio > 0;
  });
  d.observed["reconnectedPlayback"] = await playback();
  d.observed["reconnectedNowPlaying"] = await nowPlaying();
  expect((await nowPlaying()).includes("Aired"), "The reconnect lost the programme.");
  await wake();
  await d.capture("catchup-playing");

  // The panel was asked for that programme, from its start on its own clock, and again, after the
  // break, from the minute it had got to, which is the same; and for nothing live.
  const schedule = await d.evaluate<
    { start: number; stop: number; title: string }[]
  >(`(async () => {
    const read = await window.mrStreamer.invoke('library.channels', { query: ${JSON.stringify(channel)} });
    const channel = read.ok ? read.value[0] : null;
    if (!channel) return [];
    // The day Live TV reads: from its start to its end.
    const from = new Date().setHours(0, 0, 0, 0);
    const until = new Date().setHours(24, 0, 0, 0);
    const day = await window.mrStreamer.invoke('guide.schedule',
      { channel: { subscriptionId: channel.subscriptionId, id: channel.id }, from, until });
    return day.ok ? day.value : [];
  })()`);
  const programme = schedule.find((each) => each.title === aired.title);
  expect(!!programme, "The guide no longer lists the programme played.");
  const expected = {
    streamId: "1000",
    minutes: Math.ceil((programme!.stop - programme!.start) / 60_000),
    start: panelTime(programme!.start),
  };
  d.observed["archiveRequested"] = fake.archiveRequests();
  d.observed["archiveExpected"] = expected;
  expect(
    JSON.stringify(fake.archiveRequests()) === JSON.stringify([expected, expected]),
    "The panel wasn't asked for exactly the programme's window, once and after the break.",
  );
  expect(fake.streams().requests === 0, "Catch-up asked the panel for the channel live.");

  // The recording ends: the channel stops there, still saying what aired.
  await d.wait(() => d.exists("document.querySelector('[data-view=watch] [data-retry]')"));
  d.observed["archiveEnded"] = { ...(await playback()), nowPlaying: await nowPlaying() };
  expect((await nowPlaying()).includes("Aired"), "Watch forgot the programme once it ended.");
  await d.capture("catchup-ended");

  await d.click(
    `Watch ${channel} live`,
    "document.querySelector('[data-view=watch] [data-retry]')",
  );
  await d.wait(async () => {
    const v = await playback();
    return !v.ended && v.time >= 1 && v.width > 0;
  });
  d.observed["livePlayback"] = await playback();
  d.observed["liveNowPlaying"] = await nowPlaying();
  expect(!(await nowPlaying()).includes("Aired"), "The channel still says it aired.");
  expect(fake.streams().requests === 1, "Watch didn't play the channel live.");
  expect(fake.archiveRequests().length === 2, "The recording was asked for again.");
  await wake();
  await d.capture("catchup-live-again");
}

/**
 * A playlist channel's recording that names no end yet, four three-second parts: Watch plays it
 * from its first part.
 */
export async function catchupHlsScenario(
  d: Driver,
  host: { requests(): readonly string[] },
): Promise<void> {
  const aired = await airedProgramme(d, "Test", "Catch-up");
  await aired.play();
  const asked = host.requests();
  const recording = asked.find((path) => /^\/catchup\/index-\d+-\d+\.m3u8$/.test(path));
  const parts = asked.filter((path) => /^\/catchup\/part-\d\.mpegts$/.test(path));
  d.observed["recordingAsked"] = recording;
  d.observed["partsAsked"] = parts;
  expect(!!recording, "The playlist's recording wasn't asked for.");
  expect(parts[0] === "/catchup/part-0.mpegts", "The recording didn't start at its first part.");
  await aired.wake();
  await d.capture("catchup-hls-playing");
}
