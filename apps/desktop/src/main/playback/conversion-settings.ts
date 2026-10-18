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

// Chromium cannot always read converted 5.1 AAC, and plays 5.1 as stereo on stereo outputs anyway.
export const AAC_STEREO_ARGUMENTS = ["-c:a", "aac", "-b:a", "192k", "-ac", "2"] as const;
