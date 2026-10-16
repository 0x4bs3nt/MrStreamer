import { useLocalSearchParams } from "expo-router";
import { DetailsScreen } from "../../../../details-screen.tsx";

export default function FilmsDetails() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <DetailsScreen kind="movie" id={id} />;
}
