// CC, while a title plays here: every subtitle control in one panel. The file's tracks and the
// saved download, their timing and look, then online search and its results. The picture keeps
// playing and the panel stays open while the viewer compares results and steps the timing. The
// chosen track says Loading or Unavailable as the note over the picture does (`useSubtitleNote`).
//   Up and Down walk its rows, Tab reaches its fields, Escape closes it from anywhere.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { SubtitleServiceFailure } from "@mrstreamer/contracts/online-subtitles";
import { TITLE_LANGUAGES } from "@mrstreamer/core/ondemand/languages";
import { regionalLanguageName } from "@mrstreamer/core/ondemand/tracks";
import { type PlainKey, t } from "@mrstreamer/core/i18n";
import { openOnlineSubtitleSettings, useUi } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { NativeSelect } from "../../components/ui/select.tsx";
import { comingTime } from "../../lib/format.ts";
import { onlineSubtitles, useOnlineSubtitles } from "../../player/online-subtitles.ts";
import { titlePlayer, useSubtitleNote, useTitlePlayer } from "../../player/title-player.ts";
import { subtitleSettingsQuery } from "../settings/OnlineSubtitlesSection.tsx";
import { LookRows, subtitleSettingsFor, TextButton } from "../watch/SubtitleSettings.tsx";
import { Choice, moveFocus } from "../watch/TrackMenus.tsx";
import { PanelSection } from "./PanelSection.tsx";
import { SubtitleTimingSection } from "./SubtitleTimingControls.tsx";

const failureText = {
  "not-configured": "Set up in Settings",
  credentials: "Check your account in Settings",
  quota: "Service allowance reached",
  unavailable: "Service unavailable",
  unsupported: "Unsupported subtitle",
} as const satisfies Record<SubtitleServiceFailure, PlainKey>;
/** When the service's allowance starts again, as it said: a time in the interface's own words. */
function resetTime(said: string): string {
  const at = Date.parse(said);
  return Number.isNaN(at) ? said : comingTime(at, Date.now());
}
/** The word beside the chosen track for what `useSubtitleNote` says. */
export function subtitleChoiceNote(note: ReturnType<typeof useSubtitleNote>): string | null {
  return note === "loading" ? t("Loading") : note === "unavailable" ? t("Unavailable") : null;
}

