import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "./app.ts";

type LaunchFailure = {
  evidence: string;
  observations: Record<string, unknown>;
  page: Pick<Page, "send">;
  mainPage: { evaluate(expression: string, timeoutMs: number): Promise<unknown> };
  app: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">;
  rejectedUrl: string;
  comparedMainPid: number;
  browserArguments: readonly unknown[];
  pagePort: number;
  inspectorPort: number;
  profile: string;
  target: { version: string; source: string; executable: string | undefined };
  launchOrdinal: number;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Later samples are allowlisted and bounded. The primary rejected URL stays exact.
function fields(value: unknown, names: readonly string[]) {
  const result: Record<string, string | number | boolean> = {};
  if (record(value))
    for (const name of names) {
      const field = value[name];
      if (typeof field === "string") result[name] = field.slice(0, 2048);
      else if (typeof field === "number" || typeof field === "boolean") result[name] = field;
    }
  return result;
}

/** Retains evidence before cleanup, then throws the caller's exact error regardless of diagnostics. */
export async function failRendererLaunch(error: Error, context: LaunchFailure): Promise<never> {
  const link: {
    launchOrdinal: number;
    primaryFile?: string;
    laterFile?: string;
    errors: { phase: string; error: string }[];
  } = { launchOrdinal: context.launchOrdinal, errors: [] };
  let phase = "primary-write";
  try {
    const guardTime = new Date().toISOString();
    const name = `renderer-launch-failure-${context.launchOrdinal}-${randomUUID()}`;
    const primaryFile = `${name}.primary.json`;
    const laterFile = `${name}.later.json`;
    const previous = context.observations["rendererLaunchFailures"];
    context.observations["rendererLaunchFailures"] = [
      ...(Array.isArray(previous) ? previous : []),
      link,
    ];
    // Synchronous, exclusive writes cannot finish after this helper returns or replace a receipt.
    writeFileSync(
      join(context.evidence, primaryFile),
      JSON.stringify(
        {
          kind: "renderer-launch-failure-primary",
          guardTime,
          launchOrdinal: context.launchOrdinal,
          rejectedUrl: context.rejectedUrl,
          spawnedMainPid: context.app.pid,
          comparedMainPid: context.comparedMainPid,
          browserArguments: context.browserArguments,
          pagePort: context.pagePort,
          inspectorPort: context.inspectorPort,
          profile: context.profile,
          target: { ...context.target, executable: context.target.executable ?? null },
          originalSelectedListing: "unavailable",
          error: { name: error.name, message: error.message },
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    link.primaryFile = primaryFile;
    phase = "later-write";
    const deadline = performance.now() + 2000;
    const appStatus = () => ({
      exitCode: context.app.exitCode,
      signalCode: context.app.signalCode,
    });
    const samples: {
      phase: string;
      startedAt: string;
      completedAt: string;
      app: ReturnType<typeof appStatus>;
      result?: unknown;
      error?: string;
    }[] = [];
    const sample = async (phase: string, read: (timeoutMs: number) => Promise<unknown>) => {
      const startedAt = new Date().toISOString();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let outcome: { result?: unknown; error?: string };
      try {
        const timeoutMs = Math.min(500, Math.floor(deadline - performance.now()));
        if (timeoutMs <= 0) throw new Error("Diagnostic deadline exhausted");
        outcome = {
          result: await Promise.race([
            // The race handles late rejection even if a reader ignores its own timeout.
            Promise.resolve().then(() => read(timeoutMs)),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Diagnostic query timed out")), timeoutMs);
            }),
          ]),
        };
      } catch (error) {
        outcome = { error: String(error) };
      } finally {
        clearTimeout(timer);
      }
      samples.push({
        phase,
        startedAt,
        completedAt: new Date().toISOString(),
        app: appStatus(),
        ...outcome,
      });
    };
    const pageRead = async (method: string, timeoutMs: number) => {
      const reply = await context.page.send(method, {}, timeoutMs);
      if (reply.error !== undefined) throw new Error(JSON.stringify(reply.error));
      return reply.result;
    };
    // These first reads use the same page socket as the rejected location evaluation.
    await sample("same-page-frame-tree", async (timeoutMs) => {
      const result = await pageRead("Page.getFrameTree", timeoutMs);
      if (!record(result) || !record(result["frameTree"])) throw new Error("No frame tree");
      return fields(result["frameTree"]["frame"], ["id", "loaderId", "url", "unreachableUrl"]);
    });
    await sample("same-page-navigation-history", async (timeoutMs) => {
      const result = await pageRead("Page.getNavigationHistory", timeoutMs);
      if (!record(result) || !Array.isArray(result["entries"]))
        throw new Error("No navigation history");
      return {
        ...fields(result, ["currentIndex"]),
        entries: result["entries"].map((entry: unknown) =>
          fields(entry, ["url", "userTypedURL", "transitionType"]),
        ),
      };
    });
    await sample("later-target-list", async (timeoutMs) => {
      const response = await fetch(`http://127.0.0.1:${context.pagePort}/json/list`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Target listing HTTP ${response.status}`);
      const targets: unknown = await response.json();
      if (!Array.isArray(targets)) throw new Error("No target list");
      return targets.map((target: unknown) =>
        fields(target, ["id", "type", "url", "title", "attached"]),
      );
    });
    await sample("later-main-identity-and-webcontents", async (timeoutMs) => {
      const result = await context.mainPage.evaluate(
        `(() => {
        const {app, webContents} = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
        return {pid:process.pid, executable:process.execPath, resources:process.resourcesPath,
          appPath:app.getAppPath(), version:app.getVersion(),
          webContents:webContents.getAllWebContents().map(contents => {
            const destroyed = contents.isDestroyed();
            return {id:contents.id, destroyed, ...(destroyed ? {} : {
              type:contents.getType(), url:contents.getURL(), loading:contents.isLoading(),
              isLoadingMainFrame:contents.isLoadingMainFrame(), crashed:contents.isCrashed()})};
          })};
      })()`,
        timeoutMs,
      );
      if (!record(result) || !Array.isArray(result["webContents"]))
        throw new Error("No main identity/webContents");
      return {
        ...fields(result, ["pid", "executable", "resources", "appPath", "version"]),
        webContents: result["webContents"].map((contents: unknown) =>
          fields(contents, [
            "id",
            "type",
            "url",
            "loading",
            "isLoadingMainFrame",
            "crashed",
            "destroyed",
          ]),
        ),
      };
    });
    // Text evidence has priority over an optional PNG; no snapshot/rAF/AX work is added here.
    writeFileSync(
      join(context.evidence, laterFile),
      JSON.stringify({ kind: "renderer-launch-failure-later", primaryFile, samples }, null, 2),
      { flag: "wx" },
    );
    link.laterFile = laterFile;
  } catch (diagnosticError) {
    link.errors.push({ phase, error: String(diagnosticError) });
  }
  throw error;
}
