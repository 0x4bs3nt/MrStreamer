import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import type { LoginInput } from "@mrstreamer/contracts/ipc";
import type { AccountStatus } from "@mrstreamer/contracts/subscription";
import { streamsToPlay, type ListedChannel } from "@mrstreamer/core/catalogue/variants";
import type { Provider } from "@mrstreamer/core/provider";
import { parseLogin, xtreamProvider, type XtreamAccount } from "@mrstreamer/core/xtream";
import Constants from "expo-constants";
import { appError } from "./errors.ts";
import { buildLibrary, type Library } from "./library.ts";
import { play, stop } from "./playback.ts";
import { keychainSecrets } from "./secrets.ts";
import {
  firstLaunch,
  readState,
  rememberChannel,
  writeState,
  type SavedSubscription,
} from "./storage.ts";
import { store, useStore } from "./store.ts";
import { connectTitles, disconnectTitles, onTitleLists, titleLists } from "./titles.ts";
import { connectViewing, disconnectViewing } from "./viewing.ts";
import { alignWatchlist, connectWatchlist, disconnectWatchlist } from "./watchlist.ts";

// The connected subscription and its live catalogue. One Xtream subscription for now; the
// desktop app's several, and M3U playlists, come later. The server and username are saved in
// app storage and the password in the Keychain, under the subscription's id. Signing in starts
// what belongs to the subscription, its movies and series (titles.ts, once the login is known to
// be good or has been checked again), its viewing record
// (viewing.ts) and watchlist (watchlist.ts); Disconnect forgets them with it.

export type Session =
  | { readonly kind: "restoring" }
  /** `saved` fills the form again when the Keychain lost the password. */
  | { readonly kind: "signed-out"; readonly saved: SavedSubscription | null }
  | {
      readonly kind: "signed-in";
      readonly subscription: SavedSubscription;
      /** What the provider said at the last sign-in, or why it couldn't say. */
      readonly account: AccountStatus | AppError | null;
    };

export type Catalogue =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly library: Library }
  | { readonly kind: "failed"; readonly error: AppError };

const session = store<Session>({ kind: "restoring" });
const catalogue = store<Catalogue>({ kind: "loading" });

export const useSession = () => useStore(session);
export const useCatalogue = () => useStore(catalogue);

const USER_AGENT = `MrStreamer/${Constants.expoConfig?.version ?? "0.0.0"} (iOS)`;

let provider: Provider | null = null;
/** What signed in, for the stream addresses that carry it. */
let login: readonly string[] = [];
let loading: AbortController | null = null;
/** Counts sign-ins and Disconnects: only the latest Connect may still sign in. */
let attempts = 0;

const providerFor = (account: XtreamAccount) =>
  xtreamProvider(account, { userAgent: USER_AGENT, live: "hls" });

/** Reads the provider's channel list again, dropping a load still under way. */
export function loadCatalogue() {
  loading?.abort();
  const controller = new AbortController();
  loading = controller;
  catalogue.set({ kind: "loading" });
  provider?.liveCatalogue(controller.signal).then(
    (listed) => {
      if (!controller.signal.aborted)
        catalogue.set({ kind: "ready", library: buildLibrary(listed) });
    },
    (cause: unknown) => {
      if (!controller.signal.aborted) catalogue.set({ kind: "failed", error: appError(cause) });
    },
  );
}

/**
 * Makes `subscription` the signed-in one and loads its channels. Its movies and series are the
 * caller's to start (`connectTitles`), once it knows the login is good or has checked it.
 */
function signIn(subscription: SavedSubscription, password: string): Provider {
  const signedIn = providerFor({ ...subscription, password });
  provider = signedIn;
  login = [subscription.username, password];
  connectWatchlist(subscription.id);
  connectViewing(subscription.id, titleLists);
  session.set({ kind: "signed-in", subscription, account: null });
  loadCatalogue();
  return signedIn;
}

// Saved titles take their names and versions as each read of the lists has them.
onTitleLists(() => {
  const lists = titleLists();
  if (lists.kind === "ready") alignWatchlist(lists.index);
});

/** What signed in, for the stream addresses that carry it: kept out of every failure shown. */
export function streamLogin(): readonly string[] {
  return login;
}

