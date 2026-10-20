import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AnalyticsFailure } from "@mrstreamer/contracts/analytics";
import type { OperationOutcome } from "../src/main/analytics/operations.ts";
import type { UpdateFeed } from "@mrstreamer/contracts/update-feed";
import { parseVersion } from "@mrstreamer/contracts/version";
import { discovery, DiscoveryFailed, type Offer } from "@mrstreamer/core/updates/feed";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import {
  DEFAULT_SCHEDULE,
  Updates,
  type Installer,
  type UpdatesDeps,
} from "../src/main/services/updates.ts";
import { promised, runtimeFor, tempDir } from "./support.ts";

const METADATA = "latest-mac.yml";

/** The updates service, as the app starts it. */
const startUpdates = (deps: UpdatesDeps) => promised(runtimeFor(Updates.layer(deps)), Updates);

/** A release the sources found, by tag. */
function offer(tag: string): Offer {
  const version = parseVersion(tag);
  if (!version) throw new Error(`Not a version: ${tag}`);
  return {
    version,
    feedUrl: `https://example.test/download/${tag}`,
    notes: `Notes for ${tag}`,
    page: `https://example.test/releases/${tag}`,
  };
}

/**
 * Records what the updates service asked of the installer. `failures` downloads fail before one
 * succeeds; `hold` keeps a download open until `release()`, and `finishesAnyway` lets it finish
 * even after a cancel, as a real one can at that moment; `refuse` is the reason the system gives
 * for rejecting the install.
 */
function fakeInstaller(
  options: { failures?: number; hold?: boolean; finishesAnyway?: boolean; refuse?: string } = {},
) {
  const downloads: { feedUrl: string; version: string; allowDowngrade: boolean }[] = [];
  let installs = 0;
  let failures = options.failures ?? 0;
  let release: (() => void) | null = null;
  const installer: Installer = {
    async download(target, onProgress, signal) {
      downloads.push(target);
      onProgress(50);
      if (options.hold) {
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          if (options.finishesAnyway) return;
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      }
      if (failures-- > 0) throw new Error("The download broke off.");
      onProgress(100);
    },
    async install() {
      installs++;
      if (options.refuse) throw new Error(options.refuse);
    },
  };
  return { installer, downloads, installs: () => installs, release: () => release?.() };
}

async function updates(
  installed: string,
  offers: readonly Offer[],
  options: { dataDir?: string; installer?: Installer } = {},
) {
  const dataDir = options.dataDir ?? (await tempDir());
  const installer = options.installer ?? fakeInstaller().installer;
  const service = await startUpdates({
    dataDir,
    installed,
    discover: async () => offers,
    installer,
  });
  return { dataDir, service };
}

const PUBLISHED = [
  offer("v0.2.0"),
  offer("v0.2.1"),
  offer("v0.3.0-nightly.20261001.10"),
  offer("v0.3.0-nightly.20261002.14"),
];

