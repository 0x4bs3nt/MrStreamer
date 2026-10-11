// @vitest-environment happy-dom
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { CustomizeHome } from "../../src/renderer/src/features/home/CustomizeHome.tsx";
import { TooltipProvider } from "../../src/renderer/src/components/ui/tooltip.tsx";

let unmount = () => {};
afterEach(() => unmount());
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
const labels = () =>
  [...document.querySelectorAll("li label")].map((label) => label.textContent?.trim());
const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === name || button.textContent?.trim() === name,
  )!;

it("edits empty Home rows, retains focus and future IDs, serializes writes and resets defaults", async () => {
  ipc.reset();
  ipc.prefer({
    homeRows: [
      { id: "watchlist", visible: false },
      { id: "future", visible: false },
    ],
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TooltipProvider, null, createElement(CustomizeHome, { onDone: () => {} })),
      ),
    ),
  );
  unmount = () => {
    act(() => root.unmount());
    container.remove();
    client.clear();
  };
  await settle();
  expect(labels()).toEqual([
    "Watchlist",
    "Continue watching",
    "Recommendations",
    "Favourites",
    "Recently watched",
    "New movies",
    "New series",
    "Current category",
  ]);
  expect(document.querySelector<HTMLInputElement>("li input")?.checked).toBe(false);
  const held = ipc.hold("preferences.update");
  const move = button("Move Watchlist down");
  move.focus();
  await act(async () => {
    move.click();
    move.click();
  });
  expect(ipc.argsOf("preferences.update")).toHaveLength(1);
  expect(labels()[0]).toBe("Watchlist");
  const patch = ipc.argsOf("preferences.update")[0]!;
  expect(patch.homeRows?.at(-1)).toEqual({ id: "future", visible: false });
  await act(async () => held.resolve({ volume: 1, muted: false, ...patch }));
  await settle();
  expect(labels().slice(0, 2)).toEqual(["Continue watching", "Watchlist"]);
  expect(document.activeElement).toBe(move);
  const visible = ipc.hold("preferences.update");
  await act(async () => document.querySelectorAll<HTMLInputElement>("li input")[1]!.click());
  await act(async () =>
    visible.resolve({ volume: 1, muted: false, ...ipc.argsOf("preferences.update").at(-1)! }),
  );
  await settle();
  expect(document.querySelectorAll<HTMLInputElement>("li input")[1]!.checked).toBe(true);
  const reset = ipc.hold("preferences.update");
  await act(async () => button("Reset to defaults").click());
  await act(async () =>
    reset.resolve({ volume: 1, muted: false, ...ipc.argsOf("preferences.update").at(-1)! }),
  );
  await settle();
  expect(labels().slice(0, 3)).toEqual(["Continue watching", "Recommendations", "Watchlist"]);
  expect(
    [...document.querySelectorAll<HTMLInputElement>("li input")].every((input) => input.checked),
  ).toBe(true);
});
