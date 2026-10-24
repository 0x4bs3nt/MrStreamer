import { COLLECTION_SORTS, type TitleKind } from "@mrstreamer/contracts/ondemand";
import type { QualityHint } from "@mrstreamer/contracts/title-filters";
import { TITLE_LANGUAGES } from "@mrstreamer/core/ondemand/languages";
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { DEFAULT_BROWSE, type BrowseChoices, type BrowsedCollection } from "./title-browse.ts";

const sorts = { added: "Recently added", popular: "Popular", rating: "Rating", title: "Title" };
const qualities: Record<QualityHint, string> = {
  "4k": "4K",
  "full-hd": "Full HD",
  hd: "HD",
  sd: "SD",
  unknown: "Unknown",
};
const languageName = (code: string) =>
  TITLE_LANGUAGES.find((language) => language.code === code)?.name ??
  (code === "multi" ? "Multiple languages" : "Unknown");

/** One native sheet, with scrollable choices that grow with the viewer's text size. */
export function BrowseControls({
  kind,
  choices,
  result,
  onChange,
}: {
  kind: TitleKind;
  choices: BrowseChoices;
  result: BrowsedCollection | null;
  onChange: (choices: BrowseChoices) => void;
}) {
  const [open, setOpen] = useState(false);
  const noun = kind === "movie" ? "movies" : "series";
  const count = result ? `${result.titles.length} of ${result.total} ${noun}` : null;
  const active = Boolean(choices.sort || choices.filters.quality || choices.filters.language);
  return (
    <View>
      <View style={styles.summary}>
        {count ? (
          <Text style={styles.text} accessibilityLiveRegion="polite">
            {count}
          </Text>
        ) : null}
        <Choice label="Sort & filter" selected={active} onPress={() => setOpen(true)} />
      </View>
      {open ? (
        <Modal
          visible
          presentationStyle="pageSheet"
          animationType="slide"
          onRequestClose={() => setOpen(false)}
        >
          <SafeAreaView
            accessibilityViewIsModal
            style={styles.sheet}
            edges={["top", "bottom", "left", "right"]}
          >
            <ScrollView contentContainerStyle={styles.content}>
              <Text style={styles.heading} accessibilityRole="header">
                Sort & filter
              </Text>
              {count ? (
                <Text style={styles.text} accessibilityLiveRegion="polite">
                  {count}
                </Text>
              ) : null}
              <Text style={styles.section} accessibilityRole="header">
                Sort
              </Text>
              {COLLECTION_SORTS.map((sort) => (
                <Choice
                  key={sort}
                  label={sorts[sort]}
                  selected={(choices.sort ?? result?.sort) === sort}
                  onPress={() => onChange({ ...choices, sort })}
                />
              ))}
              <Text style={styles.section} accessibilityRole="header">
                Quality
              </Text>
              <Choice
                label="Any quality"
                selected={!choices.filters.quality}
                onPress={() => {
                  const { quality: _quality, ...filters } = choices.filters;
                  onChange({ ...choices, filters });
                }}
              />
              {result?.qualities.map(({ value, count }) => (
                <Choice
                  key={value}
                  label={`${qualities[value]} · ${count}`}
                  selected={choices.filters.quality === value}
                  onPress={() =>
                    onChange({ ...choices, filters: { ...choices.filters, quality: value } })
                  }
                />
              ))}
              {choices.filters.quality &&
              !result?.qualities.some(({ value }) => value === choices.filters.quality) ? (
                <Text style={styles.text}>
                  Selected quality: {qualities[choices.filters.quality]}. No matching files listed.
                </Text>
              ) : null}
              <Text style={styles.section} accessibilityRole="header">
                File language
              </Text>
              <Text style={styles.text}>
                Quality and language are provider name hints, not verified tracks.
              </Text>
              <Choice
                label="Any file language"
                selected={!choices.filters.language}
                onPress={() => {
                  const { language: _language, ...filters } = choices.filters;
                  onChange({ ...choices, filters });
                }}
              />
              {result?.languages.map(({ value, count }) => (
                <Choice
                  key={value}
                  label={`${languageName(value)} · ${count}`}
                  selected={choices.filters.language === value}
                  onPress={() =>
                    onChange({ ...choices, filters: { ...choices.filters, language: value } })
                  }
                />
              ))}
              {choices.filters.language &&
              !result?.languages.some(({ value }) => value === choices.filters.language) ? (
                <Text style={styles.text}>
                  Selected file language: {languageName(choices.filters.language)}. No matching
                  files listed.
                </Text>
              ) : null}
              <Text style={styles.section} accessibilityRole="header">
                Known audio/subtitles
              </Text>
              <Text style={styles.text}>
                Unavailable. Verified track information is not available for this catalogue.
              </Text>
              <Choice label="Reset" onPress={() => onChange(DEFAULT_BROWSE)} />
              <Choice
                label={result ? `Show ${result.titles.length} ${noun}` : "Done"}
                onPress={() => setOpen(false)}
              />
            </ScrollView>
          </SafeAreaView>
        </Modal>
      ) : null}
    </View>
  );
}

function Choice({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? {} : { selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.choice, pressed && { opacity: 0.6 }]}
    >
      <Text style={styles.text}>
        {label}
        {selected ? " ✓" : ""}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  summary: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  sheet: { flex: 1, backgroundColor: "#000000" },
  content: { padding: 20, paddingBottom: 32 },
  heading: { color: "#FFFFFF", fontSize: 28, fontWeight: "700", marginBottom: 12 },
  section: { color: "#FFFFFF", fontSize: 20, fontWeight: "600", marginTop: 24, marginBottom: 8 },
  text: { color: "#FFFFFF", fontSize: 17, flexShrink: 1 },
  choice: { minHeight: 44, justifyContent: "center", paddingVertical: 10 },
});
