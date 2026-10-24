import { randomUUID } from "node:crypto";
import { type } from "arktype";
import { PlaybackDiagnostic } from "@mrstreamer/contracts/analytics";
import type {
  AnalyticsAction,
  AnalyticsFailure,
  AnalyticsSetting,
  AnalyticsPlaybackKind,
  AnalyticsPlaybackState,
  AnalyticsFeature,
  AnalyticsSettings,
  PlaybackControl,
} from "@mrstreamer/contracts/analytics";
import {
  AnalyticsRecord,
  BuildProperties,
  CaptureEvent,
  OUTBOX_LIMIT,
  WATCH_SECONDS_LIMIT,
  WINDOW_MS,
  SUMMARY_TTL_MS,
  OUTBOX_BYTES,
  type SummaryBlock,
  type LifecycleBlock,
  type VersionObservation,
  type SummaryEvent,
  type StreamSummary,
  type UsageKey,
  type DirectName,
  type EventProperties,
  type ProfileOrigin,
} from "./model.ts";
import type { OperationOutcome } from "./operations.ts";
import { analyticsStore } from "./storage.ts";
import type { CaptureTransport } from "./transport.ts";

const IO_MS = 1500;
const QUIT_MS = 500;
const ATTEMPTS = 3;
/** Captures per minute. Human actions stay far below it; a runaway producer loses the rest. */
const RATE_LIMIT = 60;

interface PlaybackIntent {
  readonly control: string;
  readonly order: number;
  readonly kind: AnalyticsPlaybackKind;
  readonly frame: string;
  ended: boolean;
  remoteControl?: string | null;
}

/** A capture waiting for the disk serializer, which adds the installation identity. */
interface Unsent {
  readonly uuid: string;
  readonly timestamp: string;
  readonly event: DirectName;
  readonly properties: object;
}

interface AnalyticsOptions {
  readonly dataDir: string;
  readonly origin: Promise<ProfileOrigin>;
  readonly properties: BuildProperties;
  readonly transport: CaptureTransport | null;
  /** Replaces the persistence port for failure/deadline verification, not the owner. */
  readonly store?: ReturnType<typeof analyticsStore>;
  /** Requests a fresh composed snapshot after a consent save, even if its caller timed out. */
  readonly consentChanged?: () => void | Promise<void>;
  readonly playbackReset?: () => void;
  readonly monotonic?: () => number;
}

/** One profile's consent, identity, playback runs, durable outbox and owned network work. */
export class Analytics {
  private readonly monotonic: () => number;
  private readonly playbackReset: (() => void) | undefined;
  private readonly consentChanged: AnalyticsOptions["consentChanged"];
  private intent: PlaybackIntent | null = null;
  private run: {
    token: string;
    kind: AnalyticsPlaybackKind;
    /** Playing was confirmed, here or before this run was minted for a continuation. */
    started: boolean;
    /** Only an admitted first confirmed play owns a future summary. */
    reported: boolean;
    incident: boolean;
    eligible: boolean;
    watchMs: number;
    checkpointMs: number;
    summary: StreamSummary | null;
    remoteControl?: string | null;
    intent?: PlaybackIntent;
  } | null = null;
  private binding: {
    token: string;
    output: "local" | "remote";
    sequence: number;
    state: AnalyticsPlaybackState | null;
  } | null = null;
  // One just-closed generation may report its terminal failure after synchronous teardown.
  private lastClosedBinding: string | null = null;
  private bindingClosed: { signal: AbortSignal; listener: () => void } | null = null;
  private interval: { mono: number; until: number } | null = null;
  private readonly store: ReturnType<typeof analyticsStore>;
  private readonly transport: CaptureTransport | null;
  private properties: BuildProperties;
  private record: AnalyticsRecord | null = null;
  private serial: Promise<void>;
  /** Settled initial consent read, including a late success after the public wait expires. */
  readonly loaded: Promise<void>;
  private readonly initialized: Promise<void>;
  private recoveryPending = true;
  private available = true;
  private paused = false;
  private revision = 0;
  private foreground = false;
  /** Only a fresh profile's uninterrupted initial consent period can establish a new arrival. */
  private freshSession = false;
  private closing = false;
  private stopped = false;
  private observationPending = false;
  private incoming: Unsent[] = [];
  private flushing = false;
  private rate = { start: -Infinity, count: 0 };
  private usageRate = { start: -Infinity, count: 0 };
  private playRate = { start: -Infinity, count: 0 };
  private usageIncoming: { key: UsageKey; timestamp: string; properties: BuildProperties }[] = [];
  private summariesIncoming: SummaryEvent[] = [];
  private journal: SummaryBlock["unfinished"] = null;
  private journalDirty = false;
  private sealRequested = false;
  private windowTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly directRetry = new Map<string, number>();
  private dayTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private request: AbortController | undefined;
  private sending: Promise<void> | undefined;

  constructor(options: AnalyticsOptions) {
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.playbackReset = options.playbackReset;
    this.consentChanged = options.consentChanged;
    this.store = options.store ?? analyticsStore(options.dataDir);
    this.transport = options.transport;
    const properties = BuildProperties()(options.properties);
    // No raw values in errors or diagnostics, including invalid version strings.
    if (properties instanceof type.errors) throw new Error("Invalid analytics build properties.");
    this.properties = properties;
    this.loaded = Promise.all([this.store.load(), options.origin])
      .then(([kept, origin]) => {
        if (this.closing) return;
        this.freshSession = kept === null && origin === "fresh" && this.revision === 0;
        this.record = kept ?? {
          format: 2,
          enabled: true,
          installationId: null,
          profileOrigin: origin,
          firstSeen: false,
          lastDay: null,
          pending: [],
        };
      })
      .catch(() => this.unavailable());
    this.serial = this.loaded;
    // A slow read is still the serializer's owner. Only its actual failure disables capture;
    // Settings can stop waiting without letting preference writes overtake load or migration.
    this.initialized = deadline(this.serial, IO_MS).catch(() => {});
    // Base consent is readable before recovery performs any new disk write.
    void this.exclusive(() => this.recover())
      .catch(() => {})
      .finally(() => this.pump());
  }

