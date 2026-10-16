import { useLocalSearchParams } from "expo-router";
import { DetailsScreen } from "../../../../details-screen.tsx";

export default function SeriesDetails() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <DetailsScreen kind="series" id={id} />;
}
