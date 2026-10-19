import { useLocalSearchParams } from "expo-router";
import { CategoryScreen } from "../../../live-screen.tsx";

/** One category's channels, by its region and title (`categoryHref` in live-screen.tsx). */
export default function LiveCategory() {
  const { region = "", name = "" } = useLocalSearchParams<{ region: string; name: string }>();
  return <CategoryScreen region={region} name={name} />;
}
