// The viewer's channel lists in the window: what each holds, as the main process says, and the
// changes Live TV makes to them. A change answers every list as stored, which the lists' query
// takes, unless a later change began meanwhile: then the lists are read again, as `syncCustomLists`
// also has them read once a change is stored. One that fails keeps what it asked, to send again.
// A delete is the window's own from when it is sent, kept with the window's query client. Of
// changes sent side by side, the last that failed shows until the viewer answers it.
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { CustomList } from "@mrstreamer/contracts/custom-lists";
import type { AppError } from "@mrstreamer/contracts/errors";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { appError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { queries } from "../../lib/queries.ts";

/** A change of the lists, which answers them as stored. */
export type ListChange = () => Promise<readonly CustomList[]>;

/** Where a change stands: none under way, sent, or failed with why, to send again. */
export type ChangeState =
  | { readonly status: "idle" }
  | { readonly status: "saving" }
  | { readonly status: "failed"; readonly error: AppError; readonly change: ListChange };

/** Counts the changes begun in this window, so an answer overtaken by a later one is read again. */
let changesBegun = 0;

/**
 * Sends `change`, and gives the lists' query what it answers. Answers the lists as stored, or
 * rejects with the change's failure.
 */
async function send(client: QueryClient, change: ListChange): Promise<readonly CustomList[]> {
  const turn = ++changesBegun;
  try {
    const lists = await change();
    if (turn === changesBegun) client.setQueryData(queries.customLists().queryKey, lists);
    else void client.invalidateQueries({ queryKey: queries.customLists().queryKey });
    return lists;
  } catch (cause) {
    void client.invalidateQueries({ queryKey: queries.customLists().queryKey });
    throw cause;
  }
}

/**
 * The lists each window deleted, by the deletes of each it sent that haven't failed. They are
 * kept with the window's query client, which outlives Live TV's page: a list that goes once its
 * delete is sent went from here, whether the answer or the lists read again come first, and
 * after Live TV was left and opened again. Another client starts with none.
 */
const deletions = new WeakMap<QueryClient, Map<string, number>>();

/** Whether the window of `client` deleted `id`'s list, or has a delete of it out. */
export function deletedHere(client: QueryClient, id: string): boolean {
  return deletions.get(client)?.has(id) ?? false;
}

/**
 * Deletes `id`'s list, as the window's own from when it is sent: one that fails no longer
 * counts, so a list that goes otherwise still says so. Answers the lists as stored.
 */
export function removeList(client: QueryClient, id: string): ListChange {
  return async () => {
    const sent = deletions.get(client) ?? new Map<string, number>();
    deletions.set(client, sent);
    sent.set(id, (sent.get(id) ?? 0) + 1);
    try {
      return await call("customLists.remove", { id });
    } catch (cause) {
      const left = (sent.get(id) ?? 1) - 1;
      if (left > 0) sent.set(id, left);
      else sent.delete(id);
      throw cause;
    }
  };
}

/**
 * Changes of the lists made from one place, one at a time: what the last one came to, and Retry,
 * which sends the change that failed again as it was.
 */
export function useListChange() {
  const client = useQueryClient();
  const [state, setState] = useState<ChangeState>({ status: "idle" });
  /** Sends `change`; answers the lists as stored, or null once it failed, which `state` says. */
  const run = async (change: ListChange): Promise<readonly CustomList[] | null> => {
    setState({ status: "saving" });
    try {
      const lists = await send(client, change);
      setState({ status: "idle" });
      return lists;
    } catch (cause) {
      setState({ status: "failed", error: appError(cause), change });
      return null;
    }
  };
  return {
    state,
    run,
    retry: () => (state.status === "failed" ? run(state.change) : Promise.resolve(null)),
    dismiss: () => setState({ status: "idle" }),
  };
}

const IDLE: ChangeState = { status: "idle" };

/**
 * Changes of the lists sent side by side, from rows and menus that don't wait for one another:
 * the last that failed shows, with Retry, until the viewer sends it again or closes it, or
 * another fails. A change starting or answering meanwhile leaves it showing.
 */
export function useListChanges() {
  const client = useQueryClient();
  const [failed, setFailed] = useState<Extract<ChangeState, { status: "failed" }> | null>(null);
  /** Sends `change`; answers the lists as stored, or null once it failed, which then shows. */
  const run = async (change: ListChange): Promise<readonly CustomList[] | null> => {
    try {
      return await send(client, change);
    } catch (cause) {
      setFailed({ status: "failed", error: appError(cause), change });
      return null;
    }
  };
  /** Takes down the failure the viewer answered, unless another failed since. */
  const answered = () => setFailed((current) => (current === failed ? null : current));
  return {
    state: failed ?? IDLE,
    run,
    retry: () => {
      if (!failed) return;
      answered();
      void run(failed.change);
    },
    dismiss: answered,
  };
}

/** Whether a list shows `channel` among its channels, by the id it shows by. */
export function holds(list: CustomList, channel: OwnedId): boolean {
  const key = ownedKey(channel);
  return list.members.some((each) => each.kind === "listed" && ownedKey(each.channel) === key);
}

/**
 * The rail's New list, as a field that names one: closed, or open with what is typed and how the
 * last try went. One made from a row's lists menu holds that row's channel from the start. Each
 * name typed is sent under one id, so Retry, or Enter again, never makes a second list. One list
 * is made at a time: while it is sent, New list from a row leaves its field as it is.
 */
export function useNewList(onMade: (id: string) => void) {
  const change = useListChange();
  const [field, setField] = useState<{
    readonly text: string;
    readonly channel: OwnedId | null;
    readonly id: string;
  } | null>(null);
  return {
    open: field !== null,
    text: field?.text ?? "",
    state: change.state,
    start: (channel: OwnedId | null = null) => {
      if (change.state.status === "saving") return;
      change.dismiss();
      setField({ text: "", channel, id: crypto.randomUUID() });
    },
    // Another name is another list, under an id of its own.
    type: (text: string) => {
      if (field)
        setField({ ...field, text, id: text === field.text ? field.id : crypto.randomUUID() });
    },
    /** Makes the list; answers its id once made, or null. */
    confirm: async (): Promise<string | null> => {
      if (!field || field.text.trim() === "" || change.state.status === "saving") return null;
      const { id, text, channel } = field;
      const made = await change.run(() =>
        call("customLists.create", { id, name: text, ...(channel ? { channel } : {}) }),
      );
      if (!made) return null;
      setField(null);
      onMade(id);
      return id;
    },
    cancel: () => {
      if (change.state.status === "saving") return;
      change.dismiss();
      setField(null);
    },
  };
}

export type NewList = ReturnType<typeof useNewList>;
