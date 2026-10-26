import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "./e2e/app.ts";
import { failRendererLaunch } from "./e2e/analytics-launch-diagnostic.ts";

vi.mock("node:fs", { spy: true });
const { writeFileSync: write } = await vi.importActual<typeof fs>("node:fs");
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

type LaterReceipt = {
  primaryFile: string;
  samples: {
    phase: string;
    startedAt: string;
    completedAt: string;
    app: { exitCode: number | null; signalCode: string | null };
    result?: unknown;
    error?: string;
  }[];
};

function fixture(rejectedUrl = "about:blank") {
  const evidence = fs.mkdtempSync(join(tmpdir(), "renderer-launch-diagnostic-"));
  directories.push(evidence);
  const calls: string[] = [];
  const send = vi.fn<Page["send"]>(async (method, _params, timeoutMs) => {
    calls.push(method);
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(500);
    return {
      result:
        method === "Page.getFrameTree"
          ? {
              frameTree: {
                frame: {
                  id: "same-page",
                  loaderId: "loader",
                  url: "chrome-error://chromewebdata/",
                  unreachableUrl: "file:///missing/resources/app.asar/out/renderer/index.html",
                  securityOrigin: "excluded",
                },
              },
            }
          : {
              currentIndex: 1,
              entries: [
                {
                  url: "file:///later",
                  userTypedURL: "file:///typed",
                  transitionType: "typed",
                  id: 9,
                },
              ],
            },
    };
  });
  const evaluate = vi.fn<Page["evaluate"]>().mockResolvedValue({
    pid: 123,
    executable: "/owned/app.exe",
    resources: "/owned/resources",
    appPath: "/owned/resources/app.asar",
    version: "0.0.15",
    excluded: "not retained",
    webContents: [
      {
        id: 1,
        type: "window",
        url: "file:///later",
        loading: true,
        isLoadingMainFrame: true,
        crashed: false,
        destroyed: false,
      },
      {
        id: 2,
        type: "remote",
        url: "devtools://later",
        loading: false,
        isLoadingMainFrame: false,
        crashed: false,
        destroyed: false,
      },
    ],
  });
  const listing = [
    {
      id: "same-page",
      type: "page",
      url: "x".repeat(4096),
      title: "t".repeat(4096),
      attached: true,
      webSocketDebuggerUrl: "ws://excluded",
      devtoolsFrontendUrl: "devtools://excluded",
      faviconUrl: "https://excluded",
    },
  ];
  const fetch_ = vi.fn<typeof fetch>(async () => {
    calls.push("listing");
    return Response.json(listing);
  });
  vi.stubGlobal("fetch", fetch_);
  const observations: Record<string, unknown> = { instance: { pid: 999 } };
  const context = {
    evidence,
    observations,
    page: { send },
    mainPage: { evaluate },
    app: { pid: 123, exitCode: null as number | null, signalCode: null },
    rejectedUrl,
    comparedMainPid: 123,
    browserArguments: ["--user-data-dir=/owned/profile", "--remote-debugging-port=1234"],
    pagePort: 1234,
    inspectorPort: 1235,
    profile: "/owned/profile",
    target: { version: "0.0.15", source: "selected-source", executable: "/owned/app.exe" },
    launchOrdinal: 4,
  };
  const file = (suffix: string) => {
    const name = fs.readdirSync(evidence).find((name) => name.endsWith(suffix));
    if (!name) throw new Error(`Missing receipt ${suffix}`);
    return { name, bytes: fs.readFileSync(join(evidence, name), "utf8") };
  };
  return { context, calls, send, evaluate, fetch_, file };
}

