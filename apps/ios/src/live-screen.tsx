import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  ActionSheetIOS,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {
  playChannel,
  reloadAllChannels,
  retry,
  retryChannels,
  useCatalogue,
  useRoster,
} from "./account.ts";
import { failureOf } from "./errors.ts";
import { starChannel, useFavouriteKeys } from "./favourites.ts";
import { FavouritesEntry } from "./favourites-screen.tsx";
import { Glass, IconButton } from "./glass.tsx";
import { tabHref } from "./header.tsx";
import type { Channel, Library, Region, Shelf } from "./library.ts";
import { Docked, libraryStatus, loadingStatus, PlaceholderRows, useDockInset } from "./loading.tsx";
import { channelStatus, usePlayback } from "./playback.ts";
import { useSavedState, writeState } from "./storage.ts";
import { store, useStore } from "./store.ts";
import { ShelfHead, TextTabs } from "./titles-ui.tsx";
import { ChannelLogo, ChannelRow, colors, Message, Notice, useRowHeight } from "./ui.tsx";

// Live, in Movies' and Series' shape: a large title, its Favourites row, which opens every
// favourite (favourites-screen.tsx), and Find countries or categories, which finds them by name
// in every provider's channels (live-discover.tsx), then For you, Categories and All as text
// tabs, with the country first in their row, reading All countries until one is chosen. All lists
// every channel of every provider and country once, in a virtualised list of rows of one fixed
// height, and is where Live opens at launch. For you leads with the channel watched last and Play,
// then the recent channels and a few categories as shelves of logos; Categories is every category
// as a tile. A category's shelf or tile opens all its channels, pushed on Live's stack. Nothing
// plays until a tile, a row or Play is pressed, and each plays in Watch; a row's star stars or
// unstars its channel and plays nothing. A "country" is the
// provider's group, which can be a language or a label. Rows and tiles show the channel's category
// or quality until iOS reads a guide, which brings now and next. While channels first load, still
// rows hold the list's place; what loads or failed by provider is the status line at the bottom,
// with Retry and Settings, over the channels already there.

type Tab = "for-you" | "categories" | "all";

/** How many channels a shelf of For you shows. */
const TILES = 12;
/** How many categories For you shows as shelves; Categories has every one. */
const SHELVES = 6;

/**
 * The tab and country Live shows, kept while the viewer goes elsewhere and comes back. Each launch
 * starts on All of every country; the country chosen last stays in `state.json` for Home only.
 */
const place = store<{ readonly tab: Tab; readonly region: string | null }>({
  tab: "all",
  region: null,
});

/** A category in its region, as For you's shelves and Categories' tiles show it. */
interface Category {
  readonly region: Region;
  readonly shelf: Shelf;
}

/** "News · Netherlands", or "News" for a category that stands alone or a country already chosen. */
const nameOf = ({ region, shelf }: Category, chosen = false) =>
  chosen || shelf.title === region.name ? shelf.title : `${shelf.title} · ${region.name}`;

/** Where a category's channels open, by its region and title, which name it across providers. */
export const categoryHref = ({ region, shelf }: Category) =>
  `/live/category?region=${encodeURIComponent(region.name)}&name=${encodeURIComponent(shelf.title)}` as const;

/**
 * Live shows `region`'s channels from now on, every one again with null, on the tab it showed.
 * Home's On now shows the country chosen last until channels are watched.
 */
export function chooseCountry(region: Region | null) {
  if (region) writeState((state) => ({ ...state, region: region.name }));
  place.set((current) => ({ ...current, region: region?.name ?? null }));
}

/** Settings, on Live's own stack. */
const openSettings = () => router.push(tabHref("live", "settings"));

/** Plays `channel` in Watch, named by where it shows. */
const watch = (library: Library, channel: Channel) =>
  playChannel(channel, library.placeOf.get(channel.key) ?? "", { watch: true });

/** The Live tab. Its Favourites and Find rows show whatever the channels' state. */
export function LiveHome() {
  return <Channels lead={<Entries />}>{(library) => <Browse library={library} />}</Channels>;
}

/**
 * Live's own rows, before its tabs: Favourites, and Find countries or categories. On the tab only:
 * a category's screen has neither.
 */
function Entries() {
  return (
    <>
      <FavouritesEntry />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Find countries or categories"
        onPress={() => router.push("/live/discover")}
        style={({ pressed }) => [styles.find, pressed && styles.pressed]}
        testID="live-discover"
      >
        <SymbolView name="magnifyingglass" size={15} tintColor={colors.dim} />
        <Text style={styles.findText}>Find countries or categories</Text>
      </Pressable>
    </>
  );
}

