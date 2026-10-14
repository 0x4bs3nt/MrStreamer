// How much of a guide the app reads. A guide past any of these is refused whole, and says so:
// none of it is used, rather than part of it shown as if it were all.
//
// Programmes are kept on disk (index-file.ts), not in memory, so how many a guide lists has no
// limit of its own: the size of the document bounds them.

export interface GuideLimits {
  /** The document, unpacked, and also as it downloads. */
  readonly bytes: number;
  /** One channel or programme, from its opening tag to its closing one. */
  readonly elementBytes: number;
  /** The channels the guide lists, which its index keeps in memory. */
  readonly channels: number;
}

/**
 * The limits every guide is read under, set against the largest real guide the budgets are
 * measured with (apps/desktop/scripts/measure-guide.ts): a US guide of 512 MiB unpacked, 82 MB
 * packed, 12,994 channels and 1.18 million programmes over ten days.
 *   - 2 GiB unpacked, four times that guide: a gzip of a few megabytes can unpack no further.
 *   - 1 MiB for one element, where real guides' are under a kilobyte: one that never closes
 *     stops there.
 *   - 50,000 guide channels, nearly four times that guide's. Each costs about 200 bytes in
 *     memory while its guide is in use.
 */
export const GUIDE_LIMITS: GuideLimits = {
  bytes: 2 * 1024 * 1024 * 1024,
  elementBytes: 1024 * 1024,
  channels: 50_000,
};

/**
 * What an index keeps of a guide that is read: past these, a guide isn't refused, its index keeps
 * less. They bound every row, so whatever reads one reads a few kilobytes at most, and every
 * stretch of time, so a day of one channel holds 1,440 programmes at most.
 *   - A title of 300 characters and a description of 2,000, cut where a character ends.
 *   - A channel's name of 128 characters. A channel whose id is longer is no channel the app
 *     keeps: it and its programmes are passed over, as a programme it can't read is.
 *   - Programmes a minute long or longer, once laid out in time: a shorter one is dropped.
 */
export const GUIDE_KEPT = {
  titleChars: 300,
  descriptionChars: 2_000,
  nameChars: 128,
  idChars: 128,
  shortestMs: 60_000,
} as const;
