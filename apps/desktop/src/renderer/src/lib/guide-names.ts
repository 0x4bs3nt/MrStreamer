// What the window calls a guide of Settings > Guides, the same in its row, every button of it, a
// subscription's Guide row and the mapping sheet: the name the viewer gave it, else its host.
// Where another listed guide would be called the same, case aside, as two from one host, two
// given one name, or a name that is another's host, each of those adds a tag: the start of its
// id, a random UUID the main process gave it, so nothing of its address. Four characters, more
// only while that still leaves two alike. A tag follows its guide through moves and restarts.
import type { GuideSourceStatus } from "@mrstreamer/contracts/guide";
import { hostOf } from "./format.ts";

/** What a guide is named by. */
type Named = Pick<GuideSourceStatus, "id" | "origin" | "label">;

/** The shortest tag. */
const TAG = 4;

/** Each of `sources`' names, by its id: "United Kingdom", "epg.example.net 3f9a". */
export function guideNames(sources: readonly Named[]): ReadonlyMap<string, string> {
  const bases = sources.map(({ label, origin }) => label ?? hostOf(origin));
  const ids = sources.map(({ id }) => id.replaceAll("-", "").toLowerCase());
  // How much of its id each one shows: none until it is alike another.
  const shown = sources.map(() => 0);
  const nameAt = (at: number) =>
    shown[at] ? `${bases[at]} ${ids[at]?.slice(0, shown[at])}` : (bases[at] ?? "");
  for (let grew = true; grew;) {
    grew = false;
    const alike = Map.groupBy(sources.keys(), (at) => nameAt(at).toLocaleLowerCase());
    for (const group of alike.values()) {
      if (group.length < 2) continue;
      for (const at of group) {
        const now = shown[at] ?? 0;
        const next = Math.min(now === 0 ? TAG : now + 1, ids[at]?.length ?? 0);
        if (next === now) continue;
        shown[at] = next;
        grew = true;
      }
    }
  }
  return new Map(sources.map(({ id }, at) => [id, nameAt(at)]));
}

/** `source`'s name among `listed`, as one of them where it isn't listed yet. */
export function guideName(source: Named, listed: readonly Named[]): string {
  const among = listed.some(({ id }) => id === source.id) ? listed : [...listed, source];
  return guideNames(among).get(source.id) ?? hostOf(source.origin);
}
