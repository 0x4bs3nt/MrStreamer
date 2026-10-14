// Passes a recording on no faster than it plays. A catch-up archive is a file to the provider,
// which may send it as fast as the network allows; the player keeps a live stream's every byte
// until it plays, and a programme's worth would fill its buffer. The recording's own clock, the
// program clock references (PCR) of its MPEG-TS packets, says how far into it each chunk is; a
// chunk more than `leadS` seconds ahead of the time it has been playing waits for that time.
//
// It also ends the recording once that clock passes `endS`, as a catch-up address that names no
// end plays on into the programmes after; returning closes the provider's connection.
//
// Only the first PID that carries a PCR counts. A jump of the clock, backwards or by more than a
// few seconds, is a cut in the recording rather than time passing, and adds nothing; so is the
// step to the first PCR at or after a packet of that PID that the stream marks as a
// discontinuity (the adaptation field's discontinuity_indicator), with a PCR or without one: the
// clock counts anew from there.
const PACKET = 188;
const SYNC = 0x47;
const PCR_HZ = 90_000;
const PCR_WRAP = 2 ** 33;
/** A step of the clock between two PCRs that counts as time passing; more is a cut. */
const MAX_STEP_S = 5;

/**
 * `chunks` as they come, each held back until it is at most `leadS` seconds ahead of how long the
 * stream has been sent, and none after the one that reaches `endS` seconds of the recording.
 * `now` gives milliseconds; `signal` ends a wait.
 */
export async function* paced(
  chunks: AsyncIterable<Uint8Array>,
  leadS: number,
  signal: AbortSignal,
  { endS = Infinity, now = () => performance.now() }: { endS?: number; now?: () => number } = {},
): AsyncGenerator<Uint8Array> {
  /** Bytes of a packet that continues in the next chunk. */
  let carry = new Uint8Array(0);
  let pid: number | null = null;
  let previous: number | null = null;
  /** The stream marked a discontinuity since the last PCR: the next one counts anew. */
  let cut = false;
  /** Seconds of the recording sent so far, by its clock. */
  let media = 0;
  let started: number | null = null;
  for await (const chunk of chunks) {
    const data = carry.length ? join(carry, chunk) : chunk;
    let offset = 0;
    while (offset + PACKET <= data.length) {
      // Out of step with the packets: on to the next sync byte.
      if (data[offset] !== SYNC) {
        offset++;
        continue;
      }
      const clock = pcrOf(data, offset);
      const marked = discontinuity(data, offset);
      const packetPid = ((data[offset + 1]! & 0x1f) << 8) | data[offset + 2]!;
      offset += PACKET;
      if (clock !== null) pid ??= packetPid;
      if (packetPid !== pid) continue;
      cut ||= marked;
      if (clock === null) continue;
      if (previous !== null && !cut) {
        const step = ((clock - previous + PCR_WRAP) % PCR_WRAP) / PCR_HZ;
        if (step <= MAX_STEP_S) media += step;
      }
      previous = clock;
      cut = false;
    }
    carry = data.slice(offset);
    started ??= now();
    const ahead = media - (now() - started) / 1000;
    if (ahead > leadS) await wait((ahead - leadS) * 1000, signal);
    if (signal.aborted) return;
    yield chunk;
    if (media >= endS) return;
  }
}

/** Whether the packet at `offset` has an adaptation field that marks a discontinuity. */
function discontinuity(data: Uint8Array, offset: number): boolean {
  const adaptation = (data[offset + 3]! >> 4) & 0x02;
  return adaptation !== 0 && data[offset + 4]! > 0 && (data[offset + 5]! & 0x80) !== 0;
}

/** The 90 kHz base of the PCR in the packet at `offset`, or null when it carries none. */
function pcrOf(data: Uint8Array, offset: number): number | null {
  const adaptation = (data[offset + 3]! >> 4) & 0x02;
  if (!adaptation || data[offset + 4]! < 7 || (data[offset + 5]! & 0x10) === 0) return null;
  return (
    data[offset + 6]! * 2 ** 25 +
    (data[offset + 7]! << 17) +
    (data[offset + 8]! << 9) +
    (data[offset + 9]! << 1) +
    (data[offset + 10]! >> 7)
  );
}

function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  return joined;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
