// What the installed upgrade check does to the Windows machine it runs on: the per-user NSIS
// install, the process tree of each app instance it starts, and the outbound block on the
// installed app and its bundled ffmpeg for the offline part. It refuses anywhere but a
// GitHub-hosted runner with no Mr. Streamer installed, never stops a process it didn't start, and
// takes back only the firewall rules, profile and audit settings it changed. The runner's disposal
// is the outer boundary for anything a failure leaves behind.
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** The disposable runner and the install this run owns on it. */
export interface Runner {
  /** Unique to this attempt of this run, for the firewall rules' names. */
  readonly id: string;
  readonly temp: string;
  /** Where the per-user setup installs: %LOCALAPPDATA%\Programs\mrstreamer. */
  readonly installRoot: string;
  readonly executable: string;
  /** The bundled ffmpeg and ffprobe, which the offline part blocks with the app. */
  readonly tools: readonly string[];
}

/** Refuses anywhere but a GitHub-hosted Windows runner, where installing replaces nobody's app. */
export function disposableRunner(): Runner {
  const env = process.env;
  if (process.platform !== "win32") throw new Error("This check installs on Windows only.");
  if (env["GITHUB_ACTIONS"] !== "true" || env["RUNNER_ENVIRONMENT"] !== "github-hosted")
    throw new Error("This check runs only on a GitHub-hosted runner, never on a person's PC.");
  const [temp, local, run, attempt] = [
    env["RUNNER_TEMP"],
    env["LOCALAPPDATA"],
    env["GITHUB_RUN_ID"],
    env["GITHUB_RUN_ATTEMPT"],
  ];
  if (!temp || !local || !run || !attempt) throw new Error("The runner's environment is missing.");
  const installRoot = join(local, "Programs", "mrstreamer");
  return {
    id: `mrstreamer-upgrade-${run}-${attempt}-${crypto.randomUUID().slice(0, 8)}`,
    temp,
    installRoot,
    executable: join(installRoot, "Mr. Streamer.exe"),
    tools: ["ffmpeg.exe", "ffprobe.exe"].map((name) =>
      join(installRoot, "resources", "ffmpeg", name),
    ),
  };
}

/** Runs a PowerShell script, with values passed as environment variables rather than quoted in. */
function powershell(script: string, values: Record<string, string> = {}): string {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", env: { ...process.env, ...values }, maxBuffer: 64 * 1024 * 1024 },
  ).trim();
}

/** A PowerShell script's array, written with ConvertTo-Json -InputObject @(...). */
function list<T>(script: string, values?: Record<string, string>): T[] {
  return JSON.parse(powershell(script, values) || "[]") as T[];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const inside = (root: string, path: string | null) =>
  !!path && path.toLowerCase().startsWith(`${root.toLowerCase()}\\`);

export const fileSha256 = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });

export interface WinProcess {
  readonly pid: number;
  readonly parent: number;
  readonly name: string;
  readonly path: string | null;
  /** When it started, UTC: with the id, it tells a process from a later one given that id. */
  readonly created: string;
}

export function processes(): WinProcess[] {
  return list<WinProcess>(`
    $all = Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{
      pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; name = [string]$_.Name
      path = $_.ExecutablePath
      created = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }) } }
    ConvertTo-Json -Compress -InputObject @($all)`);
}

/** Every Mr. Streamer process on the machine, by name or by where it runs from. */
function appProcesses(runner: Runner): WinProcess[] {
  return processes().filter(
    (each) => same(each.name, "Mr. Streamer.exe") || inside(runner.installRoot, each.path),
  );
}

/** Fails while any Mr. Streamer runs: the setup stops them by name, whoever started them. */
export function assertNoAppRunning(runner: Runner, when: string): void {
  const running = appProcesses(runner);
  if (running.length > 0)
    throw new Error(
      `${when}: Mr. Streamer processes run (${running.map((p) => p.pid).join(", ")}).`,
    );
}

const key = (each: WinProcess) => `${each.pid}@${each.created}`;

/** The app as this run started it: its handle, unlike its id, never names another program. */
export type Started = Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill">;

