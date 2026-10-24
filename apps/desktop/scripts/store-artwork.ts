// Export the selected hat artwork. This prepares files only; it never updates a listing.
// node apps/desktop/scripts/store-artwork.ts
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp, { type OverlayOptions } from "sharp";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const brand = `${root}/apps/desktop/assets/brand`;
const output = `${root}/docs/assets/store`;
const font = `${brand}/fonts/Inter.ttf`;
const hat = await sharp(`${brand}/hat.png`).trim().png().toBuffer();
await mkdir(output, { recursive: true });

async function text(value: string, size: number, weight: number) {
  return sharp({
    text: {
      text: `<span foreground="#fff" weight="${weight}">${value}</span>`,
      font: `Inter ${size}`,
      fontfile: font,
      dpi: 72,
      rgba: true,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
}

const layouts = [
  {
    name: "signature-landscape",
    width: 3840,
    height: 2160,
    hat: { left: 300, top: 260, width: 1580, height: 1640 },
    title: { left: 1960, top: 880, size: 180 },
    caption: { left: 1968, top: 1120, size: 88, text: "Live TV, movies and series." },
    placement: "Landscape creative master; source for the trailer thumbnail.",
  },
  {
    name: "signature-portrait",
    width: 1080,
    height: 1920,
    hat: { left: 100, top: 310, width: 880, height: 940 },
    title: { top: 1390, size: 116 },
    caption: { top: 1560, size: 38, text: "Live TV, movies and series." },
    placement: "9:16 creative master. No Microsoft app poster slot is claimed.",
  },
  {
    name: "signature-square",
    width: 2160,
    height: 2160,
    hat: { left: 500, top: 180, width: 1160, height: 1260 },
    title: { top: 1590, size: 196 },
    caption: { top: 1850, size: 64, text: "Live TV, movies and series." },
    placement: "Square creative master. This is not a Microsoft game box or app icon.",
  },
  {
    name: "store-hero",
    width: 3840,
    height: 2160,
    hat: { left: 1240, top: 70, width: 1360, height: 1320 },
    placement: "Microsoft Store 16:9 hero candidate. Text-free, detail in the upper two thirds.",
  },
];

const exports = [];
for (const layout of layouts) {
  const picture = await sharp(hat)
    .resize(layout.hat.width, layout.hat.height, { fit: "inside" })
    .toBuffer({ resolveWithObject: true });
  const layers: OverlayOptions[] = [
    {
      input: picture.data,
      left: layout.hat.left + Math.round((layout.hat.width - picture.info.width) / 2),
      top: layout.hat.top + Math.round((layout.hat.height - picture.info.height) / 2),
    },
  ];
  for (const line of [
    ...("title" in layout ? [{ ...layout.title, text: "mr. streamer", weight: 800 }] : []),
    ...("caption" in layout ? [{ ...layout.caption, weight: 450 }] : []),
  ]) {
    const image = await text(line.text, line.size, line.weight);
    layers.push({
      input: image.data,
      top: line.top,
      left: "left" in line ? line.left : Math.round((layout.width - image.info.width) / 2),
    });
  }
  const bytes = await sharp({
    create: {
      width: layout.width,
      height: layout.height,
      channels: 3,
      background: "#000",
    },
  })
    .composite(layers)
    .removeAlpha()
    .png()
    .toBuffer();
  await writeFile(`${output}/${layout.name}.png`, bytes);
  exports.push({
    file: `${layout.name}.png`,
    width: layout.width,
    height: layout.height,
    format: "PNG",
    alpha: false,
    placement: layout.placement,
    layout,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

const thumbnail = await sharp(`${output}/signature-landscape.png`)
  .resize(1920, 1080)
  .png()
  .toBuffer();
await writeFile(`${output}/store-trailer-thumbnail.png`, thumbnail);
exports.push({
  file: "store-trailer-thumbnail.png",
  width: 1920,
  height: 1080,
  format: "PNG",
  alpha: false,
  placement:
    "Microsoft Store trailer thumbnail candidate. Final acceptance and upload are separate.",
  bytes: thumbnail.length,
  sha256: createHash("sha256").update(thumbnail).digest("hex"),
});

const sources = await Promise.all(
  ["hat.py", "hat.png", "mark.svg", "fonts/Inter.ttf", "fonts/Inter-LICENSE.txt"].map(
    async (file) => ({
      file: `apps/desktop/assets/brand/${file}`,
      sha256: createHash("sha256")
        .update(await readFile(`${brand}/${file}`))
        .digest("hex"),
    }),
  ),
);
await writeFile(
  `${output}/manifest.json`,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      direction: "B: The signature, selected by Wout on 2026-10-23",
      acceptance:
        "Candidate exports. Final visual acceptance and listing publication are separate.",
      provenance: {
        hat: "Existing Mr. Streamer launch-film model, derived from mark.svg. Static Blender 4.5 render, 3072px, 96 samples. No generative image model or product UI is used.",
        font: "Inter variable, SIL Open Font License 1.1. Licence included beside the font.",
        copy: ["mr. streamer", "Live TV, movies and series."],
        screenshots: "No screenshots in promotional exports. Genuine Linux captures are separate.",
      },
      rules: {
        checked: "2026-10-23",
        source:
          "https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/screenshots-and-images",
        thumbnail: "1920x1080 PNG, less than 50 MB.",
        hero: "3840x2160 PNG, text-free, no UI/devices, important details centred above the bottom third.",
        creativeMasters:
          "Portrait and square are ratio-specific masters, not confirmed Microsoft app slots.",
      },
      sources,
      exports,
    },
    null,
    2,
  )}\n`,
);
