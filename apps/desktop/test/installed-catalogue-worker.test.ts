import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { connect } from "./e2e/app.ts";
import { pauseMain, resumeMain } from "./e2e/installed-subtitles.ts";
import {
  installCatalogueWorkerProbe,
  type MainTransport,
  type Outcome,
} from "./e2e/installed-catalogue-worker.ts";

const expected = "file:///tmp/owned/resources/app.asar/out/main/catalogue-worker-test.js";
const dependency = expected.replace("catalogue-worker-test", "dependency-test");
const pid = 240024;
type Command = { id: number; method: string; params: Record<string, unknown> };
function success<T>(result: Outcome<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Speaks the private NodeWorker protocol at its main transport boundary. */
class Transport implements MainTransport {
  listeners = new Map<string, (params: unknown) => void>();
  commands: Command[] = [];
  outer: string[] = [];
  pid = pid;
  replySession = "owned";
  respond = true;
  startupURL = expected;
  startupReason = "Break on start";
  beforeReply?: (command: Command) => void;
  deliveryError?: string;
  disableError?: string;
  on(method: string, listener: (params: unknown) => void) {
    this.listeners.set(method, listener);
    return () => {
      if (this.listeners.get(method) === listener) this.listeners.delete(method);
    };
  }
  event(method: string, params: unknown) {
    this.listeners.get(method)?.(params);
  }
  worker(message: unknown, sessionId = "owned") {
    this.event("NodeWorker.receivedMessageFromWorker", {
      sessionId,
      message: JSON.stringify(message),
    });
  }
  attach(url = expected, sessionId = "owned") {
    this.event("NodeWorker.attachedToWorker", {
      sessionId,
      workerInfo: { url, type: "worker" },
      waitingForDebugger: false,
    });
  }
  pause(reason = this.startupReason, url = this.startupURL) {
    this.worker({ method: "Debugger.scriptParsed", params: { scriptId: "startup", url } });
    this.worker({
      method: "Debugger.paused",
      params: {
        reason,
        callFrames: [
          { callFrameId: "frame", url: "", location: { scriptId: "startup", lineNumber: 0 } },
        ],
      },
    });
  }
  async send(method: string, params: Record<string, unknown> = {}) {
    this.outer.push(method);
    if (method === "NodeWorker.disable" && this.disableError) return { error: this.disableError };
    if (method === "NodeWorker.sendMessageToWorker") {
      const raw: unknown = JSON.parse(String(params.message));
      assert(
        object(raw) &&
          typeof raw.id === "number" &&
          typeof raw.method === "string" &&
          object(raw.params),
      );
      const command = { id: raw.id, method: raw.method, params: raw.params };
      this.commands.push(command);
      this.beforeReply?.(command);
      if (this.respond)
        this.worker(
          {
            id: command.id,
            result:
              command.method === "Debugger.evaluateOnCallFrame"
                ? { result: { type: "number", value: this.pid } }
                : {},
          },
          this.replySession,
        );
      if (
        command.method === "Runtime.runIfWaitingForDebugger" &&
        !this.commands.some((c) => c.method === "Debugger.evaluateOnCallFrame")
      )
        this.pause();
      if (command.method === "Debugger.resume")
        this.worker({ method: "Debugger.resumed", params: {} });
      if (this.deliveryError) return { error: this.deliveryError };
    }
    return { result: {} };
  }
}
function probe(main = new Transport(), startupScriptURLs: string[] = []) {
  return installCatalogueWorkerProbe({
    main,
    expectedWorker: expected,
    startupScriptURLs,
    verifiedMainPID: pid,
    timeoutMs: 50,
    evidence: () => undefined,
  });
}

describe("owned catalogue worker inspector startup", () => {
  it("observes without releasing code, preserves main listeners, and unregisters/disables on close", async () => {
    const main = new Transport();
    const mainPause = () => {};
    main.on("Debugger.paused", mainPause);
    const worker = probe(main);
    success(await worker.ready);
    main.attach();
    expect(success(await worker.observe()).kind).toBe("no-startup-pause");
    expect(main.commands.map((c) => c.method)).toEqual(["Debugger.enable"]);
    expect((await worker.close()).errors).toEqual([]);
    await worker.close();
    expect(main.outer.filter((m) => m === "NodeWorker.disable")).toHaveLength(1);
    expect([...main.listeners.values()]).toEqual([mainPause]);
    main.attach();
    expect(main.commands).toHaveLength(1);
  });

  it("releases inherited inspector wait and resumes exactly one verified startup", async () => {
    const main = new Transport();
    const worker = probe(main, [dependency]);
    main.startupURL = dependency;
    success(await worker.ready);
    const startup = worker.start(100);
    main.attach(expected.replace("/owned/", "/foreign/"));
    main.worker({ method: "Debugger.paused", params: {} }, "foreign");
    main.attach();
    expect(success(await startup)).toMatchObject({
      pid,
      sessionId: "owned",
      workerURL: expected,
      frameURL: dependency,
    });
    main.pause("other");
    await worker.settle();
    expect((await worker.resumeStartup()).ok).toBe(false);
    expect(main.commands.filter((c) => c.method === "Debugger.resume")).toHaveLength(1);
    await worker.close();
  });

  it.each(["pid", "script", "reason", "session", "delivery"])(
    "fails closed for wrong %s",
    async (scenario) => {
      const main = new Transport();
      if (scenario === "pid") main.pid++;
      if (scenario === "script")
        main.startupURL = expected.replace("catalogue-worker-test", "unlisted");
      if (scenario === "reason") main.startupReason = "other";
      if (scenario === "session") main.replySession = "foreign";
      if (scenario === "delivery") main.deliveryError = "rejected outer delivery";
      const worker = probe(main);
      success(await worker.ready);
      const startup = worker.start(100);
      main.attach();
      expect((await startup).ok).toBe(false);
      expect(main.commands.some((c) => c.method === "Debugger.resume")).toBe(false);
      const closed = await worker.close();
      expect(closed.errors.length).toBeGreaterThan(0);
      expect(closed.pendingCommands + closed.pendingTasks).toBe(0);
      expect(main.listeners.size).toBe(0);
    },
  );

  it.each(["pid", "pause", "script", "detach", "duplicate"])(
    "revalidates %s before resume",
    async (scenario) => {
      const main = new Transport();
      const worker = probe(main, [dependency]);
      main.startupURL = dependency;
      success(await worker.ready);
      main.attach();
      await worker.settle();
      success(await worker.runToStartupPause());
      if (scenario === "pid") main.pid++;
      else
        main.beforeReply = (request) => {
          if (request.method !== "Debugger.evaluateOnCallFrame") return;
          if (scenario === "pause") main.pause("other");
          if (scenario === "script")
            main.worker({
              method: "Debugger.scriptParsed",
              params: { scriptId: "startup", url: expected },
            });
          if (scenario === "detach")
            main.event("NodeWorker.detachedFromWorker", { sessionId: "owned" });
          if (scenario === "duplicate") main.attach(expected, "second");
        };
      expect((await worker.resumeStartup()).ok).toBe(false);
      expect(main.commands.some((c) => c.method === "Debugger.resume")).toBe(false);
      const closed = await worker.close();
      expect(closed.pendingCommands + closed.pendingTasks).toBe(0);
    },
  );

  it("accepts an already delivered startup pause and prevents concurrent or repeated resume", async () => {
    const main = new Transport();
    const worker = probe(main);
    success(await worker.ready);
    main.attach();
    main.pause();
    const started = success(await worker.start(100));
    expect(started.reason).toBe("Break on start");
    expect(main.commands.filter((c) => c.method === "Debugger.resume")).toHaveLength(1);
    expect((await worker.resumeStartup()).ok).toBe(false);
    await worker.close();

    const concurrentMain = new Transport();
    const concurrent = probe(concurrentMain);
    success(await concurrent.ready);
    concurrentMain.attach();
    await concurrent.settle();
    success(await concurrent.runToStartupPause());
    const results = await Promise.all([concurrent.resumeStartup(), concurrent.resumeStartup()]);
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(concurrentMain.commands.some((c) => c.method === "Debugger.resume")).toBe(false);
    await concurrent.close();
  });

  it("cancels and joins attachment wait, retaining disable failures", async () => {
    const main = new Transport();
    const worker = probe(main);
    success(await worker.ready);
    const pending = worker.start(120_000);
    await delay(0);
    main.disableError = "disable failed";
    const closed = await worker.close();
    expect((await pending).ok).toBe(false);
    expect(closed.errors).toContain("NodeWorker.disable: disable failed");
    expect(closed.pendingCommands + closed.pendingTasks).toBe(0);
    expect(main.listeners.size).toBe(0);
  });

  it("retains synchronous evidence failures and drains malformed/late worker replies", async () => {
    const main = new Transport();
    const worker = installCatalogueWorkerProbe({
      main,
      expectedWorker: expected,
      verifiedMainPID: pid,
      timeoutMs: 30,
      evidence: () => {
        throw new Error("evidence failed");
      },
    });
    await worker.ready;
    expect((await worker.close()).errors).toContain("evidence failed");
    const clean = probe(main);
    success(await clean.ready);
    main.respond = false;
    main.attach();
    await delay(0);
    main.event("NodeWorker.receivedMessageFromWorker", { sessionId: "owned", message: "{" });
    const closed = await clean.close();
    main.worker({ id: 1, result: {} });
    expect(closed.errors.length).toBeGreaterThan(0);
    expect(closed.pendingCommands + closed.pendingTasks).toBe(0);
  });

  it("accepts canonical Mac and Windows paths with spaces and rejects expanded allowlists", async () => {
    for (const entry of [
      expected.replace("resources", "Resources"),
      "file:///C:/Program%20Files/Mr%20Streamer/resources/app.asar/out/main/catalogue-worker-test.js",
    ]) {
      const main = new Transport();
      const worker = installCatalogueWorkerProbe({
        main,
        expectedWorker: entry,
        verifiedMainPID: pid,
        evidence: () => undefined,
      });
      success(await worker.ready);
      main.attach(entry);
      await worker.settle();
      expect(worker.state().workerURL).toBe(entry);
      expect((await worker.close()).errors).toEqual([]);
    }
    for (const urls of [
      [dependency, dependency],
      [expected],
      [`${dependency}?x=1`],
      [dependency.replace("/owned/", "/other/")],
      [dependency.replace("dependency-test", "nested/dependency-test")],
      [dependency.replace("dependency", "%64ependency")],
    ]) {
      const main = new Transport();
      expect(() => probe(main, urls)).toThrow();
      expect(main.listeners.size).toBe(0);
    }
  });
});

it.each([false, true])(
  "real Node24 worker holds startup until guarded resume, nested ESM dependency=%s",
  async (nested) => {
    const root = await mkdtemp(join(tmpdir(), "owned catalogue worker "));
    const scripts = join(root, "Resources", "app.asar", "out", "main");
    const entry = join(scripts, "catalogue-worker-test.js");
    await mkdir(scripts, { recursive: true });
    await writeFile(join(root, "Resources", "app.asar", "package.json"), '{"type":"module"}');
    await writeFile(join(scripts, "dependency.js"), 'import "./nested.js";\n');
    await writeFile(join(scripts, "nested.js"), "globalThis.catalogueDependency = true;\n");
    await writeFile(
      entry,
      `${nested ? 'import "./dependency.js";\n' : ""}import { parentPort } from "node:worker_threads"; parentPort.postMessage({phase:"started",pid:process.pid}); setTimeout(()=>{debugger; parentPort.postMessage({phase:"later"}); process.exitCode=7},10);`,
    );
    const mainPath = join(root, "main.cjs");
    await writeFile(
      mainPath,
      `const {Worker}=require("node:worker_threads"); const w=new Worker(${JSON.stringify(entry)}); w.on("message",m=>console.log(JSON.stringify(m))); w.on("exit",code=>process.exitCode=code); w.on("error",e=>{console.error(e);process.exitCode=19});`,
    );
    const child = spawn(process.execPath, ["--inspect-brk=127.0.0.1:0", mainPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "" },
    });
    const ended = once(child, "exit");
    let output = "";
    child.stdout.on("data", (bytes: Buffer) => {
      output += bytes;
    });
    let main: Awaited<ReturnType<typeof connect>> | undefined;
    let worker: ReturnType<typeof installCatalogueWorkerProbe> | undefined;
    let laterPause = false;
    let inheritedWaitFlag: unknown;
    async function until(check: () => boolean) {
      const deadline = Date.now() + 5_000;
      while (!check() && Date.now() < deadline) await delay(10);
      expect(check()).toBe(true);
    }
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let stderr = "";
        const timer = setTimeout(() => reject(new Error("Inspector startup timed out")), 5_000);
        child.stderr.on("data", (bytes: Buffer) => {
          stderr += bytes;
          const match = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);
          if (match) {
            clearTimeout(timer);
            resolve(Number(match[1]));
          }
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      main = await connect(port, "node");
      const paused = await pauseMain(main);
      expect(await paused.evaluate("process.pid")).toBe(child.pid);
      worker = installCatalogueWorkerProbe({
        main,
        expectedWorker: pathToFileURL(entry).href,
        verifiedMainPID: child.pid!,
        timeoutMs: 500,
        startupScriptURLs: nested
          ? ["dependency.js", "nested.js"].map((name) => pathToFileURL(join(scripts, name)).href)
          : [],
        evidence: (event) => {
          if (event.kind === "worker-attached" && object(event.data))
            inheritedWaitFlag = event.data.waitingForDebugger;
          if (
            event.kind === "worker-message" &&
            object(event.data) &&
            event.data.method === "Debugger.paused" &&
            object(event.data.params) &&
            event.data.params.reason === "other"
          )
            laterPause = true;
          return undefined;
        },
      });
      success(await worker.ready);
      await resumeMain(main);
      await until(() => !!worker?.state().sessionId);
      expect(success(await worker.observe()).kind).toBe("no-startup-pause");
      expect(output).toBe("");
      expect(inheritedWaitFlag).toBe(false);
      const startup = success(await worker.runToStartupPause());
      expect(startup.pid).toBe(child.pid);
      expect(startup.frameURL).toBe(
        pathToFileURL(nested ? join(scripts, "nested.js") : entry).href,
      );
      expect(output).toBe("");
      success(await worker.resumeStartup());
      await until(() => laterPause && output.includes('"started"'));
      expect(output).not.toContain('"later"');
      expect((await worker.close()).errors).toEqual([]);
      // Inspector cleanup releases the test's later pause without a Debugger.resume command.
      main.close();
      await until(() => child.exitCode !== null);
      expect(await ended).toEqual([7, null]);
      expect(output).toContain('"later"');
    } finally {
      if (worker && !worker.state().closed) await worker.close();
      main?.close();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await ended;
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
