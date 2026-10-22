import * as React from "react";
import { Window, type HTMLInputElement } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Member } from "../src/account.ts";

// Settings' provider form: Add saves the name with the login, Edit changes the name and only a
// password that was typed, and leaving the form before the provider answers cancels what it
// asked. The real form runs with React DOM on a happy-dom window, as connect-form.test.ts does;
// `add` and `update` are held until a test answers them.

const REACT_DOM = "react-dom/client";
const window = new Window();
Object.assign(globalThis, { window, document: window.document });
const { document, Event } = window;
type Root = { render(node: unknown): void; unmount(): void };
const { createRoot } = (await import(REACT_DOM)) as { createRoot(container: object): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Asked {
  readonly call: "add" | "update";
  readonly args: readonly unknown[];
  readonly signal: AbortSignal;
  readonly succeed: () => void;
}
const asked: Asked[] = [];
const held =
  (call: Asked["call"]) =>
  (...args: unknown[]) =>
    new Promise<void>((succeed) => {
      const signal = args.at(-1) as AbortSignal;
      asked.push({ call, args: args.slice(0, -1), signal, succeed });
    });

vi.mock("../src/account.ts", () => ({ add: held("add"), update: held("update") }));
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
    StyleSheet: { create: <T>(styles: T) => styles },
  };
});

const { ProviderForm } = await import("../src/provider-form.tsx");

const saved: Member = {
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

let unmount = () => {};
afterEach(() => {
  unmount();
  asked.length = 0;
});

function mount(mode: Parameters<typeof ProviderForm>[0]["mode"]) {
  const done = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  React.act(() => root.render(React.createElement(ProviderForm, { mode, onDone: done })));
  unmount = () => React.act(() => root.unmount());
  return {
    done,
    leave: () => unmount(),
    type(name: string, value: string) {
      React.act(() => {
        const input = container.querySelector(
          `[data-testid="provider-${name}"]`,
        ) as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    press: () =>
      React.act(() =>
        container.querySelector("button")!.dispatchEvent(new Event("click", { bubbles: true })),
      ),
    answer: (each: () => void) => React.act(async () => each()),
    text: () => container.textContent,
  };
}

describe("adding a provider in Settings", () => {
  it("adds the login with its name, then goes back", async () => {
    const form = mount({ kind: "add" });
    form.type("name", "Cabin");
    form.type("server", "http://b.example:8080");
    form.type("username", "two");
    form.type("password", "pw");
    form.press();
    expect(asked.map(({ call, args }) => [call, args])).toEqual([
      [
        "add",
        [{ server: "http://b.example:8080", username: "two", password: "pw", name: "Cabin" }],
      ],
    ]);
    await form.answer(asked[0]!.succeed);
    expect(form.done).toHaveBeenCalledOnce();
  });

  it("cancels the add when the viewer leaves before the provider answers", () => {
    const form = mount({ kind: "add" });
    form.type("server", "http://b.example");
    form.press();
    form.leave();
    expect(asked[0]?.signal.aborted).toBe(true);
    expect(form.done).not.toHaveBeenCalled();
  });
});

describe("editing a saved provider", () => {
  it("shows its server and username without fields for them, and changes only the name", async () => {
    const form = mount({ kind: "edit", member: saved });
    expect(form.text()).toContain("b.example · two");
    form.type("name", "Holiday house");
    form.press();
    expect(asked.map(({ call, args }) => [call, args])).toEqual([
      ["update", ["xtream-b", { name: "Holiday house" }]],
    ]);
  });

  it("sends a password only when one was typed", () => {
    const form = mount({ kind: "edit", member: saved });
    form.type("password", "new");
    form.press();
    expect(asked[0]?.args).toEqual(["xtream-b", { name: "Cabin", password: "new" }]);
  });
});
