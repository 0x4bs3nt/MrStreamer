import {
  atTime,
  expired,
  keptUntil,
  nextAt,
  relisted,
  sameReminder,
  seen,
  statusOf,
  type KeptReminder,
} from "@mrstreamer/core/reminders/rules";
import { afterEach, describe, expect, it } from "vitest";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 21:30 to 23:00 on 2 October 2026 in +02:00. */
const START = Date.parse("2026-10-02T21:30:00+02:00");
const STOP = START + 90 * MINUTE;

const set = (changes: Partial<KeptReminder> = {}): KeptReminder => ({
  id: "r1",
  subscriptionId: "s1",
  channel: "11",
  streams: ["11", "12"],
  channelName: "Eurosport 1",
  adult: false,
  start: START,
  stop: STOP,
  set: "Ski Jumping",
  title: "Ski Jumping",
  state: { kind: "pending" },
  ...changes,
});

const zone = process.env["TZ"];
afterEach(() => {
  if (zone === undefined) delete process.env["TZ"];
  else process.env["TZ"] = zone;
});

describe("programme reminders", () => {
  it("tells once its start comes, while its programme is on, and is missed once it ended", () => {
    expect(atTime(set(), START - 1, true)).toEqual({ reminder: set(), tells: false });
    const told = atTime(set(), START + 12 * MINUTE, true);
    expect(told).toEqual({
      reminder: set({ state: { kind: "told", at: START + 12 * MINUTE } }),
      tells: true,
    });
    // Told is told: a later moment tells nothing more.
    expect(atTime(told.reminder, START + 13 * MINUTE, true).tells).toBe(false);
    expect(atTime(set(), STOP, true)).toEqual({
      reminder: set({ state: { kind: "missed" } }),
      tells: false,
    });
    // Hidden, as a channel for adults while those are hidden: missed, silently.
    expect(atTime(set(), START, false)).toEqual({
      reminder: set({ state: { kind: "missed" } }),
      tells: false,
    });
    // Gone at its start: it stays gone and tells nothing.
    const gone = set({ state: { kind: "gone" } });
    expect(atTime(gone, START, true)).toEqual({ reminder: gone, tells: false });
  });

  it("follows what the guide lists at its start, and nothing it can't tell", () => {
    const flying = seen(set(), undefined, { title: "Ski Flying", stop: STOP + HOUR });
    expect(flying).toMatchObject({ title: "Ski Flying", stop: STOP + HOUR });
    expect(statusOf(flying)).toEqual({ kind: "changed", was: "Ski Jumping" });
    expect(statusOf(seen(flying, undefined, { title: "Ski Jumping", stop: STOP }))).toEqual({
      kind: "upcoming",
    });
    expect(statusOf(seen(set(), undefined, null))).toEqual({ kind: "gone" });
    expect(statusOf(seen(set(), null, undefined))).toEqual({ kind: "gone" });
    // What can't be told, as a guide or a catalogue not read yet, changes nothing.
    expect(seen(set({ state: { kind: "gone" } }), undefined, undefined)).toEqual(
      set({ state: { kind: "gone" } }),
    );
    // Once told or missed, nothing the guide says changes it.
    const told = set({ state: { kind: "told", at: START } });
    expect(seen(told, null, null)).toBe(told);
  });

  it("finds its channel by any stream, keeping the streams it knew", () => {
    const found = seen(
      set(),
      { id: "10", streams: ["10", "12"], name: "Eurosport", adult: true },
      undefined,
    );
    expect(found).toMatchObject({
      channel: "10",
      streams: ["10", "12", "11"],
      channelName: "Eurosport",
      adult: true,
      state: { kind: "pending" },
    });
    expect(sameReminder(found, { subscriptionId: "s1", streams: ["11"], start: START })).toBe(true);
    expect(sameReminder(found, { subscriptionId: "s2", streams: ["11"], start: START })).toBe(
      false,
    );
    expect(sameReminder(found, { subscriptionId: "s1", streams: ["11"], start: STOP })).toBe(false);
  });

  it("follows its channel after it told or was missed, and keeps what it told", () => {
    const filed = { id: "10", streams: ["10", "12"], name: "Eurosport", adult: true };
    for (const state of [{ kind: "told", at: START }, { kind: "missed" }] as const) {
      const kept = set({ state });
      expect(relisted(kept, filed)).toEqual({
        ...kept,
        channel: "10",
        streams: ["10", "12", "11"],
        channelName: "Eurosport",
        adult: true,
      });
      // The guide changes nothing of it.
      expect(seen(kept, filed, { title: "Ski Flying", stop: STOP + HOUR })).toBe(kept);
    }
  });

  it("keeps one that told, was missed or went until the midnight ending its programme's day there", () => {
    // 25 October 2026 in Amsterdam: summer time ends at 03:00, so the day lasts 25 hours.
    process.env["TZ"] = "Europe/Amsterdam";
    const night = set({
      start: Date.parse("2026-10-25T01:00:00+02:00"),
      stop: Date.parse("2026-10-25T02:30:00+02:00"),
      state: { kind: "missed" },
    });
    const midnight = Date.parse("2026-10-26T00:00:00+01:00");
    expect(midnight - Date.parse("2026-10-25T00:00:00+02:00")).toBe(25 * HOUR);
    expect(keptUntil(night)).toBe(midnight);
    expect(expired(night, midnight - 1)).toBe(false);
    expect(expired(night, midnight)).toBe(true);
    // Until its start, kept whatever the time.
    expect(expired(set(), midnight + 7 * 24 * HOUR)).toBe(false);

    // The same moment ends another day where the viewer is elsewhere.
    process.env["TZ"] = "America/New_York";
    expect(keptUntil(night)).toBe(Date.parse("2026-10-25T00:00:00-04:00"));
  });

  it("is due again at the next start, the end of a programme that told, or a midnight it goes", () => {
    process.env["TZ"] = "UTC";
    const told = set({ id: "r2", start: START - HOUR, stop: STOP, state: { kind: "told", at: 0 } });
    const later = set({ id: "r3", start: STOP + HOUR, stop: STOP + 2 * HOUR });
    const missed = set({ id: "r4", start: START - HOUR, stop: START, state: { kind: "missed" } });
    // 23:00 in +02:00 is 21:00 UTC: that day ends three hours after the programme.
    const midnight = Date.parse("2026-10-03T00:00:00Z");
    expect(nextAt([later, told, missed], START - 2 * HOUR)).toBe(STOP);
    expect(nextAt([later, told, missed, set()], START - 2 * HOUR)).toBe(START);
    expect(nextAt([later, told, missed], STOP)).toBe(STOP + HOUR);
    expect(nextAt([told, missed], STOP)).toBe(midnight);
    expect(nextAt([missed], midnight)).toBeNull();
  });
});
