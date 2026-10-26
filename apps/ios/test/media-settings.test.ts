import { createRoot, document, Event } from "./dom.ts";
import * as React from "react";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Member } from "../src/account.ts";

// The real Settings route rendered over native view/sheet doubles and a temporary disk.

Object.assign(globalThis, { __DEV__: false });

interface Button {
  readonly text: string;
  readonly onPress?: () => void;
}
interface Shown {
  readonly title: string;
  readonly message: string;
  readonly buttons?: readonly Button[];
}

const scenario = vi.hoisted(() => ({
  members: [] as Member[],
  /** The action sheet last shown: its options, and what picking one does. */
  sheet: null as { options: readonly string[]; pick: (index: number) => void } | null,
  alerts: [] as Shown[],
}));

vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
  ActionSheetIOS: {
    showActionSheetWithOptions: (
      { options }: { options: readonly string[] },
      pick: (index: number) => void,
    ) => {
      scenario.sheet = { options, pick };
    },
  },
  Alert: {
    alert: (title: string, message: string, buttons?: readonly Button[]) => {
      scenario.alerts.push({ title, message, ...(buttons ? { buttons } : {}) });
    },
  },
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.0.0" } } }));
vi.mock("expo-router", () => ({
  router: { push: () => undefined },
  useRootNavigationState: () => ({ index: 0, routes: [{ name: "(tabs)" }] }),
}));
vi.mock("expo-video", () => ({ isPictureInPictureSupported: () => true }));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
// Downloads open from a row of their own, which this test leaves out.
vi.mock("../src/downloads-screen.tsx", () => ({ DownloadsLink: () => null }));
// This screen's native header is outside the renderer; its queue button has separate coverage.
vi.mock("../src/download-status.tsx", () => ({ DownloadStatusButton: () => null }));
vi.mock("../src/ui.tsx", () => ({
  colors: { text: "#FFFFFF", dim: "#8E8E93", line: "#38383A" },
  ChannelLogo: () => null,
  TextButton: () => null,
}));
vi.mock("../src/titles.ts", () => ({
  hasTmdb: false,
  useMetadataStatus: () => null,
  useTitleTimings: () => null,
}));
vi.mock("../src/telemetry/index.ts", () => ({
  useStatistics: () => ({ enabled: false, transport: "production" }),
  setStatistics: async () => undefined,
}));
vi.mock("../src/account.ts", () => ({
  useRoster: () => ({ kind: "ready", members: scenario.members }),
  members: () => scenario.members,
  remove: async () => undefined,
  retry: () => undefined,
  reloadChannels: () => undefined,
  reloadTitles: () => undefined,
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
// The actual Settings route imports the real preferences owner. Native views and OS sheets
// are the only UI doubles. The base-revision control must render before a missing row fails.
let Settings: typeof import("../src/app/(tabs)/(home)/settings.tsx").default;
const { native } = await import("./native-files.ts");

let unmount = () => {};
let container: ReturnType<typeof document.createElement>;
beforeEach(async () => {
  vi.resetModules();
  rmSync(join(native.root, "documents"), { force: true, recursive: true });
  mkdirSync(join(native.root, "documents"));
  Settings = (await import("../src/app/(tabs)/(home)/settings.tsx")).default;
  scenario.members = [];
  scenario.alerts.length = 0;
  native.sync = null;
});
afterEach(() => {
  unmount();
  native.sync = null;
  vi.restoreAllMocks();
  scenario.sheet = null;
});
function render() {
  container = document.createElement("div");
  const root = createRoot(container);
  React.act(() => root.render(React.createElement(Settings)));
  unmount = () => React.act(() => root.unmount());
}
function row(name: string) {
  const found = container.querySelector(`[data-testid="settings-${name}"]`);
  if (!found) throw new Error(`Rendered Settings has no ${name} row: ${container.textContent}`);
  return found;
}
function choose(name: string, label: string) {
  React.act(() => row(name).dispatchEvent(new Event("click", { bubbles: true })));
  const sheet = scenario.sheet;
  if (!sheet) throw new Error("No system sheet");
  const at = sheet.options.indexOf(label);
  if (at < 0) throw new Error(`Missing choice ${label}`);
  React.act(() => sheet.pick(at));
}
it("renders four native Media rows with accepted defaults and the device language", () => {
  render();
  expect(row("title-language").textContent).toContain("System default (");
  expect(row("audio").textContent).toContain("Follow title language");
  expect(row("subtitles").textContent).toContain("Only when forced");
  expect(row("live-quality").textContent).toContain("Full HD");
});
it("persists choices through the real rows and restores them on a cold remount", async () => {
  render();
  choose("title-language", "Nederlands");
  choose("audio", "Original language");
  choose("subtitles", "Off");
  choose("live-quality", "4K");
  expect(row("title-language").textContent).toContain("Nederlands");
  unmount();
  vi.resetModules();
  Settings = (await import("../src/app/(tabs)/(home)/settings.tsx")).default;
  render();
  expect(row("title-language").textContent).toContain("Nederlands");
  expect(row("audio").textContent).toContain("Original language");
  expect(row("subtitles").textContent).toContain("Off");
  expect(row("live-quality").textContent).toContain("4K");
});
it("Cancel leaves the row and saved bytes unchanged", () => {
  render();
  choose("title-language", "Français");
  const path = join(native.root, "documents", "media-preferences.json");
  const before = readFileSync(path, "utf8");
  choose("title-language", "Cancel");
  expect(row("title-language").textContent).toContain("Français");
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(scenario.alerts).toEqual([]);
});
it("a lost atomic write keeps the accepted row and reports a safe failure", async () => {
  render();
  choose("title-language", "Nederlands");
  native.sync = (step) => {
    if (step === "move") throw new Error("private disk path/login detail");
  };
  choose("title-language", "Deutsch");
  expect(row("title-language").textContent).toContain("Nederlands");
  expect(scenario.alerts).toEqual([
    {
      title: "Couldn't save media preference",
      message: "Your previous choice is still saved. Try again.",
    },
  ]);
});

it("offers Follow title language explicitly and saves it after another audio policy", () => {
  render();
  choose("audio", "Original language");
  choose("audio", "Follow title language");
  expect(row("audio").textContent).toContain("Follow title language");
});
