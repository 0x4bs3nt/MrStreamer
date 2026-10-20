import type { Distribution } from "@mrstreamer/contracts/updates";
import { t } from "@mrstreamer/core/i18n";

/** The installation owner shown in About and the local diagnostics preview. */
export function distributionLabel(distribution: Distribution): string {
  switch (distribution) {
    case "direct":
      return t("Direct install");
    case "store":
      return "Microsoft Store";
    case "pacman":
      return "AUR (pacman)";
  }
}
