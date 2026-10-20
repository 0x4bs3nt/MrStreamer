import { useLocalSearchParams, useNavigation } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useLayoutEffect } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { licenceOf, noticeText } from "../../../licences.ts";
import { openLink } from "../../../open-link.ts";
import { colors, Message } from "../../../ui.tsx";

/**
 * One component of Licences, by `id`: its licence and facts, where its source is, then each of its
 * notices in full, as the build carries them. The source opens in the browser; the rest needs no
 * network.
 */
export default function Licence() {
  const { id = "" } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const component = licenceOf(id);
  useLayoutEffect(() => {
    navigation.setOptions({ title: component?.name ?? "" });
  }, [navigation, component]);
  if (!component) return <Message text="This build has no such licence." />;
  return (
    <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic">
      <Fact label="Licence" value={component.licence} />
      {component.facts.map((fact) => (
        <Fact key={fact.label} {...fact} />
      ))}
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="Source code"
        accessibilityHint={component.source}
        onPress={() => openLink(component.source)}
        style={({ pressed }) => [styles.line, pressed && styles.pressed]}
        testID="licence-source"
      >
        <Text style={styles.label}>Source code</Text>
        <Text style={styles.value} numberOfLines={2}>
          {component.source.replace(/^https:\/\//, "")}
        </Text>
        <SymbolView name="chevron.right" size={14} tintColor={colors.dim} weight="semibold" />
      </Pressable>
      {component.notices.map((notice) => (
        <View key={notice.title} style={styles.notice}>
          <Text style={styles.title} accessibilityRole="header">
            {notice.title}
          </Text>
          {/* A paragraph each: one Text of a whole licence lays out slowly. */}
          {noticeText(notice)
            .split(/\n[ \t]*\n/)
            .map((paragraph, at) => (
              <Text key={at} style={styles.text} selectable>
                {paragraph}
              </Text>
            ))}
        </View>
      ))}
      <View style={styles.end} />
    </ScrollView>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.line} accessible accessibilityLabel={`${label}, ${value}`}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value} numberOfLines={3}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  line: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 16,
    minHeight: 44,
    paddingVertical: 8,
    marginHorizontal: 16,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pressed: { opacity: 0.5 },
  label: { color: colors.text, fontSize: 17 },
  value: { color: colors.dim, fontSize: 15, flexShrink: 1, textAlign: "right" },
  notice: { marginHorizontal: 16, marginTop: 24, gap: 10 },
  title: { color: colors.text, fontSize: 17, fontWeight: "600" },
  text: { color: colors.text, fontSize: 13, lineHeight: 18 },
  end: { height: 32 },
});