/**
 * At launch: the saved subscription, signed in again with its password from the Keychain. A
 * first launch since installing first removes what an earlier install left in the Keychain.
 */
export async function restore() {
  if (firstLaunch()) {
    await keychainSecrets.clear().catch(() => undefined);
    writeState((state) => state);
  }
  const { subscription } = readState();
  const password = subscription
    ? await keychainSecrets.read(subscription.id).catch(() => null)
    : null;
  if (!subscription || !password) {
    session.set({ kind: "signed-out", saved: subscription });
    return;
  }
  const signedIn = signIn(subscription, password);
  const attempt = attempts;
  // The login is checked again before the movie and series lists, the largest downloads, start:
  // they wait until the check answers, fails or runs out of time, so on a slow link they don't
  // hold its answer back. Channels load at once. A Disconnect or another Connect meanwhile
  // leaves the lists to whatever signed in since.
  void signedIn
    .authenticate()
    .then(
      (account) => updateAccount(subscription.id, account),
      (cause: unknown) => updateAccount(subscription.id, appError(cause)),
    )
    .then(() => {
      if (attempt === attempts && provider === signedIn) connectTitles(signedIn, subscription.id);
    });
}

function updateAccount(id: string, account: AccountStatus | AppError) {
  session.set((current) =>
    current.kind === "signed-in" && current.subscription.id === id
      ? { ...current, account }
      : current,
  );
}

/**
 * Signs in with what the viewer typed. Rejects with the reason it couldn't. A newer Connect or a
 * Disconnect before it finishes leaves it without effect: it saves nothing and signs nothing in.
 */
export async function connect(input: LoginInput): Promise<void> {
  const attempt = ++attempts;
  const { account } = parseLogin(input);
  if (account.kind !== "xtream") {
    throw new AppFailure({
      kind: "invalid-input",
      detail: "M3U playlists aren't on iPhone yet. Enter an Xtream server, username and password.",
    });
  }
  const status = await providerFor(account).authenticate(AbortSignal.timeout(20_000));
  if (attempt !== attempts) return;
  const subscription = {
    id: `xtream-${Date.now().toString(36)}`,
    server: account.server,
    username: account.username,
  };
  await keychainSecrets.write(subscription.id, account.password);
  if (attempt !== attempts) {
    await keychainSecrets.remove(subscription.id).catch(() => undefined);
    return;
  }
  writeState((state) => ({ ...state, subscription, recent: [], region: null }));
  // The login was just checked, so the movie and series lists start with the channels.
  connectTitles(signIn(subscription, account.password), subscription.id);
  updateAccount(subscription.id, status);
}

/**
 * Forgets the subscription: its password, its saved state and what it plays. Everything but the
 * Keychain is forgotten at once, so a second Disconnect finds nothing to forget, and the removal
 * that finishes later touches only this subscription's password, never a newer sign-in.
 */
export async function disconnect() {
  attempts++;
  const current = session.get();
  stop();
  loading?.abort();
  disconnectTitles();
  disconnectWatchlist();
  await disconnectViewing();
  provider = null;
  login = [];
  writeState(() => ({ subscription: null, recent: [], region: null }));
  catalogue.set({ kind: "loading" });
  session.set({ kind: "signed-out", saved: null });
  if (current.kind === "signed-in") {
    await keychainSecrets.remove(current.subscription.id).catch(() => undefined);
  }
}

/**
 * Plays a channel's first stream in Auto's order (the desktop's `streamsToPlay`, at its default
 * quality), in Watch or in Home's preview. Trying the next stream when one fails comes later.
 */
export function playChannel(channel: ListedChannel, place: string, options: { watch: boolean }) {
  const [variant] = streamsToPlay(channel, {});
  if (!variant) return;
  const open = async (signal: AbortSignal) => {
    if (!provider) throw new AppFailure({ kind: "no-subscription" });
    const stream = await provider.liveStream(variant.id, signal);
    return {
      url: stream.url,
      hls: stream.format === "hls",
      ...(stream.headers ? { headers: stream.headers } : {}),
    };
  };
  rememberChannel(channel.id);
  void play(
    { id: channel.id, title: channel.title, place, live: true, next: false, versions: false },
    open,
    { ...options, login },
  );
}
