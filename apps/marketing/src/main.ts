// Every page runs website analytics (analytics.ts). Home moves; download and about keep release
// links current:
// - Each part comes in once as it scrolls into view, the stack of windows fans out and can be
//   replayed, and the hero's window tips upright as the page scrolls. The reader starts all of
//   it, nothing runs while the page sits still, and nothing is hidden waiting for this script:
//   without it the page is whole, the window upright and the stack fanned out. styles.css holds
//   the keyframes and switches them off for reduced motion.
// - One request for the update feed points the download and about pages' links at a stable
//   release published since the site was built (downloads.ts). Home links /download and holds no
//   installer, so it doesn't ask. Without an answer the built links stand.
import { startSiteAnalytics, type SiteCapture } from "./analytics.ts";
import { FEED, showFeedDownloads } from "./downloads.ts";

/** Written by vite.config.ts: null unless the build named a capture endpoint and key. */
declare const __SITE_ANALYTICS__: SiteCapture | null;

startSiteAnalytics(__SITE_ANALYTICS__);

/** The full layout, for someone who hasn't asked for less motion. Either can change while open. */
const tilting = matchMedia("(min-width: 70em) and (prefers-reduced-motion: no-preference)");
const calm = matchMedia("(prefers-reduced-motion: reduce)");

// Only the home page has the window. The other pages listen for nothing.
const hero = document.querySelector<HTMLElement>("[data-tilt]");
if (hero) {
  let queued = false;

  /**
   * Sets how upright the hero's window stands, from 0 as its top enters at the foot of the screen
   * to 1 once it is a fifth of the way from the top. Upright, it keeps no trace of the tilt.
   */
  const tilt = (): void => {
    queued = false;
    const { top } = hero.getBoundingClientRect();
    const upright = tilting.matches
      ? Math.min(Math.max((innerHeight - top) / (innerHeight * 0.8), 0), 1)
      : 1;
    hero.classList.toggle("tipped", upright < 1);
    if (upright < 1) hero.style.setProperty("--tilt", upright.toFixed(3));
    else hero.style.removeProperty("--tilt");
  };

  /** One update per frame, and only after the reader scrolled, resized or changed a preference. */
  const queue = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(tilt);
  };

  addEventListener("scroll", queue, { passive: true });
  addEventListener("resize", queue);
  tilting.addEventListener("change", queue);
  tilt();
}

/**
 * The parts that are `revealed` right now, each with the run that revealed it. A part carries
 * the class, and the will-change it brings, only while its animations run.
 */
const playing = new Map<Element, symbol>();

/** Ends a part's motion where it stands. Its animations are dropped with the class. */
const settle = (part: Element): void => {
  playing.delete(part);
  part.classList.remove("revealed");
};

/**
 * Runs a part's animations once, from where their keyframes start to where the part rests, and
 * settles it once every one of them, the stack's windows included, has finished or was dropped.
 * A replay cuts a run short and starts over; the older run then leaves the newer one alone.
 */
async function play(part: Element): Promise<void> {
  if (calm.matches) return;
  settle(part);
  // Flushes the style with the class off, so a part still running starts afresh.
  part.getAnimations({ subtree: true });
  const run = Symbol("run");
  playing.set(part, run);
  part.classList.add("revealed");
  await Promise.allSettled(part.getAnimations({ subtree: true }).map(({ finished }) => finished));
  if (playing.get(part) === run) settle(part);
}

// What is on screen when the page opens stays as it is: only what scrolls in later comes in, and
// once. A part stays watched, so leaving the screen mid-run settles it where it stands.
let opening = true;
const entered = new WeakSet<Element>();
const reveal = new IntersectionObserver(
  (entries) => {
    for (const { isIntersecting, target } of entries) {
      if (!isIntersecting) {
        if (playing.has(target)) settle(target);
        continue;
      }
      if (entered.has(target)) continue;
      entered.add(target);
      if (!opening) void play(target);
    }
    opening = false;
  },
  // A little before it shows, so it never appears and then starts over.
  { rootMargin: "0px 0px 10% 0px" },
);
for (const part of document.querySelectorAll("[data-reveal]")) reveal.observe(part);

// Replay fans the stack out again. It shows only where the script can run the fan.
const stack = document.querySelector(".stack");
const replay = document.querySelector<HTMLButtonElement>("[data-replay]");
if (stack && replay) {
  replay.hidden = calm.matches;
  replay.addEventListener("click", () => void play(stack));
}

// Hiding the page, or asking for less motion halfway, leaves nothing mid-animation.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) for (const part of [...playing.keys()]) settle(part);
});
calm.addEventListener("change", () => {
  for (const part of [...playing.keys()]) settle(part);
  if (replay) replay.hidden = calm.matches;
});

/** Shows the stable release the update feed names now. Without an answer the built links stand. */
async function refreshDownloads(): Promise<void> {
  try {
    const response = await fetch(FEED, { signal: AbortSignal.timeout(8_000) });
    if (response.ok) showFeedDownloads(document, await response.json());
  } catch {
    // Offline, blocked or not a feed.
  }
}

// Download and about refresh through the same feed contract. Home has neither mark, so it doesn't.
if (document.querySelector("[data-installer], [data-release-version]")) void refreshDownloads();
