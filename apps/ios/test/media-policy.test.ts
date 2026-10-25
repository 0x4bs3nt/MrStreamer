import type {
  ObservedAudioTrack,
  ObservedSubtitleTrack,
  ObservedTrackSelection,
  ObservedTrackSnapshot,
} from "expo-video";
import { describe, expect, it } from "vitest";
import {
  RECONNECT_DELAYS_MS,
  STABLE_PLAYBACK_MS,
  audioTarget,
  confirms,
  decideAudio,
  decideSubtitles,
  holdOf,
  nextStep,
  observedFileTracks,
  rematch,
  remembered,
  type MediaPolicy,
  type PlaybackFailure,
  type Recovery,
  type TrackContext,
} from "../src/media-policy.ts";

// Native snapshots as the patched expo-video player reports them: option ids are positions in the
// item's selection group, languages as the file tags them, defaults and forced flags the player's.

interface Facts {
  readonly isDefault?: boolean;
  readonly isPlayable?: boolean;
  readonly label?: string;
  readonly name?: string;
}

const named = (language: string | null, facts: Facts) => ({
  attemptId: 1,
  itemId: 1,
  revision: 1,
  label: facts.label ?? language ?? "Unknown",
  isDefault: facts.isDefault ?? false,
  isPlayable: facts.isPlayable ?? true,
  ...(language === null ? {} : { language }),
  ...(facts.name === undefined ? {} : { name: facts.name }),
});

const sound = (id: string, language: string | null, facts: Facts = {}): ObservedAudioTrack => ({
  ...named(language, facts),
  group: "audio",
  id,
});

const text = (
  id: string,
  language: string | null,
  facts: Facts & { readonly forced?: boolean } = {},
): ObservedSubtitleTrack => ({
  ...named(language, facts),
  group: "subtitles",
  id,
  forcedOnly: facts.forced ?? false,
});

type GroupState = ObservedTrackSnapshot["audio"]["state"];

const snapshot = (parts: {
  readonly revision?: number;
  readonly audio?: readonly ObservedAudioTrack[];
  readonly audioState?: GroupState;
  readonly subtitles?: readonly ObservedSubtitleTrack[];
  readonly subtitleState?: GroupState;
  readonly offAllowed?: boolean;
  readonly selectedAudio?: string | null;
  readonly selectedSubtitle?: string | null;
}): ObservedTrackSnapshot => ({
  attemptId: 1,
  itemId: 1,
  revision: parts.revision ?? 1,
  audio: { state: parts.audioState ?? "ready", options: parts.audio ?? [] },
  subtitles: { state: parts.subtitleState ?? "ready", options: parts.subtitles ?? [] },
  subtitleOffAllowed: parts.offAllowed ?? true,
  selectedAudioId: parts.selectedAudio ?? null,
  selectedSubtitleId: parts.selectedSubtitle ?? null,
});

const film: TrackContext = { media: "file", titleLanguage: "nl", originalLanguage: "fr" };
const channel: TrackContext = { media: "live", titleLanguage: "nl", originalLanguage: null };
const policy = (
  audio: MediaPolicy["audio"],
  subtitles: MediaPolicy["subtitles"] = { kind: "forced-only" },
): MediaPolicy => ({ audio, subtitles });
const followTitle = policy({ kind: "follow-title" });

const selectsAudio = (track: ObservedAudioTrack) => ({
  kind: "select",
  selection: { kind: "audio", track },
});
const selectsSubtitles = (track: ObservedSubtitleTrack | null) => ({
  kind: "select",
  selection: { kind: "subtitles", track },
});
const KEEP = { kind: "keep" };
const WAIT = { kind: "wait" };

