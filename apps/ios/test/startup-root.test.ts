import * as React from "react";
import { Window } from "happy-dom";
import { expect, it, vi } from "vitest";
import type { Roster } from "../src/account.ts";

// The real root and startup owner, with native navigation represented by its registered routes.
// A registry that hasn't answered cannot choose Connect; known subscriptions can show the App
// at the fallback even while credentials remain pending. This is not native layout/timing proof.
const scenario = vi.hoisted(() => ({
  roster: { kind: "restoring" } as Roster,
  changed: new Set<() => void>(),
  finish: () => {},
  prompts: 0,
}));

vi.mock("../src/account.ts", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    scenario.changed.add(listener);
    return () => {
      scenario.changed.delete(listener);
    };
  };
  return {
    useRoster: () => useSyncExternalStore(subscribe, () => scenario.roster),
    currentRoster: () => scenario.roster,
    onRoster: subscribe,
    onCatalogue: () => () => {},
    onReadingSaved: () => () => {},
    channelsWorkedOut: () => true,
    readingSaved: () => false,
    restore: () =>
      new Promise<void>((resolve) => {
        scenario.finish = resolve;
      }),
  };
});
vi.mock("../src/titles.ts", () => ({
  endLaunchBatch: () => {},
  onTitleLists: () => () => {},
  titlesWorkedOut: () => true,
}));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    View: ({ children }: { children?: React.ReactNode }) => createElement("div", null, children),
    Alert: {
      alert: () => {
        scenario.prompts++;
      },
    },
    StyleSheet: { create: <T>(styles: T) => styles },
  };
});
vi.mock("expo-router", async () => {
  const { createElement } = await import("react");
  const Stack = Object.assign(
    ({ children }: { children?: React.ReactNode }) => createElement("main", null, children),
    {
      Screen: ({ name }: { name: string }) => createElement("div", { "data-route": name }),
      Protected: ({ guard, children }: { guard: boolean; children?: React.ReactNode }) =>
        guard ? children : null,
    },
  );
  return {
    DarkTheme: { colors: {} },
    ThemeProvider: ({ children }: { children?: React.ReactNode }) => children,
    Stack,
    usePathname: () => "/",
  };
});
vi.mock("../src/downloads.ts", () => ({ startDownloads: () => {} }));
vi.mock("../src/playback.ts", () => ({ onScreen: () => {} }));
vi.mock("../src/telemetry/index.ts", () => ({
  onTelemetryScreen: () => {},
  startTelemetry: () => {},
  statisticsChoice: () => null,
}));
vi.mock("../src/startup-screen.tsx", async () => {
  const { createElement } = await import("react");
  return {
    holdLaunchScreen: () => {},
    StartupScreen: () => createElement("div", { "data-splash": true }),
  };
});
vi.mock("../src/watch.tsx", async () => {
  const { createElement } = await import("react");
  return { WatchLayer: () => createElement("div", { "data-watch": true }) };
});

it("keeps the splash until routes are known, then mounts saved-account navigation at the expired fallback", async () => {
  const window = new Window();
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const REACT_DOM = "react-dom/client";
  const { createRoot } = (await import(REACT_DOM)) as {
    createRoot(container: object): { render(node: React.ReactNode): void; unmount(): void };
  };
  const { default: RootLayout } = await import("../src/app/_layout.tsx");
  const { currentStartup } = await import("../src/startup.ts");
  const container = window.document.createElement("div");
  const root = createRoot(container);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await React.act(async () => {
      root.render(React.createElement(RootLayout));
    });
    await React.act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(currentStartup().kind).toBe("opening");
    expect(container.querySelector("[data-splash]")).not.toBeNull();
    expect(container.querySelector("main")).toBeNull();
    expect(scenario.prompts).toBe(0);
    await React.act(async () => {
      scenario.roster = {
        kind: "ready",
        members: [
          {
            entry: {
              id: "saved",
              kind: "xtream",
              server: "http://fixture.invalid",
              username: "fixture",
              name: null,
            },
            label: "Saved provider",
            account: null,
            needsSecret: false,
            live: { kind: "idle" },
            titles: { kind: "idle" },
          },
        ],
      };
      for (const changed of scenario.changed) changed();
    });
    expect(currentStartup().kind).toBe("open");
    expect(container.querySelector("[data-splash]")).toBeNull();
    expect(container.querySelector('[data-route="(tabs)"]')).not.toBeNull();
    expect(container.querySelector('[data-route="connect"]')).toBeNull();
    expect(container.querySelector("[data-watch]")).not.toBeNull();
    expect(scenario.prompts).toBe(1);
    await React.act(async () => {
      scenario.finish();
    });
    expect(currentStartup().kind).toBe("open");
    expect(scenario.prompts).toBe(1);
  } finally {
    React.act(() => root.unmount());
    vi.useRealTimers();
    await window.happyDOM.abort();
  }
});
