// Conversion settings shared by the local and receiver planners. Each planner keeps its own
// encoder timing, track maps, clocks and output format.

// Deinterlace frames marked as interlaced, and keep 4K within 1080p so conversion keeps up on an
// ordinary CPU. All converted pictures use 8-bit 4:2:0.
export const H264_IMAGE_ARGUMENTS = [
  "-vf",
  "yadif=deint=interlaced,scale=w='min(1920,iw)':h=-2",
  "-pix_fmt",
  "yuv420p",
] as const;

/** Fit each HLS epoch by display aspect ratio inside a stable square-pixel canvas. */
export function h264ImageArguments(
  picture: { readonly width: number; readonly height: number } | null,
) {
  const [filterOption, filter, ...pixelFormat] = H264_IMAGE_ARGUMENTS;
  return [
    filterOption,
    picture
      ? `${filter},scale=w='max(2,round(min(${picture.width},${picture.height}*dar)/2)*2)':h='max(2,round(min(${picture.height},${picture.width}/dar)/2)*2)',setsar=1,pad=${picture.width}:${picture.height}:(ow-iw)/2:(oh-ih)/2`
      : filter,
    ...pixelFormat,
  ];
}

// Chromium cannot always read converted 5.1 AAC, and plays 5.1 as stereo on stereo outputs anyway.
export const AAC_STEREO_ARGUMENTS = ["-c:a", "aac", "-b:a", "192k", "-ac", "2"] as const;