describe("audio", () => {
  const english = sound("0", "eng", { isDefault: true });
  const dutch = sound("1", "dut");
  const dutchMain = sound("2", "nl-NL", { label: "Nederlands 5.1" });

  it("asks for the title language's track, its default first, and keeps one already speaking it", () => {
    expect(
      decideAudio(snapshot({ audio: [english, dutch], selectedAudio: "0" }), followTitle, film),
    ).toEqual(selectsAudio(dutch));
    const defaultDutch = sound("2", "nl", { isDefault: true });
    expect(
      decideAudio(
        snapshot({ audio: [dutch, defaultDutch], selectedAudio: null }),
        followTitle,
        film,
      ),
    ).toEqual(selectsAudio(defaultDutch));
    expect(
      decideAudio(
        snapshot({ audio: [english, dutch, dutchMain], selectedAudio: "2" }),
        followTitle,
        film,
      ),
    ).toEqual(KEEP);
  });

  it("falls back to the playable native default, never the first track, when the target can't play", () => {
    const german = sound("1", "ger");
    expect(
      decideAudio(snapshot({ audio: [english, german], selectedAudio: "1" }), followTitle, film),
    ).toEqual(selectsAudio(english));
    expect(
      decideAudio(snapshot({ audio: [english, german], selectedAudio: "0" }), followTitle, film),
    ).toEqual(KEEP);
    const unplayableDutch = sound("1", "nl", { isPlayable: false });
    expect(
      decideAudio(
        snapshot({ audio: [english, unplayableDutch], selectedAudio: "0" }),
        followTitle,
        film,
      ),
    ).toEqual(KEEP);
    const unplayableDefault = sound("0", "en", { isDefault: true, isPlayable: false });
    expect(
      decideAudio(
        snapshot({ audio: [unplayableDefault, german], selectedAudio: null }),
        followTitle,
        film,
      ),
    ).toEqual(KEEP);
  });

  it("targets the caller's original language, an explicit language, and for a channel only an explicit one", () => {
    const french = sound("3", "fre");
    const tracks = snapshot({ audio: [english, french, dutch], selectedAudio: "0" });
    expect(decideAudio(tracks, policy({ kind: "original" }), film)).toEqual(selectsAudio(french));
    expect(
      decideAudio(tracks, policy({ kind: "original" }), { ...film, originalLanguage: null }),
    ).toEqual(KEEP);
    expect(decideAudio(tracks, policy({ kind: "language", language: "nl" }), film)).toEqual(
      selectsAudio(dutch),
    );
    expect(audioTarget({ kind: "follow-title" }, channel)).toBeNull();
    expect(audioTarget({ kind: "original" }, channel)).toBeNull();
    expect(decideAudio(tracks, followTitle, channel)).toEqual(KEEP);
    expect(decideAudio(tracks, policy({ kind: "language", language: "nl" }), channel)).toEqual(
      selectsAudio(dutch),
    );
  });

  it("waits until the audio group is ready", () => {
    for (const audioState of ["loading", "unavailable", "absent"] as const) {
      expect(decideAudio(snapshot({ audioState, audio: [] }), followTitle, film)).toEqual(WAIT);
    }
  });
});

