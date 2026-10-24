// The sound and subtitle controls of Watch and a playing title. Live TV puts Sound in More.
// Sound lists the stream's sound tracks. CC shows at a glance whether subtitles are on, and lists
// Off and every subtitle track, then their timing and look; C turns the last choice on and off.
// A title playing here opens its CC panel instead (SubtitlePanel.tsx), which has the same and
// online search.
import { Popover } from "@base-ui/react/popover";
import { AudioLines, Captions } from "lucide-react";
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import type { AudioTrack, SubtitleFormat, SubtitleTrack } from "@mrstreamer/contracts/playback";
import { t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { menuSurface } from "../../components/ui/menu.ts";
import { Tooltip } from "../../components/ui/tooltip.tsx";
import { cn } from "../../lib/utils.ts";
import { SubtitleSettingRows } from "./SubtitleSettings.tsx";

/** Which menu is open over the controls, so Escape closes it before anything else. */
export type TrackMenu = "sound" | "subtitles" | "quality" | "output" | null;

export function TrackMenus({
  audio,
  audioId,
  subtitles,
  subtitle,
  subtitleNote = null,
  shows = null,
  hereOnly = null,
  showSound = true,
  showSubtitles = true,
  open,
  onOpenChange,
  onAudio,
  onSubtitle,
}: {
  audio: readonly AudioTrack[];
  /** The sound track playing; null when the stream's own plays. */
  audioId: number | null;
  subtitles: readonly SubtitleTrack[];
  subtitle: SubtitleTrack | null;
  /** What to say beside the chosen subtitle track, such as that it is still loading. */
  subtitleNote?: string | null;
  /**
   * While a receiver on the network plays: the kinds of subtitles it shows. The others stay
   * listed, marked as playing here only. Null while it plays here, which shows them all.
   */
  shows?: readonly SubtitleFormat[] | null;
  /** Why some subtitles play here only, said at the foot of their menu. */
  hereOnly?: string | null;
  /** Live TV puts Sound in More; titles keep its button here. */
  showSound?: boolean;
  showSubtitles?: boolean;
  open: TrackMenu;
  onOpenChange: (open: TrackMenu) => void;
  onAudio: (id: number) => void;
  onSubtitle: (track: SubtitleTrack | null) => void;
}) {
  return (
    <>
      {showSound && audio.length > 1 && (
        <Menu
          label={t("Sound")}
          open={open === "sound"}
          onOpenChange={(next) => onOpenChange(next ? "sound" : null)}
          trigger={<AudioLines />}
        >
          <SoundChoices
            audio={audio}
            audioId={audioId}
            onAudio={onAudio}
            onDone={() => onOpenChange(null)}
          />
        </Menu>
      )}
      {showSubtitles && subtitles.length > 0 && (
        <Menu
          label={subtitle ? t("Subtitles on") : t("Subtitles")}
          on={subtitle !== null}
          open={open === "subtitles"}
          onOpenChange={(next) => onOpenChange(next ? "subtitles" : null)}
          trigger={<Captions />}
        >
          <Choice
            chosen={subtitle === null}
            onChoose={() => {
              onSubtitle(null);
              onOpenChange(null);
            }}
          >
            {t("Off")}
          </Choice>
          {subtitles.map((track) => {
            const chosen = track.id === subtitle?.id && track.page === subtitle.page;
            const elsewhere = shows !== null && !shows.includes(track.format);
            return (
              <Choice
                key={`${track.id}:${track.page}`}
                chosen={chosen}
                disabled={elsewhere}
                note={elsewhere ? t("Here only") : chosen ? subtitleNote : null}
                onChoose={() => {
                  onSubtitle(track);
                  onOpenChange(null);
                }}
              >
                {track.label}
              </Choice>
            );
          })}
          {shows !== null && subtitles.some((track) => !shows.includes(track.format)) && (
            <MenuNote>{hereOnly}</MenuNote>
          )}
          {shows === null ? (
            <SubtitleSettingRows subtitles={subtitles} subtitle={subtitle} />
          ) : (
            // A receiver plays: these settings are this computer's, listed and not set.
            <>
              <div role="separator" className="my-1 border-t border-white/12" />
              <Choice chosen={false} disabled onChoose={() => {}}>
                {t("Subtitle timing")}
              </Choice>
              <Choice chosen={false} disabled onChoose={() => {}}>
                {t("Subtitle look")}
              </Choice>
              <MenuNote>{t("The subtitle settings apply on this computer only.")}</MenuNote>
            </>
          )}
        </Menu>
      )}
    </>
  );
}

/** Sound choices shared by the title button and Live TV's More page. */
export function SoundChoices({
  audio,
  audioId,
  onAudio,
  onDone,
}: {
  audio: readonly AudioTrack[];
  audioId: number | null;
  onAudio: (id: number) => void;
  onDone: () => void;
}) {
  const playing = audioId ?? audio.find((track) => track.default)?.id ?? audio[0]?.id;
  return audio.map((track) => (
    <Choice
      key={track.id}
      chosen={track.id === playing}
      onChoose={() => {
        onAudio(track.id);
        onDone();
      }}
    >
      {track.label}
    </Choice>
  ));
}

/**
 * A menu over the player's controls, opened by a button. While it's open a click elsewhere only
 * closes it, so the same click can't also pause, skip or change channel. Opened by the keyboard,
 * it starts on the item chosen, by the pointer on none; Up and Down move between items
 * (`data-item`), Home and End to the first and last.
 */
export function Menu({
  label,
  on = false,
  text = false,
  focusChosen = false,
  description,
  onKeyDown,
  open,
  onOpenChange,
  trigger,
  children,
}: {
  label: string;
  on?: boolean;
  /** The button holds words rather than an icon. */
  text?: boolean;
  /** A page opened by a shortcut has no keyboard press on its trigger. */
  focusChosen?: boolean;
  description?: string | undefined;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  children: ReactNode;
}) {
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange} modal>
      <Tooltip label={label}>
        <Popover.Trigger
          render={
            <Button
              variant={on ? "primary" : "media"}
              size={text ? "default" : "icon"}
              aria-label={label}
              aria-description={description}
              aria-pressed={on}
              className={cn(text && "px-3.5 font-semibold")}
            />
          }
        >
          {trigger}
        </Popover.Trigger>
      </Tooltip>
      {/* Over Watch, so the backdrop that takes clicks outside the menu covers the controls too. */}
      <Popover.Portal className="relative z-[60]">
        <Popover.Positioner side="top" align="end" sideOffset={10} className="z-[60]">
          {/* Focus goes back to the button only for the keyboard: a pointer pick would open
              its tooltip, which stays after the controls hide. */}
          <Popover.Popup
            ref={popup}
            aria-label={label}
            initialFocus={(openType) =>
              ((openType === "keyboard" || focusChosen) &&
                popup.current &&
                chosenItem(popup.current)) ||
              popup.current
            }
            finalFocus={(closeType) => closeType === "keyboard"}
            onKeyDown={(event) => {
              onKeyDown?.(event);
              if (!event.defaultPrevented) moveFocus(event);
            }}
            className={cn(
              menuSurface,
              "max-h-[60vh] w-[18rem] overflow-y-auto text-[0.9375rem] transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
            )}
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The usable choice a menu opens on: the selected row, else its first non-Back row. */
function chosenItem(popup: HTMLElement): HTMLElement | null {
  return (
    popup.querySelector<HTMLElement>("[data-item][aria-pressed=true]:not(:disabled)") ??
    popup.querySelector<HTMLElement>("[data-item]:not(:disabled):not([data-live-back])")
  );
}

/**
 * Live and title menus share arrow navigation, and so does the title's CC panel. Initial Down
 * selects the current usable choice.
 */
export function moveFocus(event: KeyboardEvent<HTMLElement>): void {
  if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select"))
    return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>("[data-item]:not(:disabled)"),
  ];
  const at = items.findIndex((item) => item === document.activeElement);
  const target =
    event.key === "ArrowDown"
      ? at < 0
        ? (chosenItem(event.currentTarget) ?? items[0])
        : (items[at + 1] ?? items[0])
      : event.key === "ArrowUp"
        ? (items[at - 1] ?? items.at(-1))
        : event.key === "Home"
          ? items[0]
          : event.key === "End"
            ? items.at(-1)
            : undefined;
  if (!target) return;
  event.preventDefault();
  target.focus();
}

/** A line of small text at the foot of a menu, saying what its rows can't. */
export function MenuNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="px-2 pt-1.5 pb-1 text-[0.8125rem] leading-snug text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * One of a menu's choices, marked when chosen, with a word at its end when there is one to say.
 * A `disabled` one stays listed, dimmed, and can't be chosen.
 */
export function Choice({
  chosen,
  disabled = false,
  note = null,
  onChoose,
  children,
}: {
  chosen: boolean;
  disabled?: boolean;
  note?: string | null;
  onChoose: () => void;
  children: ReactNode;
}) {
  return (
    <button
      data-item
      aria-pressed={chosen}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onChoose}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:bg-white/10 disabled:opacity-40",
        chosen ? "text-white" : "text-foreground/80 enabled:hover:bg-white/6",
      )}
    >
      <span className={cn("size-1.5 flex-none rounded-full", chosen && "bg-white")} />
      <span className="min-w-0">{children}</span>
      {note && (
        <span className="ml-auto flex-none text-[0.8125rem] text-muted-foreground">{note}</span>
      )}
    </button>
  );
}
