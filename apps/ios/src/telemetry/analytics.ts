import { type } from "arktype";
import type {
  AnalyticsFailure,
  AnalyticsPlaybackKind,
  AnalyticsSettings,
} from "@mrstreamer/contracts/analytics";
import { store, type Store } from "../store.ts";
import {
  ATTEMPTS,
  AnalyticsRecord,
  CaptureEvent,
  IosBuild,
  OUTBOX_LIMIT,
  WATCH_SECONDS_LIMIT,
  type CaptureName,
  type EventProperties,
  type IosAction,
  type IosFeature,
} from "./model.ts";
import type { CaptureTransport } from "./transport.ts";

/**
 * Whether statistics are on before the viewer chooses. Off while the app has no Settings control
 * for them: nothing is recorded or sent until a choice can be made and changed. Turning this on
 * belongs in the same change as that control, with the policy and docs that describe it.
 */
export const STATISTICS_DEFAULT = false;

/** Captures per minute. A viewer stays far below it; a runaway producer loses the rest. */
const RATE_LIMIT = 60;
/** How long a confirmed playing state counts without the clock moving on. */
const PLAYING_LEASE_MS = 5000;
/** How often a counted run's stop is saved, for a launch after iOS ended the app. */
const CHECKPOINT_MS = 60_000;

/** What plays, as telemetry needs it from the player's state. */
export interface PlaybackView {
  /** One viewer request, kept across Try again; null when nothing plays. */
  readonly run: object | null;
  readonly kind: AnalyticsPlaybackKind;
  /** The player confirmed playing: not loading, buffering, paused, failed or stopped. */
  readonly playing: boolean;
  /** Seen or heard: Watch, Picture in Picture, AirPlay, or a preview the viewer unmuted. */
  readonly watched: boolean;
  /** Plays on with the app in the background: Picture in Picture or AirPlay. */
  readonly background: boolean;
}

export interface AnalyticsPorts {
  /** `analytics.json`: null when there is none. Throws when it can't be written. */
  readonly store: { load(): unknown; save(record: AnalyticsRecord): void };
  readonly transport: CaptureTransport | null;
  readonly build: IosBuild;
  readonly monotonic: () => number;
  readonly uuid: () => string;
  readonly retryMs?: number;
}

interface Run {
  readonly identity: object;
  readonly kind: AnalyticsPlaybackKind;
  /** Playing was confirmed, or this run continues across a consent change and never reports. */
  started: boolean;
  /** Its stream_started was queued, so its end owes a stream_stopped. */
  reported: boolean;
  /** A failure was reported and the player hasn't confirmed playing since. */
  incident: boolean;
  watchMs: number;
  /** The stop's own UUID, so a stop saved for the next launch and the stop itself are one. */
  readonly stop: string;
  checkpoint: number;
}

const NOTHING: PlaybackView = {
  run: null,
  kind: "live",
  playing: false,
  watched: false,
  background: false,
};

/**
 * The iOS app's one statistics owner: the viewer's choice, the installation's random identity,
 * playback runs, the bounded outbox and the one request in flight. Producers report fixed
 * observations; only this owner builds events, and only while statistics are on.
 */