describe("update channels", () => {
  it("starts on the channel of the downloaded build", async () => {
    expect((await (await updates("0.2.0", [])).service.status()).channel).toBe("stable");
    expect((await (await updates("0.3.0-nightly.20261002.14", [])).service.status()).channel).toBe(
      "nightly",
    );
  });

  it("offers Stable users the newest stable release only, with its notes and page", async () => {
    const { service } = await updates("0.2.0", PUBLISHED);

    const status = await service.check();

    expect(status.update).toEqual({ kind: "available", version: "0.2.1" });
    expect(status.offer).toEqual({
      version: "0.2.1",
      notes: "Notes for v0.2.1",
      page: "https://example.test/releases/v0.2.1",
    });
  });

  it("offers Nightly users the newest nightly, never a stable release", async () => {
    const { service } = await updates("0.3.0-nightly.20261001.10", [...PUBLISHED, offer("v0.3.0")]);

    expect((await service.check()).update).toEqual({
      kind: "available",
      version: "0.3.0-nightly.20261002.14",
    });
  });

  it("keeps a stable build on Nightly until a newer nightly is out", async () => {
    const dataDir = await tempDir();
    await (await updates("0.3.0-nightly.20261002.14", [], { dataDir })).service.status();

    const stableBuild = await updates("0.3.0", [...PUBLISHED, offer("v0.3.0")], { dataDir });
    const later = await updates(
      "0.3.0",
      [...PUBLISHED, offer("v0.3.0"), offer("v0.3.1-nightly.20261003.15")],
      { dataDir },
    );

    expect(await stableBuild.service.check()).toMatchObject({
      channel: "nightly",
      update: { kind: "current" },
    });
    expect((await later.service.check()).update).toEqual({
      kind: "available",
      version: "0.3.1-nightly.20261003.15",
    });
  });

  it("offers a stable build switched to Nightly only a newer nightly", async () => {
    const { service } = await updates("0.3.0", [...PUBLISHED, offer("v0.3.0")]);

    expect((await service.setChannel("nightly")).update).toEqual({ kind: "current" });
    expect((await service.setChannel("stable")).update).toEqual({ kind: "current" });
  });

  it("offers a nightly just below a stable release the next nightly, or on Stable that release", async () => {
    const published = [...PUBLISHED, offer("v0.3.0"), offer("v0.3.1-nightly.20261003.15")];
    const { service } = await updates("0.3.0-nightly.20261002.14", published);

    expect((await service.check()).update).toEqual({
      kind: "available",
      version: "0.3.1-nightly.20261003.15",
    });
    expect((await service.setChannel("stable")).update).toEqual({
      kind: "available",
      version: "0.3.0",
    });
  });

  it("takes a Nightly user who switches to Stable to the newest stable release, older or not", async () => {
    const fake = fakeInstaller();
    const { service } = await updates("0.3.0-nightly.20261002.14", PUBLISHED, {
      installer: fake.installer,
    });

    const status = await service.setChannel("stable");

    expect(status.channel).toBe("stable");
    expect(status.update).toEqual({ kind: "available", version: "0.2.1" });
    expect((await service.download()).update).toEqual({ kind: "ready", version: "0.2.1" });
    expect(fake.downloads.at(-1)).toMatchObject({ version: "0.2.1", allowDowngrade: true });
  });

  it("says why a check the user asked for failed", async () => {
    const service = await startUpdates({
      dataDir: await tempDir(),
      installed: "0.2.0",
      discover: () => Promise.reject(new DiscoveryFailed({ kind: "http", status: 502 }, [])),
      installer: fakeInstaller().installer,
    });

    const status = await service.check();

    expect(status.update).toEqual({
      kind: "failed",
      step: "check",
      failure: { kind: "http", status: 502 },
    });
    expect(status.checked).toMatchObject({ failure: { kind: "http", status: 502 } });
  });

  it("keeps an update on offer when a later check the user asked for fails", async () => {
    let offline = false;
    const service = await startUpdates({
      dataDir: await tempDir(),
      installed: "0.2.0",
      discover: async () => {
        if (offline) throw new DiscoveryFailed({ kind: "offline" }, []);
        return PUBLISHED;
      },
      installer: fakeInstaller().installer,
    });
    await service.check();
    offline = true;

    const status = await service.check();

    expect(status.update).toEqual({ kind: "available", version: "0.2.1" });
    expect(status.checked).toMatchObject({ failure: { kind: "offline" } });
    expect((await service.download()).update).toEqual({ kind: "ready", version: "0.2.1" });
  });

  it("keeps the channel the user picked last, however fast they switch", async () => {
    const dataDir = await tempDir();
    const { service } = await updates("0.2.0", PUBLISHED, { dataDir });

    await Promise.all([
      service.setChannel("nightly"),
      service.setChannel("stable"),
      service.setChannel("nightly"),
    ]);

    expect((await (await updates("0.2.0", [], { dataDir })).service.status()).channel).toBe(
      "nightly",
    );
  });

  it("remembers a closed notice per version, across restarts", async () => {
    const dataDir = await tempDir();
    const { service } = await updates("0.2.0", PUBLISHED, { dataDir });
    await service.check();

    await service.dismiss("0.2.1");

    const restarted = (await updates("0.2.0", PUBLISHED, { dataDir })).service;
    expect(await restarted.check()).toMatchObject({
      dismissed: "0.2.1",
      update: { kind: "available", version: "0.2.1" },
    });
  });

  it("keeps what a newer release added to its settings when it saves them", async () => {
    const dataDir = await tempDir();
    const file = join(dataDir, "updates.json");
    await writeFile(file, JSON.stringify({ channel: "stable", dismissed: null, later: [1] }));
    const { service } = await updates("0.2.0", PUBLISHED, { dataDir });

    await service.dismiss("0.2.1");

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      channel: "stable",
      dismissed: "0.2.1",
      later: [1],
    });
  });
});

