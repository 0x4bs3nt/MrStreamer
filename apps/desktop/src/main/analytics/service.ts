import { randomUUID } from "node:crypto";
import { type } from "arktype";
import type {
  AnalyticsAction,
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
  type CaptureEvent,
  type ProfileOrigin,
} from "./model.ts";
import { analyticsStore } from "./storage.ts";
import type { CaptureTransport } from "./transport.ts";
import {
  incrementSummary,
  summaryOnDay,
  type SummaryCounts,
  type SummaryFailure,
  type SummaryOperation,
  type SummaryOutcome,
  type SummaryRecord,
} from "./summary.ts";

const IO_MS = 1500;
const QUIT_MS = 500;
const QUEUE_LIMIT = 8;
const ATTEMPTS = 3;

interface OperationGeneration {
  readonly consent: number;
  readonly dimensions: number;
}

interface PlaybackIntent {
  readonly control: string;
  readonly order: number;
  readonly kind: AnalyticsPlaybackKind;
  readonly frame: string;
  ended: boolean;
  remoteControl?: string | null;
}

interface AnalyticsOptions {
  readonly dataDir: string;
  readonly origin: Promise<ProfileOrigin>;
  readonly properties: BuildProperties;
  readonly transport: CaptureTransport | null;
  /** Replaces the persistence port for failure/deadline verification, not the owner. */
  readonly store?: ReturnType<typeof analyticsStore>;
  readonly playbackReset?: () => void;
  readonly monotonic?: () => number;
}

/** One profile's consent, identity, observation ledger, durable outbox and owned network work. */
export class Analytics {
  private readonly monotonic: () => number;
  private readonly playbackReset: (() => void) | undefined;
  private playbackTimer: ReturnType<typeof setInterval> | undefined;
  private intent: PlaybackIntent | null = null;
  private run: {
    token: string;
    kind: AnalyticsPlaybackKind;
    started: boolean;
    incident: boolean;
    eligible: boolean;
    remoteControl?: string | null;
    intent?: PlaybackIntent;
  } | null = null;
  private binding: {
    token: string;
    output: "local" | "remote";
    sequence: number;
  } | null = null;
  // One just-closed generation may report its terminal failure after synchronous teardown.
  private lastClosedBinding: string | null = null;
  private bindingClosed: { signal: AbortSignal; listener: () => void } | null = null;
  private interval: { wall: number; mono: number; until: number } | null = null;
  private readonly store: ReturnType<typeof analyticsStore>;
  private readonly transport: CaptureTransport | null;
  private properties: BuildProperties;
  private record: AnalyticsRecord | null = null;
  private serial: Promise<void>;
  private readonly initialized: Promise<void>;
  private available = true;
  private paused = false;
  private revision = 0;
  private dimensions = 0;
  private foreground = false;
  private closing = false;
  private stopped = false;
  private observationPending = false;
  private summary: SummaryRecord | undefined;
  private notesDirty = false;
  private checkpointPending = false;
  private checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  private dayTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private request: AbortController | undefined;
  private sending: Promise<void> | undefined;

  constructor(options: AnalyticsOptions) {
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.playbackReset = options.playbackReset;
    this.store = options.store ?? analyticsStore(options.dataDir);
    this.transport = options.transport;
    const properties = BuildProperties()(options.properties);
    // No raw values in errors or diagnostics, including invalid version strings.
    if (properties instanceof type.errors) throw new Error("Invalid analytics build properties.");
    this.properties = properties;
    this.serial = deadline(
      Promise.all([this.store.load(), options.origin]).then(([kept, origin]) => {
        this.record = kept ?? {
          format: 1,
          enabled: true,
          installationId: null,
          profileOrigin: origin,
          firstSeen: false,
          lastDay: null,
          pending: [],
        };
        this.summary = this.record.enabled && !this.paused ? this.record.summary : undefined;
      }),
      IO_MS,
    ).catch(() => this.unavailable());
    this.initialized = this.serial;
    if (this.transport) {
      this.playbackTimer = setInterval(() => this.settlePlayback(), 1000);
      this.playbackTimer.unref();
    }
  }

