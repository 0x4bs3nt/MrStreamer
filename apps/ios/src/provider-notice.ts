import { currentRoster, onRoster } from "./account.ts";
import { store, useStore } from "./store.ts";

type Source = "live" | "titles";
export type ProviderFailureKind = "unavailable" | "password";

interface Incident {
  readonly token: number;
  readonly kind: ProviderFailureKind;
  readonly pending: ReadonlySet<Source>;
  readonly acknowledged: boolean;
}

// One session's acknowledgements, independent of screens. Only the roster's owner changes
// provider state; this observer never clears errors, retries, or touches retained lists.
const incidents = store<ReadonlyMap<string, Incident>>(new Map());
let nextToken = 0;

function observe() {
  const roster = currentRoster();
  if (roster.kind !== "ready") return;
  const next = new Map<string, Incident>();
  for (const member of roster.members) {
    const previous = incidents.get().get(member.entry.id);
    const kind = member.needsSecret ? "password" : "unavailable";
    const pending = new Set<Source>(previous?.kind === kind ? previous.pending : []);
    for (const source of ["live", "titles"] as const) {
      const list = member[source];
      if (list.kind === "failed") pending.add(source);
      // A loading transition or a saved copy isn't evidence that the failed source recovered.
      else if (list.kind === "ready" && list.from === "provider") pending.delete(source);
    }
    if (!member.needsSecret && pending.size === 0) continue;
    next.set(member.entry.id, {
      token: previous?.kind === kind ? previous.token : ++nextToken,
      kind,
      pending,
      acknowledged: previous?.kind === kind && previous.acknowledged,
    });
  }
  incidents.set(next);
}

observe();
onRoster(observe);

/** Shared across tabs and resume, including recovery while no notice is mounted. */
export const useProviderNotices = () => useStore(incidents);

/** A stale close action cannot acknowledge a newer incident under the same provider id. */
export function dismissProviderNotice(id: string, token: number) {
  const incident = incidents.get().get(id);
  if (!incident || incident.token !== token || incident.acknowledged) return;
  const next = new Map(incidents.get());
  next.set(id, { ...incident, acknowledged: true });
  incidents.set(next);
}
