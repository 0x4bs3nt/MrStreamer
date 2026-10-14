// Makes public/generated/, the pictures the page shows, from what the repository commits: the
// app captures docs/assets/marketing-*.png (2560 × 1600, see
// docs/contributing/marketing-artwork.md) and the mark in apps/desktop/assets/brand.
//
//   node scripts/prepare-assets.ts
//
// - <name>-<width>.webp: the whole window, at the widths the page asks for.
// - <name>-phone-<width>.webp: the part of the window a phone shows, large enough to read.
// - mark.svg, favicon.svg, favicon-48.png, apple-touch-icon.png: the mark, alone and on black.
// - social.png: 1200 × 630, the Home window on black, for links shared elsewhere.
//
// The folder is rebuilt on every run and is not committed. index.html names these files and the
// phone pictures' sizes: change both together.
import { createHash } from "node:crypto";
import manifest from "../../../docs/assets/marketing-capture.json" with { type: "json" };
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const root = join(import.meta.dirname, "..");
const repository = join(root, "../..");
const out = join(root, "public/generated");
const mark = join(repository, "apps/desktop/assets/brand/mark.svg");

/** Widths of the whole window, up to the capture's own. */
const WIDTHS = [960, 1440, 1920, 2560];
/** Pixels in a capture for each of the window's points. */
const SCALE = 2;
/**
 * Each capture, and the part of it a phone shows, in the window's points (1280 × 800): what the
 * section is about, at a size that stays readable on a narrow screen.
 */
const SHOTS = {
  // Home keeps its actions, compact preview and personalized rows together.
  home: { left: 0, top: 0, width: 1280, height: 800 },
  "live-tv": { left: 236, top: 56, width: 600, height: 650 },
  // The catch-up signs, the open programme's Play from start and the now line.
  "tv-guide": { left: 250, top: 236, width: 632, height: 564 },
  library: { left: 164, top: 53, width: 620, height: 700 },
  // The subtitle panel moved to the right; retain it alongside the actual subtitle.
  watching: { left: 396, top: 42, width: 884, height: 758 },
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const webp = { quality: 88, effort: 5 };
for (const [name, phone] of Object.entries(SHOTS)) {
  const file = `marketing-${name}.png`;
  const bytes = readFileSync(join(repository, "docs/assets", file));
  const recorded = manifest.captures.find((capture) => capture.file === file);
  if (
    !recorded ||
    recorded.bytes !== bytes.length ||
    recorded.sha256 !== createHash("sha256").update(bytes).digest("hex")
  )
    throw new Error(`${file} differs from its capture manifest; regenerate captures together.`);
  const capture = sharp(bytes);
  const size = await capture.metadata();
  if (size.width !== 2560 || size.height !== 1600 || size.format !== "png")
    throw new Error(`${name} must be the lossless 2560 × 1600 PNG master.`);
  for (const width of WIDTHS) {
    await capture
      .clone()
      .resize({ width })
      .webp(webp)
      .toFile(join(out, `${name}-${width}.webp`));
  }
  const part = capture.clone().extract({
    left: phone.left * SCALE,
    top: phone.top * SCALE,
    width: phone.width * SCALE,
    height: phone.height * SCALE,
  });
  for (const width of [phone.width, phone.width * SCALE]) {
    await part
      .clone()
      .resize({ width })
      .webp(webp)
      .toFile(join(out, `${name}-phone-${width}.webp`));
  }
}

// The mark is white: on black with rounded corners it shows on any tab bar or home screen.
copyFileSync(mark, join(out, "mark.svg"));
const favicon =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">` +
  `<rect width="100" height="100" rx="22" fill="#000"/>` +
  `<image x="14" y="14" width="72" height="72" href="data:image/svg+xml;base64,${readFileSync(mark).toString("base64")}"/></svg>`;
writeFileSync(join(out, "favicon.svg"), favicon);
await sharp(Buffer.from(favicon), { density: 300 })
  .resize(48)
  .png()
  .toFile(join(out, "favicon-48.png"));
// Square: iOS rounds the corners itself.
await sharp(Buffer.from(favicon.replace('rx="22"', 'rx="0"')), { density: 600 })
  .resize(180)
  .png()
  .toFile(join(out, "apple-touch-icon.png"));

// The complete Home window on black, keeping its recommendation and permanent actions visible.
const SOCIAL = { width: 1200, height: 630, window: 848, top: 96, radius: 16 };
const windowHeight = (SOCIAL.window * 800) / 1280;
const rounded = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SOCIAL.window}" height="${windowHeight}">` +
    `<rect width="${SOCIAL.window}" height="${windowHeight}" rx="${SOCIAL.radius}"/></svg>`,
);
const frame = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SOCIAL.window}" height="${windowHeight}">` +
    `<rect x=".5" y=".5" width="${SOCIAL.window - 1}" height="${windowHeight - 1}" rx="${SOCIAL.radius}" fill="none" stroke="#333"/></svg>`,
);
const home = await sharp(join(repository, "docs/assets/marketing-home.png"))
  .resize({ width: SOCIAL.window })
  .composite([
    { input: rounded, blend: "dest-in" },
    { input: frame, blend: "over" },
  ])
  .png()
  .toBuffer();
await sharp({
  create: { width: SOCIAL.width, height: SOCIAL.height, channels: 3, background: "#000" },
})
  .composite([
    {
      input: await sharp(home)
        .extract({
          left: 0,
          top: 0,
          width: SOCIAL.window,
          height: Math.min(windowHeight, SOCIAL.height - SOCIAL.top),
        })
        .toBuffer(),
      left: (SOCIAL.width - SOCIAL.window) / 2,
      top: SOCIAL.top,
    },
    {
      input: await sharp(mark, { density: 300 }).resize(44).toBuffer(),
      left: (SOCIAL.width - 44) / 2,
      top: 26,
    },
  ])
  .png({ compressionLevel: 9 })
  .toFile(join(out, "social.png"));
