// How far TMDB's metadata has come, as a ring beside search in the top bar. It shows only while
// titles are being asked about, about a quarter of an hour on a first run, and goes once the
// asking ends: done, refused or unreachable. Clicking it opens Settings > Movies and series, which
// has the count and the key.
import { useQuery } from "@tanstack/react-query";
import { useUi } from "../app/ui-store.ts";
import { queries } from "../lib/queries.ts";
import { Button } from "./ui/button.tsx";
import { Tooltip } from "./ui/tooltip.tsx";

const RADIUS = 8;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function TmdbProgress() {
  const status = useQuery(queries.onDemandStatus());
  const metadata = status.data?.metadata;
  if (!metadata?.fetching || metadata.refused || metadata.known >= metadata.wanted) return null;
  const done = metadata.known / metadata.wanted;
  const label = `TMDB · ${Math.floor(done * 100)} %`;
  return (
    <Tooltip label={label} side="bottom">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        onClick={() => useUi.setState({ settings: "movies", settingsTarget: "tmdb" })}
      >
        <svg viewBox="0 0 20 20" className="size-[18px] -rotate-90" fill="none" strokeWidth={2.5}>
          <circle cx={10} cy={10} r={RADIUS} className="stroke-white/18" />
          <circle
            cx={10}
            cy={10}
            r={RADIUS}
            className="stroke-white transition-[stroke-dashoffset] duration-500"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - done)}
          />
        </svg>
      </Button>
    </Tooltip>
  );
}
