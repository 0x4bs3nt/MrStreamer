// Makes public/generated/, the pictures the page shows, from what the repository commits: the
// app captures docs/assets/marketing-*.png (2560 × 1600, see
// docs/contributing/marketing-artwork.md) and the mark in apps/desktop/assets/brand.
//
//   node scripts/prepare-assets.ts            the website's pictures, in public/generated/
//   node scripts/prepare-assets.ts --readme   also the README's poster and mark, in docs/assets/
//
// - <name>-<width>.webp: the whole window, at the widths the page asks for.
// - <name>-cut-<width>.webp: the part of a window a section is about, at one and two pixels a
//   point. The four feature cuts share one shape, 6:5, so the gallery lines up; the stack of
//   windows uses two of them, and a phone shows the Home stage cut above the fold.
// - mark.svg, favicon.svg, favicon-48.png, apple-touch-icon.png: the mark, alone and on black.
// - social.png: 1200 × 630, the Home window on black, for links shared elsewhere.
// - With --readme, in docs/assets: readme-poster.webp, the Home window with the Live TV and TV
//   Guide cuts in front of it on black, and readme-mark-light.svg and readme-mark-dark.svg, the
//   mark in GitHub's text colours. README.md shows these, so they are committed.
//
// public/generated/ is rebuilt on every run and is not committed. index.html names these files
// and the cuts' sizes: change both together.
import { createHash } from "node:crypto";
import manifest from "../../../docs/assets/marketing-capture.json" with { type: "json" };
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp, { type Sharp } from "sharp";

const root = join(import.meta.dirname, "..");
const repository = join(root, "../..");
const assets = join(repository, "docs/assets");
const out = join(root, "public/generated");
const mark = join(repository, "apps/desktop/assets/brand/mark.svg");

/** Widths of the whole window, up to the capture's own. */
const WIDTHS = [960, 1440, 1920, 2560];
/** Pixels in a capture for each of the window's points. */
const SCALE = 2;
/** The five captures, each the whole window in points (1280 × 800). */
const MASTERS = ["home", "live-tv", "tv-guide", "library", "watching"] as const;
type Master = (typeof MASTERS)[number];
interface Cut {
  readonly master: Master;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
/**
 * The parts of the windows the page shows close up, in points: what each section is about, at a
 * size that stays readable in a narrow column.
 */
const CUTS: Readonly<Record<string, Cut>> = {
  // What a phone shows of Home above the fold: the stage preview, favourites and the rows' start.
  "home-stage": { master: "home", left: 16, top: 56, width: 574, height: 540 },
  // The playing preview and the channel list with what's on.
  "live-tv": { master: "live-tv", left: 236, top: 56, width: 600, height: 500 },
  // The catch-up signs, the open programme's Play from start and the now line.
  "tv-guide": { master: "tv-guide", left: 246, top: 236, width: 600, height: 500 },
  // The story, cast, Play and Save.
  library: { master: "library", left: 174, top: 60, width: 600, height: 500 },
  // The subtitle on the picture beside the subtitle panel.
  watching: { master: "watching", left: 396, top: 42, width: 884, height: 737 },
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const webp = { quality: 88, effort: 5 };
/** A capture, checked against its manifest entry, as sharp reads it. */
const captures = new Map<Master, Sharp>();
for (const name of MASTERS) {
  const file = `marketing-${name}.png`;
  const bytes = readFileSync(join(assets, file));
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
  captures.set(name, capture);
  for (const width of WIDTHS) {
    await capture
      .clone()
      .resize({ width })
      .webp(webp)
      .toFile(join(out, `${name}-${width}.webp`));
  }
}
const captureOf = (name: Master): Sharp => {
  const capture = captures.get(name);
  if (!capture) throw new Error(`No capture for ${name}.`);
  return capture;
};
/** The pixels of a cut, as the master holds them. */
const cutOf = ({ master, left, top, width, height }: Cut): Sharp =>
  captureOf(master)
    .clone()
    .extract({
      left: left * SCALE,
      top: top * SCALE,
      width: width * SCALE,
      height: height * SCALE,
    });
for (const [name, cut] of Object.entries(CUTS)) {
  for (const width of [cut.width, cut.width * SCALE]) {
    await cutOf(cut)
      .resize({ width })
      .webp(webp)
      .toFile(join(out, `${name}-cut-${width}.webp`));
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

/** A window `width` wide on black: its corners rounded and a thin frame around it. */
async function framed(
  picture: Sharp,
  width: number,
  radius: number,
  stroke: string,
): Promise<{ readonly input: Buffer; readonly height: number }> {
  const resized = await picture.resize({ width }).png().toBuffer();
  const { height = 0 } = await sharp(resized).metadata();
  const rounded = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="${width}" height="${height}" rx="${radius}"/></svg>`,
  );
  const frame = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect x=".5" y=".5" width="${width - 1}" height="${height - 1}" rx="${radius}" fill="none" stroke="${stroke}"/></svg>`,
  );
  const input = await sharp(resized)
    .composite([
      { input: rounded, blend: "dest-in" },
      { input: frame, blend: "over" },
    ])
    .png()
    .toBuffer();
  return { input, height };
}

// The complete Home window on black, keeping its recommendation and permanent actions visible.
const SOCIAL = { width: 1200, height: 630, window: 848, top: 96, radius: 16 };
const home = await framed(captureOf("home").clone(), SOCIAL.window, SOCIAL.radius, "#333");
await sharp({
  create: { width: SOCIAL.width, height: SOCIAL.height, channels: 3, background: "#000" },
})
  .composite([
    {
      input: await sharp(home.input)
        .extract({
          left: 0,
          top: 0,
          width: SOCIAL.window,
          height: Math.min(home.height, SOCIAL.height - SOCIAL.top),
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

if (process.argv.includes("--readme")) {
  // The mark in GitHub's own text colours, so README.md shows it in both of GitHub's themes.
  const white = '<g transform="translate(0 3)" fill="#fff">';
  const source = readFileSync(mark, "utf8");
  if (!source.includes(white)) throw new Error("mark.svg no longer paints its shape white.");
  writeFileSync(
    join(assets, "readme-mark-light.svg"),
    source.replace(white, white.replace("#fff", "#1f2328")),
  );
  writeFileSync(
    join(assets, "readme-mark-dark.svg"),
    source.replace(white, white.replace("#fff", "#e6edf3")),
  );

  // The Home window with the Live TV and TV Guide cuts in front of it, lower right, on black. The
  // windows are black too, so the poster reads the same on GitHub's light and dark themes.
  const POSTER = { width: 1400, height: 900, window: 1120, cut: 460, radius: 10 };
  const frame = "#3a3a3a";
  const liveTv = CUTS["live-tv"];
  const tvGuide = CUTS["tv-guide"];
  if (!liveTv || !tvGuide) throw new Error("The poster needs the Live TV and TV Guide cuts.");
  const layers = [
    {
      ...(await framed(captureOf("home").clone(), POSTER.window, POSTER.radius, frame)),
      left: 40,
      top: 40,
    },
    { ...(await framed(cutOf(liveTv), POSTER.cut, POSTER.radius, frame)), left: 560, top: 470 },
    { ...(await framed(cutOf(tvGuide), POSTER.cut, POSTER.radius, frame)), left: 900, top: 500 },
  ];
  await sharp({
    create: { width: POSTER.width, height: POSTER.height, channels: 3, background: "#000" },
  })
    .composite(layers.map(({ input, left, top }) => ({ input, left, top })))
    .webp({ quality: 72, effort: 6 })
    .toFile(join(assets, "readme-poster.webp"));
}
