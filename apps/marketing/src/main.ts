// Every page runs website analytics (analytics.ts). Home moves; download and about keep release
// links current:
// - Each part comes in once as it scrolls into view, and the hero fan opens once. Nothing runs
//   while the page sits still. Without scripts the page is whole and the fan rests open.
//   styles.css holds the keyframes and switches them off for reduced motion.
// - One request for the update feed points the download and about pages' links at a stable
//   release published since the site was built (downloads.ts). Home links /download and holds no
//   installer, so it doesn't ask. Without an answer the built links stand.
import { startSiteAnalytics, type SiteCapture } from "./analytics.ts";
import { FEED, showFeedDownloads } from "./downloads.ts";

/** Written by vite.config.ts: null unless the build named a capture endpoint and key. */
declare const __SITE_ANALYTICS__: SiteCapture | null;

startSiteAnalytics(__SITE_ANALYTICS__);

const calm = matchMedia("(prefers-reduced-motion: reduce)");

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
 * A run that was settled meanwhile, by leaving the screen or hiding the page, leaves it be.
 */
async function play(part: Element): Promise<void> {
  if (calm.matches) return;
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

// Hiding the page, or asking for less motion halfway, leaves nothing mid-animation.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) for (const part of [...playing.keys()]) settle(part);
});
calm.addEventListener("change", () => {
  for (const part of [...playing.keys()]) settle(part);
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
