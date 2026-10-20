import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { tabHref, useTabs } from "../../../header.tsx";
import { licences } from "../../../licences.ts";
import { colors } from "../../../ui.tsx";

/**
 * Settings' Licences: the app, then every component this build carries, a row each with its
 * licence. A row opens its notices (`licence.tsx`) on the tab Settings is on.
 */
export default function Licences() {
  const tab = useTabs()?.tab ?? "(home)";
  return (
    <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic">
      {licences.components.map(({ id, name, licence }) => (
        <Pressable
          key={id}
          accessibilityRole="button"
          accessibilityLabel={`${name}, ${licence}`}
          onPress={() => router.push({ pathname: tabHref(tab, "licence"), params: { id } })}
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          testID={`licence-${id}`}
        >
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.licence} numberOfLines={1}>
            {licence}
          </Text>
          <SymbolView name="chevron.right" size={14} tintColor={colors.dim} weight="semibold" />
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    marginHorizontal: 16,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pressed: { opacity: 0.5 },
  name: { color: colors.text, fontSize: 17, flexShrink: 1 },
  licence: { color: colors.dim, fontSize: 15, flex: 1, textAlign: "right" },
});
