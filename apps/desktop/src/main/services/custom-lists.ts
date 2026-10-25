// The viewer's channel lists: named, in an order of the viewer's, each holding exact channels of
// any saved subscriptions in an order of its own. Nothing joins two subscriptions' channels, and
// no channel is ever found by its name.
//
// A channel of a list is kept under its subscription's account by every stream id it was seen
// with (platform/custom-lists-store.ts), so it is the same channel after the provider lists it
// under another id, joins it with another or splits it again, and after its subscription is
// removed and added again. Which channel it is, the catalogue says each time the lists are read:
// the first of its streams the catalogue knows. After each fetch of a subscription's channels,
// what its channels in lists were seen as is brought in line, so a channel is followed from one
// fetch to the next: the stream it was found by stays first, and the streams it has now join it.
//
// What the viewer sees of a list:
// - a channel its subscription lists, once, by its id;
// - one its saved subscription lists none of the streams of now: by its last name, to take out;
// - one of a subscription that isn't saved: counted, not shown, and back once it is saved again;
// - nothing for adults, listed or not, counted or not, while Settings hides them.
// A saved subscription whose channels aren't at hand yet, as before its first fetch, shows none.
//
// A change to a list's channels names a channel by its subscription, which has to be saved, with
// the login it had when the channel was looked up, when the change is stored: what arrives after
// it went is stored for none. That is asked in the change's own transaction, so a removal that
// erases the account comes wholly before or after it. Each change is told to the UI after it is
// stored. Nothing here logs the name of a list or a channel.
import type { CustomList, CustomListMember } from "@mrstreamer/contracts/custom-lists";
import { CUSTOM_LIST_NAME_MAX } from "@mrstreamer/contracts/custom-lists";
import type { CatalogueStatus, LiveChannel } from "@mrstreamer/contracts/library";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { Failed } from "@mrstreamer/core/failure";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import {
  CustomListStore,
  type ListedChannel,
  type StoredList,
  type StoredMember,
} from "../platform/custom-lists-store.ts";
import { Library } from "./library.ts";
import { Settings } from "./preferences.ts";
import { sameSource, Subscriptions, type SavedSubscription } from "./subscription.ts";

export class CustomLists extends Context.Service<
  CustomLists,
  {
    /** Every list, in the viewer's order, as the viewer may see it now. */
    readonly lists: Effect.Effect<readonly CustomList[], Failed>;
    /**
     * Makes a list called `name`, trimmed, after the others, holding `channel` when given. The
     * window makes up `id`: sent again, it answers the list it made. Fails with `list-name-taken`
     * when another is called the same, apart from case and accents, with `no-list` for a list
     * made under `id` and deleted since, and for `channel` as `setMember` does. Answers the lists.
     */
    create(input: {
      readonly id: string;
      readonly name: string;
      readonly channel?: OwnedId | undefined;
    }): Effect.Effect<readonly CustomList[], Failed>;
    /** Calls a list `name`, trimmed. Fails as `create` does, and with `no-list`. */
    rename(id: string, name: string): Effect.Effect<readonly CustomList[], Failed>;
    /**
     * Puts the lists in `order`, by their ids. Fails with `list-changed`, changing nothing,
     * unless it names every list there is.
     */
    order(order: readonly string[]): Effect.Effect<readonly CustomList[], Failed>;
    /** Deletes a list and every channel it holds, of every account, saved or not. */
    remove(id: string): Effect.Effect<readonly CustomList[], Failed>;
    /**
     * Puts a channel, by its id or any of its streams', at the end of a list, or takes it out.
     * Adding one there already, or taking out one that isn't, changes nothing. Fails with
     * `no-list`, `channel-not-found` when its subscription doesn't list it, and `no-subscription`
     * when that subscription isn't saved, or went or had its login stored anew meanwhile.
     */
    setMember(
      list: string,
      channel: OwnedId,
      member: boolean,
    ): Effect.Effect<readonly CustomList[], Failed>;
    /** Takes a channel out of a list by its member id, as for one its subscription no longer lists. */
    removeMember(list: string, member: string): Effect.Effect<readonly CustomList[], Failed>;
    /**
     * Puts the channels of a list `order` names, by member id, in that order, in the places they
     * had among the list's channels; every other keeps its place. Fails with `list-changed`,
     * saving nothing, when the list's `revision` is another now, or `order` names a channel twice
     * or one the list doesn't show as listed now, or the subscriptions changed meanwhile.
     */
    arrange(input: {
      readonly list: string;
      readonly revision: number;
      readonly order: readonly string[];
    }): Effect.Effect<readonly CustomList[], Failed>;
    /** Says so after each change of a list. */
    readonly changes: Stream.Stream<void>;
  }
>()("mrstreamer/CustomLists") {
  static readonly layer = Layer.effect(CustomLists, make());
}