describe("subtitles", () => {
  const forcedEnglish = text("0", "eng", { forced: true });
  const french = text("1", "fre");
  const forcedFrench = text("2", "fre", { forced: true });
  const plainCalledForced = text("3", "eng", { label: "English Forced" });

  it("turns them off only where the group allows it", () => {
    const off = policy({ kind: "follow-title" }, { kind: "off" });
    const tracks = { subtitles: [forcedEnglish, french], selectedSubtitle: "1" } as const;
    expect(decideSubtitles(snapshot(tracks), off, film, "en")).toEqual(selectsSubtitles(null));
    expect(
      decideSubtitles(snapshot({ ...tracks, selectedSubtitle: null }), off, film, "en"),
    ).toEqual(KEEP);
    expect(decideSubtitles(snapshot({ ...tracks, offAllowed: false }), off, film, "en")).toEqual(
      KEEP,
    );
  });

  it("picks a file's language as a plain track, else forced subtitles for the confirmed sound", () => {
    const wanted = policy({ kind: "follow-title" }, { kind: "language", language: "fr" });
    expect(
      decideSubtitles(snapshot({ subtitles: [forcedFrench, french] }), wanted, film, undefined),
    ).toEqual(selectsSubtitles(french));
    const another = text("4", "fr-CA");
    expect(
      decideSubtitles(
        snapshot({ subtitles: [french, another], selectedSubtitle: "4" }),
        wanted,
        film,
        "en",
      ),
    ).toEqual(KEEP);
    const german = policy({ kind: "follow-title" }, { kind: "language", language: "de" });
    const none = { subtitles: [forcedEnglish, french], selectedSubtitle: "1" } as const;
    expect(decideSubtitles(snapshot(none), german, film, "en")).toEqual(
      selectsSubtitles(forcedEnglish),
    );
    expect(decideSubtitles(snapshot(none), german, film, undefined)).toEqual(WAIT);
    expect(decideSubtitles(snapshot(none), german, film, null)).toEqual(selectsSubtitles(null));
  });

  it("keeps forced-only to the confirmed sound's forced track, never one a label calls forced", () => {
    const forcedOnly = policy({ kind: "follow-title" });
    const tracks = { subtitles: [forcedEnglish, forcedFrench, plainCalledForced] } as const;
    expect(decideSubtitles(snapshot(tracks), forcedOnly, film, "fr")).toEqual(
      selectsSubtitles(forcedFrench),
    );
    expect(decideSubtitles(snapshot(tracks), forcedOnly, film, "en")).toEqual(
      selectsSubtitles(forcedEnglish),
    );
    expect(
      decideSubtitles(snapshot({ ...tracks, selectedSubtitle: "0" }), forcedOnly, film, "en"),
    ).toEqual(KEEP);
    expect(
      decideSubtitles(snapshot({ ...tracks, selectedSubtitle: "3" }), forcedOnly, film, "de"),
    ).toEqual(selectsSubtitles(null));
    expect(decideSubtitles(snapshot(tracks), forcedOnly, film, undefined)).toEqual(WAIT);
    const unplayable = text("0", "en", { forced: true, isPlayable: false });
    expect(
      decideSubtitles(
        snapshot({ subtitles: [unplayable], selectedSubtitle: null }),
        forcedOnly,
        film,
        "en",
      ),
    ).toEqual(KEEP);
  });

  it("follows core's channelSubtitle for a channel's language", () => {
    const dutch = policy({ kind: "follow-title" }, { kind: "language", language: "nl" });
    const plainDutch = text("5", "dut");
    const forcedDutch = text("6", "nl", { forced: true });
    const dutchSound = sound("0", "nl");
    const englishSound = sound("1", "en", { isDefault: true });
    expect(
      decideSubtitles(
        snapshot({
          audio: [dutchSound, englishSound],
          subtitles: [plainDutch],
          selectedSubtitle: "5",
        }),
        dutch,
        channel,
        "en",
      ),
    ).toEqual(selectsSubtitles(null));
    const silentDutch = sound("0", "nl", { isPlayable: false });
    expect(
      decideSubtitles(
        snapshot({ audio: [silentDutch, englishSound], subtitles: [forcedDutch, plainDutch] }),
        dutch,
        channel,
        "en",
      ),
    ).toEqual(selectsSubtitles(plainDutch));
    expect(
      decideSubtitles(
        snapshot({ audio: [englishSound], subtitles: [forcedDutch] }),
        dutch,
        channel,
        "en",
      ),
    ).toEqual(selectsSubtitles(forcedDutch));
    expect(
      decideSubtitles(
        snapshot({ audio: [englishSound], subtitles: [forcedEnglish], selectedSubtitle: "0" }),
        dutch,
        channel,
        "en",
      ),
    ).toEqual(selectsSubtitles(null));
    expect(
      decideSubtitles(
        snapshot({ audioState: "loading", subtitles: [plainDutch] }),
        dutch,
        channel,
        undefined,
      ),
    ).toEqual(WAIT);
  });

  it("waits until the subtitle group is ready", () => {
    for (const subtitleState of ["loading", "unavailable", "absent"] as const) {
      expect(
        decideSubtitles(snapshot({ subtitleState }), policy({ kind: "follow-title" }), film, "en"),
      ).toEqual(WAIT);
    }
  });
});

