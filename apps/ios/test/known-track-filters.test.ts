import { createRoot, window, type Root } from "./dom.ts";
import * as React from "react";
import type { CollectionId, TitleKind } from "@mrstreamer/contracts/ondemand";
import { kindOf } from "@mrstreamer/core/ondemand/catalogue";
import type { ObservedTrackSnapshot } from "expo-video";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { observedFileTracks } from "../src/media-policy.ts";

// Real Titles, controls, poster tiles, account and facts owner over the fake panel and real local
// files. Calling titleFile's public callback models the future consumer, not a native read.

const memory = vi.hoisted(() => ({
  secrets: new Map<string, string>(),
  requests: [] as string[],
  routes: [] as string[],
  presses: new Map<string, () => void>(),
  heldSecrets: [] as Array<() => void>,
  holdSecrets: false,
}));
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("expo-video", () => ({
  createVideoPlayer: () => ({
    addListener: () => undefined,
    replaceAsync: async () => undefined,
    play: () => undefined,
    pause: () => undefined,
  }),
}));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => memory.secrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    memory.secrets.set(key, value);
    if (memory.holdSecrets && key.startsWith("s.")) {
      await new Promise<void>((go) => memory.heldSecrets.push(go));
    }
  },
  deleteItemAsync: async (key: string) => void memory.secrets.delete(key),
}));
vi.mock("expo-router", () => ({ router: { push: (route: string) => memory.routes.push(route) } }));
vi.mock("../src/telemetry/index.ts", () => ({ noteAction: () => undefined }));
vi.mock("../src/header.tsx", () => ({ tabHref: () => "/" }));
vi.mock("../src/tab-bar.ts", () => ({ useFixedTabBar: () => undefined }));
vi.mock("../src/artwork-cache.ts", () => ({ useArtwork: () => ({ kind: "none" }) }));
vi.mock("react-native-safe-area-context", async () => {
  const { createElement } = await import("react");
  return {
    SafeAreaView: ({ children }: { children?: React.ReactNode }) =>
      createElement("div", null, children),
  };
});
vi.mock("react-native", async () => {
  const { reactNative } = await import("./react-native.ts");
  return {
    ...reactNative,
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 2 }),
    Pressable: (props: Parameters<typeof reactNative.Pressable>[0]) => {
      if (props.testID && props.onPress) memory.presses.set(props.testID, props.onPress);
      return reactNative.Pressable(props);
    },
  };
});
vi.mock("../src/loading.tsx", async () => {
  const { createElement } = await import("react");
  const box = ({ children }: { children?: React.ReactNode }) =>
    createElement("div", null, children);
  return {
    Docked: box,
    Placeholders: box,
    Shape: () => null,
    useDockInset: () => 0,
    libraryStatus: () => null,
    loadingStatus: () => null,
  };
});
vi.mock("../src/ui.tsx", async () => {
  const { createElement } = await import("react");
  return {
    colors: {},
    Message: ({
      text,
      action,
    }: {
      text: string;
      action?: { label: string; onPress: () => void };
    }) =>
      createElement(
        "p",
        null,
        text,
        action ? createElement("button", { onClick: action.onPress }, action.label) : null,
      ),
  };
});