  /** The only renderer-readable state. Identity and pending payloads stay in the main process. */
  async settings(): Promise<AnalyticsSettings> {
    // Reading consent never waits behind capture/outbox writes or a network retry.
    await this.initialized;
    return {
      enabled: this.record?.enabled ?? false,
      transport:
        !this.available || !this.record ? "unavailable" : (this.transport?.kind ?? "unconfigured"),
    };
  }

  /**
   * Pauses synchronously, before waiting for disk. Successful latest writes alone resume capture.
   * Re-enable keeps firstSeen and lastDay, so cleared observations are never recounted/backfilled.
   * Opting out drops the current run without a stop; one continuing across opt-in has no start.
   */
  configure(enabled: boolean): Promise<AnalyticsSettings> {
    if (!enabled) {
      this.freshSession = false;
      this.invalidatePlayback();
      this.directRetry.clear();
    }
    this.paused = true;
    const revision = ++this.revision;
    this.incoming = [];
    this.usageIncoming = [];
    this.summariesIncoming = [];
    this.journal = null;
    this.journalDirty = false;
    this.sealRequested = false;
    this.clearWindow();
    this.request?.abort();
    this.clearRetry();
    const changed = this.exclusive(async () => {
      if (!this.available || !this.record || this.closing)
        throw new Error("Analytics preference could not be saved.");
      const { summaries, lifecycle, ...base } = this.record;
      await this.save({
        ...base,
        enabled,
        pending: enabled ? base.pending : [],
        ...(enabled && summaries ? { summaries } : {}),
        ...(enabled && lifecycle ? { lifecycle } : {}),
      });
      // The consent commit is independent of both the bounded caller and later recovery.
      // Publication reads current owners, so queued choices cannot replay an obsolete value.
      if (this.consentChanged && !this.closing)
        void Promise.resolve()
          .then(() => {
            if (!this.closing) return this.consentChanged?.();
          })
          .catch(() => {});
      if (this.revision === revision) this.paused = !enabled;
      // A preference requested during load paused startup recovery. Resume it only after the
      // latest enabled preference is durable, so opt-out/re-enable cannot revive cleared work.
      await this.recover();
    }).then(async () => {
      this.playbackReset?.();
      this.observe();
      this.pump();
      return this.settings();
    });
    // The requested preference stays queued if loading takes longer. Opt-out remains paused
    // synchronously and will clear persisted work when the serializer becomes available.
    return deadline(changed, IO_MS).catch(() => {
      throw new Error("Analytics preference could not be saved.");
    });
  }

  private async recover(): Promise<void> {
    if (!this.recoveryPending || !this.canCapture() || this.closing || !this.record) return;
    this.recoveryPending = false;
    const block = this.record.summaries;
    if (!block) return;
    const recovered = block.unfinished?.event;
    await this.save({
      ...this.record,
      summaries: {
        ...block,
        usage: null,
        unfinished: null,
        pending: [
          ...block.pending,
          ...[block.usage, recovered].flatMap((event) => (event ? [queuedDurable(event)] : [])),
        ],
      },
    });
  }

  /** Native primary-window state, never a renderer event, playback or receiver activity. */
  setForeground(on: boolean): void {
    if (this.closing) return;
    this.foreground = on;
    if (this.dayTimer) clearInterval(this.dayTimer);
    this.dayTimer = undefined;
    if (on) {
      this.observe();
      this.dayTimer = setInterval(() => this.observe(), 60_000);
      this.dayTimer.unref();
    }
  }

  /** Each capture carries the dimensions current when it is queued. */
  setUpdateChannel(channel: BuildProperties["update_channel"]): void {
    if (channel === this.properties.update_channel) return;
    // Old usage seals before the committed setting is counted in the new envelope.
    this.sealRequested = true;
    this.flush();
    this.properties = { ...this.properties, update_channel: channel };
    this.checkpointPlayback();
  }

  /** A transaction's note counts only in the consent generation that began it. */
  actionObserver(action: AnalyticsAction): () => void {
    const consent = this.revision;
    const enabled = this.canCapture();
    return () => {
      if (enabled && consent === this.revision) this.noteAction(action);
    };
  }

  settingObserver(setting: AnalyticsSetting): () => void {
    const consent = this.revision;
    const enabled = this.canCapture();
    return () => {
      if (enabled && consent === this.revision) this.noteSetting(setting);
    };
  }

  noteAction(action: AnalyticsAction): void {
    this.noteUsage(`action_${action}`);
  }

  noteSetting(setting: AnalyticsSetting): void {
    this.noteUsage(`setting_${setting}`);
  }

  noteFeature(feature: AnalyticsFeature): void {
    this.noteUsage(`feature_${feature}`);
  }

  /** Main observes the reason; clean exits and requested closes are the caller's to exclude. */
  noteRendererExit(reason: EventProperties<"renderer_exited">["reason"]): void {
    this.capture("renderer_exited", { reason });
  }

