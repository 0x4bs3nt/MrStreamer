import type { Download, DownloadFailure } from "@mrstreamer/contracts/downloads";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import { formatBytes, formatPercent, t } from "@mrstreamer/core/i18n";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { minutesLeft } from "@mrstreamer/core/viewing/continue";
import { SymbolView, type SFSymbol } from "expo-symbols";
import {
  ActionSheetIOS,
  Alert,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  addDownload,
  downloadList,
  playDownload,
  removeDownload,
  retryDownload,
  useDownloadOf,
} from "./downloads.ts";
import { appError, describeError } from "./errors.ts";

// What a download says and what can be done with it, wherever one shows: Downloads' rows, the
// details' capsule and episode rows. Each state offers its own actions, as the desktop's do:
// queued, waiting and transferring Cancel; failed Retry and Remove, with why it stopped; a copy
// Play offline and Delete; a copy whose file went Delete. Ending a running transfer or deleting a
// copy asks first, as both lose what took a while to download; the rest happens at once.
// A sheet or a confirmation can stay open while the download moves on, so each action looks the
// download up again when it runs, and again on confirming: it does what still applies, or nothing.

const RED = "#FF453A";

/** One thing to do with a download, as a menu, a button or a VoiceOver action offers it. */
export interface DownloadAction {
  readonly label: string;
  readonly destructive: boolean;
  readonly run: () => void;
}

/** "Paper Harbor · S1 E3", or the movie's name: how sheets and alerts name a download. */
export function nameOf(download: Download): string {
  const { title } = download;
  return title.kind === "episode"
    ? `${download.name} · ${episodeLabel(title.season, title.episode)}`
    : download.name;
}

/** "S1 E3 · The Tide Table", or null for a movie. */
export function episodeLine(download: Download): string | null {
  const { title } = download;
  if (title.kind !== "episode") return null;
  const label = episodeLabel(title.season, title.episode);
  return download.episodeName ? `${label} · ${download.episodeName}` : label;
}

/** Why a download stopped, in the desktop's sentence, with what to do about it. */
export function describeFailure(failure: DownloadFailure): string {
  switch (failure.kind) {
    case "disk-full":
      return failure.needed === null
        ? t("Disk full. Free some space, then retry.")
        : t("Disk full. Free {size}, then retry.", { size: formatBytes(failure.needed) });
    case "folder":
      return t("The downloads folder can't be written. Retry, or check the disk.");
    case "stream":
      return describeError({ kind: "stream", failure: failure.failure });
    case "app":
      return describeError(failure.error);
  }
}

/** How far a transfer is, from 0 to 1, when its size is known. */
export function transferred(download: Download): number | null {
  const { status } = download;
  return status.kind === "transferring" && status.size ? status.received / status.size : null;
}

const percentOf = (done: number) => formatPercent(Math.floor(done * 100) / 100);

