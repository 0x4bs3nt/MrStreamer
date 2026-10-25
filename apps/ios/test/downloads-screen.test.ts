import * as React from "react";
import type { Download, DownloadList } from "@mrstreamer/contracts/downloads";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// Downloads as the viewer meets it: the queue, then the copies, and what each row's tap, button,
// sheet and VoiceOver actions ask of the downloads owner. The real screen runs with React DOM on
// a happy-dom window, as details-screen.test.ts does. React Native's list draws its sections in
// order, each pressable is kept by its test id so the test can tap it, long-press it or run a
// VoiceOver action, sheets answer as the test picks, and the owner records what it was asked.

const REACT_DOM = "react-dom/client";
const window = new Window();
Object.assign(globalThis, { window, document: window.document });
const { document } = window;
type Root = { render(node: unknown): void; unmount(): void };
const { createRoot } = (await import(REACT_DOM)) as { createRoot(container: object): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Touchable {
  readonly onPress?: () => void;
  readonly onLongPress?: () => void;
  readonly accessibilityLabel?: string;
  readonly accessibilityActions?: readonly { name: string }[];
  readonly onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
}

const scenario = vi.hoisted(() => ({
  list: { items: [], series: {}, bytes: 0, free: null, ended: 0 } as DownloadList,
  pressables: new Map<string, Touchable>(),
  sheet: null as null | { title?: string; options: readonly string[]; pick: (at: number) => void },
  asked: [] as string[],
}));

vi.mock("react-native", async () => {
  const { createElement, Fragment } = await import("react");
  type Props = { children?: React.ReactNode; testID?: string };
  const box = ({ children }: Props) => createElement("div", null, children);
  type Section = { key: string; data: readonly { id: string }[] };
  return {
    View: box,
    Text: ({ children }: Props) => createElement("p", null, children),
    Pressable: (props: Props & Touchable & { children?: unknown }) => {
      if (props.testID) scenario.pressables.set(props.testID, props);
      const children =
        typeof props.children === "function"
          ? (props.children as (state: object) => React.ReactNode)({ pressed: false })
          : props.children;
      return createElement("div", null, children as React.ReactNode);
    },
    SectionList: (props: {
      sections: readonly Section[];
      renderSectionHeader: (info: { section: Section }) => React.ReactNode;
      renderSectionFooter: (info: { section: Section }) => React.ReactNode;
      renderItem: (info: { item: { id: string } }) => React.ReactNode;
      ListEmptyComponent: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
    }) =>
      createElement(
        "div",
        null,
        props.sections.length === 0 ? props.ListEmptyComponent : null,
        props.sections.map((section) =>
          createElement(
            Fragment,
            { key: section.key },
            props.renderSectionHeader({ section }),
            section.data.map((item) =>
              createElement(Fragment, { key: item.id }, props.renderItem({ item })),
            ),
            props.renderSectionFooter({ section }),
          ),
        ),
        props.ListFooterComponent,
      ),
    Animated: {
      View: box,
      Value: class {
        setValue() {}
      },
      timing: () => ({ start: () => undefined }),
    },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1 },
    useWindowDimensions: () => ({ fontScale: 1 }),
    Alert: { alert: (title: string) => scenario.asked.push(`alert ${title}`) },
    ActionSheetIOS: {
      showActionSheetWithOptions: (
        { title, options }: { title?: string; options: readonly string[] },
        pick: (at: number) => void,
      ) => {
        scenario.sheet = { ...(title ? { title } : {}), options, pick };
      },
    },
  };
});
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("../src/glass.tsx", async () => {
  const { createElement } = await import("react");
  return {
    Glass: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
  };
});
vi.mock("../src/titles-ui.tsx", () => ({ Artwork: () => null }));
vi.mock("../src/ui.tsx", async () => {
  const { createElement } = await import("react");
  return {
    colors: { text: "#FFFFFF", dim: "#A1A1A6", line: "#2C2C2E" },
    Notice: ({ failure }: { failure: { headline: string; advice: string } }) =>
      createElement("p", null, `${failure.headline} ${failure.advice}`),
  };
});
vi.mock("../src/downloads.ts", () => ({
  useDownloads: () => scenario.list,
  downloadList: () => scenario.list,
  useDownloadOf: () => undefined,
  addDownload: async () => undefined,
  playDownload: (id: string) => scenario.asked.push(`play ${id}`),
  removeDownload: async (id: string) => {
    scenario.asked.push(`remove ${id}`);
  },
  retryDownload: async (id: string) => {
    scenario.asked.push(`retry ${id}`);
  },
}));

