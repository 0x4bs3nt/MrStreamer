import { Checkbox } from "@base-ui/react/checkbox";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { QUALITIES } from "@mrstreamer/contracts/library";
import { LANGUAGE_NAMES, LOCALES, type LanguageChoice } from "@mrstreamer/contracts/language";
import {
  DEFAULT_LIVE_QUALITY,
  DEFAULT_NEXT_EPISODE_DELAY,
  DEFAULT_SUBTITLE_LOOK,
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
import { updatePreferences } from "../../lib/preferences.ts";
import { updateSubtitleLook } from "../../player/subtitle-look.ts";
import { preferenceName } from "../../lib/quality.ts";
import {
  queries,
  updateSubscriptionPreferences,
  useSubscriptionPreferences,
} from "../../lib/queries.ts";
import {
  SUBTITLE_SIZES,
  SUBTITLE_BACKGROUNDS,
  SUBTITLE_POSITIONS,
} from "../watch/subtitle-choices.ts";
import { OnlineSubtitlesSection } from "./OnlineSubtitlesSection.tsx";
import { Row, Section, Select } from "./Rows.tsx";
import { SaveFeedback } from "./SaveFeedback.tsx";
import type { SettingsControl } from "./catalogue.ts";

const FORCED = "forced";

/** Each row has its own pending/error state. Accepted snapshots alone supply saved values. */
function PreferenceRow<K extends keyof Preferences>({
  id,
  field,
  label,
  note,
  children,
  lookField,
}: {
  id: SettingsControl;
  field: K;
  label: string;
  note?: ReactNode;
  lookField?: keyof NonNullable<Preferences["subtitleLook"]>;
  children: (
    saved: Preferences | undefined,
    change: (value: Preferences[K]) => void,
    disabled: boolean,
  ) => ReactNode;
}) {
  const client = useQueryClient();
  const read = useQuery(queries.preferences());
  const writing = useRef(false);
  const fieldBusy = useIsMutating({ mutationKey: ["settings", field] }) > 0;
  const update = useMutation({
    mutationKey: ["settings", field],
    mutationFn: async (value: Preferences[K]) => {
      const look = value as Preferences["subtitleLook"];
      if (field === "subtitleLook" && lookField && look) {
        await updateSubtitleLook({ [lookField]: look[lookField] }, { client });
      } else {
        await updatePreferences({ [field]: value }, client);
      }
    },
    onSettled: () => {
      writing.current = false;
    },
    onMutate: (value) => {
      if (field === "adultTitles" && value === false) useUi.setState({ savedEntry: null });
    },
  });
  // A timed-out consent call can still commit. Only the accepted value matching this
  // mutation's boolean intent makes its save error obsolete.
  const consentSaved =
    field === "analyticsEnabled" &&
    typeof update.variables === "boolean" &&
    read.data?.analyticsEnabled === update.variables;
  const change = (value: Preferences[K]) => {
    if (
      !read.data ||
      writing.current ||
      fieldBusy ||
      update.isPending ||
      client.isMutating({ mutationKey: ["settings", field] })
    )
      return;
    writing.current = true;
    update.mutate(value);
  };
  return (
    <div>
      <fieldset
        disabled={!read.data}
        aria-disabled={fieldBusy || update.isPending}
        aria-busy={update.isPending}
        className="min-w-0"
      >
        <Row id={id} label={label} note={note}>
          {children(read.data, change, !read.data)}
        </Row>
      </fieldset>
      <SaveFeedback
        pending={update.isPending}
        error={consentSaved ? null : update.error}
        retryDisabled={fieldBusy}
        retry={() => change(update.variables!)}
      />
    </div>
  );
}

export function GeneralSection() {
  const client = useQueryClient();
  const language = useQuery(queries.language());
  const writing = useRef(false);
  const update = useMutation({
    mutationFn: (choice: LanguageChoice) => changeLanguage(client, choice),
    onSettled: () => {
      writing.current = false;
    },
  });
  const choose = (choice: LanguageChoice) => {
    if (writing.current || update.isPending) return;
    writing.current = true;
    update.mutate(choice);
  };
  return (
    <Section title={t("General")}>
      <Row id="interface-language" label={t("Interface language")}>
        {language.data && (
          <Select
            wide
            busy={update.isPending}
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
            onChange={choose}
          />
        )}
      </Row>
      <SaveFeedback
        pending={update.isPending}
        error={update.error ?? language.error}
        retry={() => (update.isError ? choose(update.variables!) : void language.refetch())}
      />
    </Section>
  );
}

function Toggle({
  disabled,
  label,
  value,
  change,
}: {
  label: string;
  disabled: boolean;
  value: boolean;
  change: (value: boolean) => void;
}) {
  return (
    <Checkbox.Root
      aria-label={label}
      disabled={disabled}
      checked={value}
      onCheckedChange={change}
      className="grid size-4 flex-none place-items-center rounded-[0.25rem] shadow-[inset_0_0_0_1.5px_rgb(255_255_255/45%)] outline-none focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-white data-checked:shadow-none"
    >
      <Checkbox.Indicator>
        <Check className="size-3 text-black" strokeWidth={3} />
      </Checkbox.Indicator>
    </Checkbox.Root>
  );
}

export function PlaybackSection() {
  return (
    <Section title={t("Playback")}>
      <PreferenceRow id="audio" field="audioLanguage" label={t("Audio in")}>
        {(saved, change) => {
          const value = saved?.audioLanguage ?? saved?.titleLanguage ?? DEFAULT_TITLE_LANGUAGE;
          return (
            <Select
              label={t("Audio in")}
              value={value}
              options={[
                { value: ORIGINAL_SOUND, label: t("Original language") },
                ...languages(value),
              ]}
              onChange={change}
            />
          );
        }}
      </PreferenceRow>
      <PreferenceRow
        id="autoplay"
        field="autoplayNext"
        label={t("Next episode")}
        note={t("plays automatically")}
      >
        {(saved, change, disabled) => (
          <Toggle
            disabled={disabled}
            label={t("Next episode")}
            value={saved?.autoplayNext ?? true}
            change={change}
          />
        )}
      </PreferenceRow>
      <PreferenceRow id="delay" field="nextEpisodeDelaySeconds" label={t("Next episode delay")}>
        {(saved, change) => (
          <>
            {saved?.nextEpisodeDelaySeconds === 0 && <span>{t("Instant")}</span>}
            <EpisodeDelay
              seconds={saved?.nextEpisodeDelaySeconds ?? DEFAULT_NEXT_EPISODE_DELAY}
              onChange={change}
            />
            <span>{t("seconds")}</span>
          </>
        )}
      </PreferenceRow>
    </Section>
  );
}

export function LiveSettingsSection() {
  const client = useQueryClient();
  const subscriptions = useSubscriptionPreferences("always");
  const picked = [...(subscriptions ?? [])].filter(
    ([, saved]) => Object.keys(saved.channelVariants ?? {}).length > 0,
  );
  const count = picked.reduce(
    (sum, [, saved]) => sum + Object.keys(saved.channelVariants ?? {}).length,
    0,
  );
  const writing = useRef(false);
  const reset = useMutation({
    mutationFn: async () => {
      // Wait for every result, including partial success. Retry reads only overrides still present.
      const results = await Promise.allSettled(
        picked.map(([subscriptionId]) =>
          updateSubscriptionPreferences(client, subscriptionId, { channelVariants: {} }),
        ),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
    onSettled: () => {
      writing.current = false;
    },
  });
  const resetQualities = () => {
    if (count === 0 || writing.current || reset.isPending) return;
    writing.current = true;
    reset.mutate();
  };
  return (
    <Section title={t("Live TV")}>
      <PreferenceRow
        id="quality"
        field="liveQuality"
        label={t("Quality")}
        note={t("Automatic tries the nearest if one fails")}
      >
        {(saved, change) => (
          <Select
            label={t("Quality")}
            value={saved?.liveQuality ?? DEFAULT_LIVE_QUALITY}
            options={QUALITIES.map((quality) => ({
              value: quality,
              label: preferenceName(quality),
            }))}
            onChange={change}
          />
        )}
      </PreferenceRow>
      <Row id="own-quality" label={t("Channels with their own quality")} note={formatNumber(count)}>
        <Button
          variant="secondary"
          size="sm"
          aria-disabled={count === 0 || reset.isPending}
          onClick={resetQualities}
        >
          {t("Reset")}
        </Button>
      </Row>
      <SaveFeedback pending={reset.isPending} error={reset.error} retry={resetQualities} />
    </Section>
  );
}

export function MoviesSettingsSection() {
  return (
    <Section title={t("Movies and series")}>
      <PreferenceRow id="titles" field="titleLanguage" label={t("Titles in")}>
        {(saved, change) => (
          <Select
            label={t("Titles in")}
            value={saved?.titleLanguage ?? DEFAULT_TITLE_LANGUAGE}
            options={languages(saved?.titleLanguage ?? DEFAULT_TITLE_LANGUAGE)}
            onChange={change}
          />
        )}
      </PreferenceRow>
      <PreferenceRow
        id="adult"
        field="adultTitles"
        label={t("For adults")}
        note={t("titles in their own tab, channels only in Live TV")}
      >
        {(saved, change, disabled) => (
          <Toggle
            disabled={disabled}
            label={t("For adults")}
            value={saved?.adultTitles ?? false}
            change={change}
          />
        )}
      </PreferenceRow>
      <Tmdb />
    </Section>
  );
}

export function SubtitlesSettingsSection() {
  return (
    <>
      <Section title={t("Subtitles")}>
        <PreferenceRow id="subtitle-language" field="subtitleLanguage" label={t("Subtitles")}>
          {(saved, change) => {
            const value = saved?.subtitleLanguage ?? FORCED;
            return (
              <Select
                label={t("Subtitles")}
                value={value}
                options={[
                  { value: "off", label: t("Off") },
                  { value: FORCED, label: t("Only when forced") },
                  ...languages(value),
                ]}
                onChange={(value) => change(value === FORCED ? null : value)}
              />
            );
          }}
        </PreferenceRow>
      </Section>
      <Section title={t("Subtitle look")}>
        <PreferenceRow id="subtitle-size" field="subtitleLook" lookField="size" label={t("Size")}>
          {(saved, change) => {
            const look = saved?.subtitleLook ?? DEFAULT_SUBTITLE_LOOK;
            return (
              <Select
                label={t("Size")}
                value={look.size}
                options={SUBTITLE_SIZES.map((option) => ({
                  value: option.value,
                  label: t(option.label),
                }))}
                onChange={(size) => change({ ...look, size })}
              />
            );
          }}
        </PreferenceRow>
        <PreferenceRow
          id="subtitle-background"
          field="subtitleLook"
          lookField="background"
          label={t("Background")}
        >
          {(saved, change) => {
            const look = saved?.subtitleLook ?? DEFAULT_SUBTITLE_LOOK;
            return (
              <Select
                label={t("Background")}
                value={look.background}
                options={SUBTITLE_BACKGROUNDS.map((option) => ({
                  value: option.value,
                  label: t(option.label),
                }))}
                onChange={(background) => change({ ...look, background })}
              />
            );
          }}
        </PreferenceRow>
        <PreferenceRow
          id="subtitle-position"
          field="subtitleLook"
          lookField="position"
          label={t("Position")}
        >
          {(saved, change) => {
            const look = saved?.subtitleLook ?? DEFAULT_SUBTITLE_LOOK;
            return (
              <Select
                label={t("Position")}
                value={look.position}
                options={SUBTITLE_POSITIONS.map((option) => ({
                  value: option.value,
                  label: t(option.label),
                }))}
                onChange={(position) => change({ ...look, position })}
              />
            );
          }}
        </PreferenceRow>
      </Section>
      <OnlineSubtitlesSection />
    </>
  );
}

export function PrivacySection() {
  return (
    <Section title={t("Privacy")}>
      <PreferenceRow
        id="statistics"
        field="analyticsEnabled"
        label={t("Share basic usage statistics")}
      >
        {(saved, change, disabled) => (
          <Toggle
            disabled={disabled}
            label={t("Share basic usage statistics")}
            value={saved?.analyticsEnabled ?? true}
            change={change}
          />
        )}
      </PreferenceRow>
      <p className="mt-3 text-sm">
        {t(
          "Counts app use, the features you open, whether playback, downloads and update checks work, and how often the window stops unexpectedly. No viewing history or provider details.",
        )}
      </p>
      <a
        data-setting="privacy-policy"
        href="https://mrstreamer.app/privacy"
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-block text-sm underline underline-offset-4"
      >
        {t("Privacy policy")}
      </a>
    </Section>
  );
}

/** Draft seconds survive unrelated snapshots. Blur/Enter clamps whole seconds; Escape cancels. */
function EpisodeDelay({
  seconds,
  onChange,
}: {
  seconds: number;
  onChange: (seconds: number) => void;
}) {
  const [value, setValue] = useState(String(seconds));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setValue(String(seconds));
  }, [seconds]);
  const commit = (input: HTMLInputElement) => {
    const next = input.valueAsNumber;
    const changed = editing.current;
    editing.current = false;
    setValue(String(seconds));
    if (changed && Number.isInteger(next)) {
      const bounded = Math.max(0, Math.min(60, next));
      if (bounded !== seconds) onChange(bounded);
    }
  };
  return (
    <Input
      aria-label={t("Next episode delay")}
      type="number"
      min={0}
      max={60}
      step={1}
      value={value}
      compact
      className="w-20 text-right tabular-nums"
      onChange={(event) => {
        editing.current = true;
        setValue(event.target.value);
      }}
      onKeyDown={(event) => {
        if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          editing.current = true;
          const current = Number(value) || 0;
          setValue(
            String(
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? 60
                  : Math.max(
                      0,
                      Math.min(
                        60,
                        current + (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 5 : 1),
                      ),
                    ),
            ),
          );
        } else if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          commit(event.currentTarget);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setValue(String(seconds));
          editing.current = false;
          event.currentTarget.blur();
        }
      }}
      onBlur={(event) => commit(event.currentTarget)}
    />
  );
}

