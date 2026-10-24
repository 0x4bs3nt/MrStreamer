import { GUIDE_DAY_MS, type Listing, type Programme } from "@mrstreamer/contracts/guide";
import {
  GuideFault,
  ingest,
  nativeGuide,
  type Activation,
  type Generation,
  type GuideNative,
  type GuideProblem,
  type Query,
} from "./guide-native.ts";
import type { Part } from "./library.ts";
import { currentSource, type Source } from "./sources.ts";
import { store } from "./store.ts";

export interface GuideStatus {
  readonly availability: "unknown" | "none" | "available";
  readonly activity: "idle" | "loading";
  readonly fetchedAt: number | null;
  readonly stale: boolean;
  readonly error: GuideProblem | null;
}
export interface Day {
  readonly from: number;
  readonly until: number;
}
export interface ScheduleItem extends Omit<Programme, "description"> {
  readonly detail: string;
}
export interface DayPage {
  readonly programmes: readonly ScheduleItem[];
  readonly cursor: string | null;
}
interface Entry {
  activation: Activation;
  readonly source: Source | undefined;
  part?: Part;
  generation: Generation | null;
  failedAt: number;
  refresh?: Promise<void>;
  readonly jobs: Set<string>;
}
interface Token {
  readonly entry: Entry;
  readonly part: Part;
  readonly generation: Generation;
  readonly ids: readonly string[];
  readonly key: string;
  readonly start: number;
  readonly day?: Day;
}
const FRESH = 6 * 3600_000;
const MAX_AGE = 7 * 86400_000;
const EMPTY: GuideStatus = {
  availability: "unknown",
  activity: "idle",
  fetchedAt: null,
  stale: true,
  error: null,
};

