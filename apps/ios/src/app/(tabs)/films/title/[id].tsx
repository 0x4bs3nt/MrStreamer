import { useLocalSearchParams } from "expo-router";
import { DetailsScreen } from "../../../../details-screen.tsx";

export default function FilmsDetails() {
  // `id` is the version's `ownedKey`: the subscription that lists it, then its own id.
  const { id } = useLocalSearchParams<{ id: string }>();
  return <DetailsScreen kind="movie" version={id} />;
}