const { DownloadsScreen } = await import("../src/downloads-screen.tsx");

const base = {
  subscription: { id: "a", name: "Northside" },
  episodeName: null,
  year: 2024,
  duration: 6720,
  originalLanguage: null,
  posterUrl: null,
  wideUrl: null,
  size: null,
  progress: null,
  series: null,
} as const;
const movie = (id: string, name: string, rest: Partial<Download>): Download => ({
  ...base,
  id,
  name,
  title: { kind: "movie", id },
  status: { kind: "queued" },
  ...rest,
});

const transferring: Download = {
  ...base,
  id: "t",
  name: "Paper Harbor",
  title: { kind: "episode", id: "e3", seriesId: "s", season: 1, episode: 3 },
  episodeName: "The Tide Table",
  size: 1_400_000_000,
  status: {
    kind: "transferring",
    received: 590_000_000,
    size: 1_400_000_000,
    rate: 810_000_000 / 360,
    restarted: false,
  },
};
const waiting = movie("w", "Lowland", { status: { kind: "waiting" }, size: 1_900_000_000 });
const queued = movie("q", "Glass Orchard", {});
const failed = movie("f", "Kettle Run", {
  status: { kind: "failed", failure: { kind: "disk-full", needed: 1_200_000_000 } },
});
const complete = movie("c", "North of Quiet", {
  status: { kind: "complete" },
  size: 2_100_000_000,
  progress: { position: 4440, duration: 6720 },
});
const kept = movie("k", "Small Hours", { status: { kind: "complete" }, subscription: null });
const missing = movie("m", "Red Meridian", { status: { kind: "missing" } });

let unmount = () => {};
let redraw = () => {};
afterEach(() => {
  unmount();
  scenario.pressables.clear();
  scenario.sheet = null;
  scenario.asked.length = 0;
});

function show(items: readonly Download[], bytes = 0, free: number | null = null) {
  scenario.list = { items, series: {}, bytes, free, ended: 0 };
  const container = document.createElement("div");
  const root = createRoot(container);
  React.act(() => root.render(React.createElement(DownloadsScreen)));
  unmount = () => React.act(() => root.unmount());
  redraw = () => React.act(() => root.render(React.createElement(DownloadsScreen)));
  return container;
}

/** The owner's list moves on, as it can while a sheet stays open, and the screen redraws. */
function publish(...items: Download[]) {
  scenario.list = { ...scenario.list, items };
  redraw();
}

const row = (id: string) => scenario.pressables.get(`download-${id}`)!;
/** The row's trailing glass button, by what it does. */
const button = (id: string, label: string) => scenario.pressables.get(`download-${id}-${label}`)!;
/** Answers the sheet on show with the option `label`. */
async function pick(label: string) {
  const sheet = scenario.sheet!;
  scenario.sheet = null;
  React.act(() => sheet.pick(sheet.options.indexOf(label)));
  await React.act(async () => undefined);
}
const settled = () => React.act(async () => undefined);

