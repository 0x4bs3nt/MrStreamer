// Artwork for movies, series and episodes: the provider's image, or the title's name on a tint
// worked out from it when the provider has none or it doesn't load.
import { X } from "lucide-react";
import { useState } from "react";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { t } from "@mrstreamer/core/i18n";
import { useSourceOf } from "../lib/queries.ts";
import { cn } from "../lib/utils.ts";
import { hueOf } from "./ChannelLogo.tsx";
import { Progress } from "./Progress.tsx";

/**
 * Widths to ask TMDB for, by how wide the artwork shows: twice its width on screen, for sharp
 * displays. Providers link 600-pixel posters and 1280-pixel backdrops whatever the use.
 */
const WIDTHS = { thumb: 154, card: 342, wide: 780, full: 1280 } as const;

/** A provider's TMDB link at the width shown; any other link as it is. */
function sized(url: string, size: keyof typeof WIDTHS): string {
  return url.replace(/^(https?:\/\/image\.tmdb\.org\/t\/p\/)[^/]+\//, `$1w${WIDTHS[size]}/`);
}

export function Artwork({
  url,
  name,
  size,
  className,
  plain = false,
}: {
  url: string | null;
  name: string;
  /** How wide it shows: thumb up to 77 px, card 171, wide 390, full beyond. */
  size: keyof typeof WIDTHS;
  className?: string;
  /** Only the tint, where the name already shows beside it. */
  plain?: boolean;
}) {
  // The link that failed to load: a tile shown again for another title tries its own.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (url && url !== failedUrl) {
    return (
      <img
        src={sized(url, size)}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailedUrl(url)}
        className={cn("size-full object-cover", className)}
      />
    );
  }
  const hue = hueOf(name);
  return (
    <span
      className={cn(
        "grid size-full place-items-center p-3 text-center text-[0.8125rem] font-semibold text-balance",
        className,
      )}
      style={{
        background: `linear-gradient(160deg, hsl(${hue} 30% 18%), hsl(${hue} 25% 8%))`,
        color: `hsl(${hue} 50% 82%)`,
      }}
    >
      {plain ? null : name}
    </span>
  );
}

/**
 * A movie or series as a poster, with its name and a short line under it. The line ends with the
 * subscription the title is from where another's reads the same and isn't it.
 */
export function PosterTile({
  title,
  line,
  wrapLine = false,
  onOpen,
}: {
  title: Title;
  line?: string;
  /** Home recommendation reasons include the seed and must remain readable. */
  wrapLine?: boolean;
  onOpen: () => void;
}) {
  const source = useSourceOf()(title);
  return (
    <button
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOpen}
      className="group min-w-0 text-left"
    >
      <span className="block aspect-[2/3] overflow-hidden rounded-xl ring-1 ring-white/8 transition-[box-shadow,transform] duration-150 group-hover:ring-2 group-hover:ring-white/40 group-active:scale-[0.98]">
        <Artwork url={title.posterUrl} name={title.title} size="card" />
      </span>
      <span className="mt-2 block truncate text-[0.875rem] font-medium">{title.title}</span>
      <span
        className={cn("block text-xs text-muted-foreground", wrapLine ? "break-words" : "truncate")}
      >
        {[line ?? [title.year, ...title.tags].filter(Boolean).join(" · "), source]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </button>
  );
}

/**
 * Something to resume or start, as a 16:9 picture with how far it got. Remove, on hover, takes it
 * out of Continue watching.
 */
export function StillTile({
  artworkUrl,
  name,
  line,
  done,
  onPlay,
  onRemove,
}: {
  artworkUrl: string | null;
  name: string;
  line: string;
  /** How far, from 0 to 1; null draws no bar. */
  done: number | null;
  onPlay: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className="group relative min-w-0">
      <button
        onMouseDown={(event) => event.preventDefault()}
        onClick={onPlay}
        className="block w-full text-left"
      >
        <span className="relative block aspect-video overflow-hidden rounded-xl ring-1 ring-white/8 transition-[box-shadow,transform] duration-150 group-hover:ring-2 group-hover:ring-white/40 group-active:scale-[0.98]">
          <Artwork url={artworkUrl} name={name} size="wide" />
          {done !== null && <Progress value={done} className="absolute inset-x-3 bottom-2.5" />}
        </span>
        <span className="mt-2 block truncate text-[0.875rem] font-medium">{name}</span>
        <span className="block truncate text-xs text-muted-foreground">{line}</span>
      </button>
      {onRemove && (
        <button
          aria-label={t("Remove {name} from Continue watching", { name })}
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
