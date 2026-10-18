// Explicit native acceptance. The ordinary release-UI scenario never calls this workload.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Preferences } from "@mrstreamer/contracts/preferences";
import type {
  AnalyticsRecord,
  CaptureEvent,
  StreamSummary,
  UsageKey,
} from "../../src/main/analytics/model.ts";
import { delay, type Page } from "./app.ts";
import { boundary, type Boundary } from "./analytics-boundary.ts";
import type { analyticsOptions } from "./analytics-options.ts";
import { installedTelemetryPair } from "./analytics-installed-pair.ts";
import { windowsDeleteLock } from "./analytics-windows-lock.ts";

type Target = { executable: string | undefined; version: string; source: string };
type Context = {
  options: ReturnType<typeof analyticsOptions>;
  evidence: string;
  abort: AbortSignal;
  candidate: Target;
  page(): Page;
  main(): Page;
  profile(): string;
  fresh(): Promise<void>;
  launch(target?: Target, local?: boolean): Promise<void>;
  connect(): Promise<void>;
  settings(): Promise<void>;
  verifyAbout(): Promise<void>;
  click(selector: string): Promise<void>;
  namedButton(selector: string, name: string, title?: boolean): Promise<void>;
  escape(): Promise<void>;
  snapshot(name: string): Promise<void>;
  preference(): Promise<Preferences>;
  quit(): Promise<void>;
  prepareExit(reason: string): void;
  kill(): Promise<number>;
  waitFor(check: () => Promise<boolean>, timeoutMs?: number): Promise<void>;
  read(): Promise<AnalyticsRecord>;
  events(): CaptureEvent[];
  bodies: { body: string; at: number; closedAt?: number }[];
  capture(mode: "accept" | "reject" | "hold" | "hold-usage" | "offline"): Promise<void>;
  observations: Record<string, unknown>;
};
const checkbox = '[role="checkbox"][aria-label="Share basic usage statistics"]';

/** A repeated HTTP UUID is one logical event only when every received byte is identical. */
export function reconcileBodies(bodies: readonly string[]) {
  const events = new Map<string, string>();
  for (const body of bodies) {
    const event = JSON.parse(body) as { uuid: string };
    if (events.has(event.uuid))
      assert.equal(body, events.get(event.uuid), "UUID changed its wire body");
    else events.set(event.uuid, body);
  }
  return { deliveries: bodies.length, logicalEvents: events.size };
}

