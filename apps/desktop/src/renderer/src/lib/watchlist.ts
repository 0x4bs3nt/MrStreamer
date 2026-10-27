// The watchlist as the views use it: whether a title is saved, saving it and taking it out. A
// change shows once the main process has stored it, never before, and a control makes one change
// at a time.
//   React hears that a change began a moment after it did. A press in that moment still reads
//   `isPending` as false, and would start a second change, whose answer the control then shows
//   instead of the first's. So each control keeps a ref beside it, set as its change starts and
//   cleared as it ends, stored or not. `isPending` then holds on until the control shows how the
//   change went, which is a moment after it ended.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import type { TitleKind } from "@mrstreamer/contracts/ondemand";
import { ownedId, type OwnedId } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import { call } from "./ipc.ts";
import { queries } from "./queries.ts";

/** "Movie" or "Series", where the watchlist shows both together. */
export function kindLabel(kind: TitleKind): string {
  return kind === "movie" ? t("Movie") : t("Series");
}

/** A title's place on the watchlist, and the one thing its button does about it. */
export interface SaveToggle {
  /** The lists have the title and the main process said whether it is saved. */
  readonly ready: boolean;
  readonly saved: boolean;
  /** A change is being stored: the button keeps what it says and takes no other. */
  readonly busy: boolean;
  /** What the last change was, when it wasn't stored. */
  readonly failed: "save" | "remove" | null;
  /** Saves the title, or removes it when it is saved. */
  readonly toggle: () => void;
}

/**
 * The Save button of a movie or series, named by one of its versions. It needs the title from
 * the lists alone (`listed`), so it works while the title's details are still on their way.
 */
export function useSaveToggle(kind: TitleKind, version: OwnedId, listed: boolean): SaveToggle {
  const client = useQueryClient();
  const query = queries.saved(kind, version);
  const entry = useQuery({ ...query, enabled: listed });
  const underWay = useRef(false);
  const change = useMutation({
    mutationFn: async (saved: OwnedId | null): Promise<OwnedId | null> => {
      if (!saved) return call("watchlist.save", { kind, version: ownedId(version) });
      await call("watchlist.remove", { entry: ownedId(saved) });
      return null;
    },
    // Stored by now: the button says so at once, and the lists read again.
    onSuccess: (saved) => {
      client.setQueryData(query.queryKey, saved);
      void client.invalidateQueries({ queryKey: ["watchlist"] });
    },
    onSettled: () => {
      underWay.current = false;
    },
  });
  return {
    ready: listed && !entry.isPending,
    saved: Boolean(entry.data),
    busy: change.isPending,
    failed: !change.isError ? null : change.variables ? "remove" : "save",
    toggle: () => {
      if (underWay.current || change.isPending) return;
      underWay.current = true;
      change.mutate(entry.data ?? null);
    },
  };
}

/**
 * Takes an entry off the watchlist, also one whose title the lists don't have. A removal counts
 * as done once the lists were read again; `error` says the last one failed.
 */
export function useRemoveSaved() {
  const client = useQueryClient();
  const underWay = useRef(false);
  const removal = useMutation({
    mutationFn: (entry: OwnedId) => call("watchlist.remove", { entry: ownedId(entry) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["watchlist"] }),
    onSettled: () => {
      underWay.current = false;
    },
  });
  return {
    isPending: removal.isPending,
    error: removal.error,
    /** Removes `entry`, then runs `onRemoved`. It does nothing while a removal is under way. */
    remove: (entry: OwnedId, onRemoved?: () => void) => {
      if (underWay.current || removal.isPending) return;
      underWay.current = true;
      removal.mutate(entry, onRemoved && { onSuccess: onRemoved });
    },
  };
}