/** Sole JS owner. Account supplies lifecycle and Parts; screens only read this service. */
export function createGuide(
  port: () => GuideNative = nativeGuide,
  now: () => number = Date.now,
  sourceOf = currentSource,
) {
  const entries = new Map<string, Entry>();
  const parts = new Map<string, Part>();
  const state = store<ReadonlyMap<string, GuideStatus>>(new Map());
  const tokens = new Map<string, Token>();
  const versions = new Map<string, number>();
  let sequence = 0;
  let era = 0;
  let foreground = true;
  let listeners = 0;
  let clock: ReturnType<typeof setInterval> | undefined;
  let lifecycle: readonly { remove(): void }[] = [];
  const id = () => `g${++sequence}`;
  const cancel = async (job: string) => {
    try {
      await port().cancel(job);
    } catch {
      /* A missing binding cannot have an active local job. */
    }
  };
  const stands = (key: string, entry: Entry) =>
    entries.get(key) === entry && sourceOf(key) === entry.source;
  const usable = (g: Generation | null) =>
    g !== null &&
    g.until > now() &&
    now() - g.fetchedAt <= MAX_AGE &&
    g.fetchedAt - now() <= 600_000;
  const status = (key: string) => state.get().get(key) ?? EMPTY;
  const update = (key: string, change: Partial<GuideStatus> = {}) => {
    const g = entries.get(key)?.generation ?? null;
    state.set(
      new Map(state.get()).set(key, {
        ...status(key),
        fetchedAt: g?.fetchedAt ?? null,
        stale: !usable(g) || (g !== null && now() - g.fetchedAt >= FRESH),
        ...change,
      }),
    );
  };
  const invalidate = (entry: Entry) => {
    for (const [key, value] of tokens) if (value.entry === entry) tokens.delete(key);
  };
  const token = (value: Token) => {
    if (tokens.size >= 1024) tokens.delete(tokens.keys().next().value ?? "");
    const key = id();
    tokens.set(key, value);
    return key;
  };
  const validToken = (value: Token) =>
    [...entries.values()].includes(value.entry) &&
    value.entry.part === value.part &&
    value.entry.generation === value.generation &&
    usable(value.generation) &&
    sourceOf(value.part.subscriptionId) === value.entry.source;
  const cancelEntry = (entry: Entry) => {
    if (entry.refresh) entry.failedAt = now();
    invalidate(entry);
    for (const job of entry.jobs) void cancel(job);
  };
  const connect = () => {
    if (lifecycle.length) return;
    const native = port();
    if (native.addListener)
      lifecycle = [
        native.addListener("foreground", () => service.foreground()),
        native.addListener("background", () => service.background()),
      ];
  };
  async function refresh(key: string, explicit = true): Promise<void> {
    const entry = entries.get(key);
    if (!entry || !entry.source || !stands(key, entry) || !foreground) return;
    if (entry.refresh) return entry.refresh;
    if (!explicit && now() - entry.failedAt < 15 * 60_000) return;
    const source = entry.source;
    const job = id();
    entry.jobs.add(job);
    entry.refresh = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let expired = false;
      try {
        const native = port();
        native.begin(entry.activation.lease, job);
        const controller = new AbortController();
        timer = setTimeout(() => {
          expired = true;
          entry.failedAt = now();
          if (stands(key, entry) && foreground) update(key, { error: "time" });
          controller.abort();
          void cancel(job);
        }, 180_000);
        const wanted = () => !expired && foreground && stands(key, entry);
        update(key, { activity: "loading", error: null });
        if (!source.provider.liveGuideRequest) throw new GuideFault("unavailable");
        const request = await source.provider.liveGuideRequest(controller.signal);
        if (!wanted()) return;
        if (request.kind === "none") {
          // Only an authoritative provider answer clears availability.
          native.revoke(key);
          if (!(await native.forget(key))) throw new GuideFault("disk");
          if (!stands(key, entry)) return;
          entry.activation = await native.attach(key, source.revision);
          entry.generation = null;
          invalidate(entry);
          update(key, { availability: "none" });
          return;
        }
        const result = await ingest(
          native,
          entry.activation.lease,
          job,
          request,
          source.login,
          now(),
          wanted,
        );
        if (!wanted()) return;
        if (result.kind === "failed") throw new GuideFault(result.error);
        if (result.kind === "cancelled") entry.failedAt = now();
        if (result.kind === "ok") {
          entry.generation = result.value;
          invalidate(entry);
          update(key, { availability: "available", error: null });
        }
      } catch (cause) {
        if (stands(key, entry) && foreground) {
          entry.failedAt = now();
          update(key, {
            error: expired ? "time" : cause instanceof GuideFault ? cause.problem : "network",
          });
        }
      } finally {
        clearTimeout(timer);
        await cancel(job);
        entry.jobs.delete(job);
        delete entry.refresh;
        if (stands(key, entry)) update(key, { activity: "idle" });
      }
    })();
    return entry.refresh;
  }
  const capture = (key: string): Token | null => {
    const colon = key.indexOf(":");
    if (colon < 1) return null;
    const owned = { subscriptionId: key.slice(0, colon), id: key.slice(colon + 1) };
    const entry = entries.get(owned.subscriptionId);
    const part = entry?.part;
    const channel = part?.byId.get(owned.id);
    if (
      !entry ||
      !part ||
      !channel ||
      !stands(owned.subscriptionId, entry) ||
      !usable(entry.generation) ||
      !entry.generation
    )
      return null;
    return {
      entry,
      part,
      generation: entry.generation,
      ids: part.guideIds.get(channel.id) ?? [],
      key: channel.key,
      start: -1,
    };
  };
  async function query(
    value: Token,
    mode: "listing" | "day" | "detail",
    day: Day,
    signal?: AbortSignal,
  ): Promise<Query | null> {
    if (signal?.aborted || !validToken(value)) return null;
    const native = port();
    const job = id();
    value.entry.jobs.add(job);
    native.begin(value.entry.activation.lease, job);
    const cancel = () => {
      void native.cancel(job);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    let expired = false;
    const timeout = setTimeout(() => {
      expired = true;
      cancel();
    }, 2000);
    try {
      const result = await native.query(
        value.entry.activation.lease,
        value.generation.id,
        job,
        value.ids,
        now(),
        mode,
        day.from,
        day.until,
        value.start,
      );
      return !expired && !signal?.aborted && validToken(value) && result.kind === "ok"
        ? result.value
        : null;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      await native.cancel(job);
      value.entry.jobs.delete(job);
    }
  }
  const tick = () => {
    for (const key of entries.keys()) {
      update(key);
      if (status(key).stale) void refresh(key, false);
    }
  };
  const service = {
    status,
    subscribe(listener: () => void) {
      const stop = state.subscribe(listener);
      listeners++;
      if (listeners === 1 && foreground) clock = setInterval(tick, 60_000);
      return () => {
        stop();
        if (--listeners === 0) {
          clearInterval(clock);
          clock = undefined;
        }
      };
    },
    async restore(ids: readonly string[]) {
      const cycle = ++era;
      for (const entry of entries.values()) cancelEntry(entry);
      entries.clear();
      tokens.clear();
      try {
        connect();
        const restored = await port().restore(ids);
        if (cycle !== era) return;
        for (const value of restored) {
          if (!ids.includes(value.subscriptionId)) continue;
          const entry: Entry = {
            activation: value.activation,
            source: undefined,
            generation: value.activation.generation,
            failedAt: -Infinity,
            jobs: new Set(),
          };
          entries.set(value.subscriptionId, entry);
          const part = parts.get(value.subscriptionId);
          if (part) entry.part = part;
          update(value.subscriptionId, {
            availability: usable(entry.generation) ? "available" : "unknown",
            activity: "idle",
            error: null,
          });
        }
      } catch {
        for (const key of ids) update(key, { error: "unavailable" });
      }
    },
    async attach(key: string) {
      const source = sourceOf(key);
      const cycle = era;
      if (!source) return;
      const before = entries.get(key);
      if (before?.source === source) return;
      if (before) {
        entries.delete(key);
        cancelEntry(before);
      }
      const version = (versions.get(key) ?? 0) + 1;
      versions.set(key, version);
      try {
        connect();
        const activation = await port().attach(key, source.revision);
        if (sourceOf(key) !== source || versions.get(key) !== version || cycle !== era) return;
        const entry: Entry = {
          activation,
          source,
          generation: activation.generation,
          failedAt: -Infinity,
          jobs: new Set(),
        };
        const part = parts.get(key);
        if (part) entry.part = part;
        entries.set(key, entry);
        update(key, {
          availability: usable(entry.generation) ? "available" : "unknown",
          activity: "idle",
          error: null,
        });
        if (status(key).stale) void refresh(key, false);
      } catch {
        if (sourceOf(key) === source) update(key, { error: "unavailable" });
      }
    },
    setPart(part: Part) {
      parts.set(part.subscriptionId, part);
      const entry = entries.get(part.subscriptionId);
      if (entry) {
        invalidate(entry);
        entry.part = part;
      }
    },
    async forget(key: string): Promise<boolean> {
      versions.set(key, (versions.get(key) ?? 0) + 1);
      const entry = entries.get(key);
      entries.delete(key);
      parts.delete(key);
      state.set(new Map([...state.get()].filter(([id]) => id !== key)));
      try {
        port().revoke(key);
        if (entry) cancelEntry(entry);
        return await port().forget(key);
      } catch {
        return false;
      }
    },
    refresh,
    foreground() {
      foreground = true;
      if (listeners && !clock) clock = setInterval(tick, 60_000);
      tick();
    },
    background() {
      foreground = false;
      clearInterval(clock);
      clock = undefined;
      for (const entry of entries.values()) cancelEntry(entry);
    },
    async listings(
      keys: readonly string[],
      options?: { readonly signal?: AbortSignal },
    ): Promise<ReadonlyMap<string, Listing>> {
      if (keys.length > 40) throw new GuideFault("reply");
      const result = new Map<string, Listing>();
      // At most two native reads in flight; every result binds the current catalogue and generation.
      for (let offset = 0; offset < keys.length; offset += 2)
        await Promise.all(
          keys.slice(offset, offset + 2).map(async (key) => {
            const captured = capture(key);
            const answer = captured
              ? await query(captured, "listing", { from: 0, until: 0 }, options?.signal)
              : null;
            const at = now();
            result.set(key, {
              now: answer?.rows.find((row) => row.start <= at && row.stop > at) ?? null,
              next: answer?.rows.find((row) => row.start > at) ?? null,
            });
          }),
        );
      return result;
    },
    async schedule(
      key: string,
      day: Day,
      cursor?: string,
      options?: { readonly signal?: AbortSignal },
    ): Promise<DayPage> {
      if (
        !Number.isFinite(day.from) ||
        !Number.isFinite(day.until) ||
        day.until <= day.from ||
        day.until - day.from > GUIDE_DAY_MS
      )
        throw new GuideFault("time");
      const midnight = new Date(day.from);
      const tomorrow = new Date(midnight);
      tomorrow.setDate(tomorrow.getDate() + 1);
      if (
        midnight.getHours() ||
        midnight.getMinutes() ||
        midnight.getSeconds() ||
        midnight.getMilliseconds() ||
        tomorrow.getTime() !== day.until
      )
        throw new GuideFault("time");
      const captured = cursor ? tokens.get(cursor) : capture(key);
      if (
        !captured ||
        !validToken(captured) ||
        (cursor &&
          (captured.day?.from !== day.from ||
            captured.day.until !== day.until ||
            capture(key)?.key !== captured.key))
      )
        return { programmes: [], cursor: null };
      const answer = await query(captured, "day", day, options?.signal);
      if (!answer?.guideId) return { programmes: [], cursor: null };
      const ids = [answer.guideId];
      const programmes = answer.rows.map(({ start, stop, title }) => ({
        start,
        stop,
        title,
        detail: token({ ...captured, ids, start }),
      }));
      const last = programmes.at(-1);
      return {
        programmes,
        cursor: answer.more && last ? token({ ...captured, ids, start: last.start, day }) : null,
      };
    },
    async programme(
      detail: string,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Programme | null> {
      const captured = tokens.get(detail);
      if (!captured || !validToken(captured)) return null;
      return (
        (await query(captured, "detail", { from: 0, until: 0 }, options?.signal))?.rows[0] ?? null
      );
    },
  };
  return service;
}

export const guide = createGuide();
