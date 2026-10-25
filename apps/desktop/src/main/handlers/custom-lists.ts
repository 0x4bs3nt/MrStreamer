import type { HandlersFor } from "../ipc.ts";
import type { CustomLists } from "../services/custom-lists.ts";

export function customListHandlers({
  customLists,
}: {
  readonly customLists: CustomLists["Service"];
}): HandlersFor<"customLists"> {
  return {
    "customLists.get": () => customLists.lists,
    "customLists.create": ({ id, name, channel }) => customLists.create({ id, name, channel }),
    "customLists.rename": ({ id, name }) => customLists.rename(id, name),
    "customLists.order": ({ order }) => customLists.order(order),
    "customLists.remove": ({ id }) => customLists.remove(id),
    "customLists.setMember": ({ list, channel, member }) =>
      customLists.setMember(list, channel, member),
    "customLists.removeMember": ({ list, member }) => customLists.removeMember(list, member),
    "customLists.arrange": ({ list, revision, order }) =>
      customLists.arrange({ list, revision, order }),
  };
}
