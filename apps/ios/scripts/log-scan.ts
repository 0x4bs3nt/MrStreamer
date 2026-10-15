// Looks for a login in the logs of a simulator run: Metro's output, the simulator's unified log or
// anything else captured. Run the fixture panel with canary credentials (FIXTURE_USERNAME and
// FIXTURE_PASSWORD, distinctive and with characters an address encodes), sign in with them, make
// streams and tracks fail, then scan what was logged. Live stream addresses carry the login in
// their path and API calls in their query, so each canary is looked for as typed, as a path
// encodes it and as a query encodes it, ignoring case.
//
//   node scripts/log-scan.ts <username> <password> <log>...
//
// Prints each match with its file and line, the login itself masked, and exits 1 when any log
// holds either canary.
import { readFileSync } from "node:fs";

const [username, password, ...files] = process.argv.slice(2);
if (!username || !password || files.length === 0) {
  console.error("usage: node scripts/log-scan.ts <username> <password> <log>...");
  process.exit(2);
}

/** The ways a log can spell `value`, lower-cased. */
const spellings = (value: string) =>
  [
    ...new Set([
      value,
      encodeURIComponent(value),
      encodeURI(value),
      new URLSearchParams({ value }).toString().slice("value=".length),
    ]),
  ].map((each) => each.toLowerCase());

const canaries = [
  ...spellings(username).map((form) => ({ name: "username", form })),
  ...spellings(password).map((form) => ({ name: "password", form })),
];
const masks = canaries.map(({ name, form }) => ({
  name,
  pattern: new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
}));
const masked = (line: string) =>
  masks.reduce((text, { name, pattern }) => text.replace(pattern, `<${name}>`), line);

let found = 0;
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  let matches = 0;
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    const hits = canaries.filter(({ form }) => lower.includes(form));
    if (hits.length === 0) return;
    matches += hits.length;
    const names = [...new Set(hits.map(({ name }) => name))].join(", ");
    console.log(`${file}:${index + 1}: ${names}: ${masked(line).slice(0, 240)}`);
  });
  console.log(`${file}: ${lines.length} lines, ${matches} canary matches`);
  found += matches;
}
process.exit(found > 0 ? 1 : 0);
