// Input focus and playback have their own owners. This context only says whether a mounted
// page can be seen, so its display work can wait while Watch or a title covers it.
import { createContext, useContext, useSyncExternalStore } from "react";

export const PresentationVisible = createContext(true);

const subscribe = (changed: () => void) => {
  document.addEventListener("visibilitychange", changed);
  return () => document.removeEventListener("visibilitychange", changed);
};
const visible = () => document.visibilityState !== "hidden";

/** Partially covered pages, including Settings and detail sheets, remain visible. */
export function usePresentationVisible(): boolean {
  const page = useContext(PresentationVisible);
  const documentVisible = useSyncExternalStore(subscribe, visible);
  return page && documentVisible;
}