describe("holds and readback", () => {
  const german = sound("3", "ger", { label: "Deutsch", name: "Main" });
  const pickGerman: ObservedTrackSelection = { kind: "audio", track: german };

  it("keeps what describes a pick, never its id, and rematches one alike playable track", () => {
    const hold = holdOf(pickGerman);
    expect(hold).toEqual({ group: "audio", language: "de", label: "Deutsch", name: "Main" });
    expect(Object.keys(hold)).not.toContain("id");
    const moved = sound("1", "de-DE", { label: "Deutsch", name: "Main" });
    const commentary = sound("2", "de", { label: "Deutsch", name: "Commentary" });
    const later = snapshot({ revision: 7, audio: [sound("0", "en"), moved, commentary] });
    expect(rematch(hold, later)).toEqual({ kind: "audio", track: moved });
    const twin = sound("4", "de", { label: "Deutsch", name: "Main" });
    expect(rematch(hold, snapshot({ audio: [moved, twin] }))).toBeNull();
    const silent = sound("1", "de", { label: "Deutsch", name: "Main", isPlayable: false });
    expect(rematch(hold, snapshot({ audio: [silent] }))).toBeNull();
    expect(rematch(hold, snapshot({ audioState: "loading", audio: [moved] }))).toBeNull();
  });

  it("rematches subtitle holds by their forced flag, and Off only where it is allowed", () => {
    const forced = text("2", "en", { forced: true, label: "English" });
    const plain = text("1", "en", { label: "English" });
    const hold = holdOf({ kind: "subtitles", track: forced });
    expect(rematch(hold, snapshot({ subtitles: [plain, forced] }))).toEqual({
      kind: "subtitles",
      track: forced,
    });
    const off = holdOf({ kind: "subtitles", track: null });
    expect(off).toEqual({ group: "subtitles", off: true });
    expect(rematch(off, snapshot({ offAllowed: false }))).toBeNull();
    expect(rematch(off, snapshot({ offAllowed: true }))).toEqual({
      kind: "subtitles",
      track: null,
    });
  });

  it("confirms the requested track by id at its revision, and only uniquely by description later", () => {
    expect(confirms(pickGerman, 4, snapshot({ revision: 4, selectedAudio: "3" }))).toBe(true);
    expect(confirms(pickGerman, 4, snapshot({ revision: 4, selectedAudio: "1" }))).toBe(false);
    // At a newer revision "3" is another track's position: the same id is no evidence.
    const other = sound("0", "de");
    const reordered = [other, sound("3", "en", { label: "English" })];
    expect(
      confirms(pickGerman, 4, snapshot({ revision: 5, audio: reordered, selectedAudio: "3" })),
    ).toBe(false);
    const moved = sound("1", "de", { label: "Deutsch", name: "Main" });
    expect(
      confirms(pickGerman, 4, snapshot({ revision: 5, audio: [other, moved], selectedAudio: "1" })),
    ).toBe(true);
  });

  it("confirms Off only in a ready group that still allows it with nothing selected", () => {
    const off: ObservedTrackSelection = { kind: "subtitles", track: null };
    expect(confirms(off, 3, snapshot({ revision: 3 }))).toBe(true);
    expect(confirms(off, 3, snapshot({ revision: 4, offAllowed: false }))).toBe(false);
    for (const subtitleState of ["absent", "loading", "unavailable"] as const) {
      expect(confirms(off, 3, snapshot({ revision: 3, subtitleState }))).toBe(false);
    }
    expect(
      confirms(
        off,
        3,
        snapshot({ revision: 3, subtitles: [text("0", "en")], selectedSubtitle: "0" }),
      ),
    ).toBe(false);
  });
});

