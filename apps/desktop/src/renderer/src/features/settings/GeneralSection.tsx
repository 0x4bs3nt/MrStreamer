// Settings > General: the app's language, the content preferences, then Updates. The interface
// language changes only the app's own text, at once; titles, sound and subtitles keep their own.
// Live channels start in a quality, Full HD unless chosen otherwise, and channels can keep their
// own. Movies and series show in one language, play their sound in another, or in the language
// they were made in, and show subtitles in a third, only forced ones or none; picking a track in
// the player sets these too.
// TMDB is where names, genres, popularity and streaming services come from. The app has its own
// key; a viewer's own comes first, for when TMDB stops accepting the app's.
import { Checkbox } from "@base-ui/react/checkbox";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useState } from "react";
import { QUALITIES } from "@mrstreamer/contracts/library";
import { LANGUAGE_NAMES, LOCALES, type LanguageChoice } from "@mrstreamer/contracts/language";
import {
  DEFAULT_LIVE_QUALITY,
  ORIGINAL_SOUND,
  type Preferences,
} from "@mrstreamer/contracts/preferences";
import { formatNumber, t } from "@mrstreamer/core/i18n";
import { DEFAULT_TITLE_LANGUAGE, TITLE_LANGUAGES } from "@mrstreamer/core/ondemand/languages";
import { languageName } from "@mrstreamer/core/ondemand/tracks";
import { useUi } from "../../app/ui-store.ts";
import { changeLanguage } from "../../app/language.ts";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { preferenceName } from "../../lib/quality.ts";
import {
  queries,
  updateSubscriptionPreferences,
  useSubscriptionPreferences,
} from "../../lib/queries.ts";
import { UpdatesSection } from "../updates/UpdatesSection.tsx";
import { OnlineSubtitlesSection } from "./OnlineSubtitlesSection.tsx";
import { Row, Section, Select } from "./Rows.tsx";

/** The Subtitles choice for only the subtitles a file marks as forced: no language stored. */
const FORCED = "forced";

/** Changes that alter what the lists show, which are asked for again. */
const LIST_CHANGES = ["titleLanguage", "adultTitles", "tmdbKey"] as const;

