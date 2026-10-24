// Marking an episode watched or unwatched by hand, from the three dots on its row in a series'
// details. The mark is the viewer's word on the episode, in the subscription whose version the
// sheet shows: it opens no stream and leaves what plays alone. A row changes only once the main
// process stored the mark, and one mark is made at a time.
//
// The line under the season tabs says what was marked and offers Undo, which puts the episode and
// the series back exactly as they were. It goes once the series is marked again or played, when
// the main process would refuse the Undo. A mark that wasn't stored says so there too, with
// Retry, which sends the same change again: if the first was stored after all, nothing is stored
// twice.
import { Menu } from "@base-ui/react/menu";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Circle, Ellipsis } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AppError } from "@mrstreamer/contracts/errors";
import type { Episode } from "@mrstreamer/contracts/ondemand";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import type { EpisodeMark, SeriesViewing } from "@mrstreamer/contracts/viewing";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import type { EpisodeState } from "@mrstreamer/core/viewing/episodes";
import { t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { menuItem, menuSurface } from "../../components/ui/menu.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { queries } from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";

/** A mark asked for, with the id it is sent under: sending it again stores nothing twice. */
interface Marking {
  /** The series version it was made in. A sheet that shows another says nothing of it. */
  readonly series: string;
  readonly episode: Episode;
  readonly watched: boolean;
  readonly commandId: string;
}

/** How the viewer's last mark stands. */
type Change = Marking &
  (
    | { readonly step: "saving" }
    | { readonly step: "saved"; readonly revision: number }
    | { readonly step: "failed"; readonly error: AppError }
    | { readonly step: "undoing"; readonly revision: number }
    | { readonly step: "undo-failed"; readonly revision: number; readonly error: AppError }
  );

export interface EpisodeMarks {
  /** The last mark made in this series version, until it is undone or no longer the latest. */
  readonly change: Change | null;
  /** A mark or an Undo is being stored: no other is taken meanwhile. */
  readonly busy: boolean;
  mark(episode: Episode, watched: boolean): void;
  undo(): void;
  /** Sends the change that wasn't stored again. */
  retry(): void;
}

/**
 * The marks of the series version `series`, which the sheet shows. `standing` is how its episodes
 * stand as last read: once the main process would no longer take the mark back, as after another
 * mark or a play of the series, the line about it goes.
 */
export function useEpisodeMarks(
  series: OwnedId,
  standing: SeriesViewing | undefined,
): EpisodeMarks {
  const client = useQueryClient();
  const [change, setChange] = useState<Change | null>(null);
  /** Rises with each change sent, so only the latest one's answer shows. */
  const sent = useRef(0);
  // React hears that a change began a moment after it did (see lib/watchlist.ts).
  const underWay = useRef(false);
  // An answer that comes after the sheet closed shows nowhere.
  useEffect(() => () => void sent.current++, []);
  const key = ownedKey(series);

  /** Stores `marking`, or takes back the mark `revision` names, and shows how it went. */
  const send = (marking: Marking, revision?: number) => {
    if (underWay.current) return;
    underWay.current = true;
    const mine = ++sent.current;
    const undoing = revision !== undefined;
    setChange(undoing ? { ...marking, step: "undoing", revision } : { ...marking, step: "saving" });
    const { episode, watched, commandId } = marking;
    const stored: Promise<EpisodeMark | null> = undoing
      ? call("viewing.undoMark", { commandId, series, revision })
      : call("viewing.markEpisode", {
          commandId,
          watched,
          episode: {
            kind: "episode",
            subscriptionId: episode.subscriptionId,
            id: episode.id,
            seriesId: episode.seriesId,
            season: episode.season,
            episode: episode.number,
          },
        });
    void stored
      .then(
        async (mark): Promise<Change | null> => {
          // The rows are read again first, so they show what was stored as the line says so.
          await client.invalidateQueries({ queryKey: queries.episodes(series).queryKey });
          return mark ? { ...marking, step: "saved", revision: mark.revision } : null;
        },
        (cause: unknown): Change => {
          const error = appError(cause);
          return undoing
            ? { ...marking, step: "undo-failed", revision, error }
            : { ...marking, step: "failed", error };
        },
      )
      .then((next) => {
        underWay.current = false;
        if (mine === sent.current) setChange(next);
      });
  };

  const mine = change?.series === key ? change : null;
  const stale =
    mine?.step === "saved" && standing !== undefined && standing.undoable !== mine.revision;

  return {
    change: stale ? null : mine,
    busy: mine?.step === "saving" || mine?.step === "undoing",
    mark: (episode, watched) =>
      send({ series: key, episode, watched, commandId: crypto.randomUUID() }),
    undo: () => {
      // Another id than the mark's own: an Undo is a change of its own.
      if (mine?.step === "saved") send({ ...mine, commandId: crypto.randomUUID() }, mine.revision);
    },
    retry: () => {
      if (mine?.step === "failed") send(mine);
      if (mine?.step === "undo-failed") send(mine, mine.revision);
    },
  };
}

/**
 * The three dots on an episode's row: Mark watched and Mark unwatched, each naming the
 * subscription when the title's versions are of several. An episode played partway offers both,
 * so it can be reset without marking it watched first.
 */
export function EpisodeMenu({
  episode,
  state,
  source,
  marks,
}: {
  episode: Episode;
  state: EpisodeState<unknown>["kind"];
  /** The subscription whose record the mark goes to, when the title has versions of several. */
  source: string | null;
  marks: EpisodeMarks;
}) {
  const saving = marks.busy && marks.change?.episode.id === episode.id;
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("More for {episode}", {
              episode: episodeLabel(episode.season, episode.number),
            })}
            aria-busy={saving || undefined}
            // Dim until the row is pointed at or the button has the keyboard, as in the row's own
            // weight; never disabled, so it keeps the focus while a mark is stored.
            className={cn(
              "opacity-40 group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100",
              saving && "opacity-50",
            )}
          />
        }
      >
        <Ellipsis />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={8} className="z-[60]">
          <Menu.Popup
            className={cn(menuSurface, "w-max min-w-[15rem] max-w-[26rem] text-[0.9375rem]")}
          >
            <MarkItem
              disabled={marks.busy || state === "watched"}
              source={source}
              onPick={() => marks.mark(episode, true)}
            >
              <Check className="size-4 flex-none" />
              {t("Mark watched")}
            </MarkItem>
            <MarkItem
              disabled={marks.busy || state === "unwatched"}
              source={source}
              onPick={() => marks.mark(episode, false)}
            >
              <Circle className="size-4 flex-none" />
              {t("Mark unwatched")}
            </MarkItem>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function MarkItem({
  disabled,
  source,
  onPick,
  children,
}: {
  disabled: boolean;
  source: string | null;
  onPick: () => void;
  children: ReactNode;
}) {
  return (
    <Menu.Item
      disabled={disabled}
      onClick={onPick}
      className={cn(
        menuItem,
        "flex w-full items-center gap-2 px-2 py-1.5 text-foreground/80 data-disabled:text-muted-foreground/60 data-highlighted:text-white",
      )}
    >
      {children}
      {source && (
        <span className="ml-auto flex-none pl-4 text-[0.8125rem] text-muted-foreground">
          {source}
        </span>
      )}
    </Menu.Item>
  );
}

