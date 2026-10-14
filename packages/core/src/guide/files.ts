// Who holds each of a guide service's files, and so when one may close and when it may go. Every
// file the service knows has holders, each a claim: the guide loaded from it, a read under way, a
// build reading the past from it, a check's candidate, a use that opened one, a download or a
// build writing it, and what is kept naming it, `guide.json` or `guide-source.json`. An index is
// open while a holder reads it, and closes when the last reader lets go. A file goes once nothing
// holds it, and only then: nothing else in the service closes or deletes one.
//
// A claim is let go once, by whoever has it last. Work that hands what it made to another holder
// claims it for that holder first and lets go of its own claim after, so the file is held
// throughout; work that is stopped lets go of its own claims, and never of one it handed on.
import { openGuideIndex, type GuideIndex } from "./index-file.ts";

/** Lets go of a claim. Called again, it does nothing. */
export type Release = () => void;

/** An index open to read, held until `release`. */
export interface Reader {
  readonly index: GuideIndex;
  readonly release: Release;
}

/** Where the registry finds files, and how it removes one: the guide store's. */
export interface FilePlaces {
  path(store: string, file: string): string;
  /** Removes a file. It doesn't fail: one it can't remove stays for the next sweep. */
  remove(store: string, file: string): Promise<void>;
}

interface Entry {
  readonly store: string;
  readonly file: string;
  holders: number;
  /** The index open on it while any holder reads it, and how many do. */
  index: GuideIndex | null;
  readers: number;
  /** Set once nothing holds it: it is going, and nothing may claim it any more. */
  going: boolean;
  /** Settles once it is gone. */
  readonly gone: PromiseWithResolvers<void>;
}

/** A guide service's files and their holders. */
export interface GuideFiles {
  /** Claims a file: it stays until the claim is let go. Null when it is already going. */
  claim(store: string, file: string): Release | null;
  /**
   * Opens the index in a file to read, claiming it as a reader: one open index is shared by its
   * readers. Null when the file is going or isn't an index this release reads.
   */
  open(store: string, file: string): Promise<Reader | null>;
  /** One more reader of an index already open, at once; null when none is. */
  share(store: string, file: string): Reader | null;
  /** Whether a file has holders, or is going. The sweep leaves those alone. */
  known(store: string, file: string): boolean;
  /** Settles once no file of `store` is held or going. */
  settled(store: string): Promise<void>;
  /** Closes every open index, for shutdown. What is held stays on disk. */
  closeAll(): void;
}

export function guideFiles(places: FilePlaces): GuideFiles {
  const entries = new Map<string, Entry>();

  const letGoOf = (path: string, entry: Entry) => {
    if (--entry.holders > 0) return;
    entry.going = true;
    void places.remove(entry.store, entry.file).finally(() => {
      if (entries.get(path) === entry) entries.delete(path);
      entry.gone.resolve();
    });
  };

  const claim = (store: string, file: string): Release | null => {
    const path = places.path(store, file);
    let entry = entries.get(path);
    if (entry?.going) return null;
    if (!entry) {
      entry = {
        store,
        file,
        holders: 0,
        index: null,
        readers: 0,
        going: false,
        gone: Promise.withResolvers(),
      };
      entries.set(path, entry);
    }
    entry.holders++;
    const held = entry;
    return once(() => letGoOf(path, held));
  };

  /** A reader of `entry`'s open index, holding the claim `hold` until it lets go. */
  const reader = (entry: Entry, index: GuideIndex, hold: Release): Reader => {
    entry.readers++;
    return {
      index,
      release: once(() => {
        if (--entry.readers === 0 && entry.index) {
          entry.index.close();
          entry.index = null;
        }
        hold();
      }),
    };
  };

  return {
    claim,
    async open(store, file) {
      const hold = claim(store, file);
      if (!hold) return null;
      const entry = entries.get(places.path(store, file));
      if (!entry) return null;
      if (!entry.index) {
        const index = await openGuideIndex(places.path(store, file));
        if (!index) {
          hold();
          return null;
        }
        // Another reader opened it meanwhile: one index is enough.
        if (entry.index) index.close();
        else entry.index = index;
      }
      return reader(entry, entry.index, hold);
    },
    share(store, file) {
      const entry = entries.get(places.path(store, file));
      if (!entry?.index || entry.going) return null;
      const hold = claim(store, file);
      return hold && reader(entry, entry.index, hold);
    },
    known: (store, file) => entries.has(places.path(store, file)),
    async settled(store) {
      for (;;) {
        const held = [...entries.values()].filter((entry) => entry.store === store);
        if (held.length === 0) return;
        await Promise.all(held.map((entry) => entry.gone.promise));
      }
    },
    closeAll() {
      for (const entry of entries.values()) {
        entry.index?.close();
        entry.index = null;
      }
    },
  };
}

/** `run`, at most once however often it is called. */
function once(run: () => void): Release {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    run();
  };
}
