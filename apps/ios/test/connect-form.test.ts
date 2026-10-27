import { createRoot, document, Event } from "./dom.ts";
import * as React from "react";
import { createRequire } from "node:module";
import { AppFailure } from "@mrstreamer/contracts/errors";
import type { HTMLInputElement } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// The Connect form after a failed sign-in: its button says Try again only for the details that
// just failed, and the failure shows only while those details stand. A sign-in that fails after
// a field changed says nothing about the new details. The real screen runs with React DOM on a
// happy-dom window; React Native's views stand in as plain elements and `add` is held until
// a test answers it. The file stays in Node's environment, where the mocked native modules need
// no install.

/** The app's own types have no React DOM; the tests resolve it from the desktop's install. */
// Metro supplies native asset ids; Node has no PNG loader.
createRequire(import.meta.url).extensions[".png"] = (module) => {
  module.exports = 1;
};

vi.stubGlobal("__DEV__", false);

/** Sign-ins waiting for an answer, oldest first. */
const signIns: Array<{ server: string; fail: () => void; succeed: () => void }> = [];
const consent = vi.hoisted(() => ({
  choice: null as "on" | "off" | null,
  answers: [] as Array<{ text: string; onPress: () => void }>,
  prompts: 0,
  privacy: [] as string[],
}));
vi.mock("../src/telemetry/index.ts", () => ({
  statisticsChoice: () => consent.choice,
  setStatistics: (enabled: boolean) => {
    consent.choice = enabled ? "on" : "off";
  },
}));

vi.mock("../src/account.ts", () => ({
  add: (input: { server: string }) =>
    new Promise<void>((resolve, reject) => {
      signIns.push({
        server: input.server,
        fail: () =>
          reject(new AppFailure({ kind: "unreachable", server: input.server, detail: "refused" })),
        succeed: resolve,
      });
    }),
}));
// Downloads open from a row of their own, which this test leaves out.
vi.mock("../src/downloads-screen.tsx", () => ({ DownloadsLink: () => null }));
vi.mock("../src/downloads.ts", () => ({
  useDownloads: () => ({ items: [], series: {}, bytes: 0, free: null, ended: 0 }),
}));
vi.mock("expo-router", () => ({ router: { push: () => undefined } }));
vi.mock("react-native-safe-area-context", async () => ({
  SafeAreaView: (await import("./react-native.ts")).reactNative.View,
}));
// ui.tsx keeps its pictures with artwork-cache.ts: over the files stand-in here.
vi.mock("expo-file-system", () => import("./native-files.ts"));
// Channel rows draw their star with an SF Symbol.
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
  Alert: {
    alert: (_title: string, _message: string, answers: typeof consent.answers) => {
      consent.answers = answers;
      consent.prompts++;
    },
  },
  Linking: {
    openURL: async (url: string) => {
      consent.privacy.push(url);
    },
  },
}));

const { default: Connect } = await import("../src/app/connect.tsx");

let unmount = () => {};
afterEach(() => {
  unmount();
  signIns.length = 0;
  consent.choice = null;
  consent.answers = [];
  consent.prompts = 0;
  consent.privacy = [];
});

function mount() {
  const container = document.createElement("div");
  const root = createRoot(container);
  React.act(() => root.render(React.createElement(Connect)));
  unmount = () => React.act(() => root.unmount());
  const field = (name: string) =>
    container.querySelector(`[data-testid="connect-${name}"]`) as HTMLInputElement;
  const button = () =>
    [...container.querySelectorAll("button")].find((each) =>
      ["Connect", "Connecting", "Try again"].includes(each.textContent ?? ""),
    )!;
  return {
    container,
    click(label: string) {
      React.act(() =>
        [...container.querySelectorAll("button")]
          .find((each) => each.textContent === label)!
          .dispatchEvent(new Event("click", { bubbles: true })),
      );
    },
    choose(label: string) {
      React.act(() => consent.answers.find((each) => each.text === label)!.onPress());
    },
    type(name: "server" | "username" | "password", value: string) {
      React.act(() => {
        // React tracks the value it last rendered; setting it through the prototype lets the
        // input event read as a change.
        const input = field(name);
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    press: () => React.act(() => button().dispatchEvent(new Event("click", { bubbles: true }))),
    answer: (each: () => void) => React.act(async () => each()),
    label: () => button().textContent,
    error: () => container.querySelector('[data-testid="connect-error"]')?.textContent ?? null,
  };
}

function filledForm() {
  const form = mount();
  form.click("Add provider");
  form.choose("Don't share");
  form.type("server", "http://a.example");
  form.type("username", "demo");
  form.type("password", "secret");
  return form;
}

describe("Connect after a failed sign-in", () => {
  it("offers Try again with the failure for the details that failed", async () => {
    const form = filledForm();
    form.press();
    expect(form.label()).toBe("Connecting");
    await form.answer(signIns[0]!.fail);
    expect(form.label()).toBe("Try again");
    expect(form.error()).toContain("Couldn't reach a.example");
  });

  it("says Connect, and no failure, once a field changes after it", async () => {
    const form = filledForm();
    form.press();
    await form.answer(signIns[0]!.fail);
    form.type("server", "http://b.example");
    expect(form.label()).toBe("Connect");
    expect(form.error()).toBeNull();
  });

  it("keeps Connect for details edited while the earlier ones were signing in", async () => {
    const form = filledForm();
    form.press();
    form.type("server", "http://b.example");
    await form.answer(signIns[0]!.fail);
    expect(form.label()).toBe("Connect");
    expect(form.error()).toBeNull();
    form.press();
    expect(signIns).toHaveLength(2);
    expect(signIns[1]!.server).toBe("http://b.example");
    await form.answer(signIns[1]!.fail);
    expect(form.label()).toBe("Try again");
    expect(form.error()).toContain("Couldn't reach b.example");
  });

  it("starts one sign-in at a time and stays on Connecting when it succeeds", async () => {
    const form = filledForm();
    form.press();
    form.press();
    expect(signIns).toHaveLength(1);
    await form.answer(signIns[0]!.succeed);
    expect(form.label()).toBe("Connecting");
  });
});

it.each(["Don't share", "Share"])(
  "continues through %s, keeps the choice on Back and opens privacy",
  (answer) => {
    const form = mount();
    form.click("Privacy policy");
    expect(consent.privacy).toEqual(["https://mrstreamer.app/privacy"]);
    form.click("Add provider");
    expect(form.container.querySelector("input")).toBeNull();
    form.choose(answer);
    expect(consent.choice).toBe(answer === "Share" ? "on" : "off");
    expect(form.container.querySelector("input")).not.toBeNull();
    form.click("Back");
    form.click("Add provider");
    expect(consent.prompts).toBe(1);
    expect(form.container.querySelector("input")).not.toBeNull();
  },
);