/**
 * The process tree of one app instance this run started: the app and everything it started.
 * The root is pinned by id and start time as soon as it is made, and must run the installed
 * executable. Each `sample` follows only parents that still run under the id and start time this
 * run saw, so a reused id never makes another program, or its children, ours. An app that can't
 * be pinned is killed through its handle, which names nothing else, and refused. Nothing is ever
 * stopped by its id: an id read a moment ago may name another program by the time it is used.
 * `childGraceMs` is how long the children get to end after the app; tests shorten it.
 */
export function ownedTree(runner: Runner, app: Started, childGraceMs = 20_000) {
  const exited = () => app.exitCode !== null || app.signalCode !== null;
  const root = processes().find((each) => each.pid === app.pid);
  if (!root || exited() || !same(root.path ?? "", runner.executable)) {
    app.kill("SIGKILL");
    throw new Error(
      `Process ${app.pid} can't be shown to be the installed app this run started: ${JSON.stringify(root ?? null)}.`,
    );
  }
  const owned = new Map([[key(root), root]]);
  /** The owned processes running now, after adding the children of those. */
  const alive = () => {
    const all = processes();
    let parents = all.filter((each) => owned.has(key(each)));
    while (parents.length > 0) {
      const children = all.filter(
        (each) =>
          !owned.has(key(each)) &&
          parents.some((parent) => parent.pid === each.parent && each.created >= parent.created),
      );
      for (const child of children) owned.set(key(child), child);
      parents = children;
    }
    return all.filter((each) => owned.has(key(each)));
  };
  return {
    root,
    sample: () => void alive(),
    /**
     * Ends the instance: the window closes as a user's would, then, only if that leaves the app
     * running, the app is killed through its handle. Its children get `childGraceMs`, twenty
     * seconds by default, to end with it. Fails when anything of the tree, or any other process
     * from the install folder, is still there: the setup must not replace files in use. What is
     * left runs on, with the profile, until the runner is thrown away.
     */
    async stop(close: () => Promise<unknown>) {
      alive();
      const forced: string[] = [];
      await close().catch(() => undefined);
      for (let i = 0; i < 150 && !exited(); i++) await delay(100);
      if (!exited()) {
        forced.push(`kill ${root.pid} through its handle`);
        app.kill("SIGKILL");
        for (let i = 0; i < 50 && !exited(); i++) await delay(100);
      }
      const until = Date.now() + childGraceMs;
      while (alive().length > 0 && Date.now() < until) await delay(200);
      const remaining = alive();
      const others = appProcesses(runner).filter((each) => !owned.has(key(each)));
      if (!exited() || remaining.length > 0 || others.length > 0)
        throw new Error(
          `The app's processes did not all end, and are left to the runner's disposal: ${[...remaining, ...others].map((p) => `${p.pid} ${p.name}`).join(", ") || root.pid}.`,
        );
      return {
        owned: [...owned.values()].map(({ pid, parent, name, created }) => ({
          pid,
          parent,
          name,
          created,
        })),
        graceful: forced.length === 0,
        forced,
        remaining: 0,
      };
    },
  };
}

interface UninstallEntry {
  readonly DisplayName: string;
  readonly DisplayVersion: string | null;
  readonly UninstallString: string | null;
  readonly QuietUninstallString: string | null;
}

/** Mr. Streamer's entries under Installed apps, for this user and the machine. */
function uninstallEntries(): UninstallEntry[] {
  return list<UninstallEntry>(`
    $keys = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
    $found = Get-ItemProperty $keys -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -like 'Mr. Streamer*' } |
      Select-Object DisplayName, DisplayVersion, UninstallString, QuietUninstallString
    ConvertTo-Json -Compress -InputObject @($found)`);
}

/** The uninstaller an entry names, which must be in the install folder, and its arguments. */
function uninstaller(runner: Runner, entry: UninstallEntry): { path: string; args: string[] } {
  const command = entry.QuietUninstallString ?? `${entry.UninstallString ?? ""} /S`;
  const match = /^"([^"]+)"\s*(.*)$/.exec(command.trim());
  if (!match || !inside(runner.installRoot, match[1]!))
    throw new Error(`Installed apps names an uninstaller outside the install: ${command}`);
  return { path: match[1]!, args: match[2]!.split(/\s+/).filter(Boolean) };
}

