import { ScrollView, StyleSheet } from "react-native";
import { Message } from "../../../ui.tsx";

/** Where downloads will be. Downloading and offline playback aren't on iOS yet. */
export default function Downloads() {
  return (
    <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic">
      <Message text="Downloads aren't on iPhone yet." />
    </ScrollView>
  );
}

const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: "#000000" } });
