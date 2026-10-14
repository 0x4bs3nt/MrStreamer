// @vitest-environment happy-dom
// An HLS channel's sound and subtitles, which its playlists declare and its player reads: the
// same Sound and CC as any channel, with the viewer's remembered languages. Sound switches where
// the stream plays. Subtitles and captions come on only by the viewer's choice, never because the
// stream marks them as its default, and a choice stays the same track when the stream moves to
// another group of renditions, or the channel opens again with them in another order. Chosen
// captions stay chosen through that too, though a stream's picture tells of them only at their
// first line. CC says the chosen subtitles are loading until the stream's player has read them
// where it plays, whether or not anything is said there. hls.js itself runs in the real app (see
// test/e2e); here a stand-in plays the stream's part.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { player } from "../../src/renderer/src/player/player.ts";
import { subtitleLayer } from "../../src/renderer/src/player/subtitles.ts";
import { streams, type Rendition } from "./hls-stand-in.ts";

vi.mock("hls.js", async (original) => {
  const real = await original<typeof import("hls.js")>();
  const { standIn } = await import("./hls-stand-in.ts");
  return { default: standIn(real.default) };
});

const channel = (id: string): LiveChannel => ({
  subscriptionId: SUBSCRIPTION,
  id,
  name: id,
  title: id,
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  catchupDays: null,
  variants: [{ id, name: id, tags: [], quality: null }],
});

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const SOUND: readonly Rendition[] = [
  { name: "English", lang: "en", default: true },
  { name: "Español", lang: "es" },
];
/** English is the stream's default, as broadcasters mark the subtitles of their own language. */
const SUBTITLES: readonly Rendition[] = [
  { name: "English", lang: "en", default: true },
  { name: "Deutsch", lang: "de" },
];

/** Opens `id` as an HLS stream, and gives the stream the player opened for it. */
async function open(id: string) {
  const answer = ipc.hold("playback.open");
  player.play(channel(id));
  await wait();
  answer.resolve({
    sessionId: id,
    channel: { subscriptionId: SUBSCRIPTION, id: id },
    url: `http://127.0.0.1/${id}`,
    format: "hls",
  });
  await wait();
  return streams.latest();
}

/** Opens `id` with the usual sound and subtitles, once the player has taken them in. */
async function playing(id: string) {
  const stream = await open(id);
  stream.variant({ audio: SOUND, subtitles: SUBTITLES });
  // Supply expired cue data so the selection tests use proven tracks. Discovery ordering and
  // empty renditions are exercised separately by live-hls-availability.test.ts.
  stream.subtitleLines([{ start: -2, end: -1, text: "Proof" }], "English");
  stream.subtitleLines([{ start: -2, end: -1, text: "Proof" }], "Deutsch");
  await wait();
  player.element.currentTime = 7;
  return stream;
}

/** Opens `id` again, as after the connection was lost, and gives the stream opened for that. */
async function reopened(id: string) {
  const answer = ipc.hold("playback.open");
  player.retry();
  await wait();
  answer.resolve({
    sessionId: `${id}2`,
    channel: { subscriptionId: SUBSCRIPTION, id: id },
    url: `http://127.0.0.1/${id}2`,
    format: "hls",
  });
  await wait();
  return streams.latest();
}

/** The tracks Sound and CC list, by label. */
const listed = () => ({
  sound: player.state().tracks?.audio.map((track) => track.label),
  subtitles: player.state().tracks?.subtitles.map((track) => track.label),
});
const sound = (label: string) => player.state().tracks?.audio.find((each) => each.label === label);
const subtitles = (label: string) => {
  const track = player.state().tracks?.subtitles.find((each) => each.label === label);
  if (!track) throw new Error(`The stream lists no ${label} subtitles.`);
  return track;
};
/** The sound Sound marks as playing, by label. */
const soundPlaying = () => {
  const { audioId, tracks } = player.state();
  return tracks?.audio.find((track) => track.id === (audioId ?? tracks.playing))?.label;
};
/** Puts the picture at `position` seconds: happy-dom times no cues, so the test says where it is. */
function skipTo(position: number): void {
  player.element.currentTime = position;
  player.element.dispatchEvent(new Event("seeked"));
}
/** What the viewer reads over the picture where it is, top to bottom. */
const onScreen = () =>
  [...subtitleLayer.querySelectorAll<HTMLElement>("[data-subtitle-text] > div")]
    .filter((row) => row.style.visibility !== "hidden")
    .map((row) => row.textContent)
    .reverse();
