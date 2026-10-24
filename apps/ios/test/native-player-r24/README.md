These fixtures exercise the patched production package. No Swift/native result is recorded by adding them.

Run the binding check on Linux, after the frozen iOS install:

```sh
flock -w 30 /home/t3/.local/state/mrstreamer-0.0.14/runtime.lock \
  node --experimental-vm-modules apps/ios/test/native-player-r24/binding.ts
```

It loads the installed `build/VideoPlayer.js` through Node's module VM. Only native module, React and hook boundaries are replaced. It checks that the real binding refuses managed track setters while other instances retain their native accessors. It also checks that a managed hook source update cannot enter the legacy failure/recreate fallback. It proves no Swift behavior.

In ROOT's separately authorized Mac window, run `bash run-facts.sh <owned-output-directory>` from this folder. It compiles the installed production `VideoPlayerObservationFacts.swift` with Apple's real AVFoundation. The canary cases cover allowlisted errors, unknown HTTP-shaped error-log identifiers, bounded underlying errors and cancellation before/after asset registration.

Add `ObservedPlayerContractTests.swift` to a disposable XCTest target linking the exact frozen ExpoVideo/ExpoModulesCore targets with testability enabled. Run that target on the isolated iOS project, keeping its Podfile.lock unchanged. The tests use the actual `VideoPlayer` and existing transport registry to hold production asset preparation. They check pre-admission cancellation, held app work blocking B, duplicate settlement, old detach after B, invalid IDs, and stale track choices. A native preparation that ignores cancellation deliberately remains held until the fixture releases it. No timer becomes a drain receipt.

`native-probe.ts` is a consumer for a disposable Release/Hermes harness with the actual `expo-video` player. Pass synthetic multi-audio/subtitle HLS sources with duplicate English audio, second-option native default, a missing language, subtitles named `Texte` with FORCED=YES and `Forced by label only` with FORCED=NO. It checks attached/event ordering, guarded setters, exact-record selection, native selected-ID readback, Off capability, stale choices and old detach. After selection settles, consecutive unchanged native queries must preserve the revision and selected IDs, and an earlier exact record must remain selectable. This check is unrun; it does not establish whether AVFoundation vends equivalent instances across loads. It emits only counters and fixed facts. It intentionally fails if the expected native facts are not exposed by that fixture.

`observed-tracks.types.ts` checks the public declaration contract using the native record shape, including records without language, known-language controls, required item/revision fields and the guarded-selection consumer. Source and build mirrors must both accept absent language and require consumers to handle `undefined`. This type check proves no native behavior.

Outstanding native fixture work includes deterministic cancellation after loader return but before main attachment, held late track/error callbacks with event capture through Expo, group reorder/late availability, and an actually exposed unplayable media option. The XCTest fixture and probe do not establish audible sound, visible subtitles, exact HTTP responses, remote connection closure, PiP, rotation, Matroska parity, or full-app Release behavior. Those need ROOT's exact native runtime and hardware checks.

Generate the synthetic HLS inputs with `node media-fixture.ts prepare <owned-media-directory>` under the canonical Linux runtime lock. `node media-fixture.ts serve <owned-media-directory> 0` serves them on an owned loopback port and prints that port. Stop that process after the native window. `master.m3u8` and `reordered.m3u8` reuse three audio options and three WebVTT options; the two audible tracks use 440 Hz and 880 Hz tones. `/counts` reports aggregate GET, HEAD, playlist and segment counts. Generated media can be checked by ffprobe on Linux; only Apple's runtime can establish native group exposure, option order, language facts, forced characteristics and rendering.