describe("remembering a manual pick", () => {
  const context: TrackContext = { media: "file", titleLanguage: "en", originalLanguage: "fr" };

  it("saves the last confirmed pick of a choice, compared with the current accepted globals", () => {
    let accepted: MediaPolicy = { audio: { kind: "follow-title" }, subtitles: { kind: "off" } };
    const first = remembered({ kind: "audio", track: sound("1", "ger") }, "de", accepted, context);
    expect(first).toEqual({ field: "audio", value: { kind: "language", language: "de" } });
    accepted = { ...accepted, audio: { kind: "language", language: "de" } };
    expect(
      remembered({ kind: "audio", track: sound("0", "eng") }, "en", accepted, context),
    ).toEqual({ field: "audio", value: { kind: "language", language: "en" } });
    const dutch = remembered(
      { kind: "subtitles", track: text("2", "dut") },
      "en",
      accepted,
      context,
    );
    expect(dutch).toEqual({ field: "subtitles", value: { kind: "language", language: "nl" } });
    accepted = { ...accepted, subtitles: { kind: "language", language: "nl" } };
    expect(remembered({ kind: "subtitles", track: null }, "en", accepted, context)).toEqual({
      field: "subtitles",
      value: { kind: "off" },
    });
  });

  it("keeps follow-title and original while they already say it, and holds what no global choice can", () => {
    const follow: MediaPolicy = { audio: { kind: "follow-title" }, subtitles: { kind: "off" } };
    expect(
      remembered({ kind: "audio", track: sound("0", "en") }, "en", follow, context),
    ).toBeNull();
    const original: MediaPolicy = { ...follow, audio: { kind: "original" } };
    expect(
      remembered({ kind: "audio", track: sound("1", "fre") }, "fr", original, context),
    ).toBeNull();
    expect(
      remembered({ kind: "audio", track: sound("2", "ger") }, "de", original, context),
    ).toEqual({
      field: "audio",
      value: { kind: "language", language: "de" },
    });
    expect(
      remembered({ kind: "audio", track: sound("3", "jpn") }, "ja", follow, context),
    ).toBeNull();
    expect(
      remembered({ kind: "audio", track: sound("4", null) }, null, follow, context),
    ).toBeNull();
    expect(remembered({ kind: "subtitles", track: null }, "en", follow, context)).toBeNull();
    expect(
      remembered({ kind: "subtitles", track: text("5", "jpn") }, "en", follow, context),
    ).toBeNull();
  });

  it("turns forced subtitles into forced-only only for the confirmed sound's language", () => {
    const german: MediaPolicy = {
      audio: { kind: "follow-title" },
      subtitles: { kind: "language", language: "de" },
    };
    const forcedEnglish = text("0", "en", { forced: true });
    expect(remembered({ kind: "subtitles", track: forcedEnglish }, "en", german, context)).toEqual({
      field: "subtitles",
      value: { kind: "forced-only" },
    });
    expect(
      remembered({ kind: "subtitles", track: forcedEnglish }, "fr", german, context),
    ).toBeNull();
    expect(
      remembered({ kind: "subtitles", track: forcedEnglish }, undefined, german, context),
    ).toBeNull();
    const forcedOnly: MediaPolicy = { ...german, subtitles: { kind: "forced-only" } };
    expect(
      remembered({ kind: "subtitles", track: forcedEnglish }, "en", forcedOnly, context),
    ).toBeNull();
  });
});

describe("observed file tracks", () => {
  it("lists playable track languages once audio is ready and subtitles are known", () => {
    const audio = [
      sound("0", "eng"),
      sound("1", "ger", { isPlayable: false }),
      sound("2", "und"),
      sound("3", null),
    ];
    expect(observedFileTracks(snapshot({ audio, subtitleState: "absent" }))).toEqual({
      audio: ["en", null, null],
      subtitles: [],
    });
    const subtitles = [text("0", "fre", { forced: true }), text("1", "nl")];
    expect(observedFileTracks(snapshot({ audio, subtitles }))).toEqual({
      audio: ["en", null, null],
      subtitles: ["fr", "nl"],
    });
  });

  it("says nothing while a group is unknown, or rather than cut a long list short", () => {
    const audio = [sound("0", "en")];
    expect(observedFileTracks(snapshot({ audioState: "loading" }))).toBeNull();
    expect(observedFileTracks(snapshot({ audioState: "absent" }))).toBeNull();
    for (const subtitleState of ["loading", "unavailable"] as const) {
      expect(observedFileTracks(snapshot({ audio, subtitleState }))).toBeNull();
    }
    const many = (count: number) =>
      Array.from({ length: count }, (_, at) => sound(String(at), "en"));
    expect(observedFileTracks(snapshot({ audio: many(32) }))?.audio).toHaveLength(32);
    expect(observedFileTracks(snapshot({ audio: many(33) }))).toBeNull();
  });
});