const passThrough = globalThis.fetch;
vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
  const url = new URL(input);
  if (url.hostname !== "127.0.0.1") throw new Error("Only the local fake panel is allowed");
  memory.requests.push(url.searchParams.get("action") ?? "login");
  return passThrough(input, init);
});
const { native, Directory, Paths } = await import("./native-files.ts");
interface FakeTitles {
  readonly movies: readonly {
    readonly id: number;
    readonly name: string;
    readonly container: string;
    readonly tmdb?: string;
  }[];
  readonly series: readonly {
    readonly id: number;
    readonly name: string;
    readonly tmdb?: string;
    readonly seasons: readonly (readonly { readonly id: number; readonly container: string }[])[];
  }[];
}
interface FakeProvider {
  readonly url: string;
  serveTitles(select: (all: FakeTitles) => FakeTitles): void;
  close(): Promise<void>;
}
const FAKE_PROVIDER = "../../desktop/test/fake-provider.ts";
const { startFakeProvider } = (await import(FAKE_PROVIDER)) as {
  startFakeProvider(options: {
    username: string;
    password: string;
    channels: number;
    titles: number;
  }): Promise<FakeProvider>;
};
const LOGIN = { username: "browseuser", password: "browse+Pw@1" };
let panel: FakeProvider;
let container: ReturnType<typeof window.document.createElement>;
let root: Root;
let releases: Array<() => void> = [];
let pending: Promise<unknown>[] = [];
beforeAll(async () => {
  panel = await startFakeProvider({ ...LOGIN, channels: 2, titles: 20 });
});
afterAll(async () => {
  await panel.close();
});
beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("EXPO_PUBLIC_TMDB_KEY", "");
  for (const path of ["documents", "cache"])
    rmSync(join(native.root, path), { recursive: true, force: true });
  for (const path of [Paths.document, Paths.cache])
    new Directory(path).create({ idempotent: true });
  native.gate = null;
  native.undeletable = null;
  memory.secrets.clear();
  memory.requests = [];
  memory.routes = [];
  memory.presses.clear();
  memory.holdSecrets = false;
  releases = [];
  pending = [];
  panel.serveTitles((all) => ({
    ...all,
    movies: all.movies
      .filter((movie) => movie.id >= 91000 && movie.id <= 91002)
      .map((movie, at) => ({
        ...movie,
        name:
          at === 0 ? "Same Film 2024 HD (NL)" : at === 1 ? "Same Film 2024 4K (EN)" : "Other Film",
        container: "mp4",
        tmdb: at < 2 ? "77777" : "77778",
      })),
    series: all.series
      .filter((series) => series.id === 80000 || series.id === 80001)
      .map((series, at) => ({
        ...series,
        name: at === 0 ? "Same Show HD (NL)" : "Same Show 4K (EN)",
        tmdb: "77779",
      })),
  }));
  container = window.document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  native.gate = null;
  native.undeletable = null;
  for (const release of memory.heldSecrets.splice(0)) release();
  for (const release of releases) release();
  await Promise.allSettled(pending);
  await React.act(async () => root.unmount());
  vi.unstubAllEnvs();
});

async function until(ready: () => boolean, what: string) {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > 5000) throw new Error(`Timed out waiting for ${what}`);
    await React.act(async () => {
      await new Promise((go) => setTimeout(go, 10));
    });
  }
}
async function launch() {
  const account = await import("../src/account.ts");
  const titles = await import("../src/titles.ts");
  const screens = await import("../src/titles-screen.tsx");
  await account.restore();
  const id = await account.add({ server: panel.url, ...LOGIN });
  if (!id) throw new Error("No subscription");
  await until(
    () => titles.titleLists().kind === "ready" && account.currentCatalogue().kind === "ready",
    "the lists",
  );
  return { ...account, ...titles, ...screens, id };
}
type App = Awaited<ReturnType<typeof launch>>;
async function draw(app: App, kind: TitleKind = "movie", id: CollectionId = "all") {
  await React.act(async () => root.render(React.createElement(app.CollectionScreen, { kind, id })));
}
const buttons = () => [...container.querySelectorAll("button")];
const button = (label: string) =>
  buttons().find((each) => each.getAttribute("aria-label") === label || each.textContent === label);
async function click(label: string) {
  const control = button(label);
  expect(control, label).toBeDefined();
  await React.act(async () => control!.click());
}
const posters = () =>
  [...container.querySelectorAll('[data-testid^="title-"]')].map((node) =>
    node.getAttribute("data-testid"),
  );
