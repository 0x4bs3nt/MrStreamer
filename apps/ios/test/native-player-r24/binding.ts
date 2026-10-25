// Runs the installed production JS binding. Native methods are the mocked boundary here;
// this check covers the nonthrowing Expo setter workaround, not Swift behavior.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { SourceTextModule, SyntheticModule } from "node:vm";

const require = createRequire(import.meta.url);
let writes = 0;
let recreations = 0;
let hookDefinition:
  | {
      factory(): NativePlayer;
      shouldRecreate(
        player: NativePlayer,
        context: { previousDependencies: unknown[]; dependencies: unknown[] },
      ): boolean;
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
  rejectReplacement: ((error: Error) => void) | undefined;
  replaceAsync(): Promise<void> {
    return new Promise((_resolve, reject) => {
      this.rejectReplacement = reject;
    });
  }
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
const sourceBinding = process.argv.includes("--source");
const bindingCode = readFileSync(
  require.resolve(
    sourceBinding ? "expo-video/src/VideoPlayer.tsx" : "expo-video/build/VideoPlayer.js",
  ),
  "utf8",
);
const module = new SourceTextModule(
  sourceBinding ? stripTypeScriptTypes(bindingCode) : bindingCode,
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
const createHookPlayer = useVideoPlayer;
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

const results: Array<{ case: string; passed: boolean }> = [];
const failures: unknown[] = [];
async function control(name: string, test: () => void | Promise<void>) {
  try {
    await test();
    results.push({ case: name, passed: true });
  } catch (error) {
    results.push({ case: name, passed: false });
    failures.push(error);
  }
}
function hook() {
  const player: unknown = createHookPlayer(null);
  assert.ok(player instanceof NativePlayer);
  assert.ok(hookDefinition);
  return { player, definition: hookDefinition };
}
const sourceChange = {
  previousDependencies: ["old", "builder", 0],
  dependencies: ["new", "builder", 0],
};
const fallbackChange = {
  previousDependencies: ["old", "builder", 0],
  dependencies: ["old", "builder", 1],
};
const builderChange = {
  previousDependencies: ["old", "old-builder", 0],
  dependencies: ["old", "new-builder", 0],
};

await control("managed after preflight rejects without scheduling fallback", async () => {
  const { player, definition } = hook();
  const before = recreations;
  const pending = definition.update(player, sourceChange);
  assert.ok(pending);
  assert.ok(player.rejectReplacement);
  await player.replaceObservedAsync();
  // The outer rejection code does not describe current native admission state.
  player.rejectReplacement(
    Object.assign(new Error("synthetic load failure"), { code: "ERR_FUNCTION_CALL" }),
  );
  await assert.rejects(pending, { code: "ERR_OBSERVED_LEGACY_WRITE" });
  assert.equal(recreations, before);
});

await control("managed after fallback scheduled refuses eventual recreation", async () => {
  const { player, definition } = hook();
  const before = recreations;
  const pending = definition.update(player, sourceChange);
  assert.ok(pending);
  assert.ok(player.rejectReplacement);
  player.rejectReplacement(new Error("synthetic legacy failure"));
  await pending;
  assert.equal(recreations, before + 1);
  await player.replaceObservedAsync();
  assert.throws(() => definition.shouldRecreate(player, fallbackChange), {
    code: "ERR_OBSERVED_LEGACY_WRITE",
  });
  assert.throws(() => definition.shouldRecreate(player, fallbackChange), {
    code: "ERR_OBSERVED_LEGACY_WRITE",
  });
  assert.equal(recreations, before + 1, "render-time decisions must not schedule state changes");
});

await control("legacy failures and builder options retain recreation", async () => {
  const { player, definition } = hook();
  const before = recreations;
  const pending = definition.update(player, sourceChange);
  assert.ok(pending);
  assert.ok(player.rejectReplacement);
  player.rejectReplacement(new Error("synthetic legacy failure"));
  await pending;
  assert.equal(recreations, before + 1);
  assert.equal(definition.shouldRecreate(player, fallbackChange), true);
  assert.equal(definition.shouldRecreate(player, builderChange), true);
  assert.equal(definition.shouldRecreate(player, sourceChange), false);
});

await control("managed builder changes cannot recreate the player", async () => {
  const { player, definition } = hook();
  await player.replaceObservedAsync();
  assert.throws(() => definition.shouldRecreate(player, builderChange), {
    code: "ERR_OBSERVED_LEGACY_WRITE",
  });
});

console.log(JSON.stringify({ binding: sourceBinding ? "source" : "build", results }));
if (failures.length) throw new AggregateError(failures, "Production binding controls failed");
console.log("Installed production binding controls passed; native scheduling is not exercised.");
