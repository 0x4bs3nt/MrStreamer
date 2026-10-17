import type { AnalyticsSettings } from "@mrstreamer/contracts/analytics";
import type { AppError } from "@mrstreamer/contracts/errors";
import type { AccountStatus } from "@mrstreamer/contracts/subscription";
import { formatDate } from "@mrstreamer/core/i18n";
import Constants from "expo-constants";
import { router } from "expo-router";
import { isPictureInPictureSupported } from "expo-video";
import { SymbolView } from "expo-symbols";
import {
  ActionSheetIOS,
  Alert,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import {
  members,
  reloadChannels,
  reloadTitles,
  remove,
  retry,
  useRoster,
  type Member,
} from "../../../account.ts";
import { DownloadsLink } from "../../../downloads-screen.tsx";
import { failureOf } from "../../../errors.ts";
import { setStatistics, useStatistics } from "../../../telemetry/index.ts";
import { hasTmdb, useMetadataStatus, useTitleTimings } from "../../../titles.ts";
import { ChannelLogo, colors, TextButton } from "../../../ui.tsx";

/**
 * Settings as one list: the providers first, each a row with Add provider under them, then
 * Downloads, a row with what they take that opens them, Playback, Privacy and About. M3U playlists
 * and guide sources come here as they come to iOS, and until then nothing here offers them. TMDB's terms ask for its logo and
 * notice, as the desktop's Settings show them.
 */
export default function Settings() {
  const roster = useRoster();
  const statistics = useStatistics();
  if (roster.kind !== "ready") return null;
  return (
    <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic">
      <Section name="Providers" />
      {roster.members.map((member) => (
        <Provider key={member.entry.id} member={member} />
      ))}
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push("/provider")}
        style={({ pressed }) => [styles.provider, pressed && styles.pressed]}
        testID="settings-add-provider"
      >
        <SymbolView name="plus" size={20} tintColor={colors.text} style={styles.mark} />
        <Text style={styles.name}>Add provider</Text>
      </Pressable>

      <Section name="Downloads" />
      <DownloadsLink onPress={() => router.push("/downloads")} />

      <Section name="Playback" />
      <Line
        label="Picture in Picture"
        value={isPictureInPictureSupported() ? "Supported" : "Not on this iPhone"}
      />

      <Section name="Privacy" />
      <View style={styles.toggle}>
        <Text style={styles.label} importantForAccessibility="no" accessibilityElementsHidden>
          Share basic usage statistics
        </Text>
        <Switch
          accessibilityLabel="Share basic usage statistics"
          value={statistics.enabled}
          onValueChange={(enabled) => void setStatistics(enabled)}
          testID="settings-statistics"
        />
      </View>
      <Text style={styles.paragraph}>
        {[
          "Counts app use, the screens you open, and whether playback works and for how long.",
          "No viewing history, searches or provider details. On unless you turn it off.",
          transportNote(statistics),
        ]
          .filter(Boolean)
          .join(" ")}
      </Text>

      <Section name="About" />
      <Line
        label="Version"
        value={`${Constants.expoConfig?.version ?? "?"} (${Constants.platform?.ios?.buildNumber ?? "?"})`}
      />
      <TmdbLine />
      {hasTmdb ? (
        <View style={styles.notice}>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="TMDB"
            onPress={() => void Linking.openURL("https://www.themoviedb.org")}
          >
            <Image
              source={require("../../../../assets/tmdb.png") as number}
              style={styles.logo}
              resizeMode="contain"
            />
          </Pressable>
          <Text style={styles.noticeText}>
            This application uses TMDB and the TMDB APIs but is not endorsed, certified, or
            otherwise approved by TMDB. Where titles stream comes from JustWatch.
          </Text>
        </View>
      ) : null}
      {__DEV__ ? <Development /> : null}
      <View style={styles.end} />
    </ScrollView>
  );
}

/**
 * A provider as one row: its name and how it stands, in a line. Pressing it offers what can be
 * done with it, as a system sheet: Retry when it didn't answer, the reloads, Edit and Remove.
 */
