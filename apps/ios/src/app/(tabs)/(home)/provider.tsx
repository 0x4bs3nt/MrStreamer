import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useLayoutEffect } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { useRoster } from "../../../account.ts";
import { ProviderForm } from "../../../provider-form.tsx";
import { colors, Message } from "../../../ui.tsx";

/**
 * Settings' Add provider, or a saved provider's Edit when `id` names it: the form Connect shows,
 * pushed on Home's stack. Saving goes back to Settings.
 */
export default function Provider() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const navigation = useNavigation();
  const roster = useRoster();
  const member =
    id && roster.kind === "ready" ? roster.members.find((each) => each.entry.id === id) : null;
  useLayoutEffect(() => {
    navigation.setOptions({ title: member ? member.label : "Add provider" });
  }, [navigation, member]);
  if (id && !member) return <Message text="This provider was removed." />;
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <ProviderForm
        mode={member ? { kind: "edit", member } : { kind: "add" }}
        onDone={() => router.back()}
      />
      <Text style={styles.footnote}>The password stays in this iPhone's Keychain.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  content: { padding: 24, gap: 16 },
  footnote: { color: colors.dim, fontSize: 13 },
});
