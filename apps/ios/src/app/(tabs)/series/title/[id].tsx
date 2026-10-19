import { useLocalSearchParams } from "expo-router";
import { DetailsScreen } from "../../../../details-screen.tsx";

export default function SeriesDetails() {
  // `id` is the version's `ownedKey`: the subscription that lists it, then its own id. `asked`
  // when that version itself was asked for (resume.ts `detailsHref`).
  const { id, asked } = useLocalSearchParams<{ id: string; asked?: string }>();
  return <DetailsScreen kind="series" version={id} asked={asked === "1"} />;
}