  /** An outcome reports only in the enabled generation that observed its start. */
  observeOperation(
    event: "download_ended" | "update_check_ended",
  ): (outcome: OperationOutcome, failure?: AnalyticsFailure) => void {
    const consent = this.revision;
    const enabled = this.transport !== null && this.canCapture() && !this.closing;
    return (outcome, failure = "app") => {
      if (!enabled || consent !== this.revision) return;
      this.capture(event, outcome === "failed" ? { outcome, error_type: failure } : { outcome });
    };
  }

  /** Admission uses the same hint whether its advisory RPC answered, failed or never arrived. */
  admitPlayback(
    kind: AnalyticsPlaybackKind,
    hint: PlaybackControl | undefined,
    frame: string | null,
  ): string | null {
    if (!hint || !frame || this.closing) return null;
    const prior = this.intent;
    if (prior && (prior.frame !== frame || hint.order < prior.order)) return null;
    const fresh = !prior || hint.order > prior.order;
    if (!fresh && (prior.control !== hint.control || prior.kind !== kind || prior.ended))
      return null;
    const intent: PlaybackIntent = fresh
      ? { control: hint.control, order: hint.order, kind, frame, ended: false }
      : prior;
    this.intent = intent;
    if (fresh && (!hint.ongoing || this.run?.kind !== kind)) {
      this.beginPlayback(kind, hint.ongoing);
    } else if (!this.run) {
      // Recollection after a consent reset belongs to the current continuation.
      this.beginPlayback(kind, fresh ? hint.ongoing : true);
    }
    if (this.run?.kind !== kind) return null;
    intent.remoteControl = this.run.remoteControl ?? null;
    this.run.intent = intent;
    return this.run.token;
  }

  /** Acceptance remains meaningful while consent is off and no run has been minted. */
  isPlaybackControlCurrent(control: string, frame: string | null): boolean {
    const intent = this.intent;
    return !!intent && !intent.ended && intent.frame === frame && intent.control === control;
  }

  /** Resolve only the current trusted renderer control; callers retain this exact run token. */
  controlledPlayback(control: string, frame: string | null): string | null {
    return this.isPlaybackControlCurrent(control, frame) && this.run?.intent === this.intent
      ? this.run.token
      : null;
  }

  endControlledPlayback(control: string, frame: string | null): void {
    const token = this.controlledPlayback(control, frame);
    if (token) this.endPlayback(token);
    else if (this.intent && this.isPlaybackControlCurrent(control, frame)) this.intent.ended = true;
  }

  /**
   * Logical intent is ephemeral. Opening media does not establish that it played. A new run ends
   * the previous one. An ongoing continuation never reports a historical start.
   */
  beginPlayback(
    kind: AnalyticsPlaybackKind,
    ongoing = false,
    remoteControl?: string | null,
    intent?: PlaybackIntent,
  ): string | null {
    this.finishRun();
    if (!this.transport || !this.canCapture() || this.closing) return null;
    const token = randomUUID();
    this.run = {
      token,
      kind,
      started: ongoing,
      reported: false,
      incident: false,
      eligible: true,
      watchMs: 0,
      checkpointMs: 0,
      summary: null,
      ...(remoteControl !== undefined ? { remoteControl } : {}),
      ...(intent ? { intent } : {}),
    };
    return token;
  }

  bindPlayback(
    token: string,
    output: "local" | "remote",
    kind?: AnalyticsPlaybackKind,
    closed?: AbortSignal,
  ): string | null {
    if (
      this.run?.token !== token ||
      (kind !== undefined && this.run.kind !== kind) ||
      !this.canCapture() ||
      this.closing
    )
      return null;
    this.settlePlayback();
    this.checkpointPlayback();
    this.clearBindingListener();
    if (closed?.aborted) return null;
    const binding = randomUUID();
    this.lastClosedBinding = null;
    this.binding = { token: binding, output, sequence: -1, state: null };
    this.interval = null;
    if (closed) {
      const listener = () => this.stopPlaybackBinding(binding);
      this.bindingClosed = { signal: closed, listener };
      closed.addEventListener("abort", listener, { once: true });
    }
    return binding;
  }

  notePlaybackState(
    token: string,
    binding: string,
    sequence: number,
    state: AnalyticsPlaybackState,
  ): void {
    if (
      this.run?.token !== token ||
      this.binding?.token !== binding ||
      !Number.isSafeInteger(sequence) ||
      sequence <= this.binding.sequence ||
      !this.canCapture() ||
      this.closing
    )
      return;
    this.settlePlayback();
    const changed = this.binding.state !== state;
    this.binding.sequence = sequence;
    this.binding.state = state;
    if (state === "playing" && this.run.eligible) {
      if (!this.run.started) {
        this.run.started = true;
        if (this.record?.installationId && this.admit(this.playRate)) {
          this.run.reported = true;
          this.run.summary = {
            uuid: randomUUID(),
            distinct_id: this.record.installationId,
            timestamp: new Date().toISOString(),
            event: "stream_summary",
            properties: {
              ...this.common(),
              stream_type: this.run.kind,
              started_at: new Date().toISOString(),
              started_update_channel: this.properties.update_channel,
              watch_duration_seconds: 0,
              end_reason: "interrupted",
            },
          };
          this.checkpointPlayback();
        }
      }
      this.run.incident = false;
      const mono = this.monotonic();
      this.interval = { mono, until: mono + (this.binding.output === "local" ? 5000 : 15000) };
    } else {
      this.interval = null;
      if (
        changed &&
        (state === "paused" || state === "stopped") &&
        this.run.watchMs !== this.run.checkpointMs
      )
        this.checkpointPlayback();
    }
  }

