import { ScrollView, StyleSheet } from "react-native";
import { Message } from "../../../ui.tsx";

/** The Series tab, in place. Browsing, details and playback of series aren't on iOS yet. */
export default function Series() {
  return (
    <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic">
      <Message text="Series aren't on iPhone yet." />
    </ScrollView>
  );
}

const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: "#000000" } });
