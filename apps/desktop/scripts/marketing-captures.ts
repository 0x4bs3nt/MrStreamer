// What a marketing capture run takes and how it records each master, for marketing-capture.ts.
// See docs/contributing/marketing-artwork.md.
import { readFileSync, writeFileSync } from "node:fs";

/** Every capture, in the order the viewer's path takes them. */
export const CAPTURES = ["library", "watching", "live-tv", "tv-guide", "home"] as const;
export type CaptureName = (typeof CAPTURES)[number];

/** The names given as `--only a,b`, or undefined for every capture. Fails on a name it doesn't know. */
export function parseOnly(value: string | undefined): readonly CaptureName[] | undefined {
  if (value === undefined) return undefined;
  const names = value.split(",").map((name) => name.trim());
  const known = names.filter((name): name is CaptureName =>
    CAPTURES.some((capture) => capture === name),
  );
  if (known.length !== names.length) {
    const unknown = names.filter((name) => !known.some((capture) => capture === name));
    throw new Error(`No capture named ${unknown.join(", ")}: ${CAPTURES.join(", ")}.`);
  }
  return known;
}

/**
 * The stages a run takes for the captures asked for, every capture when `only` is undefined: the
 * series' details for its own capture and its episode; the episode for the watching capture and
 * for the history Home's rows show; Live TV's two favourites and watched channel for Live TV, the
 * guide grid opened from its strip, and Home.
 */
export function capturePlan(only: readonly CaptureName[] | undefined) {
  const wanted = (name: CaptureName) => !only || only.includes(name);
  const episode = wanted("watching") || wanted("home");
  return {
    wanted,
    series: wanted("library") || episode,
    episode,
    liveTv: wanted("live-tv") || wanted("tv-guide") || wanted("home"),
  };
}

/** A master as marketing-capture.json lists it. */
export interface CaptureEntry {
  readonly name: CaptureName;
  readonly file: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly videoBox: unknown;
}

/** The build, system and inputs a master was captured from. */
export type Provenance = Readonly<Record<string, unknown>>;

interface CaptureManifest {
  readonly captures: readonly { readonly name: string }[];
}

/**
 * Puts a master just written into the manifest at once, with its own provenance, replacing that
 * capture's entry and leaving every other entry as it was. A later stage that fails then leaves no
 * master whose manifest hash is stale.
 */
export function recordCapture(file: string, entry: CaptureEntry, provenance: Provenance): void {
  const manifest: CaptureManifest = JSON.parse(readFileSync(file, "utf8"));
  const recorded = { ...entry, provenance };
  const at = manifest.captures.findIndex((each) => each.name === entry.name);
  const captures =
    at === -1
      ? [...manifest.captures, recorded]
      : manifest.captures.map((each, index) => (index === at ? recorded : each));
  writeFileSync(file, JSON.stringify({ ...manifest, captures }, null, 2) + "\n");
}