describe("in-app updates", () => {
  it("downloads only when asked and installs only after the restart is confirmed", async () => {
    const fake = fakeInstaller();
    const { service } = await updates("0.2.0", PUBLISHED, { installer: fake.installer });

    await service.check();
    expect(fake.downloads).toEqual([]);
    expect((await service.download()).update).toEqual({ kind: "ready", version: "0.2.1" });
    expect(fake.downloads).toEqual([
      { feedUrl: "https://example.test/download/v0.2.1", version: "0.2.1", allowDowngrade: false },
    ]);
    expect(fake.installs()).toBe(0);

    await service.restart();
    expect(fake.installs()).toBe(1);
  });

  it.each([false, true])(
    "goes back to the available update when a download is cancelled (finishes anyway: %s)",
    async (finishesAnyway) => {
      const fake = fakeInstaller({ hold: true, finishesAnyway });
      const { service } = await updates("0.2.0", PUBLISHED, { installer: fake.installer });
      await service.check();

      const download = service.download();
      await vi.waitFor(() => expect(fake.downloads).toHaveLength(1));
      await service.cancel();
      fake.release();

      expect((await download).update).toEqual({ kind: "available", version: "0.2.1" });
    },
  );

  it("downloads once when asked twice at the same time", async () => {
    const fake = fakeInstaller({ hold: true });
    const { service } = await updates("0.2.0", PUBLISHED, { installer: fake.installer });
    await service.check();

    const [first, second] = [service.download(), service.download()];
    await vi.waitFor(() => expect(fake.downloads).toHaveLength(1));
    fake.release();

    expect((await first).update).toEqual({ kind: "ready", version: "0.2.1" });
    expect((await second).update.kind).toBe("downloading");
    expect(fake.downloads).toHaveLength(1);
  });

  it("reports a failed download, and downloads again on Try again", async () => {
    const fake = fakeInstaller({ failures: 1 });
    const { service } = await updates("0.2.0", PUBLISHED, { installer: fake.installer });
    await service.check();

    expect((await service.download()).update).toEqual({
      kind: "failed",
      step: "download",
      version: "0.2.1",
      detail: "The download broke off.",
    });
    expect((await service.download()).update).toEqual({ kind: "ready", version: "0.2.1" });
    expect(fake.downloads).toHaveLength(2);
  });

  it("reports an install the system refuses, and can download it again", async () => {
    const refusal = "The update's signature doesn't match this app.";
    const { service } = await updates("0.2.0", PUBLISHED, {
      installer: fakeInstaller({ refuse: refusal }).installer,
    });
    await service.check();
    await service.download();

    await service.restart();

    expect((await service.status()).update).toEqual({
      kind: "failed",
      step: "install",
      version: "0.2.1",
      detail: refusal,
    });
    expect((await service.download()).update).toEqual({ kind: "ready", version: "0.2.1" });
  });

  it("keeps a downloaded update through a check that fails", async () => {
    let fail = false;
    const service = await startUpdates({
      dataDir: await tempDir(),
      installed: "0.2.0",
      discover: async () => {
        if (fail) throw new DiscoveryFailed({ kind: "offline" }, []);
        return PUBLISHED;
      },
      installer: fakeInstaller().installer,
    });
    await service.check();
    await service.download();
    fail = true;

    expect((await service.check()).update).toEqual({ kind: "ready", version: "0.2.1" });
  });

  it("drops a downloaded nightly when the user switches to Stable, and offers Stable instead", async () => {
    const fake = fakeInstaller();
    const { service } = await updates("0.3.0-nightly.20261001.10", PUBLISHED, {
      installer: fake.installer,
    });
    await service.check();
    await service.download();

    expect((await service.setChannel("stable")).update).toEqual({
      kind: "available",
      version: "0.2.1",
    });
    await service.restart();
    expect(fake.installs()).toBe(0);
  });

  it("drops a nightly download that finishes after the switch to Stable", async () => {
    const fake = fakeInstaller({ hold: true, finishesAnyway: true });
    const { service } = await updates("0.3.0-nightly.20261001.10", PUBLISHED, {
      installer: fake.installer,
    });
    await service.check();
    const download = service.download();
    await vi.waitFor(() => expect(fake.downloads).toHaveLength(1));

    const switched = service.setChannel("stable");
    fake.release();
    await download;

    expect((await switched).update).toEqual({ kind: "available", version: "0.2.1" });
    await service.restart();
    expect(fake.installs()).toBe(0);
  });

  it("drops a downloaded stable release when the user switches to Nightly, and offers Nightly instead", async () => {
    const fake = fakeInstaller();
    const { service } = await updates("0.2.0", PUBLISHED, { installer: fake.installer });
    await service.check();
    await service.download();

    expect((await service.setChannel("nightly")).update).toEqual({
      kind: "available",
      version: "0.3.0-nightly.20261002.14",
    });
    await service.restart();
    expect(fake.installs()).toBe(0);
  });
});