async function fileFor(app: App, kind: TitleKind, id: string) {
  if (kind === "movie")
    return app.titleFile({ kind, subscriptionId: app.id, id }, AbortSignal.timeout(5000));
  const lists = app.titleLists();
  const title =
    lists.kind === "ready" ? kindOf(lists.index, kind).byId.get(`${app.id}:${id}`) : undefined;
  if (!title) throw new Error("No series");
  const details = await app.detailsOf({ ...title, subscriptionId: app.id, id });
  const episode = details.kind === "series" ? details.seasons[0]?.episodes[0] : undefined;
  if (!episode) throw new Error("No episode");
  return app.titleFile(
    {
      kind: "episode",
      subscriptionId: app.id,
      seriesId: id,
      id: episode.id,
      season: episode.season,
      episode: episode.number,
    },
    AbortSignal.timeout(5000),
  );
}
async function found(
  app: App,
  kind: TitleKind,
  id: string,
  audio: readonly (string | null)[],
  subtitles: readonly (string | null)[] = [],
) {
  const file = await React.act(() => fileFor(app, kind, id));
  if (!file.observed) throw new Error("No public observation callback");
  await React.act(async () => file.observed!({ audio, subtitles }));
  await expect
    .poll(
      () =>
        button(
          `Audio: ${audio[0] === "nl" ? "Nederlands" : audio[0] === null ? "Unknown" : "English"} · 1`,
        ),
      { timeout: 3000 },
    )
    .toBeDefined();
  return file.observed;
}

