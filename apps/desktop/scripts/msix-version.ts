// electron-builder appxManifestCreated hook: gives the Microsoft Store package the four-part version
// the Store reads, which electron-builder can't work out from a release version.
// @mrstreamer/contracts/package-version maps one to the other and explains the numbering.
import { readFile, writeFile } from "node:fs/promises";
import { type } from "arktype";
import { packageVersion } from "@mrstreamer/contracts/package-version";

// package-receipt.ts checks a Store receipt's package version with it.
export { packageVersion };

/** Sets the version in the manifest electron-builder wrote, from the app's package.json. */
export default async function setPackageVersion(manifestPath: string): Promise<void> {
  const app = type({ version: "string" }).assert(
    JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")),
  );
  const version = packageVersion(app.version);
  const manifest = await readFile(manifestPath, "utf8");
  const identity = /(<Identity\b[^>]*?\sVersion=")[^"]*(")/;
  if (!identity.test(manifest)) throw new Error(`${manifestPath} has no Identity version.`);
  await writeFile(manifestPath, manifest.replace(identity, `$1${version}$2`));
  console.log(`  • MSIX version ${version} for ${app.version}`);
}
