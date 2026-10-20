// Putting the favourites in another order, in Live TV's Favourites list: a draft of the channels
// shown there, which the viewer arranges with each row's buttons or the keys. Save sends it once;
// Cancel, and leaving the list, throw it away. Until it is saved, nothing but this draft knows it.
//   The favourites are every saved subscription's, in one order, and the draft belongs to the
// subscriptions and the favourites it was read from. It closes when a subscription is added or
// removed, and when the favourites or the channels the list shows change under it, as a new
// catalogue or the setting for adults does. The main process checks the same as it saves, so an
// order from an older list never lands: it answers that the favourites changed, and the draft
// asks to be read again. Once saved, the list shows the channels the main process names for the
// record it answered with, and nothing of the draft.
//   Up and Down move the selection; PageUp, PageDown, Home and End jump. With Alt, or Option on a
// Mac, the same keys move the selected channel: one place, ten, or to the top or bottom. Enter
// saves and Escape cancels.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { ownedId, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import type { Viewing } from "@mrstreamer/contracts/viewing";
import { t } from "@mrstreamer/core/i18n";
import { appError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { browseQuery } from "./lists.ts";
import { useUi } from "../../app/ui-store.ts";
import { keepViewing, queries, rosterOf, savedAs, useSubscriptions } from "../../lib/queries.ts";

/** What of a row holds the focus: the row itself, or one of its two buttons. */
export type RowPart = "row" | "up" | "down";

interface Draft {
  /** The subscriptions saved when the favourites were read: `savedAs`. */
  readonly saved: string;
  /** Every favourite as read, of every subscription, with those the list doesn't show. */
  readonly original: readonly OwnedId[];
  /**
   * The channels the list showed, as read: the array the lists' cache gave, which it keeps giving
   * until a read finds a channel changed.
   */
  readonly listed: readonly LiveChannel[];
  /** The same channels as arranged. */
  readonly order: readonly LiveChannel[];
  /**
   * The channel the keys move, and the part of its row with the focus. `asked` counts the times
   * the viewer chose it, so a row chosen again takes the focus again.
   */
  readonly focus: { readonly channel: OwnedId; readonly part: RowPart; readonly asked: number };
  /**
   * `saving` until the main process answered and the list it names is read, and nothing moves
   * meanwhile. `failed` keeps the draft to send again. `changed` when the favourites are no
   * longer the ones read: the draft can't be saved, only read again, which `reading` waits for.
   */
  readonly status: "editing" | "saving" | "failed" | "changed" | "reading";
  /**
   * The id the order is sent under: again for a retry, another once the order changed. While
   * the favourites are read again, what names that read.
   */
  readonly commandId: string | null;
  /** What a screen reader hears of the last move: "Nature, 2 of 9". */
  readonly said: string;
}

interface OrderEditor {
  /** The order being made, or null while the list shows the saved one. */
  readonly draft: Draft | null;
  /** Whether there is an order to make: two channels or more, of favourites that are known. */
  readonly available: boolean;
  /** Starts a draft from the list as it shows, with the keys on `channel`. */
  start(channel: OwnedId | null): void;
  /** Gives a row the keys, as a click on it or the arrows do. */
  select(channel: OwnedId, part?: RowPart): void;
  /** Notes where the focus went by itself, as with Tab, so a move keeps it there. */
  focused(channel: OwnedId, part: RowPart): void;
  /** Moves the selection `by` rows, within the list. */
  step(by: number): void;
  /** Moves a channel `by` places, within the list, and gives it the keys. */
  move(channel: OwnedId, by: number, part?: RowPart): void;
  /** Saves the draft, or sends it again after a failure; reads the favourites again once changed. */
  confirm(): void;
  /** Throws the draft away. Not while it waits for the main process. */
  cancel(): void;
}

/** How far each key goes. With Alt it moves the channel, without it the selection. */
const STEPS: Readonly<Record<string, number>> = {
  ArrowUp: -1,
  ArrowDown: 1,
  PageUp: -10,
  PageDown: 10,
  Home: -Infinity,
  End: Infinity,
};

/** Sends a key to the order being made. Every other key of the guide rests meanwhile. */
export function orderKey(event: KeyboardEvent, order: OrderEditor): void {
  const { draft } = order;
  if (!draft) return;
  const by = Object.hasOwn(STEPS, event.key) ? STEPS[event.key] : undefined;
  if (by !== undefined) {
    if (event.altKey) order.move(draft.focus.channel, by);
    else order.step(by);
  } else if (event.key === "Enter") {
    // A button with the focus takes Enter itself, as it takes Space.
    if (event.target instanceof HTMLButtonElement || event.repeat) return;
    order.confirm();
  } else if (event.key === "Escape") order.cancel();
  else return;
  event.preventDefault();
}

/** Whether two lists name the same channels, in the same order. */
const sameChannels = (a: readonly OwnedId[], b: readonly OwnedId[]) =>
  a === b || (a.length === b.length && a.every((channel, at) => sameOwned(channel, b[at])));

/** Whether a draft waits for the main process: nothing moves meanwhile, and nothing leaves it. */
export const waits = (draft: Draft | null): boolean =>
  draft?.status === "saving" || draft?.status === "reading";

/**
 * A draft of `channels` as they stand, with the keys on `focus` or else the first; null when
 * there is nothing to order, one channel or none.
 */
function drafted(
  saved: string,
  favourites: readonly OwnedId[],
  channels: readonly LiveChannel[],
  focus: OwnedId | null,
  asked: number,
): Draft | null {
  const channel = channels.find((each) => sameOwned(each, focus)) ?? channels[0];
  if (channels.length < 2 || !channel) return null;
  return {
    saved,
    original: favourites,
    listed: channels,
    order: channels,
    focus: { channel, part: "row", asked },
    status: "editing",
    commandId: null,
    said: "",
  };
}

/**
 * The order of the favourites as the viewer makes it. `channels` are the favourites the list
 * shows, unsearched, or undefined while they load, and `open` says whether the list is there to
 * order: leaving it throws the draft away.
 */
export function useFavouriteOrder(
  open: boolean,
  channels: readonly LiveChannel[] | undefined,
): OrderEditor {
  const client = useQueryClient();
  const saved = savedAs(useSubscriptions());
  const favourites = useQuery(queries.viewing()).data?.favourites;
  const [held, setDraft] = useState<Draft | null>(null);

  // A draft ends when the list is left and when a subscription is added or removed, whatever it
  // waits for: an answer that comes later finds no draft to change. One being arranged ends too when
  // the favourites or the channels shown are no longer the ones it was made from. The channels
  // are the same for as long as the lists' cache gives the same array, which it does through
  // every read that finds them unchanged: another name, logo or stream makes another array, as
  // another channel does, and programmes or a watch in between make none.
  const obsolete =
    held !== null &&
    (!open ||
      held.saved !== saved ||
      ((held.status === "editing" || held.status === "failed") &&
        (!favourites || !sameChannels(favourites, held.original) || channels !== held.listed)));
  if (obsolete) setDraft(null);
  const draft = obsolete ? null : held;

  // While a draft waits for the main process nothing else happens to it, and nothing takes the
  // viewer away from it before the answer: the keys rest, for every listener of the window.
  const waiting = waits(draft);
  useEffect(() => {
    if (!waiting) return;
    const rest = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      event.preventDefault();
    };
    window.addEventListener("keydown", rest, true);
    return () => window.removeEventListener("keydown", rest, true);
  }, [waiting]);

  const available = favourites !== undefined && (channels?.length ?? 0) > 1;

  /**
   * Changes the draft once an answer is in, if it still waits for that one: a draft cancelled or
   * started since stays as it is, and one that ended stays ended.
   */
  const answer = (token: string, next: (waiting: Draft) => Draft | null) =>
    setDraft((current) =>
      current && waits(current) && current.commandId === token ? next(current) : current,
    );

  /** Whether the subscriptions an answer is for are still the ones saved. */
  const connected = (from: string) => rosterOf(client) === from;

  /**
   * Reads `channels` from the main process, as it lists them now, into the lists' cache, and
   * gives the array the list gets for them from then on.
   */
  const read = async (viewing: Viewing) => {
    const listed = queries.browse(browseQuery(useUi.getState().list, viewing, "viewer"));
    await client.fetchQuery({ ...listed, staleTime: 0 });
    return client.getQueryData(listed.queryKey)?.channels;
  };

  /**
   * Takes in the record the main process answered an order with: the record as it stands, which
   * for an order sent again can be further on than that order. So the list shows the channels
   * the main process names for the record's favourites, read before it shows them, and never
   * the draft's. An answer for subscriptions that changed since tells the lists nothing, and
   * neither does one older than the record they hold.
   */
  const takeIn = async (from: string, viewing: Viewing) => {
    const later = client.getQueryData(queries.viewing().queryKey)?.sequence ?? 0;
    if (!connected(from) || later > viewing.sequence) return;
    // A list that can't be read says so itself, once it shows.
    await read(viewing).catch(() => {});
    keepViewing(client, viewing, from);
  };

  const select = (channel: OwnedId, part: RowPart = "row") => {
    if (!draft || waiting) return;
    setDraft({ ...draft, focus: { channel, part, asked: draft.focus.asked + 1 } });
  };

  const save = (from: Draft) => {
    if (sameChannels(from.order, from.listed)) return setDraft(null);
    const commandId = from.commandId ?? crypto.randomUUID();
    setDraft({ ...from, status: "saving", commandId });
    const { saved, original, order } = from;
    const roster = rosterOf(client);
    if (roster !== saved) return setDraft(null);
    void call("viewing.reorderFavourites", {
      commandId,
      original: original.map(ownedId),
      order: order.map(ownedId),
    }).then(
      async (viewing) => {
        await takeIn(roster, viewing);
        answer(commandId, () => null);
      },
      (cause: unknown) => {
        const changed = appError(cause).kind === "favourites-changed";
        answer(commandId, (sent) => ({ ...sent, status: changed ? "changed" : "failed" }));
      },
    );
  };

  /**
   * Starts over from the favourites as the main process has them, which refused the order: what
   * this page holds of them may be as old as the draft.
   */
  const reload = (from: Draft) => {
    const token = crypto.randomUUID();
    setDraft({ ...from, status: "reading", commandId: token });
    void (async () => {
      const viewing = await client.fetchQuery({ ...queries.viewing(), staleTime: 0 });
      const listed = await read(viewing);
      if (!listed || !connected(from.saved)) return null;
      const { channel, asked } = from.focus;
      return drafted(from.saved, viewing.favourites, listed, channel, asked + 1);
    })().then(
      (fresh) => answer(token, () => fresh),
      () => answer(token, () => null),
    );
  };

  return {
    draft,
    available,
    start: (channel) => {
      if (available && channels) setDraft(drafted(saved, favourites, channels, channel, 1));
    },
    select,
    focused: (channel, part) => {
      if (!draft || waiting) return;
      if (sameOwned(draft.focus.channel, channel) && draft.focus.part === part) return;
      setDraft({ ...draft, focus: { ...draft.focus, channel, part } });
    },
    step: (by) => {
      if (!draft) return;
      const at = draft.order.findIndex((channel) => sameOwned(channel, draft.focus.channel));
      const next = draft.order[Math.min(Math.max(at + by, 0), draft.order.length - 1)];
      if (next) select(next);
    },
    move: (moved, by, part = "row") => {
      if (!draft || (draft.status !== "editing" && draft.status !== "failed")) return;
      const from = draft.order.findIndex((channel) => sameOwned(channel, moved));
      const channel = draft.order[from];
      if (!channel) return;
      const to = Math.min(Math.max(from + by, 0), draft.order.length - 1);
      const order = draft.order.toSpliced(from, 1).toSpliced(to, 0, channel);
      setDraft({
        ...draft,
        order,
        focus: { channel, part, asked: draft.focus.asked + 1 },
        // Another order than the one that failed is another save, under an id of its own.
        ...(to === from ? {} : { status: "editing", commandId: null }),
        said: t("{name}, {position} of {count}", {
          name: channel.title,
          position: to + 1,
          count: order.length,
        }),
      });
    },
    confirm: () => {
      if (!draft || waiting) return;
      if (draft.status === "changed") reload(draft);
      else save(draft);
    },
    cancel: () => {
      if (draft && !waiting) setDraft(null);
    },
  };
}
