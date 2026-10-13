// Notarizes and staples the signed DMG electron-builder made, so a downloaded copy passes
// Gatekeeper even offline. electron-builder notarizes the app inside but not the disk image.
//
//   node scripts/notarize-dmg.ts dist/Mr-Streamer-0.2.0-mac-arm64.dmg
//
// Needs APPLE_API_KEY (path of the .p8 key), APPLE_API_KEY_ID and APPLE_API_ISSUER, the same
// variables electron-builder notarizes the app with. Stapling changes the file, so the script
// then updates the DMG's checksum and size in latest-mac.yml and drops its stale block map.
// The lines it prints at each step mark the phases scripts/mac-release-phases.ts times; the wait
// for Apple is the one between "Submitting" and "Notarization ... Accepted", and a rejection ends
// the run there.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runStaplerTicket } from "./stapler-ticket.ts";

const dmg = process.argv[2];
if (!dmg?.endsWith(".dmg")) throw new Error("Usage: node scripts/notarize-dmg.ts <file>.dmg");
const key = process.env["APPLE_API_KEY"];
const keyId = process.env["APPLE_API_KEY_ID"];
const issuer = process.env["APPLE_API_ISSUER"];
if (!key || !keyId || !issuer) {
  throw new Error("Set APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER.");
}
const credentials = ["--key", key, "--key-id", keyId, "--issuer", issuer];

console.log(`Submitting ${basename(dmg)} for notarization`);
const submission = JSON.parse(
  execFileSync(
    "xcrun",
    ["notarytool", "submit", dmg, ...credentials, "--wait", "--output-format", "json"],
    { encoding: "utf8" },
  ),
) as { id: string; status: string };
if (submission.status !== "Accepted") {
  const log = execFileSync("xcrun", ["notarytool", "log", submission.id, ...credentials], {
    encoding: "utf8",
  });
  throw new Error(`Notarization ended as ${submission.status}:\n${log}`);
}
console.log(`Notarization ${submission.id} ${submission.status}`);
console.log(`Stapling ${basename(dmg)}`);
await runStaplerTicket("staple", dmg);
await runStaplerTicket("validate", dmg);

rmSync(`${dmg}.blockmap`, { force: true });
const metadata = join(dirname(dmg), "latest-mac.yml");
if (existsSync(metadata)) {
  const sha512 = createHash("sha512").update(readFileSync(dmg)).digest("base64");
  const size = statSync(dmg).size;
  // The entry is "- url: <name>" followed by its sha512, size and blockMapSize lines.
  const lines = readFileSync(metadata, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === `- url: ${basename(dmg)}`);
  if (start === -1) throw new Error(`${metadata} does not list ${basename(dmg)}.`);
  for (
    let index = start + 1;
    index < lines.length && !lines[index]?.trim().startsWith("-");
    index++
  ) {
    const line = lines[index] ?? "";
    const indent = line.slice(0, line.length - line.trimStart().length);
    if (!indent) break;
    if (line.trim().startsWith("sha512:")) lines[index] = `${indent}sha512: ${sha512}`;
    if (line.trim().startsWith("size:")) lines[index] = `${indent}size: ${size}`;
    if (line.trim().startsWith("blockMapSize:")) lines[index] = "";
  }
  writeFileSync(
    metadata,
    lines.filter((line, index) => line !== "" || index === lines.length - 1).join("\n"),
  );
}
console.log(`Notarized and stapled ${basename(dmg)}.`);
