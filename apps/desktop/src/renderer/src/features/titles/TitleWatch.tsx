// Playing a movie or an episode: the picture fills the window, with the title, a scrubber and the
// controls along the bottom, fading when idle. Sound opens the file's sound tracks, CC everything
// about its subtitles, and Speed plays it slower or faster; a series offers its next episode, and at an
// episode's end counts down to it (see title-player.ts). Back returns to where the title was opened.
//   Space or K pauses, Left and Right skip 10 seconds, Up and Down change the volume, F is full
//   screen, M mutes, C turns subtitles on or off, N plays the next episode, also during the
//   countdown, G and H move subtitles earlier or later, < and > play slower or faster, P shrinks
//   the window into the mini player and back, O opens the chooser of where it plays. While a menu
//   is open, keys are its own: Escape closes it, then leaves full screen or the mini player, then
//   goes back.
// In the mini player the picture fills the small window, with a few controls along its foot.
// While a receiver on the network plays the title, the same controls command it and show what it
// confirmed, the picture area says where it plays, and the controls stay: there is no picture to
// clear. Going back leaves the receiver playing; only Play here, or quitting, ends it.
// A failure's message closes with its cross (CloseMessage.tsx), also with Enter or Space once Tab
// reached it, and the controls come back where it stood: Play, or Space, tries the title again.
import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import {
  Captions,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipForward,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SeriesDetails } from "@mrstreamer/contracts/ondemand";
import { ownedId, sameOwned } from "@mrstreamer/contracts/subscription";
import { nextEpisode } from "@mrstreamer/core/ondemand/details";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { formatDecimal, t } from "@mrstreamer/core/i18n";
import { miniPlayer, useMiniPlayer } from "../../app/mini-player.ts";
import { hasModifier, isTyping } from "../../app/platform.ts";
import { leaveTitle, openDetails, useUi } from "../../app/ui-store.ts";
import { Artwork } from "../../components/TitleArt.tsx";
import { Button } from "../../components/ui/button.tsx";
import { SliderControl } from "../../components/ui/slider.tsx";
import { Tooltip } from "../../components/ui/tooltip.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { describeError } from "../../lib/errors.ts";
import { clock, runtime } from "../../lib/titles.ts";
import { cn } from "../../lib/utils.ts";
import { WINDOW_BAR } from "../../../../shared/window-bar.ts";
import { useTitleSession } from "../../player/media-session.ts";
import { outputs, useOutput, where } from "../../player/output.ts";
import { Picture } from "../../player/Picture.tsx";
import { player } from "../../player/player.ts";
import {
  titlePlayer,
  useSubtitleNote,
  useTitlePlayer,
  type TitlePlayerState,
  type TitleProblem,
} from "../../player/title-player.ts";
import { CloseMessage, pressesClose, useClosed } from "../watch/CloseMessage.tsx";
import { pressesDownloads } from "../downloads/DownloadsNotice.tsx";
import { Flash, flash, flashNote } from "../watch/Flash.tsx";
import { useFullscreen, useWake } from "../watch/layout.ts";
import { MINI_NEEDS_PICTURE, MiniControls, MiniPlayerButton } from "../watch/MiniPlayer.tsx";
import {
  ConnectingNote,
  openChooser,
  OutputButton,
  PlayHere,
  ReceiverLine,
  receiverProblem,
} from "../watch/Output.tsx";
import { SpeedMenu, stepSpeed } from "../watch/SpeedMenu.tsx";
import { nudgeSubtitles } from "../watch/SubtitleSettings.tsx";
import { TrackMenus, type TrackMenu } from "../watch/TrackMenus.tsx";
import { SubtitlePanel, subtitleChoiceNote } from "./SubtitlePanel.tsx";
import { VolumeControl } from "../watch/VolumeControl.tsx";

/** Controls fade out after this long without input. */
const IDLE_MS = 3000;
const SKIP_S = 10;
/** How long the note that subtitles can't be had stays. */
const SUBTITLES_UNAVAILABLE_MS = 5000;
/** Which menu is open over the title's controls: one of the tracks' or its speed. */
type TitleMenu = TrackMenu | "speed";

