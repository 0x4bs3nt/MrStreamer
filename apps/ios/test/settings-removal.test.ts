import * as React from "react";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Member } from "../src/account.ts";

// Removing a provider from Settings when the removal doesn't all go through: a removal the
// registry refused leaves the provider saved, and Settings says so; a removal that went through
// with history still to delete says that instead. The real Settings run with React DOM on a
// happy-dom window, as provider-form.test.ts does; the action sheet and alerts answer as the test
// picks, and `remove` fails the way the account owner does on each side of its registry write.

const REACT_DOM = "react-dom/client";
const window = new Window();
Object.assign(globalThis, { window, document: window.document, __DEV__: false });
const { document, Event } = window;
type Root = { render(node: unknown): void; unmount(): void };
const { createRoot } = (await import(REACT_DOM)) as { createRoot(container: object): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
}));

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  type Props = { children?: React.ReactNode; testID?: string };
  const box = ({ children, testID }: Props) =>
    createElement("div", { "data-testid": testID }, children);
  return {
    View: box,
    ScrollView: box,
    Text: ({ children }: Props) => createElement("span", null, children),
    Image: () => null,
    Switch: () => null,
    Linking: { openURL: async () => undefined },
    Pressable: ({ children, testID, onPress }: Props & { onPress: () => void }) =>
      createElement("button", { "data-testid": testID, onClick: onPress }, children),
    StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1 },
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
  };
});
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.0.0" } } }));
vi.mock("expo-router", () => ({ router: { push: () => undefined } }));
vi.mock("expo-video", () => ({ isPictureInPictureSupported: () => true }));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
// Downloads open from a row of their own, which this test leaves out.
vi.mock("../src/downloads-screen.tsx", () => ({ DownloadsLink: () => null }));
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
