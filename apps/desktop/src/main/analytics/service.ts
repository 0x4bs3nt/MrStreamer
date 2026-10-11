import { randomUUID } from "node:crypto";
import { type } from "arktype";
import type { AnalyticsSettings } from "@mrstreamer/contracts/analytics";
import {
  AnalyticsRecord,
  BuildProperties,
  type CaptureEvent,
  type ProfileOrigin,
} from "./model.ts";
import { analyticsStore } from "./storage.ts";
import type { CaptureTransport } from "./transport.ts";

const IO_MS = 1500;
const QUIT_MS = 500;
const QUEUE_LIMIT = 8;
const ATTEMPTS = 3;

interface AnalyticsOptions {
  readonly dataDir: string;
  readonly origin: Promise<ProfileOrigin>;
  readonly properties: BuildProperties;
  readonly transport: CaptureTransport | null;
  /** Replaces the persistence port for failure/deadline verification, not the owner. */
  readonly store?: ReturnType<typeof analyticsStore>;
}

/** One profile's consent, identity, observation ledger, durable outbox and owned network work. */
export class Analytics {
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
  private dayTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private request: AbortController | undefined;
  private sending: Promise<void> | undefined;

  constructor(options: AnalyticsOptions) {
    this.store = options.store ?? analyticsStore(options.dataDir);
    this.transport = options.transport;
    const properties = BuildProperties(options.properties);
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
   */
  configure(enabled: boolean): Promise<AnalyticsSettings> {
    this.paused = true;
    const revision = ++this.revision;
    this.request?.abort();
    this.clearRetry();
    return this.exclusive(async () => {
      if (!this.available || !this.record || this.closing)
        throw new Error("Analytics preference could not be saved.");
      await this.save({ ...this.record, enabled, pending: enabled ? this.record.pending : [] });
      if (this.revision === revision) this.paused = !enabled;
    }).then(async () => {
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
    this.properties = { ...this.properties, update_channel: channel };
  }

  /** Bounds the total wait, including a hung disk/transport. No new observations during quit. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.foreground = false;
    if (this.dayTimer) clearInterval(this.dayTimer);
    this.clearRetry();
    try {
      await deadline(
        (async () => {
          await this.serial;
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
      // Preserve a pending first observation; discard the oldest day when offline too long.
      while (pending.length > QUEUE_LIMIT) {
        const oldestDay = pending.findIndex((item) => item.event.event === "app_active_day");
        pending.splice(oldestDay, 1);
      }
      await this.save({
        ...this.record,
        installationId,
        firstSeen: true,
        lastDay: day,
        pending,
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