export async function runNativeTelemetry(c: Context) {
  const cases: {
    name: string;
    status: "running" | "passed" | "failed";
    started: number;
    ended?: number;
    proof?: unknown;
  }[] = [];
  c.observations.nativeCases = cases;
  c.observations.nativeLimits = [
    "Loopback only; native package and production acceptance require separately pinned real candidate runs.",
    "Checkpoint/slow-write promise holds are controlled delays, not physical slow-disk measurements. The Windows reader case uses actual OS handles.",
  ];
  const selected = c.options.nativeCase;
  let boundaryIndex = 0;
  const pending = (record: AnalyticsRecord) => record.summaries?.pending ?? [];
  const wires = (uuid: string) =>
    c.bodies.filter(({ body }) => (JSON.parse(body) as { uuid: string }).uuid === uuid);
  const journal = async () => {
    const event = (await c.read()).summaries?.unfinished?.event;
    assert(event, "No actual admitted durable journal");
    return event;
  };
  const saved = async (name: string) => {
    const state = await c.read();
    await writeFile(join(c.evidence, `${name}-record.json`), JSON.stringify(state, null, 2));
    return state;
  };
  const awake = async () => {
    await c.page().send("Emulation.setFocusEmulationEnabled", { enabled: true });
  };
  const fresh = async () => {
    await c.capture("accept");
    await c.fresh();
    await c.launch();
    await awake();
    await c.connect();
    await c.escape();
    await c.verifyAbout();
    await c.waitFor(
      async () => !!(await c.read()).installationId && (await c.read()).pending.length === 0,
    );
  };
  const restart = async () => {
    await c.launch();
    await awake();
    await c.verifyAbout();
  };
  const play = async () => {
    await c.escape();
    await c.namedButton("header button", "Live TV");
    await c.click('button[aria-label="Search"]');
    await c.page().send("Input.insertText", { text: "TEST | H.264 + AAC" });
    await c.waitFor(() =>
      c
        .page()
        .evaluate<boolean>(
          "document.querySelector('[aria-label=\"Search results\"] [aria-selected=true]')?.textContent.includes('H.264 + AAC') ?? false",
        ),
    );
    for (const type of ["rawKeyDown", "keyUp"])
      await c.page().send("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
    await c.waitFor(async () => !!(await c.read()).summaries?.unfinished);
    await c.waitFor(() =>
      c
        .page()
        .evaluate<boolean>(
          "!!document.querySelector('[data-view=watch]') && document.querySelector('video').videoWidth > 0 && !document.querySelector('video').paused",
        ),
    );
    return journal();
  };
  const home = async () => {
    await c.escape();
    await c.namedButton("header button", "Home");
  };
  const stop = async () => {
    await c.click('button[aria-label="Stop"]');
  };
  const recovered = async (event: StreamSummary) => {
    await c.waitFor(async () => wires(event.uuid).length > 0);
    const actual = c.events().find((item) => item.uuid === event.uuid);
    assert.deepEqual(actual, event, "Recovery changed the checkpoint event or fabricated time");
    assert.equal(
      c
        .events()
        .filter(
          (item) =>
            item.event === "stream_summary" &&
            item.properties.started_at === event.properties.started_at,
        ).length,
      wires(event.uuid).length,
      "Second UUID for the same admitted play",
    );
    await c.waitFor(
      async () => !pending(await c.read()).some((item) => item.event.uuid === event.uuid),
    );
    return { checkpoint: event, ...reconcileBodies(wires(event.uuid).map((wire) => wire.body)) };
  };
  const killAt = async (probe: Awaited<ReturnType<typeof boundary>>) => {
    await c.waitFor(async () => !!(await probe.hit()), 1500);
    const hit = await probe.hit();
    assert(hit);
    // Retain the real before/after bytes externally before killing main. Never restore them.
    await writeFile(
      join(c.evidence, `boundary-${++boundaryIndex}-${hit.phase}.json`),
      JSON.stringify(hit, null, 2),
    );
    assert(Date.now() - hit.at < 1500, "Missed the unchanged serializer deadline");
    const killedAt = await c.kill();
    assert(killedAt - hit.at < 1500, "Main kill completed after the serializer deadline");
    return hit;
  };
  const observeQuit = async (name: string) => {
    const marker = join(c.evidence, `${name}.json`);
    await c
      .main()
      .evaluate(
        `(() => { const {app}=process.getBuiltinModule('module').createRequire(process.execPath)('electron'); const fs=process.getBuiltinModule('fs'); app.once('will-quit',()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({at:Date.now()}))); })()`,
      );
    return marker;
  };
  const run = async (name: string, work: () => Promise<unknown>) => {
    if (selected && selected !== name) return;
    c.abort.throwIfAborted();
    const receipt: (typeof cases)[number] = { name, status: "running", started: Date.now() };
    cases.push(receipt);
    console.log(`Native telemetry: ${name}`);
    try {
      receipt.proof = await work();
      receipt.status = "passed";
    } catch (error) {
      receipt.status = "failed";
      throw error;
    } finally {
      receipt.ended = Date.now();
      await writeFile(join(c.evidence, "native-cases.json"), JSON.stringify(cases, null, 2));
    }
  };

  // A Windows published pair installs candidate before any app starts, and owns replacement.
  const pair = c.options.installedPair
    ? await installedTelemetryPair(c.options.installedPair, c.evidence, c.candidate)
    : null;
  if (pair) await pair.select("candidate");
  let primaryError: unknown;
  let failed = false;
  const cleanupErrors: string[] = [];
  try {
    await run("consent", async () => {
      await fresh();
      const before = await saved("consent-on");
      await play();
      await c.capture("offline");
      await stop();
      await c.waitFor(async () =>
        pending(await c.read()).some(
          (item) =>
            item.event.event === "stream_summary" && item.attempts === 0 && item.failures > 0,
        ),
      );
      await play();
      assert((await c.read()).summaries?.unfinished, "No active journal at opt-out");
      await c.escape();
      await c.settings();
      // A refused connection briefly retains its reservation until the refund is saved.
      await c.waitFor(
        async () =>
          pending(await c.read()).some(
            (item) => item.event.event === "stream_summary" && item.attempts === 0,
          ),
        2500,
      );
      await c.capture("hold");
      let held: (typeof c.bodies)[number] | undefined;
      await c.waitFor(async () => {
        held = c.bodies.findLast(
          ({ body, at, closedAt }) =>
            JSON.parse(body).distinct_id === before.installationId &&
            JSON.parse(body).event === "stream_summary" &&
            closedAt === undefined &&
            Date.now() - at <= 250,
        );
        return !!held;
      });
      assert(held && Date.now() - held.at <= 250, "No fresh received request held at opt-out");
      const from = c.bodies.length;
      const optedOutAt = Date.now();
      await c.click(checkbox);
      await c.waitFor(async () => !(await c.preference()).analyticsEnabled);
      await c.waitFor(async () =>
        c.bodies
          .filter(({ body }) => JSON.parse(body).distinct_id === before.installationId)
          .every((wire) => wire.closedAt !== undefined),
      );
      assert.equal(c.bodies.length, from, "Opt-out sent new work");
      assert(
        held.closedAt !== undefined && held.closedAt >= optedOutAt && held.closedAt - held.at < 900,
        "Held request reached its ordinary HTTP timeout instead of being aborted by opt-out",
      );
      const disabled = await saved("consent-off");
      assert.equal(disabled.enabled, false);
      assert.equal(disabled.summaries, undefined);
      assert.equal(disabled.pending.length, 0);
      await c.quit();
      await restart();
      await c.settings();
      await delay(1200);
      assert.equal((await c.preference()).analyticsEnabled, false);
      assert.equal(c.bodies.length, from);
      await c.snapshot("native-consent-off");
      await c.click(checkbox);
      await c.waitFor(async () => !!(await c.preference()).analyticsEnabled);
      await delay(1200);
      const enabled = await saved("consent-reenabled");
      assert.equal(enabled.installationId, before.installationId);
      assert.equal(enabled.firstSeen, before.firstSeen);
      assert.equal(enabled.lastDay, before.lastDay);
      assert.equal(c.bodies.length, from);
      await c.capture("accept");
      await c.quit();
      return {
        identity: before.installationId,
        disabled,
        enabled,
        disabledCaptures: 0,
        optedOutAt,
        heldRequest: held,
      };
    });

    await run("offline", async () => {
      await fresh();
      await play();
      await c.capture("offline");
      await stop();
      await c.waitFor(async () =>
        pending(await c.read()).some(
          (item) =>
            item.event.event === "stream_summary" && item.failures > 0 && item.attempts === 0,
        ),
      );
      const kept = pending(await saved("offline-ended")).find(
        (item) => item.event.event === "stream_summary",
      )!;
      assert.equal(wires(kept.event.uuid).length, 0);
      await c.quit();
      await restart();
      assert(pending(await c.read()).some((item) => item.event.uuid === kept.event.uuid));
      await c.capture("accept");
      await c.waitFor(async () => wires(kept.event.uuid).length === 1);
      assert.deepEqual(
        c.events().find((event) => event.uuid === kept.event.uuid),
        kept.event,
      );
      await c.quit();
      return { retained: kept, delivered: wires(kept.event.uuid) };
    });

    await run("checkpoint", async () => {
      const proofs: unknown[] = [];
      for (const phase of ["before", "after"] as const) {
        await fresh();
        const admitted = await play();
        await delay(8000);
        const probe = await boundary(c.main(), c.profile());
        c.prepareExit(`checkpoint-${phase}`);
        await probe.arm({ kind: "checkpoint", phase, uuid: admitted.uuid });
        await home();
        const hit = await killAt(probe);
        const disk = await saved(`checkpoint-${phase}-killed`);
        const expected = (phase === "before" ? hit.before : hit.after).summaries!.unfinished!.event;
        assert.deepEqual(disk.summaries?.unfinished?.event, expected);
        if (phase === "after") assert(expected.properties.watch_duration_seconds >= 7);
        const deadFrom = Date.now();
        await delay(2000);
        await restart();
        proofs.push({ phase, deadMs: Date.now() - deadFrom, ...(await recovered(expected)) });
        await c.quit();
      }
      return proofs;
    });

    await run("periodic", async () => {
      await fresh();
      const admitted = await play();
      const start = Date.now();
      // One actual counted five-minute run, separate from the normal five-minute UI budget.
      await c.waitFor(
        async () => (await journal()).properties.watch_duration_seconds >= 300,
        330_000,
      );
      const checkpoint = await journal();
      assert.equal(checkpoint.uuid, admitted.uuid);
      assert(Date.now() - start >= 295_000, "Periodic checkpoint used fabricated elapsed time");
      const checkpointAt = Date.now();
      const usage = c
        .events()
        .filter(
          (event) => event.event === "usage_window" && event.distinct_id === checkpoint.distinct_id,
        );
      assert(
        usage.some((event) => {
          if (event.event !== "usage_window") return false;
          const end = Date.parse(event.properties.window_end);
          return (
            end >= start &&
            end <= checkpointAt &&
            end % 300_000 === 0 &&
            wires(event.uuid).some((wire) => wire.at >= start && wire.at <= checkpointAt)
          );
        }),
        "No actual five-minute UTC window ended and transmitted inside the measured run",
      );
      await saved("periodic-checkpoint");
      await c.snapshot("periodic-watch");
      c.prepareExit("periodic-checkpoint");
      await c.kill();
      await restart();
      const proof = await recovered(checkpoint);
      await c.quit();
      return { start, checkpointAt, wallMs: checkpointAt - start, usage, ...proof };
    });

    await run("seal-send-ack", async () => {
      const proofs: unknown[] = [];
      for (const spec of [
        { kind: "seal", phase: "before" },
        { kind: "seal", phase: "after" },
        { kind: "reserve", phase: "before" },
        { kind: "reserve", phase: "after" },
        { kind: "retire", phase: "before" },
        { kind: "retire", phase: "after" },
      ] satisfies Boundary[]) {
        await fresh();
        const admitted = await play();
        await delay(1100);
        const probe = await boundary(c.main(), c.profile());
        c.prepareExit(`${spec.kind}-${spec.phase}`);
        await probe.arm({ ...spec, uuid: admitted.uuid });
        await stop();
        const hit = await killAt(probe);
        const state = await saved(`${spec.kind}-${spec.phase}-killed`);
        const expectedState = spec.phase === "before" ? hit.before : hit.after;
        assert.deepEqual(
          state,
          expectedState,
          "Actual committed atomic state differs from boundary",
        );
        const queued = pending(expectedState).find((item) => item.event.uuid === admitted.uuid);
        const expected = expectedState.summaries?.unfinished?.event ?? queued?.event;
        const before = wires(admitted.uuid).length;
        if (spec.kind === "reserve") {
          assert.equal(before, 0);
          assert.equal(queued?.attempts, spec.phase === "after" ? 1 : 0);
        }
        if (spec.kind === "retire") assert.equal(before, 1, "Ack case never received a real body");
        await restart();
        if (spec.kind === "retire" && spec.phase === "after") {
          await delay(2200);
          assert.equal(wires(admitted.uuid).length, before);
        } else {
          assert(expected);
          await c.waitFor(async () => wires(admitted.uuid).length > before);
          assert.deepEqual(
            c.events().findLast((event) => event.uuid === admitted.uuid),
            expected,
          );
        }
        const delivery = reconcileBodies(wires(admitted.uuid).map((wire) => wire.body));
        assert(
          c
            .events()
            .filter(
              (event) =>
                event.event === "stream_summary" &&
                event.properties.started_at === admitted.properties.started_at,
            )
            .every((event) => event.uuid === admitted.uuid),
        );
        proofs.push({ spec, hit, delivery });
        await c.quit();
      }
      return proofs;
    });

    await run("ambiguous", async () => {
      await fresh();
      const admitted = await play();
      c.prepareExit("body-held-first");
      await c.capture("hold");
      await stop();
      await c.waitFor(async () => wires(admitted.uuid).length === 1);
      const held = await saved("body-held");
      assert.equal(pending(held).find((item) => item.event.uuid === admitted.uuid)?.attempts, 1);
      assert.equal(wires(admitted.uuid)[0]!.closedAt, undefined);
      const killedAt = await c.kill();
      assert(
        killedAt - wires(admitted.uuid)[0]!.at < 1000,
        "Main was not killed while its first body was held",
      );
      await restart();
      await c.waitFor(async () => wires(admitted.uuid).length === 3);
      await c.waitFor(
        async () => !pending(await c.read()).some((item) => item.event.uuid === admitted.uuid),
      );
      const replay = reconcileBodies(wires(admitted.uuid).map((wire) => wire.body));
      assert.deepEqual(replay, { deliveries: 3, logicalEvents: 1 });
      await c.quit();
      await restart();
      await delay(2200);
      assert.equal(wires(admitted.uuid).length, 3);
      await c.quit();

      // Prepare real UI across the first delivery/backoff. Prove the ready incident
      // beats the actual persisted retry deadline after the second body, without a UI timer.
      await fresh();
      const priority = await play();
      await c.capture("hold");
      await stop();
      await c.escape();
      await c.namedButton("header button", "Movies");
      await c.namedButton("nav button", "All movies");
      await c.namedButton("button[title]", "Missing file", true);
      const preparedAt = Date.now();
      await c.waitFor(async () => wires(priority.uuid).length >= 2);
      const requestedAt = Date.now();
      await c.namedButton('[role="dialog"] button', "Play");
      await c.waitFor(async () =>
        c
          .events()
          .some(
            (event) => event.event === "stream_error" && event.distinct_id === priority.distinct_id,
          ),
      );
      const backoff = pending(await saved("priority-backoff")).find(
        (item) => item.event.uuid === priority.uuid,
      );
      assert(
        backoff && backoff.attempts === 2 && backoff.failures === 2,
        "Incident missed the second summary backoff",
      );
      const eligibleAt = Date.parse(backoff.nextAttemptAt);
      const incident = c
        .events()
        .find(
          (event) => event.event === "stream_error" && event.distinct_id === priority.distinct_id,
        );
      assert(incident);
      assert(
        wires(incident.uuid)[0]!.at < eligibleAt,
        "Ready direct incident waited until the summary became eligible",
      );
      await c.waitFor(async () => wires(priority.uuid).length === 3);
      assert(
        wires(priority.uuid)[2]!.at >= eligibleAt,
        "Summary retried before its persisted backoff",
      );
      await c.waitFor(
        async () => !pending(await c.read()).some((item) => item.event.uuid === priority.uuid),
      );
      const proof = reconcileBodies(wires(priority.uuid).map((wire) => wire.body));
      assert.equal(proof.deliveries, 3);
      assert.equal(proof.logicalEvents, 1);
      await c.quit();
      await restart();
      assert(!pending(await c.read()).some((item) => item.event.uuid === priority.uuid));
      await delay(2200);
      assert.equal(wires(priority.uuid).length, 3);
      await c.quit();
      return {
        held,
        killedAt,
        replay,
        priority: { preparedAt, requestedAt, eligibleAt, backoff, ...proof },
      };
    });

    await run("quit", async () => {
      await fresh();
      const admitted = await play();
      // Accept the window-close summary; hold only the usage fragment sealed by will-quit.
      // This distinguishes analytics.close's allowance from an earlier playback request.
      c.prepareExit("quit-held-usage");
      await c.capture("hold-usage");
      const marker = await observeQuit("native-will-quit");
      await c.quit();
      const at = (JSON.parse(await readFile(marker, "utf8")) as { at: number }).at;
      const held = c.bodies.find((wire) => {
        const event = JSON.parse(wire.body) as CaptureEvent;
        return (
          event.distinct_id === admitted.distinct_id &&
          event.event === "usage_window" &&
          wire.at >= at
        );
      });
      assert(
        held?.closedAt,
        "Quit did not send and close its actual held usage request after will-quit",
      );
      // 500 ms product allowance plus at most 250 ms for OS/socket observation. A natural
      // 1000 ms transport timeout cannot pass. Whole-app teardown has its own strict check.
      assert(
        held.closedAt - at <= 750,
        "Analytics quit exceeded 500 ms + 250 ms observation tolerance",
      );
      const uuid = (JSON.parse(held.body) as CaptureEvent).uuid;
      const retained = pending(await saved("quit-held")).find((item) => item.event.uuid === uuid);
      assert(retained, "Quit lost its actual final outbox");
      await c.capture("accept");
      await restart();
      await c.waitFor(async () => wires(uuid).length === 2);
      assert.equal(reconcileBodies(wires(uuid).map((wire) => wire.body)).logicalEvents, 1);
      await c.quit();
      await fresh();
      const future = await play();
      const backoffMarker = await observeQuit("native-backoff-will-quit");
      c.prepareExit("quit-future-backoff");
      await c.capture("reject");
      await stop();
      await c.waitFor(async () =>
        pending(await c.read()).some(
          (item) => item.event.uuid === future.uuid && Date.parse(item.nextAttemptAt) > Date.now(),
        ),
      );
      const futureItem = pending(await c.read()).find((item) => item.event.uuid === future.uuid);
      assert(futureItem);
      const eligibleAt = Date.parse(futureItem.nextAttemptAt);
      const from = wires(future.uuid).length;
      const closing = Date.now();
      await c.quit();
      const willQuitAt = (JSON.parse(await readFile(backoffMarker, "utf8")) as { at: number }).at;
      assert(willQuitAt < eligibleAt, "Quit did not enter the actual future-backoff window");
      assert.equal(wires(future.uuid).length, from, "Quit bypassed a persisted future backoff");
      return {
        markerAt: at,
        requestAbortedAfterMs: held.closedAt - at,
        final: retained,
        backoffQuitAt: closing,
        backoffWillQuitAt: willQuitAt,
        backoffEligibleAt: eligibleAt,
      };
    });

    await run("slow-write", async () => {
      await fresh();
      await play();
      await delay(1200);
      const before = await c.read();
      const probe = await boundary(c.main(), c.profile());
      await probe.arm({ kind: "checkpoint", phase: "before" });
      await home();
      await c.waitFor(async () => !!(await probe.hit()), 1500);
      const hit = await probe.hit();
      assert(hit);
      await delay(Math.max(0, 1650 - (Date.now() - hit.at)));
      await c.settings();
      await c.click(checkbox);
      await c.waitFor(() =>
        c.page().evaluate<boolean>("!!document.querySelector('.text-destructive')"),
      );
      await c.snapshot("slow-write-fail-closed");
      assert.equal((await c.read()).installationId, before.installationId);
      assert.equal((await c.read()).enabled, before.enabled);
      const from = c.bodies.length;
      await probe.release();
      await delay(1200);
      assert.equal(c.bodies.length, from, "Late write resumed capture");
      const measurements = await probe.measurements();
      assert(measurements.length > 0);
      await probe.restore();
      await c.quit();
      await restart();
      assert.equal((await c.read()).installationId, before.installationId);
      assert.equal((await c.read()).enabled, before.enabled);
      await c.quit();
      return { injectedPromiseHold: true, deadlineMs: 1500, hit, measurements };
    });

    if (process.platform === "win32")
      await run("windows-retry", async () => {
        await fresh();
        const identity = (await c.read()).installationId;
        const counter = async (key: UsageKey) => {
          const record = await c.read();
          const events = new Map(
            [
              ...c.events(),
              ...pending(record).map((item) => item.event),
              record.summaries?.usage,
            ].flatMap((event) =>
              event?.event === "usage_window" && event.distinct_id === identity
                ? [[event.uuid, event] as const]
                : [],
            ),
          );
          // A pending/received copy during acknowledgement is one fragment, not two actions.
          return [...events.values()].reduce(
            (sum, event) => sum + (event.properties.counts[key] ?? 0),
            0,
          );
        };
        await c.escape();
        await c.namedButton("header button", "Live TV");
        await c.waitFor(async () => (await counter("feature_live_tv")) > 0);
        const probe = await boundary(c.main(), c.profile());
        const denied = new Set(["EPERM", "EACCES", "EBUSY"]);
        try {
          for (const [mode, key, selector] of [
            ["default", "action_epg_opened", 'button[aria-label="Later programmes"]'],
            ["exclusive", "action_favourite_added", 'button[aria-label="Add to favourites"]'],
          ] as const) {
            await probe.reader(mode, key);
            await c.click(selector);
            await c.waitFor(async () => {
              const result = (await probe.readers()).find((item) => item.mode === mode);
              return (
                !!result &&
                (!!result.destinationSha256 ||
                  result.attempts >= 4 ||
                  (typeof result.lastCode === "string" && !denied.has(result.lastCode)))
              );
            });
            const results = await probe.readers();
            c.observations.windowsRetryReaders = results;
            const result = results.find((item) => item.mode === mode)!;
            assert(!result.captureError, result.captureError);
            assert(
              result.attempts >= 1 && result.attempts <= 4,
              "Unbounded native rename attempts",
            );
            assert.equal(
              result.destinationSha256,
              result.tempSha256,
              "Recovery changed temporary bytes",
            );
            assert.equal(await counter(key), 1, "Real handle action was not durably counted once");
          }
          const results = await probe.readers();
          const recovered = results.filter(
            (result) =>
              !result.openError &&
              typeof result.firstCode === "string" &&
              denied.has(result.firstCode) &&
              result.lastCode === null &&
              result.attempts > 1,
          );
          assert(
            recovered.length > 0,
            "OPEN: neither real Windows handle denied replacement; retry recovery unproved",
          );
          const measurements = await probe.measurements();
          for (const result of recovered) {
            assert(result.openedAt && result.closedAt, "Missing actual handle lifetime");
            const attempts = measurements.filter((item) => item.from === result.from);
            assert.equal(attempts.length, result.attempts);
            assert(denied.has(attempts[0]!.code!));
            assert.equal(attempts.at(-1)!.code, null);
            assert.equal(result.destinationSha256, result.tempSha256);
          }
        } finally {
          try {
            c.observations.windowsRetryReaders = await probe.readers();
            const measurements = await probe.measurements();
            c.observations.windowsRetryMeasurements = measurements;
            await writeFile(
              join(c.evidence, "windows-retry-boundary.json"),
              JSON.stringify(
                {
                  scope:
                    "Controlled real in-process Windows handles, actual native rename results; no mocked rejection. Default-reader outcome is diagnostic.",
                  observed: await saved("windows-retry-observed"),
                  readers: c.observations.windowsRetryReaders,
                  measurements,
                },
                null,
                2,
              ),
            );
          } catch (error) {
            cleanupErrors.push(`windows-retry evidence: ${String(error)}`);
          }
          try {
            await probe.restore();
          } catch (error) {
            cleanupErrors.push(`windows-retry restore: ${String(error)}`);
          }
        }
        // A later real UI action must persist and reach HTTP after the held handle was removed.
        await c.click('button[aria-label="Search"]');
        await c.page().send("Input.insertText", { text: "TEST | H.264 + AAC" });
        await c.waitFor(async () => (await counter("action_search_used")) === 1);
        await c.snapshot("windows-retry-recovered");
        c.prepareExit("windows-retry-complete");
        await c.quit();
        const final = await saved("windows-retry-final");
        assert.equal(final.installationId, identity);
        assert.equal(final.enabled, true);
        assert.equal(final.summaries?.usage, null);
        assert.equal(pending(final).length, 0);
        assert.equal(final.pending.length, 0);
        const received = c
          .events()
          .filter((event) => event.event === "usage_window")
          .filter((event) => event.distinct_id === identity);
        assert.equal(
          new Set(received.map((event) => event.uuid)).size,
          received.length,
          "Duplicate usage wire UUID",
        );
        for (const key of [
          "action_epg_opened",
          "action_favourite_added",
          "action_search_used",
        ] as const)
          assert.equal(
            received.reduce((sum, event) => sum + (event.properties.counts[key] ?? 0), 0),
            1,
          );
        return {
          readers: c.observations.windowsRetryReaders,
          measurements: c.observations.windowsRetryMeasurements,
          received,
          final,
        };
      });

    if (process.platform === "win32")
      await run("windows-rename", async () => {
        await fresh();
        await play();
        const probe = await boundary(c.main(), c.profile());
        await delay(1200);
        await home();
        await c.waitFor(async () => (await probe.measurements()).length > 0);
        const normal = await probe.measurements();
        await c.namedButton("button", "Watch");
        await delay(1200);
        const prior = await readFile(join(c.profile(), "analytics.json"), "utf8");
        const lock = await windowsDeleteLock(c.profile());
        try {
          await home();
          await c.waitFor(async () =>
            (await probe.measurements()).some((entry) => entry.code !== null),
          );
          assert.equal(await readFile(join(c.profile(), "analytics.json"), "utf8"), prior);
          const failedTemps = await Promise.all(
            (await readdir(c.profile()))
              .filter((name) => /^analytics\.json\.[a-f0-9-]{36}\.tmp$/.test(name))
              .map(async (name) => ({
                name,
                record: JSON.parse(
                  await readFile(join(c.profile(), name), "utf8"),
                ) as AnalyticsRecord,
              })),
          );
          assert(
            failedTemps.some(
              ({ record }) =>
                (record.summaries?.unfinished?.event.properties.watch_duration_seconds ?? 0) >
                (JSON.parse(prior) as AnalyticsRecord).summaries!.unfinished!.event.properties
                  .watch_duration_seconds,
            ),
            "The failed real rename did not contain the newly counted checkpoint",
          );
          await writeFile(
            join(c.evidence, "windows-failed-checkpoint-temps.json"),
            JSON.stringify(failedTemps, null, 2),
          );
          await c.settings();
          await c.click(checkbox);
          await c.waitFor(() =>
            c.page().evaluate<boolean>("!!document.querySelector('.text-destructive')"),
          );
          await c.snapshot("windows-rename-failed");
        } finally {
          await lock.close();
        }
        const from = c.bodies.length;
        await delay(1200);
        assert.equal(c.bodies.length, from);
        const failed = await probe.measurements();
        await probe.restore();
        await c.quit();
        await restart();
        assert.equal((await c.read()).installationId, JSON.parse(prior).installationId);
        assert.equal((await c.read()).enabled, JSON.parse(prior).enabled);
        await c.quit();
        return { normalRename: normal, failedRename: failed, lock: lock.ready };
      });

    const prior = pair
      ? pair.prior
      : c.options.priorExecutable
        ? {
            executable: c.options.priorExecutable,
            version: "0.0.15",
            source: c.options.priorSource!,
          }
        : null;
    if (prior)
      await run("compatibility", async () => {
        const select = async (which: "stable" | "candidate", local = true) => {
          await c.quit();
          if (pair) await pair.select(which);
          await c.launch(which === "stable" ? prior : c.candidate, local);
          await awake();
          await c.waitFor(() =>
            c
              .page()
              .evaluate<boolean>(
                "!!document.querySelector('header') || document.querySelectorAll('form input').length >= 3",
              ),
          );
          if (await c.page().evaluate<boolean>("!!document.querySelector('header')"))
            await c.verifyAbout();
        };
        const proofs: unknown[] = [];
        // Profiles are created by actual binaries. There is no seeded crash snapshot.
        for (const variant of [
          "legacy-queue",
          "off",
          "write",
          "opt-out",
          "reenable",
          "no-write",
        ] as const) {
          await c.capture("accept");
          await c.fresh();
          if (variant === "legacy-queue" || variant === "off") {
            await select("stable");
            await c.connect();
            await c.escape();
            await c.verifyAbout();
            const identity = (await c.read()).installationId;
            if (variant === "off") {
              await c.settings();
              await c.click(checkbox);
              await c.waitFor(async () => !(await c.read()).enabled);
            } else {
              await c.capture("offline");
              await c.settings();
              await c.waitFor(async () =>
                (await c.read()).pending.some((item) => item.event.event === "feature_opened"),
              );
            }
            if (variant === "legacy-queue") c.prepareExit("legacy-queue");
            const old = await saved(`compat-${variant}-015`);
            // .15 deliberately skips backoff at quit and spends all remaining refused-connect
            // attempts. Kill its actual main with the admitted queue still durable instead.
            if (variant === "legacy-queue") {
              await c.kill();
              assert.deepEqual((await c.read()).pending, old.pending);
            } else await c.quit();
            await c.capture("accept");
            const from = c.bodies.length;
            await select("candidate");
            assert.equal((await c.read()).installationId, identity);
            assert.equal((await c.read()).enabled, old.enabled);
            if (variant === "legacy-queue") {
              const event = old.pending.find(
                (item) => item.event.event === "feature_opened",
              )!.event;
              await c.waitFor(async () => wires(event.uuid).length > 0);
              assert.deepEqual(
                c.events().find((item) => item.uuid === event.uuid),
                event,
              );
            } else {
              await delay(1200);
              assert.equal(c.bodies.length, from);
            }
            proofs.push({ variant, old, after: await saved(`compat-${variant}-return`) });
          } else {
            await select("candidate");
            await c.connect();
            await c.escape();
            await c.verifyAbout();
            await play();
            await c.capture("offline");
            await stop();
            await c.waitFor(async () =>
              pending(await c.read()).some(
                (item) =>
                  item.event.event === "stream_summary" && item.attempts === 0 && item.failures > 0,
              ),
            );
            const before = await saved(`compat-${variant}-before`);
            await c.quit();
            const bytes = await readFile(join(c.profile(), "analytics.json"), "utf8");
            await select("stable", variant !== "no-write");
            assert.equal((await c.preference()).analyticsEnabled, true);
            assert.equal((await c.read()).installationId, before.installationId);
            await c.verifyAbout();
            if (variant === "no-write") {
              await c.quit();
              assert.equal(await readFile(join(c.profile(), "analytics.json"), "utf8"), bytes);
            } else {
              await c.capture("accept");
              await c.settings();
              if (variant === "opt-out" || variant === "reenable") {
                await c.click(checkbox);
                await c.waitFor(async () => !(await c.read()).enabled);
                if (variant === "reenable") {
                  await c.click(checkbox);
                  await c.waitFor(async () => (await c.read()).enabled);
                }
              } else
                await c.waitFor(async () =>
                  c
                    .events()
                    .some(
                      (event) =>
                        event.event === "feature_opened" &&
                        event.properties.app_version === "0.0.15" &&
                        event.distinct_id === before.installationId,
                    ),
                );
              await c.waitFor(async () => !(await c.read()).summaries);
            }
            await select("candidate");
            await c.capture("accept");
            assert.equal((await c.read()).installationId, before.installationId);
            assert.equal((await c.read()).enabled, variant !== "opt-out");
            if (variant === "no-write") {
              for (const item of pending(before)) {
                await c.waitFor(async () => wires(item.event.uuid).length > 0);
                assert.deepEqual(
                  c.events().find((event) => event.uuid === item.event.uuid),
                  item.event,
                );
              }
            } else {
              await delay(2200);
              for (const item of pending(before))
                assert.equal(
                  wires(item.event.uuid).length,
                  0,
                  "Unsupported work revived after an old-build write",
                );
            }
            proofs.push({ variant, before, after: await saved(`compat-${variant}-after`) });
          }
          await c.quit();
        }
        return proofs;
      });
    assert(cases.length > 0, "Unknown or inapplicable --native-case");
    c.events(); // Validate every raw decoded body, including duplicates, against the wire allowlist.
    c.observations.nativeReconciliation = reconcileBodies(c.bodies.map((wire) => wire.body));
    c.observations.nativeCoverage = {
      selected: selected ?? "all applicable core cases",
      compatibility: !!prior,
      windows: process.platform === "win32",
      installed: !!c.candidate.executable,
      productionEvidence:
        "Separately owned by the release runner; local synthetic captures do not establish production ingestion",
      pending: [
        ...(!prior
          ? ["installed .15 compatibility requires --prior-executable or --installed-pair"]
          : []),
        ...(!c.candidate.executable
          ? ["source-build evidence does not close installed native acceptance"]
          : []),
      ],
    };
    pair?.accepted();
  } catch (error) {
    primaryError = error;
    failed = true;
  } finally {
    for (const close of [
      () => c.quit(),
      async () => {
        if (pair) await pair.close();
      },
    ]) {
      try {
        await close();
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    }
    c.observations.nativeCleanupErrors = cleanupErrors;
  }
  if (failed) throw primaryError;
  if (cleanupErrors.length) throw new Error(cleanupErrors.join("\n"));
}