/**
 * Leaves the title for its series' episodes: the details it was played from when they are still
 * open underneath, else the details of the version playing.
 */
function toEpisodes(series: SeriesDetails): void {
  const { details } = useUi.getState();
  const underneath =
    details?.kind === "series" &&
    series.title.versions.some((version) => sameOwned(version, details));
  leaveTitle();
  if (!underneath) openDetails({ kind: "series", ...ownedId(series.title) });
}

export function TitleWatch() {
  const [awake, wake] = useWake(IDLE_MS);
  const [fullscreen, toggleFullscreen] = useFullscreen();
  const mini = useMiniPlayer((state) => state.on);
  const account = useUi((state) => state.account);
  const countdown = useTitlePlayer((state) => state.countdown);
  const now = useTitlePlayer((state) => state.now);
  const phase = useTitlePlayer((state) => state.phase);
  const next = useTitlePlayer((state) => state.next);
  const continued = useTitlePlayer((state) => state.continued);
  const subtitleNote = useSubtitleNote();
  const failure = phase.kind === "failed" ? phase : null;
  const closed = useClosed(failure);
  const [menu, setMenu] = useState<TitleMenu>(null);
  // The title plays on a receiver on the network, or did until its connection broke.
  const remote = useTitlePlayer((state) => state.shows !== null);
  useTitleSession();

  // What happens to the title when a receiver lets go of it depends on whether it is on screen.
  useEffect(() => {
    titlePlayer.setShown(true);
    return () => titlePlayer.setShown(false);
  }, []);

  // The mini player is a small picture, and a receiver leaves none here.
  useEffect(() => {
    if (remote && miniPlayer.on()) void miniPlayer.leave();
  }, [remote]);

  // When nothing the chosen subtitles have covers the position, where a changed speed shows:
  // loading for as long as it lasts, and that they can't be had for a few seconds. Text that
  // shows is never called either. The picture plays either way.
  useEffect(() => {
    flashNote(
      subtitleNote === "loading"
        ? t("Subtitles loading")
        : subtitleNote === "unavailable"
          ? t("Subtitles unavailable")
          : null,
      subtitleNote === "unavailable",
    );
    const timer =
      subtitleNote === "unavailable"
        ? setTimeout(() => flashNote(null), SUBTITLES_UNAVAILABLE_MS)
        : undefined;
    return () => {
      clearTimeout(timer);
      flashNote(null);
    };
  }, [subtitleNote]);

  // Nothing open any more, as after a live channel took over: back to the page.
  useEffect(() => {
    if (!now) useUi.setState({ playingTitle: false });
  }, [now]);

  // The key handler reads the latest render through a ref; see WatchScreen.
  const latest = useRef({ menu, toggleFullscreen, wake });
  latest.current = { menu, toggleFullscreen, wake };
  useEffect(() => {
    // Ends with this view, or with the account it shows, and with it an O that still waits for
    // the window and the system's list asked for from here.
    const view = new AbortController();
    outputs.viewShown(view.signal);
    function onKey(event: KeyboardEvent) {
      const ui = useUi.getState();
      if (event.defaultPrevented || isTyping(event) || hasModifier(event) || event.isComposing)
        return;
      if (ui.searchOpen || ui.settings || ui.updateDialog || !ui.playingTitle) return;
      const current = latest.current;
      current.wake();
      // The menu's own keys: Escape closes it, and focus goes back to its button. A message's
      // cross takes Enter and Space, so Space closes it rather than playing the title again, and
      // so does the bar's word on the downloads, which opens Downloads.
      if (current.menu || pressesClose(event) || pressesDownloads(event)) return;
      switch (event.key) {
        case " ":
        case "k":
          titlePlayer.togglePause();
          break;
        case "ArrowLeft":
          titlePlayer.skip(-SKIP_S);
          break;
        case "ArrowRight":
          titlePlayer.skip(SKIP_S);
          break;
        case "ArrowUp":
        case "ArrowDown":
          if (!player.nudgeVolume(event.key === "ArrowUp" ? 0.05 : -0.05)) {
            flash(t("TV remote sets volume"));
          }
          break;
        case "f":
          if (miniPlayer.on()) void miniPlayer.leave(true);
          else current.toggleFullscreen();
          break;
        case "p":
        case "P":
          if (titlePlayer.onReceiver()) flash(t(MINI_NEEDS_PICTURE));
          else void miniPlayer.toggle();
          break;
        case "o":
        case "O":
          // A copy plays here only.
          if (titlePlayer.state().now?.kind === "copy") return;
          void openChooser(() => setMenu("output"), view.signal);
          break;
        case "m":
          if (!player.toggleMute()) flash(t("TV remote sets volume"));
          break;
        case "c":
          titlePlayer.toggleSubtitles();
          break;
        case "n":
          titlePlayer.playNext();
          break;
        case "g":
        case "G":
        case "h":
        case "H":
          if (titlePlayer.onReceiver()) flash(t("Subtitle timing plays here only"));
          else {
            const direction = event.key.toLowerCase() === "g" ? -1 : 1;
            const state = titlePlayer.state();
            if (state.downloadedOn && state.savedSubtitle) {
              const timing = state.savedSubtitle.timing;
              const offset =
                Math.round(
                  Math.max(
                    -600,
                    Math.min(600, timing.offset + direction * (event.shiftKey ? 1 : 0.1)),
                  ) * 10,
                ) / 10;
              void titlePlayer
                .setDownloadedTiming({ ...timing, offset })
                .catch(() => flash(t("Subtitle timing could not be saved")));
              flash(
                t("Subtitle offset {seconds} s", {
                  seconds: `${offset > 0 ? "+" : ""}${formatDecimal(offset, 1)}`,
                }),
              );
            } else nudgeSubtitles(state.subtitle, direction);
          }
          break;
        case "<":
        case ">":
          if (titlePlayer.onReceiver()) flash(t("Speed plays here only"));
          else stepSpeed(event.key === "<" ? -1 : 1);
          break;
        case "Escape":
          if (document.fullscreenElement) void document.exitFullscreen();
          else if (miniPlayer.on()) void miniPlayer.leave();
          else leaveTitle();
          break;
        default:
          return;
      }
      event.preventDefault();
      // Handled here only: the layer underneath, shown again by this key, must not take it too.
      event.stopPropagation();
    }
    // Before tooltips and popovers see the key, which would otherwise keep Escape to themselves.
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      view.abort();
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [account]);

  if (!now) return null;
  const controlsVisible = awake || phase.kind !== "playing" || menu !== null || remote;
  // Keep the end screen while the next episode opens, including an unheld Instant transition.
  const nextUp =
    now.kind === "provider" &&
    now.series &&
    ((phase.kind === "ended" && next !== undefined) ||
      (continued &&
        (phase.kind === "opening" || phase.kind === "starting" || (failure && !closed))))
      ? now.series
      : null;
  if (mini) {
    return (
      <div
        data-view="title"
        tabIndex={-1}
        data-mini=""
        data-controls={controlsVisible ? "" : undefined}
        onMouseMove={wake}
        className={cn(
          "fixed inset-0 z-30 overflow-hidden bg-black outline-none",
          !controlsVisible && "cursor-none",
        )}
      >
        <Picture
          active
          fit="contain"
          className="absolute inset-0"
          onClick={() => titlePlayer.togglePause()}
          onDoubleClick={() => void miniPlayer.leave()}
        />
        <MiniControls
          visible={controlsVisible}
          status={miniStatus(phase, countdown)}
          failure={failure}
          onClose={leaveTitle}
        >
          <Button
            variant="media"
            size="icon-sm"
            aria-label={t("Back 10 seconds")}
            onClick={() => titlePlayer.skip(-SKIP_S)}
          >
            <RotateCcw />
          </Button>
          <PlayPause size="icon-sm" />
          <Button
            variant="media"
            size="icon-sm"
            aria-label={t("Forward 10 seconds")}
            onClick={() => titlePlayer.skip(SKIP_S)}
          >
            <RotateCw />
          </Button>
        </MiniControls>
        <Flash />
      </div>
    );
  }
  return (
    <div
      data-view="title"
      tabIndex={-1}
      data-controls={controlsVisible ? "" : undefined}
      onMouseMove={wake}
      className={cn(
        "fixed inset-0 z-30 overflow-hidden bg-black outline-none",
        !controlsVisible && "cursor-none",
      )}
    >
      {/* In a window the picture starts below the bar, so the bar never draws on it. */}
      <Picture
        active
        fit="contain"
        className="absolute inset-x-0 bottom-0"
        style={{ top: fullscreen ? 0 : WINDOW_BAR.height }}
        onClick={() => titlePlayer.togglePause()}
        onDoubleClick={toggleFullscreen}
      />
      {!fullscreen && (
        <div
          className={cn(
            "absolute inset-x-0 top-0 z-30 transition-opacity duration-300",
            controlsVisible ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <WindowBar onBack={leaveTitle} />
        </div>
      )}
      {nextUp ? (
        <NextUp series={nextUp} />
      ) : (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <State />
        </div>
      )}
      {!nextUp && (
        <div
          className={cn(
            "no-drag absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-10 pt-28 pb-7 transition-opacity duration-300",
            controlsVisible ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <div className="mb-3 min-w-0">
            <div className="truncate text-2xl font-semibold tracking-tight">{now.name}</div>
            {now.detail && <div className="truncate text-sm text-foreground/85">{now.detail}</div>}
          </div>
          <Scrubber />
          <div className="mt-3 flex items-center gap-2">
            <Tooltip label={t("Back 10 seconds")}>
              <Button
                variant="media"
                size="icon"
                aria-label={t("Back 10 seconds")}
                onClick={() => titlePlayer.skip(-SKIP_S)}
              >
                <RotateCcw />
              </Button>
            </Tooltip>
            <PlayPause />
            <Tooltip label={t("Forward 10 seconds")}>
              <Button
                variant="media"
                size="icon"
                aria-label={t("Forward 10 seconds")}
                onClick={() => titlePlayer.skip(SKIP_S)}
              >
                <RotateCw />
              </Button>
            </Tooltip>
            <div className="ml-auto flex items-center gap-2">
              <Tracks menu={menu} onMenu={setMenu} />
              {next && (
                <Button variant="media" onClick={() => titlePlayer.playNext()}>
                  <SkipForward />
                  {t("Next episode")}
                </Button>
              )}
              <VolumeControl />
              {now.kind === "provider" && (
                <OutputButton
                  open={menu === "output"}
                  onOpenChange={(open) => setMenu(open ? "output" : null)}
                />
              )}
              <MiniPlayerButton />
              <Tooltip label={fullscreen ? t("Exit full screen") : t("Full screen")}>
                <Button
                  variant="media"
                  size="icon"
                  aria-label={t("Full screen")}
                  onClick={toggleFullscreen}
                >
                  {fullscreen ? <Minimize /> : <Maximize />}
                </Button>
              </Tooltip>
            </div>
          </div>
        </div>
      )}
      <Flash />
      <ConnectingNote />
    </div>
  );
}

/** Plays and pauses; Play tries a failed title again. */
function PlayPause({ size = "icon" }: { size?: "icon" | "icon-sm" }) {
  const phase = useTitlePlayer((state) => state.phase);
  const paused = phase.kind !== "playing";
  const label = phase.kind === "ended" ? t("Play again") : paused ? t("Play") : t("Pause");
  return (
    <Tooltip label={label}>
      <Button
        data-retry={phase.kind === "failed" ? "" : undefined}
        variant="primary"
        size={size}
        aria-label={label}
        onClick={() => titlePlayer.togglePause()}
      >
        {paused ? (
          <Play className="size-4 translate-x-px fill-current" />
        ) : (
          <Pause className="fill-current" />
        )}
      </Button>
    </Tooltip>
  );
}

/**
 * Where the title is, where it can go, and how long is left. Seeks when let go, and the keys are
 * the player's again: see `SliderControl`.
 */
function Scrubber() {
  const position = useTitlePlayer((state) => state.position);
  const duration = useTitlePlayer((state) => state.duration);
  // On a receiver, after a skip: where it last said it was, until it has caught up.
  const confirmed = useTitlePlayer((state) => state.confirmed);
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? position;
  if (!duration) {
    return <div className="text-sm text-muted-foreground">{clock(position)}</div>;
  }
  return (
    <div className="flex items-center gap-4 text-[0.8125rem] tabular-nums">
      <span className="w-14 text-right">{clock(shown)}</span>
      <SliderPrimitive.Root
        value={shown}
        min={0}
        max={duration}
        step={1}
        onValueChange={(next) => setDragging(Array.isArray(next) ? (next[0] ?? 0) : next)}
        onValueCommitted={(next) => {
          titlePlayer.seek(Array.isArray(next) ? (next[0] ?? 0) : next);
          setDragging(null);
        }}
        className="flex-1"
      >
        <SliderControl className="flex h-6 w-full touch-none items-center">
          <SliderPrimitive.Track className="relative h-1 w-full rounded-full bg-white/25">
            <SliderPrimitive.Indicator className="rounded-full bg-white" />
            {confirmed !== null && (
              <span
                aria-hidden
                className="absolute top-1/2 size-3 -translate-1/2 rounded-full ring-2 ring-white/70"
                style={{ left: `${(Math.min(confirmed, duration) / duration) * 100}%` }}
              />
            )}
            <SliderPrimitive.Thumb
              aria-label={t("Position")}
              className="size-3.5 rounded-full bg-white shadow-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </SliderPrimitive.Track>
        </SliderControl>
      </SliderPrimitive.Root>
      <span className="w-16 text-muted-foreground">-{clock(duration - shown)}</span>
    </div>
  );
}

/** The file's sound and subtitle tracks, to choose from while playing. */
function Tracks({ menu, onMenu }: { menu: TitleMenu; onMenu: (menu: TitleMenu) => void }) {
  const audio = useTitlePlayer((state) => state.audio);
  const subtitles = useTitlePlayer((state) => state.subtitles);
  const audioId = useTitlePlayer((state) => state.audioId);
  const subtitle = useTitlePlayer((state) => state.subtitle);
  const subtitleNote = useSubtitleNote();
  const speed = useTitlePlayer((state) => state.speed);
  const shows = useTitlePlayer((state) => state.shows);
  const downloadedOn = useTitlePlayer((state) => state.downloadedOn);
  return (
    <>
      {shows === null && (
        <>
          <Tooltip label={downloadedOn || subtitle ? t("Subtitles on") : t("Subtitles")}>
            <Button
              variant="media"
              size="icon"
              aria-label={t("Subtitles")}
              aria-pressed={downloadedOn || subtitle !== null}
              aria-expanded={menu === "subtitles"}
              onClick={() => onMenu(menu === "subtitles" ? null : "subtitles")}
            >
              <Captions />
            </Button>
          </Tooltip>
          <SubtitlePanel open={menu === "subtitles"} onClose={() => onMenu(null)} />
        </>
      )}
      <TrackMenus
        showSubtitles={shows !== null}
        audio={audio}
        audioId={audioId}
        subtitles={subtitles}
        subtitle={subtitle}
        shows={shows}
        hereOnly={t("Picture subtitles, teletext and captions play on this computer only.")}
        subtitleNote={subtitleChoiceNote(subtitleNote)}
        open={menu === "speed" ? null : menu}
        onOpenChange={onMenu}
        onAudio={(id) => titlePlayer.setAudio(id)}
        onSubtitle={(track) => titlePlayer.setSubtitle(track)}
      />
      <SpeedMenu
        speed={speed}
        hereOnly={shows !== null}
        open={menu === "speed"}
        onSpeed={(next) => titlePlayer.setSpeed(next)}
        onOpenChange={(next) => onMenu(next ? "speed" : null)}
      />
    </>
  );
}

/** What the picture area says without a picture: starting, reconnecting, failed or finished. */
function State() {
  const phase = useTitlePlayer((state) => state.phase);
  const now = useTitlePlayer((state) => state.now);
  const next = useTitlePlayer((state) => state.next);
  const position = useTitlePlayer((state) => state.position);
  const skipping = useTitlePlayer((state) => state.confirmed !== null);
  const remote = useTitlePlayer((state) => state.shows !== null);
  const output = useOutput((state) => state.status.output);
  const closed = useClosed(phase.kind === "failed" ? phase : null);
  // On a receiver there is never a picture here: this says what it does and where.
  const receiver =
    remote && (output.kind === "receiver" || output.kind === "lost") ? output.receiver : null;
  // Closed: nothing in its place, not even what a receiver said before the failure.
  if (!now || closed) return null;
  if (receiver && phase.kind !== "ended" && phase.kind !== "reconnecting") {
    const on = where(receiver);
    if (phase.kind === "failed") {
      const { problem } = phase;
      const failed =
        problem.kind === "receiver"
          ? receiverProblem(
              problem.failure,
              problem.lost,
              receiver,
              t("{title} stopped at {position}.", { title: now.name, position: clock(position) }),
            )
          : null;
      return (
        <Stated
          title={failed?.title ?? problemTitle(problem)}
          body={failed?.body ?? problemBody(problem)}
          failure={phase}
        >
          {(failed?.retry ?? true) && (
            <Button variant="primary" onClick={() => titlePlayer.retry()}>
              <RotateCw />
              {t("Try again")}
            </Button>
          )}
          <PlayHere />
        </Stated>
      );
    }
    return (
      <Stated
        line={
          <ReceiverLine receiver={receiver}>
            {phase.kind === "playing"
              ? t("Playing {where}", { where: on })
              : phase.kind === "paused"
                ? t("Paused {where}", { where: on })
                : skipping
                  ? t("Buffering {where}", { where: on })
                  : t("Loading {where}", { where: on })}
          </ReceiverLine>
        }
        body={
          skipping && phase.kind === "starting"
            ? t("Seeking to {position}", { position: clock(position) })
            : null
        }
      >
        <PlayHere />
      </Stated>
    );
  }
  if (phase.kind === "playing" || phase.kind === "paused") return null;
  let body: ReactNode = null;
  let actions: ReactNode = null;
  let title = now.name;
  switch (phase.kind) {
    case "opening":
    case "starting":
    case "idle":
      body = now.detail;
      break;
    case "reconnecting":
      title = t("Connection lost");
      body = t("Trying again, attempt {attempt} of {of}.", {
        attempt: phase.attempt,
        of: phase.of,
      });
      break;
    case "ended":
      title = t("Finished");
      body = now.detail;
      actions = (
        <>
          <Button variant="primary" onClick={() => titlePlayer.seek(0)}>
            <Play className="fill-current" />
            {t("Play again")}
          </Button>
          <Button variant="secondary" onClick={leaveTitle}>
            {t("Back")}
          </Button>
          {receiver && <PlayHere />}
        </>
      );
      break;
    case "failed":
      // A copy's file that went from the app's folder.
      if (now.kind === "copy" && phase.problem.kind === "unavailable") {
        title = t("Download missing");
        body = t("Its file is no longer on this computer.");
      } else {
        title = problemTitle(phase.problem);
        body = problemBody(phase.problem);
      }
      actions = (
        <>
          <Button variant="primary" onClick={() => titlePlayer.retry()}>
            <RotateCw />
            {t("Retry")}
          </Button>
          {next && (
            <Button variant="secondary" onClick={() => titlePlayer.playNext()}>
              <SkipForward />
              {t("Next episode")}
            </Button>
          )}
        </>
      );
      break;
  }
  return (
    <Stated title={title} body={body} failure={phase.kind === "failed" ? phase : undefined}>
      {actions}
      {receiver && phase.kind === "reconnecting" && <PlayHere />}
    </Stated>
  );
}

/**
 * What stands where the picture would be: a receiver's line or a title, a body, and actions. A
 * failure's closes.
 */
function Stated({
  line,
  title,
  body,
  failure,
  children,
}: {
  line?: ReactNode;
  title?: string;
  body?: ReactNode;
  failure?: object | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="pointer-events-auto relative flex max-w-[34rem] flex-col items-center px-12 text-center">
      {line}
      {title && <h2 className="text-3xl font-semibold tracking-tight text-balance">{title}</h2>}
      {body && <p className="mt-3 text-[0.9375rem] text-muted-foreground">{body}</p>}
      {children && <div className="mt-7 flex items-center gap-3">{children}</div>}
      {failure && <CloseMessage failure={failure} />}
    </div>
  );
}

/**
 * What the mini player says when there's no picture, in a few words, the countdown to the next
 * episode included; null while it plays.
 */
function miniStatus(phase: TitlePlayerState["phase"], countdown: number | null): string | null {
  switch (phase.kind) {
    case "reconnecting":
      return t("Connection lost");
    case "failed":
      return problemTitle(phase.problem);
    case "ended":
      return countdown === null
        ? t("Finished")
        : countdown === 0
          ? t("Next episode")
          : t("Next episode plays in {seconds}", { seconds: countdown });
    default:
      return null;
  }
}

function problemTitle(problem: TitleProblem): string {
  switch (problem.kind) {
    case "unavailable":
      return t("Not available");
    case "refused":
      return t("Refused by the provider");
    case "unsupported":
      return t("Can't play this title");
    case "network":
      return t("Couldn't reconnect");
    case "provider-error":
      return t("Provider error");
    case "app":
      return t("Can't open this title");
    case "receiver":
      return receiverProblem(problem.failure, problem.lost, outputs.receiver(), null).title;
  }
}

/** Why it doesn't play, of a "title" or an "episode". */
function problemBody(problem: TitleProblem, what: "title" | "episode" = "title"): string {
  switch (problem.kind) {
    case "unavailable":
      return what === "episode"
        ? t("The provider has no file for this episode right now.")
        : t("The provider has no file for this title right now.");
    case "refused":
      return t("Another device may be using your connection.");
    case "unsupported":
      return problem.detail;
    case "network":
      return `${t("The connection stopped and trying again didn't help.")} ${problem.detail}`;
    case "provider-error":
      return t("The provider answered with HTTP {status}.", { status: String(problem.status) });
    case "app":
      return describeError(problem.error);
    case "receiver":
      return receiverProblem(problem.failure, problem.lost, outputs.receiver(), null).body;
  }
}

/**
 * An episode's end, in the controls' place: the countdown to the next episode, that episode on
 * offer once the countdown is cancelled or turned off, the series' last episode, or a next
 * episode that didn't start. The countdown's number changes once a second; nothing else moves.
 */
function NextUp({ series }: { series: SeriesDetails }) {
  const now = useTitlePlayer((state) => state.now);
  const phase = useTitlePlayer((state) => state.phase);
  const next = useTitlePlayer((state) => state.next);
  const countdown = useTitlePlayer((state) => state.countdown);
  const remote = useTitlePlayer((state) => state.shows !== null);
  const output = useOutput((state) => state.status.output);
  // On a receiver, where the next one plays, and the way back.
  const receiver =
    remote && (output.kind === "receiver" || output.kind === "lost") ? output.receiver : null;
  if (now?.kind !== "provider" || now.title.kind !== "episode") return null;
  if (phase.kind === "opening" || phase.kind === "starting") {
    return (
      <EndOfEpisode
        artworkUrl={now.artworkUrl}
        line={t("Next episode")}
        title={now.detail ?? now.name}
        detail={t("Starting")}
      >
        <Button variant="secondary" size="lg" onClick={() => toEpisodes(series)}>
          {t("Episodes")}
        </Button>
      </EndOfEpisode>
    );
  }
  if (phase.kind === "failed") {
    return (
      <EndOfEpisode
        artworkUrl={now.artworkUrl}
        line={now.detail}
        title={t("Didn't start")}
        detail={problemBody(phase.problem, "episode")}
        failure={phase}
      >
        <Button variant="primary" size="lg" onClick={() => titlePlayer.retry()}>
          <RotateCw />
          {t("Try again")}
        </Button>
        <Button variant="secondary" size="lg" onClick={() => toEpisodes(series)}>
          {t("Episodes")}
        </Button>
      </EndOfEpisode>
    );
  }
  const finished = t("Finished {episode}", {
    episode: episodeLabel(now.title.season, now.title.episode),
  });
  if (!next) {
    // None left to watch after it: the series' last episode, or the later ones are watched.
    const last = nextEpisode(series, now.title) === null;
    return (
      <EndOfEpisode
        artworkUrl={now.artworkUrl}
        line={finished}
        title={last ? t("That was the last episode") : t("The rest is watched")}
        detail={
          last
            ? t("{title} is finished for now.", { title: now.name })
            : t("Every later episode is watched.")
        }
      >
        <Button variant="secondary" size="lg" onClick={() => toEpisodes(series)}>
          {t("Episodes")}
        </Button>
        <Button variant="ghost" size="lg" onClick={leaveTitle}>
          {t("Back")}
        </Button>
      </EndOfEpisode>
    );
  }
  const length = next.duration ? runtime(next.duration) : null;
  return (
    <EndOfEpisode
      artworkUrl={next.stillUrl ?? series.backdropUrl}
      line={
        next.season === now.title.season
          ? finished
          : `${finished} · ${t("Season {number} is next", { number: String(next.season) })}`
      }
      title={`${episodeLabel(next.season, next.number)} · ${next.title}`}
      detail={
        countdown === null ? (
          length
        ) : (
          <>
            {length && `${length} · `}
            <span className="text-foreground">
              {countdown === 0
                ? t("Next episode")
                : receiver
                  ? t("Plays in {seconds} {where}", { seconds: countdown, where: where(receiver) })
                  : t("Plays in {seconds}", { seconds: countdown })}
            </span>
          </>
        )
      }
    >
      <Button variant="primary" size="lg" onClick={() => titlePlayer.playNext()}>
        <Play className="fill-current" />
        {countdown === null || countdown === 0 ? t("Next episode") : t("Play now")}
      </Button>
      {countdown === null ? (
        <Button variant="secondary" size="lg" onClick={() => toEpisodes(series)}>
          {t("Episodes")}
        </Button>
      ) : (
        <Button variant="secondary" size="lg" onClick={() => titlePlayer.cancelNext()}>
          {t("Cancel")}
        </Button>
      )}
      {receiver && <PlayHere size="lg" />}
    </EndOfEpisode>
  );
}

/**
 * Next Up's layout: a dimmed still, and along the bottom a line, a title, a detail and actions. It
 * covers the picture and the subtitles on it, whose layer is above the controls (see styles.css).
 */
function EndOfEpisode({
  artworkUrl,
  line,
  title,
  detail,
  failure,
  children,
}: {
  artworkUrl: string | null;
  line: ReactNode;
  title: string;
  detail: ReactNode;
  /** A next episode that didn't start, whose message the viewer can close. */
  failure?: object;
  children: ReactNode;
}) {
  return (
    <div className="absolute inset-0 z-20">
      <div className="absolute inset-0 opacity-35">
        <Artwork url={artworkUrl} name={title} size="full" plain />
      </div>
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-black/20" />
      <div className={cn("absolute bottom-16 left-10 max-w-[44rem]", failure && "pr-12")}>
        <div className="text-[0.9375rem] text-muted-foreground">{line}</div>
        <div className="mt-1 text-4xl font-semibold tracking-tight text-balance">{title}</div>
        {detail && <div className="mt-2 text-[0.9375rem] text-muted-foreground">{detail}</div>}
        <div className="mt-7 flex gap-3">{children}</div>
        {failure && <CloseMessage failure={failure} />}
      </div>
    </div>
  );
}
