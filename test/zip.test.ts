import { describe, expect, it } from "vitest";
import { readZipEntry, storedZip } from "../scripts/zip.ts";

// An MSIX is a ZIP that makeappx writes in the ZIP64 form whatever its size, and a real one can't
// be built here. This archive is CPython's zipfile made to write that form for everything
// (ZIP64_LIMIT = 0 and ZIP_FILECOUNT_LIMIT = 0): 64-bit sizes and offsets in each entry's extra
// field, and the ZIP64 end record with its locator. It holds a deflated [Content_Types].xml and
// AppxManifest.xml, and app/stored.txt stored as it is.
const ZIP64 = Buffer.from(
  "UEsDBC0AAAAIAMVKRV3HHBc8//////////8TABQAW0NvbnRlbnRfVHlwZXNdLnhtbAEAEAAIAAAAAAAAAAoAAAAAAAAAswmp" +
    "LEgt1rcDAFBLAwQtAAAACADFSkVd8NF+Av//////////EAAUAEFwcHhNYW5pZmVzdC54bWwBABAAdwAAAAAAAABqAAAAAAAA" +
    "ADWNSwqAIBQAryLvAFoQrVSIaNEmWrU3e5T0UZ4Gdfta1HqGGdkbu5oZtWwnPJJLN+vMjgqay+xhQ16FAKw/x83FBUlB3akP" +
    "ARuQovOHgpxnvODZK5K3GKOniuziEtp00hu7ygKY0FL8twdQSwMELQAAAAAAAAAhAGV40Vr//////////w4AFABhcHAvc3Rv" +
    "cmVkLnR4dAEAEAAPAAAAAAAAAA8AAAAAAAAAc3RvcmVkIGFzIGl0IGlzUEsBAi0DLQAAAAgAxUpFXcccFzz//////////xMA" +
    "FAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWwBABAACAAAAAAAAAAKAAAAAAAAAFBLAQItAy0AAAAIAMVKRV3w" +
    "0X4C//////////8QABwAAAAAAAAAAACAAf////9BcHB4TWFuaWZlc3QueG1sAQAYAHcAAAAAAAAAagAAAAAAAABPAAAAAAAA" +
    "AFBLAQItAy0AAAAAAAAAIQBleNFa//////////8OABwAAAAAAAAAAACAAf////9hcHAvc3RvcmVkLnR4dAEAGAAPAAAAAAAA" +
    "AA8AAAAAAAAA+wAAAAAAAABQSwYGLAAAAAAAAAAtAC0AAAAAAAAAAAADAAAAAAAAAAMAAAAAAAAABwEAAAAAAABKAQAAAAAA" +
    "AFBLBgcAAAAAUQIAAAAAAAABAAAAUEsFBgAAAAADAAMABwEAAEoBAAAAAA==",
  "base64",
);

describe("reading a file out of a ZIP", () => {
  it("reads deflated and stored files from an archive in the ZIP64 form", () => {
    expect(readZipEntry(ZIP64, "AppxManifest.xml")?.toString()).toBe(
      '<Package><Identity Name="Example.App" Publisher="CN=Example" Version="1.0.4.0" ProcessorArchitecture="x64" /></Package>',
    );
    expect(readZipEntry(ZIP64, "[Content_Types].xml")?.toString()).toBe("<Types/>");
    expect(readZipEntry(ZIP64, "app/stored.txt")?.toString()).toBe("stored as it is");
  });

  it("answers null for a file the archive doesn't hold", () => {
    expect(readZipEntry(ZIP64, "appxmanifest.xml")).toBeNull();
  });

  it.each([
    ["ZIP", storedZip("AppxManifest.xml", Buffer.from("<Package/>")), "<Package/>"],
    [
      "ZIP64",
      ZIP64,
      '<Package><Identity Name="Example.App" Publisher="CN=Example" Version="1.0.4.0" ProcessorArchitecture="x64" /></Package>',
    ],
  ] as const)(
    "reads %s entries when the archive comment contains an end-record signature",
    (_, zip, expected) => {
      for (const length of [4, 40, 0xffff]) {
        const comment = Buffer.alloc(length, 0x61);
        comment.set([0x50, 0x4b, 0x05, 0x06]);
        const archive = Buffer.concat([zip, comment]);
        archive.writeUInt16LE(comment.length, zip.length - 2);

        expect(readZipEntry(archive, "AppxManifest.xml")?.toString()).toBe(expected);
        expect(readZipEntry(archive, "missing.xml")).toBeNull();
      }
    },
  );

  it("refuses what isn't a ZIP, and a file that no longer matches its checksum", () => {
    expect(() => readZipEntry(Buffer.from("MSIX"), "AppxManifest.xml")).toThrow("Not a ZIP file");

    const damaged = Buffer.from(ZIP64);
    const stored = damaged.indexOf("stored as it is");
    damaged.write("S", stored);
    expect(() => readZipEntry(damaged, "app/stored.txt")).toThrow("checksum");
  });
});

describe("the ZIP a package is uploaded in", () => {
  it("holds the package under its name, byte for byte, and is the same every time", () => {
    const data = Buffer.from("not really a package");
    const zip = storedZip("Mr-Streamer-0.0.5-win-x64.msix", data);

    expect(readZipEntry(zip, "Mr-Streamer-0.0.5-win-x64.msix")?.equals(data)).toBe(true);
    expect(zip.equals(storedZip("Mr-Streamer-0.0.5-win-x64.msix", data))).toBe(true);
  });
});
