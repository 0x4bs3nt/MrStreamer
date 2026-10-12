// @vitest-environment happy-dom
import { ipc } from "./support.ts";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { useFeatureEntries } from "../../src/renderer/src/app/analytics.ts";
import { openView, useUi } from "../../src/renderer/src/app/ui-store.ts";

let unmount = () => {};
afterEach(() => unmount());
function Entries() {
  useFeatureEntries(true, false, false);
  return null;
}

it("notifies fixed screen entries once through StrictMode renders and overlay changes, with no content data", async () => {
  ipc.reset();
  ipc.always("analytics.feature", null);
  useUi.setState({
    view: "home",
    watching: false,
    playingTitle: false,
    details: null,
    savedEntry: null,
    searchOpen: false,
    settings: null,
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  unmount = () => act(() => root.unmount());
  const element = createElement(StrictMode, null, createElement(Entries));
  await act(async () => root.render(element));
  await act(async () => root.render(element));
  expect(ipc.argsOf("analytics.feature")).toEqual(["home"]);
  await act(async () => openView("live"));
  await act(async () => useUi.setState({ settings: "general" }));
  await act(async () => useUi.setState({ settings: "about" }));
  await act(async () => useUi.setState({ searchOpen: true, searchFrom: "PRIVATE query" }));
  await act(async () => useUi.setState({ searchFrom: "changed PRIVATE query" }));
  await act(async () =>
    useUi.setState({
      details: { kind: "movie", id: "PRIVATE title", subscriptionId: "PRIVATE provider" },
      watching: false,
    }),
  );
  await act(async () => useUi.setState({ watching: true }));
  await act(async () => useUi.setState({ watching: false, playingTitle: true }));
  await act(async () => useUi.setState({ settings: null }));
  await act(async () => useUi.setState({ settings: "general" }));
  expect(ipc.argsOf("analytics.feature")).toEqual([
    "home",
    "live_tv",
    "settings",
    "search",
    "details",
    "player",
    "settings",
  ]);
});
