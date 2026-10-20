import { Alert, Linking } from "react-native";

/** Opens `url` in the system's browser. When iOS won't, an alert gives the address to type in. */
export function openLink(url: string) {
  Linking.openURL(url).catch(() => Alert.alert("Couldn't open the link", url));
}