  setPlaybackEligible(token: string, eligible: boolean): void {
    if (this.run?.token !== token) return;
    this.settlePlayback();
    if (this.run.eligible !== eligible) this.checkpointPlayback();
    this.run.eligible = eligible;
    this.interval = null;
    // The producer must confirm playing again after promotion; eligibility alone proves no media.
  }

  notePlaybackFailure(
    token: string,
    binding: string | null,
    failure: AnalyticsFailure,
    diagnostic?: PlaybackDiagnostic,
  ): void {
    const context = PlaybackDiagnostic()(diagnostic ?? {});
    if (context instanceof type.errors) return;
    if (
      this.run?.token !== token ||
      (binding === null
        ? this.binding !== null
        : this.binding?.token !== binding &&
          (this.binding !== null || this.lastClosedBinding !== binding)) ||
      this.run.incident ||
      !this.run.eligible ||
      !this.canCapture() ||
      this.closing
    )
      return;
    this.settlePlayback();
    this.interval = null;
    this.checkpointPlayback();
    this.run.incident = true;
    this.capture("stream_error", { stream_type: this.run.kind, error_type: failure, ...context });
  }

  endPlayback(token: string): void {
    if (this.run?.token !== token) return;
    if (this.run.intent) this.run.intent.ended = true;
    this.finishRun();
  }

  stopPlaybackBinding(binding: string): void {
    if (this.binding?.token !== binding) return;
    this.settlePlayback();
    this.checkpointPlayback();
    this.clearBindingListener();
    this.lastClosedBinding = binding;
    this.binding = null;
    this.interval = null;
  }

  /** A local run ends with its renderer. Receiver playback continues under main ownership. */
  rendererGone(): void {
    this.intent = null;
    if (this.binding?.output !== "remote") this.finishRun();
  }

  suspendPlayback(): void {
    this.settlePlayback();
    this.checkpointPlayback();
    this.interval = null;
  }

  /** Output's generation guard owns this callback, independently of the renderer lifetime. */
  remotePlayback(kind: AnalyticsPlaybackKind, control: string | null = this.run?.token ?? null) {
    const requested =
      this.intent?.kind === kind && this.intent.control === control && !this.intent.ended
        ? this.intent
        : undefined;
    let token =
      this.run?.kind === kind &&
      (this.run.token === control ||
        this.run.remoteControl === control ||
        (requested && this.run.intent === requested))
        ? this.run.token
        : null;
    const authorized = token !== null || requested !== undefined;
    if (requested) requested.remoteControl = control;
    if (token && this.run) {
      this.run.remoteControl = control;
      if (this.run.intent) this.run.intent.remoteControl = control;
    }
    let binding: string | null = token ? this.bindPlayback(token, "remote") : null;
    let intent = requested ?? this.run?.intent;
    let sequence = 0;
    let active = true;
    return {
      state: (state: AnalyticsPlaybackState) => {
        // Consent changes require a fresh trusted observation, with no historical start.
        if (!active || !authorized) return;
        if (!this.run) {
          if (this.intent?.remoteControl === control && this.intent.kind === kind)
            intent = this.intent;
          if (intent && (intent.ended || (this.intent && this.intent !== intent))) return;
          token = this.beginPlayback(
            kind,
            true,
            control,
            this.intent === intent ? intent : undefined,
          );
          binding = token ? this.bindPlayback(token, "remote") : null;
        }
        if (token && binding) this.notePlaybackState(token, binding, ++sequence, state);
      },
      failure: (failure: AnalyticsFailure, diagnostic?: PlaybackDiagnostic) => {
        if (active && token && binding)
          this.notePlaybackFailure(token, binding, failure, diagnostic);
      },
      stop: () => {
        active = false;
        if (binding) this.stopPlaybackBinding(binding);
      },
      // Only while this load still owns the run's binding: a newer load, run or reset keeps its own.
      end: () => {
        if (!active) return;
        active = false;
        if (token && binding && this.binding?.token === binding) this.endPlayback(token);
        else if (binding) this.stopPlaybackBinding(binding);
      },
    };
  }

  /** A terminal result can count only in the enabled generation that observed its start. */
  playbackFailureObserver(
    control: string | undefined,
  ): (failure: AnalyticsFailure, diagnostic?: PlaybackDiagnostic) => void {
    // Resolve a receiver alias now, then retain the exact run through asynchronous completion.
    const token =
      control && (this.run?.token === control || this.run?.remoteControl === control)
        ? this.run.token
        : null;
    return (failure, diagnostic) => {
      if (token) this.notePlaybackFailure(token, null, failure, diagnostic);
    };
  }

  /** A receiver load failed before Output could create its physical observation. */
  receiverLoadFailureObserver(
    control: string | undefined,
    frame: string | null,
  ): (failure: AnalyticsFailure, diagnostic?: PlaybackDiagnostic) => void {
    const token = control ? this.controlledPlayback(control, frame) : null;
    return (failure, diagnostic) => {
      if (!token || !control || this.controlledPlayback(control, frame) !== token) return;
      // An earlier receiver load may still own the binding until this load takes its place.
      // The run's incident guard merges that failure with any later physical callback.
      const binding = this.binding;
      this.notePlaybackFailure(token, binding?.token ?? null, failure, diagnostic);
    };
  }

  private clearBindingListener(): void {
    if (this.bindingClosed)
      this.bindingClosed.signal.removeEventListener("abort", this.bindingClosed.listener);
    this.bindingClosed = null;
  }

