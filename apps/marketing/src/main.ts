// Every page runs website analytics (analytics.ts). Home moves its window; home, download and
// about keep release links current:
// - Each part comes in once as it scrolls into view, and the hero's window tips upright as the
//   page scrolls. The reader starts all of it, nothing runs while the page sits still, and nothing
//   is hidden waiting for this script: without it the page is whole and the window upright.
//   styles.css holds the keyframes and switches them off for reduced motion.
// - One request for the update feed points the download links at a stable release published
//   since the site was built (downloads.ts). Without an answer the built links stand.
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

/** Takes `revealed` off a part whose animation ended, or was dropped before it could. */
const settle = ({ currentTarget }: Event): void => {
  if (!(currentTarget instanceof Element)) return;
  currentTarget.classList.remove("revealed");
  currentTarget.removeEventListener("animationend", settle);
  currentTarget.removeEventListener("animationcancel", settle);
};

// What is on screen when the page opens stays as it is: only what scrolls in later comes in.
let opening = true;
const reveal = new IntersectionObserver(
  (entries) => {
    for (const { isIntersecting, target } of entries) {
      if (!isIntersecting) continue;
      reveal.unobserve(target);
      if (opening || calm.matches) continue;
      // A window's animation runs on the panel over it, and ends here all the same.
      target.addEventListener("animationend", settle);
      target.addEventListener("animationcancel", settle);
      target.classList.add("revealed");
    }
    opening = false;
  },
  // A little before it shows, so it never appears and then starts over.
  { rootMargin: "0px 0px 10% 0px" },
);
for (const element of document.querySelectorAll("[data-reveal]")) reveal.observe(element);

// Asking for less motion halfway leaves nothing mid-animation.
calm.addEventListener("change", () => {
  for (const element of document.querySelectorAll(".revealed")) {
    element.classList.remove("revealed");
  }
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

// Home, download and about refresh through the same feed contract.
if (document.querySelector("[data-installer], [data-release-version]")) void refreshDownloads();
