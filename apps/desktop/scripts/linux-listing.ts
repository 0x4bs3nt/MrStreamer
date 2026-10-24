// Native Linux capture support for marketing-capture.ts. Owns its X server and window manager;
// ImageMagick reads the whole X window directly. No pixel editing or synthetic decoration.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import manifest from "../../../docs/assets/marketing-demo-sources.json" with { type: "json" };
import { delay, waitFor } from "../test/e2e/app.ts";

/** Even a complete derived cache must retain the approved original downloads and match them. */
export async function verifyLinuxSources(cache: string) {
  const sources = [];
  for (const [name, source] of Object.entries(manifest.sources)) {
    const file = join(cache, source.file);
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    const sha256 = digest.digest("hex");
    const bytes = statSync(file).size;
    if (sha256 !== source.sha256 || bytes !== source.bytes)
      throw new Error(`Unapproved original media: ${file}`);
    sources.push({
      name,
      file: source.file,
      url: source.url,
      credit: source.credit,
      bytes,
      sha256,
    });
  }
  return sources;
}

/** Start a private display using a locally extracted Ubuntu Openbox/x11-utils prefix. */
export async function startLinuxListing(toolsDirectory: string, evidence: string) {
  if (process.platform !== "linux") throw new Error("Linux listing captures require Linux.");
  const tools = resolve(toolsDirectory);
  const processes: ChildProcess[] = [];
  let logs = "";
  const launch = (command: string, args: string[], env: NodeJS.ProcessEnv) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
    processes.push(child);
    child.on("error", (error) => {
      logs += `${command}: ${error}\n`;
    });
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk: Buffer) => {
        logs += chunk.toString();
      });
    return child;
  };
  const close = async () => {
    for (const child of processes.toReversed()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill("SIGTERM");
      for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++)
        await delay(100);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await waitFor(async () => child.exitCode !== null || child.signalCode !== null);
    }
    writeFileSync(join(evidence, "x-session.log"), logs);
    return processes.map((child) => ({
      pid: child.pid,
      exited: child.exitCode !== null || child.signalCode !== null,
    }));
  };
  try {
    const x = launch(
      "Xvfb",
      ["-displayfd", "3", "-screen", "0", "1400x1000x24", "-nolisten", "tcp", "-ac"],
      process.env,
    );
    let displayNumber = "";
    x.stdio[3]?.on("data", (chunk: Buffer) => {
      displayNumber += chunk.toString();
    });
    await waitFor(async () => /^\d+\s*$/.test(displayNumber));
    const env = {
      ...process.env,
      DISPLAY: `:${displayNumber.trim()}`,
      LD_LIBRARY_PATH: [join(tools, "usr/lib/x86_64-linux-gnu"), process.env["LD_LIBRARY_PATH"]]
        .filter(Boolean)
        .join(":"),
      XDG_DATA_DIRS: `${join(tools, "usr/share")}:/usr/local/share:/usr/share`,
    };
    const run = (command: string, args: string[]) =>
      execFileSync(command, args, { env, encoding: "utf8" });
    const xprop = join(tools, "usr/bin/xprop");
    const xwininfo = join(tools, "usr/bin/xwininfo");
    const wm = launch(
      join(tools, "usr/bin/openbox"),
      ["--config-file", join(tools, "etc/xdg/openbox/rc.xml"), "--sm-disable"],
      env,
    );
    await waitFor(async () =>
      run(xprop, ["-root", "_NET_SUPPORTING_WM_CHECK"]).includes("window id #"),
    );
    const identity = {
      display: env.DISPLAY,
      xvfbPid: x.pid,
      wmPid: wm.pid,
      windowManager: run(join(tools, "usr/bin/openbox"), ["--version"]).trim(),
      screen: "1400x1000x24",
      compositor: "none",
      tools,
      toolsSha256: Object.fromEntries(
        ["openbox", "xprop", "xwininfo"].map((name) => [
          name,
          createHash("sha256")
            .update(readFileSync(join(tools, "usr/bin", name)))
            .digest("hex"),
        ]),
      ),
      importVersion: run("import", ["-version"]),
      limitations: [
        "Openbox is noncomposited: no compositor shadow, transparent padding or rounded outer corners are supplied. Flathub quality acceptance remains open.",
      ],
    };
    writeFileSync(join(evidence, "x-session.json"), JSON.stringify(identity, null, 2));
    const ownedWindow = (pid: number) => {
      const windows = run("wmctrl", ["-lp"]);
      const owned = windows
        .split("\n")
        .filter(
          (row) => Number(row.trim().split(/\s+/)[2]) === pid && row.endsWith("Mr. Streamer"),
        );
      const id = owned[0]?.split(/\s+/)[0];
      if (owned.length !== 1 || !id)
        throw new Error(`Expected one owned window for PID ${pid}: ${windows}`);
      return { id, windows };
    };
    return {
      env,
      identity,
      close,
      async resize(pid: number) {
        // CDP can connect before ready-to-show maps the native window into the WM's client list.
        await waitFor(async () =>
          run("wmctrl", ["-lp"])
            .split("\n")
            .some(
              (row) => Number(row.trim().split(/\s+/)[2]) === pid && row.endsWith("Mr. Streamer"),
            ),
        );
        const { id } = ownedWindow(pid);
        run("wmctrl", ["-ir", id, "-b", "remove,maximized_vert,maximized_horz"]);
        run("wmctrl", ["-ir", id, "-e", "0,100,100,1000,700"]);
        await delay(600);
        return run(xwininfo, ["-id", id, "-stats"]);
      },
      async capture(pid: number, name: string) {
        const { id, windows } = ownedWindow(pid);
        const properties = run(xprop, [
          "-id",
          id,
          "_NET_WM_PID",
          "_NET_WM_STATE",
          "_MOTIF_WM_HINTS",
          "_NET_FRAME_EXTENTS",
        ]);
        if (
          !properties.includes(`= ${pid}\n`) ||
          /_NET_WM_STATE_(FULLSCREEN|MAXIMIZED)/.test(properties)
        )
          throw new Error(`Wrong PID or fullscreen/maximized window: ${properties}`);
        const geometry = run(xwininfo, ["-id", id, "-tree", "-stats"]);
        const raw = join(evidence, `${name}-window.png`);
        // -frame includes the actual window-manager frame. No crop, resize, alpha edits or overlays.
        run("import", ["-silent", "-window", id, "-frame", raw]);
        const metadata = await sharp(raw).metadata();
        if (!metadata.width || !metadata.height || metadata.width < 960 || metadata.height < 600)
          throw new Error(`Incomplete native window: ${raw}`);
        const bytes = readFileSync(raw);
        const native = {
          id,
          pid,
          windows,
          properties,
          geometry,
          width: metadata.width,
          height: metadata.height,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          hasAlpha: metadata.hasAlpha,
          command: ["import", "-silent", "-window", id, "-frame", raw],
          raw,
        };
        writeFileSync(join(evidence, `${name}-window.json`), JSON.stringify(native, null, 2));
        return native;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
