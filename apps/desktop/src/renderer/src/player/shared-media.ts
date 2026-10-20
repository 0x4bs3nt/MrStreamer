/** Picture moves this one element between views without reopening playback. */
export const video = document.createElement("video");
video.playsInline = true;
video.className = "size-full";

let holder: { readonly end: () => void } | null = null;
let handingOff = false;

/** A controller supplies only its own synchronous cleanup, never another controller's methods. */
export function mediaClaim(end: () => void) {
  const mine = { end };
  return {
    /** Explicit playback ends the previous controller before starting. Cleanup cannot start more. */
    take(): boolean {
      if (handingOff) return false;
      if (holder === mine) return true;
      const previous = holder;
      handingOff = true;
      holder = null;
      try {
        previous?.end();
        holder = mine;
        return true;
      } finally {
        handingOff = false;
      }
    },
    /** Previews and continuations never replace a different controller's playback. */
    keep(): boolean {
      if (handingOff || (holder && holder !== mine)) return false;
      holder = mine;
      return true;
    },
    /** A non-owner's cleanup cannot release whoever plays now. */
    release(): void {
      if (holder === mine) holder = null;
    },
  };
}
