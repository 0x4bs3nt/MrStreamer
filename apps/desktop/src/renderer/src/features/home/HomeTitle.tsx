import { Play, X } from "lucide-react";
import { t } from "@mrstreamer/core/i18n";
import { Artwork } from "../../components/TitleArt.tsx";
import { Progress } from "../../components/Progress.tsx";
import { Button } from "../../components/ui/button.tsx";

/** Sparse rows keep a small piece of artwork beside their title and public actions. */
export function HomeTitle({
  name,
  artworkUrl,
  line,
  still = false,
  done = null,
  unavailable = false,
  onOpen,
  onPlay,
  onRemove,
}: {
  name: string;
  artworkUrl: string | null;
  line: string;
  still?: boolean;
  done?: number | null;
  unavailable?: boolean;
  onOpen: () => void;
  onPlay?: (() => void) | undefined;
  onRemove?: () => void;
}) {
  return (
    <article className="group flex min-w-0 items-center gap-4" data-home-title>
      <div className={`relative shrink-0 ${still ? "w-44" : "w-28"}`}>
        <button
          title={name}
          onMouseDown={(event) => event.preventDefault()}
          onClick={still ? (onPlay ?? onOpen) : onOpen}
          className={`relative block w-full overflow-hidden rounded-xl ring-1 ring-white/8 hover:ring-white/40 ${still ? "aspect-video" : "aspect-[2/3]"}`}
        >
          <Artwork
            url={artworkUrl}
            name={name}
            size={still ? "wide" : "card"}
            className={unavailable ? "opacity-45 saturate-[0.2]" : ""}
          />
          {done !== null && <Progress value={done} className="absolute inset-x-3 bottom-2.5" />}
        </button>
        {onRemove && (
          <Button
            variant="media"
            size="icon-sm"
            className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={t("Remove {name} from Continue watching", { name })}
            onClick={onRemove}
          >
            <X />
          </Button>
        )}
      </div>
      <div className="min-w-0">
        <h3 className="text-lg leading-snug font-semibold break-words">{name}</h3>
        <p className="mt-1 text-[0.8125rem] break-words text-muted-foreground">{line}</p>
        <div className="mt-3.5 flex flex-wrap gap-2">
          {onPlay && (
            <Button variant="primary" size="sm" onClick={onPlay}>
              <Play className="fill-current" />
              {done === null ? t("Play") : t("Resume")}
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={onOpen}>
            {t("Details")}
          </Button>
        </div>
      </div>
    </article>
  );
}
