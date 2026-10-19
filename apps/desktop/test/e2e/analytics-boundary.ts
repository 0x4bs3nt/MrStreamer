import type { AnalyticsRecord, UsageKey } from "../../src/main/analytics/model.ts";
import type { Page } from "./app.ts";

export type Boundary = {
  kind: "checkpoint" | "seal" | "reserve" | "retire" | "next";
  phase: "before" | "after";
  uuid?: string;
};
type Hit = {
  at: number;
  before: AnalyticsRecord;
  after: AnalyticsRecord;
  phase: Boundary["phase"];
};
type Measurement = {
  from: string;
  at: number;
  ms: number;
  code: string | null;
  index: number;
  pid: number;
  to: string;
  startedAt: string;
  endedAt: string;
  errno?: number;
  syscall?: string;
  path?: string;
  dest?: string;
  errorName?: string;
  errorMessage?: string;
};
type Reader = {
  mode: "default" | "exclusive";
  key: UsageKey;
  flags: string | number;
  node: string;
  uv: string;
  electron: string | undefined;
  from: string;
  tempBase64: string;
  tempSha256: string;
  attempts: number;
  firstCode?: string | null;
  lastCode?: string | null;
  openedAt?: number;
  closedAt?: number;
  openError?: string;
  captureError?: string;
  destinationSha256?: string;
};

/** Holds one public filesystem promise around a real atomic rename, never an analytics method. */
export async function boundary(main: Page, profile: string, directory?: string) {
  directory ??= await main.evaluate<string>(
    `process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.getPath('userData')`,
  );
  const attachment = await main.evaluate<Awaited<ReturnType<typeof install>>>(
    `(${install.toString()})(${JSON.stringify(profile)},${JSON.stringify(directory)})`,
  );
  return {
    attachment,
    arm: async (spec: Boundary) => {
      await main.evaluate(`globalThis.__nativeTelemetryFS.arm(${JSON.stringify(spec)})`);
    },
    hit: () => main.evaluate<Hit | null>("globalThis.__nativeTelemetryFS.hit"),
    release: () => main.evaluate("globalThis.__nativeTelemetryFS.release()"),
    reader: (mode: Reader["mode"], key: UsageKey) =>
      main.evaluate(
        `globalThis.__nativeTelemetryFS.reader(${JSON.stringify(mode)},${JSON.stringify(key)})`,
      ),
    readers: () => main.evaluate<Reader[]>("globalThis.__nativeTelemetryFS.readers"),
    measurements: () => main.evaluate<Measurement[]>("globalThis.__nativeTelemetryFS.measurements"),
    restore: () => main.evaluate("globalThis.__nativeTelemetryFS.restore()"),
  };
}

