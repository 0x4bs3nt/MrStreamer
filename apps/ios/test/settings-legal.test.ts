import * as React from "react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// Settings' legal rows and Licences, as the viewer meets them: the privacy policy opening in the
// browser, Licences opening on the tab Settings is on, a component's facts and its full notices
// read with no network, and an address iOS won't open saying so. The real screens run with React
// DOM on a happy-dom window, as settings-removal.test.ts does. The last tests hold the committed
// inventory to the inputs it was generated from that CI has without the iOS install.

const REACT_DOM = "react-dom/client";
const window = new Window();
Object.assign(globalThis, { window, document: window.document, __DEV__: false });
const { document, Event } = window;
type Root = { render(node: unknown): void; unmount(): void };
const { createRoot } = (await import(REACT_DOM)) as { createRoot(container: object): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scenario = vi.hoisted(() => ({
  tab: 0,
  params: {} as Record<string, string>,
  pushed: [] as unknown[],
  opened: [] as string[],
  opens: true,
  alerts: [] as { title: string; message: string }[],
  title: "",
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  type Props = {
    children?: React.ReactNode;
    testID?: string;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  };
  const box = ({ children, testID }: Props) =>
    createElement("div", { "data-testid": testID }, children);
  return {
    View: box,
    ScrollView: box,
    Text: ({ children }: Props) => createElement("p", null, children),
    Image: () => null,
    Switch: () => null,
    Pressable: ({
      children,
      testID,
      onPress,
      accessibilityLabel,
      accessibilityRole,
    }: Props & { onPress: () => void }) =>
      createElement(
        "button",
        {
          "data-testid": testID,
          "aria-label": accessibilityLabel,
          "data-role": accessibilityRole,
          onClick: onPress,
        },
        children,
      ),
    StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1 },
    ActionSheetIOS: { showActionSheetWithOptions: () => undefined },
    Linking: {
      openURL: async (url: string) => {
        scenario.opened.push(url);
        if (!scenario.opens) throw new Error("Unable to open URL");
      },
    },
    Alert: {
      alert: (title: string, message: string) => scenario.alerts.push({ title, message }),
    },
  };
});
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.0.0" } } }));
vi.mock("expo-router", () => {
  const TABS = ["(home)", "live", "films", "series"].map((name) => ({ name }));
  return {
    router: { push: (href: unknown) => scenario.pushed.push(href) },
    useRootNavigationState: () => ({
      index: 0,
      routes: [{ name: "(tabs)", state: { index: scenario.tab, routes: TABS } }],
    }),
    useLocalSearchParams: () => scenario.params,
    useNavigation: () => ({
      setOptions: ({ title }: { title: string }) => {
        scenario.title = title;
      },
    }),
  };
});
vi.mock("expo-video", () => ({ isPictureInPictureSupported: () => true }));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("../src/downloads-screen.tsx", () => ({ DownloadsLink: () => null }));
// This screen's native header is outside the renderer; its queue button has separate coverage.
vi.mock("../src/download-status.tsx", () => ({ DownloadStatusButton: () => null }));
vi.mock("../src/ui.tsx", async () => {
  const { createElement } = await import("react");
  return {
    colors: { text: "#FFFFFF", dim: "#8E8E93", line: "#38383A" },
    ChannelLogo: () => null,
    TextButton: () => null,
    Message: ({ text }: { text: string }) => createElement("p", null, text),
  };
});
vi.mock("../src/titles.ts", () => ({
  hasTmdb: false,
  useMetadataStatus: () => null,
  useTitleTimings: () => null,
}));
vi.mock("../src/telemetry/index.ts", () => ({
  useStatistics: () => ({ enabled: true, transport: "production" }),
  setStatistics: async () => undefined,
}));
vi.mock("../src/account.ts", () => ({
  useRoster: () => ({ kind: "ready", members: [] }),
  members: () => [],
  remove: async () => undefined,
  retry: () => undefined,
  reloadChannels: () => undefined,
  reloadTitles: () => undefined,
}));

const { default: Settings } = await import("../src/app/(tabs)/(home)/settings.tsx");
const { default: Licences } = await import("../src/app/(tabs)/(home)/licences.tsx");
const { default: Licence } = await import("../src/app/(tabs)/(home)/licence.tsx");
const { licences } = await import("../src/licences.ts");

const app = join(import.meta.dirname, "..");

let unmount = () => {};
afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  Object.assign(scenario, { tab: 0, params: {}, opens: true, title: "" });
  scenario.pushed.length = 0;
  scenario.opened.length = 0;
  scenario.alerts.length = 0;
});

/** Shows `screen` and returns what it rendered. */
function show(screen: () => React.ReactNode) {
  const container = document.createElement("div");
  const root = createRoot(container);
  React.act(() => root.render(React.createElement(screen)));
  unmount = () => React.act(() => root.unmount());
  return container;
}

const press = (container: ReturnType<typeof show>, testID: string) => {
  const button = container.querySelector(`[data-testid="${testID}"]`);
  if (!button) throw new Error(`No ${testID}`);
  React.act(() => button.dispatchEvent(new Event("click", { bubbles: true })));
  return button;
};