describe("Downloads", () => {
  it("lists the queue in the order added, then the copies, with the storage line", () => {
    const shown = show(
      [transferring, waiting, queued, failed, complete, kept],
      3_700_000_000,
      61_000_000_000,
    ).textContent;
    const order = [
      "Queue",
      "Paper Harbor",
      "42% · 590 MB of 1.4 GB · 6 min left",
      "Waiting while Northside plays",
      "Queued",
      "Disk full. Free 1.2 GB, then retry.",
      "A download continues in the background; the next starts once the app is open.",
      "On this iPhone",
      "2024 · 1 h 52 min · 2.1 GB",
      "38 min left",
      "Provider removed, copy kept",
      "3.7 GB on this iPhone · 61 GB free",
    ];
    const at = order.map((text) => shown.indexOf(text));
    expect(at).not.toContain(-1);
    expect(at).toEqual(at.toSorted((a, b) => a - b));
  });

  it("leaves out an empty section, and says when nothing is there", () => {
    const copies = show([complete]).textContent;
    expect(copies).not.toContain("Queue");
    expect(copies).not.toContain("continue only while");
    unmount();
    expect(show([]).textContent).toContain("Nothing downloaded yet.");
  });

  it("plays a copy from its row and button, and never acts on a tap of a queue row", () => {
    show([queued, transferring, complete]);
    expect(row("q").onPress).toBeUndefined();
    expect(row("t").onPress).toBeUndefined();
    row("c").onPress!();
    button("c", "Play offline").onPress!();
    expect(scenario.asked).toEqual(["play c", "play c"]);
  });

  it("cancels a waiting download at once and asks before ending a transfer", async () => {
    show([waiting, transferring]);
    button("w", "Cancel download").onPress!();
    await settled();
    expect(scenario.asked).toEqual(["remove w"]);

    button("t", "Cancel download").onPress!();
    expect(scenario.sheet?.title).toBe("Cancel downloading Paper Harbor · S1 E3?");
    await pick("Keep downloading");
    expect(scenario.asked).toEqual(["remove w"]);
    button("t", "Cancel download").onPress!();
    await pick("Cancel download");
    expect(scenario.asked).toEqual(["remove w", "remove t"]);
  });

  it("retries a failed download, with Remove and its reason on long-press", async () => {
    show([failed]);
    button("f", "Retry").onPress!();
    await settled();
    expect(scenario.asked).toEqual(["retry f"]);

    row("f").onLongPress!();
    expect(scenario.sheet?.title).toBe("Disk full. Free 1.2 GB, then retry.");
    expect(scenario.sheet?.options).toEqual(["Retry", "Remove", "Cancel"]);
    await pick("Remove");
    expect(scenario.asked).toEqual(["retry f", "remove f"]);
  });

  it("deletes a copy only once asked, and a missing one at once", async () => {
    show([complete, missing]);
    row("c").onLongPress!();
    expect(scenario.sheet?.options).toEqual(["Play offline", "Delete download", "Cancel"]);
    await pick("Delete download");
    expect(scenario.sheet?.title).toBe("Delete the 2.1 GB copy of North of Quiet?");
    await pick("Delete download");
    button("m", "Delete download").onPress!();
    await settled();
    expect(scenario.asked).toEqual(["remove c", "remove m"]);
  });

  it("gives VoiceOver one element per row with its actions", async () => {
    show([transferring, complete]);
    expect(row("t").accessibilityLabel).toBe(
      "Paper Harbor, season 1 episode 3, The Tide Table, 1.4 GB, 42%, 590 MB of 1.4 GB, 6 min left",
    );
    expect(row("t").accessibilityActions?.map((action) => action.name)).toEqual([
      "Cancel download",
    ]);
    expect(row("c").accessibilityActions?.map((action) => action.name)).toEqual([
      "activate",
      "Play offline",
      "Delete download",
    ]);
    row("c").onAccessibilityAction!({ nativeEvent: { actionName: "activate" } });
    row("c").onAccessibilityAction!({ nativeEvent: { actionName: "Delete download" } });
    await pick("Delete download");
    expect(scenario.asked).toEqual(["play c", "remove c"]);
  });
});

describe("a sheet left open while the download moves on", () => {
  const nowQueued = (status: Download["status"]): Download => ({ ...queued, status });

  it("asks before ending a transfer that started under it", async () => {
    show([queued]);
    row("q").onLongPress!();
    publish(nowQueued(transferring.status));
    await pick("Cancel download");
    expect(scenario.asked).toEqual([]);
    expect(scenario.sheet?.title).toBe("Cancel downloading Glass Orchard?");
    await pick("Cancel download");
    expect(scenario.asked).toEqual(["remove q"]);
  });

  it("keeps a copy that finished under its Cancel, or under the confirmation", async () => {
    show([queued]);
    row("q").onLongPress!();
    publish(nowQueued({ kind: "complete" }));
    await pick("Cancel download");
    expect(scenario.sheet).toBeNull();

    publish(nowQueued(transferring.status));
    row("q").onLongPress!();
    await pick("Cancel download");
    publish(nowQueued({ kind: "complete" }));
    await pick("Cancel download");
    expect(scenario.asked).toEqual([]);
  });

  it("cancels one still waiting at once, and does nothing for one that went", async () => {
    show([queued, failed, complete]);
    row("q").onLongPress!();
    publish(nowQueued({ kind: "waiting" }), failed, complete);
    await pick("Cancel download");
    expect(scenario.asked).toEqual(["remove q"]);

    row("f").onLongPress!();
    publish(complete);
    await pick("Remove");
    row("c").onLongPress!();
    await pick("Delete download");
    publish();
    await pick("Delete download");
    expect(scenario.asked).toEqual(["remove q"]);
    expect(scenario.sheet).toBeNull();
  });
});