describe("failure-only renderer launch evidence", () => {
  it.each([
    { label: "empty", url: "" },
    { label: "long foreign", url: `https://foreign.invalid/${"x".repeat(4096)}` },
  ])(
    "durably records the exact $label URL before querying, independently of cleanup and later navigation",
    async ({ url }) => {
      const f = fixture(url);
      let primaryBeforeQuery = "";
      const read = f.send.getMockImplementation()!;
      f.send.mockImplementation((...args) => {
        primaryBeforeQuery ||= f.file(".primary.json").bytes;
        return read(...args);
      });
      const error = new Error("Wrong renderer build.");
      await expect(failRendererLaunch(error, f.context)).rejects.toBe(error);
      // The caller can now close the sockets and app without losing the rejected state.
      f.send.mockRejectedValue(new Error("socket closed"));
      f.evaluate.mockRejectedValue(new Error("inspector closed"));
      f.context.app.exitCode = 0;
      f.context.rejectedUrl = "file:///after-cleanup";
      const primary = f.file(".primary.json");
      expect(primary.bytes).toBe(primaryBeforeQuery);
      expect(JSON.parse(primary.bytes)).toMatchObject({
        rejectedUrl: url,
        spawnedMainPid: 123,
        comparedMainPid: 123,
        browserArguments: f.context.browserArguments,
        pagePort: 1234,
        inspectorPort: 1235,
        profile: "/owned/profile",
        target: f.context.target,
        launchOrdinal: 4,
        guardTime: expect.any(String),
        originalSelectedListing: "unavailable",
        error: { message: "Wrong renderer build." },
      });
      expect(f.context.observations["rendererLaunchFailures"]).toEqual([
        {
          launchOrdinal: 4,
          primaryFile: primary.name,
          laterFile: f.file(".later.json").name,
          errors: [],
        },
      ]);
    },
  );

  it("keeps allowlisted later page/list/main facts separate, with timing and exit status for every phase", async () => {
    const f = fixture();
    f.evaluate.mockImplementationOnce(async () => {
      f.context.app.exitCode = 0;
      return {
        pid: 123,
        version: "0.0.15",
        webContents: [
          {
            id: 2,
            type: "remote",
            url: "devtools://later",
            loading: false,
            isLoadingMainFrame: false,
            crashed: false,
            destroyed: false,
            extra: "excluded",
          },
        ],
      };
    });
    const error = new Error("Wrong renderer build.");
    await expect(failRendererLaunch(error, f.context)).rejects.toBe(error);
    expect(f.calls.slice(0, 3)).toEqual([
      "Page.getFrameTree",
      "Page.getNavigationHistory",
      "listing",
    ]);
    const later = JSON.parse(f.file(".later.json").bytes) as LaterReceipt;
    expect(later.primaryFile).toBe(f.file(".primary.json").name);
    expect(later.samples.map((sample) => sample.result)).toEqual([
      {
        id: "same-page",
        loaderId: "loader",
        url: "chrome-error://chromewebdata/",
        unreachableUrl: "file:///missing/resources/app.asar/out/renderer/index.html",
      },
      {
        currentIndex: 1,
        entries: [{ url: "file:///later", userTypedURL: "file:///typed", transitionType: "typed" }],
      },
      [
        {
          id: "same-page",
          type: "page",
          url: "x".repeat(2048),
          title: "t".repeat(2048),
          attached: true,
        },
      ],
      {
        pid: 123,
        version: "0.0.15",
        webContents: [
          {
            id: 2,
            type: "remote",
            url: "devtools://later",
            loading: false,
            isLoadingMainFrame: false,
            crashed: false,
            destroyed: false,
          },
        ],
      },
    ]);
    for (const sample of later.samples) {
      expect(sample.phase).toEqual(expect.any(String));
      expect(Date.parse(sample.startedAt)).toBeLessThanOrEqual(Date.parse(sample.completedAt));
      expect(sample.app).toEqual({
        exitCode: sample === later.samples.at(-1) ? 0 : null,
        signalCode: null,
      });
    }
    expect(f.evaluate.mock.calls[0]?.[1]).toBeGreaterThan(0);
    expect(f.evaluate.mock.calls[0]?.[1]).toBeLessThanOrEqual(500);
    expect(f.fetch_.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses distinct durable receipts for successive launches instead of the previous instance observation", async () => {
    const f = fixture();
    const error = new Error("Wrong renderer build.");
    await expect(failRendererLaunch(error, f.context)).rejects.toBe(error);
    const original = f.file(".primary.json").bytes;
    f.context.launchOrdinal++;
    f.context.rejectedUrl = "chrome-error://chromewebdata/";
    await expect(failRendererLaunch(error, f.context)).rejects.toBe(error);
    const primary = fs
      .readdirSync(f.context.evidence)
      .filter((name) => name.endsWith(".primary.json"));
    expect(primary).toHaveLength(2);
    expect(
      primary.map((name) => fs.readFileSync(join(f.context.evidence, name), "utf8")),
    ).toContain(original);
    expect(f.context.observations["instance"]).toEqual({ pid: 999 });
    expect(f.context.observations["rendererLaunchFailures"]).toHaveLength(2);
  });

  it.each(["rejection", "protocol-error"])(
    "retains %s failures without replacing the caller's Error",
    async (mode) => {
      const f = fixture();
      if (mode === "rejection") f.send.mockRejectedValue(new Error("page rejected"));
      else f.send.mockResolvedValue({ error: { code: -32601, message: "unsupported" } });
      f.fetch_.mockRejectedValue(new Error("listing rejected"));
      f.evaluate.mockRejectedValue(new Error("main rejected"));
      const error = new Error("Wrong renderer build.");
      const start = performance.now();
      await expect(failRendererLaunch(error, f.context)).rejects.toBe(error);
      expect(performance.now() - start).toBeLessThan(2500);
      const later = JSON.parse(f.file(".later.json").bytes) as LaterReceipt;
      expect(later.samples).toHaveLength(4);
      expect(
        later.samples
          .slice(0, 2)
          .every((sample) =>
            sample.error?.includes(mode === "rejection" ? "page rejected" : "unsupported"),
          ),
      ).toBe(true);
      expect(later.samples[2]?.error).toContain("listing rejected");
      expect(later.samples[3]?.error).toContain("main rejected");
    },
  );

  it("bounds uncooperative page/fetch/main queries to two seconds and makes no writes when they later settle", async () => {
    const f = fixture();
    const page = Promise.withResolvers<Awaited<ReturnType<Page["send"]>>>();
    const listing = Promise.withResolvers<Response>();
    const main = Promise.withResolvers<unknown>();
    f.send.mockReturnValue(page.promise);
    f.fetch_.mockReturnValue(listing.promise);
    f.evaluate.mockReturnValue(main.promise);
    const error = new Error("Wrong renderer build.");
    const start = performance.now();
    await expect(failRendererLaunch(error, f.context)).rejects.toBe(error);
    expect(performance.now() - start).toBeLessThan(2500);
    const later = JSON.parse(f.file(".later.json").bytes) as LaterReceipt;
    expect(later.samples).toHaveLength(4);
    expect(
      later.samples.every(
        (sample) => sample.error?.includes("timed out") || sample.error?.includes("deadline"),
      ),
    ).toBe(true);
    expect(f.fetch_.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    const durable = () =>
      fs
        .readdirSync(f.context.evidence)
        .map((name) => [name, fs.readFileSync(join(f.context.evidence, name), "utf8")]);
    const before = durable();
    const observed = JSON.stringify(f.context.observations);
    const writes = vi.mocked(fs.writeFileSync).mock.calls.length;
    page.reject(new Error("late page rejection"));
    listing.resolve(Response.json([{ url: "file:///late" }]));
    main.reject(new Error("late main rejection"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(durable()).toEqual(before);
    expect(JSON.stringify(f.context.observations)).toBe(observed);
    expect(vi.mocked(fs.writeFileSync).mock.calls).toHaveLength(writes);
  });

  it.each(["primary", "later"])(
    "retains the original Error when the %s receipt write fails",
    async (phase) => {
      const f = fixture();
      vi.mocked(fs.writeFileSync).mockImplementation((path, data, options) => {
        if (String(path).endsWith(`.${phase}.json`)) throw new Error("disk unavailable");
        write(path, data, options);
      });
      const error = new Error("Wrong renderer build.");
      const start = performance.now();
      await expect(failRendererLaunch(error, f.context)).rejects.toBe(error);
      expect(performance.now() - start).toBeLessThan(2500);
      expect(f.context.observations["rendererLaunchFailures"]).toEqual([
        expect.objectContaining({
          errors: [{ phase: `${phase}-write`, error: "Error: disk unavailable" }],
        }),
      ]);
      if (phase === "primary") {
        expect(f.send).not.toHaveBeenCalled();
        expect(f.fetch_).not.toHaveBeenCalled();
        expect(f.evaluate).not.toHaveBeenCalled();
        expect(fs.readdirSync(f.context.evidence)).toEqual([]);
      } else {
        expect(JSON.parse(f.file(".primary.json").bytes)).toMatchObject({
          rejectedUrl: "about:blank",
        });
        expect(fs.readdirSync(f.context.evidence)).toHaveLength(1);
      }
    },
  );
});
