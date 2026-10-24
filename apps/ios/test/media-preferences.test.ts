import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-file-system", () => import("./native-files.ts"));
const { native } = await import("./native-files.ts");
const path = join(native.root, "documents", "media-preferences.json");
const bytes = () => readFileSync(path, "utf8");
const restart = async () => {
  vi.resetModules();
  return import("../src/media-preferences.ts");
};

beforeEach(() => {
  rmSync(join(native.root, "documents"), { force: true, recursive: true });
  mkdirSync(join(native.root, "documents"));
  native.sync = null;
  native.undeletable = null;
});
afterEach(() => {
  native.sync = null;
  vi.restoreAllMocks();
});

describe("accepted media preferences", () => {
  it("keeps device title default and distinct native policies across cold launches", async () => {
    let app = await restart();
    expect(app.getMediaPreferences()).toEqual({
      titleLanguage: null,
      audio: { kind: "default" },
      subtitles: { kind: "forced-only" },
      liveQuality: "fhd",
    });
    expect(app.updateMediaPreferences("titleLanguage", "nl")).toBe(true);
    expect(app.updateMediaPreferences("audio", { kind: "original" })).toBe(true);
    expect(app.updateMediaPreferences("subtitles", { kind: "off" })).toBe(true);
    expect(app.updateMediaPreferences("liveQuality", "uhd")).toBe(true);
    app = await restart();
    expect(app.getMediaPreferences()).toEqual({
      titleLanguage: "nl",
      audio: { kind: "original" },
      subtitles: { kind: "off" },
      liveQuality: "uhd",
    });
    app.updateMediaPreferences("audio", { kind: "language", language: "fr" });
    app.updateMediaPreferences("subtitles", { kind: "language", language: "de" });
    app.updateMediaPreferences("titleLanguage", null);
    const again = (await restart()).getMediaPreferences();
    expect(again.titleLanguage).toBeNull();
    expect(again.audio).toEqual({ kind: "language", language: "fr" });
    expect(again.subtitles).toEqual({ kind: "language", language: "de" });
  });

  it("isolates an unknown field policy and preserves it and future fields on other saves", async () => {
    const futureAudio = { kind: "spatial", layout: "future" };
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        titleLanguage: "fr",
        audio: futureAudio,
        subtitles: { kind: "off" },
        liveQuality: "hd",
        future: { keep: true },
      }),
    );
    const app = await restart();
    expect(app.getMediaPreferences()).toEqual({
      titleLanguage: "fr",
      audio: { kind: "default" },
      subtitles: { kind: "off" },
      liveQuality: "hd",
    });
    app.updateMediaPreferences("liveQuality", "sd");
    const disk: unknown = JSON.parse(bytes());
    expect(disk).toMatchObject({
      audio: futureAudio,
      future: { keep: true },
      titleLanguage: "fr",
      subtitles: { kind: "off" },
      liveQuality: "sd",
    });
  });

  it.each(["titleLanguage", "audio", "subtitles", "liveQuality"])(
    "parses other valid fields when %s is malformed",
    async (field) => {
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          titleLanguage: "it",
          audio: { kind: "original" },
          subtitles: { kind: "off" },
          liveQuality: "uhd",
          [field]: ["invalid"],
        }),
      );
      const app = await restart();
      const prefs = app.getMediaPreferences();
      if (field !== "titleLanguage") expect(prefs.titleLanguage).toBe("it");
      if (field !== "audio") expect(prefs.audio).toEqual({ kind: "original" });
      if (field !== "subtitles") expect(prefs.subtitles).toEqual({ kind: "off" });
      if (field !== "liveQuality") expect(prefs.liveQuality).toBe("uhd");
      expect(app.updateMediaPreferences("titleLanguage", "nl")).toBe(true);
    },
  );

  it("reads known future-version values without overwriting that file", async () => {
    const original =
      '{ "version": 88, "titleLanguage": "pl", "audio": { "kind": "original" }, "future": 9 }';
    writeFileSync(path, original);
    const app = await restart();
    expect(app.getMediaPreferences().titleLanguage).toBe("pl");
    const heard = vi.fn();
    app.onMediaPreferences(heard);
    expect(app.updateMediaPreferences("titleLanguage", "en")).toBe(false);
    expect(bytes()).toBe(original);
    expect(heard).not.toHaveBeenCalled();
  });

  it("writes before notification, orders rapid choices and skips an accepted duplicate", async () => {
    const app = await restart();
    const heard: string[] = [];
    const stop = app.onMediaPreferences(() => {
      const cold = JSON.parse(bytes()) as { titleLanguage: string };
      expect(cold.titleLanguage).toBe(app.getMediaPreferences().titleLanguage);
      heard.push(cold.titleLanguage);
    });
    app.updateMediaPreferences("titleLanguage", "nl");
    app.updateMediaPreferences("titleLanguage", "fr");
    app.updateMediaPreferences("titleLanguage", "nl");
    const before = bytes();
    const write = vi.fn();
    native.sync = write;
    app.updateMediaPreferences("titleLanguage", "nl");
    expect(write).not.toHaveBeenCalled();
    expect(bytes()).toBe(before);
    expect(heard).toEqual(["nl", "fr", "nl"]);
    stop();
  });

  it.each(["writeSync", "moveSync"] as const)(
    "retains accepted snapshot, bytes and silence after atomic %s failure",
    async (operation) => {
      const state =
        '{"subscription":null,"recent":[],"region":null,"titleVersions":{"a":{"movie:12":"7"}}}';
      writeFileSync(join(native.root, "documents", "state.json"), state);
      const app = await restart();
      app.updateMediaPreferences("titleLanguage", "nl");
      const accepted = app.getMediaPreferences();
      const before = bytes();
      const heard = vi.fn();
      app.onMediaPreferences(heard);
      native.sync = (step) => {
        if (step === (operation === "writeSync" ? "write" : "move"))
          throw new Error("raw private disk detail");
      };
      expect(app.updateMediaPreferences("titleLanguage", "de")).toBe(false);
      expect(app.getMediaPreferences()).toBe(accepted);
      expect(heard).not.toHaveBeenCalled();
      expect(bytes()).toBe(before);
      expect(readFileSync(join(native.root, "documents", "state.json"), "utf8")).toBe(state);
      native.sync = null;
      expect((await restart()).getMediaPreferences().titleLanguage).toBe("nl");
    },
  );
});

