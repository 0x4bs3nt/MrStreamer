// publish.yml calls this only after GitHub publication. Discord is optional: delivery problems
// warn without failing the publisher. No response body, credential or network error is logged.
import { parseArgs } from "node:util";

/** Posts once, waiting for Discord's confirmation. An ambiguous timeout is never retried. */
export async function announceRelease(
  env: NodeJS.ProcessEnv,
  { test = false, timeoutMs = 10_000 } = {},
) {
  const warn = (message: string) => console.log(`::warning::Discord: ${message}`);
  const { CHANNEL: channel, VERSION: version, TAG: tag, GITHUB_REPOSITORY: repository } = env;
  if ((channel !== "stable" && channel !== "nightly") || !version || !tag || !repository) {
    warn("Missing or invalid release metadata; no announcement sent.");
    return;
  }
  const secret = `DISCORD_${channel.toUpperCase()}_WEBHOOK_URL`;
  const webhook = env[secret];
  if (!webhook) {
    warn(`${secret} is not configured; no announcement sent.`);
    return;
  }
  try {
    const url = new URL(webhook);
    url.searchParams.set("wait", "true");
    const label = channel === "stable" ? "Stable" : "Nightly preview";
    const release = `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `${test ? "[Setup test] " : ""}Mr. Streamer ${label} ${version}\nNotes and downloads: ${release}`,
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    await response.body?.cancel();
    if (!response.ok) {
      warn(
        `Delivery returned HTTP ${response.status}. Check the channel before manually retrying.`,
      );
      return;
    }
    console.log(`Discord ${channel} announcement confirmed${test ? " (setup test)" : ""}.`);
  } catch {
    warn("Delivery was not confirmed. Check the channel before manually retrying.");
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { test: { type: "boolean", default: false } } });
  await announceRelease(process.env, { test: values.test });
}
