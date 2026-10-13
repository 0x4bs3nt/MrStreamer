// The files a release carries for each platform, as electron-builder names them from
// apps/desktop/electron-builder.yml. Publishing checks a release has every one of them, and the
// update feed counts a release only when it carries each platform's update metadata.
//
// Release jobs run this with plain node before installing packages, so it imports nothing.

/** The platforms every release is built for, in the order the update feed lists them. */
export const PLATFORMS = ["mac-arm64", "win-x64", "linux-x64"] as const;

export type Platform = (typeof PLATFORMS)[number];

/** The update metadata electron-builder writes for each platform, which the app's updater reads. */
export const UPDATE_METADATA = {
  "mac-arm64": "latest-mac.yml",
  "win-x64": "latest.yml",
  "linux-x64": "latest-linux.yml",
} as const satisfies Record<Platform, string>;

/**
 * Every file the direct-download build of `platform` makes for `version` and the release attaches:
 * its installers, the blockmaps in-app updates read, and its update metadata. On macOS the ZIP is
 * what in-app updates install; notarizing drops the DMG's blockmap.
 */
export function platformFiles(version: string, platform: Platform): string[] {
  switch (platform) {
    case "mac-arm64":
      return [
        `Mr-Streamer-${version}-mac-arm64.dmg`,
        `Mr-Streamer-${version}-mac-arm64.zip`,
        `Mr-Streamer-${version}-mac-arm64.zip.blockmap`,
        UPDATE_METADATA[platform],
      ];
    case "win-x64":
      return [
        `Mr-Streamer-${version}-win-x64-setup.exe`,
        `Mr-Streamer-${version}-win-x64-setup.exe.blockmap`,
        UPDATE_METADATA[platform],
      ];
    case "linux-x64":
      // electron-builder spells x64 the way each Linux package format does.
      return [
        `Mr-Streamer-${version}-linux-x86_64.AppImage`,
        `Mr-Streamer-${version}-linux-amd64.deb`,
        UPDATE_METADATA[platform],
      ];
  }
}

/** Every platform's files of `version`, which a release must carry before it is published. */
export function releaseFiles(version: string): string[] {
  return PLATFORMS.flatMap((platform) => platformFiles(version, platform));
}
