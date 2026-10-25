import { CHANNEL, ORIGINALS, type MediaIndex, type RenditionId } from "./catalogue.ts";

export const EPOCH = Date.UTC(2026, 0, 1);
const SEGMENT_MS = 6000;
const CYCLE_MS = 330_000;

const boundary = (n: number) => n > 0 && [0, 25, 40].includes(n % 55);

/** The fixed video clock, shared by playlists and XMLTV, never the longest audio track. */
export function completedSequence(now: number): number {
  return Math.floor((now - EPOCH) / SEGMENT_MS) - 1;
}

export function masterPlaylist(media: MediaIndex): string {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    ...media.renditions.flatMap((r) => [
      `#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},AVERAGE-BANDWIDTH=${r.averageBandwidth},CODECS="${r.codecs}",RESOLUTION=${r.width}x${r.height},FRAME-RATE=${r.frameRate.toFixed(3)}`,
      `${CHANNEL.id}/${media.release}/${r.id}.m3u8`,
    ]),
    "",
  ].join("\n");
}

/** A rolling window of complete video segments, optionally one older to avoid an initial seam. */
export function rollingPlaylist(
  media: MediaIndex,
  rendition: RenditionId,
  now: number,
): string | null {
  const last = completedSequence(now);
  let first = last - 149;
  if (boundary(first) || first === 0) first--;
  if (!Number.isSafeInteger(first) || first < 0) return null;
  const through = first - 1;
  const cycles = Math.floor(through / 55);
  const rest = through % 55;
  const discontinuities = cycles * 3 + Number(rest >= 25) + Number(rest >= 40);
  const rows = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-TARGETDURATION:6",
    `#EXT-X-MEDIA-SEQUENCE:${first}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${discontinuities}`,
  ];
  for (let n = first; n <= last; n++) {
    const segment = media.segments[n % media.segments.length];
    if (!segment) return null;
    if (boundary(n)) rows.push("#EXT-X-DISCONTINUITY");
    rows.push(
      `#EXT-X-PROGRAM-DATE-TIME:${new Date(EPOCH + n * SEGMENT_MS).toISOString()}`,
      `#EXTINF:${(segment.videoDurationTicks / 90000).toFixed(3)},`,
      `${rendition}/${n}.ts`,
    );
  }
  return rows.join("\n") + "\n";
}

const xml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
const xmlTime = (time: number) =>
  new Date(time).toISOString().replace(/[-:T]/g, "").slice(0, 14) + " +0000";

export function guideDocument(now: number): string {
  const since = now - 3_600_000;
  const until = now + 86_400_000;
  const firstCycle = Math.max(0, Math.floor((since - EPOCH) / CYCLE_MS));
  const rows = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tv generator-info-name="Mr. Streamer original samples">',
    `<channel id="${CHANNEL.guideId}"><display-name>${xml(CHANNEL.name)}</display-name></channel>`,
  ];
  for (let cycle = firstCycle; EPOCH + cycle * CYCLE_MS < until; cycle++) {
    let start = EPOCH + cycle * CYCLE_MS;
    for (const original of ORIGINALS) {
      const stop = start + (original.frames / 24) * 1000;
      if (stop > since && start < until)
        rows.push(
          `<programme channel="${CHANNEL.guideId}" start="${xmlTime(start)}" stop="${xmlTime(stop)}"><title>${xml(original.name)}</title><desc>Original generated shapes and a quiet tone. No speech.</desc></programme>`,
        );
      start = stop;
    }
  }
  rows.push("</tv>");
  return rows.join("\n") + "\n";
}