/** All of one category's channels, pushed over Live by its region and title. */
export function CategoryScreen({ region, name }: { region: string; name: string }) {
  return (
    <Channels>
      {(library) => {
        const found = library.regions.find((each) => each.name === region);
        const shelf = found?.shelves.find((each) => each.title === name);
        if (!found || !shelf) {
          return (
            <Still>
              <Message text="This category isn't listed any more." />
            </Still>
          );
        }
        return (
          <ChannelList
            library={library}
            channels={shelf.channels}
            header={<Text style={styles.categoryName}>{nameOf({ region: found, shelf })}</Text>}
            testID="live-category-list"
          />
        );
      }}
    </Channels>
  );
}

/**
 * Live's screens with the channels there are, under the status line; still rows while the first
 * list loads, the failure when no provider's list came, or that the providers list no channels.
 * `lead` goes first in those three, as the screen with channels leads with it in its own list.
 * Each of the three is in a `Still`, as the channels are in their list, so it starts below the
 * header.
 */
function Channels({
  lead,
  children,
}: {
  lead?: ReactNode;
  children: (library: Library) => ReactNode;
}) {
  const catalogue = useCatalogue();
  const roster = useRoster();
  const height = useRowHeight();
  const providers = roster.kind === "ready" ? roster.members : [];
  // One provider is named; several are "your providers".
  const host = providers.length === 1 && providers[0] ? providers[0].label : "";
  // With no channels at all, the failure has the screen to itself instead.
  const status =
    catalogue.kind === "failed"
      ? null
      : libraryStatus(providers, { channels: true, retry, settings: openSettings });
  if (catalogue.kind === "loading") {
    return (
      <Docked status={status ?? loadingStatus("channels")}>
        <Still>
          {lead}
          <PlaceholderRows height={height} />
        </Still>
      </Docked>
    );
  }
  if (catalogue.kind === "failed") {
    const failure = failureOf(catalogue.error, catalogue.member.entry.server);
    return (
      <Still>
        {lead}
        <Notice
          failure={{
            headline: "Couldn't load channels",
            advice: [failure.headline, failure.advice].filter(Boolean).join(". "),
          }}
          actions={[
            { label: "Try again", onPress: retryChannels },
            { label: "Provider settings", onPress: openSettings },
          ]}
        />
      </Still>
    );
  }
  if (catalogue.library.regions.length === 0) {
    return (
      <Docked status={status}>
        <Still>
          {lead}
          <Notice
            failure={{
              headline: "No live channels",
              advice: `${host || "Your providers"} ${host ? "lists" : "list"} no live channels.`,
            }}
            actions={[{ label: "Reload", onPress: reloadAllChannels }]}
          />
        </Still>
      </Docked>
    );
  }
  return <Docked status={status}>{children(catalogue.library)}</Docked>;
}

/**
 * What a Live screen shows in place of channels, as the screen's own scrolling content: the
 * header's and status bar's insets keep it below them, as the channels' list is, and its end
 * clears the status line.
 */
function Still({ children }: { children: ReactNode }) {
  const inset = useDockInset();
  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: inset }}
    >
      {children}
    </ScrollView>
  );
}

