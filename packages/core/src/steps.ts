// Long synchronous work written once, as a generator that pauses between slices of its loops. The
// desktop runs it to the end at once with `finish`; the iOS app, whose one JS thread also handles
// taps, runs a few slices per task (apps/ios/src/library.ts). A pause carries no value.

/** Work that pauses at each `yield` and returns `A` when done. */
export type Steps<A> = Generator<void, A, void>;

/** How many items a loop handles between pauses. */
const SLICE = 100;

/** Counts the items a piece of work handles: true after each `SLICE`, where it pauses. */
export function pacer(): () => boolean {
  let count = 0;
  return () => ++count % SLICE === 0;
}

/** Runs `steps` to the end without pausing. */
export function finish<A>(steps: Steps<A>): A {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}