export function SubtitlePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sessionId = useTitlePlayer((state) => state.subtitleSessionId);
  const subtitle = useTitlePlayer((state) => state.subtitle);
  const tracks = useTitlePlayer((state) => state.subtitles);
  const saved = useTitlePlayer((state) => state.savedSubtitle);
  const downloadedOn = useTitlePlayer((state) => state.downloadedOn);
  const note = subtitleChoiceNote(useSubtitleNote());
  // A downloaded copy plays offline: what was saved for it is all there is, with no search.
  const offline = useTitlePlayer((state) => state.now?.kind === "copy");
  const search = useOnlineSubtitles((state) => state);
  const settings = useQuery({ ...subtitleSettingsQuery, enabled: open && !offline });
  const root = useRef<HTMLElement>(null);
  const [language, setLanguage] = useState("saved");
  const [forgetError, setForgetError] = useState(false);
  useEffect(() => {
    onlineSubtitles.bind(sessionId);
    return () => onlineSubtitles.bind(null);
  }, [sessionId]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    root.current?.querySelector<HTMLElement>("[aria-pressed=true]")?.focus();
    return () => {
      onlineSubtitles.dismissPending();
      // Settings opened from here covers the title: focus on a button underneath would show its
      // tooltip, which takes the first Escape from Settings.
      if (useUi.getState().settings) return;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);
  // At the window: a result picked with the pointer goes disabled while it downloads, and focus
  // leaves the panel with it. Settings and search over the title keep their own Escape. One
  // listener for as long as the panel is open: the title's own key handler runs first and can
  // render the view again, and a listener put back in that moment would miss the key.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      const ui = useUi.getState();
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (ui.searchOpen || ui.settings || ui.updateDialog) return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [open]);
  if (!open) return null;
  const downloaded = downloadedOn && saved?.subtitle != null;
  const settingsFor = subtitleSettingsFor(tracks, subtitle, downloaded);
  return (
    <aside
      ref={root}
      aria-label={t("Subtitle choices")}
      className="no-drag fixed top-12 right-0 bottom-0 z-40 w-[25rem] max-w-full overflow-y-auto border-l border-white/20 bg-black p-5 text-white"
      onKeyDown={moveFocus}
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold">{t("Subtitles")}</h2>
        <Button aria-label={t("Close subtitles")} variant="media" size="icon-sm" onClick={onClose}>
          <X />
        </Button>
      </div>
      <Choice chosen={!subtitle && !downloadedOn} onChoose={() => titlePlayer.setSubtitle(null)}>
        {t("Off")}
      </Choice>
      {tracks.map((track) => {
        const chosen = !downloadedOn && subtitle?.id === track.id && subtitle.page === track.page;
        return (
          <Choice
            key={`${track.id}:${track.page}`}
            chosen={chosen}
            note={chosen ? note : null}
            onChoose={() => titlePlayer.setSubtitle(track)}
          >
            {track.label}
          </Choice>
        );
      })}
      {saved?.subtitle && (
        <Choice chosen={downloadedOn} onChoose={() => titlePlayer.showDownloaded()}>
          <span className="block break-words">{saved.subtitle.release || t("Saved subtitle")}</span>
          <span className="block text-xs">
            {regionalLanguageName(saved.subtitle.language)} · {t("Saved for this version")}
          </span>
        </Choice>
      )}
      {saved?.subtitle && (
        <div className="mt-1 pl-4.5">
          <TextButton
            onClick={() => {
              onlineSubtitles.bind(null);
              onlineSubtitles.bind(sessionId);
              setForgetError(false);
              void titlePlayer.forgetDownloaded().catch(() => setForgetError(true));
            }}
          >
            {t("Forget downloaded subtitles")}
          </TextButton>
        </div>
      )}
      {forgetError && (
        <p role="alert" className="mt-2 text-sm">
          {t("Saved subtitles could not be removed.")}
        </p>
      )}
      {settingsFor.timing && <SubtitleTimingSection downloaded={downloaded} />}
      {settingsFor.look && (
        <PanelSection title={t("Look")}>
          <LookRows text={settingsFor.text} />
        </PanelSection>
      )}
      {!offline && (
        <PanelSection
          title={t("Find online")}
          aside={
            <TextButton
              onClick={() => {
                onClose();
                openOnlineSubtitleSettings();
              }}
            >
              {t("Settings")}
            </TextButton>
          }
        >
          {settings.data?.enabled && (
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect
                aria-label={t("Subtitle search language")}
                value={language}
                onChange={(event) => setLanguage(event.currentTarget.value)}
              >
                <option value="saved">{t("Saved languages")}</option>
                {TITLE_LANGUAGES.map(({ code, name }) => (
                  <option key={code} value={code} lang={code}>
                    {name}
                  </option>
                ))}
              </NativeSelect>
              <Button
                data-item
                variant="secondary"
                size="sm"
                disabled={!sessionId || search.pending !== null}
                onClick={() =>
                  void onlineSubtitles.search(language === "saved" ? undefined : [language])
                }
              >
                {search.searched ? t("Search again") : t("Search subtitles")}
              </Button>
              {downloaded && search.results.length > 1 && (
                <Button
                  data-item
                  variant="secondary"
                  size="sm"
                  disabled={search.pending !== null}
                  onClick={() => onlineSubtitles.tryNext()}
                >
                  {t("Try the next result")}
                </Button>
              )}
            </div>
          )}
          {search.pending && (
            <div role="status" className="mt-3 flex items-center gap-3 text-sm">
              <span>{search.pending === "search" ? t("Searching") : t("Downloading")}</span>
              <Button
                data-item
                size="sm"
                variant="secondary"
                onClick={() => onlineSubtitles.dismissPending()}
              >
                {t("Cancel")}
              </Button>
            </div>
          )}
          {search.error && (
            <p role="alert" className="mt-3 text-sm">
              {search.error}
            </p>
          )}
          {search.failures.map(({ service, reason }) => (
            <p key={service} className="mt-3 text-sm">
              {service === "subdl" ? "SubDL" : "OpenSubtitles"}: {t(failureText[reason])}
            </p>
          ))}
          {search.searched && !search.pending && search.results.length === 0 && !search.error && (
            <p className="mt-3 text-sm">
              {t("No subtitles found. Try another language in Settings.")}
            </p>
          )}
          <div className="mt-3">
            {search.results.map((result) => (
              <button
                key={result.id}
                data-item
                aria-pressed={downloadedOn && search.selected === result.id}
                disabled={search.pending !== null || !settings.data?.enabled}
                className="block w-full border-b border-white/10 py-3 text-left outline-none hover:bg-white/8 focus-visible:bg-white/10 disabled:opacity-50"
                onClick={() => void onlineSubtitles.choose(result.id)}
              >
                <span className="block break-words font-mono text-xs">
                  {result.release || t("Untitled release")}
                </span>
                <span className="mt-1 block text-xs">
                  {result.service === "subdl" ? "SubDL" : "OpenSubtitles"} ·{" "}
                  {regionalLanguageName(result.language)}
                  {result.hearingImpaired ? ` · ${t("Hearing impaired")}` : ""}
                  {result.downloads !== null
                    ? ` · ${t("{count} downloads", { count: result.downloads })}`
                    : ""}
                </span>
              </button>
            ))}
          </div>
          {search.quota && (
            <p className="mt-3 text-xs">
              {t("{count} service downloads remain", { count: search.quota.remaining })}
              {search.quota.resetAt
                ? ` · ${t("Resets {when}", { when: resetTime(search.quota.resetAt) })}`
                : ""}
            </p>
          )}
        </PanelSection>
      )}
    </aside>
  );
}
