// What Live TV shows of the viewer's lists, where they show: the options of a list's header and
// what they open in its place (a field to rename it, a question before deleting it), a channel
// row's lists menu, the channels a list keeps that their subscription no longer lists, and the
// line a failed change leaves, with Retry. Menus are UI A's, and keep their keys to themselves.
import { Menu } from "@base-ui/react/menu";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Ellipsis, ListPlus, Plus } from "lucide-react";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { CUSTOM_LIST_NAME_MAX, type CustomList } from "@mrstreamer/contracts/custom-lists";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { t } from "@mrstreamer/core/i18n";
import { initials } from "../../components/ChannelLogo.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { menuItem, menuSurface } from "../../components/ui/menu.ts";
import { describeError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { cn } from "../../lib/utils.ts";
import { holds, removeList, useListChange, type ChangeState } from "./custom-lists.ts";

/**
 * Keeps a menu's pointer and keys from the row or page behind it: its popup sits in a portal,
 * whose events still reach the components it was opened from.
 */
const keep = (event: SyntheticEvent) => event.stopPropagation();

/**
 * What a failed change came to, in the window's words, and whether sending it again as it was
 * can help: not once the list went, its name is another's, or the list changed under it.
 */
function failureOf(state: ChangeState): { readonly text: string; readonly retry: boolean } | null {
  if (state.status !== "failed") return null;
  const { error } = state;
  return error.kind === "list-name-taken" ||
    error.kind === "no-list" ||
    error.kind === "list-changed"
    ? { text: describeError(error), retry: false }
    : { text: t("Couldn't save."), retry: true };
}

/**
 * "Couldn't save." with Retry, for the last change made from a row or a menu that failed. One
 * that can't be sent again as it was says why, with Close.
 */
export function ChangeNotice({
  state,
  onRetry,
  onDismiss,
}: {
  state: ChangeState;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const failure = failureOf(state);
  if (!failure) return null;
  return (
    <p role="alert" className="flex items-baseline gap-4 px-9 pb-2.5 text-sm">
      <span className="min-w-0 text-foreground/85">{failure.text}</span>
      <button
        onMouseDown={(event) => event.preventDefault()}
        onClick={failure.retry ? onRetry : onDismiss}
        className="flex-none text-white underline underline-offset-4"
      >
        {failure.retry ? t("Retry") : t("Close")}
      </button>
    </p>
  );
}

/** The options of a list's header: Rename, Move up, Move down and Delete list. */
export function ListOptions({
  list,
  first,
  last,
  onRename,
  onMove,
  onDelete,
}: {
  list: CustomList;
  /** Whether it is the first of the viewer's lists, or the last: it moves no further. */
  first: boolean;
  last: boolean;
  onRename: () => void;
  onMove: (by: -1 | 1) => void;
  onDelete: () => void;
}) {
  const item = cn(menuItem, "flex h-9 items-center px-2 data-disabled:opacity-40");
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("Options for {list}", { list: list.name })}
            title={t("Options for {list}", { list: list.name })}
          />
        }
      >
        <Ellipsis />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={8} className="z-[60]">
          <Menu.Popup
            aria-label={t("Options for {list}", { list: list.name })}
            className={cn(menuSurface, "w-[12rem] text-[0.875rem] text-white")}
            onKeyDown={keep}
            onClick={keep}
          >
            <Menu.Item closeOnClick onClick={onRename} className={item}>
              {t("Rename")}
            </Menu.Item>
            <Menu.Item closeOnClick disabled={first} onClick={() => onMove(-1)} className={item}>
              {t("Move up")}
            </Menu.Item>
            <Menu.Item closeOnClick disabled={last} onClick={() => onMove(1)} className={item}>
              {t("Move down")}
            </Menu.Item>
            <Menu.Separator className="mx-1 my-1 h-px bg-white/12" />
            <Menu.Item closeOnClick onClick={onDelete} className={cn(item, "text-destructive")}>
              {t("Delete list")}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * The list's name as a field in its header, with Cancel and Save. Enter saves, Escape cancels;
 * a failed save stays to try again. While it saves, nothing is disabled, so the focus stays where
 * it was for Enter again; a second save waits for the first. `onDone` follows a save or a cancel.
 */
export function RenameList({ list, onDone }: { list: CustomList; onDone: () => void }) {
  const [name, setName] = useState(list.name);
  const change = useListChange();
  const saving = change.state.status === "saving";
  const failure = failureOf(change.state);
  const save = async () => {
    if (saving) return;
    if (name.trim() === list.name || name.trim() === "") return onDone();
    if (await change.run(() => call("customLists.rename", { id: list.id, name }))) onDone();
  };
  return (
    <>
      <Input
        compact
        autoFocus
        aria-label={t("List name")}
        aria-invalid={failure ? true : undefined}
        maxLength={CUSTOM_LIST_NAME_MAX}
        value={name}
        readOnly={saving}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") void save();
          else if (event.key === "Escape") {
            if (!saving) onDone();
          } else return;
          event.preventDefault();
          event.stopPropagation();
        }}
        className="w-[15rem] flex-none text-base"
      />
      {failure && (
        <span role="alert" className="min-w-0 truncate text-[0.8125rem] text-foreground">
          {failure.text}
        </span>
      )}
      <div className="ml-auto flex flex-none items-center gap-2">
        <Button size="sm" onClick={() => !saving && onDone()} aria-disabled={saving}>
          {t("Cancel")}
        </Button>
        <Button size="sm" variant="primary" onClick={() => void save()} aria-disabled={saving}>
          {failure?.retry ? t("Retry") : t("Save")}
        </Button>
      </div>
    </>
  );
}

