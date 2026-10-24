import { describe, expect, it, vi } from "vitest";
import { xtreamProvider } from "@mrstreamer/core/xtream";
import { finish } from "@mrstreamer/core/steps";
import { createGuide } from "../src/guide.ts";
import { ingest, type GuideNative } from "../src/guide-native.ts";
import { partSteps } from "../src/library.ts";
import type { Source } from "../src/sources.ts";
import { guideFixture } from "./native-guide.ts";

const at = Date.now();
const part = (subscriptionId = "a") =>
  finish(
    partSteps({
      subscriptionId,
      catalogue: {
        categories: [],
        channels: [
          {
            id: "1",
            name: "News HD",
            number: null,
            logoUrl: null,
            categoryIds: [],
            guideId: "trusted.tv",
            catchupDays: null,
          },
          {
            id: "2",
            name: "News FHD",
            number: null,
            logoUrl: null,
            categoryIds: [],
            guideId: "trusted TV",
            catchupDays: null,
          },
          {
            id: "3",
            name: "Hidden",
            number: null,
            logoUrl: null,
            categoryIds: [],
            guideId: "adult",
            adult: true,
            catchupDays: null,
          },
        ],
      },
    }),
  );
const source: Source = {
  revision: 1,
  login: ["fixture", "canary"],
  provider: xtreamProvider(
    { server: "https://fixture.test", username: "fixture", password: "canary" },
    { userAgent: "fixture" },
  ),
};
const programme = { start: at - 60000, stop: at + 60000, title: "News", description: "Details" };
const empty = { programmes: [], cursor: null };
function setup() {
  const { native, control } = guideFixture();
  const sources = new Map<string, Source>();
  const owner = createGuide(
    () => native,
    () => at,
    (id) => sources.get(id),
  );
  control.activations.set("a", {
    lease: "offline",
    generation: { id: "db", fetchedAt: at, until: at + 86400_000 },
  });
  return { owner, native, control, sources };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("guide public owner", () => {
  it("retains only canonical trusted IDs after adult filtering, including variant aliases", () => {
    const value = part();
    expect(value.channels).toHaveLength(1);
    const first = value.channels[0]!;
    expect(value.byId.get("2")).toBe(first);
    expect(value.guideIds.get(first.id)).toEqual(["trusted.tv", "trusted TV"]);
    expect([...value.guideIds.values()].flat()).not.toContain("adult");
  });
  it("restores an authorized cache without a secret and never makes a network request", async () => {
    const { owner, control } = setup();
    await owner.restore(["a"]);
    owner.setPart(part());
    control.query = async () => ({
      kind: "ok",
      value: { guideId: "trusted.tv", rows: [programme], more: false },
    });
    expect((await owner.listings(["a:2"])).get("a:2")?.now).toEqual(programme);
    await owner.refresh("a");
    expect(control.calls.filter((call) => call.startsWith("begin:"))).toHaveLength(1);
    expect(owner.status("a").availability).toBe("available");
    expect((await owner.listings(["b:2"])).get("b:2")).toEqual({ now: null, next: null });
  });
  it("drops late queries after catalogue changes and after removal, with immediate revocation", async () => {
    const { owner, control } = setup();
    await owner.restore(["a"]);
    owner.setPart(part());
    const held = deferred<Awaited<ReturnType<GuideNative["query"]>>>();
    control.query = () => held.promise;
    const read = owner.listings(["a:2"]);
    owner.setPart(part());
    held.resolve({ kind: "ok", value: { guideId: "trusted.tv", rows: [programme], more: false } });
    expect((await read).get("a:2")?.now).toBeNull();
    const erase = deferred<boolean>();
    control.forget = () => erase.promise;
    const removing = owner.forget("a");
    expect(control.calls).toContain("revoke:a");
    expect((await owner.listings(["a:1"])).get("a:1")?.now).toBeNull();
    erase.resolve(false);
    expect(await removing).toBe(false);
  });
  it("coalesces refresh and preserves last-good status after a typed failure", async () => {
    const { owner, control, sources } = setup();
    await owner.restore(["a"]);
    sources.set("a", source);
    await owner.attach("a");
    owner.setPart(part());
    const held = deferred<Awaited<ReturnType<GuideNative["prepare"]>>>();
    let calls = 0;
    control.prepare = () => {
      calls++;
      return held.promise;
    };
    const first = owner.refresh("a"),
      second = owner.refresh("a");
    await Promise.resolve();
    expect(calls).toBe(1);
    held.resolve({ kind: "failed", error: "gzip" });
    await Promise.all([first, second]);
    expect(owner.status("a")).toMatchObject({
      availability: "available",
      activity: "idle",
      error: "gzip",
    });
  });
  it("binds day/detail tokens to channel, generation and current catalogue", async () => {
    const { owner, control } = setup();
    await owner.restore(["a"]);
    owner.setPart(part());
    const from = new Date(at);
    from.setHours(0, 0, 0, 0);
    const until = new Date(from);
    until.setDate(until.getDate() + 1);
    const day = { from: from.getTime(), until: until.getTime() };
    control.query = async () => ({
      kind: "ok",
      value: { guideId: "trusted TV", rows: [programme], more: false },
    });
    const page = await owner.schedule("a:2", day);
    const detail = page.programmes[0]!.detail;
    expect(await owner.programme(detail)).toEqual(programme);
    owner.setPart(part());
    expect(await owner.programme(detail)).toBeNull();
    await expect(
      owner.schedule("a:1", { from: day.from, until: day.from + 27 * 3600_000 }),
    ).rejects.toMatchObject({ problem: "time" });
    expect(await owner.schedule("a:1", day, "invented")).toEqual(empty);
  });
  it("reads the local calendar day when midnight is skipped", async () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/Santiago";
    try {
      const when = new Date(2026, 8, 6, 12).getTime();
      const from = new Date(2026, 8, 6);
      const until = new Date(2026, 8, 7);
      expect(from.getHours()).toBe(1);
      expect(until.getTime() - from.getTime()).toBe(23 * 3600_000);
      const { native, control } = guideFixture();
      control.activations.set("a", {
        lease: "midnight",
        generation: { id: "day", fetchedAt: when, until: until.getTime() },
      });
      const owner = createGuide(
        () => native,
        () => when,
        () => undefined,
      );
      await owner.restore(["a"]);
      owner.setPart(part());
      control.query = async () => ({
        kind: "ok",
        value: {
          guideId: "trusted.tv",
          rows: [{ ...programme, start: when - 60000, stop: when + 60000 }],
          more: false,
        },
      });
      const day = { from: from.getTime(), until: until.getTime() };
      expect((await owner.schedule("a:1", day)).programmes).toHaveLength(1);
      await expect(owner.schedule("a:1", { ...day, from: day.from + 1 })).rejects.toMatchObject({
        problem: "time",
      });
      await expect(
        owner.schedule("a:1", { ...day, until: day.until + 3600_000 }),
      ).rejects.toMatchObject({ problem: "time" });
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
  it("cancels quietly on background and never accepts a replaced source's late generation", async () => {
    const { owner, control, sources } = setup();
    await owner.restore(["a"]);
    sources.set("a", source);
    await owner.attach("a");
    const held = deferred<Awaited<ReturnType<GuideNative["prepare"]>>>();
    control.prepare = () => held.promise;
    const loading = owner.refresh("a");
    await Promise.resolve();
    owner.background();
    sources.set("a", { ...source, revision: 2 });
    held.resolve({ kind: "ok", value: { kind: "candidate", id: "late" } });
    await loading;
    expect(owner.status("a").error).toBeNull();
    expect(control.cancelled.size).toBeGreaterThan(0);
  });
  it("reports a whole-job deadline and backs off without an automatic retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    try {
      const { native, control } = guideFixture();
      const held = deferred<Awaited<ReturnType<GuideNative["prepare"]>>>();
      let prepares = 0;
      control.prepare = () => {
        prepares++;
        return held.promise;
      };
      const owner = createGuide(
        () => native,
        Date.now,
        () => source,
      );
      await owner.attach("a");
      const refreshing = owner.refresh("a");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(180000);
      expect(owner.status("a").error).toBe("time");
      held.resolve({ kind: "cancelled" });
      await refreshing;
      owner.foreground();
      expect(prepares).toBe(1);
      expect(owner.status("a")).toMatchObject({ activity: "idle", error: "time" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports missing binding as unavailable, with no fake success", async () => {
    const owner = createGuide(() => {
      throw new Error("missing");
    });
    await owner.restore(["a"]);
    expect(owner.status("a").error).toBe("unavailable");
    expect(await owner.forget("a")).toBe(false);
  });
  it("uses a minute foreground clock only while subscribed and never fast-retries a failure", async () => {
    vi.useFakeTimers();
    try {
      const { owner, control } = setup();
      await owner.restore(["a"]);
      const notify = vi.fn();
      const stop = owner.subscribe(notify);
      await vi.advanceTimersByTimeAsync(59999);
      expect(notify).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(notify).toHaveBeenCalledTimes(1);
      owner.background();
      await vi.advanceTimersByTimeAsync(120000);
      expect(notify).toHaveBeenCalledTimes(1);
      stop();
      expect(control.calls).toEqual(["restore:a"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("native transport adapter", () => {
  it("keeps yesterday's full calendar day when today's midnight is skipped", async () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/Santiago";
    try {
      const when = new Date(2026, 8, 6, 12).getTime();
      const { native } = guideFixture();
      const prepare = vi.spyOn(native, "prepare");
      await ingest(
        native,
        "lease",
        "job",
        { kind: "request", url: "https://fixture.test/guide", headers: {} },
        [],
        when,
        () => true,
      );
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(prepare.mock.calls[0]?.[6]).toBe(new Date(2026, 8, 5).getTime());
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
  it("validates each closed hop with original credentials and stops unsafe downgrade", async () => {
    const { native } = guideFixture();
    const urls: string[] = [];
    native.prepare = async (_lease, _job, url) => {
      urls.push(url);
      return {
        kind: "ok",
        value: {
          kind: "redirect",
          location:
            urls.length === 1
              ? "http://fixture.test/?token=safe"
              : "http://fixture.test/?password=canary",
        },
      };
    };
    const result = await ingest(
      native,
      "l",
      "job",
      { kind: "request", url: "https://fixture.test/guide", headers: {} },
      source.login,
      at,
      () => true,
    );
    expect(result).toEqual({ kind: "failed", error: "redirect" });
    expect(urls).toHaveLength(2);
  });
});

describe("guide control and publication lifecycle", () => {
  it("discards unadmitted reads without losing another provider's programmes", async () => {
    const { owner, native, control } = setup();
    control.activations.set("b", {
      lease: "other",
      generation: { id: "db-b", fetchedAt: at, until: at + 86400_000 },
    });
    await owner.restore(["a", "b"]);
    owner.setPart(part());
    owner.setPart(part("b"));
    control.query = async () => ({
      kind: "ok",
      value: { guideId: "trusted.tv", rows: [programme], more: false },
    });
    const from = new Date(at);
    from.setHours(0, 0, 0, 0);
    const until = new Date(from);
    until.setDate(until.getDate() + 1);
    const day = { from: from.getTime(), until: until.getTime() };
    const page = await owner.schedule("a:1", day);
    const detail = page.programmes[0]!.detail;
    const begin = native.begin;
    native.begin = (lease, job) => lease !== "offline" && begin(lease, job);
    const result = await owner.listings(["a:1", "b:1"]);
    expect(result.get("a:1")).toEqual({ now: null, next: null });
    expect(result.get("b:1")?.now).toEqual(programme);
    expect(await owner.schedule("a:1", day)).toEqual(empty);
    expect(await owner.programme(detail)).toBeNull();
    native.begin = begin;
    expect((await owner.listings(["a:1"])).get("a:1")?.now).toEqual(programme);
  });

  it("discards the old lease after native attach commits but before JS receives it", async () => {
    const { owner, native, control, sources } = setup();
    control.activations.set("b", {
      lease: "other",
      generation: { id: "db-b", fetchedAt: at, until: at + 86400_000 },
    });
    await owner.restore(["a", "b"]);
    owner.setPart(part());
    owner.setPart(part("b"));
    control.query = async () => ({
      kind: "ok",
      value: { guideId: "trusted.tv", rows: [programme], more: false },
    });
    const committed = deferred<void>(),
      ack = deferred<void>();
    const attach = native.attach;
    native.attach = async (...args) => {
      const result = await attach(...args);
      committed.resolve();
      await ack.promise;
      return result;
    };
    sources.set("a", source);
    const activating = owner.attach("a");
    try {
      await committed.promise;
      const result = await owner.listings(["a:1", "b:1"]);
      expect(result.get("a:1")).toEqual({ now: null, next: null });
      expect(result.get("b:1")?.now).toEqual(programme);
    } finally {
      ack.resolve();
      await activating;
    }
    expect((await owner.listings(["a:1"])).get("a:1")?.now).toEqual(programme);
  });

  it.each(["before", "after"] as const)(
    "waits for activation before refreshing when native attach is held %s its lease replacement",
    async (phase) => {
      vi.useFakeTimers();
      vi.setSystemTime(at);
      const { owner, native, control, sources } = setup();
      control.activations.set("a", {
        lease: "offline",
        generation: { id: "db", fetchedAt: at - 6 * 3600_000, until: at + 86400_000 },
      });
      await owner.restore(["a"]);
      owner.setPart(part());
      const gate = deferred<void>(),
        committed = deferred<void>();
      const attach = native.attach;
      native.attach = async (...args) => {
        if (phase === "before") await gate.promise;
        const result = await attach(...args);
        committed.resolve();
        if (phase === "after") await gate.promise;
        return result;
      };
      const prepares: string[] = [];
      native.prepare = async (lease) => {
        prepares.push(lease);
        return { kind: "failed", error: "network" };
      };
      sources.set("a", source);
      const activating = owner.attach("a");
      try {
        if (phase === "after") await committed.promise;
        owner.foreground();
        await vi.advanceTimersByTimeAsync(0);
        expect(prepares).toEqual([]);
        expect(owner.status("a").error).toBeNull();
        gate.resolve();
        await activating;
        await vi.advanceTimersByTimeAsync(0);
        expect(prepares).toEqual([control.activations.get("a")?.lease]);
      } finally {
        gate.resolve();
        await activating;
        owner.background();
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
      }
    },
  );

  it("keeps the authorized cache readable while a replacement activation is pending", async () => {
    const { owner, native, control, sources } = setup();
    await owner.restore(["a"]);
    owner.setPart(part());
    sources.set("a", source);
    const gate = deferred<void>();
    const attach = native.attach;
    native.attach = async (...args) => {
      await gate.promise;
      return attach(...args);
    };
    control.query = async () => ({
      kind: "ok",
      value: { guideId: "trusted.tv", rows: [programme], more: false },
    });
    const activating = owner.attach("a");
    const row = (await owner.listings(["a:1"])).get("a:1");
    gate.resolve();
    await activating;
    expect(row?.now?.title).toBe("News");
  });

  it("retries a background-cancelled cold refresh on foreground without a failure backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    const { native, control } = guideFixture();
    const held = deferred<Awaited<ReturnType<GuideNative["prepare"]>>>();
    let prepares = 0;
    control.prepare = async () =>
      ++prepares === 1 ? held.promise : { kind: "failed", error: "network" };
    const owner = createGuide(
      () => native,
      Date.now,
      () => source,
    );
    try {
      await owner.attach("a");
      await vi.advanceTimersByTimeAsync(0);
      owner.background();
      held.resolve({ kind: "cancelled" });
      await vi.advanceTimersByTimeAsync(30000);
      owner.foreground();
      await vi.advanceTimersByTimeAsync(0);
      expect(prepares).toBe(2);
    } finally {
      owner.background();
      vi.useRealTimers();
    }
  });

  it.each(["background", "deadline", "removal", "replacement"] as const)(
    "reconciles a committed publication after %s while rejecting retired identities",
    async (change) => {
      vi.useFakeTimers();
      vi.setSystemTime(at);
      const { native, control } = guideFixture();
      const sources = new Map([["a", source]]);
      const owner = createGuide(
        () => native,
        Date.now,
        (key) => sources.get(key),
      );
      control.activations.set("a", {
        lease: "restored",
        generation: { id: "old", fetchedAt: at, until: at + 86400_000 },
      });
      await owner.restore(["a"]);
      await owner.attach("a");
      owner.setPart(part());
      control.prepare = async () => ({ kind: "ok", value: { kind: "candidate", id: "candidate" } });
      const committed = deferred<void>(),
        ack = deferred<void>();
      const publish = native.publish;
      native.publish = async (...args) => {
        const result = await publish(...args);
        committed.resolve();
        await ack.promise;
        return result;
      };
      native.query = async (_lease, generation) =>
        control.activations.get("a")?.generation?.id === generation
          ? {
              kind: "ok",
              value: {
                guideId: "trusted.tv",
                rows: [{ ...programme, stop: at + 86400_000, title: generation }],
                more: false,
              },
            }
          : { kind: "changed" };
      try {
        const refreshing = owner.refresh("a");
        await committed.promise;
        const current = control.activations.get("a")?.generation?.id;
        if (change === "background") owner.background();
        if (change === "deadline") await vi.advanceTimersByTimeAsync(180000);
        if (change === "removal") await owner.forget("a");
        if (change === "replacement") sources.set("a", { ...source, revision: 2 });
        ack.resolve();
        await refreshing;
        const row = (await owner.listings(["a:1"])).get("a:1");
        if (change === "removal" || change === "replacement") expect(row?.now).toBeNull();
        else {
          expect(row?.now?.title).toBe(current);
          expect(owner.status("a")).toMatchObject({ availability: "available", error: null });
        }
      } finally {
        ack.resolve();
        owner.background();
        vi.useRealTimers();
      }
    },
  );
});

describe("guide results after final asynchronous cleanup", () => {
  it.each(["listings", "schedule", "programme"] as const)(
    "revalidates %s after removal, catalogue/generation replacement and abort during cleanup",
    async (method) => {
      for (const change of ["removal", "part", "generation", "abort"] as const) {
        const { owner, native, control, sources } = setup();
        await owner.restore(["a"]);
        sources.set("a", source);
        await owner.attach("a");
        owner.setPart(part());
        control.query = async () => ({
          kind: "ok",
          value: { guideId: "trusted.tv", rows: [programme], more: false },
        });
        const from = new Date(at);
        from.setHours(0, 0, 0, 0);
        const until = new Date(from);
        until.setDate(until.getDate() + 1);
        const day = { from: from.getTime(), until: until.getTime() };
        const detail = (await owner.schedule("a:1", day)).programmes[0]!.detail;
        const held = deferred<void>(),
          reached = deferred<void>();
        const baseQuery = native.query,
          baseCancel = native.cancel;
        let readJob = "";
        native.query = async (...args) => {
          readJob = args[2];
          return baseQuery(...args);
        };
        native.cancel = async (job) => {
          if (job === readJob) {
            reached.resolve();
            await held.promise;
          }
          await baseCancel(job);
        };
        const controller = new AbortController();
        const options = { signal: controller.signal };
        const pending =
          method === "listings"
            ? owner.listings(["a:1"], options)
            : method === "schedule"
              ? owner.schedule("a:1", day, undefined, options)
              : owner.programme(detail, options);
        await reached.promise;
        if (change === "removal") await owner.forget("a");
        if (change === "part") owner.setPart(part());
        if (change === "generation") {
          control.prepare = async () => ({ kind: "ok", value: { kind: "candidate", id: "new" } });
          await owner.refresh("a");
        }
        if (change === "abort") controller.abort();
        held.resolve();
        const result = await pending;
        if (result instanceof Map) expect(result.get("a:1")?.now, change).toBeNull();
        else if (result && "programmes" in result) expect(result.programmes, change).toEqual([]);
        else expect(result, change).toBeNull();
      }
    },
  );

  it.each(["removal", "part", "generation", "abort"])(
    "revalidates every earlier alias after a later batch: %s",
    async (change) => {
      const { owner, control, sources } = setup();
      await owner.restore(["a"]);
      sources.set("a", source);
      await owner.attach("a");
      const value = part(),
        first = value.channels[0]!;
      owner.setPart({ ...value, byId: new Map([...value.byId, ["third-alias", first]]) });
      const held = deferred<Awaited<ReturnType<GuideNative["query"]>>>(),
        reached = deferred<void>();
      let calls = 0;
      control.query = async () => {
        if (++calls === 3) {
          reached.resolve();
          return held.promise;
        }
        return { kind: "ok", value: { guideId: "trusted.tv", rows: [programme], more: false } };
      };
      const controller = new AbortController();
      const pending = owner.listings(["a:1", "a:2", "a:third-alias"], {
        signal: controller.signal,
      });
      await reached.promise;
      if (change === "removal") await owner.forget("a");
      if (change === "part") owner.setPart(part());
      if (change === "generation") {
        control.prepare = async () => ({ kind: "ok", value: { kind: "candidate", id: "new" } });
        await owner.refresh("a");
      }
      if (change === "abort") controller.abort();
      held.resolve({ kind: "ok", value: { guideId: "trusted.tv", rows: [], more: false } });
      const result = await pending;
      expect([...result.values()].every((value) => value.now === null && value.next === null)).toBe(
        true,
      );
    },
  );

  it("does not return a saved result after the query budget expires during drain", async () => {
    vi.useFakeTimers();
    const { owner, native, control } = setup();
    try {
      await owner.restore(["a"]);
      owner.setPart(part());
      control.query = async () => ({
        kind: "ok",
        value: { guideId: "trusted.tv", rows: [programme], more: false },
      });
      const held = deferred<void>(),
        reached = deferred<void>();
      native.cancel = async () => {
        reached.resolve();
        await held.promise;
      };
      const pending = owner.listings(["a:1"]);
      await reached.promise;
      await vi.advanceTimersByTimeAsync(2001);
      held.resolve();
      expect((await pending).get("a:1")?.now).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