/** How a download stands, as Downloads says it under the facts; empty for a copy. */
export function statusLine(download: Download): string {
  const { status } = download;
  switch (status.kind) {
    case "queued":
      return t("Queued");
    case "waiting":
      return download.subscription
        ? t("Waiting while {subscription} plays", { subscription: download.subscription.name })
        : t("Waiting for playback");
    case "transferring": {
      const done = transferred(download);
      if (done === null || status.size === null) {
        return status.received > 0 ? formatBytes(status.received) : t("Starting");
      }
      const left =
        status.rate && status.rate > 0 ? (status.size - status.received) / status.rate : null;
      return [
        percentOf(done),
        t("{received} of {size}", {
          received: formatBytes(status.received),
          size: formatBytes(status.size),
        }),
        left !== null ? minutesLeft(Math.max(1, Math.round(left / 60))) : null,
        status.restarted ? t("started again, the file changed") : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "failed":
      return describeFailure(status.failure);
    case "complete":
      return "";
    case "missing":
      return "File missing";
  }
}

/** The state in a word or two, as the details' facts and episode lines add it. */
export function stateWord(download: Download): string {
  const { status } = download;
  switch (status.kind) {
    case "queued":
      return "Queued";
    case "waiting":
      return "Waiting";
    case "transferring": {
      const done = transferred(download);
      return done === null ? "Downloading" : `Downloading ${percentOf(done)}`;
    }
    case "failed":
      return "Download failed";
    case "complete":
      return "Downloaded";
    case "missing":
      return "File missing";
  }
}

/** What VoiceOver says of the download button. */
function buttonLabel(download: Download | undefined): string {
  if (!download) return "Download";
  const { status } = download;
  switch (status.kind) {
    case "queued":
      return "Queued, download";
    case "waiting":
      return "Waiting for playback, download";
    case "transferring":
      return stateWord(download);
    case "failed":
      return `Download failed, ${describeFailure(status.failure)}`;
    case "complete":
      return "Downloaded";
    case "missing":
      return "File missing, download";
  }
}

/** Shows why something couldn't be done, in the desktop's words. */
function attempt(title: string, work: Promise<unknown>) {
  void work.catch((cause: unknown) => Alert.alert(title, describeError(appError(cause))));
}

function remove(download: Download) {
  attempt(`Couldn't remove ${nameOf(download)}`, removeDownload(download.id));
}

/** Asks first, then runs `run`: the sheet's red button is `confirm`. */
function ask(title: string, confirm: string, keep: string, run: () => void) {
  ActionSheetIOS.showActionSheetWithOptions(
    { title, options: [confirm, keep], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
    (index) => index === 0 && run(),
  );
}

/** The download `id` as it stands now, or undefined once it is gone. */
const current = (id: string) => downloadList().items.find((item) => item.id === id);

/** Still in the queue, or stopped there: what Cancel and Remove end. */
const unfinished = (download: Download | undefined): download is Download =>
  download !== undefined &&
  download.status.kind !== "complete" &&
  download.status.kind !== "missing";

/**
 * Cancels or removes download `id` while it is unfinished: at once, unless it is transferring and
 * would lose its bytes. One that finished meanwhile stays, as Cancel no longer applies to it.
 */
function cancel(id: string) {
  const download = current(id);
  if (!unfinished(download)) return;
  if (download.status.kind !== "transferring") return remove(download);
  ask(`Cancel downloading ${nameOf(download)}?`, "Cancel download", "Keep downloading", () => {
    const now = current(id);
    if (unfinished(now)) remove(now);
  });
}

/** Deletes copy `id`: after asking while its file is there, at once when the file went. */
function deleteCopy(id: string) {
  const download = current(id);
  if (download?.status.kind === "missing") return remove(download);
  if (download?.status.kind !== "complete") return;
  const size = download.size ? `${formatBytes(download.size)} ` : "";
  ask(`Delete the ${size}copy of ${nameOf(download)}?`, "Delete download", "Cancel", () => {
    const now = current(id);
    if (now && !unfinished(now)) remove(now);
  });
}

/**
 * Everything that can be done with `download` as it stands, the first being what fits most. Each
 * run acts on the download as it is by then.
 */
export function actionsOf(download: Download): readonly DownloadAction[] {
  const { status } = download;
  switch (status.kind) {
    case "queued":
    case "waiting":
    case "transferring":
      return [{ label: "Cancel download", destructive: true, run: () => cancel(download.id) }];
    case "failed":
      return [
        {
          label: "Retry",
          destructive: false,
          run: () => attempt(`Couldn't retry ${nameOf(download)}`, retryDownload(download.id)),
        },
        { label: "Remove", destructive: true, run: () => cancel(download.id) },
      ];
    case "complete":
      return [
        { label: "Play offline", destructive: false, run: () => playDownload(download.id) },
        { label: "Delete download", destructive: true, run: () => deleteCopy(download.id) },
      ];
    case "missing":
      return [{ label: "Delete download", destructive: true, run: () => deleteCopy(download.id) }];
  }
}

/**
 * Offers `actions` in a system sheet, after any of the caller's own; a failed download's reason
 * is its title.
 */
export function showActions(
  download: Download | undefined,
  actions: readonly DownloadAction[],
): void {
  if (actions.length === 0) return;
  const destructive = actions.flatMap((action, at) => (action.destructive ? [at] : []));
  ActionSheetIOS.showActionSheetWithOptions(
    {
      ...(download?.status.kind === "failed"
        ? { title: describeFailure(download.status.failure) }
        : {}),
      options: [...actions.map((action) => action.label), "Cancel"],
      destructiveButtonIndex: destructive,
      cancelButtonIndex: actions.length,
    },
    (index) => actions[index]?.run(),
  );
}

/** Queues `ref` at once, saying why when it can't be. */
export function queue(ref: TitleRef, name: string): void {
  attempt(`Couldn't download ${name}`, addDownload(ref));
}

/** What a title without a download offers: Download. */
export const downloadAction = (ref: TitleRef, name: string): DownloadAction => ({
  label: "Download",
  destructive: false,
  run: () => queue(ref, name),
});

/** The symbol for each state; a transfer of known size draws its ring instead. */
const SYMBOLS: Record<Download["status"]["kind"] | "none", SFSymbol> = {
  none: "arrow.down",
  queued: "clock",
  waiting: "pause.circle",
  transferring: "arrow.down.circle",
  failed: "arrow.clockwise",
  complete: "checkmark",
  missing: "exclamationmark.triangle",
};

/** The download's state as one symbol, or a still ring of how far it got. */
export function DownloadGlyph({
  download,
  size = 18,
}: {
  download: Download | undefined;
  size?: number;
}) {
  const done = download ? transferred(download) : null;
  if (done !== null) return <Ring done={done} size={size + 2} />;
  const kind = download?.status.kind ?? "none";
  return (
    <SymbolView
      name={SYMBOLS[kind]}
      size={size}
      tintColor={kind === "failed" ? RED : "#FFFFFF"}
      weight="semibold"
    />
  );
}

/**
 * A still ring filled clockwise from the top by `done`. Each half is a circle's border coloured
 * on two sides, turned and clipped to its side of the ring; nothing animates.
 */
function Ring({ done, size }: { done: number; size: number }) {
  const turn = Math.min(1, Math.max(0, done));
  const stroke = Math.max(2, Math.round(size / 9));
  const circle: ViewStyle = {
    position: "absolute",
    top: 0,
    width: size,
    height: size,
    borderRadius: size / 2,
    borderWidth: stroke,
  };
  const half = (side: "left" | "right", degrees: number) => (
    <View style={[styles.half, { width: size / 2, height: size, [side]: 0 }]}>
      <View
        style={[
          circle,
          styles.arc,
          side === "right" ? { left: -size / 2 } : { left: 0 },
          { transform: [{ rotate: `${degrees}deg` }] },
        ]}
      />
    </View>
  );
  return (
    <View style={{ width: size, height: size }}>
      <View style={[circle, styles.track]} />
      {half("right", -135 + 360 * Math.min(turn, 0.5))}
      {turn > 0.5 ? half("left", 45 + 360 * (turn - 0.5)) : null}
    </View>
  );
}

/**
 * The download button of a movie or an episode, its symbol the download's state. Without a
 * download it queues one at once; otherwise it offers what the state allows. On an episode row a
 * finished copy plays offline at once (`playsCopy`).
 */
export function DownloadButton({
  of: ref,
  name,
  playsCopy = false,
  hidden = false,
  style,
  testID,
}: {
  of: TitleRef;
  /** How alerts name the title. */
  name: string;
  playsCopy?: boolean;
  /** Left out of VoiceOver, where the row around it offers the same as actions. */
  hidden?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const download = useDownloadOf(ref);
  const press = () => {
    if (!download) return queue(ref, name);
    if (playsCopy && download.status.kind === "complete") return playDownload(download.id);
    showActions(download, actionsOf(download));
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={buttonLabel(download)}
      {...(hidden
        ? { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" }
        : {})}
      onPress={press}
      style={({ pressed }) => [styles.button, style, pressed && styles.pressed]}
      testID={testID}
    >
      <DownloadGlyph download={download} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.6 },
  half: { position: "absolute", top: 0, overflow: "hidden" },
  track: { borderColor: "rgba(255,255,255,0.3)" },
  arc: { borderColor: "transparent", borderTopColor: "#FFFFFF", borderRightColor: "#FFFFFF" },
});
