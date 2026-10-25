// Channel lists the viewer makes and names: global, in an order of the viewer's, each holding
// exact channels of any saved subscription in an order of its own. The main process keeps them
// (apps/desktop/src/main/services/custom-lists.ts) and says what each holds as the catalogues and
// Settings show it now.
import type { OwnedId } from "./subscription.ts";

/** The most characters a list's name has, once trimmed. */
export const CUSTOM_LIST_NAME_MAX = 60;

/** A channel of a list, as the viewer may see it now. */
export type CustomListMember =
  /** Its subscription lists it: by the channel's own id. */
  | { readonly member: string; readonly kind: "listed"; readonly channel: OwnedId }
  /**
   * Its subscription is saved and lists none of its streams now, as when the provider dropped
   * it: by the name it had when last listed.
   */
  | {
      readonly member: string;
      readonly kind: "unlisted";
      readonly name: string;
      readonly subscriptionId: string;
    };

export interface CustomList {
  readonly id: string;
  readonly name: string;
  /** Rises with every change to its channels or their order. `arrange` refuses an older one. */
  readonly revision: number;
  /**
   * In the list's order, each channel once, with nothing for adults while Settings hides them,
   * listed or not.
   */
  readonly members: readonly CustomListMember[];
  /**
   * Channels it keeps for accounts whose subscription isn't saved, which show again once it is.
   * None for adults is counted while Settings hides them.
   */
  readonly away: number;
}