/** Whether CC says the chosen subtitles are loading. */
const loading = () => player.state().subtitleLoading;
const saved = () => ipc.argsOf("preferences.update");

beforeEach(() => {
  player.reset();
  player.element.currentTime = 0;
  ipc.reset();
});

describe("an HLS channel's tracks", () => {
  it("lists proven tracks, and starts with its own sound and no subtitles", async () => {
    const stream = await playing("a");

    expect(listed()).toEqual({ sound: ["English", "Español"], subtitles: ["English", "Deutsch"] });
    expect(soundPlaying()).toBe("English");
    // Discovery reads subtitle-only segments without enabling the stream's default.
    expect(player.state().subtitle).toBeNull();
    expect(stream.subtitleTrack).toBe(-1);
    expect(stream.subtitlesLoaded[0]).toBe("English");
  });

  it("starts with the sound and subtitles in the viewer's languages", async () => {
    ipc.prefer({ audioLanguage: "es", subtitleLanguage: "de" });

    const stream = await playing("a");

    expect(soundPlaying()).toBe("Español");
    expect(stream.audioTrack).toBe(1);
    expect(player.state().subtitle).toMatchObject({ label: "Deutsch", format: "text" });
    expect(stream.subtitleTrack).toBe(1);
    expect(new Set(stream.subtitlesLoaded)).toEqual(new Set(["Deutsch"]));
  });

  it("leaves subtitles off for a viewer who turned them off, whatever the stream lists later", async () => {
    ipc.prefer({ subtitleLanguage: "off" });
    const stream = await playing("a");

    stream.captionLines(1, 4, 6, ["HELLO"]);
    await wait();
    skipTo(5);

    expect(listed().subtitles).toEqual(["English", "Deutsch", "Captions"]);
    expect(player.state().subtitle).toBeNull();
    expect(stream.subtitleTrack).toBe(-1);
    expect(onScreen()).toEqual([]);
  });

  it("switches sound where the stream plays, and remembers the language", async () => {
    const stream = await playing("a");

    player.setAudio(sound("Español")?.id ?? -1);
    await wait();

    expect(stream.audioTrack).toBe(1);
    expect(soundPlaying()).toBe("Español");
    // The same stream: nothing opened again.
    expect(ipc.argsOf("playback.open")).toHaveLength(1);
    expect(streams.latest()).toBe(stream);
    expect(saved()).toEqual([{ audioLanguage: "es" }]);
  });

  it("shows the chosen subtitles' lines, each once", async () => {
    const stream = await playing("a");

    player.setSubtitle(subtitles("English"));
    // A line that spans two segments comes with both.
    stream.subtitleLines([{ start: 10, end: 12, text: "We sail at first light." }]);
    stream.subtitleLines([
      { start: 10, end: 12, text: "We sail at first light." },
      { start: 13, end: 15, text: "Aye." },
    ]);

    // Read twice, it would show twice, one over the other.
    skipTo(11);
    expect(onScreen()).toEqual(["We sail at first light."]);
    skipTo(14);
    expect(onScreen()).toEqual(["Aye."]);
    expect(saved()).toEqual([{ subtitleLanguage: "en" }]);
  });

  it("says the chosen subtitles are loading until a segment of theirs is read, lines or none", async () => {
    const stream = await playing("a");

    player.setSubtitle(subtitles("English"));
    expect(loading()).toBe(true);
    // One unreadable fragment leaves the choice on while hls.js can recover.
    stream.subtitleUnreadable();
    expect(loading()).toBe(true);
    expect(player.state().subtitle?.label).toBe("English");
    expect(stream.loading).toBe(true);
    expect(loading()).toBe(true);
    // As a broadcaster sends while nothing is subtitled: a segment without a line.
    stream.subtitleLines([]);

    expect(loading()).toBe(false);
    expect(onScreen()).toEqual([]);
  });

  it("keeps saying so through a late segment of the subtitles chosen before", async () => {
    const stream = await playing("a");
    player.setSubtitle(subtitles("English"));

    player.setSubtitle(subtitles("Deutsch"));
    // hls.js asked for it while English was chosen.
    stream.subtitleLines([{ start: 1, end: 2, text: "Too late." }], "English");
    skipTo(1.5);

    expect(loading()).toBe(true);
    expect(onScreen()).toEqual([]);

    stream.subtitleLines([]);

    expect(loading()).toBe(false);
  });

  it("has nothing loading with subtitles off, and loads them again past what was read", async () => {
    const stream = await playing("a");
    player.setSubtitle(subtitles("English"));

    player.toggleSubtitles();
    expect(loading()).toBe(false);

    player.toggleSubtitles();
    expect(loading()).toBe(true);
    stream.subtitleLines([]);
    expect(loading()).toBe(false);

    // Off for a minute: the stream plays on, and hls.js reads no subtitles meanwhile.
    player.toggleSubtitles();
    player.element.currentTime = 60;
    player.toggleSubtitles();

    expect(loading()).toBe(true);
    stream.subtitleLines([]);
    expect(loading()).toBe(false);
  });

  it("turns subtitles off and on again with C, with the lines read before", async () => {
    const stream = await playing("a");
    player.setSubtitle(subtitles("Deutsch"));
    skipTo(11);
    stream.subtitleLines([{ start: 10, end: 12, text: "Wir segeln im Morgengrauen." }]);
    expect(onScreen()).toEqual(["Wir segeln im Morgengrauen."]);

    player.toggleSubtitles();

    expect(player.state().subtitle).toBeNull();
    expect(stream.subtitleTrack).toBe(-1);
    expect(onScreen()).toEqual([]);

    // hls.js read those lines already, and won't again.
    player.toggleSubtitles();

    expect(player.state().subtitle).toMatchObject({ label: "Deutsch" });
    expect(stream.subtitleTrack).toBe(1);
    expect(onScreen()).toEqual(["Wir segeln im Morgengrauen."]);
    expect(loading()).toBe(false);
    expect(saved()).toEqual([
      { subtitleLanguage: "de" },
      { subtitleLanguage: "off" },
      { subtitleLanguage: "de" },
    ]);
  });

  it("tells captions from subtitles of the same name, and shows only the ones chosen", async () => {
    const stream = await open("a");
    stream.manifest([{ name: "English", lang: "en", instreamId: "CC1" }]);
    stream.variant({ subtitles: [{ name: "English", lang: "en" }] });
    stream.subtitleLines([{ start: -2, end: -1, text: "Proof" }], "English");
    stream.captionLines(1, -2, -1, ["Proof"]);
    // A second caption channel the playlist didn't declare.
    stream.captionLines(3, 1, 3, ["TEXT THREE"]);
    await wait();
    expect(listed().subtitles).toEqual(["English · Text", "English · Captions", "Captions"]);

    player.setSubtitle(subtitles("English · Captions"));
    // Captions come with the picture: the stream has nothing left to load for them.
    expect(loading()).toBe(false);
    stream.captionLines(1, 4, 6, ["FIRST ROW", "SECOND ROW"]);
    stream.captionLines(3, 4, 6, ["OTHER CHANNEL"]);
    skipTo(5);

    // The rows of one screen are one line, and the subtitle rendition isn't loaded for them.
    expect(onScreen()).toEqual(["FIRST ROW\nSECOND ROW"]);
    expect(stream.subtitleTrack).toBe(-1);

    player.setSubtitle(subtitles("English · Text"));
    stream.subtitleLines([{ start: 4, end: 6, text: "First line" }]);
    stream.captionLines(1, 7, 9, ["LATER ROW"]);

    expect(onScreen()).toEqual(["First line"]);
    expect(stream.subtitleTrack).toBe(0);
    skipTo(8);
    expect(onScreen()).toEqual([]);
  });

  it("names renditions by their language when the stream gives only a code, or nothing", async () => {
    const stream = await open("a");
    stream.variant({
      audio: [
        { name: "eng", lang: "ENG" },
        { name: "Director's commentary", lang: "en" },
        { name: "" },
      ],
      subtitles: [{ name: "deu" }, { name: "eng", lang: "eng", forced: true }],
    });
    stream.subtitleLines([{ start: -2, end: -1, text: "Proof" }], "deu");
    stream.subtitleLines([{ start: -2, end: -1, text: "Proof" }], "eng");
    await wait();

    expect(listed()).toEqual({
      sound: ["English", "Director's commentary", "Track 3"],
      subtitles: ["Deutsch", "English · Forced"],
    });
    expect(player.state().tracks?.audio.map((track) => track.language)).toEqual(["en", "en", null]);
  });

  it("keeps the viewer's tracks when the stream moves to another group of renditions", async () => {
    const stream = await playing("a");
    player.setAudio(sound("Español")?.id ?? -1);
    player.setSubtitle(subtitles("Deutsch"));
    const chosen = { audioId: player.state().audioId, subtitle: player.state().subtitle };

    // The same renditions, in another order and with one more.
    stream.variant({
      audio: [{ name: "Français", lang: "fr", default: true }, ...SOUND.toReversed()],
      subtitles: SUBTITLES.toReversed(),
    });
    await wait();

    expect(listed()).toEqual({
      sound: ["Français", "Español", "English"],
      subtitles: ["Deutsch", "English"],
    });
    expect(player.state()).toMatchObject(chosen);
    expect(soundPlaying()).toBe("Español");
    expect(stream.audioTrack).toBe(1);
    expect(stream.subtitleTrack).toBe(0);
    stream.subtitleLines([{ start: 20, end: 22, text: "Noch da." }]);
    skipTo(21);
    expect(onScreen()).toEqual(["Noch da."]);
  });

  it("lets go of tracks the stream no longer has, without counting that as the viewer's choice", async () => {
    const stream = await playing("a");
    player.setAudio(sound("Español")?.id ?? -1);
    player.setSubtitle(subtitles("Deutsch"));
    stream.subtitleLines([{ start: 10, end: 12, text: "Wir segeln im Morgengrauen." }]);
    skipTo(11);
    const before = saved().length;

    stream.variant({
      audio: [
        { name: "English", lang: "en" },
        { name: "Italiano", lang: "it" },
      ],
    });
    await wait();

    expect(listed()).toEqual({ sound: ["English", "Italiano"], subtitles: [] });
    expect(soundPlaying()).toBe("English");
    expect(player.state().subtitle).toBeNull();
    expect(onScreen()).toEqual([]);
    // Nothing to turn back on, and Off was never saved.
    player.toggleSubtitles();
    expect(player.state().subtitle).toBeNull();
    expect(saved()).toHaveLength(before);
  });

  it("starts the next channel without the last one's tracks, lines or late answers", async () => {
    const first = await open("a");
    // The viewer's languages are still being read when the next channel is picked.
    const preferences = ipc.hold("preferences.get");
    first.variant({ audio: SOUND, subtitles: SUBTITLES });
    await wait();

    const second = await open("b");
    preferences.resolve({
      volume: 1,
      muted: false,
      subtitleLanguage: "de",
    });
    first.variant({ audio: SOUND, subtitles: SUBTITLES });
    first.subtitleLines([{ start: 1, end: 2, text: "From the channel before." }]);
    await wait();
    skipTo(1.5);

    expect(first.destroyed).toBe(true);
    expect(second).not.toBe(first);
    expect(player.state()).toMatchObject({ tracks: null, subtitle: null, audioId: null });
    expect(onScreen()).toEqual([]);
  });

  it("opens the channel again with the tracks the viewer chose on it, wherever it lists them", async () => {
    const first = await playing("a");
    player.setAudio(sound("Español")?.id ?? -1);
    player.setSubtitle(subtitles("Deutsch"));
    first.subtitleLines([{ start: 10, end: 12, text: "Wir segeln im Morgengrauen." }]);
    skipTo(11);

    // Another stream of the channel, as its other qualities are, lists them the other way round.
    const second = await reopened("a");
    second.variant({ audio: SOUND.toReversed(), subtitles: SUBTITLES.toReversed() });
    await wait();

    expect(second).not.toBe(first);
    expect(first.destroyed).toBe(true);
    expect(second.audioTrack).toBe(0);
    expect(soundPlaying()).toBe("Español");
    expect(second.subtitleTrack).toBe(0);
    expect(player.state().subtitle).toMatchObject({ label: "Deutsch" });
    // English, the stream's default and where Deutsch was listed before, is never loaded.
    expect(second.subtitlesLoaded).not.toContain("English");
    // The line of the stream before went with it, and the new one has yet to read the subtitles.
    expect(onScreen()).toEqual([]);
    expect(loading()).toBe(true);

    second.subtitleLines([{ start: 10, end: 12, text: "Noch da." }]);

    expect(onScreen()).toEqual(["Noch da."]);
  });

  it("opens the channel again in the viewer's languages when it lists the chosen tracks no more", async () => {
    await playing("a");
    player.setAudio(sound("Español")?.id ?? -1);
    player.setSubtitle(subtitles("Deutsch"));
    // What choosing them saved.
    ipc.prefer({ audioLanguage: "es", subtitleLanguage: "de" });

    const second = await reopened("a");
    second.variant({
      audio: [
        { name: "English", lang: "en", default: true },
        { name: "Italiano", lang: "it" },
        { name: "Español (Latinoamérica)", lang: "es" },
      ],
      subtitles: [
        { name: "English", lang: "en", default: true },
        { name: "Français", lang: "fr" },
        { name: "Deutsch (Schweiz)", lang: "de" },
      ],
    });
    await wait();

    second.subtitleLines([{ start: -2, end: -1, text: "Proof" }], "Deutsch (Schweiz)");
    await wait();
    // Not Italiano and Français, which are where Español and Deutsch were listed before.
    expect(soundPlaying()).toBe("Español (Latinoamérica)");
    expect(player.state().subtitle).toMatchObject({ label: "Deutsch (Schweiz)" });
    expect(new Set(second.subtitlesLoaded)).toEqual(new Set(["Deutsch (Schweiz)"]));
  });

  it("opens the channel again with the captions chosen from its picture, before any line of them", async () => {
    const first = await playing("a");
    // The playlist declares no captions: the picture tells of them at their first line.
    first.captionLines(1, 1, 3, ["HELLO"]);
    await wait();
    player.setSubtitle(subtitles("Captions"));
    skipTo(2);

    const second = await reopened("a");
    second.variant({ audio: SOUND, subtitles: SUBTITLES });
    await wait();

    // The new stream's picture has yet to tell of them, and the line of the one before is gone.
    expect(listed().subtitles).toEqual(["English", "Deutsch", "Captions"]);
    expect(player.state().subtitle).toMatchObject({ label: "Captions", format: "captions" });
    expect(second.subtitleTrack).toBe(-1);
    expect(onScreen()).toEqual([]);

    second.captionLines(1, 1, 3, ["STILL HERE"]);
    await wait();

    expect(listed().subtitles).toEqual(["English", "Deutsch", "Captions"]);
    expect(player.state().subtitle).toMatchObject({ label: "Captions" });
    expect(onScreen()).toEqual(["STILL HERE"]);
  });

  it("opens the channel again with the captions still off for a viewer who turned them off", async () => {
    const first = await playing("a");
    first.captionLines(1, 1, 3, ["HELLO"]);
    await wait();
    player.setSubtitle(subtitles("Captions"));
    player.toggleSubtitles();
    // What turning them off saved.
    ipc.prefer({ subtitleLanguage: "off" });

    const second = await reopened("a");
    second.variant({ audio: SOUND, subtitles: SUBTITLES });
    second.captionLines(1, 1, 3, ["NOT ASKED FOR"]);
    await wait();
    skipTo(2);

    expect(player.state().subtitle).toBeNull();
    expect(onScreen()).toEqual([]);
  });

  it("lists no captions on the next channel until its own picture carries them", async () => {
    const first = await playing("a");
    first.captionLines(1, 1, 3, ["HELLO"]);
    await wait();
    player.setSubtitle(subtitles("Captions"));

    const second = await playing("b");

    expect(listed().subtitles).toEqual(["English", "Deutsch"]);
    expect(player.state().subtitle).toBeNull();

    second.captionLines(1, 1, 3, ["ANOTHER CHANNEL'S"]);
    await wait();
    skipTo(2);

    expect(listed().subtitles).toEqual(["English", "Deutsch", "Captions"]);
    expect(player.state().subtitle).toBeNull();
    expect(onScreen()).toEqual([]);
  });

  it("lets go of the stream and its lines when stopped", async () => {
    const stream = await playing("a");
    player.setSubtitle(subtitles("English"));

    player.stop();
    stream.subtitleLines([{ start: 10, end: 12, text: "After the end." }]);
    skipTo(11);

    expect(stream.destroyed).toBe(true);
    expect(onScreen()).toEqual([]);
    // The subtitles stay chosen, and nothing loads them any more.
    expect(loading()).toBe(false);
  });
});
