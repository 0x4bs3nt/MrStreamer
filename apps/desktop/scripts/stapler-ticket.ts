// Staple or validate one notarized Mac artifact. Retry only Apple's observed CloudKit
// ticket-lookup connection loss; every other stapler failure stops the release.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const DELAYS_MS = [30_000, 60_000, 120_000];
const DEADLINE_MS = 300_000;
const ATTEMPT_MS = 60_000;
const TICKET_LOOKUP =
  "https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup";

type Action = "staple" | "validate";

/** One command has at most four attempts and five minutes, including backoff. */
export async function runStaplerTicket(action: Action, artifact: string): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  for (let attempt = 1; attempt <= DELAYS_MS.length + 1; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error(`${action} ticket lookup deadline exceeded for ${artifact}.`);

    const result = spawnSync("xcrun", ["stapler", action, artifact], {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
      timeout: Math.min(ATTEMPT_MS, remaining),
      killSignal: "SIGKILL",
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status === 0 && !result.error) return;

    const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const lostTicketConnection =
      !result.error &&
      result.status === 68 &&
      /NSURLErrorDomain Code=-1005\b/.test(diagnostic) &&
      diagnostic.includes(TICKET_LOOKUP);
    const detail = result.error?.message ?? `exit ${result.status ?? "unknown"}`;
    if (!lostTicketConnection) {
      throw new Error(`${action} failed for ${artifact} on attempt ${attempt}: ${detail}.`);
    }

    const delay = DELAYS_MS[attempt - 1];
    if (delay === undefined || deadline - Date.now() <= delay) {
      throw new Error(
        `${action} ticket download failed for ${artifact} after ${attempt} attempts: retry budget exhausted.`,
      );
    }
    console.error(
      `${action} ticket lookup lost connection for ${artifact} (attempt ${attempt}); retrying in ${delay / 1000}s.`,
    );
    await setTimeout(delay);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, artifact, extra] = process.argv.slice(2);
  if (
    (action !== "staple" && action !== "validate") ||
    !artifact ||
    (!artifact.endsWith(".app") && !artifact.endsWith(".dmg")) ||
    extra !== undefined
  ) {
    throw new Error(
      "Usage: node scripts/stapler-ticket.ts <staple|validate> <file>.app|<file>.dmg",
    );
  }
  await runStaplerTicket(action, artifact);
}
