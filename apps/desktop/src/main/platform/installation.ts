import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { t } from "@mrstreamer/core/i18n";
import {
  INSTALLATION_MARKER,
  PACMAN_INSTALLATION,
  type Distribution,
} from "@mrstreamer/contracts/updates";

/** Resolves installation-owned metadata before Analytics or an updater is constructed. */
export async function installedDistribution(options: {
  readonly platform: string;
  readonly packaged: boolean;
  readonly store: boolean;
  readonly resources: string;
}): Promise<Distribution> {
  if (options.store) return "store";
  if (options.platform !== "linux" || !options.packaged) return "direct";
  const path = join(options.resources, INSTALLATION_MARKER);
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "direct";
    throw new Error(
      t("Cannot inspect {path}. Reinstall Mr. Streamer with your package manager.", { path }),
      {
        cause: error,
      },
    );
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      t("Cannot read {path}. Reinstall Mr. Streamer with your package manager.", { path }),
      {
        cause: error,
      },
    );
  }
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value === "object" &&
      value !== null &&
      "schema" in value &&
      value.schema === PACMAN_INSTALLATION.schema &&
      "updates" in value &&
      value.updates === PACMAN_INSTALLATION.updates
    )
      return "pacman";
  } catch {
    // A present marker is authoritative; damage must never enable direct updating.
  }
  throw new Error(t("Invalid {path}. Reinstall Mr. Streamer with your package manager.", { path }));
}
