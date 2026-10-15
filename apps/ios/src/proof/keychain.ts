import type { Observed } from "./cases.ts";
import type { SecretStore } from "../secrets.ts";

const RELAUNCH = "proof:relaunch";
const ROUND_TRIP = "proof:round trip/ü";
/** Ids that an escape-shaped id or a character outside the BMP once mapped onto the same item. */
const LOOKALIKES = [
  ["proof:pair/a", "proof:pair_2f_a"],
  ["proof:pair😀", "proof:pair😁"],
] as const;

/**
 * The secret store against the real Keychain: an id with characters Keychain keys refuse, a
 * removal, ids that look alike but each keep their own item, and a value written by the previous
 * launch, so a relaunch shows what survived it. Only made-up values are written.
 */
export async function keychainProof(store: SecretStore): Promise<Observed> {
  const previous = await store.read(RELAUNCH);
  const launch = previous?.startsWith("launch-") ? Number(previous.slice(7)) + 1 : 1;
  await store.write(RELAUNCH, `launch-${launch}`);

  await store.write(ROUND_TRIP, "pässwörd with spaces");
  const readBack = await store.read(ROUND_TRIP);
  await store.remove(ROUND_TRIP);
  const afterRemove = await store.read(ROUND_TRIP);

  const lookalikes: Observed[] = [];
  for (const [first, second] of LOOKALIKES) {
    await store.write(first, "first-secret");
    await store.write(second, "second-secret");
    const both = [await store.read(first), await store.read(second)];
    await store.remove(first);
    const afterRemovingFirst = [await store.read(first), await store.read(second)];
    await store.remove(second);
    const isolated =
      both[0] === "first-secret" &&
      both[1] === "second-secret" &&
      afterRemovingFirst[0] === null &&
      afterRemovingFirst[1] === "second-secret";
    lookalikes.push({ first, second, both, afterRemovingFirst, isolated });
  }
  return {
    previous,
    launch,
    roundTrip: readBack === "pässwörd with spaces",
    afterRemove,
    lookalikes,
  };
}