function languages(current: string): { value: string; label: string }[] {
  const listed = TITLE_LANGUAGES.map((language) => ({
    value: language.code,
    label: language.name,
  }));
  const other = current !== ORIGINAL_SOUND && current !== "off" && current !== FORCED;
  return other && !listed.some((option) => option.value === current)
    ? [...listed, { value: current, label: languageName(current) ?? current }]
    : listed;
}

function Tmdb() {
  const client = useQueryClient();
  const preferences = useQuery(queries.preferences());
  const status = useQuery(queries.onDemandStatus());
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const update = useMutation({
    mutationFn: (tmdbKey: string) => updatePreferences({ tmdbKey }, client),
    onSuccess: () => {
      setKey("");
      setEditing(false);
    },
  });
  const save = (tmdbKey: string) => {
    if (!preferences.data || update.isPending) return;
    update.mutate(tmdbKey);
  };
  const metadata = status.data?.metadata;
  const progress = !metadata
    ? t("no key")
    : metadata.refused
      ? t("refused the key")
      : metadata.known < metadata.wanted
        ? t("{known} of {wanted} titles", { known: metadata.known, wanted: metadata.wanted })
        : t("{count} titles", { count: metadata.known });
  return (
    <div data-setting="tmdb">
      <Row
        label="TMDB"
        note={preferences.data?.tmdbKey ? `${t("your key")} · ${progress}` : progress}
      >
        {preferences.data?.tmdbKey && (
          <Button
            variant="ghost"
            size="sm"
            aria-disabled={update.isPending}
            onClick={() => save("")}
          >
            {t("Use the app's key")}
          </Button>
        )}
        {!editing && (
          <Button
            variant="secondary"
            size="sm"
            disabled={!preferences.data}
            aria-disabled={update.isPending}
            onClick={() => {
              if (!update.isPending) setEditing(true);
            }}
          >
            {t("Own key…")}
          </Button>
        )}
      </Row>
      {editing && (
        <form
          className="flex flex-wrap gap-3 border-b border-white/8 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim()) save(key.trim());
          }}
        >
          <Input
            autoFocus
            readOnly={update.isPending}
            aria-disabled={update.isPending}
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={t("Your own key or read access token")}
            aria-label={t("Your own TMDB key")}
            compact
            className="min-w-0 flex-1"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setEditing(false);
              }
            }}
          />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={!key.trim()}
            aria-disabled={update.isPending}
          >
            {t("Use")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            {t("Cancel")}
          </Button>
        </form>
      )}
      <SaveFeedback
        pending={update.isPending}
        error={update.error}
        retry={() => save(update.variables!)}
      />
    </div>
  );
}
