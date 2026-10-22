import { lazy } from "@mrstreamer/contracts/lazy";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import type { FavouriteGroup } from "@mrstreamer/core/viewing/service";
import { type } from "arktype";

// Which of a provider's stream ids were seen together in one channel, for the favourites alone:
// the memory viewing.ts keeps beside the record (core's), so a favourite stays one favourite while
// its provider lists some of its qualities and not others, across launches. Pure: viewing.ts reads
// and writes it, with the record, in viewing.json.
//
// Per account, a cohort holds two or more stream ids, and each id is in one cohort at most. A
// cohort is kept while it holds a stream the record keeps as a favourite. The channels listed now
// always win: a cohort whose ids one channel lists takes that channel's other streams in; one the
// lists split between channels goes, its listed ids following their channels and the others left
// on their own until one channel lists them together again. Two of a provider's channels that
// list one stream share it, so what they list is one cohort, and a cohort they alone list isn't
// split, its streams no list shows staying in it. A provider whose channels don't show
// tells nothing, so its cohorts stay as they are. No name, and no other provider, ever joins them.

/** A group of one account's stream ids seen together in one channel. */
export type Cohort = readonly string[];

/** Every account's cohorts, by its record key: its subscription's id on iOS. */
export type Membership = Readonly<Record<string, readonly Cohort[]>>;

/** The field in viewing.json, as this build writes it. */
export interface MembershipFile {
  readonly version: 1;
  readonly accounts: Membership;
}

/** viewing.json's field as read: none, one this build reads, or one it keeps as it is. */
export type ReadMembership =
  | { readonly kind: "none" }
  | { readonly kind: "read"; readonly membership: Membership }
  /** Another version, or a version 1 this build can't trust: written back unchanged, unused. */
  | { readonly kind: "kept"; readonly value: unknown };

const Version1 = lazy(() => type({ version: "1", accounts: type.Record("string", "string[][]") }));

/** Reads viewing.json's `favouriteMembership`, trusting only a well-formed version 1. */
export function readMembership(value: unknown): ReadMembership {
  if (value === undefined) return { kind: "none" };
  const parsed = Version1()(value);
  if (parsed instanceof type.errors) return { kind: "kept", value };
  for (const cohorts of Object.values(parsed.accounts)) {
    const seen = new Set<string>();
    for (const cohort of cohorts) {
      if (cohort.length < 2) return { kind: "kept", value };
      for (const id of cohort) {
        if (seen.has(id)) return { kind: "kept", value };
        seen.add(id);
      }
    }
  }
  return { kind: "read", membership: parsed.accounts };
}

/** The field to write for `membership`; none while it holds nothing. */
export function membershipFile(membership: Membership): MembershipFile | undefined {
  return Object.keys(membership).length > 0 ? { version: 1, accounts: membership } : undefined;
}

/** A subscription's channels now, by the `ownedKey` of each channel and stream. */
type ChannelsNow = ReadonlyMap<string, LiveChannel>;

/** A channel's stream ids, its own first. */
const idsOf = (channel: LiveChannel) => [
  ...new Set([channel.id, ...channel.variants.map(({ id }) => id)]),
];

/**
 * The lower of two stream ids, by number when both are numbers: the rule core's catalogue names
 * a channel by (`lower` in core/catalogue/variants.ts, not exported), so a wholly hidden
 * favourite shows by the id its channel would.
 */
function lower(a: string, b: string): string {
  const numbers = /^\d+$/.test(a) && /^\d+$/.test(b);
  return (numbers ? Number(b) < Number(a) : b < a) ? b : a;
}

/**
 * One account's cohorts after the record's `starred` stream ids and its subscription's channels
 * now, looked up by those ids and the cohorts' alone. `channels` without the subscription's
 * channels changes nothing but what `starred` no longer backs.
 */