describe("a copy the Microsoft Store installed", () => {
  it("leaves updates to the Store, and opens it when asked", async () => {
    const dataDir = await tempDir();
    let opened = 0;
    const service = await startUpdates({
      dataDir,
      installed: "0.0.4",
      openStore: async () => {
        opened++;
      },
    });

    const checked = await service.check();
    const switched = await service.setChannel("nightly");
    await service.download();
    await service.openStore();

    expect(checked).toMatchObject({ distribution: "store", update: { kind: "idle" }, offer: null });
    expect(switched.channel).toBe("stable");
    expect(opened).toBe(1);
    expect(await readdir(dataDir)).toEqual([]);
  });
});

describe("a copy managed by pacman", () => {
  it("ignores stale direct update state and leaves every update action inert", async () => {
    const dataDir = await tempDir();
    const path = join(dataDir, "updates.json");
    const stored = JSON.stringify({ channel: "nightly", dismissed: "0.0.18", future: "keep" });
    await writeFile(path, stored);
    const service = await startUpdates({ dataDir, installed: "0.0.17", managed: "pacman" });
    const initial = await service.status();
    expect(initial).toEqual({
      version: "0.0.17",
      distribution: "pacman",
      channel: "stable",
      update: { kind: "idle" },
      offer: null,
      checked: null,
      nextCheckAt: null,
      dismissed: null,
    });
    expect(await service.check()).toEqual(initial);
    expect(await service.download()).toEqual(initial);
    expect(await service.setChannel("nightly")).toEqual(initial);
    expect(await service.dismiss("0.0.18")).toEqual(initial);
    await service.cancel();
    await service.restart();
    await service.openStore();
    expect(await readdir(dataDir)).toEqual(["updates.json"]);
    expect(await readFile(path, "utf8")).toBe(stored);
    const direct = await updates("0.0.17", [], { dataDir });
    expect((await direct.service.status()).distribution).toBe("direct");
    expect((await direct.service.status()).channel).toBe("nightly");
  });
});