it("a refused first move cannot reappear as accepted after restart", async () => {
  const app = await restart();
  native.sync = (step) => {
    if (step === "move") throw new Error("refused");
  };
  expect(app.updateMediaPreferences("titleLanguage", "fr")).toBe(false);
  native.sync = null;
  expect((await restart()).getMediaPreferences().titleLanguage).toBeNull();
});

it.each([false, true])(
  "retains recovered interrupted bytes on the next refused save, corrupt complete=%s",
  async (corrupt) => {
    const app = await restart();
    app.updateMediaPreferences("titleLanguage", "nl");
    const accepted = bytes();
    rmSync(path);
    if (corrupt) writeFileSync(path, "{broken");
    writeFileSync(`${path}.next`, accepted);
    const recovered = await restart();
    expect(recovered.getMediaPreferences().titleLanguage).toBe("nl");
    native.sync = (step) => {
      if (step === "move") throw new Error("refused");
    };
    expect(recovered.updateMediaPreferences("titleLanguage", "fr")).toBe(false);
    native.sync = null;
    expect((await restart()).getMediaPreferences().titleLanguage).toBe("nl");
  },
);

it("keeps the first accepted defaults when proposal move and pending cleanup are both refused", async () => {
  const app = await restart();
  let moves = 0;
  native.sync = (step) => {
    if (step === "move" && ++moves === 2) throw new Error("proposal refused");
  };
  native.undeletable = (file) => file.endsWith(".next");
  expect(app.updateMediaPreferences("titleLanguage", "fr")).toBe(false);
  expect(app.getMediaPreferences().titleLanguage).toBeNull();
  native.sync = null;
  expect((await restart()).getMediaPreferences().titleLanguage).toBeNull();
});
