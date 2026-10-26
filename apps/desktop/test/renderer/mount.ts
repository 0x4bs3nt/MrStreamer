import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

/** A real renderer tree with its own container in the page. Call unmount before restoring timers or mocks. */
export function bareView() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    render: (node?: ReactNode) => act(async () => root.render(node)),
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** A bare view whose tree has `client`, cleared once it unmounts. */
export function queryView(client: QueryClient) {
  const view = bareView();
  return {
    container: view.container,
    render: (node?: ReactNode) => view.render(createElement(QueryClientProvider, { client }, node)),
    unmount() {
      view.unmount();
      client.clear();
    },
  };
}
