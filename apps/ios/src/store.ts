import { useSyncExternalStore } from "react";

/** A value one owner changes and screens read, as React's external store expects. */
export interface Store<S> {
  get(): S;
  set(next: S | ((current: S) => S)): void;
  subscribe(listener: () => void): () => void;
}

export function store<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      const value = typeof next === "function" ? (next as (current: S) => S)(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The store's value, rendering again when it changes. */
export function useStore<S>(source: Store<S>): S {
  return useSyncExternalStore(source.subscribe, source.get);
}