async function install(profile: string, directory: string) {
  const fs = process.getBuiltinModule("fs").promises;
  const nativeFS = process.getBuiltinModule("fs");
  const { createHash } = process.getBuiltinModule("crypto");
  const path = process.getBuiltinModule("path");
  const { syncBuiltinESMExports } = process.getBuiltinModule("module");
  if (
    !process.argv.includes(`--user-data-dir=${profile}`) ||
    !process.argv.includes("--enable-automation")
  )
    throw new Error("Filesystem probe requires the owned automated profile");
  // Compare ownership by realpath for Windows 8.3/long names and macOS /var versus /private/var aliases.
  // Keep the actual userData string for matching: Windows may retain the short name.
  // Canonicalizing the destination would miss those renames; resolve nothing per rename.
  const ownedReal = await fs.realpath(profile);
  const appReal = directory === profile ? ownedReal : await fs.realpath(directory);
  if (appReal !== ownedReal)
    throw new Error("Filesystem probe directory differs from the owned profile");
  const original = fs.rename;
  const destination = path.join(directory, "analytics.json");
  const read = async (file: string) =>
    JSON.parse(await fs.readFile(file, "utf8")) as AnalyticsRecord;
  const queue = (record: AnalyticsRecord) => record.summaries?.pending ?? [];
  let spec: Boundary | null = null;
  let release: (() => void) | null = null;
  let reader: Pick<Reader, "mode" | "key"> | null = null;
  let recovering: Reader | null = null;
  let operationIndex = 0;
  const probe = {
    hit: null as Hit | null,
    measurements: [] as Measurement[],
    readers: [] as Reader[],
    arm(next: Boundary) {
      if (spec || release || reader) throw new Error("Filesystem boundary already armed");
      spec = next;
      probe.hit = null;
    },
    reader(mode: Reader["mode"], key: UsageKey) {
      if (process.platform !== "win32" || spec || release || reader)
        throw new Error("Real reader boundary requires idle Windows probe");
      reader = { mode, key };
    },
    release() {
      if (!release) throw new Error("No held filesystem operation");
      release();
      release = null;
    },
    restore() {
      if (release || fs.rename !== wrapped)
        throw new Error("Filesystem probe still held or changed owner");
      fs.rename = original;
      syncBuiltinESMExports();
      delete (globalThis as typeof globalThis & { __nativeTelemetryFS?: unknown })
        .__nativeTelemetryFS;
    },
  };
  const chosen = (uuid: string) => !spec?.uuid || uuid === spec.uuid;
  const counted = (record: AnalyticsRecord, key: UsageKey) =>
    [record.summaries?.usage, ...queue(record).map((item) => item.event)].reduce(
      (sum, event) =>
        sum + (event?.event === "usage_window" ? (event.properties.counts[key] ?? 0) : 0),
      0,
    );
  const matches = (before: AnalyticsRecord, after: AnalyticsRecord) => {
    switch (spec?.kind) {
      case "next":
        return true;
      case "checkpoint": {
        const journal = after.summaries?.unfinished;
        return (
          !!journal &&
          chosen(journal.event.uuid) &&
          JSON.stringify(journal) !== JSON.stringify(before.summaries?.unfinished)
        );
      }
      case "seal":
        return [before.summaries?.usage, before.summaries?.unfinished?.event].some(
          (event) =>
            event &&
            chosen(event.uuid) &&
            queue(after).some((item) => item.event.uuid === event.uuid),
        );
      case "reserve":
        return queue(after).some(
          (item) =>
            chosen(item.event.uuid) &&
            queue(before).some(
              (prior) =>
                prior.event.uuid === item.event.uuid && item.attempts === prior.attempts + 1,
            ),
        );
      case "retire":
        return queue(before).some(
          (item) =>
            chosen(item.event.uuid) &&
            !queue(after).some((next) => next.event.uuid === item.event.uuid),
        );
      default:
        return false;
    }
  };
  async function wrapped(
    from: Parameters<typeof fs.rename>[0],
    to: Parameters<typeof fs.rename>[1],
  ) {
    if (
      typeof from !== "string" ||
      to !== destination ||
      path.dirname(from) !== directory ||
      !/^analytics\.json\.[0-9a-f-]{36}\.tmp$/.test(path.basename(from))
    )
      return original(from, to);
    const started = performance.now();
    const startedAt = new Date().toISOString();
    const index = ++operationIndex;
    const before = spec ? await read(destination) : null;
    const after = spec ? await read(from) : null;
    const selected = before && after && matches(before, after) ? spec : null;
    const hold = async () => {
      if (!selected || !before || !after) return;
      spec = null;
      await new Promise<void>((resolve) => {
        release = resolve;
        probe.hit = { at: Date.now(), before, after, phase: selected.phase };
      });
    };
    if (selected?.phase === "before") await hold();
    let descriptor: number | undefined;
    if (reader) {
      const bytes = await fs.readFile(from);
      const after = JSON.parse(bytes.toString()) as AnalyticsRecord;
      if (counted(after, reader.key) > counted(await read(destination), reader.key)) {
        // libuv include/uv/win.h: UV_FS_O_EXLOCK=0x10000000, src/win/fs.c maps it to share=0.
        // The actual Windows rejection/recovery below validates support in this Electron runtime.
        const exported: unknown = Reflect.get(nativeFS.constants, "O_EXLOCK");
        recovering = {
          ...reader,
          flags:
            reader.mode === "default"
              ? "r"
              : nativeFS.constants.O_RDONLY |
                (typeof exported === "number" ? exported : 0x10000000),
          node: process.versions.node,
          uv: process.versions.uv,
          electron: process.versions.electron,
          from: path.basename(from),
          tempBase64: bytes.toString("base64"),
          tempSha256: createHash("sha256").update(bytes).digest("hex"),
          attempts: 0,
        };
        probe.readers.push(recovering);
        reader = null;
        try {
          descriptor = nativeFS.openSync(destination, recovering.flags);
          recovering.openedAt = Date.now();
        } catch (error) {
          // A failed open is diagnostic setup failure, never a fabricated rename rejection.
          recovering.openError = String(error);
        }
      }
    }
    const observed = recovering?.from === path.basename(from) ? recovering : null;
    let code: string | null = null;
    const failure: Partial<Measurement> = {};
    try {
      await original(from, to);
    } catch (error) {
      code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
      if (error instanceof Error) {
        failure.errorName = error.name;
        failure.errorMessage = error.message;
        if ("errno" in error && typeof error.errno === "number") failure.errno = error.errno;
        if ("syscall" in error && typeof error.syscall === "string")
          failure.syscall = error.syscall;
        if ("path" in error && (error.path === from || error.path === destination))
          failure.path = error.path;
        if ("dest" in error && error.dest === destination) failure.dest = error.dest;
      }
      throw error;
    } finally {
      // No CDP/PowerShell roundtrip: release before the product sees rejection and schedules retry.
      if (descriptor !== undefined) {
        try {
          nativeFS.closeSync(descriptor);
          if (observed) observed.closedAt = Date.now();
        } catch (error) {
          if (observed) observed.captureError = `close: ${String(error)}`;
        }
      }
      probe.measurements.push({
        from: path.basename(from),
        at: Date.now(),
        ms: performance.now() - started,
        code,
        index,
        pid: process.pid,
        to: path.basename(to),
        startedAt,
        endedAt: new Date().toISOString(),
        ...failure,
      });
      if (observed) {
        observed.attempts++;
        if (observed.attempts === 1) observed.firstCode = code;
        observed.lastCode = code;
        if (code === null)
          try {
            observed.destinationSha256 = createHash("sha256")
              .update(nativeFS.readFileSync(destination))
              .digest("hex");
          } catch (error) {
            observed.captureError = String(error);
          }
      }
    }
    if (selected?.phase === "after") await hold();
  }
  const global = globalThis as typeof globalThis & { __nativeTelemetryFS?: typeof probe };
  if (global.__nativeTelemetryFS) throw new Error("Filesystem probe already installed");
  global.__nativeTelemetryFS = probe;
  fs.rename = wrapped;
  syncBuiltinESMExports();
  return {
    pid: process.pid,
    profile,
    directory,
    ownedReal,
    appReal,
    boundary: "actual public fs.rename on owned analytics.json",
  };
}