/** Lets an open's failure reach its alert. */
const settle = () => React.act(async () => await new Promise((done) => setTimeout(done, 0)));

describe("Settings' legal rows", () => {
  it("open the privacy policy in the browser as a link, under the statistics disclosure", async () => {
    const settings = show(Settings);
    const row = press(settings, "settings-privacy-policy");
    expect(row.getAttribute("aria-label")).toBe("Privacy policy");
    expect(row.getAttribute("data-role")).toBe("link");
    const text = settings.textContent ?? "";
    expect(text.indexOf("Off until you choose to share.")).toBeGreaterThan(-1);
    expect(text.indexOf("Privacy policy")).toBeGreaterThan(
      text.indexOf("Off until you choose to share."),
    );
    await settle();
    expect(scenario.opened).toEqual(["https://mrstreamer.app/privacy"]);
    expect(scenario.alerts).toEqual([]);
  });

  it("say so with the address when iOS won't open the policy", async () => {
    scenario.opens = false;
    press(show(Settings), "settings-privacy-policy");
    await settle();
    expect(scenario.alerts).toEqual([
      { title: "Couldn't open the link", message: "https://mrstreamer.app/privacy" },
    ]);
  });

  it("count what Licences lists and open it on the tab Settings is on", () => {
    scenario.tab = 1;
    const row = press(show(Settings), "settings-licences");
    expect(row.getAttribute("aria-label")).toBe(`Licences, ${licences.components.length}`);
    expect(scenario.pushed).toEqual(["/live/licences"]);
  });
});

describe("Licences", () => {
  it("lead with the app, each row naming its licence, and open a component on the same tab", () => {
    scenario.tab = 2;
    const list = show(Licences);
    const rows = [...list.querySelectorAll("button")].map((each) =>
      each.getAttribute("aria-label"),
    );
    expect(rows[0]).toBe("Mr. Streamer, GPL-3.0-only");
    expect(rows).toHaveLength(licences.components.length);
    expect(rows).toContain("FFmpeg, LGPL-2.1-or-later");
    press(list, "licence-mrstreamer");
    expect(scenario.pushed).toEqual([{ pathname: "/films/licence", params: { id: "mrstreamer" } }]);
  });

  it("show a component's licence text whole, from the build, with no network", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    scenario.params = { id: "mrstreamer" };
    const page = show(Licence);
    expect(scenario.title).toBe("Mr. Streamer");
    const words = (text: string) => text.replace(/\s+/g, " ").trim();
    const gpl = readFileSync(join(app, "../../LICENSE"), "utf8");
    const shown = [...page.querySelectorAll("p")].map((each) => each.textContent).join(" ");
    expect(words(shown)).toContain(words(gpl));
    expect(page.textContent).toContain("GPL-3.0-only");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("open a component's source in the browser, and say so when iOS won't", async () => {
    const ffmpeg = licences.components.find((each) => each.name === "FFmpeg");
    if (!ffmpeg) throw new Error("No FFmpeg");
    scenario.params = { id: ffmpeg.id };
    scenario.opens = false;
    const source = press(show(Licence), "licence-source");
    expect(source.getAttribute("aria-label")).toBe("Source code");
    expect(source.getAttribute("data-role")).toBe("link");
    await settle();
    expect(scenario.opened).toEqual([ffmpeg.source]);
    expect(scenario.alerts).toEqual([{ title: "Couldn't open the link", message: ffmpeg.source }]);
  });
});

describe("the committed inventory", () => {
  it("carries FFmpeg as build-ffmpeg.sh configures it, without its GPL parts", () => {
    const script = readFileSync(join(app, "scripts/build-ffmpeg.sh"), "utf8");
    const block = script.slice(script.indexOf("features=(") + "features=(".length);
    const flags = block.slice(0, block.indexOf("\n)")).trim().split(/\s+/);
    const ffmpeg = licences.components.find((each) => each.name === "FFmpeg");
    const configuration = ffmpeg?.notices.find((notice) => notice.title === "Configuration");
    if (!configuration) throw new Error("No FFmpeg configuration");
    const carried = licences.texts[configuration.text]?.split(/\s+/);
    expect(carried).toEqual(flags);
    expect(flags).not.toContain("--enable-gpl");
    expect(ffmpeg?.source).toBe(
      `${/^FFMPEG_URL=(.+)$/m.exec(script)?.[1]}`.replace(
        "$FFMPEG_VERSION",
        `${/^FFMPEG_VERSION=(.+)$/m.exec(script)?.[1]}`,
      ),
    );
  });

  it("gives every component a notice, and every patched package its patch", () => {
    for (const component of licences.components) {
      expect(component.notices.length, component.id).toBeGreaterThan(0);
      for (const notice of component.notices) {
        expect(
          licences.texts[notice.text]?.length,
          `${component.id} ${notice.title}`,
        ).toBeGreaterThan(0);
      }
    }
    for (const patch of readdirSync(join(app, "patches"))) {
      const id = patch.slice(0, -".patch".length).replace("__", "/");
      const component = licences.components.find((each) => each.id === id);
      expect(component?.facts, id).toContainEqual({
        label: "Changed by",
        value: `apps/ios/patches/${patch}`,
      });
    }
  });
});