/** A saved subscription with its channels as its catalogue has them now. */
interface Catalogued {
  readonly subscription: SavedSubscription;
  /** Its channel by its id or any of its streams', in its catalogue as it is when asked. */
  readonly channelOf: (id: string) => LiveChannel | undefined;
  /** When its catalogue was fetched, or null without one at hand. */
  readonly fetchedAt: number | null;
}

/** Every stream id of a channel, its own first. */
function streamsOf(channel: LiveChannel): string[] {
  return [...new Set([channel.id, ...channel.variants.map((variant) => variant.id)])];
}

/** The channel a stored one is now, by the first of its streams the catalogue knows, and that stream. */
function resolve(
  channelOf: Catalogued["channelOf"],
  stored: StoredMember,
): { readonly channel: LiveChannel; readonly via: string } | null {
  for (const via of stored.streams) {
    const channel = channelOf(via);
    if (channel) return { channel, via };
  }
  return null;
}

/**
 * A list as the viewer may see it, with `found` saved and adults shown or not: see the top of
 * this file.
 */
function shownOf(found: readonly Catalogued[], adults: boolean, list: StoredList): CustomList {
  const byAccount = new Map(found.map((each) => [each.subscription.key, each]));
  const members: CustomListMember[] = [];
  const seen = new Set<string>();
  let away = 0;
  for (const stored of list.members) {
    const owner = byAccount.get(stored.account);
    if (!owner) {
      if (adults || !stored.adult) away++;
      continue;
    }
    if (owner.fetchedAt === null) continue;
    const resolved = resolve(owner.channelOf, stored);
    if (!resolved) {
      if (adults || !stored.adult) {
        members.push({
          member: stored.member,
          kind: "unlisted",
          name: stored.name,
          subscriptionId: owner.subscription.id,
        });
      }
      continue;
    }
    if (resolved.channel.adult && !adults) continue;
    const channel = { subscriptionId: owner.subscription.id, id: resolved.channel.id };
    // Two of its channels the provider joined since show as one.
    if (seen.has(ownedKey(channel))) continue;
    seen.add(ownedKey(channel));
    members.push({ member: stored.member, kind: "listed", channel });
  }
  return { id: list.id, name: list.name, revision: list.revision, members, away };
}

