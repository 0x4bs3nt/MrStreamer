// Execute archived public owners/loaders rather than maintaining a second schema fixture.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { Analytics } from "../../src/main/analytics/service.ts";
import { analyticsStore } from "../../src/main/analytics/storage.ts";
import type { CaptureEvent } from "../../src/main/analytics/model.ts";
import { evidenceDirectory } from "../../../../.cursor/skills/verify-mrstreamer/scripts/session.ts";

const root = join(import.meta.dirname, "../../../..");
const evidence = await evidenceDirectory(join(root, ".local/verification"), "analytics-downgrade-");
const source = join(evidence, "archive");
const tag = process.argv[2] ?? "v0.0.15";
if (!["v0.0.15", "v0.0.18"].includes(tag)) throw new Error("Unsupported compatibility archive.");
const supportsSummaries = tag === "v0.0.18";
const revision = execFileSync("git", ["rev-parse", `${tag}^{commit}`], {
  cwd: root,
  encoding: "utf8",
}).trim();
const files = ["model.ts", "properties.ts", "storage.ts", "service.ts", "operations.ts"]
  .map((file) => `apps/desktop/src/main/analytics/${file}`)
  .concat("apps/desktop/src/main/platform/json-file.ts");
const hashes: Record<string, string> = {};
for (const file of files) {
  const bytes = execFileSync("git", ["show", `${revision}:${file}`], { cwd: root });
  const destination = join(source, file);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  hashes[file] = createHash("sha256").update(bytes).digest("hex");
}
await symlink(join(root, "apps/desktop/node_modules"), join(source, "node_modules"), "dir");
// These assertions describe only public factory/class types. The executed implementations are
// byte-identical archived files, including their schema, migrations and ordinary write behavior.
const oldStoreModule = (await import(
  pathToFileURL(join(source, "apps/desktop/src/main/analytics/storage.ts")).href
)) as { analyticsStore: typeof analyticsStore };
const oldOwnerModule = (await import(
  pathToFileURL(join(source, "apps/desktop/src/main/analytics/service.ts")).href
)) as { Analytics: typeof Analytics };
const properties = {
  app_version: "0.0.19",
  build_channel: "stable",
  update_channel: "stable",
  os: "linux",
  arch: "x64",
  distribution: "direct",
} as const;
const owners: Analytics[] = [];
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await pause(5);
  }
  throw new Error("Downgrade side effect did not settle.");
}
const results: Record<string, unknown> = {};
try {
  const directory = join(evidence, "profile");
  await mkdir(directory);
  const store = analyticsStore(directory);
  const current = new Analytics({
    dataDir: directory,
    origin: Promise.resolve("fresh"),
    properties,
    store,
    transport: { kind: "local", send: async () => "not_sent" },
  });
  owners.push(current);
  await current.settings();
  current.setForeground(true);
  await until(async () => !!(await store.load())?.installationId);
  current.noteAction("search_used");
  const run = current.beginPlayback("live")!;
  const binding = current.bindPlayback(run, "local")!;
  current.notePlaybackState(run, binding, 1, "playing");
  current.notePlaybackFailure(run, binding, "unsupported", {
    diagnostic_stage: "decode",
    diagnostic_reason: "decode_rejected",
  });
  await until(
    async () =>
      !!(await store.load())?.summaries?.unfinished &&
      (await store.load())?.pending.some((item) => item.event.event === "stream_error") === true,
  );
  // Snapshot emulates abrupt death without calling a private owner API. Stop the real owner only
  // after retaining bytes, then restore the exact crash snapshot for the archived loader.
  const crash = await readFile(join(directory, "analytics.json"), "utf8");
  await current.close();
  await writeFile(join(directory, "analytics.json"), crash);
  const saved = await store.load();
  const old = oldStoreModule.analyticsStore(directory);
  const loaded = await old.load();
  assert.equal(loaded?.enabled, true);
  assert.equal(loaded?.installationId, saved?.installationId);
  assert.equal(loaded?.pending.length, saved?.pending.length);
  assert.equal(!!loaded?.summaries, supportsSummaries);
  assert(!loaded?.lifecycle);
  const oldError = loaded?.pending
    .map((item) => item.event)
    .find((event) => event.event === "stream_error");
  assert.equal(oldError?.properties.diagnostic_stage, supportsSummaries ? "decode" : undefined);
  assert.equal(await readFile(join(directory, "analytics.json"), "utf8"), crash);
  results.noWriteReturn = {
    enabled: (await store.load())?.enabled,
    identityPreserved: (await store.load())?.installationId === saved?.installationId,
    summariesRetained: !!(await store.load())?.summaries,
    lifecycleRetained: !!(await store.load())?.lifecycle,
  };

  const delivered: CaptureEvent[] = [];
  const legacy = new oldOwnerModule.Analytics({
    dataDir: directory,
    origin: Promise.resolve("unknown"),
    properties: { ...properties, app_version: tag.slice(1) },
    store: old,
    transport: {
      kind: "local",
      send: async (event) => {
        delivered.push(event);
        return "accepted";
      },
    },
  });
  owners.push(legacy);
  assert.deepEqual(await legacy.settings(), { enabled: true, transport: "local" });
  legacy.setForeground(true);
  await until(async () => (await old.load())?.pending.length === 0);
  legacy.noteRendererExit("crashed");
  await until(() => delivered.some((event) => event.event === "renderer_exited"));
  assert.equal(!!(await store.load())?.summaries, supportsSummaries);
  assert(!(await store.load())?.lifecycle);
  assert.equal((await store.load())?.installationId, saved?.installationId);
  results.oldObservationAndActionWrite = {
    enabled: (await store.load())?.enabled,
    identityPreserved: true,
    summariesRemoved: !supportsSummaries,
    lifecycleRemoved: true,
    delivered,
  };
  await legacy.configure(false);
  assert.equal((await store.load())?.enabled, false);
  assert.deepEqual((await store.load())?.pending, []);
  assert(!(await store.load())?.summaries);
  assert(!(await store.load())?.lifecycle);
  await legacy.close();
  const offEvents: CaptureEvent[] = [];
  const upgradedOff = new Analytics({
    dataDir: directory,
    origin: Promise.resolve("unknown"),
    properties,
    store,
    transport: {
      kind: "local",
      send: async (event) => {
        offEvents.push(event);
        return "accepted";
      },
    },
  });
  owners.push(upgradedOff);
  upgradedOff.setForeground(true);
  assert.deepEqual(await upgradedOff.settings(), { enabled: false, transport: "local" });
  await upgradedOff.close();
  assert.deepEqual(offEvents, []);
  const oldEnabled = new oldOwnerModule.Analytics({
    dataDir: directory,
    origin: Promise.resolve("unknown"),
    properties: { ...properties, app_version: tag.slice(1) },
    store: old,
    transport: { kind: "local", send: async () => "accepted" },
  });
  owners.push(oldEnabled);
  await oldEnabled.configure(true);
  await oldEnabled.close();
  const upgraded = await store.load();
  assert.equal(upgraded?.enabled, true);
  assert.equal(upgraded?.summaries?.pending.length ?? 0, 0);
  assert(!upgraded?.summaries?.usage);
  assert(!upgraded?.summaries?.unfinished);
  assert(!upgraded?.lifecycle);
  const returnedEvents: CaptureEvent[] = [];
  const returned = new Analytics({
    dataDir: directory,
    origin: Promise.resolve("unknown"),
    properties,
    store,
    transport: {
      kind: "local",
      send: async (event) => {
        returnedEvents.push(event);
        return "accepted";
      },
    },
  });
  owners.push(returned);
  await returned.settings();
  returned.setForeground(true);
  await until(
    async () =>
      returnedEvents.some((event) => event.event === "app_version_observed") &&
      (await store.load())?.lifecycle?.pending.length === 0,
  );
  await returned.close();
  assert.equal((await store.load())?.installationId, saved?.installationId);
  const baseline = returnedEvents.find((event) => event.event === "app_version_observed")!;
  assert.equal(baseline.properties.observation_kind, "unknown_history");
  assert(!("previous_app_version" in baseline.properties));
  assert(
    !returnedEvents.some(
      (event) => event.event === "installation_observed" || event.event === "app_active_day",
    ),
  );
  results.oldOptOutReenableReupgrade = {
    identityPreserved: true,
    cleared: true,
    noSummaryRevival: true,
    noVersionRevival: true,
    optOutSurvivedActualOldLoader: true,
    baseline,
  };
  // The full actual archive is retained with hashes, not copied into tracked fixtures.
  await writeFile(
    join(evidence, "proof.json"),
    JSON.stringify(
      {
        status: "passed",
        revision,
        tag,
        hashes,
        results,
        limitations: [
          "Archived public owner/storage contracts on Linux, not an installed old binary",
          "No private providers, production requests or native checkpoint latency",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all(owners.map((owner) => owner.close()));
}
console.log(evidence);
