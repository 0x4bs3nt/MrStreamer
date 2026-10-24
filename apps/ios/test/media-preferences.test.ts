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
  native.undeletable = null;
  vi.restoreAllMocks();
});

describe("accepted media preferences", () => {
  it("keeps device title default and distinct native policies across cold launches", async () => {
    let app = await restart();
    expect(app.getMediaPreferences()).toEqual({
      titleLanguage: null,
      audio: { kind: "follow-title" },
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
      audio: { kind: "follow-title" },
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
    // A legacy interrupted save has no accepted-backup file yet. A new-owner backup would
    // intentionally take precedence over a pending proposal after losing the primary.
    const accepted = JSON.stringify({ version: 1, titleLanguage: "nl" });
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

it("saves follow-title as its own policy while later title-language choices remain independent", async () => {
  let app = await restart();
  app.updateMediaPreferences("audio", { kind: "original" });
  app.updateMediaPreferences("audio", { kind: "follow-title" });
  app.updateMediaPreferences("titleLanguage", "fr");
  app = await restart();
  expect(app.getMediaPreferences().audio).toEqual({ kind: "follow-title" });
  expect(app.getMediaPreferences().titleLanguage).toBe("fr");
  app.updateMediaPreferences("titleLanguage", null);
  expect(app.getMediaPreferences().audio).toEqual({ kind: "follow-title" });
});

describe("R77 accepted-value recovery", () => {
  const prior = {
    version: 1,
    titleLanguage: "nl",
    audio: { kind: "language", language: "de", futureLayout: "surround" },
    subtitles: { kind: "off" },
    liveQuality: "hd",
    future: { nested: ["keep", 7] },
  };

  it.each([false, true])(
    "recovers Dutch and future leaves after destination deletion, cleanup refused=%s",
    async (cleanupRefused) => {
      writeFileSync(path, JSON.stringify(prior));
      const app = await restart();
      const before = app.getMediaPreferences();
      const heard = vi.fn();
      app.onMediaPreferences(heard);
      native.sync = (step, file) => {
        if (step === "move-after-delete" && file === `${path}.next`)
          throw new Error("move refused after destination deletion");
      };
      native.undeletable = (file) => cleanupRefused && file === `${path}.next`;
      expect(app.updateMediaPreferences("titleLanguage", "fr")).toBe(false);
      expect(app.getMediaPreferences()).toBe(before);
      expect(heard).not.toHaveBeenCalled();
      native.sync = null;
      native.undeletable = null;
      const cold = await restart();
      expect(cold.getMediaPreferences()).toEqual(before);
      // Public unrelated save proves that recovery kept the complete raw accepted contents.
      expect(cold.updateMediaPreferences("liveQuality", "sd")).toBe(true);
      expect(JSON.parse(bytes())).toEqual({ ...prior, liveQuality: "sd" });
    },
  );

  it.each(["write", "move-after-delete"] as const)(
    "a checkpoint %s failure cannot touch the accepted primary",
    async (fault) => {
      writeFileSync(path, JSON.stringify(prior));
      const app = await restart();
      expect(app.updateMediaPreferences("titleLanguage", "fr")).toBe(true);
      const before = app.getMediaPreferences();
      const text = bytes();
      native.sync = (step) => {
        if (step === fault) throw new Error("checkpoint refused");
      };
      expect(app.updateMediaPreferences("titleLanguage", "it")).toBe(false);
      expect(app.getMediaPreferences()).toBe(before);
      expect(bytes()).toBe(text);
      native.sync = null;
      expect((await restart()).getMediaPreferences()).toEqual(before);
    },
  );

  it("reuses a recovered accepted checkpoint after another refused proposal", async () => {
    writeFileSync(path, JSON.stringify(prior));
    const app = await restart();
    app.getMediaPreferences();
    native.sync = (step, file) => {
      if (step === "move-after-delete" && file === `${path}.next`)
        throw new Error("first proposal refused");
    };
    native.undeletable = (file) => file === `${path}.next`;
    expect(app.updateMediaPreferences("titleLanguage", "fr")).toBe(false);
    native.sync = null;
    const cold = await restart();
    expect(cold.getMediaPreferences().titleLanguage).toBe("nl");
    native.sync = (step, file) => {
      if (step === "move" && file === `${path}.next`) throw new Error("second proposal refused");
    };
    expect(cold.updateMediaPreferences("titleLanguage", "it")).toBe(false);
    native.sync = null;
    const again = await restart();
    expect(again.getMediaPreferences().titleLanguage).toBe("nl");
    expect(again.updateMediaPreferences("liveQuality", "uhd")).toBe(true);
    expect(JSON.parse(bytes())).toEqual({ ...prior, liveQuality: "uhd" });
  });

  it("a readable accepted primary stays authoritative over an older checkpoint and refused pending bytes", async () => {
    const app = await restart();
    app.updateMediaPreferences("titleLanguage", "nl");
    app.updateMediaPreferences("titleLanguage", "fr");
    writeFileSync(`${path}.next`, JSON.stringify({ version: 1, titleLanguage: "it" }));
    expect((await restart()).getMediaPreferences().titleLanguage).toBe("fr");
  });

  it.each(["primary", "pending"] as const)(
    "refuses edits after an existing %s text read failed, even when readable later",
    async (candidate) => {
      const destination = candidate === "primary" ? path : `${path}.next`;
      const text = JSON.stringify({ ...prior, version: 88 });
      writeFileSync(destination, text);
      native.sync = (step, file) => {
        if (step === "text" && file === destination) throw new Error("protected file unreadable");
      };
      const app = await restart();
      app.getMediaPreferences();
      const heard = vi.fn();
      app.onMediaPreferences(heard);
      native.sync = null;
      expect(app.updateMediaPreferences("titleLanguage", "fr")).toBe(false);
      expect(readFileSync(destination, "utf8")).toBe(text);
      expect(heard).not.toHaveBeenCalled();
      expect((await restart()).getMediaPreferences().titleLanguage).toBe("nl");
    },
  );
});
