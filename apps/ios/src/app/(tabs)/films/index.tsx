import { ScrollView, StyleSheet } from "react-native";
import { Message } from "../../../ui.tsx";

/** The Films tab, in place. Browsing, details and playback of films aren't on iOS yet. */
export default function Films() {
  return (
    <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic">
      <Message text="Films aren't on iPhone yet." />
    </ScrollView>
  );
}

const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: "#000000" } });