function reconcileAccount(
  subscriptionId: string,
  kept: readonly Cohort[],
  starred: readonly string[],
  channels: ChannelsNow,
): Cohort[] {
  const channelOf = (id: string) => channels.get(ownedKey({ subscriptionId, id }));
  // Each channel listed now that one of these ids is in, by its id, with the ids it takes in.
  const joined = new Map<string, Set<string>>();
  const join = (channel: LiveChannel, ids: Iterable<string>) => {
    const group = joined.get(channel.id) ?? new Set(idsOf(channel));
    for (const id of ids) group.add(id);
    joined.set(channel.id, group);
  };
  const next: Cohort[] = [];
  for (const cohort of kept) {
    const hits = new Map(
      cohort.flatMap((id) => {
        const channel = channelOf(id);
        return channel ? [[channel.id, channel] as const] : [];
      }),
    );
    if (hits.size === 0) next.push(cohort);
    // Its streams listed are one channel's, listed once or in channels sharing its streams: the
    // others are that channel's too. Asked of every channel found, two of one id included, as
    // the one linking the others can be.
    else if (connected([...new Set(cohort.flatMap((id) => channelOf(id) ?? []))]))
      for (const channel of hits.values()) join(channel, cohort);
    // Split between channels: listed ids follow theirs, the others go on their own.
    else for (const channel of hits.values()) join(channel, []);
  }
  // A favourite's channel with several streams is a cohort of its own.
  for (const id of starred) {
    const channel = channelOf(id);
    if (channel) join(channel, []);
  }
  const backed = new Set(starred);
  return disjoint([...next, ...[...joined.values()].map((group) => [...group])]).filter(
    (cohort) => cohort.length > 1 && cohort.some((id) => backed.has(id)),
  );
}

/**
 * Whether `channels` are all one channel's streams: each shares a stream with another, however
 * they chain, as a panel listing a stream's row in two categories makes them.
 */
function connected(channels: readonly LiveChannel[]): boolean {
  const [first, ...rest] = channels;
  if (!first) return false;
  const reached = new Set(idsOf(first));
  let left = rest;
  for (;;) {
    const joining = left.filter((channel) => idsOf(channel).some((id) => reached.has(id)));
    if (joining.length === 0) return left.length === 0;
    for (const channel of joining) for (const id of idsOf(channel)) reached.add(id);
    left = left.filter((channel) => !joining.includes(channel));
  }
}

/**
 * `cohorts` with every two that share an id made one, however they chain: the same stream two
 * of a provider's channels list, as a panel listing a stream's row in two categories does, is one
 * favourite's either way. So each id is in one cohort at most, as `readMembership` requires.
 */
function disjoint(cohorts: readonly Cohort[]): Cohort[] {
  const groups: Set<string>[] = [];
  for (const cohort of cohorts) {
    const sharing = groups.filter((group) => cohort.some((id) => group.has(id)));
    const union = new Set([...sharing.flatMap((group) => [...group]), ...cohort]);
    groups.splice(0, groups.length, ...groups.filter((group) => !sharing.includes(group)), union);
  }
  return groups.map((group) => [...group]);
}

/**
 * Every account's cohorts after the record's favourites, by account, and the channels shown now.
 * An account the record no longer holds, as one erased, loses its cohorts with it.
 */
export function reconcile(
  membership: Membership,
  favourites: ReadonlyMap<string, readonly string[]>,
  channels: ChannelsNow,
): Membership {
  const next: Record<string, readonly Cohort[]> = {};
  for (const [account, starred] of favourites) {
    const cohorts = reconcileAccount(account, membership[account] ?? [], starred, channels);
    if (cohorts.length > 0) next[account] = cohorts;
  }
  return next;
}

/** Whether two memberships hold the same cohorts, in the same order. */
export const sameMembership = (a: Membership, b: Membership) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Which favourite each of a subscription's stream ids is, for core's `ViewingChannels.favourite`:
 * the channel listed now, with its cohort's streams no other channel lists; while none of a
 * cohort is listed, the cohort under its lowest id; nothing for an id of no cohort and no channel,
 * or of a cohort two channels list now.
 */
export function favouriteOf(
  subscriptionId: string,
  cohorts: readonly Cohort[],
  channels: ChannelsNow,
): (streamId: string) => FavouriteGroup | undefined {
  const cohortOf = new Map(cohorts.flatMap((cohort) => cohort.map((id) => [id, cohort] as const)));
  const channelOf = (id: string) => channels.get(ownedKey({ subscriptionId, id }));
  return (streamId) => {
    const cohort = cohortOf.get(streamId) ?? [streamId];
    const own = channelOf(streamId);
    const listed = new Map(
      cohort.flatMap((id) => {
        const channel = channelOf(id);
        return channel ? [[channel.id, channel] as const] : [];
      }),
    );
    const [only, ...more] = listed.values();
    const channel = own ?? (more.length === 0 ? only : undefined);
    if (channel) {
      // The cohort's streams no other channel lists now go with it.
      const others = cohort.filter((id) => {
        const listedIn = channelOf(id);
        return !listedIn || listedIn.id === channel.id;
      });
      return { id: channel.id, streamIds: [...new Set([...idsOf(channel), ...others])] };
    }
    if (listed.size > 0 || cohort.length < 2) return undefined;
    return { id: cohort.reduce(lower), streamIds: cohort };
  };
}