export function GeneralSection() {
  const client = useQueryClient();
  // Read afresh each time Settings opens: the players save the languages picked in them without
  // going through this cache.
  const preferences = useQuery({ ...queries.preferences(), refetchOnMount: "always" });
  const update = useMutation({
    mutationFn: (patch: Partial<Preferences>) => call("preferences.update", patch),
    // The sheet of a saved title the provider dropped stays open under Settings, and holds the
    // entry as it was read while titles for adults showed. It closes as the viewer hides them,
    // before anything is waited for, so leaving Settings never shows it again.
    onMutate: (patch) => {
      if (patch.adultTitles === false) useUi.setState({ savedEntry: null });
    },
    onSuccess: async (saved, patch) => {
      client.setQueryData(queries.preferences().queryKey, saved);
      // Saved titles for adults follow the setting first, with nothing waited for before. Reset
      // rather than read again, so one now hidden doesn't stay on from before.
      if ("adultTitles" in patch) await client.resetQueries({ queryKey: ["watchlist"] });
      if (LIST_CHANGES.some((key) => key in patch)) {
        await client.invalidateQueries({ queryKey: ["ondemand"] });
        // The watchlist shows the same titles, under the same names.
        await client.invalidateQueries({ queryKey: ["watchlist"] });
      }
      // Live TV's channels for adults, and their programmes, follow the same setting. Reset
      // rather than read again, for the same reason.
      if ("adultTitles" in patch) {
        await client.resetQueries({ queryKey: ["library"] });
        await client.resetQueries({ queryKey: ["guide"] });
      }
    },
  });
  const language = useQuery(queries.language());
  const changingLanguage = useMutation({
    mutationFn: (choice: LanguageChoice) => changeLanguage(client, choice),
  });
  const titles = preferences.data?.titleLanguage ?? DEFAULT_TITLE_LANGUAGE;
  const audio = preferences.data?.audioLanguage ?? titles;
  const subtitles = preferences.data?.subtitleLanguage ?? FORCED;

  // The streams picked are each subscription's own. Read afresh too: Watch picks them.
  const left = useSubscriptionPreferences("always");
  const picked = [...(left ?? [])].flatMap(([subscriptionId, { channelVariants }]) => {
    const count = Object.keys(channelVariants ?? {}).length;
    return count > 0 ? [{ subscriptionId, count }] : [];
  });
  const ownQualities = picked.reduce((sum, each) => sum + each.count, 0);

  return (
    <>
      <Section title={t("App")}>
        <Row label={t("Interface language")}>
          {language.data && (
            <Select
              wide
              label={t("Interface language")}
              value={language.data.choice}
              options={[
                {
                  value: "system",
                  label: t("System default ({language})", {
                    language: LANGUAGE_NAMES[language.data.system],
                  }),
                },
                ...LOCALES.map((locale) => ({
                  value: locale,
                  label: LANGUAGE_NAMES[locale],
                  lang: locale,
                })),
              ]}
              onChange={(choice) => changingLanguage.mutate(choice)}
            />
          )}
        </Row>
        {changingLanguage.error && (
          <p className="mt-3 text-sm text-destructive">
            {describeError(appError(changingLanguage.error))}
          </p>
        )}
      </Section>
      <Section title={t("Privacy")}>
        <Row label={t("Share basic usage statistics")}>
          <Checkbox.Root
            aria-label={t("Share basic usage statistics")}
            checked={preferences.data?.analyticsEnabled ?? true}
            disabled={!preferences.isSuccess || update.isPending}
            onCheckedChange={(checked) => update.mutate({ analyticsEnabled: checked })}
            className="grid size-4 flex-none place-items-center rounded-[0.25rem] shadow-[inset_0_0_0_1.5px_rgb(255_255_255/45%)] outline-none focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-white data-checked:shadow-none"
          >
            <Checkbox.Indicator>
              <Check className="size-3 text-black" strokeWidth={3} />
            </Checkbox.Indicator>
          </Checkbox.Root>
        </Row>
        <p className="mt-3 text-sm">
          {t(
            "Counts app use, the features you open, whether playback, downloads and update checks work, and how often the window stops unexpectedly. No viewing history or provider details.",
          )}
        </p>
        <a
          href="https://mrstreamer.app/privacy"
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-sm underline underline-offset-4"
        >
          {t("Privacy policy")}
        </a>
        {update.error && update.variables?.analyticsEnabled !== undefined && (
          <p className="mt-3 text-sm text-destructive">{describeError(appError(update.error))}</p>
        )}
      </Section>
      <Section title={t("Live TV")}>
        <Row label={t("Quality")} note={t("Automatic tries the nearest if one fails")}>
          <Select
            label={t("Quality")}
            value={preferences.data?.liveQuality ?? DEFAULT_LIVE_QUALITY}
            options={QUALITIES.map((quality) => ({
              value: quality,
              label: preferenceName(quality),
            }))}
            onChange={(liveQuality) => update.mutate({ liveQuality })}
          />
        </Row>
        {ownQualities > 0 && (
          <Row label={t("Channels with their own quality")} note={formatNumber(ownQualities)}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                for (const { subscriptionId } of picked) {
                  void updateSubscriptionPreferences(client, subscriptionId, {
                    channelVariants: {},
                  }).catch(() => {});
                }
              }}
            >
              {t("Reset")}
            </Button>
          </Row>
        )}
      </Section>
      <Section title={t("Movies and series")}>
        <Row label={t("Titles in")}>
          <Select
            label={t("Titles in")}
            value={titles}
            options={languages(titles)}
            onChange={(titleLanguage) => update.mutate({ titleLanguage })}
          />
        </Row>
        <Row label={t("Audio in")}>
          <Select
            label={t("Audio in")}
            value={audio}
            options={[
              { value: ORIGINAL_SOUND, label: t("Original language") },
              ...languages(audio),
            ]}
            onChange={(audioLanguage) => update.mutate({ audioLanguage })}
          />
        </Row>
        <Row label={t("Subtitles")}>
          <Select
            label={t("Subtitles")}
            value={subtitles}
            options={[
              { value: "off", label: t("Off") },
              { value: FORCED, label: t("Only when forced") },
              ...languages(subtitles),
            ]}
            onChange={(value) =>
              update.mutate({ subtitleLanguage: value === FORCED ? null : value })
            }
          />
        </Row>
        <Row label={t("For adults")} note={t("titles in their own tab, channels only in Live TV")}>
          <Checkbox.Root
            aria-label={t("For adults")}
            checked={preferences.data?.adultTitles ?? false}
            onCheckedChange={(checked) => update.mutate({ adultTitles: checked })}
            className="grid size-4 flex-none place-items-center rounded-[0.25rem] shadow-[inset_0_0_0_1.5px_rgb(255_255_255/45%)] outline-none transition-shadow duration-150 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-white data-checked:shadow-none"
          >
            <Checkbox.Indicator>
              <Check className="size-3 text-black" strokeWidth={3} />
            </Checkbox.Indicator>
          </Checkbox.Root>
        </Row>
        <Row label={t("Next episode")} note={t("plays after a 10 second countdown")}>
          <Checkbox.Root
            aria-label={t("Next episode")}
            checked={preferences.data?.autoplayNext ?? true}
            onCheckedChange={(checked) => update.mutate({ autoplayNext: checked })}
            className="grid size-4 flex-none place-items-center rounded-[0.25rem] shadow-[inset_0_0_0_1.5px_rgb(255_255_255/45%)] outline-none transition-shadow duration-150 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-white data-checked:shadow-none"
          >
            <Checkbox.Indicator>
              <Check className="size-3 text-black" strokeWidth={3} />
            </Checkbox.Indicator>
          </Checkbox.Root>
        </Row>
        <Tmdb
          ownKey={Boolean(preferences.data?.tmdbKey)}
          onKey={(tmdbKey, done) => update.mutate({ tmdbKey }, { onSuccess: done })}
        />
        {update.error && update.variables?.analyticsEnabled === undefined && (
          <p className="mt-3 text-sm text-destructive">{describeError(appError(update.error))}</p>
        )}
      </Section>
      <OnlineSubtitlesSection />
      <UpdatesSection />
    </>
  );
}

