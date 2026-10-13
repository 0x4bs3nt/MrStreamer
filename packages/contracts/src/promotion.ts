// Which published nightly a stable release may promote. The release plan
// (scripts/release-plan.ts) applies this before any release work starts, and the installed
// upgrade check (apps/desktop/test/e2e/installed-upgrade-packages.ts), which installs the newest
// stable release and upgrades it to that nightly, applies it again, so the two never disagree.
// docs/maintainers/releasing.md#stable-releases describes it.
//
// Release jobs run this with plain node before installing packages, so it imports only
// ./version.ts, by relative path.
import { compareVersions, formatVersion, type Version } from "./version.ts";

/** How a nightly's commit relates to the newest stable release's, as GitHub's compare reports it. */
export type Ancestry = "ahead" | "identical" | "behind" | "diverged";

/**
 * Why `nightly` can't be promoted over `stable`, the newest stable release, or null when it can.
 * Its version must sort above that release, so the upgrade check can install it over it, and its
 * commit must strictly descend from that release's, so it holds that release and something more.
 * A nightly from before the newest stable release, or one built beside it, never qualifies,
 * whatever version it would ship as: test a fresh nightly instead.
 */
export function promotionProblem(
  nightly: { readonly tag: string; readonly version: Version },
  stable: { readonly tag: string; readonly version: Version },
  ancestry: Ancestry,
): string | null {
  const fresh = `A stable release needs a fresh tested nightly: test one published after ${stable.tag}.`;
  if (compareVersions(nightly.version, stable.version) <= 0) {
    return `${nightly.tag} sorts below ${stable.tag}, the newest stable release, so the upgrade check can't install it over that release. ${fresh}`;
  }
  if (ancestry === "identical") {
    return `${nightly.tag} was built from the same commit as ${stable.tag}, so it holds nothing new. ${fresh}`;
  }
  if (ancestry !== "ahead") {
    return `${nightly.tag} doesn't contain ${stable.tag}'s commit (${ancestry}), so it can hold older code than ${formatVersion(stable.version)}. ${fresh}`;
  }
  return null;
}