describe("overlapping checks", () => {
  /** Discoveries answered one at a time, in whatever order the test chooses. */
  function heldDiscovery() {
    const requests: {
      resolve: (offers: readonly Offer[]) => void;
      reject: (error: Error) => void;
    }[] = [];
    return {
      discover: () =>
        new Promise<readonly Offer[]>((resolve, reject) => requests.push({ resolve, reject })),
      count: () => requests.length,
      /** The `index`th request, once the service has made it. */
      request: (index: number) =>
        vi.waitFor(() => {
          const request = requests[index];
          if (!request) throw new Error(`No request ${index} yet.`);
          return request;
        }),
    };
  }

  const LATEST = [offer("v0.0.1"), offer("v0.0.2"), offer("v0.0.3-nightly.20260930.1")];

  async function service(installed: string) {
    const held = heldDiscovery();
    const fake = fakeInstaller();
    const updates = await startUpdates({
      dataDir: await tempDir(),
      installed,
      discover: held.discover,
      installer: fake.installer,
    });
    return { held, fake, updates };
  }

  it("asks once when checks overlap", async () => {
    const { held, updates } = await service("0.0.1");

    const checks = [updates.check(), updates.check(), updates.check()];
    (await held.request(0)).resolve(LATEST);
    await Promise.all(checks);

    expect(held.count()).toBe(1);
  });

  it("ignores a Nightly check that answers after the switch to Stable, and never installs its nightly", async () => {
    const { held, fake, updates } = await service("0.0.1");
    const nightly = updates.setChannel("nightly");
    const nightlyRequest = await held.request(0);
    const stable = updates.setChannel("stable");

    (await held.request(1)).resolve(LATEST);
    expect((await stable).update).toEqual({ kind: "available", version: "0.0.2" });
    nightlyRequest.resolve(LATEST);
    expect(await nightly).toMatchObject({
      channel: "stable",
      update: { kind: "available", version: "0.0.2" },
    });

    await updates.download();
    await updates.restart();
    expect(fake.downloads.map((download) => download.version)).toEqual(["0.0.2"]);
    expect(fake.installs()).toBe(1);
  });

  it("doesn't let an older check that fails late hide a newer result", async () => {
    const { held, updates } = await service("0.0.1");
    const first = updates.check();
    const firstRequest = await held.request(0);
    const second = updates.setChannel("stable");

    (await held.request(1)).resolve(LATEST);
    await second;
    firstRequest.reject(new DiscoveryFailed({ kind: "http", status: 502 }, []));
    await first;

    expect((await updates.status()).update).toEqual({ kind: "available", version: "0.0.2" });
  });

  it("offers nothing from a check that answers after a newer one found nothing", async () => {
    const { held, fake, updates } = await service("0.0.2");
    const nightly = updates.setChannel("nightly");
    const nightlyRequest = await held.request(0);
    const stable = updates.setChannel("stable");

    (await held.request(1)).resolve(LATEST);
    await stable;
    nightlyRequest.resolve(LATEST);
    await nightly;

    expect((await updates.status()).update).toEqual({ kind: "current" });
    await updates.download();
    await updates.restart();
    expect(fake.downloads).toEqual([]);
    expect(fake.installs()).toBe(0);
  });
});

