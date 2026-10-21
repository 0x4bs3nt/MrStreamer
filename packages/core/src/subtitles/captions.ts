// Closed captions (CEA-608), as broadcasts carry them inside the picture: ATSC A/53 user data in
// SEI messages holds two bytes a field per frame. Channels 1 and 2 share field one, 3 and 4 field
// two. Captions build up in memory and show as pop-on (a whole caption at once), roll-up (lines
// scrolling up) or paint-on (letters as they arrive).
import type { SubtitleChange } from "./screen.ts";

/**
 * The CEA-608 byte pairs in one H.264 or HEVC SEI NAL unit, three bytes each: the field (0 or
 * 1), then the pair. Empty when it carries none.
 */
export function captionPairs(nal: Uint8Array, codec: "h264" | "hevc"): Uint8Array {
  const rbsp = unescape(nal.subarray(codec === "hevc" ? 2 : 1));
  const pairs: number[] = [];
  for (let offset = 0; offset < rbsp.length && rbsp[offset] !== 0x80;) {
    let type = 0;
    while (rbsp[offset] === 0xff) type += rbsp[offset++]!;
    type += rbsp[offset++] ?? 0;
    let size = 0;
    while (rbsp[offset] === 0xff) size += rbsp[offset++]!;
    size += rbsp[offset++] ?? 0;
    const payload = rbsp.subarray(offset, offset + size);
    offset += size;
    // Registered user data: USA, ATSC, "GA94", closed captions.
    if (
      type !== 4 ||
      payload.length < 10 ||
      payload[0] !== 0xb5 ||
      payload[1] !== 0x00 ||
      payload[2] !== 0x31 ||
      String.fromCharCode(...payload.subarray(3, 7)) !== "GA94" ||
      payload[7] !== 0x03 ||
      !(payload[8]! & 0x40)
    ) {
      continue;
    }
    const count = payload[8]! & 0x1f;
    for (let index = 0; index < count; index++) {
      const at = 10 + index * 3;
      if (at + 3 > payload.length) break;
      const marker = payload[at]!;
      // Valid, and CEA-608 for field one or two; CEA-708 packets are left out.
      if (!(marker & 0x04) || (marker & 0x03) > 1) continue;
      pairs.push(marker & 0x01, payload[at + 1]!, payload[at + 2]!);
    }
  }
  return Uint8Array.from(pairs);
}

/** The caption pairs in one picture's PES packet, from its SEI NAL units, in Annex B. */
export function captionsInPicture(payload: Uint8Array, codec: "h264" | "hevc"): Uint8Array {
  const found: Uint8Array[] = [];
  for (const nal of nalUnits(payload)) {
    const sei =
      codec === "h264" ? (nal[0]! & 0x1f) === 6 : [39, 40].includes((nal[0]! >> 1) & 0x3f);
    if (sei) found.push(captionPairs(nal, codec));
  }
  const joined = new Uint8Array(found.reduce((sum, pairs) => sum + pairs.length, 0));
  let at = 0;
  for (const pairs of found) {
    joined.set(pairs, at);
    at += pairs.length;
  }
  return joined;
}

/**
 * The caption pairs in one packet of a CEA-608 track as ffmpeg reads it from a file: three bytes
 * each there too, a marker that names the field, then the pair.
 */
export function captionsInTrack(packet: Uint8Array): Uint8Array {
  const pairs: number[] = [];
  for (let at = 0; at + 3 <= packet.length; at += 3) {
    const marker = packet[at]!;
    // Valid, and CEA-608 for field one or two, as in a picture's user data.
    if (!(marker & 0x04) || (marker & 0x03) > 1) continue;
    pairs.push(marker & 0x01, packet[at + 1]!, packet[at + 2]!);
  }
  return Uint8Array.from(pairs);
}

/** NAL units in Annex B data, each from its header byte. */
function* nalUnits(data: Uint8Array): Generator<Uint8Array> {
  let start = -1;
  for (let index = 2; index < data.length;) {
    const byte = data[index]!;
    // Only zero can be inside a start code ending in either of the next two bytes.
    if (byte > 1) {
      index += 3;
    } else if (byte === 0) {
      index++;
    } else if (data[index - 1] === 0 && data[index - 2] === 0) {
      if (start >= 0) yield trimZeros(data.subarray(start, index - 2));
      start = index + 1;
      index += 3;
    } else {
      index += 3;
    }
  }
  if (start >= 0 && start < data.length) yield data.subarray(start);
}