  private invalidatePlayback(): void {
    this.clearBindingListener();
    this.run = null;
    this.lastClosedBinding = null;
    this.binding = null;
    this.interval = null;
  }

  /** Atomically retires an admitted journal into its one terminal outbox event. */
  private finishRun(): void {
    this.settlePlayback();
    const run = this.run;
    if (run?.reported && run.summary && this.canCapture()) {
      this.summariesIncoming.push({
        ...run.summary,
        timestamp: new Date().toISOString(),
        properties: {
          ...run.summary.properties,
          ...this.properties,
          watch_duration_seconds: Math.min(WATCH_SECONDS_LIMIT, Math.round(run.watchMs / 1000)),
          end_reason: "ended",
        },
      });
      this.journal = null;
      this.journalDirty = true;
      this.flush();
    }
    this.invalidatePlayback();
  }

  private checkpointPlayback(): void {
    const run = this.run;
    if (!run?.summary || !this.canCapture()) return;
    run.checkpointMs = run.watchMs;
    this.journal = {
      event: {
        ...run.summary,
        timestamp: new Date().toISOString(),
        properties: {
          ...run.summary.properties,
          update_channel: this.properties.update_channel,
          watch_duration_seconds: Math.min(WATCH_SECONDS_LIMIT, Math.floor(run.watchMs / 1000)),
        },
      },
      watchMs: Math.min(WATCH_SECONDS_LIMIT * 1000, run.watchMs),
    };
    this.journalDirty = true;
    this.flush();
  }

  /**
   * Monotonic elapsed time since the last confirmed playing state, capped by its lease, so a
   * stalled producer, pause, wait, seek or suspend adds nothing. Media positions are never used.
   */
  private settlePlayback(): void {
    const interval = this.interval;
    if (!interval || !this.run || !this.canCapture() || this.closing) return;
    const mono = this.monotonic();
    this.run.watchMs += Math.max(0, Math.min(mono, interval.until) - interval.mono);
    this.interval = mono >= interval.until ? null : { mono, until: interval.until };
    if (this.run.watchMs - this.run.checkpointMs >= WINDOW_MS) this.checkpointPlayback();
  }

  /**
   * Queues one event in memory and coalesces a burst into one outbox write. Returns whether it
   * was queued; consent, quit and the rate limit refuse it.
   */
  private capture<Name extends DirectName>(
    event: Name,
    properties: EventProperties<Name>,
  ): boolean {
    if (!this.transport || !this.canCapture() || this.closing || !this.record) return false;
    if (!this.admit(this.rate)) return false;
    this.incoming.push({
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      event,
      properties: {
        ...this.common(),
        ...properties,
      },
    });
    this.flush();
    return true;
  }

  private common() {
    return {
      ...this.properties,
      profile_origin: this.record?.profileOrigin ?? "unknown",
      $process_person_profile: false as const,
      $geoip_disable: true as const,
    };
  }

  private admit(budget: { start: number; count: number }): boolean {
    const now = this.monotonic();
    if (now - budget.start >= 60_000) {
      budget.start = now;
      budget.count = 0;
    }
    if (budget.count >= RATE_LIMIT) return false;
    budget.count++;
    return true;
  }

  private noteUsage(key: UsageKey): void {
    if (
      !this.transport ||
      !this.canCapture() ||
      this.closing ||
      !this.record?.installationId ||
      !this.admit(this.usageRate)
    )
      return;
    this.usageIncoming.push({
      key,
      timestamp: new Date().toISOString(),
      properties: this.common(),
    });
    this.flush();
    this.armWindow();
  }

