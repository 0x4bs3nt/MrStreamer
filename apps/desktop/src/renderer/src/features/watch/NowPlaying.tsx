import { useQuery } from "@tanstack/react-query";
import { List, Maximize, Minimize, Play, Square, Star } from "lucide-react";
import { useEffect, useState } from "react";
import type { Category, LiveChannel } from "@mrstreamer/contracts/library";
import { ownedKey, sameOwned } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Progress } from "../../components/Progress.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Tooltip } from "../../components/ui/tooltip.tsx";
import { LiveMore, type LiveMenu } from "./LiveMore.tsx";
import { TrackMenus } from "./TrackMenus.tsx";
import { useNow } from "../../lib/clock.ts";
import {
  channelLine,
  clockTime,
  pastTime,
  progressOf,
  techLine,
  timeLeft,
} from "../../lib/format.ts";
import { qualityName } from "../../lib/quality.ts";
import {
  queries,
  useChooseQuality,
  useFavouriteKeys,
  useSourceOf,
  useToggleFavourite,
} from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
import type { StreamInfo } from "../../player/engine.ts";
import { useOutput } from "../../player/output.ts";
import { player, usePlayer } from "../../player/player.ts";
import { useChannelQuality } from "./quality.ts";
import { VolumeControl } from "./VolumeControl.tsx";

interface NowPlayingProps {
  channel: LiveChannel;
  /** The menu or More page open over the Live TV controls. */
  menu: LiveMenu;
  /** Direct shortcuts focus a choice; pointer opens keep focus off the choices. */
  keyboardMenu: boolean;
  onMenu: (menu: LiveMenu) => void;
  categories: ReadonlyMap<string, Category>;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onOpenChannels: () => void;
  /** Switches to the channel above (-1) or below (1) in the current list. */
  onSwitch: (direction: -1 | 1) => void;
}

/** Programme details and idle-fading controls. Only the controls intercept picture gestures. */
export function NowPlayingBar({ visible, ...props }: NowPlayingProps & { visible: boolean }) {
  return (
    <div
      className={cn(
        "pointer-events-none no-drag absolute inset-x-0 bottom-0 z-10 flex items-end gap-8 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-10 pt-32 pb-8 transition-opacity duration-300 max-[720px]:flex-col max-[720px]:items-stretch max-[720px]:gap-3 max-[720px]:px-4 max-[720px]:pb-4",
        visible ? "opacity-100 [&>div:last-child]:pointer-events-auto" : "opacity-0",
      )}
    >
      <Details {...props} />
      <Controls {...props} />
    </div>
  );
}

/**
 * Programme first: its title, time left and what's next. The channel stands in without a guide.
 * A programme from the catch-up archive says when it aired instead. Once it plays, the line says
 * the provider's quality and what the decoder reports, and when Automatic had to play another
 * stream.
 */
function Details({ channel, categories }: NowPlayingProps) {
  const playing = usePlayer(
    (state) => state.phase.kind === "playing" && sameOwned(state.channel, channel),
  );
  const archive = usePlayer((state) => (sameOwned(state.channel, channel) ? state.archive : null));
  const listing = useQuery(queries.listings([channel])).data?.[ownedKey(channel)];
  const now = useNow();
  const tech = techLine(useStreamInfo(playing));
  const quality = useChannelQuality(channel);
  const current = archive ? null : (listing?.now ?? null);
  const next = archive ? null : (listing?.next ?? null);
  // Whose channel it is, where another subscription has one of its name.
  const source = useSourceOf()(channel);
  const line = archive
    ? [channel.title, source, t("Aired {time}", { time: pastTime(archive.start, now) })]
    : current
      ? [
          channel.title,
          source,
          t("Until {time}", { time: clockTime(current.stop, now) }),
          timeLeft(current, now),
        ]
      : [channelLine(channel, categories), source];
  const fellBack = quality.fellBack;
  return (
    <div className="flex min-w-0 items-center gap-5 min-[720px]:flex-1">
      <ChannelLogo channel={channel} className="h-12 w-18" />
      <div className="min-w-0">
        <div className="truncate text-3xl font-semibold tracking-tight">
          {(archive ?? current)?.title ?? channel.title}
        </div>
        <div className="mt-1 truncate text-sm text-foreground/85">
          {[...line, playing && quality.playing && qualityName(quality.playing), tech]
            .filter(Boolean)
            .join(" · ")}
          {fellBack && (
            <span className="text-white">
              {" · "}
              {t("{from} didn't start, playing {to}", {
                from: qualityName(fellBack.from),
                to: qualityName(fellBack.to),
              })}
            </span>
          )}
        </div>
        {current && <Progress value={progressOf(current, now)} className="mt-2 w-64" />}
        {next && (
          <div className="mt-1.5 truncate text-sm text-muted-foreground">
            {clockTime(next.start, now)} {next.title}
          </div>
        )}
      </div>
    </div>
  );
}