function Provider({ member }: { member: Member }) {
  const { entry, label } = member;
  const line = standing(member);
  const open = () => {
    const actions = [
      ...(member.needsSecret
        ? [{ label: "Enter password", run: () => edit(entry.id) }]
        : failed(member)
          ? [{ label: "Retry", run: () => retry(entry.id) }]
          : []),
      ...(member.needsSecret
        ? []
        : [
            { label: "Reload channels", run: () => reloadChannels(entry.id) },
            { label: "Reload movies and series", run: () => reloadTitles(entry.id) },
          ]),
      { label: "Edit", run: () => edit(entry.id) },
      { label: "Remove", run: () => confirmRemove(member) },
    ];
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: label,
        options: [...actions.map((action) => action.label), "Cancel"],
        destructiveButtonIndex: actions.length - 1,
        cancelButtonIndex: actions.length,
      },
      (index) => actions[index]?.run(),
    );
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${line}`}
      onPress={open}
      style={({ pressed }) => [styles.provider, pressed && styles.pressed]}
      testID={`settings-provider-${entry.id}`}
    >
      <ChannelLogo channel={{ title: label, logoUrl: null }} style={styles.mark} />
      <View style={styles.names}>
        <Text style={styles.name} numberOfLines={1}>
          {label}
        </Text>
        <Text style={[styles.plain, failed(member) && styles.failed]} numberOfLines={2}>
          {line}
        </Text>
      </View>
    </Pressable>
  );
}

const edit = (id: string) => router.push({ pathname: "/provider", params: { id } });

/** Whether it needs the viewer: it didn't answer, or asks for its password again. */
const failed = (member: Member) =>
  member.needsSecret ||
  member.live.kind === "failed" ||
  member.titles.kind === "failed" ||
  (member.account !== null && "kind" in member.account);

/** How a provider stands, in a line: its account, or what needs the viewer, or what loads. */
function standing({ entry, account, needsSecret, live, titles }: Member): string {
  if (needsSecret) return "Enter the password again";
  if (live.kind === "failed") return failureOf(live.error, entry.server).headline;
  if (titles.kind === "failed") {
    return `Movies and series: ${failureOf(titles.error, entry.server).headline}`;
  }
  const loading =
    live.kind === "loading" ? "Loading channels" : titles.kind === "loading" ? "Loading" : null;
  return [accountLine(account, entry.server), loading].filter(Boolean).join(" · ");
}

/**
 * Asks before removing, saying what goes. Its history stays unless the viewer deletes it too;
 * the last one removed returns to Connect. A failed removal says how it stands: still saved
 * when the registry refused it, else removed with history the next launch deletes.
 */
function confirmRemove({ entry, label }: Member) {
  const removing = (keepHistory: boolean) => () =>
    void remove(entry.id, { keepHistory }).catch(() => {
      if (members().some((member) => member.entry.id === entry.id)) {
        Alert.alert(
          `Couldn't remove ${label}`,
          "It's still saved and nothing was deleted. Try again.",
        );
      } else if (!keepHistory) {
        Alert.alert(
          `${label} is removed`,
          "Its history couldn't all be deleted yet. The app tries again when it next opens.",
        );
      }
    });
  Alert.alert(
    `Remove ${label}?`,
    "What plays from it stops. Its favourites, watchlist, history and progress stay for when you add it again, unless you delete them too.",
    [
      { text: "Remove", style: "destructive", onPress: removing(true) },
      { text: "Remove and delete history", style: "destructive", onPress: removing(false) },
      { text: "Cancel", style: "cancel" },
    ],
  );
}

/** Where statistics go in this build, when that isn't PostHog. */
function transportNote({ enabled, transport }: AnalyticsSettings): string | null {
  if (transport === "unavailable") return "They can't be saved on this iPhone right now.";
  if (!enabled || transport === "production") return null;
  return transport === "local"
    ? "This development build sends them to a test endpoint on this computer only."
    : "This build sends nothing.";
}

/** TMDB's part: movie and series facts and pictures, when the build has a key. */
function TmdbLine() {
  const tmdb = useMetadataStatus();
  return (
    <Line
      label="TMDB"
      value={
        !hasTmdb
          ? "Not in this build"
          : !tmdb
            ? "Waiting for the lists"
            : tmdb.refused
              ? "Refused the key"
              : tmdb.known < tmdb.wanted
                ? `${tmdb.known} of ${tmdb.wanted} titles`
                : `${tmdb.known} titles`
      }
    />
  );
}

/** What development builds also show. Release builds leave it out. */
function Development() {
  const timings = useTitleTimings();
  return (
    <>
      <Section name="Development" />
      <Line
        label="Movies and series lists"
        value={timings ? `read ${timings.fetched} ms, indexed ${timings.indexed} ms` : "Not read"}
      />
      <View style={styles.actions}>
        <TextButton label="Runtime proof" onPress={() => router.push("/proof")} />
      </View>
    </>
  );
}

/** The account as one plain line: "Active until 12 Mar 2027, 1 of 2 streams". */
function accountLine(account: AccountStatus | AppError | null, server: string): string {
  if (!account) return "Checking";
  if ("kind" in account) return failureOf(account, server).headline;
  const state = account.state === "active" ? "Active" : capitalised(account.state);
  const until = account.expiresAt
    ? ` until ${formatDate(Date.parse(account.expiresAt), "date")}`
    : "";
  const streams =
    account.maxConnections !== null
      ? `, ${account.activeConnections ?? 0} of ${account.maxConnections} streams`
      : "";
  return `${state}${until}${streams}`;
}

const capitalised = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

function Section({ name }: { name: string }) {
  return (
    <Text style={styles.section} accessibilityRole="header">
      {name}
    </Text>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.line} accessible accessibilityLabel={`${label}, ${value}`}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  section: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
    marginTop: 24,
    marginBottom: 4,
    marginHorizontal: 16,
  },
  provider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingVertical: 8,
    marginHorizontal: 16,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pressed: { opacity: 0.5 },
  mark: { width: 36, height: 36 },
  names: { flex: 1, minWidth: 0 },
  failed: { color: "#FF453A" },
  name: { color: colors.text, fontSize: 17, fontWeight: "600" },
  plain: { color: colors.text, fontSize: 15 },
  line: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 16,
    minHeight: 44,
    alignItems: "center",
    marginHorizontal: 16,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  toggle: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 16,
    minHeight: 44,
    marginHorizontal: 16,
  },
  label: { color: colors.text, fontSize: 17, flexShrink: 1 },
  value: { color: colors.dim, fontSize: 17, flexShrink: 1, textAlign: "right" },
  paragraph: {
    color: colors.dim,
    fontSize: 13,
    lineHeight: 18,
    marginHorizontal: 16,
    marginTop: 4,
  },
  actions: { marginHorizontal: 16, marginTop: 4 },
  notice: { marginHorizontal: 16, marginTop: 24, gap: 10 },
  logo: { width: 108, height: 14 },
  noticeText: { color: colors.dim, fontSize: 13, lineHeight: 18 },
  end: { height: 32 },
});
