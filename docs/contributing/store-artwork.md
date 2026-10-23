# Store artwork

Wout selected B, the signature hat direction, for the desktop 0.0.19 artwork.
The candidate files in `docs/assets/store` prepare a listing update. They do not
change the published trailer, app icons, website or Store listing. Final visual
acceptance and publication are separate steps.

## Exports

| File                          | Pixels      | Use                                         |
| ----------------------------- | ----------- | ------------------------------------------- |
| `store-trailer-thumbnail.png` | 1920 × 1080 | Microsoft Store trailer thumbnail candidate |
| `store-hero.png`              | 3840 × 2160 | Text-free Microsoft Store hero candidate    |
| `signature-landscape.png`     | 3840 × 2160 | Landscape master                            |
| `signature-portrait.png`      | 1080 × 1920 | Portrait creative master                    |
| `signature-square.png`        | 2160 × 2160 | Square creative master                      |

All exports are opaque RGB PNGs on true black. `manifest.json` records dimensions,
placements, layout coordinates, hashes, source provenance and the checked rules.
No UI, provider data, stock pictures or generative image model is used.

The [Microsoft image requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/screenshots-and-images)
checked on 23 October 2026 specify a 1920 × 1080 PNG trailer thumbnail. The hero
supports 3840 × 2160, excludes text, UI and devices, and keeps important details
centred in the upper two thirds. The separate hero export follows those rules.
Portrait and square are creative masters. The documented 2:3 poster and square box
art slots apply to games, so these files do not claim those app placements.
Partner Center acceptance has not been tested.

Linux listing screenshots are separate genuine app-window captures. Native
decoration and shadow are required; the current noncomposited candidates need a
composited recapture. See [Linux listing captures](linux-listing-capture.md).
Do not turn a promotional composition into a Flathub screenshot or replace raw
screenshots with historical Mac masters. Follow
[marketing artwork](marketing-artwork.md) for invented demo media and its credits,
then the current [Flathub screenshot rules](https://docs.flathub.org/docs/for-app-authors/metainfo-guidelines/quality-guidelines#screenshots).

## Reproduce

From the repository root after a frozen dependency install:

```sh
node apps/desktop/scripts/store-artwork.ts
pnpm exec prettier --write docs/assets/store/manifest.json
```

The script uses the committed transparent hat master and an explicit Inter font
file. It writes only the five candidates and their manifest. Review each export
at full size and at 160 pixels wide before accepting it. Sharp and its rendering
dependencies may change pixel output across versions; review regenerated files
and record their hashes rather than assuming byte-identical output.

The editable model is `apps/desktop/assets/brand/hat.py`, adapted from the existing
desktop launch film's model. Its geometry follows `mark.svg`; it retains the
same satin materials, lighting and three-quarter camera. Sharp cut edges keep
the smooth crown's normals separate from the flat triangle walls. It contains
only still rendering. Blender 4.5 generated the 3072-pixel master at 96 samples
with a transparent background. To rebuild that master with Blender on your path:

```sh
nice -n 10 blender -b -t 4 -P apps/desktop/assets/brand/hat.py -- \
  --out apps/desktop/assets/brand/hat.png --size 3072 --samples 96 \
  --view three-quarter --background transparent
node apps/desktop/scripts/store-artwork.ts
pnpm exec prettier --write docs/assets/store/manifest.json
```

The project artwork follows the repository licence. Inter is copyright the Inter
Project Authors and uses SIL Open Font License 1.1. The font and its licence are
included in `apps/desktop/assets/brand/fonts`. Keep that licence with redistributed
source. Raster exports do not redistribute the font program.