describe("automatic checks", () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;

  /** The service with its schedule on a test clock; `answers` decides each discovery. */
  async function scheduled(
    answers: (call: number) => readonly Offer[] | DiscoveryFailed | Promise<readonly Offer[]>,
  ) {
    let calls = 0;
    const runtime = runtimeFor(
      Updates.layer({
        dataDir: await tempDir(),
        installed: "0.2.0",
        discover: async () => {
          const answer = await answers(calls++);
          if (answer instanceof DiscoveryFailed) throw answer;
          return answer;
        },
        installer: fakeInstaller().installer,
        schedule: DEFAULT_SCHEDULE,
      }).pipe(Layer.provideMerge(TestClock.layer({ warningDelay: "1 day" }))),
    );
    const service = await promised(runtime, Updates);
    /**
     * Moves the clock once the schedule waits for its next check, as only a waiting check moves
     * with it, and lets the check it starts finish.
     */
    const pass = async (ms: number) => {
      await vi.waitFor(async () => {
        const planned = (await service.status()).nextCheckAt ?? 0;
        expect(planned).toBeGreaterThan(await runtime.runPromise(Clock.currentTimeMillis));
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await runtime.runPromise(TestClock.adjust(ms));
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    /** How long until the planned check, which falls anywhere in the four hours' spread. */
    const untilNext = async () => {
      const planned = (await service.status()).nextCheckAt ?? 0;
      return planned - (await runtime.runPromise(Clock.currentTimeMillis));
    };
    return { service, pass, untilNext, calls: () => calls };
  }

  it("checks after starting and every four hours, without showing it", async () => {
    const app = await scheduled(() => PUBLISHED);

    expect(app.calls()).toBe(0);
    await app.pass(20_000);
    await vi.waitFor(() => expect(app.calls()).toBe(1));
    expect((await app.service.status()).update).toEqual({ kind: "available", version: "0.2.1" });

    await app.pass(4 * HOUR - MINUTE);
    expect(app.calls()).toBe(1);
    // Up to a tenth later, so installs spread out.
    await app.pass(0.4 * HOUR + MINUTE);
    await vi.waitFor(() => expect(app.calls()).toBe(2));
  });

  it("keeps what it found when a later check fails, and tries again sooner", async () => {
    const app = await scheduled((call) =>
      call === 0 ? PUBLISHED : new DiscoveryFailed({ kind: "offline" }, []),
    );
    await app.pass(20_000);
    await vi.waitFor(() => expect(app.calls()).toBe(1));
    // Exactly to the next check: going past it could also pass the sooner retry after it.
    await vi.waitFor(async () => expect(await app.untilNext()).toBeGreaterThan(4 * HOUR - MINUTE));
    await app.pass(await app.untilNext());
    await vi.waitFor(() => expect(app.calls()).toBe(2));

    await vi.waitFor(async () =>
      expect((await app.service.status()).checked).toMatchObject({ failure: { kind: "offline" } }),
    );
    expect((await app.service.status()).update).toEqual({ kind: "available", version: "0.2.1" });
    await app.pass(15 * MINUTE);
    await vi.waitFor(() => expect(app.calls()).toBe(3));
  });

  it("keeps a download started while a check was out, however the check ends", async () => {
    for (const ending of ["found", "failed"] as const) {
      const late = Promise.withResolvers<readonly Offer[]>();
      const app = await scheduled((call) => (call === 0 ? PUBLISHED : late.promise));
      await app.pass(20_000);
      await vi.waitFor(() => expect(app.calls()).toBe(1));
      await vi.waitFor(async () => expect(await app.untilNext()).toBeGreaterThan(0));
      await app.pass(await app.untilNext());
      await vi.waitFor(() => expect(app.calls()).toBe(2));

      await app.service.download();
      if (ending === "found") late.resolve(PUBLISHED);
      else late.reject(new DiscoveryFailed({ kind: "offline" }, []));
      await vi.waitFor(async () =>
        expect((await app.service.status()).checked?.at).toBeGreaterThan(20_000),
      );
      expect((await app.service.status()).update).toEqual({ kind: "ready", version: "0.2.1" });
    }
  });

  it("waits until GitHub allows requests again", async () => {
    // The test clock starts at zero; the first check runs at 20 seconds.
    const app = await scheduled(
      () => new DiscoveryFailed({ kind: "busy", until: 20_000 + 3 * HOUR }, []),
    );
    await app.pass(20_000);
    expect((await app.service.status()).update).toEqual({ kind: "idle" });

    await app.pass(2 * HOUR);
    expect(app.calls()).toBe(1);
    await app.pass(1 * HOUR + 2 * MINUTE);
    await vi.waitFor(() => expect(app.calls()).toBe(2));
  });
});

describe("finding releases", () => {
  const FEED_URL = "https://feed.example.test/updates.json";
  const API = "https://api.example.test";

  function feedEntry(version: string, platforms = [METADATA]): UpdateFeed["stable"] {
    return {
      version,
      published: "2026-10-01T10:00:00Z",
      page: `https://github.example.test/releases/tag/v${version}`,
      files: `https://github.com/owner/app/releases/download/v${version}`,
      notes: `Notes for ${version}`,
      platforms,
    };
  }

  function githubRelease(tag: string, options: { prerelease?: boolean; draft?: boolean } = {}) {
    return {
      tag_name: tag,
      prerelease: options.prerelease ?? tag.includes("-nightly."),
      draft: options.draft ?? false,
      body: `Notes for ${tag}`,
      html_url: `https://github.example.test/releases/tag/${tag}`,
      assets: [
        {
          name: METADATA,
          browser_download_url: `https://github.example.test/releases/download/${tag}/${METADATA}`,
        },
      ],
    };
  }

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  /** Answers the feed and GitHub's two release lists as each test sets them. */
  function sources(answer: {
    feed: () => Response | Promise<Response>;
    page?: () => Response;
    latest?: () => Response;
  }) {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url === FEED_URL) return answer.feed();
      if (url.endsWith("/releases/latest")) return answer.latest?.() ?? json({}, 404);
      return answer.page?.() ?? json([]);
    });
    return { fetchImpl, requests };
  }

  const find = (fetchImpl: typeof fetch, now?: () => number) =>
    discovery({
      feedUrl: FEED_URL,
      api: API,
      repository: "owner/app",
      metadataFile: METADATA,
      userAgent: "MrStreamer/test",
      fetch: fetchImpl,
      ...(now ? { now } : {}),
    });

  const versions = async (found: Promise<Offer[]>) =>
    (await found).map(
      (each) =>
        `${each.version.major}.${each.version.minor}.${each.version.patch}${each.version.nightly ? "-nightly" : ""}`,
    );

  it("reads both channels from the feed with one request", async () => {
    const { fetchImpl, requests } = sources({
      feed: () =>
        json({
          schema: 1,
          generated: "2026-10-01T10:00:00Z",
          stable: feedEntry("0.2.1"),
          nightly: feedEntry("0.3.0-nightly.20261002.14"),
        }),
    });

    const found = await find(fetchImpl)(new AbortController().signal);

    expect(found.map((each) => each.notes)).toEqual([
      "Notes for 0.2.1",
      "Notes for 0.3.0-nightly.20261002.14",
    ]);
    expect(found[0]?.feedUrl).toBe("https://github.com/owner/app/releases/download/v0.2.1");
    expect(requests).toEqual([FEED_URL]);
  });

  it("offers a Nightly user nothing from a feed whose nightly is a stable release", async () => {
    // Feeds deployed before 0.0.4 named the highest release of all as nightly.
    const { fetchImpl } = sources({
      feed: () =>
        json({
          schema: 1,
          generated: "2026-10-02T10:00:00Z",
          stable: feedEntry("0.3.0"),
          nightly: feedEntry("0.3.0"),
        }),
    });
    const service = await startUpdates({
      dataDir: await tempDir(),
      installed: "0.3.0-nightly.20261001.10",
      discover: find(fetchImpl),
      installer: fakeInstaller().installer,
    });

    expect((await service.check()).update).toEqual({ kind: "current" });
  });

  it("skips a feed entry without this platform's update metadata", async () => {
    const { fetchImpl } = sources({
      feed: () =>
        json({
          schema: 1,
          generated: "2026-10-01T10:00:00Z",
          stable: feedEntry("0.2.1", ["latest.yml"]),
          nightly: null,
        }),
    });

    expect(await find(fetchImpl)(new AbortController().signal)).toEqual([]);
  });

  it("asks GitHub when the feed isn't there yet, and keeps its rules", async () => {
    const { fetchImpl } = sources({
      feed: () => json({ message: "Not Found" }, 404),
      page: () =>
        json([
          githubRelease("v0.2.1"),
          // A stable version marked as a pre-release, a nightly marked as stable, and a draft.
          githubRelease("v0.9.0", { prerelease: true }),
          githubRelease("v0.8.0-nightly.20261003.1", { prerelease: false }),
          githubRelease("v0.7.0", { draft: true }),
        ]),
      latest: () => json(githubRelease("v0.2.0")),
    });

    expect(await versions(find(fetchImpl)(new AbortController().signal))).toEqual([
      "0.2.1",
      "0.2.0",
    ]);
  });

  it("asks GitHub when the feed sends downloads anywhere but the repository's releases", async () => {
    for (const files of [
      "https://files.example.test/v0.2.1",
      "https://github.com/owner/app/releases/download/../../../../other/app/releases/download/v0.2.1",
    ]) {
      const { fetchImpl, requests } = sources({
        feed: () =>
          json({
            schema: 1,
            generated: "2026-10-01T10:00:00Z",
            stable: { ...feedEntry("0.2.1"), files },
            nightly: null,
          }),
        page: () => json([githubRelease("v0.2.0")]),
      });

      const found = await find(fetchImpl)(new AbortController().signal);

      expect(found.map((each) => each.feedUrl)).toEqual([
        "https://github.example.test/releases/download/v0.2.0",
      ]);
      expect(requests).toContain(`${API}/repos/owner/app/releases?per_page=100`);
    }
  });

  it("doesn't ask GitHub when offline", async () => {
    const { fetchImpl, requests } = sources({
      feed: () => Promise.reject(new TypeError("fetch failed")),
    });

    await expect(find(fetchImpl)(new AbortController().signal)).rejects.toMatchObject({
      failure: { kind: "offline" },
    });
    expect(requests).toEqual([FEED_URL]);
  });

  it("tells GitHub's limit from a refusal, and leaves GitHub alone until the limit resets", async () => {
    let now = Date.parse("2026-10-01T10:00:00Z");
    const reset = Math.floor(now / 1000) + 1800;
    const { fetchImpl, requests } = sources({
      feed: () => json({}, 503),
      page: () =>
        json({ message: "API rate limit exceeded" }, 403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(reset),
        }),
    });
    const discover = find(fetchImpl, () => now);

    const first = await discover(new AbortController().signal).catch((cause: unknown) => cause);
    expect(first).toMatchObject({ failure: { kind: "busy", until: reset * 1000 } });
    expect((first as DiscoveryFailed).answers).toEqual([
      { source: "feed", status: 503, remaining: null, reset: null, retryAfter: null },
      { source: "github", status: 403, remaining: 0, reset, retryAfter: null },
    ]);

    now += 10 * 60_000;
    await expect(discover(new AbortController().signal)).rejects.toMatchObject({
      failure: { kind: "busy" },
    });
    expect(requests.filter((url) => url.startsWith(API))).toHaveLength(1);
  });

  it("reports GitHub's other refusals as HTTP errors", async () => {
    const { fetchImpl } = sources({
      feed: () => json({}, 404),
      page: () => json({ message: "Forbidden" }, 403),
    });

    await expect(find(fetchImpl)(new AbortController().signal)).rejects.toMatchObject({
      failure: { kind: "http", status: 403 },
    });
  });
});

