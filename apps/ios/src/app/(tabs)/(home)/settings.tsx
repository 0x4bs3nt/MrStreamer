import type { AppError } from "@mrstreamer/contracts/errors";
import type { AccountStatus } from "@mrstreamer/contracts/subscription";
import { kindOf } from "@mrstreamer/core/ondemand/catalogue";
import { router } from "expo-router";
import { isPictureInPictureSupported } from "expo-video";
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { disconnect, loadCatalogue, useCatalogue, useSession } from "../../../account.ts";
import { describeError } from "../../../errors.ts";
import {
  hasTmdb,
  loadTitles,
  useMetadataStatus,
  useTitleLists,
  useTitleTimings,
  type TitleLists,
} from "../../../titles.ts";
import { colors, TextButton } from "../../../ui.tsx";

/**
 * The subscription, its movies and series and TMDB, so far. Several subscriptions, guides,
 * languages, preferences and privacy come here as they come to iOS. TMDB's terms ask for its
 * logo and notice, as the desktop's Settings show them.
 */
export default function Settings() {
  const session = useSession();
  const catalogue = useCatalogue();
  const lists = useTitleLists();
  const tmdb = useMetadataStatus();
  const timings = useTitleTimings();
  if (session.kind !== "signed-in") return null;
  const { subscription, account } = session;
  return (
    <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic">
      <Text style={styles.section} accessibilityRole="header">
        Subscription
      </Text>
      <Line label="Server" value={subscription.server.replace(/^https?:\/\//, "")} />
      <Line label="Username" value={subscription.username} />
      <Line label="Account" value={accountLine(account)} />
      <Line
        label="Channels"
        value={
          catalogue.kind === "ready"
            ? String(catalogue.library.byId.size)
            : catalogue.kind === "failed"
              ? describeError(catalogue.error)
              : "Loading"
        }
      />
      <Line label="Films" value={countOf(lists, "movie")} />
      <Line label="Series" value={countOf(lists, "series")} />
      <Line
        label="TMDB"
        value={
          !hasTmdb
            ? "No key in this build"
            : !tmdb
              ? "Waiting for the lists"
              : tmdb.refused
                ? "Refused the key"
                : tmdb.known < tmdb.wanted
                  ? `${tmdb.known} of ${tmdb.wanted} titles`
                  : `${tmdb.known} titles`
        }
      />
      <View style={styles.actions}>
        <TextButton label="Reload channels" onPress={loadCatalogue} />
        <TextButton label="Reload films and series" onPress={loadTitles} />
        <TextButton label="Disconnect" onPress={() => void disconnect()} destructive />
      </View>
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
      {__DEV__ ? (
        <>
          <Text style={styles.section} accessibilityRole="header">
            Development
          </Text>
          <Line
            label="Films and series lists"
            value={
              timings ? `read ${timings.fetched} ms, indexed ${timings.indexed} ms` : "Not read"
            }
          />
          <Line
            label="Picture in Picture"
            value={isPictureInPictureSupported() ? "Supported" : "Not supported here"}
          />
          <View style={styles.actions}>
            <TextButton label="Runtime proof" onPress={() => router.push("/proof")} />
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

function countOf(lists: TitleLists, kind: "movie" | "series"): string {
  if (lists.kind === "ready") return String(kindOf(lists.index, kind).titles.length);
  return lists.kind === "failed" ? describeError(lists.error) : "Loading";
}

function accountLine(account: AccountStatus | AppError | null): string {
  if (!account) return "Checking";
  if ("kind" in account) return describeError(account);
  const parts = [account.state === "active" ? "Active" : account.state];
  if (account.expiresAt) parts.push(`until ${new Date(account.expiresAt).toLocaleDateString()}`);
  if (account.maxConnections !== null) {
    parts.push(`${account.activeConnections ?? 0} of ${account.maxConnections} connections`);
  }
  return parts.join(" · ");
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
    marginTop: 16,
    marginHorizontal: 16,
  },
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
  label: { color: colors.text, fontSize: 17 },
  value: { color: colors.dim, fontSize: 17, flexShrink: 1, textAlign: "right" },
  actions: { marginHorizontal: 16, marginTop: 8 },
  notice: { marginHorizontal: 16, marginTop: 32, marginBottom: 24, gap: 10 },
  logo: { width: 108, height: 14 },
  noticeText: { color: colors.dim, fontSize: 13, lineHeight: 18 },
});