export class Analytics {
  /** The statistics state a Settings control shows. Identity and events never leave. */
  readonly settings: Store<AnalyticsSettings>;
  private readonly ports: AnalyticsPorts;
  private record: AnalyticsRecord | null = null;
  private available = true;
  private revision = 0;
  private foreground = false;
  private view = NOTHING;
  private run: Run | null = null;
  private interval: { mono: number; until: number } | null = null;
  private rate = { start: -Infinity, count: 0 };
  private request: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private dayTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ports: AnalyticsPorts) {
    this.ports = ports;
    try {
      this.record = loaded(ports.store.load());
    } catch {
      // Unreadable: nothing is captured until the viewer's next choice writes a new record.
      this.available = false;
    }
    this.settings = store(this.snapshot());
    // A stop saved before iOS ended the app last time is that run's end.
    const unfinished = this.record?.unfinished;
    if (this.record && unfinished) {
      this.save({
        ...this.record,
        unfinished: null,
        pending: bounded([...this.record.pending, queued(unfinished)]),
      });
    }
  }

  /**
   * The viewer's statistics choice. Off clears every unsent event and aborts the request in
   * flight; the identity and the days already seen stay, so nothing is counted twice. A run
   * playing across a change reports nothing more, and on sends nothing about the time off.
   */
  configure(enabled: boolean): AnalyticsSettings {
    if (this.available && this.record?.choice === (enabled ? "on" : "off")) {
      return this.settings.get();
    }
    this.revision++;
    this.abort();
    if (this.run) {
      this.settle();
      this.run.started = true;
      this.run.reported = false;
    }
    const record = this.record ?? fresh();
    this.available = true;
    this.save({
      ...record,
      choice: enabled ? "on" : "off",
      pending: enabled ? record.pending : [],
      unfinished: null,
    });
    this.settings.set(this.snapshot());
    this.observe();
    this.pump();
    return this.settings.get();
  }

  /** The app is active on screen. Inactive and background are not. */
  setForeground(active: boolean): void {
    if (active === this.foreground) return;
    this.settle();
    this.foreground = active;
    this.count();
    if (this.dayTimer) clearInterval(this.dayTimer);
    this.dayTimer = null;
    if (active) {
      this.observe();
      this.pump();
      this.dayTimer = setInterval(() => this.observe(), 60_000);
    } else this.checkpoint();
  }

  noteAction(action: IosAction): void {
    this.capture(action, {});
  }

  noteFeature(feature: IosFeature): void {
    this.capture("feature_opened", { feature });
  }

  /** The player's state changed. A different run ends the one before. */
  notePlayback(view: PlaybackView): void {
    this.settle();
    if (view.run !== this.run?.identity) {
      this.finishRun();
      if (view.run) {
        this.run = {
          identity: view.run,
          kind: view.kind,
          started: false,
          reported: false,
          incident: false,
          watchMs: 0,
          stop: this.ports.uuid(),
          checkpoint: this.ports.monotonic(),
        };
      }
    }
    this.view = view;
    this.count();
    // Only the player playing again ends an incident. The clock can't: it resets while a failed
    // stream is let go, before the player shows the failure.
    if (this.run && this.counting()) this.run.incident = false;
  }

  /** The playing position moved on, which renews a confirmed playing state. */
  notePlaybackClock(): void {
    if (!this.interval && !this.counting()) return;
    this.settle();
    this.count();
    const run = this.run;
    if (run?.reported && this.ports.monotonic() - run.checkpoint >= CHECKPOINT_MS) {
      this.checkpoint();
    }
  }

  /** The current run failed, before the player shows it. Once per incident, if it was seen. */
  notePlaybackFailure(failure: AnalyticsFailure): void {
    const run = this.run;
    if (!run || run.incident || !this.view.watched) return;
    run.incident = this.capture("stream_error", { stream_type: run.kind, error_type: failure });
  }

  private snapshot(): AnalyticsSettings {
    return {
      enabled: this.enabled(),
      transport: !this.available ? "unavailable" : (this.ports.transport?.kind ?? "unconfigured"),
    };
  }

  private enabled(): boolean {
    const choice = this.record?.choice ?? (STATISTICS_DEFAULT ? "on" : "off");
    return this.available && choice === "on";
  }

  private counting(): boolean {
    const { view } = this;
    return (
      this.run !== null && view.playing && view.watched && (this.foreground || view.background)
    );
  }

  /** Opens or closes the counted interval for the current state; a first one starts the run. */
  private count(): void {
    const run = this.run;
    if (!run || !this.counting()) {
      this.interval = null;
      return;
    }
    if (!run.started) {
      run.started = true;
      run.reported = this.capture("stream_started", { stream_type: run.kind });
    }
    const mono = this.ports.monotonic();
    this.interval = { mono, until: mono + PLAYING_LEASE_MS };
  }

  /**
   * Monotonic time since the last confirmed playing state, capped by its lease, so pauses,
   * buffering, a frozen app and a stalled player add nothing. Media positions are never used.
   */
  private settle(): void {
    const { interval, run } = this;
    if (!interval || !run) return;
    const mono = this.ports.monotonic();
    run.watchMs += Math.max(0, Math.min(mono, interval.until) - interval.mono);
    this.interval = mono >= interval.until ? null : { mono, until: interval.until };
  }

  private finishRun(): void {
    const run = this.run;
    this.run = null;
    this.interval = null;
    if (!run?.reported) return;
    this.capture("stream_stopped", this.stopOf(run), run.stop);
    if (this.record?.unfinished) this.save({ ...this.record, unfinished: null });
  }

  private stopOf(run: Run): EventProperties<"stream_stopped"> {
    return {
      stream_type: run.kind,
      watch_duration_seconds: Math.min(WATCH_SECONDS_LIMIT, Math.round(run.watchMs / 1000)),
    };
  }

  /** Saves the current run's stop as it stands, for the next launch if this one is ended. */
  private checkpoint(): void {
    const { run, record } = this;
    if (!run?.reported || !record || !this.enabled()) return;
    this.settle();
    const event = this.event("stream_stopped", this.stopOf(run), run.stop);
    if (!event) return;
    run.checkpoint = this.ports.monotonic();
    this.save({ ...record, unfinished: event });
  }

  /** One UTC activity observation per day; the first one also observes the installation. */
  private observe(): void {
    const record = this.record;
    if (!record || !this.foreground || !this.enabled() || !this.ports.transport) return;
    const timestamp = new Date().toISOString();
    const day = timestamp.slice(0, 10);
    if (record.lastDay !== null && day <= record.lastDay) return;
    const installationId = record.installationId ?? this.ports.uuid();
    const common = this.common();
    const observed: CaptureEvent[] = [
      ...(record.installationId === null
        ? [
            {
              uuid: this.ports.uuid(),
              distinct_id: installationId,
              timestamp,
              event: "installation_observed" as const,
              properties: common,
            },
          ]
        : []),
      {
        uuid: this.ports.uuid(),
        distinct_id: installationId,
        timestamp,
        event: "app_active_day",
        properties: { ...common, activity_date: day },
      },
    ];
    this.save({
      ...record,
      installationId,
      lastDay: day,
      pending: bounded([...record.pending, ...observed.map(queued)]),
    });
    this.pump();
  }

  private common() {
    return { ...this.ports.build, $process_person_profile: false, $geoip_disable: true } as const;
  }

  private event<Name extends CaptureName>(
    name: Name,
    properties: EventProperties<Name>,
    uuid = this.ports.uuid(),
  ): CaptureEvent | null {
    const installationId = this.record?.installationId;
    if (!installationId) return null;
    const event = CaptureEvent()({
      uuid,
      distinct_id: installationId,
      timestamp: new Date().toISOString(),
      event: name,
      properties: { ...this.common(), ...properties },
    });
    return event instanceof type.errors ? null : event;
  }

  /** Queues one event; false when statistics are off, unconfigured, unidentified or limited. */
  private capture<Name extends CaptureName>(
    name: Name,
    properties: EventProperties<Name>,
    uuid?: string,
  ): boolean {
    const record = this.record;
    if (!record || !this.enabled() || !this.ports.transport) return false;
    const event = this.event(name, properties, uuid);
    if (!event) return false;
    const now = this.ports.monotonic();
    if (now - this.rate.start >= 60_000) this.rate = { start: now, count: 0 };
    if (this.rate.count >= RATE_LIMIT) return false;
    this.rate.count++;
    if (!this.save({ ...record, pending: bounded([...record.pending, queued(event)]) })) {
      return false;
    }
    this.pump();
    return true;
  }

  /** Sends the oldest event, one request at a time, each at most three times across launches. */
  private pump(): void {
    const transport = this.ports.transport;
    const record = this.record;
    const next = record?.pending[0];
    if (!transport || !record || !next || this.request || this.retryTimer || !this.enabled())
      return;
    const revision = this.revision;
    const attempts = next.attempts + 1;
    // An attempt that can't be saved isn't made: a later launch couldn't tell it was.
    const saved = this.save({
      ...record,
      pending: record.pending.map((item) => (item === next ? { ...item, attempts } : item)),
    });
    if (!saved) return;
    const request = new AbortController();
    this.request = request;
    void transport
      .send(next.event, request.signal)
      .catch(() => "retry" as const)
      .then((result) => {
        if (this.request === request) this.request = null;
        if (revision !== this.revision || !this.record || !this.enabled()) return;
        const retry = result === "retry" && attempts < ATTEMPTS;
        if (!retry) {
          this.save({
            ...this.record,
            pending: this.record.pending.filter((item) => item.event.uuid !== next.event.uuid),
          });
          this.pump();
          return;
        }
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.pump();
        }, this.ports.retryMs ?? 10_000);
      });
  }

  /** A write that fails stops capture for this launch; the app goes on without statistics. */
  private save(record: AnalyticsRecord): boolean {
    try {
      this.ports.store.save(record);
      this.record = record;
      return true;
    } catch {
      this.available = false;
      this.abort();
      this.settings.set(this.snapshot());
      return false;
    }
  }

  /** Drops the request in flight and any retry waiting; their results change nothing. */
  private abort(): void {
    this.request?.abort();
    this.request = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

function fresh(): AnalyticsRecord {
  return {
    format: 1,
    choice: null,
    installationId: null,
    lastDay: null,
    pending: [],
    unfinished: null,
  };
}

/** The saved record, or a fresh one when there is none. Throws, quoting nothing, when invalid. */
function loaded(saved: unknown): AnalyticsRecord {
  if (saved === null) return fresh();
  const record = AnalyticsRecord()(saved);
  if (record instanceof type.errors) throw new Error("Analytics state unavailable.");
  const on = (record.choice ?? (STATISTICS_DEFAULT ? "on" : "off")) === "on";
  if (
    (record.installationId === null) !== (record.lastDay === null) ||
    (!on && (record.pending.length > 0 || record.unfinished !== null)) ||
    [...record.pending.map((item) => item.event), record.unfinished].some(
      (event) => event !== null && event.distinct_id !== record.installationId,
    ) ||
    (record.unfinished !== null && record.unfinished.event !== "stream_stopped")
  )
    throw new Error("Analytics state unavailable.");
  // An event whose attempts ran out while the app was ended mid-request goes no further.
  return { ...record, pending: record.pending.filter((item) => item.attempts < ATTEMPTS) };
}

function queued(event: CaptureEvent): AnalyticsRecord["pending"][number] {
  return { event, attempts: 0 };
}

/** Keeps the newest events and a pending first observation when the outbox overflows. */
function bounded(pending: AnalyticsRecord["pending"]): AnalyticsRecord["pending"] {
  const kept = [...pending];
  while (kept.length > OUTBOX_LIMIT) {
    const oldest = kept.findIndex((item) => item.event.event !== "installation_observed");
    kept.splice(oldest, 1);
  }
  return kept;
}