/**
 * Installs `setup` silently over `previous`, or onto a machine with no Mr. Streamer for the first,
 * and checks Installed apps names `version` from the install folder, with the app not started.
 */
export async function install(
  runner: Runner,
  setup: string,
  version: string,
  previous: string | null,
) {
  assertNoAppRunning(runner, "Before installing");
  const before = uninstallEntries();
  if (previous === null) {
    if (existsSync(runner.installRoot) || before.length > 0)
      throw new Error("Mr. Streamer is installed already: this runner isn't ours to replace.");
  } else if (before.length !== 1 || before[0]!.DisplayVersion !== previous) {
    throw new Error(`Installed apps doesn't hold ${previous} alone before the upgrade.`);
  }
  const started = Date.now();
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(setup, ["/S"], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0) throw new Error(`The setup of ${version} exited with ${code}.`);
  const after = uninstallEntries();
  if (after.length !== 1 || after[0]!.DisplayVersion !== version)
    throw new Error(`Installed apps doesn't name ${version} alone after the setup.`);
  uninstaller(runner, after[0]!);
  if (!existsSync(runner.executable)) throw new Error(`The setup left no ${runner.executable}.`);
  // A silent setup starts nothing; the next launch is this run's own.
  await delay(3000);
  assertNoAppRunning(runner, "After installing");
  const asar = join(runner.installRoot, "resources", "app.asar");
  return {
    version,
    seconds: Math.round((Date.now() - started) / 1000),
    entry: { name: after[0]!.DisplayName, version: after[0]!.DisplayVersion },
    executable: runner.executable,
    executableSha256: await fileSha256(runner.executable),
    appAsarSha256: await fileSha256(asar),
    tools: Object.fromEntries(
      await Promise.all(runner.tools.map(async (tool) => [tool, await fileSha256(tool)])),
    ),
  };
}

/** Uninstalls the app this run installed, and waits until its folder and entry are gone. */
export async function uninstall(runner: Runner) {
  assertNoAppRunning(runner, "Before uninstalling");
  const entries = uninstallEntries();
  if (entries.length !== 1)
    throw new Error("Installed apps doesn't hold this run's install alone.");
  const { path, args } = uninstaller(runner, entries[0]!);
  const run = spawn(path, args.includes("/S") ? args : [...args, "/S"], { stdio: "ignore" });
  await new Promise((resolve) => run.on("exit", resolve).on("error", resolve));
  // The uninstaller copies itself to a temporary folder and goes on from there.
  for (let i = 0; i < 120 && (existsSync(runner.executable) || uninstallEntries().length); i++)
    await delay(1000);
  if (existsSync(runner.executable) || uninstallEntries().length > 0)
    throw new Error("Uninstalling left the app installed.");
  return { uninstalled: true };
}

/** A connection the Windows Filtering Platform blocked, as its audit event 5157 says. */
export interface Blocked {
  readonly time: string;
  readonly application: string;
  readonly destination: string;
  readonly port: string;
  readonly protocol: string;
}

interface Profile {
  readonly Name: string;
  readonly Enabled: string;
  readonly DefaultInboundAction: string;
  readonly DefaultOutboundAction: string;
}

/** Filtering Platform Connection, by GUID, which every display language understands. */
const AUDIT_CONNECTIONS = "{0CCE9226-69AE-11D9-BED3-505054503030}";

/**
 * Blocks outbound connections of the installed app and its bundled ffmpeg and ffprobe, by program,
 * with firewall rules named for this run, and audits blocked connections so the block can be seen
 * working. Nothing else loses the network: a firewall profile that was off is turned on with
 * everything allowed, so only these rules block. `restore` puts back what `apply` changed.
 */