/**
 * The line under the season tabs about the last mark: what was marked, with Undo, or that it
 * wasn't stored, with Retry. Nothing shows while it is being stored: its row says so.
 */
export function MarkNotice({ marks, source }: { marks: EpisodeMarks; source: string | null }) {
  const { change } = marks;
  if (!change || change.step === "saving") return null;
  const episode = episodeLabel(change.episode.season, change.episode.number);
  const failed = change.step === "failed" || change.step === "undo-failed";
  // An Undo the record refused can't be tried again: the series moved on.
  const action = !failed ? t("Undo") : change.error.kind === "mark-changed" ? null : t("Retry");
  /** "S1 E3 marked watched on Holiday house". */
  const marked = () => {
    if (change.watched) {
      return source
        ? t("{episode} marked watched on {source}", { episode, source })
        : t("{episode} marked watched", { episode });
    }
    return source
      ? t("{episode} marked unwatched on {source}", { episode, source })
      : t("{episode} marked unwatched", { episode });
  };
  /** "Couldn't mark S1 E3 watched on Holiday house." */
  const notMarked = () => {
    if (change.watched) {
      return source
        ? t("Couldn't mark {episode} watched on {source}.", { episode, source })
        : t("Couldn't mark {episode} watched.", { episode });
    }
    return source
      ? t("Couldn't mark {episode} unwatched on {source}.", { episode, source })
      : t("Couldn't mark {episode} unwatched.", { episode });
  };
  return (
    <p
      role={failed ? "alert" : "status"}
      className={cn(
        "mx-2 mb-2 flex flex-wrap items-baseline gap-x-3 text-[0.8125rem]",
        failed && "text-destructive",
      )}
    >
      <span>
        {change.step === "failed"
          ? `${notMarked()} ${describeError(change.error)}`
          : change.step === "undo-failed"
            ? change.error.kind === "mark-changed"
              ? describeError(change.error)
              : `${t("Couldn't undo {episode}.", { episode })} ${describeError(change.error)}`
            : marked()}
      </span>
      {action && (
        <button
          aria-disabled={marks.busy || undefined}
          onClick={failed ? marks.retry : marks.undo}
          className="flex-none text-white underline underline-offset-4"
        >
          {action}
        </button>
      )}
    </p>
  );
}
