// A saved movie or series as a poster, in the Watchlist's grid and in Home's row. One the lists
// have opens its details, where Play offers every subscription's versions; one they don't is
// dimmed, says Unavailable and opens the short sheet that removes it.
import { X } from "lucide-react";
import { ownedId } from "@mrstreamer/contracts/subscription";
import type { WatchlistEntry } from "@mrstreamer/contracts/watchlist";
import { t } from "@mrstreamer/core/i18n";
import { openDetails, openSavedEntry } from "../../app/ui-store.ts";
import { PosterContent } from "../../components/TitleArt.tsx";
import { useSourceOf } from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
import { kindLabel } from "../../lib/watchlist.ts";
import type { GridTile } from "../titles/CollectionGrid.tsx";

/** Opens what a saved entry has to show: its title's details, or what was kept of it. */
export function openSaved(entry: WatchlistEntry): void {
  if (entry.title) openDetails({ kind: entry.kind, ...ownedId(entry.title) });
  else openSavedEntry(entry);
}

/**
 * The line under a poster ends with the subscription the title is from where another's reads the
 * same and isn't it, as every poster's does. In the Watchlist's grid, `grid` places it in the
 * grid's selection and Tab order, and the poster is named by what it shows.
 */
export function SavedTile({
  entry,
  brief = false,
  grid,
  onRemove,
}: {
  entry: WatchlistEntry;
  /** One word for an unavailable title, where a row has no room for more. */
  brief?: boolean;
  grid?: GridTile;
  /** Shows the cross that takes it off the watchlist. */
  onRemove?: () => void;
}) {
  const { title } = entry;
  const sourceOf = useSourceOf();
  const name = title?.title ?? entry.name;
  // The lists were there to look in, so an entry without a title is one no provider lists.
  // Without them, nothing says so.
  const unavailable = entry.listed && !title;
  const facts = [kindLabel(entry.kind), title?.year ?? entry.year, title && sourceOf(title)].filter(
    Boolean,
  );
  return (
    <div className="group relative min-w-0">
      <button
        onMouseDown={(event) => event.preventDefault()}
        onClick={grid ? grid.open : () => openSaved(entry)}
        className={cn("block w-full text-left", grid && "outline-none")}
        title={title?.name}
        {...(grid && {
          tabIndex: grid.tabIndex,
          "aria-label": [name, unavailable && t("Unavailable"), ...facts]
            .filter(Boolean)
            .join(", "),
        })}
      >
        <PosterContent
          artworkUrl={title?.posterUrl ?? entry.artworkUrl}
          name={name}
          selected={grid?.selected ?? false}
          unavailable={unavailable}
          caption={
            !unavailable
              ? facts.join(" · ")
              : brief
                ? t("Unavailable")
                : [t("Unavailable"), ...facts].join(" · ")
          }
        />
      </button>
      {onRemove && (
        <button
          aria-label={t("Remove {name} from Watchlist", { name })}
          data-remove
          {...(grid && { tabIndex: grid.tabIndex })}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onRemove}
          className="absolute top-2 right-2 grid size-7 place-items-center rounded-full bg-black/70 text-white opacity-0 ring-1 ring-white/20 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