it("observes one actual shared update check and bounded failures, excluding installer actions", async () => {
  const outcomes: { outcome: OperationOutcome; failure?: AnalyticsFailure }[] = [];
  let starts = 0;
  const channels: string[] = [];
  let release: (() => void) | undefined;
  let fail = false;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { installer } = fakeInstaller();
  const service = await startUpdates({
    dataDir: await tempDir(),
    installed: "0.2.0",
    installer,
    async discover() {
      await pending;
      if (fail) throw new Error("PRIVATE network details");
      return [offer("v0.2.1")];
    },
    observeCheck(channel) {
      channels.push(channel);
      starts++;
      return (outcome, failure) => outcomes.push({ outcome, ...(failure ? { failure } : {}) });
    },
  });
  const first = service.check();
  const second = service.check();
  await vi.waitFor(() => expect(starts).toBe(1));
  release?.();
  await Promise.all([first, second]);
  expect(outcomes).toEqual([{ outcome: "success" }]);
  fail = true;
  await service.check();
  expect(starts).toBe(2);
  expect(outcomes).toEqual([{ outcome: "success" }, { outcome: "failed", failure: "network" }]);
  fail = false;
  await service.check();
  await service.download();
  await service.restart();
  expect(starts).toBe(3);
  expect(outcomes).toHaveLength(3);
  expect(channels).toEqual(["stable", "stable", "stable"]);
  await service.setChannel("nightly");
  expect(channels).toEqual(["stable", "stable", "stable", "nightly"]);
});
