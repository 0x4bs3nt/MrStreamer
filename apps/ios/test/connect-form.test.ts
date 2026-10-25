import * as React from "react";
import { AppFailure } from "@mrstreamer/contracts/errors";
import { Window, type HTMLInputElement } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// The Connect form after a failed sign-in: its button says Try again only for the details that
// just failed, and the failure shows only while those details stand. A sign-in that fails after
// a field changed says nothing about the new details. The real screen runs with React DOM on a
// happy-dom window; React Native's views stand in as plain elements and `add` is held until
// a test answers it. The file stays in Node's environment, where the mocked native modules need
// no install.

/** The app's own types have no React DOM; the tests resolve it from the desktop's install. */
const REACT_DOM = "react-dom/client";

const window = new Window();
Object.assign(globalThis, { window, document: window.document });
const { document, Event } = window;
type Root = { render(node: unknown): void; unmount(): void };
const { createRoot } = (await import(REACT_DOM)) as { createRoot(container: object): Root };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("__DEV__", false);

/** Sign-ins waiting for an answer, oldest first. */
const signIns: Array<{ server: string; fail: () => void; succeed: () => void }> = [];

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
// ui.tsx keeps its pictures with artwork-cache.ts: over the files stand-in here.
vi.mock("expo-file-system", () => import("./native-files.ts"));
// Channel rows draw their star with an SF Symbol.
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  type Props = { children?: React.ReactNode; testID?: string };
  const box = ({ children, testID }: Props) =>
    createElement("div", { "data-testid": testID }, children);
  return {
    ScrollView: box,
    View: box,
    Text: ({ children }: Props) => createElement("span", null, children),
    Pressable: ({
      children,
      disabled,
      onPress,
    }: Props & { disabled?: boolean; onPress: () => void }) =>
      createElement("button", { disabled, onClick: onPress }, children),
    TextInput: ({
      testID,
      value,
      onChangeText,
    }: Props & { value: string; onChangeText: (value: string) => void }) =>
      createElement("input", {
        "data-testid": testID,
        value,
        onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
      }),
    Image: box,
    StyleSheet: { create: <T>(styles: T) => styles },
    useWindowDimensions: () => ({ fontScale: 1 }),
  };
});

const { default: Connect } = await import("../src/app/connect.tsx");

let unmount = () => {};
afterEach(() => {
  unmount();
  signIns.length = 0;
});

function mount() {
  const container = document.createElement("div");
  const root = createRoot(container);
  React.act(() => root.render(React.createElement(Connect)));
  unmount = () => React.act(() => root.unmount());
  const field = (name: string) =>
    container.querySelector(`[data-testid="connect-${name}"]`) as HTMLInputElement;
  const button = () => container.querySelector("button")!;
  return {
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
