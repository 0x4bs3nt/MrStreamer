// Runs the installed production JS binding. Native methods are the mocked boundary here;
// this check covers the nonthrowing Expo setter workaround, not Swift behavior.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { SourceTextModule, SyntheticModule } from "node:vm";

const require = createRequire(import.meta.url);
let writes = 0;
let recreations = 0;
let hookDefinition:
  | {
      factory(): NativePlayer;
      update(
        player: NativePlayer,
        context: { previousDependencies: unknown[]; dependencies: unknown[] },
      ): Promise<void> | undefined;
    }
  | undefined;
class NativePlayer {
  managed = false;
  audio: unknown = null;
  subtitles: unknown = null;
  replace(): void {}
  async replaceAsync(): Promise<void> {}
  async replaceObservedAsync(): Promise<{ kind: "attached" }> {
    this.managed = true;
    return { kind: "attached" };
  }
  _assertLegacyPlayback(): void {
    if (this.managed) {
      throw Object.assign(new Error("Native function failed: ERR_OBSERVED_LEGACY_WRITE"), {
        code: "ERR_FUNCTION_CALL",
      });
    }
  }
}
// Match Expo's non-configurable accessors on the native class prototype.
for (const [key, field] of [
  ["audioTrack", "audio"],
  ["subtitleTrack", "subtitles"],
] as const) {
  Object.defineProperty(NativePlayer.prototype, key, {
    get(this: NativePlayer) {
      return this[field];
    },
    set(this: NativePlayer, value: unknown) {
      writes++;
      this[field] = value;
    },
  });
}
const module = new SourceTextModule(
  readFileSync(require.resolve("expo-video/build/VideoPlayer.js"), "utf8"),
);
const boundary = (exports: Record<string, unknown>) =>
  new SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  });
await module.link((specifier) => {
  switch (specifier) {
    case "./ExpoVideo":
      return boundary({ default: { VideoPlayer: NativePlayer } });
    case "./resolveAssetSource":
      return boundary({ default: () => ({ uri: "file:///fixture.mp4" }) });
    case "expo-modules-core":
      return boundary({
        useReleasingSharedObjectWithLifecycle: (definition: NonNullable<typeof hookDefinition>) => {
          hookDefinition = definition;
          return definition.factory();
        },
      });
    case "react":
      return boundary({
        useState: () => [
          0,
          () => {
            recreations++;
          },
        ],
      });
    default:
      throw new Error("Unexpected production binding dependency");
  }
});
await module.evaluate();
const legacy = new NativePlayer();
Reflect.set(legacy, "audioTrack", { id: "0" });
assert.equal(writes, 1);
const managed = new NativePlayer();
await managed.replaceObservedAsync();
for (const key of ["audioTrack", "subtitleTrack"]) {
  assert.throws(() => Reflect.set(managed, key, null), {
    code: "ERR_OBSERVED_LEGACY_WRITE",
  });
}
assert.equal(writes, 1);
assert.equal(Reflect.get(managed, "audioTrack"), null);
Reflect.set(legacy, "subtitleTrack", { id: "1" });
assert.equal(writes, 2);
const useVideoPlayer: unknown = Reflect.get(module.namespace, "useVideoPlayer");
assert.equal(typeof useVideoPlayer, "function");
if (typeof useVideoPlayer !== "function") throw new Error("fixture-hook-missing");
const hookPlayer: unknown = useVideoPlayer(null);
assert.ok(hookPlayer instanceof NativePlayer);
await hookPlayer.replaceObservedAsync();
assert.ok(hookDefinition);
const update = hookDefinition.update(hookPlayer, {
  previousDependencies: ["old"],
  dependencies: ["new"],
});
assert.ok(update);
await assert.rejects(update, { code: "ERR_OBSERVED_LEGACY_WRITE" });
assert.equal(recreations, 0);
console.log("Installed binding: managed setters reject; legacy instances keep native accessors.");
