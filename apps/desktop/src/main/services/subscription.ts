import type { UsageObservers } from "../analytics/observers.ts";
// The saved subscriptions: each validated with its provider and stored with a sealed password or,
// for a playlist, a sealed link. Every one of them shows in the app at once; none is "the active
// one".
//
// subscription.json is the login as every release has kept it, and the newest stable release
// still reads and writes it: it stays the only place for that login, its sealed secret and the
// account's status. The subscription it holds is the original. A subscription added beside it
// keeps the same file in a folder of its own, subscriptions/<id>, with the lists loaded from it
// and what the viewer left it at, where no older release looks.
//
// subscriptions.json, the registry, lists the saved subscriptions in the order they were added
// and gives each the id the rest of the app names it by. An entry holds that id, the account it
// was given to, as its server and username or a playlist's fingerprint, and the name the viewer
// gave it; never the password or a playlist's link. The entry marked `original` is the one whose
// login subscription.json holds. An entry this build can't read stays as it found it, in its
// place.
//
// The files are written one after the other, the login first, and a stable release changes
// subscription.json without the registry. So each start settles them, with the logins deciding
// (see `settle`): the original's account keeps its id while it stays the same account, an added
// subscription is there while its folder holds its login, and nothing else is touched. An account
// shows once: a folder that holds one saved already stays as it is, and isn't shown. What an
// account loaded and what the viewer kept stay under the account's own key.
import { createHash, randomUUID } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import {
  PlaylistMapping,
  type PlaylistMode,
  type PlaylistGroupPage,
  type PlaylistOmissionPage,
} from "@mrstreamer/contracts/playlist";
import { mapPlaylistGroup, playlistGroupId, safeName } from "@mrstreamer/core/playlist/import";
import type { LoginInput } from "@mrstreamer/contracts/ipc";
import type { AccountStatus, SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { diagnosed } from "@mrstreamer/core/diagnostics";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import type { Provider, ProviderOptions } from "@mrstreamer/core/provider";
import type { ImportedPlaylist } from "@mrstreamer/core/playlist/catalogue";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { t } from "@mrstreamer/core/i18n";
import {
  readJsonFile,
  removeFile,
  removeUnfinishedWrites,
  writeJsonFile,
} from "../platform/json-file.ts";
import type { Secrets } from "../platform/secrets.ts";
import { providerFor, type ProviderAccount } from "../providers/account.ts";
import {
  connectionIgnored,
  httpsUnavailable,
  parseLogin,
  type TcpConnect,
} from "../providers/xtream.ts";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";

const AccountRecord = lazy(() =>
  type({
    state: "'active' | 'expired' | 'banned' | 'disabled' | 'unknown'",
    expiresAt: "string | null",
    maxConnections: "number | null",
    activeConnections: "number | null",
  }),
);

// A playlist is a kind releases before it don't know: they read the file as no subscription, show
// Connect and leave the file alone until another login replaces it.
const StoredSubscription = lazy(() =>
  type({
    version: "1",
    kind: "'xtream'",
    server: "string",
    username: "string",
    sealedPassword: "string",
    account: AccountRecord(),
  }).or({
    version: "1",
    kind: "'m3u'",
    /** Where the playlist comes from, to show: its origin. The link itself is sealed. */
    server: "string",
    /**
     * Tells playlists apart without the link: `m3u:` and part of the SHA-256 of the link it was
     * added with. A link entered again later keeps it, so the playlist stays the same account.
     */
    key: "string",
    sealedLink: "string",
    "mapping?": PlaylistMapping(),
    account: AccountRecord(),
  }),
);
type StoredSubscription = Infer<typeof StoredSubscription>;

/** What an added subscription's folder is named by, and so the only ids one may have. */
const FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The registry's entry for the subscription whose login subscription.json holds. */
const OriginalEntry = lazy(() =>
  type({
    /** What the app names the subscription by: made up once, and never the login. */
    id: "string > 0",
    original: "true",
    /** The account the id was given to, as `keyOf` names it. Another account gets another id. */
    key: "string",
    /** What the viewer calls it, when they named it. */
    "name?": "string",
  }),
);

/** The registry's entry for a subscription added beside it, whose login its folder holds. */
const AddedEntry = lazy(() => type({ id: FOLDER, key: "string", "name?": "string" }));

/** subscriptions.json. Entries are read one by one, so one this build can't read costs no other. */
const Registry = lazy(() => type({ version: "1", subscriptions: "object[]" }));

/**
 * A saved subscription as other services know it, whether or not its password or link can be
 * read: its lists loaded before still show.
 */
export interface SavedSubscription {
  /** What channels, titles and requests name the subscription by. */
  readonly id: string;
  /**
   * Rises each time its login or secret is stored or read anew. What was asked of the provider
   * under an earlier one doesn't count for this one. A new name leaves it as it is.
   */
  readonly revision: number;
  /** Opaque saved-secret fingerprint. Stable across restarts, unlike revision. */
  readonly fileRevision: string;
  /**
   * The account: the server and username, or a playlist's fingerprint. Its caches and its viewing
   * record are kept under it, where other releases find them.
   */
  readonly key: string;
  readonly kind: "xtream" | "m3u";
  readonly playlistMapped?: boolean;
  /** Persistent fingerprint of import settings. Used to detect caches from before a change. */
  readonly importRevision?: string;
  /**
   * The folder its lists and what the viewer left it at are kept in: the data folder itself for
   * the original, where every release keeps them, and its own for one added beside it.
   */
  readonly dir: string;
  /** The one whose login subscription.json holds: the only one older releases know. */
  readonly original: boolean;
}

/** A saved subscription with its password or link at hand: what a provider can be asked with. */
export interface Source extends SavedSubscription {
  readonly provider: Provider;
  /** The login or link itself, for a worker thread that builds its own copy of the provider. */
  readonly account: ProviderAccount;
}

/** One source revision and one shared playlist read, including its failure, for both lists. */
export interface PlaylistRefresh {
  readonly source: Source;
  readonly read: Effect.Effect<ImportedPlaylist, Failed>;
}

/**
 * Whether `other` is `source` with the login or link it had then. What was asked of a provider
 * counts only while this holds: not once its subscription went, nor after its login changed.
 */
export function sameSource(
  source: SavedSubscription,
  other: SavedSubscription | null | undefined,
): boolean {
  return other?.id === source.id && other.revision === source.revision;
}

interface Provided {
  readonly provider: Provider;
  readonly account: ProviderAccount;
}

interface Saved {
  readonly id: string;
  readonly original: boolean;
  readonly name: string | null;
  readonly revision: number;
  readonly stored: StoredSubscription;
  /**
   * Null when the saved password or link cannot be read any more; the user has to enter it
   * again.
   */
  readonly provider: Provided | null;
}

export interface SubscriptionDeps {
  readonly usage?: UsageObservers | undefined;
  readonly dataDir: string;
  readonly secrets: Secrets;
  readonly providerOptions: ProviderOptions;
  /** Opens the connection that tries an address's https port. `net.connect`, except in tests. */
  readonly tcpConnect?: TcpConnect;
}

export class Subscriptions extends Context.Service<
  Subscriptions,
  {
    /** Every saved subscription, in the order they were added. */
    readonly list: Effect.Effect<readonly SubscriptionSummary[]>;
    /**
     * Checks the login with the provider, then saves it beside the others. The first one saved is
     * the original; a login of an account that is saved already gives that subscription its
     * secret anew and keeps its id, as `update` does and with what `update` does when the
     * subscription went or its login was stored anew meanwhile. An address without a scheme
     * connects over https or fails with `unencrypted-only`.
     */
    add(login: LoginInput): Effect.Effect<SubscriptionSummary, Failed>;
    /**
     * Gives a saved subscription another name, and another password or playlist link when
     * `secret` is set: checked with the provider first, then saved. Its id and its account stay.
     * A name of null or nothing takes it away.
     *
     * The provider can take its time, and the latest thing asked wins: once the subscription
     * went meanwhile this fails with `no-subscription`, and once its login was stored anew, or it
     * was named anew, that stays and this answers with the subscription as it is saved.
     */
    update(
      subscriptionId: string,
      change: { readonly name?: string | null | undefined; readonly secret?: string | undefined },
    ): Effect.Effect<SubscriptionSummary, Failed>;
    /**
     * Asks the provider for the latest account status (expiry, connections) and stores it, unless
     * the subscription was removed or its login changed while the provider answered.
     */
    recheck(subscriptionId: string): Effect.Effect<SubscriptionSummary, Failed>;
    /**
     * Forgets a subscription's login, and for one added beside the original, its folder. A folder
     * that kept the same account without showing it goes too.
     *
     * `erase` deletes what else the app kept for its account. It runs once the subscription is
     * saved no more and before its login goes, so nothing is kept for the account while it runs
     * or after. When it fails the removal fails with it, and the subscription is saved as it was.
     */
    remove(
      subscriptionId: string,
      erase?: Effect.Effect<void, Failed>,
    ): Effect.Effect<void, Failed>;
    playlistGroups(
      subscriptionId: string,
      query: string,
      offset: number,
      limit: number,
    ): Effect.Effect<PlaylistGroupPage, Failed>;
    playlistOmissions(
      subscriptionId: string,
      offset: number,
      limit: number,
    ): Effect.Effect<PlaylistOmissionPage, Failed>;
    mapPlaylist(
      subscriptionId: string,
      group: string,
      mode: PlaylistMode,
    ): Effect.Effect<SubscriptionSummary, Failed>;
    /** Every saved subscription as services know it, in the order added. */
    readonly saved: Effect.Effect<readonly SavedSubscription[]>;
    /** Those of them whose password or link is at hand, with the provider behind each. */
    readonly sources: Effect.Effect<readonly Source[]>;
    /**
     * The source of the subscription a request names. Fails with `no-subscription` when that one
     * isn't saved, as after it was removed, and with `needs-secret` while it has no password or
     * link.
     */
    sourceOf(subscriptionId: string): Effect.Effect<Source, Failed>;
    /** Whether `subscription` is still saved, with the login or link it had. */
    stands(subscription: SavedSubscription): Effect.Effect<boolean>;
  }
>()("mrstreamer/Subscriptions") {
  static readonly layer = (deps: SubscriptionDeps) => Layer.effect(Subscriptions, make(deps));
}

function make(deps: SubscriptionDeps) {
  return Effect.gen(function* () {
    const path = join(deps.dataDir, "subscription.json");
    const registryPath = join(deps.dataDir, "subscriptions.json");
    const addedDir = join(deps.dataDir, "subscriptions");
    let current: Promise<readonly Saved[]> | null = null;
    /**
     * The added folders `settle` found holding an account another subscription holds too, by
     * that account: kept as they are and not shown, and removed with the one that is.
     */
    const spare = new Map<string, string[]>();
    /** Counts the logins and secrets stored or read, for `SavedSubscription.revision`. */
    let revisions = 0;
    /**
     * Storage changes run one at a time. Provider requests happen before, so each change checks
     * that it still applies and a slow answer never overwrites a newer state.
     */
    const writeOne = (yield* Semaphore.make(1)).withPermits(1);
    const noSubscription = new Failed({ error: { kind: "no-subscription" } });

    const folderOf = (id: string) => join(addedDir, id);
    const loginPath = ({ id, original }: Pick<Saved, "id" | "original">) =>
      original ? path : join(folderOf(id), "subscription.json");

    /** The provider of a stored subscription, from its password or link `secret`. */
    function connected(stored: StoredSubscription, secret: string): Provided {
      const account: ProviderAccount =
        stored.kind === "xtream"
          ? { kind: "xtream", server: stored.server, username: stored.username, password: secret }
          : { kind: "m3u", link: secret, ...(stored.mapping ? { mapping: stored.mapping } : {}) };
      return { provider: providerFor(account, deps.providerOptions), account };
    }

    /** A login as it was read from disk, with its secret opened if the keychain still gives it. */
    const loaded = (
      id: string,
      original: boolean,
      name: string | undefined,
      stored: StoredSubscription,
    ): Saved => {
      const revision = ++revisions;
      try {
        const provider = connected(stored, deps.secrets.open(sealedOf(stored)));
        return { id, original, name: name ?? null, revision, stored, provider };
      } catch {
        // A new signature, a reset keychain or a denied prompt all end here.
        return { id, original, name: name ?? null, revision, stored, provider: null };
      }
    };

    /**
     * The login in an added subscription's folder: there, missing as after a removal cut short,
     * or something this build can't read, which it leaves alone.
     */
    const addedLogin = async (id: string) => {
      const file = join(folderOf(id), "subscription.json");
      const stored = await readJsonFile(file, StoredSubscription());
      if (stored) return stored;
      return (await stat(file).catch(() => null)) ? ("unreadable" as const) : ("missing" as const);
    };

    /**
     * What the files hold, made to agree, with the logins deciding. subscription.json is what a
     * stable release changes, and what a write cut short leaves ahead of the registry: the
     * account the registry knows keeps its id, while a first start with the registry, another
     * account and a registry that can't be read get a new one, and a login that is gone takes
     * its entry. An added subscription is saved while its folder holds its login: an entry
     * without one goes, as a removal cut short leaves it, and a folder with a login the registry
     * doesn't list, as an add cut short or a damaged registry leaves it, is listed again. An
     * account shows once: where the original now holds one that was added too, as after a stable
     * release connected it, the added one stays as it is with what the viewer left it at, and
     * shows again once the original is another account's.
     */
    const settle = async (): Promise<readonly Saved[]> => {
      const [stored, registry, folders] = await Promise.all([
        readJsonFile(path, StoredSubscription()),
        readRegistry(registryPath),
        readdir(addedDir).then(
          (names) => names.filter((name) => FOLDER.test(name)).sort(),
          () => [],
        ),
      ]);
      const roster: Saved[] = [];
      const entries: object[] = [];
      const accounts = new Set(stored ? [keyOf(stored)] : []);
      /** The folders an entry names, read or not: none of those is a leftover. */
      const named = new Set<string>();
      const original = !stored
        ? null
        : registry.original?.key === keyOf(stored)
          ? registry.original
          : { id: randomUUID(), original: true as const, key: keyOf(stored) };
      const keepOriginal = () => {
        if (!stored || !original) return;
        entries.push(original);
        roster.push(loaded(original.id, true, original.name, stored));
      };
      /**
       * Takes up an added subscription whose folder holds `login`. One whose account is saved
       * already is left as it is, with the entry `listed` it has.
       */
      const keepAdded = async (
        entry: Infer<typeof AddedEntry>,
        login: StoredSubscription,
        listed: object | null,
      ) => {
        const key = keyOf(login);
        if (accounts.has(key)) {
          if (listed) entries.push(listed);
          spare.set(key, [...(spare.get(key) ?? []), entry.id]);
          return;
        }
        accounts.add(key);
        await removeUnfinishedWrites(folderOf(entry.id));
        entries.push(key === entry.key ? entry : { ...entry, key });
        roster.push(loaded(entry.id, false, entry.name, login));
      };
      for (const [at, raw] of registry.entries.entries()) {
        if (at === registry.at) {
          keepOriginal();
          continue;
        }
        if ("id" in raw && typeof raw.id === "string") named.add(raw.id);
        const entry = "original" in raw ? null : AddedEntry()(raw);
        if (!entry || entry instanceof type.errors) {
          entries.push(raw);
          continue;
        }
        const login = await addedLogin(entry.id);
        if (login === "unreadable") entries.push(raw);
        // A removal cut short: the entry goes, with what is left of the lists.
        else if (login === "missing")
          await rm(folderOf(entry.id), { recursive: true, force: true });
        else await keepAdded(entry, login, raw);
      }
      if (registry.at === -1) keepOriginal();
      for (const id of folders) {
        if (named.has(id)) continue;
        const login = await addedLogin(id);
        // What a removal cut short left of the lists, with nothing to list them for.
        if (login === "missing") await rm(folderOf(id), { recursive: true, force: true });
        else if (login !== "unreadable") await keepAdded({ id, key: keyOf(login) }, login, null);
      }
      if (JSON.stringify(entries) !== JSON.stringify(registry.entries)) {
        // The ids hold for this run either way; a registry that can't be written is settled again.
        await writeJsonFile(registryPath, { version: 1, subscriptions: entries }).catch(
          (cause: unknown) => console.warn(`[storage] can't write ${registryPath}`, cause),
        );
      }
      return roster;
    };

    const load = Effect.promise(() => (current ??= settle()));

    /**
     * Sets or replaces a subscription's entry in the registry, or drops it with null. Every other
     * entry stays as the file holds it, in its place, and so does what else the entry held.
     */
    const writeEntry = async (of: Pick<Saved, "id" | "original">, saved: Saved | null) => {
      const { entries, at } = await readRegistry(registryPath);
      const index = of.original
        ? at
        : entries.findIndex((raw, each) => each !== at && "id" in raw && raw.id === of.id);
      const { name: _name, ...kept }: { name?: unknown } = entries[index] ?? {};
      const entry = saved && {
        ...kept,
        id: saved.id,
        ...(saved.original ? { original: true } : {}),
        key: keyOf(saved.stored),
        ...(saved.name === null ? {} : { name: saved.name }),
      };
      const rest = entries.filter((_, each) => each !== index);
      const subscriptions = !entry
        ? rest
        : index === -1
          ? [...rest, entry]
          : entries.with(index, entry);
      await writeJsonFile(registryPath, { version: 1, subscriptions });
    };

    /**
     * Stores a subscription in place of `previous`, or as one more without. The login goes
     * first: a write cut short after it leaves what the next start settles.
     */
    const save = (next: Saved, previous: Saved | null) =>
      Effect.promise(async () => {
        if (next.stored !== previous?.stored) await writeJsonFile(loginPath(next), next.stored);
        if (!previous || previous.name !== next.name) await writeEntry(next, next);
        const roster = await (current ?? []);
        current = Promise.resolve(
          previous ? roster.map((each) => (each === previous ? next : each)) : [...roster, next],
        );
        return summary(next);
      });

    /**
     * The login check `authenticated` for an https address the viewer typed without a scheme.
     * When https is what fails there, it fails with `unencrypted-only` instead. A port that leaves
     * the connection unanswered ends it that way within seconds (`connectionIgnored`). A server
     * that accepted the connection keeps the whole time a login gets.
     */
    const httpsOrAsk = (authenticated: Effect.Effect<AccountStatus, Failed>, server: string) => {
      const ask = new Failed({ error: { kind: "unencrypted-only", server } });
      return authenticated.pipe(
        Effect.mapError((failed) => (httpsUnavailable(failed.error) ? ask : failed)),
        Effect.raceFirst(
          Effect.promise((signal) => connectionIgnored(server, signal, deps.tcpConnect)).pipe(
            Effect.flatMap((ignored) => (ignored ? Effect.fail(ask) : Effect.never)),
          ),
        ),
      );
    };

    /** The provider's word on `provider`'s account, asked now. */
    const authenticate = (provider: Provider) =>
      Effect.tryPromise({ try: (signal) => provider.authenticate(signal), catch: failedWith });

    /** A password or a playlist's link, which can hold a token, sealed as the keychain seals it. */
    const seal = (secret: string) =>
      Effect.try({ try: () => deps.secrets.seal(secret), catch: failedWith });

    const publicOf = (subscription: Saved): SavedSubscription => ({
      id: subscription.id,
      revision: subscription.revision,
      fileRevision: createHash("sha256").update(sealedOf(subscription.stored)).digest("hex"),
      key: keyOf(subscription.stored),
      kind: subscription.stored.kind,
      ...(subscription.stored.kind === "m3u"
        ? {
            playlistMapped: !!subscription.stored.mapping,
            importRevision: createHash("sha256")
              .update(JSON.stringify(subscription.stored.mapping ?? null))
              .digest("hex"),
          }
        : {}),
      dir: subscription.original ? deps.dataDir : folderOf(subscription.id),
      original: subscription.original,
    });

    const sourceOf = (subscription: Saved): Source | null =>
      subscription.provider ? { ...publicOf(subscription), ...subscription.provider } : null;

    /** The saved subscription `subscriptionId` names, or `no-subscription`. */
    const find = (subscriptionId: string) =>
      Effect.flatMap(load, (roster) => {
        const found = roster.find((each) => each.id === subscriptionId);
        return found ? Effect.succeed(found) : Effect.fail(noSubscription);
      });

    /**
     * Runs a storage change on a subscription as it is saved when the change's turn comes: the
     * provider answered before, and it may have been stored anew meanwhile. Fails once it went.
     */
    const change = <A>(
      subscriptionId: string,
      apply: (latest: Saved) => Effect.Effect<A, Failed>,
    ) => writeOne(Effect.flatMap(find(subscriptionId), apply));

    return {
      list: Effect.map(load, (roster) => roster.map(summary)),

      add: (login: LoginInput) =>
        Effect.gen(function* () {
          const added = deps.usage?.action("playlist_added");
          const { account, schemeless } = yield* Effect.try({
            try: () => parseLogin(login),
            catch: failedWith,
          });
          const provider = providerFor(account, deps.providerOptions);
          const key = keyFor(account);
          // The subscription this login is entered again for, when its account is saved already.
          const before = (yield* load).find((each) => keyOf(each.stored) === key) ?? null;
          // An address typed without a scheme goes to http only once the viewer agrees: the
          // login would travel unencrypted. A playlist without a login keeps the https answer.
          const status = yield* account.kind === "xtream" && schemeless
            ? httpsOrAsk(authenticate(provider), account.server)
            : authenticate(provider);
          const sealed = yield* seal(account.kind === "xtream" ? account.password : account.link);
          const stored: StoredSubscription =
            account.kind === "xtream"
              ? {
                  version: 1,
                  kind: "xtream",
                  server: account.server,
                  username: account.username,
                  sealedPassword: sealed,
                  account: status,
                }
              : {
                  version: 1,
                  kind: "m3u",
                  server: new URL(account.link).origin,
                  key,
                  sealedLink: sealed,
                  account: status,
                };
          const name = named(login.name);
          return yield* writeOne(
            Effect.gen(function* () {
              const roster = yield* load;
              // The same account keeps its id: what the app names by it still means it.
              const previous = roster.find((each) => keyOf(each.stored) === key) ?? null;
              if (before) {
                // It went while the provider was asked, or its login was stored anew: that stays.
                if (!previous) return yield* noSubscription;
                if (previous.revision !== before.revision) return summary(previous);
              }
              const kept: StoredSubscription =
                stored.kind === "m3u" && previous?.stored.kind === "m3u"
                  ? {
                      ...stored,
                      ...(previous.stored.mapping ? { mapping: previous.stored.mapping } : {}),
                    }
                  : stored;
              const result = yield* save(
                {
                  id: previous?.id ?? randomUUID(),
                  // The first one saved is where every release looks for a login.
                  original: previous ? previous.original : roster.length === 0,
                  name: name ?? previous?.name ?? null,
                  revision: ++revisions,
                  stored: kept,
                  provider:
                    kept.kind === "m3u" && account.kind === "m3u"
                      ? connected(kept, account.link)
                      : { provider, account },
                },
                previous,
              );
              if (!previous) added?.();
              return result;
            }),
          );
        }).pipe(diagnosed("connect")),

      update: (
        subscriptionId: string,
        asked: { readonly name?: string | null | undefined; readonly secret?: string | undefined },
      ) =>
        Effect.gen(function* () {
          const subscription = yield* find(subscriptionId);
          const renamed = (latest: Saved) =>
            asked.name === undefined ? latest.name : named(asked.name);
          if (asked.secret === undefined) {
            return yield* change(subscriptionId, (latest) =>
              save({ ...latest, name: renamed(latest) }, latest),
            );
          }
          const { stored } = subscription;
          // A password is taken as typed, and a playlist's link made whole as a typed address is.
          const secret =
            stored.kind === "xtream" ? asked.secret : yield* playlistLink(asked.secret);
          const provider = connected(stored, secret);
          const account = yield* authenticate(provider.provider);
          const sealed = yield* seal(secret);
          return yield* change(subscriptionId, (latest) => {
            // A login stored while the provider was asked is the later one: it stays as it is.
            if (latest.revision !== subscription.revision) return Effect.succeed(summary(latest));
            // The playlist stays the account it was, under the key it has: only its link is new.
            const next: StoredSubscription =
              latest.stored.kind === "xtream"
                ? { ...latest.stored, sealedPassword: sealed, account }
                : { ...latest.stored, server: new URL(secret).origin, sealedLink: sealed, account };
            // A name given while the provider was asked stays too.
            const name = latest.name === subscription.name ? renamed(latest) : latest.name;
            return save({ ...latest, name, revision: ++revisions, stored: next, provider }, latest);
          });
        }),

      recheck: (subscriptionId: string) =>
        Effect.gen(function* () {
          const subscription = yield* find(subscriptionId);
          if (!subscription.provider) return summary(subscription);
          const account = yield* authenticate(subscription.provider.provider);
          return yield* change(subscriptionId, (latest) =>
            // What the provider said under a login that changed since says nothing of this one.
            latest.revision === subscription.revision
              ? save({ ...latest, stored: { ...latest.stored, account } }, latest)
              : Effect.succeed(summary(latest)),
          );
        }),

      remove: (subscriptionId: string, erase?: Effect.Effect<void, Failed>) =>
        writeOne(
          Effect.gen(function* () {
            // Settled first, so nothing a start still writes comes after the removal.
            const removed = deps.usage?.action("playlist_removed");
            const roster = yield* load;
            const subscription = roster.find((each) => each.id === subscriptionId);
            if (!subscription) return;
            // Saved no more before anything of it is deleted: what is asked for it from here on
            // finds no subscription, and keeps nothing for its account.
            current = Promise.resolve(roster.filter((each) => each !== subscription));
            if (erase) {
              // Nothing of it went yet, so it is saved again as it was. No other change had
              // its turn meanwhile.
              yield* Effect.onError(erase, () =>
                Effect.sync(() => {
                  current = Promise.resolve(roster);
                }),
              );
            }
            yield* Effect.promise(async () => {
              // The sealed password or link first, then the id that named its subscription.
              if (subscription.original) await removeFile(path);
              else await rm(folderOf(subscription.id), { recursive: true, force: true });
              await writeEntry(subscription, null);
              // A folder that kept the same account would show in its place from the next start.
              const key = keyOf(subscription.stored);
              for (const id of spare.get(key) ?? []) {
                await rm(folderOf(id), { recursive: true, force: true });
                await writeEntry({ id, original: false }, null);
              }
              spare.delete(key);
            });
            removed?.();
          }),
        ),

      playlistGroups: (subscriptionId: string, query: string, offset: number, limit: number) =>
        Effect.gen(function* () {
          const source = yield* find(subscriptionId);
          const importer = source.provider?.provider.playlistImport;
          if (!importer) return yield* noSubscription;
          const imported = yield* Effect.tryPromise({
            try: (signal) => importer(signal),
            catch: failedWith,
          });
          const modes = new Map(
            source.stored.kind === "m3u"
              ? source.stored.mapping?.groups.map((each) => [each.group, each.mode])
              : [],
          );
          const wanted = query.toLocaleLowerCase();
          const all = [...imported.groups].filter(([group]) =>
            safeName(group || "Ungrouped")
              .toLocaleLowerCase()
              .includes(wanted),
          );
          return {
            status: imported.status,
            total: all.length,
            groups: all.slice(offset, offset + Math.min(100, limit)).map(([group, samples]) => ({
              group: playlistGroupId(group),
              name: safeName(group || "Ungrouped"),
              mode: imported.status.explicit
                ? (modes.get(playlistGroupId(group)) ?? null)
                : ("live" as const),
              entries: samples.length,
              samples: samples.slice(0, 5),
            })),
          };
        }),

      playlistOmissions: (subscriptionId: string, offset: number, limit: number) =>
        Effect.gen(function* () {
          const source = yield* find(subscriptionId);
          const importer = source.provider?.provider.playlistImport;
          if (!importer) return yield* noSubscription;
          const imported = yield* Effect.tryPromise({
            try: (signal) => importer(signal),
            catch: failedWith,
          });
          return {
            total: imported.omissions.length,
            entries: imported.omissions.slice(offset, offset + Math.min(100, limit)),
          };
        }),

      mapPlaylist: (subscriptionId: string, group: string, mode: PlaylistMode) =>
        Effect.gen(function* () {
          const before = yield* find(subscriptionId);
          const importer = before.provider?.provider.playlistImport;
          if (!importer || before.stored.kind !== "m3u") return yield* noSubscription;
          const imported = yield* Effect.tryPromise({
            try: (signal) => importer(signal),
            catch: failedWith,
          });
          if (![...imported.groups.keys()].some((each) => playlistGroupId(each) === group))
            return yield* new Failed({
              error: { kind: "unexpected", detail: t("This playlist group no longer exists.") },
            });
          return yield* change(subscriptionId, (latest) => {
            if (
              latest.revision !== before.revision ||
              latest.stored.kind !== "m3u" ||
              !latest.provider ||
              latest.provider.account.kind !== "m3u"
            )
              return Effect.fail(
                new Failed({
                  error: {
                    kind: "unexpected",
                    detail: t("The playlist changed. Open mapping again."),
                  },
                }),
              );
            const mapping = mapPlaylistGroup(
              latest.stored.mapping,
              [...imported.groups.keys()].map(playlistGroupId),
              group,
              mode,
            );
            if (mapping.groups.length > 10_000)
              return Effect.fail(
                new Failed({
                  error: {
                    kind: "unexpected",
                    detail: t("Playlist mapping exceeds {count} saved groups.", { count: 10_000 }),
                  },
                }),
              );
            const stored = { ...latest.stored, mapping };
            const provider = connected(stored, latest.provider.account.link);
            return save({ ...latest, stored, provider, revision: ++revisions }, latest);
          });
        }),

      saved: Effect.map(load, (roster) => roster.map(publicOf)),

      sources: Effect.map(load, (roster) => roster.flatMap((each) => sourceOf(each) ?? [])),

      sourceOf: (subscriptionId: string) =>
        Effect.flatMap(find(subscriptionId), (subscription) => {
          const source = sourceOf(subscription);
          return source
            ? Effect.succeed(source)
            : Effect.fail(new Failed({ error: { kind: "needs-secret", subscriptionId } }));
        }),

      stands: (subscription: SavedSubscription) =>
        Effect.map(load, (roster) =>
          roster.some(
            (each) => each.id === subscription.id && each.revision === subscription.revision,
          ),
        ),
    };
  });
}

function summary({ id, name, stored, provider }: Saved): SubscriptionSummary {
  return {
    kind: stored.kind,
    id,
    name,
    server: stored.server,
    username: stored.kind === "xtream" ? stored.username : "",
    account: stored.account,
    needsSecret: provider === null,
    ...(stored.kind === "m3u" ? { playlistMapped: !!stored.mapping } : {}),
  };
}

/** A name as typed, or null for none. */
function named(name: string | null | undefined): string | null {
  return name?.trim() || null;
}

/**
 * The playlist link typed to replace a saved one, made whole as a typed address is. A link that
 * carries a login is an Xtream panel's: another kind of subscription, which is added as one.
 */
function playlistLink(typed: string): Effect.Effect<string, Failed> {
  return Effect.try({
    try: () => parseLogin({ server: typed, username: "", password: "" }).account,
    catch: failedWith,
  }).pipe(
    Effect.flatMap((account) =>
      account.kind === "m3u"
        ? Effect.succeed(account.link)
        : Effect.fail(
            new Failed({
              error: { kind: "incomplete-login", detail: t("Enter the playlist's M3U link.") },
            }),
          ),
    ),
  );
}

/**
 * Identifies the account, and changes when the login does: the server and the username, or a
 * playlist's fingerprint. Its caches and its viewing record are kept under it.
 */
function keyOf(stored: StoredSubscription): string {
  return stored.kind === "xtream" ? `${stored.server}|${stored.username}` : stored.key;
}

/** The key a login's account is saved under: what `keyOf` gives once it is stored. */
function keyFor(account: ProviderAccount): string {
  return account.kind === "xtream"
    ? `${account.server}|${account.username}`
    : `m3u:${createHash("sha256").update(account.link).digest("hex").slice(0, 16)}`;
}

function sealedOf(stored: StoredSubscription): string {
  return stored.kind === "xtream" ? stored.sealedPassword : stored.sealedLink;
}

/**
 * The registry's entries as the file holds them, with where the original's entry is among them,
 * -1 without one. A registry that is missing or can't be read has none.
 */
async function readRegistry(path: string): Promise<{
  readonly entries: readonly object[];
  readonly at: number;
  readonly original: Infer<typeof OriginalEntry> | null;
}> {
  const entries = (await readJsonFile(path, Registry()))?.subscriptions ?? [];
  for (const [at, entry] of entries.entries()) {
    const original = OriginalEntry()(entry);
    if (!(original instanceof type.errors)) return { entries, at, original };
  }
  return { entries, at: -1, original: null };
}