function Controls({
  channel,
  fullscreen,
  onToggleFullscreen,
  onOpenChannels,
  onSwitch,
  menu,
  keyboardMenu,
  onMenu,
}: NowPlayingProps) {
  const tracks = usePlayer((state) => state.tracks);
  const audioId = usePlayer((state) => state.audioId);
  const subtitle = usePlayer((state) => state.subtitle);
  const subtitleLoading = usePlayer((state) => state.subtitleLoading);
  const active = usePlayer((state) => state.phase.kind !== "idle" && state.phase.kind !== "failed");
  const previous = usePlayer((state) => state.previous);
  const playing = usePlayer(
    (state) => state.phase.kind === "playing" && sameOwned(state.channel, channel),
  );
  const height = useStreamInfo(playing)?.height ?? null;
  const quality = useChannelQuality(channel);
  const chooseQuality = useChooseQuality();
  const favourite = useFavouriteKeys().has(ownedKey(channel));
  const toggleFavourite = useToggleFavourite();
  // A receiver shows none of a channel's subtitles, and takes none of their settings.
  const remote = useOutput((state) => state.status.output.kind !== "local") && player.onReceiver();
  useEffect(() => {
    if (menu === "subtitles" && !tracks?.subtitles.length) onMenu(null);
  }, [menu, tracks?.subtitles.length, onMenu]);
  return (
    <div className="ml-auto flex flex-none flex-wrap items-center justify-end gap-3 max-[720px]:gap-1.5">
      <Tooltip label={t("Channels")}>
        <Button variant="media" size="icon" aria-label={t("Channels")} onClick={onOpenChannels}>
          <List />
        </Button>
      </Tooltip>
      <Tooltip label={favourite ? t("Remove from favourites") : t("Add to favourites")}>
        <Button
          variant="media"
          size="icon"
          aria-label={favourite ? t("Remove from favourites") : t("Add to favourites")}
          aria-pressed={favourite}
          onClick={() => toggleFavourite(channel)}
        >
          <Star className={cn(favourite && "fill-current")} />
        </Button>
      </Tooltip>
      {active ? (
        <Tooltip label={t("Stop")}>
          <Button variant="media" size="icon" aria-label={t("Stop")} onClick={() => player.stop()}>
            <Square className="size-3.5 fill-current" />
          </Button>
        </Tooltip>
      ) : (
        <Tooltip label={t("Watch")}>
          <Button
            data-retry
            variant="primary"
            size="icon"
            aria-label={t("Watch")}
            onClick={() => player.play(channel)}
          >
            <Play className="size-4 translate-x-px fill-current" />
          </Button>
        </Tooltip>
      )}
      {tracks && (
        <TrackMenus
          showSound={false}
          audio={tracks.audio}
          audioId={audioId ?? tracks.playing}
          subtitles={tracks.subtitles}
          subtitle={remote ? null : subtitle}
          subtitleNote={subtitleLoading ? t("Loading") : null}
          shows={remote ? [] : null}
          hereOnly={t("Live subtitles play on this computer only.")}
          open={menu === "subtitles" ? menu : null}
          onOpenChange={onMenu}
          onAudio={(id) => player.setAudio(id)}
          onSubtitle={(track) => player.setSubtitle(track)}
        />
      )}
      <VolumeControl compact />
      <Tooltip label={fullscreen ? t("Exit full screen") : t("Full screen")}>
        <Button
          variant="media"
          size="icon"
          aria-label={t("Full screen")}
          onClick={onToggleFullscreen}
        >
          {fullscreen ? <Minimize /> : <Maximize />}
        </Button>
      </Tooltip>
      <LiveMore
        menu={menu}
        keyboardOpen={keyboardMenu}
        onMenu={onMenu}
        previous={previous}
        onSwitch={onSwitch}
        onPrevious={() => player.back()}
        sound={
          tracks && tracks.audio.length > 1
            ? {
                audio: tracks.audio,
                audioId: audioId ?? tracks.playing,
                onAudio: (id) => player.setAudio(id),
                onDone: () => onMenu(null),
              }
            : null
        }
        quality={
          channel.variants.length > 1
            ? {
                channel,
                chosen: quality.chosen,
                automatic: quality.automatic,
                playing: quality.playing,
                height,
                notes: quality.notes,
                onDone: () => onMenu(null),
                onChoose: (variantId) => chooseQuality(channel, variantId),
              }
            : null
        }
      />
    </div>
  );
}

/** Resolution, frame rate and audio of the playing stream, read once playback settles. */
function useStreamInfo(playing: boolean): StreamInfo | null {
  const [info, setInfo] = useState<StreamInfo | null>(null);
  useEffect(() => {
    if (!playing) {
      setInfo(null);
      return;
    }
    const read = () => setInfo(player.info());
    read();
    const timer = setTimeout(read, 1500);
    return () => clearTimeout(timer);
  }, [playing]);
  return info;
}
