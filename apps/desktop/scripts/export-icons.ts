// Renders the app icons from assets/brand/icon.svg and mark.svg.
// build/icon.png: 1024 px macOS icon (the squircle sits on Apple's grid with its margin and shadow).
// build/icon.icns: the same artwork at every size macOS asks for. Shipping it means electron-builder
//   never runs its own PNG to ICNS converter.
// build/icon.ico: Windows icon, cropped to the squircle so it fills the tile like other Windows apps.
// build/appx: the Microsoft Store package's logos, drawn from the bare mark rather than the macOS
//   squircle. electron-builder's appx target packs every file there and indexes the scaled ones.
// ../ios/assets/icon.png: the iOS app's icon, the Store tiles' artwork at 1024 px.
// Usage: pnpm icons:export
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = fileURLToPath(new URL("..", import.meta.url));
const svg = await readFile(`${root}assets/brand/icon.svg`, "utf8");
const mark = await readFile(`${root}assets/brand/mark.svg`, "utf8");
await mkdir(`${root}build`, { recursive: true });

await sharp(Buffer.from(svg), { density: 72 })
  .resize(1024, 1024)
  .png()
  .toFile(`${root}build/icon.png`);

// ICNS element types that hold PNG data, with their pixel sizes.
const icnsTypes: [type: string, size: number][] = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
];
const macImages = await Promise.all(
  icnsTypes.map(async ([type, size]): Promise<[string, Buffer]> => [
    type,
    await sharp(Buffer.from(svg), { density: 72 * (size / 1024) * 4 })
      .resize(size, size)
      .png()
      .toBuffer(),
  ]),
);
await writeFile(`${root}build/icon.icns`, icns(macImages));

// Crop the 1024 canvas to the 824 px squircle body (plus a hair of margin) for Windows.
const windowsSvg = svg.replace('viewBox="0 0 1024 1024"', 'viewBox="92 92 840 840"');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(
  sizes.map((size) =>
    sharp(Buffer.from(windowsSvg), { density: 72 * (size / 840) * 4 })
      .resize(size, size)
      .png()
      .toBuffer(),
  ),
);
await writeFile(`${root}build/icon.ico`, ico(sizes, pngs));

// The Store package's logos, as Windows asks for them (see docs/maintainers/releasing.md):
// - the app list icon at every target size, in three forms: plated, for where Windows wants a
//   tile; unplated, the white mark alone for the dark theme; light-unplated, the black mark alone
//   for the light theme. With all three Windows draws the mark itself in the taskbar and Start,
//   instead of shrinking it onto a system plate.
// - the tiles, StoreLogo and the Windows 10 small and large tiles at every scale: true black with
//   the white mark large in the middle. The manifest's background is black too.
await rm(`${root}build/appx`, { recursive: true, force: true });
await mkdir(`${root}build/appx`);

/** The mark's drawing, without its <svg> element, so it can be placed inside other artwork. */
const markBody = mark.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
/** The mark in `color`, `width` px wide, centred on (x, y). Its hat spans 80 of its 100 units. */
const placedMark = (color: "#fff" | "#000", width: number, x: number, y: number): string => {
  const box = width / 0.8;
  // Only the hat's group ends its fill attribute with ">": the mask's white rect closes with "/>".
  const body = markBody.replace('fill="#fff">', `fill="${color}">`);
  if (color !== "#fff" && body === markBody)
    throw new Error("mark.svg no longer sets the hat's fill.");
  return `<svg x="${x - box / 2}" y="${y - box / 2}" width="${box}" height="${box}" viewBox="0 0 100 100">${body}</svg>`;
};
/** A flat black rounded square with a faint edge, inset 4 %, the white mark at 60 % of it. */
const plate = (size: number): string => {
  const inset = Math.max(1, Math.round(size * 0.04));
  const edge = Math.max(1, size / 64);
  const side = size - inset * 2 - edge;
  return (
    `<rect x="${inset + edge / 2}" y="${inset + edge / 2}" width="${side}" height="${side}" rx="${side * 0.22}" fill="#000" stroke="#fff" stroke-opacity="0.18" stroke-width="${edge}"/>` +
    placedMark("#fff", (size - inset * 2) * 0.6, size / 2, size / 2)
  );
};
/** True black with the white mark `share` of the height wide, in the middle. */
const tile =
  (share: number) =>
  (width: number, height: number): string =>
    `<rect width="${width}" height="${height}" fill="#000"/>` +
    placedMark("#fff", height * share, width / 2, height / 2);

type Logo = {
  name: string;
  width: number;
  height: number;
  draw: (width: number, height: number) => string;
};
const targetSizes = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256];
const scales = [100, 125, 150, 200, 400];
/** A logo `base` px (or `base` by `tall`) at `scale` %, named as Windows looks for it. */
const scaled = (
  name: string,
  scale: number,
  base: number,
  draw: Logo["draw"],
  tall = base,
): Logo => ({
  name: `${name}.scale-${scale}`,
  width: Math.round((base * scale) / 100),
  height: Math.round((tall * scale) / 100),
  draw,
});
const logos: Logo[] = [
  ...targetSizes.flatMap((size): Logo[] => [
    { name: `Square44x44Logo.targetsize-${size}`, width: size, height: size, draw: plate },
    {
      name: `Square44x44Logo.targetsize-${size}_altform-unplated`,
      width: size,
      height: size,
      draw: () => placedMark("#fff", size * 0.9, size / 2, size / 2),
    },
    {
      name: `Square44x44Logo.targetsize-${size}_altform-lightunplated`,
      width: size,
      height: size,
      draw: () => placedMark("#000", size * 0.9, size / 2, size / 2),
    },
  ]),
  ...scales.flatMap((scale) => [
    scaled("Square44x44Logo", scale, 44, plate),
    scaled("Square150x150Logo", scale, 150, tile(0.56)),
    scaled("Wide310x150Logo", scale, 310, tile(0.56), 150),
    scaled("StoreLogo", scale, 50, tile(0.74)),
    // electron-builder adds these to the manifest as the small and large tiles when they exist.
    scaled("SmallTile", scale, 71, tile(0.66)),
    scaled("LargeTile", scale, 310, tile(0.5)),
  ]),
];
await Promise.all(
  logos.map(({ name, width, height, draw }) =>
    sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${draw(width, height)}</svg>`,
      ),
      { density: 72 * 4 },
    )
      .resize(width, height)
      .png()
      .toFile(`${root}build/appx/${name}.png`),
  ),
);

// iOS masks the icon itself and refuses one with an alpha channel, so it gets a full square of
// true black with the mark at the share the macOS squircle gives it, and no alpha.
await mkdir(`${root}../ios/assets`, { recursive: true });
await sharp(
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${tile(0.56)(1024, 1024)}</svg>`,
  ),
  { density: 72 * 4 },
)
  .resize(1024, 1024)
  .removeAlpha()
  .png()
  .toFile(`${root}../ios/assets/icon.png`);
console.log(
  "Wrote build/icon.png, build/icon.icns, build/icon.ico, build/appx and ../ios/assets/icon.png",
);

/** An ICNS file: a big-endian "icns" header followed by one PNG per element type. */
function icns(elements: [type: string, png: Buffer][]): Buffer {
  const chunks = elements.map(([type, png]) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

/** An ICO file that embeds PNG images, which every Windows version since Vista reads. */
function ico(sizes: number[], images: Buffer[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, index) => {
    const size = sizes[index] ?? 0;
    const entry = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  return Buffer.concat([header, ...images]);
}
