// What the installed upgrade check's candidate restart accepts as a copy playing from where it was
// left. The window is a stand-in that plays and keeps copies as `Player` says, plays on while the
// check waits, and shows the saved online subtitle at its saved timing; the stage itself is the
// real one, read-only calls, clicks and checks included.
import { describe, expect, it } from "vitest";
import type { Download } from "../../../packages/contracts/src/downloads.ts";
import { SUBTITLE_CUE, SUBTITLE_TIMING } from "./e2e/installed-subtitles.ts";
import { restartCandidate, type AfterCandidate, type Driver } from "./e2e/installed-upgrade.ts";

/** Where the stand-in starts a copy, and what it keeps when the viewer leaves it. */
interface Player {
  start(kept: number, play: number): number;
  keep(left: number): number;
}

/** The player as it is: five seconds back, read a moment later, kept where it was left. */
const PLAYER: Player = { start: (kept) => kept - 5 + 0.5, keep: (left) => left + 0.25 };

const copy = (id: string, kind: "movie" | "episode", position: number | null): Download => ({
  id,
  title:
    kind === "movie"
      ? { kind, id: `${id}-title` }
      : { kind, id: `${id}-title`, seriesId: "series", season: 1, episode: 2 },
  subscription: { id: "subscription", name: "Fake" },
  name: id,
  episodeName: null,
  year: 2026,
  duration: 150,
  originalLanguage: "en",
  posterUrl: `mrstreamer://download/${id}/poster`,
  wideUrl: null,
  size: 1000,
  status: { kind: "complete" },
  progress: position === null ? null : { position, duration: 150 },
});

/** The saved cue's interval once its offset and speed apply. */
const CUE = {
  start: SUBTITLE_CUE.start * SUBTITLE_TIMING.speed + SUBTITLE_TIMING.offset,
  end: SUBTITLE_CUE.end * SUBTITLE_TIMING.speed + SUBTITLE_TIMING.offset,
};

/** The restart after an upgrade that left the long movie's copy at 55 s, playing as `player`. */
function restart(player: Player) {
  let copies = [
    copy("long", "movie", 55),
    copy("sound", "movie", null),
    copy("ep", "episode", null),
  ];
  let removed = false;
  let playing: string | null = null;
  let time = 0;
  let plays = 0;
  const state = {
    preferences: {},
    favourites: [],
    watchlist: { total: 0, entries: [] },
    progress: [],
  };
  const answers: Record<string, () => unknown> = {
    "subscription.list": () => (removed ? [] : [{ id: "subscription" }]),
    "preferences.get": () => state.preferences,
    "viewing.get": () => ({ favourites: state.favourites }),
    "watchlist.list": () => state.watchlist,
    "viewing.progress": () => state.progress,
    "downloads.list": () => ({ items: copies }),
  };
  const shownWidth = (id: string) => {
    const progress = copies.find((each) => each.id === id)?.progress;
    return progress ? `${Math.round((progress.position / progress.duration) * 100)}%` : null;
  };
  const d = {
    actions: [],
    requests: [],
    exists: () => Promise.resolve(true),
    /** Playback goes on a second between checks, as it does while the real check waits. */
    async wait(check: () => Promise<boolean>, _timeout?: number, what?: string) {
      for (let tries = 0; tries < 30; tries++) {
        if (await check()) return;
        if (playing !== null) time += 1;
      }
      throw new Error(`Timed out waiting for ${what}`);
    },
    async click(action: string, element: string) {
      if (action === "Confirm removal") {
        removed = true;
        copies = copies.map((each) => ({ ...each, subscription: null }));
      }
      const id = /data-download="([^"]+)"/.exec(element)?.[1];
      if (!action.startsWith("Watch") || !id) return;
      playing = id;
      const kept = copies.find((each) => each.id === id)?.progress?.position ?? 0;
      time = id === "long" ? player.start(kept, ++plays) : 1;
    },
    async key(name: string) {
      if (name === "ArrowRight") time += 10;
      if (name === "ArrowLeft") time = Math.max(0, time - 10);
      if (name !== "Escape" || playing === null) return;
      const left = playing;
      copies = copies.map((each) =>
        each.id === left
          ? { ...each, progress: { position: player.keep(time), duration: 150 } }
          : each,
      );
      playing = null;
    },
    capture: () => Promise.resolve(),
    read: (method: string) => Promise.resolve(answers[method]!()),
    video: () =>
      Promise.resolve({ time, width: 640, audio: 1000, paused: false, title: playing !== null }),
    page: {
      async evaluate(expression: string) {
        if (expression.includes("innerText"))
          return "Remove it from this device? Subscription removed, copy kept";
        if (expression.includes("style.width"))
          return shownWidth(/data-download="([^"]+)"/.exec(expression)?.[1] ?? "");
        if (expression.includes("subtitle-offset")) return SUBTITLE_TIMING;
        const caption = time >= CUE.start && time < CUE.end ? SUBTITLE_CUE.text : "";
        if (expression.includes("currentTime")) return { time, caption };
        if (expression.includes("data-subtitle-text")) return caption;
        if (expression.includes(".map(")) return ["English 5.1", "Español Commentary"];
        return true;
      },
    },
  } as unknown as Driver;
  const upgraded = { after: state, copies } as unknown as AfterCandidate;
  return restartCandidate(d, { long: "long-title", formats: [] }, upgraded, {
    cutOff: () => Promise.resolve({}),
    refused: () => [],
  });
}

describe("the installed upgrade check's resumed copy", () => {
  it("accepts a copy that goes back five seconds from where it was left", async () => {
    const restarted = await restart(PLAYER);

    expect(restarted.played["longStartedAt"]).toEqual({ started: 50.5, keptBefore: 55 });
    // The saved subtitle check skips back to before its cue and plays to 43.5 s, where it leaves.
    expect(restarted.played["resume"]).toEqual({ left: 43.5, kept: 43.75, resumed: 39.25 });
  });

  it.each<[string, Partial<Player>, RegExp]>([
    [
      "starts 25 s past where the upgrade left it",
      { start: (kept) => kept + 25 },
      /copy started at 80 s/,
    ],
    ["starts over from the beginning", { start: () => 1 }, /copy started at 1 s/],
    [
      "resumes 25 s past where it was left",
      { start: (kept, play) => (play === 1 ? kept - 5 : kept + 25) },
      /copy again started at 68\.25 s/,
    ],
    [
      "keeps 25 s past where it was left",
      { keep: (left) => left + 25 },
      /left at 43\.5 s, but kept 68\.5 s/,
    ],
  ])("refuses a copy that %s", async (_, player, refusal) => {
    await expect(restart({ ...PLAYER, ...player })).rejects.toThrow(refusal);
  });
});