function Browse({ library }: { library: Library }) {
  const kept = useStore(place);
  const region =
    kept.region === null
      ? null
      : (library.regions.find((each) => each.name === kept.region) ?? null);
  // Categories within the country chosen, or every country's: as many as the provider lists.
  const categories = useMemo(
    () =>
      (region ? [region] : library.regions).flatMap((each) =>
        each.shelves.map((shelf) => ({ region: each, shelf })),
      ),
    [library, region],
  );
  // With one category or none in every country together, a shelf or tile would only repeat All.
  // A country chosen with one keeps the tab Live showed, as Find countries or categories does; one
  // with none, as Other channels, shows All, the tab kept for when it is cleared.
  const browsable =
    (region === null || region.shelves.length > 0) &&
    library.regions.reduce((count, each) => count + each.shelves.length, 0) > 1;
  const tabs: readonly { value: Tab; label: string }[] = browsable
    ? [
        { value: "for-you", label: "For you" },
        { value: "categories", label: "Categories" },
        { value: "all", label: "All" },
      ]
    : [{ value: "all", label: "All" }];
  const tab = browsable ? kept.tab : "all";
  // A country chosen before is kept by name: one a refresh took away says so until another is.
  const gone = kept.region !== null && region === null ? kept.region : null;
  const countries = library.regions.length > 1 || gone !== null;

  // Live's own rows lead, scrolling with the list, before the country and the tabs.
  const header = (
    <>
      <Entries />
      {countries || tabs.length > 1 ? (
        <>
          {gone ? <Text style={styles.note}>{`${gone} isn't listed any more.`}</Text> : null}
          <TextTabs
            lead={
              countries ? (
                <Country regions={library.regions} chosen={region} onChoose={chooseCountry} />
              ) : null
            }
            tabs={tabs}
            value={tab}
            onChange={(next) => place.set((current) => ({ ...current, tab: next }))}
          />
        </>
      ) : null}
    </>
  );

  const key = `${tab}\n${region?.name ?? ""}`;
  if (tab === "for-you") {
    return (
      <ForYou key={key} library={library} region={region} categories={categories} header={header} />
    );
  }
  if (tab === "categories") {
    return (
      <CategoryGrid key={key} categories={categories} chosen={region !== null} header={header} />
    );
  }
  return (
    <ChannelList
      key={key}
      library={library}
      channels={region?.channels ?? library.channels}
      header={header}
      testID="live-list"
    />
  );
}

/**
 * Channels as rows of one fixed height in a virtualised list, with what goes above them. Rows are
 * placed by their index, after the header's measured height.
 */
function ChannelList({
  library,
  channels,
  header,
  testID,
}: {
  library: Library;
  channels: readonly Channel[];
  header: ReactNode;
  testID: string;
}) {
  const height = useRowHeight();
  const inset = useDockInset();
  const playing = channelStatus(usePlayback().phase);
  const favourites = useFavouriteKeys();
  const [top, setTop] = useState(0);
  const onPress = useCallback((channel: Channel) => watch(library, channel), [library]);
  // Rows draw again when a star or what plays changes.
  const playingNow = playing && `${playing.id} ${playing.word}`;
  const extraData = useMemo(() => ({ favourites, playingNow }), [favourites, playingNow]);
  return (
    <FlatList
      style={styles.screen}
      data={channels}
      keyExtractor={(channel) => channel.key}
      extraData={extraData}
      ListHeaderComponent={
        <View onLayout={(event) => setTop(event.nativeEvent.layout.height)}>{header}</View>
      }
      renderItem={({ item }) => (
        <ChannelRow
          channel={item}
          detail={library.placeOf.get(item.key) ?? ""}
          status={item.key === playing?.id ? playing.word : null}
          height={height}
          onPress={onPress}
          favourite={favourites.has(item.key)}
          onFavourite={starChannel}
        />
      )}
      getItemLayout={(_, index) => ({ length: height, offset: top + height * index, index })}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: inset }}
      initialNumToRender={16}
      maxToRenderPerBatch={16}
      windowSize={9}
      removeClippedSubviews
      testID={testID}
    />
  );
}

/**
 * For you: the channel watched last with Play, the recent channels, then the first categories as
 * shelves. Within a chosen country, only its channels show, and the lead only when the channel
 * watched last is one of them. Every shelf is a slice, so a large catalogue builds a few tiles.
 */
function ForYou({
  library,
  region,
  categories,
  header,
}: {
  library: Library;
  region: Region | null;
  categories: readonly Category[];
  header: ReactNode;
}) {
  const inset = useDockInset();
  const playing = channelStatus(usePlayback().phase);
  const { recentChannels } = useSavedState();
  const recent = useMemo(() => {
    // By the channel each key names: a key can be one of its streams'.
    const seen = new Set<string>();
    const found: Channel[] = [];
    for (const key of recentChannels ?? []) {
      const channel = library.byKey.get(key);
      if (!channel || seen.has(channel.key)) continue;
      seen.add(channel.key);
      found.push(channel);
    }
    const listed =
      region && found.length > 0 ? new Set(region.channels.map((channel) => channel.key)) : null;
    const shown = listed ? found.filter((channel) => listed.has(channel.key)) : found;
    const last = found[0];
    return { lead: last && shown[0] === last ? last : null, shown };
  }, [library, region, recentChannels]);
  const onPress = useCallback((channel: Channel) => watch(library, channel), [library]);
  const lineOf = (channel: Channel, otherwise: string) =>
    channel.key === playing?.id
      ? playing.word
      : channel.ambiguous
        ? (library.labels.get(channel.subscriptionId) ?? otherwise)
        : otherwise;
  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: 32 + inset }}
      testID="live-for-you"
    >
      {header}
      {recent.lead ? (
        <Lead
          channel={recent.lead}
          line={
            recent.lead.key === playing?.id
              ? playing.word
              : ["Last watched", library.placeOf.get(recent.lead.key)].filter(Boolean).join(" · ")
          }
          onPlay={onPress}
        />
      ) : null}
      {recent.shown.length > 0 ? (
        <Tiles
          name="Recent"
          channels={recent.shown}
          line={(channel) =>
            lineOf(channel, (library.placeOf.get(channel.key) ?? "").split(" · ").at(-1) ?? "")
          }
          onPress={onPress}
        />
      ) : null}
      {categories.slice(0, SHELVES).map((category) => (
        <Tiles
          key={category.shelf.id}
          name={nameOf(category, region !== null)}
          channels={category.shelf.channels.slice(0, TILES)}
          total={category.shelf.channels.length}
          onAll={() => router.push(categoryHref(category))}
          line={(channel) => lineOf(channel, channel.tags.join(" "))}
          onPress={onPress}
        />
      ))}
    </ScrollView>
  );
}

