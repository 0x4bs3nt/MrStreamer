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

async function keychain<A>(operation: () => Promise<A>): Promise<A> {
  try {
    return await operation();
  } catch {
    throw new AppFailure({ kind: "keychain-refused" });
  }
}

export const keychainSecrets: SecretStore = {
  read: (id) => keychain(() => SecureStore.getItemAsync(keyOf(id), OPTIONS)),
  write: (id, secret) => keychain(() => SecureStore.setItemAsync(keyOf(id), secret, OPTIONS)),
  remove: (id) => keychain(() => SecureStore.deleteItemAsync(keyOf(id), OPTIONS)),
};
