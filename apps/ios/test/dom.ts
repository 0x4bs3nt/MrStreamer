import { Window } from "happy-dom";

// iOS keeps no React DOM install or DOM types. Vitest resolves this renderer from the desktop
// install, sharing the React used by the real screen. Each isolated test file gets its own window.
export const window = new Window();
Object.assign(globalThis, { window, document: window.document });
export const { document, Event } = window;
export type Root = { render(node: unknown): void; unmount(): void };
const REACT_DOM = "react-dom/client";
export const { createRoot } = (await import(REACT_DOM)) as {
  createRoot(container: object): Root;
};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