export function outboundBlock(runner: Runner) {
  const programs = [runner.executable, ...runner.tools];
  const rules = programs.map((program, index) => ({ name: `${runner.id}-${index}`, program }));
  const created: string[] = [];
  let profiles: Profile[] | null = null;
  let audit: { success: boolean; failure: boolean } | null = null;
  const readProfiles = (store: string) =>
    list<Profile>(
      `$p = Get-NetFirewallProfile -PolicyStore $env:MRS_STORE | Select-Object Name,
        @{n='Enabled';e={[string]$_.Enabled}}, @{n='DefaultInboundAction';e={[string]$_.DefaultInboundAction}},
        @{n='DefaultOutboundAction';e={[string]$_.DefaultOutboundAction}}
      ConvertTo-Json -Compress -InputObject @($p)`,
      { MRS_STORE: store },
    );
  // auditpol through PowerShell, which reports its exit code.
  const auditpol = (args: string) =>
    powershell(`auditpol ${args}; if ($LASTEXITCODE) { exit $LASTEXITCODE }`, {
      MRS_AUDIT: AUDIT_CONNECTIONS,
    });
  const readAudit = () => {
    const csv = auditpol('/get "/subcategory:$env:MRS_AUDIT" /r');
    const setting = csv.split("\n").at(-1)?.split(",")[4] ?? "";
    return { success: /Success/.test(setting), failure: /Failure/.test(setting) };
  };
  const setAudit = (to: { success: boolean; failure: boolean }) =>
    auditpol(
      `/set "/subcategory:$env:MRS_AUDIT" /success:${to.success ? "enable" : "disable"} /failure:${to.failure ? "enable" : "disable"}`,
    );
  const readRule = (name: string) =>
    list<{ Enabled: string; Direction: string; Action: string; Status: string; Program: string }>(
      `$r = Get-NetFirewallRule -Name $env:MRS_RULE -PolicyStore ActiveStore -ErrorAction SilentlyContinue
      $o = $r | ForEach-Object { [pscustomobject]@{ Enabled = [string]$_.Enabled; Direction = [string]$_.Direction
        Action = [string]$_.Action; Status = [string]$_.PrimaryStatus
        Program = ($_ | Get-NetFirewallApplicationFilter).Program } }
      ConvertTo-Json -Compress -InputObject @($o)`,
      { MRS_RULE: name },
    );

  return {
    programs,
    /** Adds the rules and turns on what makes them work, then reads back what is in force. */
    apply() {
      profiles = readProfiles("PersistentStore");
      audit = readAudit();
      setAudit({ success: audit.success, failure: true });
      for (const profile of profiles.filter((each) => each.Enabled !== "True"))
        powershell(
          "Set-NetFirewallProfile -Name $env:MRS_PROFILE -Enabled True -DefaultInboundAction Allow -DefaultOutboundAction Allow",
          { MRS_PROFILE: profile.Name },
        );
      for (const rule of rules) {
        powershell(
          "New-NetFirewallRule -Name $env:MRS_RULE -DisplayName $env:MRS_RULE -Description 'Mr. Streamer installed upgrade check; removed by the run that made it.' -Direction Outbound -Action Block -Program $env:MRS_PROGRAM -Profile Any -Enabled True | Out-Null",
          { MRS_RULE: rule.name, MRS_PROGRAM: rule.program },
        );
        created.push(rule.name);
      }
      const active = readProfiles("ActiveStore");
      const inForce = rules.map((rule) => ({ ...rule, read: readRule(rule.name) }));
      const working =
        active.every((each) => each.Enabled === "True") &&
        inForce.every(
          ({ program, read }) =>
            read.length === 1 &&
            read[0]!.Enabled === "True" &&
            read[0]!.Direction === "Outbound" &&
            read[0]!.Action === "Block" &&
            read[0]!.Status === "OK" &&
            same(read[0]!.Program, program),
        ) &&
        readAudit().failure;
      const record = { profilesBefore: profiles, activeProfiles: active, rules: inForce };
      if (!working) throw new Error(`The outbound block isn't in force: ${JSON.stringify(record)}`);
      return record;
    },
    /** Connections of the blocked programs the platform refused since `since`. */
    blocked(since: Date): Blocked[] {
      const events = list<Record<string, string>>(
        `$since = [datetime]::Parse($env:MRS_SINCE, $null, 'RoundtripKind')
        $e = Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 5157; StartTime = $since } -ErrorAction SilentlyContinue |
          ForEach-Object { [xml]$x = $_.ToXml(); $d = [ordered]@{ time = $_.TimeCreated.ToUniversalTime().ToString('o') }
            foreach ($n in $x.Event.EventData.Data) { $d[$n.Name] = [string]$n.'#text' }; [pscustomobject]$d }
        ConvertTo-Json -Compress -InputObject @($e)`,
        { MRS_SINCE: since.toISOString() },
      );
      // The event names a program by its device path: \device\harddiskvolume3\users\...
      const ours = (application: string) =>
        programs.find((program) =>
          application.toLowerCase().endsWith(program.slice(2).toLowerCase()),
        );
      return events.flatMap((event) => {
        const program = ours(event["Application"] ?? "");
        return program
          ? [
              {
                time: event["time"] ?? "",
                application: program,
                destination: event["DestAddress"] ?? "",
                port: event["DestPort"] ?? "",
                protocol: event["Protocol"] ?? "",
              },
            ]
          : [];
      });
    },
    /** Removes this run's rules, by name alone, and puts back the profiles and audit it changed. */
    restore() {
      const errors: string[] = [];
      const attempt = (what: string, action: () => unknown) => {
        try {
          action();
        } catch (error) {
          errors.push(`${what}: ${String(error)}`);
        }
      };
      for (const name of created.splice(0))
        attempt(`remove ${name}`, () =>
          powershell("Remove-NetFirewallRule -Name $env:MRS_RULE", { MRS_RULE: name }),
        );
      for (const profile of (profiles ?? []).filter((each) => each.Enabled !== "True"))
        attempt(`restore ${profile.Name}`, () =>
          powershell(
            "Set-NetFirewallProfile -Name $env:MRS_PROFILE -Enabled $env:MRS_ENABLED -DefaultInboundAction $env:MRS_IN -DefaultOutboundAction $env:MRS_OUT",
            {
              MRS_PROFILE: profile.Name,
              MRS_ENABLED: profile.Enabled,
              MRS_IN: profile.DefaultInboundAction,
              MRS_OUT: profile.DefaultOutboundAction,
            },
          ),
        );
      if (audit) attempt("restore audit", () => setAudit(audit!));
      const left = rules.filter((rule) => readRule(rule.name).length > 0).map((rule) => rule.name);
      if (left.length > 0) errors.push(`rules still present: ${left.join(", ")}`);
      if (errors.length > 0) throw new Error(`Restoring the network: ${errors.join("; ")}`);
      return { rulesRemoved: rules.map((rule) => rule.name), profilesRestored: true, audit };
    },
  };
}

