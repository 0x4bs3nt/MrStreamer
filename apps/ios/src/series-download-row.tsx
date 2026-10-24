import type { SeriesDetails } from "@mrstreamer/contracts/ondemand";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { useEffect, useRef, useState } from "react";
import { ActionSheetIOS, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useDownloads } from "./downloads.ts";
import { appError, describeError } from "./errors.ts";
import { openOnTabs, useTabs, type TabsAt } from "./header.tsx";
import {
  cancelRemaining,
  countDownload,
  planDownload,
  planRetry,
  seriesRun,
  startDownload,
  useSeriesRun,
  type Plan,
  type Result,
  type Scope,
} from "./series-download.ts";
import { colors } from "./ui.tsx";

// The details' bulk downloads of a series, by series-download.ts: a season's row under its tabs
// ("2 of 6 saved or queued", Download remaining) and the whole series' after the episodes (Review
// series download). Each asks first in a system sheet with its exact counts, then queues the
// version shown one episode at a time; its row says how far it got and offers Cancel remaining.
// How it went comes in an alert, with Retry failed and Open Downloads.

const episodes = (count: number) => `${count} ${count === 1 ? "episode" : "episodes"}`;

/** "4 queued. 1 failed: …", what a finished run did. */
function summary(result: Result): string {
  const failed = result.failed[0];
  const before = episodes(result.cancelled);
  const said = [
    result.added > 0 ? `${result.added} queued.` : null,
    result.retried > 0 ? `${result.retried} retried.` : null,
    result.replaced > 0 ? `${result.replaced} replaced.` : null,
    result.skipped > 0 ? `${result.skipped} changed meanwhile and stayed as they were.` : null,
    result.removed > 0
      ? `${result.removed} missing ${result.removed === 1 ? "copy" : "copies"} removed and not queued again.`
      : null,
    failed ? `${result.failed.length} failed: ${failed.error}` : null,
    result.stopped === "cancelled" ? `Cancelled before ${before}.` : null,
    result.stopped === "login"
      ? `Stopped before ${before}: the provider signed in anew or was removed.`
      : null,
    result.stopped === "left" ? `Stopped before ${before}: a version was chosen meanwhile.` : null,
  ].filter(Boolean);
  return said.length > 0 ? said.join(" ") : "Nothing was added.";
}

/** The sheet's counts: what is there already, and what will be done. */
function message(plan: Plan): string {
  const total =
    plan.scope.kind === "series" && plan.seasons > 1
      ? `${episodes(plan.episodes.length)} in ${plan.seasons} seasons.`
      : `${episodes(plan.episodes.length)}.`;
  return [
    total,
    plan.held > 0 ? `${plan.held} already saved or queued.` : null,
    plan.retry.length > 0 ? `${plan.retry.length} failed and will be retried.` : null,
    plan.missing.length > 0
      ? `${plan.missing.length} saved ${plan.missing.length === 1 ? "file is" : "files are"} missing.`
      : null,
    "Size unavailable.",
    "Uses the selected version.",
  ]
    .filter(Boolean)
    .join(" ");
}

const openDownloads = (tabs: TabsAt | null) => tabs && openOnTabs(tabs, "downloads");

/**
 * A bulk download's row for `scope` of `details`, the details of version `version` as shown:
 * `stands` is the screen's word, ending once it goes, shows another version or a version is
 * accepted in its menu. Downloads pushed over it leaves it standing.
 */