/** A NAL unit without the zero byte of a four-byte start code after it. */
function trimZeros(nal: Uint8Array): Uint8Array {
  let end = nal.length;
  while (end > 0 && nal[end - 1] === 0) end--;
  return nal.subarray(0, end);
}

/** Removes the emulation prevention bytes: 00 00 03 becomes 00 00. */
function unescape(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let length = 0;
  for (let index = 0; index < data.length; index++) {
    if (index >= 2 && data[index] === 3 && data[index - 1] === 0 && data[index - 2] === 0) continue;
    out[length++] = data[index]!;
  }
  return out.subarray(0, length);
}

const ROWS = 15;
const COLUMNS = 32;

type Memory = string[][];

/**
 * Decodes caption channel `channel`, 1 to 4. Feed it the pairs `captionPairs` found, with their
 * time; it answers with the lines on screen whenever they change.
 */
export function captionDecoder(channel: number) {
  const field = channel <= 2 ? 0 : 1;
  const dataChannel = (channel - 1) % 2;
  let displayed = blank();
  let hidden = blank();
  let mode: "pop-on" | "roll-up" | "paint-on" = "pop-on";
  let rollRows = 2;
  let row = ROWS - 1;
  let column = 0;
  /** The data channel the last control code chose; letters belong to it. */
  let current = -1;
  /** The last control pair, sent twice in a row as a rule. */
  let previous = -1;
  /** Text mode, which channels use for other services; captions resume with a caption command. */
  let text = false;
  let shown = "";

  const memory = () => (mode === "pop-on" ? hidden : displayed);

  function put(char: string): void {
    if (text || current !== dataChannel) return;
    const target = memory();
    if (column < COLUMNS) target[row]![column] = char;
    column = Math.min(column + 1, COLUMNS);
  }

  function control(first: number, second: number): void {
    const code = first & 0xf7;
    if ((first & 0xf6) === 0x14 && second >= 0x20 && second <= 0x2f) {
      misc(second);
      return;
    }
    if (code === 0x17 && second >= 0x21 && second <= 0x23) {
      column = Math.min(column + (second - 0x20), COLUMNS - 1);
      return;
    }
    if (code === 0x11 && second >= 0x20 && second <= 0x2f) {
      // A mid-row code changes the colour or style and shows as a space.
      put(" ");
      return;
    }
    if (code === 0x11 && second >= 0x30 && second <= 0x3f) {
      put(SPECIAL[second - 0x30]!);
      return;
    }
    if ((code === 0x12 || code === 0x13) && second >= 0x20 && second <= 0x3f) {
      // An extended character replaces the standard one sent before it.
      column = Math.max(0, column - 1);
      put(EXTENDED[(code - 0x12) * 32 + second - 0x20]!);
      return;
    }
    if (second >= 0x40 && second <= 0x7f) {
      const rows = PAC_ROWS[code & 0x07];
      if (!rows) return;
      const target = second & 0x20 ? rows[1] : rows[0];
      if (target === undefined) return;
      if (mode === "roll-up") {
        // The base row moves; the lines above come with it.
        moveRollUp(target - 1);
      } else {
        row = target - 1;
      }
      column = second & 0x10 ? ((second >> 1) & 0x07) * 4 : 0;
    }
  }

  function misc(command: number): void {
    switch (command) {
      case 0x20: // Resume caption loading
        text = false;
        mode = "pop-on";
        break;
      case 0x21: // Backspace
        if (column > 0) memory()[row]![--column] = " ";
        break;
      case 0x24: // Delete to end of row
        for (let at = column; at < COLUMNS; at++) memory()[row]![at] = " ";
        break;
      case 0x25: // Roll-up, two, three or four rows
      case 0x26:
      case 0x27:
        text = false;
        if (mode !== "roll-up") {
          displayed = blank();
          hidden = blank();
          row = ROWS - 1;
        }
        mode = "roll-up";
        rollRows = command - 0x23;
        column = 0;
        break;
      case 0x29: // Resume direct captioning
        text = false;
        mode = "paint-on";
        break;
      case 0x2a: // Text restart and resume text display
      case 0x2b:
        text = true;
        break;
      case 0x2c: // Erase displayed memory
        displayed = blank();
        break;
      case 0x2d: // Carriage return
        if (mode === "roll-up") {
          for (let at = row - rollRows + 1; at < row; at++) {
            if (at >= 0) displayed[at] = displayed[at + 1]!;
          }
          displayed[row] = Array<string>(COLUMNS).fill(" ");
          for (let at = 0; at <= row - rollRows; at++)
            displayed[at] = Array<string>(COLUMNS).fill(" ");
        } else {
          row = Math.min(row + 1, ROWS - 1);
        }
        column = 0;
        break;
      case 0x2e: // Erase non-displayed memory
        hidden = blank();
        break;
      case 0x2f: // End of caption: the loaded caption shows
        text = false;
        [displayed, hidden] = [hidden, displayed];
        mode = "pop-on";
        break;
    }
  }

  function moveRollUp(base: number): void {
    if (base === row) return;
    const lines = [];
    for (let offset = rollRows - 1; offset >= 0; offset--) lines.push(displayed[row - offset]);
    displayed = blank();
    lines.forEach((line, index) => {
      const at = base - (rollRows - 1) + index;
      if (line && at >= 0) displayed[at] = line;
    });
    row = base;
  }

  return {
    push(pairs: Uint8Array, at: number): SubtitleChange | null {
      for (let offset = 0; offset + 3 <= pairs.length; offset += 3) {
        if (pairs[offset] !== field) continue;
        const first = pairs[offset + 1]! & 0x7f;
        const second = pairs[offset + 2]! & 0x7f;
        if (!oddParity(pairs[offset + 1]!) || !oddParity(pairs[offset + 2]!)) continue;
        if (first === 0 && second === 0) continue;
        if (first >= 0x10 && first <= 0x1f) {
          const pair = (first << 8) | second;
          // Control codes come twice; the repeat does nothing.
          if (pair === previous) {
            previous = -1;
            continue;
          }
          previous = pair;
          current = first & 0x08 ? 1 : 0;
          if (current === dataChannel) control(first, second);
          continue;
        }
        previous = -1;
        if (first >= 0x20) put(BASIC[first - 0x20]!);
        if (second >= 0x20) put(BASIC[second - 0x20]!);
      }
      const lines = displayed
        .map((cells) => cells.join("").trim())
        .filter((line) => line.length > 0);
      const joined = lines.join("\n");
      if (joined === shown) return null;
      shown = joined;
      return { at, until: null, screen: { kind: "text", lines } };
    },
  };
}