/** The languages to pick from, with `current` added when it is another, as picked in a player. */
function languages(current: string): { value: string; label: string }[] {
  const listed: { value: string; label: string }[] = TITLE_LANGUAGES.map((language) => ({
    value: language.code,
    label: language.name,
  }));
  const other = current !== ORIGINAL_SOUND && current !== "off" && current !== FORCED;
  return other && !listed.some((option) => option.value === current)
    ? [...listed, { value: current, label: languageName(current) ?? current }]
    : listed;
}

/** How far TMDB got, and the viewer's own key: pasted in a field that opens on asking. */
function Tmdb({
  ownKey,
  onKey,
}: {
  ownKey: boolean;
  onKey: (key: string, done: () => void) => void;
}) {
  const status = useQuery(queries.onDemandStatus());
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const metadata = status.data?.metadata;
  const progress = !metadata
    ? t("no key")
    : metadata.refused
      ? t("refused the key")
      : metadata.known < metadata.wanted
        ? t("{known} of {wanted} titles", { known: metadata.known, wanted: metadata.wanted })
        : t("{count} titles", { count: metadata.known });
  return (
    <>
      <Row label="TMDB" note={ownKey ? `${t("your key")} · ${progress}` : progress}>
        {ownKey && (
          <Button variant="ghost" size="sm" onClick={() => onKey("", () => {})}>
            {t("Use the app's key")}
          </Button>
        )}
        {!editing && (
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            {t("Own key…")}
          </Button>
        )}
      </Row>
      {editing && (
        <form
          className="flex gap-3 border-b border-white/8 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!key.trim()) return;
            onKey(key.trim(), () => {
              setKey("");
              setEditing(false);
            });
          }}
        >
          <Input
            autoFocus
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={t("Your own key or read access token")}
            aria-label={t("Your own TMDB key")}
            className="h-9 flex-1"
          />
          <Button type="submit" variant="secondary" size="sm" disabled={!key.trim()}>
            {t("Use")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            {t("Cancel")}
          </Button>
        </form>
      )}
    </>
  );
}