export function SeriesDownloadRow({
  details,
  version,
  scope,
  label,
  action,
  stands,
}: {
  details: SeriesDetails;
  version: OwnedId;
  scope: Scope;
  /** What the sheet and alert call the scope: "Season 1", or the series' name. */
  label: string;
  /** The button's label. */
  action: string;
  stands: () => { stands(): boolean };
}) {
  // Counted again as downloads change.
  useDownloads();
  const run = useSeriesRun();
  const tabs = useTabs();
  // As they are when a sheet or an alert answers.
  const tabsNow = useRef(tabs);
  tabsNow.current = tabs;
  // The run started here, which this row follows and whose end it tells while it still shows.
  const [started, setStarted] = useState<{
    readonly id: number;
    readonly label: string;
    readonly asked: { stands(): boolean };
  } | null>(null);
  const mine = run && started && run.id === started.id ? run : null;
  useEffect(() => {
    if (!mine || !started || mine.phase !== "done") return;
    setStarted(null);
    const { result } = mine;
    const retry = result.failed.length > 0 ? planRetry(mine.id) : null;
    Alert.alert(started.label, summary(result), [
      ...(retry
        ? [
            {
              text: "Retry failed",
              onPress: () => begin(retry, true, started.label, started.asked),
            },
          ]
        : []),
      { text: "Open Downloads", onPress: () => openDownloads(tabsNow.current) },
      { text: "OK", style: "cancel" as const },
    ]);
  }, [mine, started]);
  // A season row counts its own; the series row every episode of the version.
  const counts = countDownload(details, version, scope);

  /** Starts `plan` as just confirmed, saying why when it can't. */
  function begin(plan: Plan, replace: boolean, name: string, asked: { stands(): boolean }) {
    const id = startDownload(plan, { replace, stands: asked.stands });
    if (id === null) {
      Alert.alert(
        `Couldn't download ${name}`,
        seriesRun()?.phase === "running"
          ? "Episodes of another download are still being added."
          : "The version or its provider changed. Try again.",
      );
      return;
    }
    setStarted({ id, label: name, asked });
  }

  const press = () => {
    // Asked now: the sheet answers only for the version and login shown as it opened.
    const asked = stands();
    let plan: Plan;
    try {
      plan = planDownload(details, version, scope);
    } catch (cause) {
      Alert.alert(`Couldn't download ${label}`, describeError(appError(cause)));
      return;
    }
    const remaining = plan.add.length + plan.retry.length;
    const missing = plan.missing.length;
    if (remaining + missing === 0) {
      Alert.alert(`All ${episodes(plan.episodes.length)} are saved or queued.`, undefined, [
        { text: "Open Downloads", onPress: () => openDownloads(tabsNow.current) },
        { text: "OK", style: "cancel" },
      ]);
      return;
    }
    const choices = [
      ...(remaining > 0 ? [{ label: `Download ${episodes(remaining)}`, replace: false }] : []),
      ...(missing > 0
        ? [
            {
              label:
                remaining > 0
                  ? `Download ${remaining} and replace ${missing} missing`
                  : `Replace ${missing} missing ${missing === 1 ? "file" : "files"}`,
              replace: true,
            },
          ]
        : []),
    ];
    let answered = false;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: scope.kind === "season" ? `Download ${label}?` : `Download all of ${label}?`,
        message: message(plan),
        options: [...choices.map((choice) => choice.label), "Cancel"],
        cancelButtonIndex: choices.length,
      },
      (index) => {
        const choice = choices[index];
        // One answer per sheet.
        if (!choice || answered) return;
        answered = true;
        begin(plan, choice.replace, label, asked);
      },
    );
  };

  const going = mine?.phase === "running" ? mine : null;
  const busy = run?.phase === "running";
  return (
    <View style={styles.row} testID={`bulk-${scope.kind}`}>
      <Text style={styles.count} numberOfLines={2}>
        {going
          ? `Adding ${Math.min(going.done + 1, going.total)} of ${going.total}`
          : [
              scope.kind === "series" ? "Whole series" : null,
              counts.held > 0
                ? `${counts.held} of ${counts.total} saved or queued`
                : episodes(counts.total),
            ]
              .filter(Boolean)
              .join(" · ")}
      </Text>
      {going ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => cancelRemaining(going.id)}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
          testID={`bulk-${scope.kind}-cancel`}
        >
          <Text style={styles.label}>Cancel remaining</Text>
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy || counts.total === 0 }}
          disabled={busy || counts.total === 0}
          onPress={press}
          style={({ pressed }) => [
            styles.button,
            (pressed || busy || counts.total === 0) && styles.pressed,
          ]}
          testID={`bulk-${scope.kind}-start`}
        >
          <Text style={styles.label}>{action}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginHorizontal: 16,
    minHeight: 44,
  },
  count: { color: colors.text, fontSize: 15, flexShrink: 1 },
  button: { minHeight: 44, justifyContent: "center", alignItems: "flex-end" },
  label: { color: colors.text, fontSize: 15, fontWeight: "700" },
  pressed: { opacity: 0.6 },
});
