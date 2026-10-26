import { createRoot, document, Event } from "./dom.ts";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Member, DemoErase, DemoStart } from "../src/account.ts";
import { demoEntry } from "../src/demo.ts";

// Removing a provider from Settings when the removal doesn't all go through: a removal the
// registry refused leaves the provider saved, and Settings says so; a removal that went through
// with history still to delete says that instead. The real Settings run with React DOM on a
// happy-dom window, as provider-form.test.ts does; the action sheet and alerts answer as the test
// picks, and `remove` fails the way the account owner does on each side of its registry write.

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
type Removal = (id: string, options: { keepHistory: boolean }) => Promise<void>;

const scenario = vi.hoisted(() => ({
  members: [] as Member[],
  /** The action sheet last shown: its options, and what picking one does. */
  sheet: null as { options: readonly string[]; pick: (index: number) => void } | null,
  alerts: [] as Shown[],
  remove: (() => Promise.resolve()) as Removal,
  demoResult: { kind: "erased", files: "deleted" } as DemoErase | DemoStart,
  demoActions: [] as string[],
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
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
  endDemo: async () => {
    scenario.demoActions.push("exit");
    return scenario.demoResult;
  },
  resetDemo: async () => {
    scenario.demoActions.push("reset");
    return scenario.demoResult;
  },
  useRoster: () => ({ kind: "ready", members: scenario.members }),
  members: () => scenario.members,
  remove: (id: string, options: { keepHistory: boolean }) => scenario.remove(id, options),
  retry: () => undefined,
  reloadChannels: () => undefined,
  reloadTitles: () => undefined,
}));

const { default: Settings } = await import("../src/app/(tabs)/(home)/settings.tsx");

const cabin: Member = {
  entry: {
    id: "xtream-b",
    kind: "xtream",
    server: "http://b.example:8080",
    username: "two",
    name: "Cabin",
  },
  label: "Cabin",
  account: null,
  needsSecret: false,
  live: { kind: "idle" },
  titles: { kind: "idle" },
};

/** The registry refused the removal: the provider is saved as it was. */
const refused: Removal = () => Promise.reject(new Error("The disk is full"));
/** The removal went through, but some of its history is still to delete. */
const erasePending: Removal = (id) => {
  scenario.members = scenario.members.filter((member) => member.entry.id !== id);
  return Promise.reject(new Error("The disk is full"));
};

let unmount = () => {};
afterEach(() => {
  unmount();
  scenario.sheet = null;
  scenario.alerts.length = 0;
  scenario.demoActions.length = 0;
});

/** Settings with Cabin saved, removed through its row, Remove and the confirmation's `choice`. */
async function removeCabin(choice: string, removal: Removal) {
  scenario.members = [cabin];
  scenario.remove = removal;
  const container = document.createElement("div");
  const root = createRoot(container);
  React.act(() => root.render(React.createElement(Settings)));
  unmount = () => React.act(() => root.unmount());
  React.act(() =>
    container
      .querySelector(`[data-testid="settings-provider-${cabin.entry.id}"]`)!
      .dispatchEvent(new Event("click", { bubbles: true })),
  );
  const sheet = scenario.sheet;
  if (!sheet) throw new Error("No provider sheet");
  React.act(() => sheet.pick(sheet.options.indexOf("Remove")));
  const confirm = scenario.alerts.at(-1);
  expect(confirm?.title).toBe("Remove Cabin?");
  const button = confirm?.buttons?.find((each) => each.text === choice);
  if (!button?.onPress) throw new Error(`No ${choice} button`);
  const press = button.onPress;
  await React.act(async () => {
    press();
    await new Promise((settle) => setTimeout(settle, 0));
  });
  return scenario.alerts.slice(1);
}

describe("removing a provider", () => {
  it.each(["Remove", "Remove and delete history"])(
    "says %s didn't happen when the registry refused it",
    async (choice) => {
      const shown = await removeCabin(choice, refused);
      expect(shown).toEqual([
        {
          title: "Couldn't remove Cabin",
          message: "It's still saved and nothing was deleted. Try again.",
        },
      ]);
    },
  );

  it("says the removal stands when only its history is still to delete", async () => {
    const shown = await removeCabin("Remove and delete history", erasePending);
    expect(shown).toEqual([
      {
        title: "Cabin is removed",
        message: "Its history couldn't all be deleted yet. The app tries again when it next opens.",
      },
    ]);
  });
});

it.each(["Exit demo", "Reset demo data"])(
  "confirms %s and reports unfinished demo removal",
  async (label) => {
    scenario.members = [{ ...cabin, entry: demoEntry, label: "Demo" }];
    scenario.demoResult = { kind: "incomplete", pending: ["downloads"] };
    const container = document.createElement("div");
    const root = createRoot(container);
    React.act(() => root.render(React.createElement(Settings)));
    unmount = () => React.act(() => root.unmount());
    React.act(() =>
      container
        .querySelector('[data-testid="settings-provider-demo"]')!
        .dispatchEvent(new Event("click", { bubbles: true })),
    );
    expect(scenario.sheet?.options).toEqual([
      "Reload channels",
      "Reload movies and series",
      "Reset demo data",
      "Exit demo",
      "Cancel",
    ]);
    React.act(() => scenario.sheet!.pick(scenario.sheet!.options.indexOf(label)));
    const confirm = scenario.alerts.at(-1)!;
    expect(confirm.title).toBe(`${label}?`);
    expect(confirm.message).toContain("Demo downloads");
    expect(confirm.message).toContain("history");
    expect(scenario.demoActions).toEqual([]);
    React.act(() => confirm.buttons!.find((button) => button.text === "Cancel")?.onPress?.());
    expect(scenario.demoActions).toEqual([]);
    await React.act(async () =>
      confirm.buttons!.find((button) => button.text === label)!.onPress!(),
    );
    expect(scenario.demoActions).toEqual([label === "Exit demo" ? "exit" : "reset"]);
    expect(scenario.alerts.at(-1)?.title).toBe("Demo removal incomplete");
  },
);