/**
 * Asks once before a list goes: "Delete Late sport?" with Cancel and Delete list, which deletes
 * it with every channel it holds, of every account. `onDone` follows a cancel, `onDeleted` the
 * delete.
 */
export function DeleteList({
  list,
  onDone,
  onDeleted,
}: {
  list: CustomList;
  onDone: () => void;
  onDeleted: () => void;
}) {
  const client = useQueryClient();
  const change = useListChange();
  const saving = change.state.status === "saving";
  const failure = failureOf(change.state);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  const remove = async () => {
    if (!saving && (await change.run(removeList(client, list.id)))) onDeleted();
  };
  return (
    <div
      role="group"
      aria-label={t("Delete {name}?", { name: list.name })}
      className="flex flex-none items-center gap-3 px-9 pb-3"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || saving) return;
        event.stopPropagation();
        onDone();
      }}
    >
      <span role={failure ? "alert" : undefined} className="min-w-0 truncate text-[0.8125rem]">
        {failure?.text ?? t("Delete {name}?", { name: list.name })}
      </span>
      <div className="ml-auto flex flex-none items-center gap-2">
        <Button ref={cancel} size="sm" onClick={() => !saving && onDone()} aria-disabled={saving}>
          {t("Cancel")}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => void remove()}
          aria-disabled={saving}
        >
          {failure?.retry ? t("Retry") : t("Delete list")}
        </Button>
      </div>
    </div>
  );
}

/**
 * A channel row's lists menu: the viewer's lists, each ticked where it holds the channel, then
 * New list. Ticking one puts the channel in it at its end, and clearing it takes it out.
 */
