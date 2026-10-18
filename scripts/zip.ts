// The two things the Store scripts need from ZIP files: reading one file out of an MSIX, which is a
// ZIP that makeappx writes in the ZIP64 form whatever its size, and wrapping a package in the ZIP
// the submission API takes uploads in. The job that holds the Store credential installs no
// packages, so this uses node: modules only.
import { crc32, inflateRawSync } from "node:zlib";

const LOCAL_FILE = 0x04034b50;
const CENTRAL_FILE = 0x02014b50;
const END = 0x06054b50;
const ZIP64_END = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
/** What a 32-bit field holds when the real value is in the entry's ZIP64 extra field. */
const IN_ZIP64 = 0xffffffff;
/** Names are UTF-8. */
const UTF8_NAMES = 0x0800;

/**
 * The contents of the file `name` in the ZIP `archive`, or null when it holds no such file.
 * Throws for anything that isn't a ZIP, and when the file's checksum doesn't match.
 */
export function readZipEntry(archive: Buffer, name: string): Buffer | null {
  try {
    const { offset, entries } = centralDirectory(archive);
    let at = offset;
    for (let entry = 0; entry < entries; entry++) {
      if (archive.readUInt32LE(at) !== CENTRAL_FILE) throw new Error("Not a file entry.");
      const nameLength = archive.readUInt16LE(at + 28);
      const extraLength = archive.readUInt16LE(at + 30);
      const next = at + 46 + nameLength + extraLength + archive.readUInt16LE(at + 32);
      if (archive.toString("utf8", at + 46, at + 46 + nameLength) === name) {
        return contents(archive, at, at + 46 + nameLength, extraLength);
      }
      at = next;
    }
    return null;
  } catch (error) {
    throw new Error(
      `Not a ZIP file this script can read. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Where the list of files starts and how many it names, from the ZIP64 record when there is one. */
function centralDirectory(archive: Buffer): { offset: number; entries: number } {
  // A comment can contain the signature too. The real record's comment reaches the archive's
  // end and is at most 65535 bytes, following the record's 22 fixed bytes.
  let end = archive.length - 22;
  const first = Math.max(0, end - 0xffff);
  for (; end >= first; end--) {
    if (
      archive.readUInt32LE(end) === END &&
      end + 22 + archive.readUInt16LE(end + 20) === archive.length
    )
      break;
  }
  if (end < first) throw new Error("It has no end record.");
  if (end >= 20 && archive.readUInt32LE(end - 20) === ZIP64_LOCATOR) {
    const record = Number(archive.readBigUInt64LE(end - 12));
    if (archive.readUInt32LE(record) !== ZIP64_END) throw new Error("Its ZIP64 record is missing.");
    return {
      entries: Number(archive.readBigUInt64LE(record + 32)),
      offset: Number(archive.readBigUInt64LE(record + 48)),
    };
  }
  return { entries: archive.readUInt16LE(end + 10), offset: archive.readUInt32LE(end + 16) };
}

/** The file a central directory entry at `entry` describes, whose extra fields start at `extra`. */
function contents(archive: Buffer, entry: number, extra: number, extraLength: number): Buffer {
  const method = archive.readUInt16LE(entry + 10);
  const checksum = archive.readUInt32LE(entry + 16);
  let compressed = archive.readUInt32LE(entry + 20);
  let size = archive.readUInt32LE(entry + 24);
  let local = archive.readUInt32LE(entry + 42);
  // The ZIP64 extra field holds, in this order, only the values that didn't fit their 32 bits.
  for (let at = extra; at + 4 <= extra + extraLength; at += 4 + archive.readUInt16LE(at + 2)) {
    if (archive.readUInt16LE(at) !== 0x0001) continue;
    let value = at + 4;
    const next = () => {
      value += 8;
      return Number(archive.readBigUInt64LE(value - 8));
    };
    if (size === IN_ZIP64) size = next();
    if (compressed === IN_ZIP64) compressed = next();
    if (local === IN_ZIP64) local = next();
  }
  if (archive.readUInt32LE(local) !== LOCAL_FILE) throw new Error("A file's header is missing.");
  const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
  if (start + compressed > archive.length) throw new Error("A file runs past the end.");
  const stored = archive.subarray(start, start + compressed);
  if (method !== 0 && method !== 8) throw new Error(`Compression method ${method} is unknown.`);
  const data = method === 0 ? stored : inflateRawSync(stored);
  if (data.length !== size || crc32(data) !== checksum) {
    throw new Error("A file's checksum doesn't match its contents.");
  }
  return data;
}

/**
 * A ZIP holding `data` as its one file, `name`, stored as it is: a package is compressed already.
 * The same input always gives the same bytes, so an upload can be sent again piece by piece.
 */
export function storedZip(name: string, data: Buffer): Buffer {
  const file = Buffer.from(name, "utf8");
  // Past these the ZIP64 form is needed, which no package comes near.
  if (data.length >= IN_ZIP64 - 1024 || file.length > 0xffff) {
    throw new Error(`${name} is too large for this script's ZIP files.`);
  }
  const checksum = crc32(data);
  // What both headers say about the file, from the version needed to its name's length. The date
  // is 1 January 1980, the earliest a ZIP can hold.
  const described = Buffer.alloc(26);
  described.writeUInt16LE(20, 0);
  described.writeUInt16LE(UTF8_NAMES, 2);
  described.writeUInt16LE(0x0021, 8);
  described.writeUInt32LE(checksum, 10);
  described.writeUInt32LE(data.length, 14);
  described.writeUInt32LE(data.length, 18);
  described.writeUInt16LE(file.length, 22);

  const local = Buffer.alloc(4);
  local.writeUInt32LE(LOCAL_FILE);
  const central = Buffer.alloc(6);
  central.writeUInt32LE(CENTRAL_FILE);
  central.writeUInt16LE(20, 4);
  // Comment length, disk, attributes and the local header's offset: all 0.
  const located = Buffer.alloc(14);
  const directory = Buffer.concat([central, described, located, file]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(local.length + described.length + file.length + data.length, 16);
  return Buffer.concat([local, described, file, data, directory, end]);
}