  /** One coalesced atomic write owns admitted facts, seals and journal transitions. */
  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    void this.exclusive(async () => {
      this.flushing = false;
      const unsent = this.incoming.splice(0);
      const usage = this.usageIncoming.splice(0);
      const summaries = this.summariesIncoming.splice(0);
      const journalDirty = this.journalDirty;
      const journal = this.journal;
      const seal = this.sealRequested;
      this.journalDirty = false;
      this.sealRequested = false;
      const record = this.record;
      const id = record?.installationId;
      if (!record || !id || !this.canCapture()) return;
      const queued = unsent.flatMap((item) => {
        const allowed = CaptureEvent()({ ...item, distinct_id: id });
        return allowed instanceof type.errors ||
          allowed.event === "usage_window" ||
          allowed.event === "stream_summary" ||
          allowed.event === "app_version_observed"
          ? []
          : [{ event: allowed, attempts: 0 }];
      });
      let block = record.summaries ?? emptySummaries(id);
      let fragment = block.usage;
      const pending = [...block.pending];
      const sealUsage = () => {
        if (fragment) pending.push(queuedDurable(fragment));
        fragment = null;
      };
      // Facts carry the envelope captured by their caller, including several changes in one burst.
      for (const fact of usage) {
        const start = Math.floor(Date.parse(fact.timestamp) / WINDOW_MS) * WINDOW_MS;
        const timestamp = new Date(start).toISOString();
        if (
          fragment &&
          (fragment.timestamp !== timestamp ||
            fragment.properties.update_channel !== fact.properties.update_channel)
        )
          sealUsage();
        if (!fragment)
          fragment = {
            uuid: randomUUID(),
            distinct_id: id,
            timestamp,
            event: "usage_window",
            properties: {
              ...this.common(),
              ...fact.properties,
              window_start: timestamp,
              window_end: new Date(start + WINDOW_MS).toISOString(),
              counts: {},
            },
          };
        const counts = fragment.properties.counts;
        counts[fact.key] = Math.min(Number.MAX_SAFE_INTEGER, (counts[fact.key] ?? 0) + 1);
      }
      if (seal || (fragment && Date.now() >= Date.parse(fragment.properties.window_end)))
        sealUsage();
      block = {
        ...block,
        usage: fragment,
        pending: [...pending, ...summaries.map(queuedDurable)],
        unfinished: journalDirty ? journal : block.unfinished,
      };
      if (queued.length || usage.length || summaries.length || journalDirty || seal)
        await this.save({ ...record, pending: [...record.pending, ...queued], summaries: block });
    })
      .catch(() => {})
      .finally(() => this.pump());
  }

  private armWindow(): void {
    if (this.windowTimer || this.closing) return;
    this.windowTimer = setTimeout(
      () => {
        this.windowTimer = undefined;
        this.sealRequested = true;
        this.flush();
      },
      WINDOW_MS - (Date.now() % WINDOW_MS),
    );
    this.windowTimer.unref();
  }

  private clearWindow(): void {
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = undefined;
  }

  /** Bounds the total wait, including a hung disk/transport. No new observations during quit. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.finishRun();
    this.sealRequested = true;
    this.flush();
    this.clearWindow();
    this.closing = true;
    this.foreground = false;
    if (this.dayTimer) clearInterval(this.dayTimer);
    this.clearRetry();
    try {
      await deadline(
        (async () => {
          // The final summary and any usage burst reach the outbox first.
          await this.exclusive(async () => {});
          // Drain due work within the quit allowance; persisted retry backoffs still apply.
          this.pump();
          while (this.sending) await this.sending;
        })(),
        QUIT_MS,
      );
    } catch {
      // Pending persisted events can be retried at next start with the same UUID and timestamp.
    } finally {
      this.stopped = true;
      this.request?.abort();
      this.clearRetry();
    }
  }

  private canCapture(): boolean {
    return this.available && !this.paused && !this.stopped && this.record?.enabled === true;
  }

  /** Foreground version history is independent of the UTC day ledger, including same-day updates. */
  private observe(): void {
    if (this.observationPending || !this.foreground || this.closing || !this.transport) return;
    this.observationPending = true;
    void this.exclusive(async () => {
      if (!this.canCapture() || !this.foreground || this.closing || !this.record) return;
      const record = this.record;
      const timestamp = new Date().toISOString();
      const day = timestamp.slice(0, 10);
      const installationId = record.installationId ?? randomUUID();
      const properties = this.common();
      const pending = [...record.pending];
      const lifecycle = { ...(record.lifecycle ?? emptyLifecycle(installationId)) };
      const baseline = lifecycle.baseline;
      const versionChanged =
        !baseline ||
        baseline.app_version !== properties.app_version ||
        baseline.build_channel !== properties.build_channel;
      if (versionChanged) {
        const event: VersionObservation = {
          uuid: randomUUID(),
          distinct_id: installationId,
          timestamp,
          event: "app_version_observed",
          properties:
            baseline && baseline.app_version !== "unknown"
              ? {
                  ...properties,
                  observation_kind: "transition",
                  previous_app_version: baseline.app_version,
                  previous_build_channel: baseline.build_channel,
                }
              : {
                  ...properties,
                  observation_kind:
                    !record.firstSeen && this.freshSession ? "new_profile" : "unknown_history",
                },
        };
        lifecycle.pending = [...lifecycle.pending, queuedDurable(event)];
        lifecycle.baseline = {
          app_version: properties.app_version,
          build_channel: properties.build_channel,
        };
      }
      const newDay = record.lastDay === null || day > record.lastDay;
      if (!versionChanged && !newDay) return;
      if (!record.firstSeen) {
        pending.push({
          event: {
            uuid: randomUUID(),
            distinct_id: installationId,
            timestamp,
            event: "installation_observed",
            properties,
          },
          attempts: 0,
        });
      }
      if (newDay)
        pending.push({
          event: {
            uuid: randomUUID(),
            distinct_id: installationId,
            timestamp,
            event: "app_active_day",
            properties: { ...properties, activity_date: day },
          },
          attempts: 0,
        });
      await this.save({
        ...record,
        installationId,
        firstSeen: true,
        lastDay: newDay ? day : record.lastDay,
        pending,
        lifecycle,
      });
    })
      .catch(() => {})
      .finally(() => {
        this.observationPending = false;
        this.pump();
      });
  }

  /** Network work stays outside the serializer; ready reliability events have priority. */
  private pump(): void {
    if (this.sending || !this.transport || !this.canCapture() || !this.record) return;
    this.clearRetry();
    const expired = (event: CaptureEvent) =>
      Date.now() - Date.parse(event.timestamp) > SUMMARY_TTL_MS;
    if (
      this.record.pending.some(
        (item) =>
          item.attempts >= ATTEMPTS || (isLegacyLifecycle(item.event) && expired(item.event)),
      ) ||
      this.record.summaries?.pending.some(
        (item) => item.attempts >= ATTEMPTS || expired(item.event),
      ) ||
      this.record.lifecycle?.pending.some(
        (item) => item.attempts >= ATTEMPTS || expired(item.event),
      )
    ) {
      this.sending = this.exclusive(async () => {
        if (!this.record || !this.canCapture()) return;
        // No request is active. Interruption after reserving a third possible send cannot
        // authorize a fourth. A conclusive pre-body refund must itself reach durable storage.
        const record = this.record;
        await this.save({
          ...record,
          pending: record.pending.filter(
            (item) =>
              item.attempts < ATTEMPTS && !(isLegacyLifecycle(item.event) && expired(item.event)),
          ),
          ...(record.summaries
            ? {
                summaries: {
                  ...record.summaries,
                  pending: record.summaries.pending.filter(
                    (item) => item.attempts < ATTEMPTS && !expired(item.event),
                  ),
                },
              }
            : {}),
          ...(record.lifecycle
            ? {
                lifecycle: {
                  ...record.lifecycle,
                  pending: record.lifecycle.pending.filter(
                    (item) => item.attempts < ATTEMPTS && !expired(item.event),
                  ),
                },
              }
            : {}),
        });
      })
        .catch(() => {})
        .finally(() => {
          this.sending = undefined;
          this.pump();
        });
      return;
    }
    const now = Date.now();
    const directDue = (item: AnalyticsRecord["pending"][number]) =>
      isLegacyLifecycle(item.event)
        ? Date.parse(
            this.record?.lifecycle?.legacyRetries.find((retry) => retry.uuid === item.event.uuid)
              ?.nextAttemptAt ?? item.event.timestamp,
          )
        : (this.directRetry.get(item.event.uuid) ?? now);
    const direct = this.record.pending.find((item) => directDue(item) <= now);
    const version = this.record.lifecycle?.pending.find(
      (item) => Date.parse(item.nextAttemptAt) <= now,
    );
    const summary = this.record.summaries?.pending.find(
      (item) => Date.parse(item.nextAttemptAt) <= now,
    );
    const chosen = direct ?? version ?? summary;
    if (!chosen) {
      const times = [
        ...this.record.pending.map(directDue),
        ...(this.record.lifecycle?.pending.map((item) => Date.parse(item.nextAttemptAt)) ?? []),
        ...(this.record.summaries?.pending.map((item) => Date.parse(item.nextAttemptAt)) ?? []),
      ];
      if (times.length && !this.closing) {
        this.retryTimer = setTimeout(
          () => {
            this.retryTimer = undefined;
            this.pump();
          },
          Math.max(1, Math.min(WINDOW_MS, Math.min(...times) - now)),
        );
        this.retryTimer.unref();
      }
      return;
    }
    const revision = this.revision;
    const sent = chosen.event;
    const optional = direct ? null : version ? "lifecycle" : "summaries";
    this.sending = (async () => {
      let reserved = false;
      await this.exclusive(async () => {
        if (!this.canCapture() || this.revision !== revision || !this.record) return;
        const record = this.record;
        if (optional) {
          const block = record[optional];
          if (!block || !block.pending.some((item) => item.event.uuid === sent.uuid)) return;
          await this.save({
            ...record,
            [optional]: {
              ...block,
              pending: block.pending.map((item) =>
                item.event.uuid === sent.uuid ? { ...item, attempts: item.attempts + 1 } : item,
              ),
            },
          });
        } else {
          if (!record.pending.some((item) => item.event.uuid === sent.uuid)) return;
          await this.save({
            ...record,
            pending: record.pending.map((item) =>
              item.event.uuid === sent.uuid ? { ...item, attempts: item.attempts + 1 } : item,
            ),
            ...(isLegacyLifecycle(sent)
              ? { lifecycle: record.lifecycle ?? emptyLifecycle(sent.distinct_id) }
              : {}),
          });
        }
        reserved = true;
      });
      if (!reserved || !this.canCapture() || this.revision !== revision || !this.transport) return;
      const controller = new AbortController();
      this.request = controller;
      let result: Awaited<ReturnType<CaptureTransport["send"]>>;
      try {
        result = await deadline(this.transport.send(sent, controller.signal), 1100);
      } catch {
        controller.abort();
        result = "retry";
      }
      await this.exclusive(async () => {
        if (!this.canCapture() || this.revision !== revision || !this.record) return;
        const record = this.record;
        if (optional) {
          const block = record[optional];
          if (!block) return;
          await this.save({
            ...record,
            [optional]: {
              ...block,
              pending: block.pending.flatMap((item) => {
                if (item.event.uuid !== sent.uuid) return [item];
                const next = retryAfter(item, result);
                return next ? [next] : [];
              }),
            },
          });
        } else {
          const attempted = record.pending.find((item) => item.event.uuid === sent.uuid);
          if (!attempted) return;
          if (isLegacyLifecycle(sent)) {
            const block = record.lifecycle ?? emptyLifecycle(sent.distinct_id);
            const retry = block.legacyRetries.find((item) => item.uuid === sent.uuid);
            const next = retryAfter(
              {
                ...attempted,
                failures: retry?.failures ?? 0,
                nextAttemptAt: retry?.nextAttemptAt ?? sent.timestamp,
              },
              result,
            );
            await this.save({
              ...record,
              pending: record.pending.flatMap((item) =>
                item.event.uuid !== sent.uuid
                  ? [item]
                  : next
                    ? [{ event: item.event, attempts: next.attempts }]
                    : [],
              ),
              lifecycle: {
                ...block,
                legacyRetries: [
                  ...block.legacyRetries.filter((item) => item.uuid !== sent.uuid),
                  ...(next
                    ? [
                        {
                          uuid: sent.uuid,
                          failures: next.failures,
                          nextAttemptAt: next.nextAttemptAt,
                        },
                      ]
                    : []),
                ],
              },
            });
          } else {
            const retry =
              (result === "retry" || result === "not_sent") && attempted.attempts < ATTEMPTS;
            if (retry) this.directRetry.set(sent.uuid, Date.now() + 2000);
            else {
              this.directRetry.delete(sent.uuid);
              await this.save({
                ...record,
                pending: record.pending.filter((item) => item.event.uuid !== sent.uuid),
              });
            }
          }
        }
      });
    })()
      .catch(() => {})
      .finally(() => {
        this.request = undefined;
        this.sending = undefined;
        this.pump();
      });
  }

  private exclusive<A>(run: () => Promise<A>): Promise<A> {
    const result = this.serial.then(run);
    this.serial = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async save(record: AnalyticsRecord): Promise<void> {
    try {
      record = bounded(record);
      await deadline(this.store.save(record), IO_MS);
      this.record = record;
      // Retry deadlines belong only to direct work that survived the durable save.
      const pending = new Set(record.pending.map((item) => item.event.uuid));
      for (const uuid of this.directRetry.keys()) {
        if (!pending.has(uuid)) this.directRetry.delete(uuid);
      }
    } catch {
      this.unavailable();
      throw new Error("Analytics preference could not be saved.");
    }
  }

  private unavailable(): void {
    this.available = false;
    this.paused = true;
    this.incoming = [];
    this.usageIncoming = [];
    this.summariesIncoming = [];
    this.journal = null;
    this.journalDirty = false;
    this.sealRequested = false;
    this.clearWindow();
    this.request?.abort();
    this.clearRetry();
    this.directRetry.clear();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}

function emptySummaries(installationId: string): SummaryBlock {
  return { version: 1, installationId, pending: [], usage: null, unfinished: null };
}

function queuedDurable<Event extends SummaryEvent | VersionObservation>(event: Event) {
  return { event, attempts: 0, failures: 0, nextAttemptAt: event.timestamp };
}

function emptyLifecycle(installationId: string): LifecycleBlock {
  return { version: 1, installationId, baseline: null, pending: [], legacyRetries: [] };
}

function isLegacyLifecycle(event: CaptureEvent): boolean {
  return event.event === "installation_observed" || event.event === "app_active_day";
}

/** Only proven pre-body failures refund a durable reservation. All other uncertainty spends it. */
function retryAfter<Item extends { attempts: number; failures: number; nextAttemptAt: string }>(
  item: Item,
  result: Awaited<ReturnType<CaptureTransport["send"]>>,
): Item | null {
  const attempts = item.attempts - (result === "not_sent" ? 1 : 0);
  if ((result !== "retry" && result !== "not_sent") || attempts >= ATTEMPTS) return null;
  const failures = Math.min(2147483647, item.failures + 1);
  return {
    ...item,
    attempts,
    failures,
    nextAttemptAt: new Date(
      Date.now() + Math.min(WINDOW_MS, 2000 * 2 ** Math.min(18, failures - 1)),
    ).toISOString(),
  };
}

/** Joint count and byte budget. Oldest summary work loses before direct reliability work. */
function bounded(record: AnalyticsRecord): AnalyticsRecord {
  const pending = record.pending.filter((item) => item.attempts <= ATTEMPTS);
  const block = record.summaries;
  const summaries =
    block?.pending.filter(
      (item) =>
        item.attempts <= ATTEMPTS &&
        Date.now() - Date.parse(item.event.timestamp) <= SUMMARY_TTL_MS,
    ) ?? [];
  const versions =
    record.lifecycle?.pending.filter(
      (item) =>
        item.attempts <= ATTEMPTS &&
        Date.now() - Date.parse(item.event.timestamp) <= SUMMARY_TTL_MS,
    ) ?? [];
  const result = {
    ...record,
    pending,
    ...(block ? { summaries: { ...block, pending: summaries } } : {}),
    ...(record.lifecycle
      ? {
          lifecycle: {
            ...record.lifecycle,
            pending: versions,
            legacyRetries: record.lifecycle.legacyRetries.filter((retry) =>
              pending.some((item) => item.event.uuid === retry.uuid),
            ),
          },
        }
      : {}),
  };
  const openSlots = Number(!!block?.usage) + Number(!!block?.unfinished);
  // Open owners reserve slots: evicting their snapshots would let a later checkpoint revive
  // discarded work. Sealed summaries and older version observations lose before direct work.
  while (
    pending.length + summaries.length + versions.length + openSlots > OUTBOX_LIMIT ||
    Buffer.byteLength(JSON.stringify(result)) > OUTBOX_BYTES
  ) {
    if (summaries.length) {
      summaries.shift();
      continue;
    }
    if (versions.length > 1) {
      versions.shift();
      continue;
    }
    const index = pending.findIndex((item) => item.event.event !== "installation_observed");
    if (index < 0) {
      if (versions.length) {
        versions.shift();
        continue;
      }
      break;
    }
    pending.splice(index, 1);
    if (result.lifecycle)
      result.lifecycle.legacyRetries = result.lifecycle.legacyRetries.filter((retry) =>
        pending.some((item) => item.event.uuid === retry.uuid),
      );
  }
  // Even a malformed oversized build envelope cannot escape the byte bound. If preserving the
  // first observation leaves no valid eviction, fail closed through the existing save owner.
  if (
    pending.length + summaries.length + versions.length + openSlots > OUTBOX_LIMIT ||
    Buffer.byteLength(JSON.stringify(result)) > OUTBOX_BYTES
  )
    throw new Error("Analytics state exceeds its work budget.");
  return result;
}

/** All owner waits have a deadline even when an injected or operating-system port never settles. */
async function deadline<A>(work: Promise<A>, ms: number): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Analytics deadline.")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
