// @vitest-environment happy-dom
// The Connect screen, shown while no subscription is saved: an address without a scheme goes to
// https first, and the login goes over plain http only after the viewer agrees. An address typed
// with http:// says so under the field. Settings adds further subscriptions with the same form.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectScreen } from "../../src/renderer/src/features/connect/ConnectScreen.tsx";

let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
});

/**
 * Does `step`, then waits for what it set off: React Query tells the screen about a mutation's
 * changes in a timer of its own, set once the answer has gone through a few promises.
 */
async function settled(step: () => unknown): Promise<void> {
  await act(async () => {
    step();
    await vi.advanceTimersByTimeAsync(20);
  });
}

/** The screen in the page, for a first login. */
async function connectScreen(): Promise<HTMLElement> {
  ipc.reset();
  const container = document.createElement("div");
  // In the page, as a field takes focus only there.
  document.body.append(container);
  const root = createRoot(container);
  await settled(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(ConnectScreen),
      ),
    ),
  );
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return container;
}

/** Types into the login form's fields, in order: server, username, password. */
function type(screen: HTMLElement, values: readonly string[]): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  return settled(() =>
    screen.querySelectorAll("input").forEach((input, index) => {
      setValue?.call(input, values[index] ?? "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }),
  );
}

const button = (screen: HTMLElement, text: string) =>
  [...screen.querySelectorAll("button")].find((each) => each.textContent?.trim() === text);

const click = (screen: HTMLElement, text: string) => settled(() => button(screen, text)?.click());

/** Presses Connect, and answers that the address has no https. */
async function connectWithoutHttps(screen: HTMLElement): Promise<void> {
  const answer = ipc.hold("subscription.add");
  await settled(() =>
    screen
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  await settled(() =>
    answer.reject({ kind: "unencrypted-only", server: "https://line.example.tv:8080" }),
  );
}

const UNENCRYPTED = "Not encrypted. Your login travels as plain text.";

describe("connecting", () => {
  it("asks before sending the login over http when https doesn't work", async () => {
    const screen = await connectScreen();
    await type(screen, ["line.example.tv:8080", "demo", "s3cret"]);
    await connectWithoutHttps(screen);

    expect(ipc.argsOf("subscription.add")).toEqual([
      { server: "line.example.tv:8080", username: "demo", password: "s3cret" },
    ]);
    expect(screen.textContent).toContain("line.example.tv has no encrypted connection.");
    expect(button(screen, "Connect")).toBeUndefined();

    ipc.hold("subscription.add");
    await click(screen, "Connect without encryption");

    expect(ipc.argsOf("subscription.add").at(-1)).toEqual({
      server: "http://line.example.tv:8080",
      username: "demo",
      password: "s3cret",
    });
    expect(screen.textContent).toContain(UNENCRYPTED);
  });

  it("goes back to the form when the viewer doesn't agree", async () => {
    const screen = await connectScreen();
    await type(screen, ["line.example.tv:8080", "demo", "s3cret"]);
    await connectWithoutHttps(screen);

    await click(screen, "Cancel");

    expect(button(screen, "Connect")).toBeDefined();
    expect(screen.textContent).not.toContain("has no encrypted connection");
    expect(ipc.argsOf("subscription.add")).toHaveLength(1);
  });

  it.each([
    { server: "http://line.example.tv:8080", line: true },
    { server: "https://line.example.tv", line: false },
    { server: "line.example.tv:8080", line: false },
  ])("says the login travels as plain text for $server: $line", async ({ server, line }) => {
    const screen = await connectScreen();
    await type(screen, [server, "demo", "s3cret"]);

    expect(screen.textContent?.includes(UNENCRYPTED)).toBe(line);
  });
});