  /** The only renderer-readable state. Identity and pending payloads stay in the main process. */
  async settings(): Promise<AnalyticsSettings> {
    // Reading consent never waits behind capture/outbox writes or a network retry.
    await this.initialized;
    return {
      enabled: this.record?.enabled ?? false,
      transport: !this.available ? "unavailable" : (this.transport?.kind ?? "unconfigured"),
    };
  }

  /**
   * Pauses synchronously, before waiting for disk. Successful latest writes alone resume capture.
   * Re-enable keeps firstSeen and lastDay, so cleared observations are never recounted/backfilled.
   */
  configure(enabled: boolean): Promise<AnalyticsSettings> {
    this.settlePlayback();
    this.invalidatePlayback();
    this.paused = true;
    const revision = ++this.revision;
    if (!enabled) this.summary = undefined;
    this.notesDirty = false;
    this.clearCheckpoint();
    this.request?.abort();
    this.clearRetry();
    return this.exclusive(async () => {
      if (!this.available || !this.record || this.closing)
        throw new Error("Analytics preference could not be saved.");
      const { summary: _summary, ...kept } = this.record;
      await this.save({
        ...kept,
        enabled,
        pending: enabled ? kept.pending : [],
      });
      if (this.revision === revision) this.paused = !enabled;
    }).then(async () => {
      this.playbackReset?.();
      this.observe();
      this.pump();
      return this.settings();
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

  setUpdateChannel(channel: BuildProperties["update_channel"]): void {
    if (channel === this.properties.update_channel) return;
    this.settlePlayback();
    this.invalidatePlayback();
    this.properties = { ...this.properties, update_channel: channel };
    this.dimensions++;
    this.playbackReset?.();
    if (this.transport && this.summary && this.canCapture()) {
      this.summary = summaryOnDay(
        this.summary,
        new Date().toISOString().slice(0, 10),
        this.properties,
      );
      this.notesDirty = true;
      this.checkpoint();
    }
  }

  actionObserver(action: AnalyticsAction): () => void {
    const consent = this.revision,
      dimensions = this.dimensions;
    const enabled = this.canCapture();
    return () => {
      if (enabled && consent === this.revision && dimensions === this.dimensions)
        this.noteAction(action);
    };
  }

  settingObserver(setting: AnalyticsSetting): () => void {
    const consent = this.revision,
      dimensions = this.dimensions;
    const enabled = this.canCapture();
    return () => {
      if (enabled && consent === this.revision && dimensions === this.dimensions)
        this.noteSetting(setting);
    };
  }

  noteAction(action: AnalyticsAction): void {
    this.note((counts) => {
      counts.actions[action] = incrementSummary(counts, counts.actions[action]);
    });
  }

  noteSetting(setting: AnalyticsSetting): void {
    this.note((counts) => {
      counts.settings[setting] = incrementSummary(counts, counts.settings[setting]);
    });
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
      // Recollection after consent/dimension reset belongs to the current continuation.
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

  /** Logical intent is ephemeral. Opening media does not establish that it played. */
  beginPlayback(
    kind: AnalyticsPlaybackKind,
    ongoing = false,
    remoteControl?: string | null,
    intent?: PlaybackIntent,
  ): string | null {
    this.settlePlayback();
    this.invalidatePlayback();
    if (!this.transport || !this.canCapture() || this.closing) return null;
    const token = randomUUID();
    this.run = {
      token,
      kind,
      started: ongoing,
      incident: false,
      eligible: true,
      ...(remoteControl !== undefined ? { remoteControl } : {}),
      ...(intent ? { intent } : {}),
    };
    return token;
  }

  resumePlayback(kind: AnalyticsPlaybackKind): string | null {
    return this.run?.kind === kind ? this.run.token : null;
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
    this.clearBindingListener();
    if (closed?.aborted) return null;
    const binding = randomUUID();
    this.lastClosedBinding = null;
    this.binding = { token: binding, output, sequence: -1 };
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
    this.binding.sequence = sequence;
    if (state === "playing" && this.run.eligible) {
      if (!this.run.started) {
        const kind = this.run.kind;
        this.note((counts) => {
          counts.playback[kind].starts = incrementSummary(counts, counts.playback[kind].starts);
        });
        this.run.started = true;
      }
      this.run.incident = false;
      const mono = this.monotonic();
      this.interval = {
        wall: Date.now(),
        mono,
        until: mono + (this.binding.output === "local" ? 5000 : 15000),
      };
    } else this.interval = null;
  }

  setPlaybackEligible(token: string, eligible: boolean): void {
    if (this.run?.token !== token) return;
    this.settlePlayback();
    this.run.eligible = eligible;
    this.interval = null;
    // The producer must confirm playing again after promotion; eligibility alone proves no media.
  }

  notePlaybackFailure(token: string, binding: string | null, failure: SummaryFailure): void {
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
    this.run.incident = true;
    const kind = this.run.kind;
    this.note((counts) => {
      const measured = counts.playback[kind];
      measured.errors = incrementSummary(counts, measured.errors);
      measured.failures[failure] = incrementSummary(counts, measured.failures[failure]);
    });
  }

  endPlayback(token: string): void {
    if (this.run?.token !== token) return;
    this.settlePlayback();
    if (this.run.intent) this.run.intent.ended = true;
    this.invalidatePlayback();
  }

  stopPlaybackBinding(binding: string): void {
    if (this.binding?.token !== binding) return;
    this.settlePlayback();
    this.clearBindingListener();
    this.lastClosedBinding = binding;
    this.binding = null;
    this.interval = null;
  }

  rendererGone(): void {
    this.intent = null;
    if (this.binding?.output !== "remote") {
      this.settlePlayback();
      this.invalidatePlayback();
    }
  }

  suspendPlayback(): void {
    this.settlePlayback();
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
        // Consent/dimension changes require a fresh trusted observation, with no historical start.
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
      failure: (failure: SummaryFailure) => {
        if (active && token && binding) this.notePlaybackFailure(token, binding, failure);
      },
      stop: () => {
        active = false;
        if (binding) this.stopPlaybackBinding(binding);
      },
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

  /** Monotonic elapsed time is allocated before any bucket rotation, capped by confirmed leases. */
  private settlePlayback(): void {
    const interval = this.interval;
    if (!interval || !this.run || !this.canCapture() || this.closing) return;
    const mono = this.monotonic();
    const wall = Date.now();
    const elapsed = mono - interval.mono;
    // A clock jump has no trustworthy UTC allocation. A stalled owner cannot accrue past its lease.
    if (elapsed < 0 || Math.abs(wall - interval.wall - elapsed) > 2000) {
      this.interval = null;
      return;
    }
    const end = interval.wall + Math.max(0, Math.min(mono, interval.until) - interval.mono);
    let from = interval.wall;
    while (from < end) {
      const day = new Date(from).toISOString().slice(0, 10);
      const midnight = Date.parse(day) + 86_400_000;
      const through = Math.min(end, midnight);
      if (
        (!this.summary || day >= this.summary.day) &&
        (!this.record?.lastDay || day >= this.record.lastDay)
      ) {
        this.summary = summaryOnDay(this.summary, day, this.properties);
        const room = Math.max(
          0,
          86_400_000 - this.summary.watch_ms.live - this.summary.watch_ms.vod,
        );
        const added = Math.min(room, through - from);
        this.summary.watch_ms[this.run.kind] += added;
        if (added < through - from) this.summary.counts.saturated = true;
        this.notesDirty = true;
        this.checkpoint();
      }
      from = through;
    }
    this.interval = mono >= interval.until ? null : { wall, mono, until: interval.until };
  }

  noteFeature(feature: AnalyticsFeature): void {
    this.note((counts) => {
      counts.features[feature] = incrementSummary(counts, counts.features[feature]);
    });
  }

  /** A terminal result can count only in the enabled generation that observed its start. */
  playbackFailureObserver(control: string | undefined): (failure: SummaryFailure) => void {
    // Resolve a receiver alias now, then retain the exact run through asynchronous completion.
    const token =
      control && (this.run?.token === control || this.run?.remoteControl === control)
        ? this.run.token
        : null;
    return (failure) => {
      if (token) this.notePlaybackFailure(token, null, failure);
    };
  }

  /** A receiver load failed before Output could create its physical observation. */
  receiverLoadFailureObserver(
    control: string | undefined,
    frame: string | null,
  ): (failure: SummaryFailure) => void {
    const token = control ? this.controlledPlayback(control, frame) : null;
    return (failure) => {
      if (!token || !control || this.controlledPlayback(control, frame) !== token) return;
      // An earlier receiver load may still own the binding until this load takes its place.
      // The run's incident guard merges that failure with any later physical callback.
      const binding = this.binding;
      this.notePlaybackFailure(token, binding?.token ?? null, failure);
    };
  }

  noteOperationStarted(operation: SummaryOperation): OperationGeneration | null {
    if (!this.transport || !this.canCapture() || this.closing) return null;
    const observed = this.note((counts) => {
      const measured = counts[operation];
      measured.started = incrementSummary(counts, measured.started);
    });
    return observed ? { consent: this.revision, dimensions: this.dimensions } : null;
  }

  /** Outcomes describe the observed operation, never content, provider identity or raw failure. */
  noteOperationFinished(
    operation: SummaryOperation,
    generation: OperationGeneration | null,
    outcome: SummaryOutcome,
    failure: SummaryFailure = "app",
  ): void {
    if (
      !generation ||
      generation.consent !== this.revision ||
      generation.dimensions !== this.dimensions
    )
      return;
    this.note((counts) => {
      const measured = counts[operation];
      measured[outcome] = incrementSummary(counts, measured[outcome]);
      if (outcome === "failed")
        measured.failures[failure] = incrementSummary(counts, measured.failures[failure]);
    });
  }

  noteRenderer(event: keyof SummaryCounts["renderer"]): void {
    this.note((counts) => {
      counts.renderer[event] = incrementSummary(counts, counts.renderer[event]);
    });
  }

  /** Notes mutate fixed-size memory. At most one checkpoint is queued, regardless of UI rate. */
  private note(change: (counts: SummaryCounts) => void): boolean {
    if (!this.transport || !this.canCapture() || this.closing) return false;
    this.settlePlayback();
    const day = new Date().toISOString().slice(0, 10);
    if (
      (this.summary && day < this.summary.day) ||
      (this.record?.lastDay && day < this.record.lastDay)
    )
      return false;
    this.summary = summaryOnDay(this.summary, day, this.properties);
    change(this.summary.counts);
    this.notesDirty = true;
    this.checkpoint();
    return true;
  }

  private checkpoint(): void {
    if (
      this.checkpointTimer ||
      this.checkpointPending ||
      !this.notesDirty ||
      this.closing ||
      !this.canCapture()
    )
      return;
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = undefined;
      this.checkpointPending = true;
      const revision = this.revision;
      void this.exclusive(async () => {
        if (!this.canCapture() || revision !== this.revision || !this.record) return;
        if (this.notesDirty) await this.save(this.record);
      })
        .catch(() => {})
        .finally(() => {
          this.checkpointPending = false;
          this.checkpoint();
        });
    }, 1000);
    this.checkpointTimer.unref();
  }

  private clearCheckpoint(): void {
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
  }

  /** Bounds the total wait, including a hung disk/transport. No new observations during quit. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.settlePlayback();
    this.invalidatePlayback();
    if (this.playbackTimer) clearInterval(this.playbackTimer);
    this.closing = true;
    this.foreground = false;
    if (this.dayTimer) clearInterval(this.dayTimer);
    this.clearRetry();
    this.clearCheckpoint();
    try {
      await deadline(
        (async () => {
          await this.exclusive(async () => {
            if (this.canCapture() && this.record && this.notesDirty) await this.save(this.record);
          });
          // A retry backoff is skipped once at quit, within the same per-event attempt budget.
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

  /** One UTC activity observation per day. Clock rollback cannot reopen a previous day. */
  private observe(): void {
    if (this.observationPending || !this.foreground || this.closing || !this.transport) return;
    this.observationPending = true;
    void this.exclusive(async () => {
      if (!this.canCapture() || !this.foreground || this.closing || !this.record) return;
      this.settlePlayback();
      const timestamp = new Date().toISOString();
      const day = timestamp.slice(0, 10);
      if (this.record.lastDay !== null && day <= this.record.lastDay) return;
      const installationId = this.record.installationId ?? randomUUID();
      const properties = {
        ...this.properties,
        profile_origin: this.record.profileOrigin,
        $process_person_profile: false as const,
        $geoip_disable: true as const,
      };
      const pending = [...this.record.pending];
      if (!this.record.firstSeen) {
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
      let summary = this.summary && summaryOnDay(this.summary, day, this.properties);
      if (summary?.ready && (!summary.reportedDay || summary.ready.day > summary.reportedDay)) {
        pending.push({
          event: {
            uuid: randomUUID(),
            distinct_id: installationId,
            timestamp,
            event: "app_summary_day",
            properties: {
              ...properties,
              ...summary.ready.properties,
              summary_date: summary.ready.day,
              counts: summary.ready.counts,
            },
          },
          attempts: 0,
        });
        summary = { ...summary, reportedDay: summary.ready.day, ready: null };
      }
      this.summary = summary;
      // Preserve a pending first observation; discard the oldest day when offline too long.
      while (pending.length > QUEUE_LIMIT) {
        const oldestDay = pending.findIndex((item) => item.event.event !== "installation_observed");
        pending.splice(oldestDay, 1);
      }
      await this.save({
        ...this.record,
        installationId,
        firstSeen: true,
        lastDay: day,
        pending,
        ...(summary ? { summary } : {}),
      });
    })
      .catch(() => {})
      .finally(() => {
        this.observationPending = false;
        this.pump();
      });
  }

  /** The request is outside the disk serializer, so disabling needn't wait for its response. */
  private pump(): void {
    if (
      this.sending ||
      this.retryTimer ||
      !this.transport ||
      !this.canCapture() ||
      !this.record?.pending.some((item) => item.attempts < ATTEMPTS)
    )
      return;
    const revision = this.revision;
    let retry = false;
    this.sending = (async () => {
      let event: CaptureEvent | undefined;
      await this.exclusive(async () => {
        if (!this.canCapture() || this.revision !== revision || !this.record) return;
        const next = this.record.pending.find((item) => item.attempts < ATTEMPTS);
        if (!next) return;
        const pending = this.record.pending
          .filter((item) => item.attempts < ATTEMPTS)
          .map((item) =>
            item === next ? { event: item.event, attempts: item.attempts + 1 } : item,
          );
        await this.save({ ...this.record, pending });
        event = next.event;
      });
      if (!event || !this.canCapture() || this.revision !== revision || !this.transport) return;
      const sent = event;
      const controller = new AbortController();
      this.request = controller;
      let result;
      try {
        result = await deadline(this.transport.send(sent, controller.signal), 1100);
      } catch {
        controller.abort();
        result = "retry";
      }
      await this.exclusive(async () => {
        if (!this.canCapture() || this.revision !== revision || !this.record) return;
        const attempted = this.record.pending.find((item) => item.event.uuid === sent.uuid);
        retry = result === "retry" && !!attempted && attempted.attempts < ATTEMPTS;
        if (!retry) {
          await this.save({
            ...this.record,
            pending: this.record.pending.filter((item) => item.event.uuid !== sent.uuid),
          });
        }
      });
    })()
      .catch(() => {})
      .finally(() => {
        this.request = undefined;
        this.sending = undefined;
        if (!this.canCapture()) return;
        if (retry && !this.closing) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this.pump();
          }, 2000);
          this.retryTimer.unref();
        } else this.pump();
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
    const { summary: _summary, ...kept } = record;
    const snapshot: AnalyticsRecord = {
      ...kept,
      ...(record.enabled && this.summary ? { summary: structuredClone(this.summary) } : {}),
    };
    this.notesDirty = false;
    try {
      await deadline(this.store.save(snapshot), IO_MS);
      this.record = snapshot;
    } catch {
      this.unavailable();
      throw new Error("Analytics preference could not be saved.");
    }
  }

  private unavailable(): void {
    this.available = false;
    this.clearCheckpoint();
    this.paused = true;
    this.request?.abort();
    this.clearRetry();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
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