function make() {
  return Effect.gen(function* () {
    const subscriptions = yield* Subscriptions;
    const library = yield* Library;
    const settings = yield* Settings;
    const store = yield* CustomListStore;
    const changes = yield* PubSub.unbounded<void>();
    const noSubscription = new Failed({ error: { kind: "no-subscription" } });
    const listChanged = new Failed({ error: { kind: "list-changed" } });
    /** The fetch of its channels each subscription's channels in lists were last aligned to. */
    let alignedTo: ReadonlyMap<string, number> = new Map();

    /** Whether lists show channels for adults. */
    const adults = Effect.map(settings.get, (preferences) => preferences.adultTitles ?? false);

    /** The saved subscriptions in their order, each with its channels. */
    const catalogued = Effect.gen(function* () {
      const statuses = yield* library.status;
      return yield* Effect.forEach(yield* subscriptions.saved, (subscription) =>
        Effect.map(library.lookup(subscription.id), (channelOf): Catalogued => ({
          subscription,
          channelOf,
          fetchedAt:
            statuses.find((status) => status.subscriptionId === subscription.id)?.fetchedAt ?? null,
        })),
      );
    });

    /**
     * Gives `subscription`'s channels in lists what its catalogue has them as now: their name and
     * adult mark, and every stream they have. Answers whether that is done; when it isn't, they
     * stay as they were and the next call tries again.
     */
    const align = (subscription: SavedSubscription) =>
      Effect.gen(function* () {
        const channelOf = yield* library.lookup(subscription.id);
        // Its catalogue went meanwhile, or the subscription did: asked last, with nothing waiting
        // after.
        if (!(yield* subscriptions.stands(subscription))) return false;
        yield* store.align(subscription.key, (stored) => {
          const resolved = resolve(channelOf, stored);
          if (!resolved) return null;
          const { channel, via } = resolved;
          return {
            streams: [...new Set([via, ...streamsOf(channel), ...stored.streams])],
            name: channel.title,
            adult: channel.adult === true,
          };
        });
        return true;
      }).pipe(
        Effect.catchTag("Failed", (failed) =>
          Effect.as(
            Effect.logWarning("[lists] the lists' channels keep what they had", failed.error),
            false,
          ),
        ),
      );

    /** Aligns each saved subscription whose catalogue was fetched since it was last aligned. */
    const alignTo = (statuses: readonly CatalogueStatus[]) =>
      Effect.gen(function* () {
        for (const subscription of yield* subscriptions.saved) {
          const fetchedAt = statuses.find(
            (status) => status.subscriptionId === subscription.id,
          )?.fetchedAt;
          if (fetchedAt === null || fetchedAt === undefined) continue;
          if (alignedTo.get(subscription.id) === fetchedAt) continue;
          if (yield* align(subscription)) {
            alignedTo = new Map([...alignedTo, [subscription.id, fetchedAt]]);
          }
        }
      });

    // After every fetch of a subscription's channels, so a channel is followed from one to the
    // next: what the provider lists under another id today and drops another stream of tomorrow
    // is found by what it was last.
    yield* Effect.forkScoped(Stream.runForEach(library.changes, (status) => alignTo([status])));

    const lists = Effect.gen(function* () {
      // Catalogues this run read from disk, as one fetched by an older build, are aligned first.
      yield* Effect.flatMap(library.status, alignTo);
      const found = yield* catalogued;
      const shown = yield* adults;
      return (yield* store.lists).map((list) => shownOf(found, shown, list));
    });

    /** Answers the lists after a change, told to the UI once stored when it changed anything. */
    const after = (changed: boolean) =>
      Effect.andThen(changed ? PubSub.publish(changes, undefined) : Effect.void, lists);

    const nameOf = (name: string) => {
      const trimmed = name.trim();
      return trimmed.length > 0 && trimmed.length <= CUSTOM_LIST_NAME_MAX
        ? Effect.succeed(trimmed)
        : Effect.fail(
            new Failed({
              error: {
                kind: "invalid-input",
                detail: `A list's name has 1 to ${CUSTOM_LIST_NAME_MAX} characters.`,
              },
            }),
          );
    };

    /**
     * A channel as a change names it, with its subscription and catalogue: `no-subscription` for
     * one that isn't saved, `channel-not-found` when it doesn't list the channel.
     */
    const listedOf = (named: OwnedId) =>
      Effect.gen(function* () {
        const subscription = (yield* subscriptions.saved).find(
          (each) => each.id === named.subscriptionId,
        );
        if (!subscription) return yield* noSubscription;
        const channelOf = yield* library.lookup(subscription.id);
        const channel = channelOf(named.id);
        if (!channel) {
          // The lookup reads the saved subscriptions again, and finds nothing of one that went
          // since: that is a subscription that went, not a channel it doesn't list.
          if (!subscriptions.standsNow(subscription)) return yield* noSubscription;
          return yield* new Failed({ error: { kind: "channel-not-found", channelId: named.id } });
        }
        const listed: ListedChannel = {
          account: subscription.key,
          streams: streamsOf(channel),
          name: channel.title,
          adult: channel.adult === true,
          stands: () => subscriptions.standsNow(subscription),
        };
        return { subscription, channelOf, channel, listed };
      });

    const service: CustomLists["Service"] = {
      lists,

      create: ({ id, name, channel }) =>
        Effect.gen(function* () {
          const named = yield* nameOf(name);
          const first = channel ? yield* listedOf(channel) : null;
          const at = yield* Clock.currentTimeMillis;
          yield* store.create({ id, name: named, first: first?.listed ?? null, at });
          return yield* after(true);
        }),

      rename: (id, name) =>
        Effect.gen(function* () {
          yield* store.rename(id, yield* nameOf(name));
          return yield* after(true);
        }),

      order: (order) => Effect.andThen(store.order(order), after(true)),

      remove: (id) => Effect.andThen(store.remove(id), after(true)),

      setMember: (list, named, member) =>
        Effect.gen(function* () {
          const { channelOf, channel, listed } = yield* listedOf(named);
          const at = yield* Clock.currentTimeMillis;
          const changed = yield* store.setMember({
            list,
            channel: listed,
            member,
            // As the list shows its channels: one the provider joined with this one is this one.
            same: (stored) => resolve(channelOf, stored)?.channel.id === channel.id,
            at,
          });
          return yield* after(changed);
        }),

      removeMember: (list, member) => Effect.flatMap(store.removeMember(list, member), after),

      arrange: ({ list, revision, order }) =>
        Effect.gen(function* () {
          const found = yield* catalogued;
          const shown = yield* adults;
          // The order was made from the channels of the subscriptions saved then.
          const saved = yield* subscriptions.saved;
          if (
            saved.length !== found.length ||
            saved.some((each, at) => !sameSource(each, found[at]?.subscription))
          ) {
            return yield* listChanged;
          }
          const changed = yield* store.arrange({
            list,
            revision,
            order,
            shown: (members) =>
              new Set(
                shownOf(found, shown, { id: list, name: "", revision, members }).members.flatMap(
                  (each) => (each.kind === "listed" ? [each.member] : []),
                ),
              ),
          });
          return yield* after(changed);
        }),

      changes: Stream.fromPubSub(changes),
    };
    return service;
  });
}