/** What a bundled tool did when asked to read a URL. */
export interface ToolProbe {
  readonly code: number | null;
  /** It started a connection, so the network, or the block, had its say. */
  readonly attempted: boolean;
  readonly connected: boolean;
  /** Its connection lines and its last line. */
  readonly said: readonly string[];
}

/**
 * Asks a bundled ffmpeg or ffprobe to read `url`. The bundled build reads http and tcp but has no
 * TLS, so `url` must be plain http: https fails before any connection. Its verbose log names each
 * connection it starts and whether it connected.
 */
export function toolProbe(tool: string, url: string): Promise<ToolProbe> {
  return new Promise((resolve) => {
    const args = ["-hide_banner", "-v", "verbose", "-rw_timeout", "5000000", "-i", url];
    execFile(
      tool,
      /ffmpeg(\.exe)?$/i.test(tool) ? ["-nostdin", ...args, "-f", "null", "-"] : args,
      { timeout: 30_000 },
      (error, _out, err) => {
        const lines = err.trim().split(/\r?\n/);
        const connection = lines.filter((line) =>
          /(Starting connection attempt|Successfully connected|Connection attempt .+ failed|Connection to .+ failed)/.test(
            line,
          ),
        );
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : null) : 0,
          attempted: connection.some((line) => line.includes("Starting connection attempt")),
          connected: connection.some((line) => line.includes("Successfully connected")),
          said: [...connection, lines.at(-1) ?? ""],
        });
      },
    );
  });
}
