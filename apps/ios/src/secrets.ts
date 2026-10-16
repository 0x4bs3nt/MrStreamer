import { AppFailure } from "@mrstreamer/contracts/errors";
import * as SecureStore from "expo-secure-store";

/**
 * Subscription and subtitle-service secrets, each kept as its own Keychain item under the id of
 * what it belongs to. The desktop app seals secrets with a Keychain key and writes them to its
 * database; on iOS the Keychain holds the secret itself, so nothing secret reaches app storage.
 * Every failure is `keychain-refused`, as on the desktop, so the app asks for the secret again.
 */
export interface SecretStore {
  read(id: string): Promise<string | null>;
  write(id: string, secret: string): Promise<void>;
  remove(id: string): Promise<void>;
  /**
   * Removes every secret this app wrote. Keychain items outlive the app, so a reinstall calls
   * this before anything else, and an uninstalled login doesn't come back.
   */
  clear(): Promise<void>;
}

/**
 * Items stay on this device, out of backups and iCloud Keychain, and are readable after the first
 * unlock since a restart, so a background guide refresh or download can still sign in.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: "app.mrstreamer.secrets",
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/**
 * Keychain keys allow letters, digits, ".", "-" and "_"; an id may hold anything else. Every other
 * UTF-16 unit, "_" included, becomes "_" and four hex digits, so each id has a key of its own.
 */
const keyOf = (id: string) =>
  `s.${id.replace(/[^A-Za-z0-9.-]/g, (unit) => `_${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)}`;

/**
 * The ids holding a secret, as JSON, in an item of their own: the Keychain can't list a
 * service's items through SecureStore. No id's key starts like it.
 */
const INDEX = "index";

async function keychain<A>(operation: () => Promise<A>): Promise<A> {
  try {
    return await operation();
  } catch {
    throw new AppFailure({ kind: "keychain-refused" });
  }
}

/** The last change to this store's items, settled or not; a failed one counts as done. */
let changing: Promise<unknown> = Promise.resolve();

/**
 * Runs `change` once every change begun before it has finished. Writes, removals and clearing
 * each read the index and write it back, so two at once would lose one's ids: a removal still
 * running when an add writes its password would drop the new id, and a reinstall wouldn't
 * remove that password.
 */
function serially<A>(change: () => Promise<A>): Promise<A> {
  const run = changing.then(change);
  changing = run.catch(() => undefined);
  return run;
}

async function ids(): Promise<string[]> {
  const listed = await SecureStore.getItemAsync(INDEX, OPTIONS);
  const parsed: unknown = listed ? JSON.parse(listed) : [];
  return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
}

const index = (change: (listed: string[]) => string[]) =>
  ids().then((listed) => SecureStore.setItemAsync(INDEX, JSON.stringify(change(listed)), OPTIONS));

export const keychainSecrets: SecretStore = {
  read: (id) => keychain(() => SecureStore.getItemAsync(keyOf(id), OPTIONS)),
  write: (id, secret) =>
    keychain(() =>
      serially(async () => {
        await index((listed) => [...listed.filter((each) => each !== id), id]);
        await SecureStore.setItemAsync(keyOf(id), secret, OPTIONS);
      }),
    ),
  remove: (id) =>
    keychain(() =>
      serially(async () => {
        await SecureStore.deleteItemAsync(keyOf(id), OPTIONS);
        await index((listed) => listed.filter((each) => each !== id));
      }),
    ),
  clear: () =>
    keychain(() =>
      serially(async () => {
        for (const id of await ids()) await SecureStore.deleteItemAsync(keyOf(id), OPTIONS);
        await SecureStore.deleteItemAsync(INDEX, OPTIONS);
      }),
    ),
};
