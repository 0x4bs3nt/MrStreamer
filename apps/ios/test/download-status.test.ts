import { createRoot, document } from "./dom.ts";
import * as React from "react";
import type { Download, DownloadList } from "@mrstreamer/contracts/downloads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const owner = vi.hoisted(() => ({
  list: { items: [], series: {}, bytes: 0, free: null, ended: 0 } as DownloadList,
  listeners: new Set<() => void>(),
  asked: [] as string[],
}));
vi.mock("../src/downloads.ts", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useDownloads: () =>
      useSyncExternalStore(
        (listener) => {
          owner.listeners.add(listener);
          return () => owner.listeners.delete(listener);
        },
        () => owner.list,
      ),
  };
});
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-router", () => ({ router: { push: (path: string) => owner.asked.push(path) } }));
vi.mock("../src/ui.tsx", () => ({ colors: { text: "#FFFFFF" } }));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    Text: ({ children }: { children: React.ReactNode }) => createElement("span", null, children),
    View: () => null,
    Image: () => null,
    Pressable: ({
      children,
      accessibilityLabel,
      onPress,
    }: {
      children: React.ReactNode;
      accessibilityLabel: string;
      onPress: () => void;
    }) => createElement("button", { "aria-label": accessibilityLabel, onClick: onPress }, children),
    StyleSheet: { create: <T>(styles: T) => styles },
  };
});

const { DownloadStatusButton } = await import("../src/download-status.tsx");
const { tabScreenOptions } = await import("../src/header.tsx");
const item = (status: Download["status"], id = "a"): Download => ({
  id,
  status,
  title: { kind: "movie", id },
  name: "Paper Harbor",
  subscription: { id: "provider", name: "Northwind" },
  episodeName: null,
  year: null,
  duration: null,
  originalLanguage: null,
  posterUrl: null,
  wideUrl: null,
  size: null,
  progress: null,
  series: null,
});
const transferring = (received: number, size: number | null) =>
  item({
    kind: "transferring",
    received,
    size,
    rate: null,
    restarted: false,
  });
let container = document.createElement("div");
let root = createRoot(container);
const button = () => container.querySelector("button");
const label = () => button()?.getAttribute("aria-label");
function publish(items: readonly Download[]) {
  React.act(() => {
    owner.list = { ...owner.list, items };
    for (const listener of owner.listeners) listener();
  });
}
beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
  owner.list = { items: [], series: {}, bytes: 0, free: null, ended: 0 };
  owner.asked.length = 0;
});
afterEach(() => React.act(() => root.unmount()));

describe("the shared Downloads action", () => {
  it("follows real queue updates, then clears progress while keeping its destination", () => {
    React.act(() =>
      root.render(
        React.createElement(DownloadStatusButton, {
          onPress: () => owner.asked.push("downloads"),
        }),
      ),
    );
    expect(label()).toBe("Downloads");
    publish([item({ kind: "queued" })]);
    expect(label()).toBe("Downloads, 1 queued");
    publish([transferring(499, 1000)]);
    expect(container.textContent).toBe("49%");
    expect(label()).toBe("Downloads, Paper Harbor, 49% downloaded");
    publish([transferring(4_200_000, null)]);
    expect(container.textContent).toBe("4 MB");
    publish([item({ kind: "waiting" })]);
    expect(label()).toBe("Downloads, Waiting while Northwind plays");
    publish([item({ kind: "failed", failure: { kind: "disk-full", needed: null } })]);
    expect(label()).toBe("Downloads, 1 failed, open Downloads to retry");
    publish([item({ kind: "complete" }), item({ kind: "missing" }, "b")]);
    expect(label()).toBe("Downloads");
    expect(container.textContent).toBe("");
    React.act(() => button()?.click());
    expect(owner.asked).toEqual(["downloads"]);
  });

  it("keeps an active transfer ahead of waiting, queued and failed items", () => {
    publish([
      item({ kind: "failed", failure: { kind: "disk-full", needed: null } }),
      item({ kind: "queued" }, "b"),
      item({ kind: "waiting" }, "c"),
      transferring(200, 100),
    ]);
    React.act(() => root.render(React.createElement(DownloadStatusButton, { onPress: () => {} })));
    expect(container.textContent).toBe("100%");
    publish([transferring(250, 0)]);
    expect(container.textContent).toBe("250 B");
    expect(container.textContent).not.toContain("%");
  });

  it("adds no Search entry for kept copies or unreachable failures", () => {
    publish([
      item({ kind: "complete" }),
      {
        ...item({ kind: "failed", failure: { kind: "disk-full", needed: null } }),
        subscription: null,
      },
    ]);
    React.act(() =>
      root.render(
        React.createElement(DownloadStatusButton, {
          onlyActive: true,
          onPress: () => owner.asked.push("search downloads"),
        }),
      ),
    );
    expect(button()).toBeNull();
    publish([item({ kind: "queued" })]);
    React.act(() => button()?.click());
    expect(owner.asked).toEqual(["search downloads"]);
    publish([]);
    expect(button()).toBeNull();
  });

  it("keeps each tab header's Downloads route while progress updates", () => {
    for (const tab of ["(home)", "live", "films", "series"] as const) {
      const options = tabScreenOptions(tab)({ route: { name: "index" } });
      const action = options
        .unstable_headerRightItems?.({ tintColor: "#FFFFFF", canGoBack: false })
        .find((each) => each.type === "custom");
      if (!action || action.type !== "custom") throw new Error("No Downloads entry");
      React.act(() => root.render(action.element));
      publish([item({ kind: "queued" })]);
      expect(label()).toBe("Downloads, 1 queued");
      React.act(() => button()?.click());
    }
    expect(owner.asked).toEqual([
      "/downloads",
      "/live/downloads",
      "/films/downloads",
      "/series/downloads",
    ]);
  });
});