/** The channel watched last, its logo on a wide dark tile, with Play: nothing plays before it. */
function Lead({
  channel,
  line,
  onPlay,
}: {
  channel: Channel;
  line: string;
  onPlay: (channel: Channel) => void;
}) {
  return (
    <View style={styles.lead} testID="live-lead">
      <View style={styles.leadLogo} pointerEvents="none">
        <ChannelLogo channel={channel} style={styles.leadMark} large />
      </View>
      <View style={styles.caption} pointerEvents="none">
        <Text style={styles.leadTitle} numberOfLines={1}>
          {channel.title}
          {channel.tags.length > 0 ? (
            <Text style={styles.leadTags}>{`  ${channel.tags.join(" ")}`}</Text>
          ) : null}
        </Text>
        <Text style={styles.leadLine} numberOfLines={2}>
          {line}
        </Text>
      </View>
      <Glass style={styles.capsule}>
        <IconButton
          symbol="play.fill"
          label={`Play ${channel.title}`}
          onPress={() => onPlay(channel)}
          testID="live-play"
        />
      </Glass>
    </View>
  );
}

/** A titled row of channel logos scrolling sideways, as Home's On now has them. */
function Tiles({
  name,
  channels,
  total,
  onAll,
  line,
  onPress,
}: {
  name: string;
  channels: readonly Channel[];
  total?: number;
  onAll?: () => void;
  line: (channel: Channel) => string;
  onPress: (channel: Channel) => void;
}) {
  return (
    <View style={styles.shelf}>
      <ShelfHead name={name} total={total ?? channels.length} onAll={onAll} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tiles}
      >
        {channels.map((channel) => {
          const shown = line(channel);
          return (
            <Pressable
              key={channel.key}
              accessibilityRole="button"
              accessibilityLabel={[channel.title, shown].filter(Boolean).join(", ")}
              onPress={() => onPress(channel)}
              style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
              testID={`live-tile-${channel.key}`}
            >
              <ChannelLogo channel={channel} style={styles.tileLogo} large />
              <Text style={styles.tileName} numberOfLines={1}>
                {channel.title}
              </Text>
              {shown ? (
                <Text style={styles.tileLine} numberOfLines={1}>
                  {shown}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** Categories: every category as a tile of its first four logos, two to a row, virtualised. */
function CategoryGrid({
  categories,
  chosen,
  header,
}: {
  categories: readonly Category[];
  /** Whether a country is chosen, which the tiles then leave out. */
  chosen: boolean;
  header: ReactNode;
}) {
  const inset = useDockInset();
  const { width } = useWindowDimensions();
  const tile = Math.floor((width - 42) / 2);
  const cell = Math.floor((tile - 4) / 2);
  return (
    <FlatList
      style={styles.screen}
      data={categories}
      numColumns={2}
      keyExtractor={(category) => category.shelf.id}
      ListHeaderComponent={header ? <View style={styles.gridHead}>{header}</View> : undefined}
      renderItem={({ item }) => {
        const count = item.shelf.channels.length;
        const line = [
          chosen || item.shelf.title === item.region.name ? null : item.region.name,
          String(count),
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${nameOf(item, chosen)}, ${count}`}
            onPress={() => router.push(categoryHref(item))}
            style={({ pressed }) => [{ width: tile }, pressed && styles.pressed]}
            testID={`live-category-${item.shelf.id}`}
          >
            <View style={styles.logos}>
              {item.shelf.channels.slice(0, 4).map((channel) => (
                <ChannelLogo
                  key={channel.key}
                  channel={channel}
                  style={{ width: cell, height: Math.round((cell * 10) / 16) }}
                />
              ))}
            </View>
            <Text style={styles.tileName} numberOfLines={1}>
              {item.shelf.title}
            </Text>
            <Text style={styles.tileLine} numberOfLines={1}>
              {line}
            </Text>
          </Pressable>
        );
      }}
      columnWrapperStyle={styles.gridRow}
      contentContainerStyle={[styles.grid, { paddingBottom: 24 + inset }]}
      contentInsetAdjustmentBehavior="automatic"
      initialNumToRender={10}
      maxToRenderPerBatch={10}
      windowSize={7}
      removeClippedSubviews
      testID="live-categories"
    />
  );
}

/**
 * The country, first in the row of tabs: All countries until one is chosen. Pressing it lists
 * them as a system sheet; a chosen one has a button that clears it.
 */
function Country({
  regions,
  chosen,
  onChoose,
}: {
  regions: readonly Region[];
  chosen: Region | null;
  onChoose: (region: Region | null) => void;
}) {
  const name = chosen?.name ?? "All countries";
  const open = () =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: "Country",
        options: [
          chosen ? "All countries" : "✓ All countries",
          ...regions.map((each) => (each === chosen ? `✓ ${each.name}` : each.name)),
          "Cancel",
        ],
        cancelButtonIndex: regions.length + 1,
      },
      (index) => {
        if (index === 0) onChoose(null);
        const next = regions[index - 1];
        if (next) onChoose(next);
      },
    );
  return (
    <View style={styles.country}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Country, ${name}`}
        accessibilityHint="Lists the countries"
        onPress={open}
        style={({ pressed }) => [styles.countryButton, pressed && styles.pressed]}
        testID="live-country"
      >
        <Text style={styles.countryName} numberOfLines={1}>
          {name}
        </Text>
        {chosen ? null : (
          <SymbolView name="chevron.down" size={12} tintColor={colors.text} weight="semibold" />
        )}
      </Pressable>
      {chosen ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Clear ${chosen.name}`}
          onPress={() => onChoose(null)}
          style={({ pressed }) => [styles.clear, pressed && styles.pressed]}
          testID="live-country-clear"
        >
          <SymbolView name="xmark" size={12} tintColor={colors.text} weight="semibold" />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  pressed: { opacity: 0.6 },
  note: { color: colors.text, fontSize: 15, marginHorizontal: 16, marginVertical: 12 },
  find: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 16,
  },
  findText: { color: colors.dim, fontSize: 17 },
  categoryName: {
    color: colors.text,
    fontSize: 28,
    fontWeight: "700",
    marginHorizontal: 16,
    marginBottom: 8,
  },
  // The name keeps 200 points beside the clear button, which takes 44.
  country: { flexDirection: "row", alignItems: "center", maxWidth: 244 },
  countryButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minWidth: 44,
    minHeight: 44,
    flexShrink: 1,
  },
  countryName: { color: colors.text, fontSize: 15, fontWeight: "600", flexShrink: 1 },
  clear: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  lead: {
    marginHorizontal: 16,
    marginTop: 8,
    aspectRatio: 16 / 9,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "#000000",
    borderColor: colors.line,
    borderWidth: StyleSheet.hairlineWidth,
  },
  leadLogo: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  leadMark: { width: "34%", aspectRatio: 16 / 10, backgroundColor: "transparent" },
  caption: { position: "absolute", left: 12, right: 72, bottom: 12 },
  leadTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  leadTags: { color: colors.dim, fontSize: 13, fontWeight: "400" },
  leadLine: { color: colors.text, fontSize: 13, marginTop: 2 },
  capsule: { position: "absolute", right: 10, bottom: 10, borderRadius: 22, paddingHorizontal: 2 },
  shelf: { marginTop: 18 },
  tiles: { paddingHorizontal: 16, gap: 10 },
  tile: { width: 112 },
  tileLogo: { width: 112, height: 63 },
  tileName: { color: colors.text, fontSize: 13, marginTop: 6 },
  tileLine: { color: colors.dim, fontSize: 12, marginTop: 1 },
  grid: { paddingHorizontal: 16, gap: 14 },
  gridHead: { marginHorizontal: -16, marginBottom: 4 },
  gridRow: { gap: 10 },
  logos: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
});
