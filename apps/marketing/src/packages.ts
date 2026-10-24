// Package availability is independent of the app's release feed. Activate a route only after
// its public package and installation procedure have been verified on the matching project card.
export type PackageName = "homebrew" | "aur";

interface PackageRoute {
  readonly name: string;
  readonly platform: "macOS" | "Arch Linux";
  readonly architecture: "Apple silicon" | "x86_64";
  readonly url: `https://${string}`;
  readonly install: string;
  readonly updates: string;
  readonly publication:
    | { readonly state: "unpublished"; readonly lastVerifiedVersion: null }
    | {
        readonly state: "published" | "withdrawn";
        readonly lastVerifiedVersion: string;
        readonly receipt: `https://${string}`;
      };
}

export type PackageRoutes = Readonly<Record<PackageName, PackageRoute>>;

export const PACKAGE_ROUTES: PackageRoutes = {
  homebrew: {
    name: "Homebrew",
    platform: "macOS",
    architecture: "Apple silicon",
    url: "https://github.com/Mr-Streamer-OSS/homebrew-tap",
    install: "brew install --cask mr-streamer-oss/tap/mr-streamer",
    updates:
      "The same signed DMG for macOS 13 or later. Update in the app or quit it before a Homebrew replacement.",
    publication: {
      state: "published",
      lastVerifiedVersion: "0.0.19",
      receipt:
        "https://github.com/Mr-Streamer-OSS/homebrew-tap/blob/main/docs/verification/0.0.19.md",
    },
  },
  aur: {
    name: "AUR",
    platform: "Arch Linux",
    architecture: "x86_64",
    url: "https://aur.archlinux.org/packages/mrstreamer-bin",
    install:
      "git clone https://aur.archlinux.org/mrstreamer-bin.git\ncd mrstreamer-bin\nmakepkg -si",
    updates: "Arch Linux, x86_64. Install and update mrstreamer-bin with makepkg or an AUR helper.",
    publication: { state: "unpublished", lastVerifiedVersion: null },
  },
};