function blank(): Memory {
  return Array.from({ length: ROWS }, () => Array<string>(COLUMNS).fill(" "));
}

function oddParity(byte: number): boolean {
  let count = 0;
  for (let rest = byte; rest; rest &= rest - 1) count++;
  return count % 2 === 1;
}

/** Rows a preamble address code's first byte chooses, by its low three bits. */
const PAC_ROWS: readonly (readonly [number, number?] | undefined)[] = [
  [11], // 0x10
  [1, 2], // 0x11
  [3, 4], // 0x12
  [12, 13], // 0x13
  [14, 15], // 0x14
  [5, 6], // 0x15
  [7, 8], // 0x16
  [9, 10], // 0x17
];

/** The standard characters from 0x20, where they differ from ASCII. */
const BASIC = [...Array(96)].map((_, index) => {
  const code = index + 0x20;
  const different: Readonly<Record<number, string>> = {
    0x27: "’",
    0x2a: "á",
    0x5c: "é",
    0x5e: "í",
    0x5f: "ó",
    0x60: "ú",
    0x7b: "ç",
    0x7c: "÷",
    0x7d: "Ñ",
    0x7e: "ñ",
    0x7f: "█",
  };
  return different[code] ?? String.fromCharCode(code);
});

// prettier-ignore
const SPECIAL = ["®", "°", "½", "¿", "™", "¢", "£", "♪", "à", " ", "è", "â", "ê", "î", "ô", "û"];

// prettier-ignore
const EXTENDED = [
  // Spanish, French and miscellaneous
  "Á", "É", "Ó", "Ú", "Ü", "ü", "‘", "¡", "*", "'", "—", "©", "℠", "•", "“", "”",
  "À", "Â", "Ç", "È", "Ê", "Ë", "ë", "Î", "Ï", "ï", "Ô", "Ù", "ù", "Û", "«", "»",
  // Portuguese, German and Danish
  "Ã", "ã", "Í", "Ì", "ì", "Ò", "ò", "Õ", "õ", "{", "}", "\\", "^", "_", "|", "~",
  "Ä", "ä", "Ö", "ö", "ß", "¥", "¤", "¦", "Å", "å", "Ø", "ø", "┌", "┐", "└", "┘",
];
