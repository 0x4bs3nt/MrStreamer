import { isCollectionId } from "@mrstreamer/contracts/ondemand";
import { useLocalSearchParams } from "expo-router";
import { CollectionScreen } from "../../../../titles-screen.tsx";
import { Message } from "../../../../ui.tsx";

export default function FilmsCollection() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return isCollectionId(id) ? (
    <CollectionScreen kind="movie" id={id} />
  ) : (
    <Message text="Nothing here." />
  );
}
