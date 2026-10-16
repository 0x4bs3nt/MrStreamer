import { randomUUID } from "node:crypto";
import { type } from "arktype";
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
  type CaptureName,
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
  readonly event: CaptureName;
  readonly properties: object;
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

/** One profile's consent, identity, playback runs, durable outbox and owned network work. */
export class Analytics {
  private readonly monotonic: () => number;
  private readonly playbackReset: (() => void) | undefined;
  private intent: PlaybackIntent | null = null;
  private run: {
    token: string;
    kind: AnalyticsPlaybackKind;
    /** Playing was confirmed, here or before this run was minted for a continuation. */
    started: boolean;
    /** This run's stream_started was queued, so its end owes a stream_stopped. */
    reported: boolean;
    incident: boolean;
    eligible: boolean;
    watchMs: number;
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
  private interval: { mono: number; until: number } | null = null;
  private readonly store: ReturnType<typeof analyticsStore>;
  private readonly transport: CaptureTransport | null;
  private properties: BuildProperties;
  private record: AnalyticsRecord | null = null;
  private serial: Promise<void>;
  private readonly initialized: Promise<void>;
  private available = true;
  private paused = false;
  private revision = 0;
  private foreground = false;
  private closing = false;
  private stopped = false;
  private observationPending = false;
  private incoming: Unsent[] = [];
  private flushing = false;
  private rate = { start: -Infinity, count: 0 };
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
          format: 2,
          enabled: true,
          installationId: null,
          profileOrigin: origin,
          firstSeen: false,
          lastDay: null,
          pending: [],
        };
      }),
      IO_MS,
    ).catch(() => this.unavailable());
    this.initialized = this.serial;
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
   * Opting out drops the current run without a stop; one continuing across opt-in has no start.
   */
  configure(enabled: boolean): Promise<AnalyticsSettings> {
    if (!enabled) this.invalidatePlayback();
    this.paused = true;
    const revision = ++this.revision;
    this.incoming = [];
    this.request?.abort();
    this.clearRetry();
    return this.exclusive(async () => {
      if (!this.available || !this.record || this.closing)
        throw new Error("Analytics preference could not be saved.");
      await this.save({
        ...this.record,
        enabled,
        pending: enabled ? this.record.pending : [],
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

  /** Each capture carries the dimensions current when it is queued. */
  setUpdateChannel(channel: BuildProperties["update_channel"]): void {
    this.properties = { ...this.properties, update_channel: channel };
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
    this.capture(action, {});
  }

  noteSetting(setting: AnalyticsSetting): void {
    this.capture("settings_changed", { setting_key: setting });
  }

  noteFeature(feature: AnalyticsFeature): void {
    this.capture("feature_opened", { feature });
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
        this.run.started = true;
        this.run.reported = this.capture("stream_started", { stream_type: this.run.kind });
      }
      this.run.incident = false;
      const mono = this.monotonic();
      this.interval = { mono, until: mono + (this.binding.output === "local" ? 5000 : 15000) };
    } else this.interval = null;
  }

  setPlaybackEligible(token: string, eligible: boolean): void {
    if (this.run?.token !== token) return;
    this.settlePlayback();
    this.run.eligible = eligible;
    this.interval = null;
    // The producer must confirm playing again after promotion; eligibility alone proves no media.
  }

  notePlaybackFailure(token: string, binding: string | null, failure: AnalyticsFailure): void {
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
    this.capture("stream_error", { stream_type: this.run.kind, error_type: failure });
  }

  endPlayback(token: string): void {
    if (this.run?.token !== token) return;
    if (this.run.intent) this.run.intent.ended = true;
    this.finishRun();
  }

  stopPlaybackBinding(binding: string): void {
    if (this.binding?.token !== binding) return;
    this.settlePlayback();
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
      failure: (failure: AnalyticsFailure) => {
        if (active && token && binding) this.notePlaybackFailure(token, binding, failure);
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
  playbackFailureObserver(control: string | undefined): (failure: AnalyticsFailure) => void {
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
  ): (failure: AnalyticsFailure) => void {
    const token = control ? this.controlledPlayback(control, frame) : null;
    return (failure) => {
      if (!token || !control || this.controlledPlayback(control, frame) !== token) return;
      // An earlier receiver load may still own the binding until this load takes its place.
      // The run's incident guard merges that failure with any later physical callback.
      const binding = this.binding;
      this.notePlaybackFailure(token, binding?.token ?? null, failure);
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

  /** Ends the current run, reporting its active time once if its start was reported. */
  private finishRun(): void {
    const run = this.run;
    this.settlePlayback();
    this.invalidatePlayback();
    if (run?.reported)
      this.capture("stream_stopped", {
        stream_type: run.kind,
        watch_duration_seconds: Math.min(WATCH_SECONDS_LIMIT, Math.round(run.watchMs / 1000)),
      });
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
  }

  /**
   * Queues one event in memory and coalesces a burst into one outbox write. Returns whether it
   * was queued; consent, quit and the rate limit refuse it.
   */
  private capture<Name extends CaptureName>(
    event: Name,
    properties: EventProperties<Name>,
  ): boolean {
    if (!this.transport || !this.canCapture() || this.closing || !this.record) return false;
    const now = this.monotonic();
    if (now - this.rate.start >= 60_000) this.rate = { start: now, count: 0 };
    if (this.rate.count >= RATE_LIMIT) return false;
    this.rate.count++;
    this.incoming.push({
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      event,
      properties: {
        ...this.properties,
        profile_origin: this.record.profileOrigin,
        $process_person_profile: false,
        $geoip_disable: true,
        ...properties,
      },
    });
    if (!this.flushing) {
      this.flushing = true;
      void this.exclusive(async () => {
        this.flushing = false;
        const unsent = this.incoming.splice(0);
        const record = this.record;
        const id = record?.installationId;
        // An event before the first foreground observation has no identity to send under.
        if (!record || !id || unsent.length === 0 || !this.canCapture()) return;
        const queued = unsent.flatMap((item) => {
          const allowed = CaptureEvent()({ ...item, distinct_id: id });
          return allowed instanceof type.errors ? [] : [{ event: allowed, attempts: 0 }];
        });
        await this.save({ ...record, pending: bounded([...record.pending, ...queued]) });
      })
        .catch(() => {})
        .finally(() => this.pump());
    }
    return true;
  }

  /** Bounds the total wait, including a hung disk/transport. No new observations during quit. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.finishRun();
    this.closing = true;
    this.foreground = false;
    if (this.dayTimer) clearInterval(this.dayTimer);
    this.clearRetry();
    try {
      await deadline(
        (async () => {
          // The final stop and any burst reach the outbox first.
          await this.exclusive(async () => {});
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
      await this.save({
        ...this.record,
        installationId,
        firstSeen: true,
        lastDay: day,
        pending: bounded(pending),
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
    try {
      await deadline(this.store.save(record), IO_MS);
      this.record = record;
    } catch {
      this.unavailable();
      throw new Error("Analytics preference could not be saved.");
    }
  }

  private unavailable(): void {
    this.available = false;
    this.paused = true;
    this.incoming = [];
    this.request?.abort();
    this.clearRetry();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}

/** Keeps the newest events and the first observation when the outbox overflows. */
function bounded(pending: AnalyticsRecord["pending"]): AnalyticsRecord["pending"] {
  const kept = [...pending];
  while (kept.length > OUTBOX_LIMIT)
    kept.splice(
      kept.findIndex((item) => item.event.event !== "installation_observed"),
      1,
    );
  return kept;
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
