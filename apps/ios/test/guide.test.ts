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