describe("Live recovery", () => {
  const watched = { live: true, attended: true, held: false, sourceStands: true };
  const network: PlaybackFailure = { kind: "native", failure: { kind: "network", evidence: null } };
  const native = (kind: "auth" | "missing" | "unknown" | "decode"): PlaybackFailure => ({
    kind: "native",
    failure: { kind, evidence: null },
  });
  const starting: Recovery = {
    candidates: 3,
    candidate: 0,
    playedOn: null,
    reconnects: 0,
    playedMs: 0,
  };

  it("keeps the desktop's reconnect waits and stable time", () => {
    expect(RECONNECT_DELAYS_MS).toEqual([1000, 2000, 4000, 8000]);
    expect(STABLE_PLAYBACK_MS).toBe(30_000);
  });

  it("tries again only for a watched Live stream the viewer didn't pause, under its own login", () => {
    expect(nextStep(network, starting, watched)).toEqual({ kind: "candidate", candidate: 1 });
    for (const context of [
      { ...watched, live: false },
      { ...watched, attended: false },
      { ...watched, held: true },
      { ...watched, sourceStands: false },
    ]) {
      expect(nextStep(network, starting, context)).toEqual({ kind: "fail" });
    }
  });

  it("tries the next candidate before one plays, and stops at refusals and app failures", () => {
    for (const failure of [
      network,
      native("missing"),
      native("unknown"),
      native("decode"),
      { kind: "deadline", stage: "startup" } as const,
    ]) {
      expect(nextStep(failure, starting, watched)).toEqual({ kind: "candidate", candidate: 1 });
    }
    expect(nextStep(network, { ...starting, candidate: 2 }, watched)).toEqual({ kind: "fail" });
    for (const failure of [
      native("auth"),
      { kind: "format", failure: { kind: "refused", status: 403 } },
      { kind: "format", failure: { kind: "network", detail: "" } },
      { kind: "lookup", error: { kind: "no-subscription" } },
      { kind: "detach-timeout" },
      { kind: "reset" },
    ] satisfies PlaybackFailure[]) {
      expect(nextStep(failure, starting, watched)).toEqual({ kind: "fail" });
    }
  });

  it("reconnects the stream that played after 1, 2, 4 and 8 seconds, earned back by playing", () => {
    const played: Recovery = { ...starting, candidate: 1, playedOn: 1, playedMs: 5000 };
    expect(nextStep(network, played, watched)).toEqual({
      kind: "reconnect",
      candidate: 1,
      delayMs: 1000,
      reconnects: 1,
    });
    expect(nextStep(network, { ...played, reconnects: 3 }, watched)).toMatchObject({
      delayMs: 8000,
      reconnects: 4,
    });
    expect(nextStep(network, { ...played, reconnects: 4 }, watched)).toEqual({ kind: "fail" });
    expect(
      nextStep(network, { ...played, reconnects: 4, playedMs: STABLE_PLAYBACK_MS }, watched),
    ).toMatchObject({ delayMs: 1000, reconnects: 1 });
    for (const failure of [
      native("unknown"),
      { kind: "deadline", stage: "stall" },
      { kind: "deadline", stage: "startup" },
    ] satisfies PlaybackFailure[]) {
      expect(nextStep(failure, played, watched)).toMatchObject({ kind: "reconnect" });
    }
    for (const failure of [native("missing"), native("decode"), native("auth")]) {
      expect(nextStep(failure, played, watched)).toEqual({ kind: "fail" });
    }
  });

  it("opens at most 3 + 4 streams until one plays 30 seconds, and 4 after", () => {
    let recovery = starting;
    let opens = 1;
    for (;;) {
      const step = nextStep(network, recovery, watched);
      if (step.kind === "fail") break;
      opens++;
      // The third candidate plays for a moment; every reconnect breaks off again at once.
      recovery =
        step.kind === "candidate"
          ? { ...recovery, candidate: step.candidate, playedOn: step.candidate === 2 ? 2 : null }
          : { ...recovery, candidate: step.candidate, reconnects: step.reconnects, playedMs: 1000 };
    }
    expect(opens).toBe(7);
    recovery = { ...recovery, playedMs: STABLE_PLAYBACK_MS };
    let after = 0;
    for (;;) {
      const step = nextStep(network, recovery, watched);
      if (step.kind !== "reconnect") break;
      after++;
      recovery = { ...recovery, reconnects: step.reconnects, playedMs: 0 };
    }
    expect(after).toBe(4);
  });
});