describe("Known audio/subtitles on the real title grids", () => {
  it("distinguishes observed Japanese, Russian and unknown languages in accessible choices", async () => {
    const app = await launch();
    await draw(app);
    await click("Sort & filter");
    const observations = await React.act(() =>
      Promise.all(
        [
          { id: "91000", language: "ja" },
          { id: "91001", language: "ru" },
          { id: "91002", language: null },
        ].map(async ({ id, language }) => {
          const file = await fileFor(app, "movie", id);
          if (!file.observed) throw new Error("No public observation callback");
          return { id, language, observed: file.observed };
        }),
      ),
    );
    await React.act(async () => {
      for (const { language, observed } of observations)
        observed({ audio: [language], subtitles: [language] });
    });
    await until(
      () =>
        buttons().filter((node) => node.getAttribute("aria-label") === "Audio: Unknown · 1")
          .length > 0,
      "the observed choices",
    );
    for (const group of ["Audio", "Subtitles"]) {
      const labels = buttons()
        .map((node) => node.getAttribute("aria-label"))
        .filter((label) => label?.startsWith(`${group}:`));
      expect(labels).toEqual([
        `${group}: 日本語 · 1`,
        `${group}: Русский · 1`,
        `${group}: Unknown · 1`,
      ]);
    }
    const requests = memory.requests.length;
    for (const group of ["Audio", "Subtitles"]) {
      for (const [label, id] of [
        ["日本語", "91000"],
        ["Русский", "91001"],
        ["Unknown", "91002"],
      ]) {
        await click(`${group}: ${label} · 1`);
        expect(posters()).toEqual([`title-${id}`]);
      }
    }
    await click("Audio: 日本語 · 1");
    const japanese = observations.find(({ language }) => language === "ja");
    if (!japanese) throw new Error("No Japanese file callback");
    await React.act(async () => japanese.observed({ audio: ["zz"], subtitles: ["zz"] }));
    await until(() => Boolean(button("Audio: zz · 1")), "the changed language");
    expect(container.textContent).toContain("Selected audio: 日本語. No matching files listed.");
    expect(button("Audio: 日本語 · 1")).toBeUndefined();
    await click("Audio: zz · 1");
    expect(posters()).toEqual(["title-91000"]);
    expect(button("Subtitles: zz · 1")).toBeDefined();
    await click("Reset");
    expect(posters()).toHaveLength(2);
    expect(memory.requests.length).toBe(requests);
  });

  it("hides unread choices and labels a read track without a language as Unknown", async () => {
    const app = await launch();
    await draw(app);
    await click("Sort & filter");
    expect(container.textContent).not.toContain("Known audio/subtitles");
    expect(container.textContent).not.toContain("Unavailable. Verified track information");
    expect(container.textContent).toContain("provider name hints, not verified tracks");
    await found(app, "movie", "91000", [null]);
    await found(app, "movie", "91001", [null]);
    expect(button("Audio: Unknown · 1")).toBeDefined();
    expect(button("Subtitles: Unknown · 1")).toBeUndefined();
    const requests = memory.requests.length;
    await click("Audio: Unknown · 1");
    expect(posters()).toHaveLength(1);
    await click("Reset");
    expect(posters()).toHaveLength(2);
    expect(memory.requests.length).toBe(requests);
  });

  it.each(["movie", "series"] as const)(
    "opens the matching %s version under Known alone and resets its active state",
    async (kind) => {
      const app = await launch();
      await draw(app, kind);
      await click("Sort & filter");
      const versions = kind === "movie" ? ["91000", "91001"] : ["80000", "80001"];
      const id = versions.find((version) => !posters().includes(`title-${version}`));
      if (!id) throw new Error("Both versions were rendered as separate titles");
      await found(app, kind, id, ["en"], ["nl"]);
      const requests = memory.requests.length;
      await click("Audio: English · 1");
      expect(button("Sort & filter")?.getAttribute("aria-pressed")).toBe("true");
      expect(button("Audio: English · 1")?.getAttribute("aria-pressed")).toBe("true");
      expect(posters()).toEqual([`title-${id}`]);
      await click(`Show 1 ${kind === "movie" ? "movies" : "series"}`);
      await React.act(async () => memory.presses.get(`title-${id}`)!());
      expect(memory.routes.at(-1)).toBe(
        `/${kind === "movie" ? "films" : "series"}/title/${encodeURIComponent(`${app.id}:${id}`)}?asked=1`,
      );
      await click("Sort & filter");
      await click("Subtitles: Nederlands · 1");
      expect(posters()).toEqual([`title-${id}`]);
      await click("Reset");
      expect(button("Sort & filter")?.getAttribute("aria-pressed")).toBe("false");
      expect(button("Any known track")?.getAttribute("aria-pressed")).toBe("true");
      expect(memory.requests.length).toBe(requests);
    },
  );

  it("keeps same-file counts, declared choices and sort when choosing or clearing Known", async () => {
    const app = await launch();
    await draw(app);
    await click("Sort & filter");
    await found(app, "movie", "91001", ["en"], ["nl"]);
    const requests = memory.requests.length;
    await click("Title");
    await click("4K · 1");
    await click("Nederlands · 0");
    expect(button("Audio: English · 0")).toBeDefined();
    await click("Audio: English · 0");
    expect(posters()).toEqual([]);
    expect(container.textContent).toContain("No titles match these filters.");
    await click("Any known track");
    expect(button("Title")?.getAttribute("aria-pressed")).toBe("true");
    expect(button("4K · 0")?.getAttribute("aria-pressed")).toBe("true");
    expect(button("Nederlands · 0")?.getAttribute("aria-pressed")).toBe("true");
    await click("Any quality");
    expect(posters()).toEqual(["title-91000"]);
    await click("Audio: English · 0");
    expect(posters()).toEqual([]);
    await click("Any file language");
    expect(posters()).toEqual(["title-91001"]);
    expect(button("Subtitles: Nederlands · 1")).toBeDefined();
    expect(memory.requests.length).toBe(requests);
    await click("Reset");
    expect(posters()).toHaveLength(2);
    expect(button("Recently added")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("excludes facts from ineligible HD versions on 4K routes and keeps choices per route", async () => {
    const app = await launch();
    await React.act(async () =>
      root.render(React.createElement(app.TitlesHome, { kind: "movie" })),
    );
    await click("All");
    await click("Sort & filter");
    await found(app, "movie", "91000", ["nl"]);
    await click("Audio: Nederlands · 1");
    await click("Show 1 movies");
    await click("4K");
    await click("Sort & filter");
    expect(container.textContent).not.toContain("Known audio/subtitles");
    expect(posters()).toEqual(["title-91001"]);
    await found(app, "movie", "91001", ["en"]);
    expect(button("Audio: Nederlands · 1")).toBeUndefined();
    await click("Audio: English · 1");
    expect(posters()).toEqual(["title-91001"]);
    await draw(app, "movie", "all");
    expect(posters()).toEqual(["title-91000"]);
    await click("Sort & filter");
    expect(button("Audio: Nederlands · 1")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("updates counts on owner revisions, retains settled facts through unknown groups and fences old presses", async () => {
    const app = await launch();
    await draw(app);
    await click("Sort & filter");
    const observed = await found(app, "movie", "91001", ["en"], ["nl"]);
    await click("Audio: English · 1");
    const oldPress = memory.presses.get("title-91001")!;
    const unknown: ObservedTrackSnapshot = {
      attemptId: 1,
      itemId: 1,
      revision: 2,
      audio: { state: "loading", options: [] },
      subtitles: { state: "unavailable", options: [] },
      subtitleOffAllowed: false,
      selectedAudioId: null,
      selectedSubtitleId: null,
    };
    const unsettled = observedFileTracks(unknown);
    expect(unsettled).toBeNull();
    if (unsettled) observed(unsettled);
    expect(button("Audio: English · 1")).toBeDefined();
    const requests = memory.requests.length;
    await React.act(async () => observed({ audio: ["nl"], subtitles: [] }));
    await until(() => Boolean(button("Audio: Nederlands · 1")), "the changed facts");
    expect(posters()).toEqual([]);
    expect(container.textContent).toContain("Selected audio: English. No matching files listed.");
    await React.act(async () => oldPress());
    expect(memory.routes).toEqual([]);
    await click("Reset");
    expect(posters()).toHaveLength(2);
    expect(memory.requests.length).toBe(requests);
  });

  it.each(["replacement", "rollback"] as const)(
    "removes Known choices during deletion and shows the honest %s result",
    async (how) => {
      const app = await launch();
      await draw(app);
      await click("Sort & filter");
      const observed = await found(app, "movie", "91001", ["en"]);
      const { readFiles } = await import("../src/details-cache.ts");
      await readFiles(app.id, [LOGIN.username, LOGIN.password], () => true);
      await click("Audio: English · 1");
      const source = (await import("../src/sources.ts")).currentSource(app.id);
      if (!source) throw new Error("No signed-in source");
      let release = () => {};
      let held = false;
      const gate = new Promise<void>((go) => {
        release = go;
      });
      releases.push(release);
      if (how === "rollback") {
        native.undeletable = (path) => path.endsWith("/files.json");
        native.gate = (operation, path) => {
          if (operation !== "write" || !path.endsWith("/files.json.next")) return undefined;
          held = true;
          return gate;
        };
        await React.act(async () => observed({ audio: ["en"], subtitles: ["nl"] }));
        await until(() => held, "the queued write");
      } else memory.holdSecrets = true;
      const changing = app.update(app.id, { password: LOGIN.password });
      const outcome = changing.then(
        () => "accepted",
        () => "refused",
      );
      pending.push(outcome);
      await until(() => !app.savable(app.id, source), "the deletion fence");
      await until(() => !button("Any known track"), "the hidden Known controls");
      const requests = memory.requests.length;
      expect(posters()).toEqual([]);
      expect(container.textContent).toContain("No titles match these filters.");
      expect(container.textContent).toContain("Selected audio: English. No matching files listed.");
      expect(container.textContent).not.toContain("Known audio/subtitles");
      if (how === "rollback") {
        native.gate = null;
        const result = await React.act(async () => {
          release();
          return outcome;
        });
        expect(result).toBe("refused");
        await until(() => Boolean(button("Audio: English · 1")), "the restored eligible facts");
        expect(posters()).toEqual(["title-91001"]);
        expect(memory.requests.length).toBe(requests);
      } else {
        await until(() => memory.heldSecrets.length > 0, "the pending password save");
        const result = await React.act(async () => {
          for (const go of memory.heldSecrets.splice(0)) go();
          return outcome;
        });
        expect(result).toBe("accepted");
        await until(() => app.members()[0]?.titles.kind === "ready", "the replacement lists");
        expect(button("Any known track")).toBeUndefined();
        await React.act(async () => observed({ audio: ["en"], subtitles: [] }));
        expect(button("Any known track")).toBeUndefined();
        await click("Reset");
        expect(posters()).toHaveLength(2);
      }
    },
  );
});