export function ListMenu({
  channel,
  lists,
  shown,
  onSet,
  onNew,
  onOpenChange,
}: {
  channel: LiveChannel;
  lists: readonly CustomList[];
  /** Whether the button shows while the pointer isn't on its row. */
  shown: boolean;
  onSet: (list: CustomList, member: boolean) => void;
  onNew: () => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const open = useRef(false);
  useEffect(
    () => () => {
      if (open.current) onOpenChange?.(false);
    },
    [onOpenChange],
  );
  return (
    <span onClick={keep} onKeyDown={keep}>
      <Menu.Root
        onOpenChange={(next) => {
          open.current = next;
          onOpenChange?.(next);
        }}
      >
        <Menu.Trigger
          aria-label={t("Lists for {name}", { name: channel.title })}
          title={t("Lists")}
          onMouseDown={(event) => event.preventDefault()}
          className={cn(
            "grid size-8 place-items-center rounded-full text-muted-foreground outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-white/10 data-popup-open:text-white data-popup-open:opacity-100",
            !shown && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          )}
        >
          <ListPlus className="size-4" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-[60]">
            <Menu.Popup
              aria-label={t("Lists for {name}", { name: channel.title })}
              className={cn(
                menuSurface,
                "max-h-[min(60vh,var(--available-height))] w-[15rem] overflow-y-auto text-[0.875rem] text-white",
              )}
              onKeyDown={keep}
              onClick={keep}
              onMouseDown={keep}
            >
              <Menu.Group>
                <Menu.GroupLabel className="px-2 pt-1 pb-1.5 text-[0.8125rem] text-muted-foreground">
                  {t("Lists")}
                </Menu.GroupLabel>
                {lists.map((list) => (
                  <Menu.CheckboxItem
                    key={list.id}
                    checked={holds(list, channel)}
                    onCheckedChange={(member) => onSet(list, member)}
                    className={cn(menuItem, "group/item flex h-9 items-center gap-2.5 px-2")}
                  >
                    <span className="grid size-4 flex-none place-items-center rounded-[0.25rem] shadow-[inset_0_0_0_1.5px_rgb(255_255_255/45%)] group-data-checked/item:bg-white group-data-checked/item:shadow-none">
                      <Menu.CheckboxItemIndicator>
                        <Check className="size-3 text-black" strokeWidth={3} />
                      </Menu.CheckboxItemIndicator>
                    </span>
                    <span className="min-w-0 truncate">{list.name}</span>
                  </Menu.CheckboxItem>
                ))}
              </Menu.Group>
              {lists.length > 0 && <Menu.Separator className="mx-1 my-1 h-px bg-white/12" />}
              <Menu.Item
                closeOnClick
                onClick={onNew}
                className={cn(menuItem, "flex h-9 items-center gap-2.5 px-2")}
              >
                <Plus className="size-3.5 flex-none" />
                {t("New list")}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </span>
  );
}

/** A channel of a list its saved subscription lists none of the streams of now. */
export interface UnlistedChannel {
  readonly member: string;
  readonly name: string;
  /** Its subscription, by name. */
  readonly source: string;
}

/**
 * The channels a list keeps that their subscription doesn't list now, after those it does: by
 * the name each had, dimmed, with Remove.
 */
export function UnlistedRows({
  channels,
  onRemove,
}: {
  channels: readonly UnlistedChannel[];
  onRemove: (member: string) => void;
}) {
  if (channels.length === 0) return null;
  return (
    <div role="list" aria-label={t("Not listed now")}>
      {channels.map((channel) => (
        <div
          key={channel.member}
          role="listitem"
          className="flex h-[3.5rem] items-center gap-4 rounded-lg px-3"
        >
          <span className="w-9 flex-none" />
          <span className="grid h-8 w-12 flex-none place-items-center rounded-lg bg-white/4 text-[0.625rem] font-bold tracking-wide text-white/40">
            {initials(channel.name)}
          </span>
          <span className="w-[13rem] flex-none truncate text-[0.9375rem] text-muted-foreground">
            {channel.name}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {t("Not listed by {name} now", { name: channel.source })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("Remove {name}", { name: channel.name })}
            onClick={() => onRemove(channel.member)}
          >
            {t("Remove")}
          </Button>
        </div>
      ))}
    </div>
  );
}

/**
 * "1 channel is from a subscription that isn't saved.": what a list keeps for subscriptions
 * removed without erasing, which shows again once they are added again.
 */
export function AwayNote({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <p className="px-9 pb-2.5 text-sm text-muted-foreground">
      {t("{count} channels are from a subscription that isn't saved.", { count })}
    </p>
  );
}
