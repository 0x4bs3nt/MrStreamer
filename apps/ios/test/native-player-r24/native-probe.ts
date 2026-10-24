// Call inside a disposable Release/Hermes harness using its actual expo-video player.
// No UI owner, persisted policy, retry timer or mocked native producer is introduced here.
import type {
  PlaybackObservation,
  ObservedItemIdentity,
  ObservedTrackSnapshot,
  VideoPlayer,
} from "expo-video";

function requireFact(value: unknown, fixedCode: string): asserts value {
  if (!value) throw new Error(fixedCode);
}

export async function probeObservedPlayer(
  player: VideoPlayer,
  fixture: { source: { uri: string }; nextSource: { uri: string } },
) {
  requireFact(player.mrStreamerPlaybackContract === 1, "fixture-contract-missing");
  const events: PlaybackObservation[] = [];
  const attached = new Map<number, number>();
  let lastSequence = 0;
  const listener = player.addListener("playbackObservation", (event) => {
    requireFact(event.version === 1 && event.sequence > lastSequence, "fixture-event-order");
    lastSequence = event.sequence;
    if (event.kind === "attached") attached.set(event.attemptId, event.itemId);
    if (event.itemId !== null && event.kind !== "attached" && event.kind !== "detached") {
      requireFact(attached.get(event.attemptId) === event.itemId, "fixture-event-before-attach");
    }
    events.push(event);
  });
  player.timeUpdateEventInterval = 0.1;
  let current = 0;
  try {
    const preclosed = await player.detachObservedAsync(1);
    requireFact(preclosed.kind === "detached", "fixture-pre-admission-detach");
    const cancelled = await player.replaceObservedAsync(fixture.source, 1);
    requireFact(cancelled.kind === "cancelled", "fixture-pre-admission-open");
    current = 2;
    const first = await player.replaceObservedAsync(fixture.source, current);
    requireFact(first.kind === "attached", "fixture-first-attach");
    const identity: ObservedItemIdentity = first;
    const legacyWrites = [
      () => {
        player.audioTrack = null;
      },
      () => {
        player.subtitleTrack = null;
      },
      () => {
        player.replace(null, true);
      },
    ];
    for (const write of legacyWrites) {
      let refused = false;
      try {
        write();
      } catch (error) {
        refused = error instanceof Error && error.message.includes("ERR_OBSERVED_LEGACY_WRITE");
      }
      requireFact(refused, "fixture-legacy-writer-accepted");
    }
    let tracks: ObservedTrackSnapshot | null = null;
    // This deadline limits the fixture, not native network classification or detach settlement.
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      const snapshot = await player.getObservedTracksAsync(identity);
      requireFact(!("kind" in snapshot), "fixture-current-tracks-stale");
      tracks = snapshot;
      if (snapshot.audio.state === "ready" && snapshot.subtitles.state === "ready") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    requireFact(
      tracks?.audio.state === "ready" && tracks.subtitles.state === "ready",
      "fixture-groups-not-ready",
    );
    requireFact(tracks.audio.options.length >= 2, "fixture-audio-options-missing");
    const sound = tracks.audio.options[1];
    requireFact(
      sound?.isDefault && sound.id !== tracks.audio.options[0]?.id,
      "fixture-default-not-second",
    );
    requireFact(
      sound.language === tracks.audio.options[0]?.language,
      "fixture-duplicate-language-missing",
    );
    requireFact(
      tracks.audio.options.some((option) => option.language === undefined),
      "fixture-missing-language-option-missing",
    );
    const marked = tracks.subtitles.options.find((option) => option.label === "Texte");
    const named = tracks.subtitles.options.find(
      (option) => option.label === "Forced by label only",
    );
    requireFact(marked?.forcedOnly && named && !named.forcedOnly, "fixture-forced-facts-wrong");
    for (const option of [...tracks.audio.options, ...tracks.subtitles.options]) {
      requireFact(
        option.attemptId === identity.attemptId &&
          option.itemId === identity.itemId &&
          option.revision === tracks.revision,
        "fixture-track-identity",
      );
    }
    const requested = await player.selectObservedTrackAsync(identity, tracks.revision, {
      kind: "audio",
      track: sound,
    });
    requireFact(requested.kind === "requested", "fixture-exact-audio-not-requested");
    // Readback supplies the checkmark. Request acknowledgement alone is never selection proof.
    let confirmed = false;
    const confirmationUntil = Date.now() + 2_000;
    while (Date.now() < confirmationUntil) {
      const readback = await player.getObservedTracksAsync(identity);
      if (!("kind" in readback) && readback.selectedAudioId === sound.id) {
        confirmed = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    requireFact(confirmed, "fixture-audio-unconfirmed");
    // Exercise consecutive real native group loads after selection has settled.
    // Equivalent groups/options must preserve the revision and selected-ID readback.
    const selected = await player.getObservedTracksAsync(identity);
    const unchanged = await player.getObservedTracksAsync(identity);
    requireFact(!("kind" in selected) && !("kind" in unchanged), "fixture-unchanged-query-stale");
    requireFact(unchanged.revision === selected.revision, "fixture-unchanged-revision");
    requireFact(
      selected.selectedAudioId === sound.id &&
        unchanged.selectedAudioId === selected.selectedAudioId &&
        unchanged.selectedSubtitleId === selected.selectedSubtitleId,
      "fixture-unchanged-selection",
    );
    const retainedSound = selected.audio.options.find((option) => option.id === sound.id);
    requireFact(retainedSound, "fixture-unchanged-audio-missing");
    const repeated = await player.selectObservedTrackAsync(identity, selected.revision, {
      kind: "audio",
      track: retainedSound,
    });
    requireFact(repeated.kind === "requested", "fixture-unchanged-selection-stale");
    const forged = await player.selectObservedTrackAsync(identity, tracks.revision, {
      kind: "audio",
      track: { ...sound, label: "not-the-exact-record" },
    });
    requireFact(forged.kind !== "requested", "fixture-forged-record-accepted");
    const off = await player.selectObservedTrackAsync(identity, tracks.revision, {
      kind: "subtitles",
      track: null,
    });
    requireFact(
      off.kind === (tracks.subtitleOffAllowed ? "requested" : "unavailable"),
      "fixture-off-capability",
    );
    const [a, duplicate] = await Promise.all([
      player.detachObservedAsync(current),
      player.detachObservedAsync(current),
    ]);
    requireFact(
      a.kind === "detached" && duplicate.kind === "detached",
      "fixture-detach-not-settled",
    );
    requireFact(a.providerDisconnect === "unobservable", "fixture-provider-disconnect-claim");
    current = 3;
    const next = await player.replaceObservedAsync(fixture.nextSource, current);
    requireFact(next.kind === "attached", "fixture-next-not-attached");
    const stale = await player.selectObservedTrackAsync(identity, tracks.revision, {
      kind: "audio",
      track: sound,
    });
    requireFact(stale.kind === "stale", "fixture-old-choice-not-stale");
    await player.detachObservedAsync(2);
    const nextTracks = await player.getObservedTracksAsync(next);
    requireFact(!("kind" in nextTracks), "fixture-old-detach-removed-new-item");
    return {
      eventCount: events.length,
      lastSequence,
      audioReadback: confirmed,
      unchangedRevision: unchanged.revision,
      providerDisconnect: a.providerDisconnect,
    };
  } finally {
    if (current > 0) await player.detachObservedAsync(current);
    listener.remove();
  }
}
