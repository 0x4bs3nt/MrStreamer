import { resolve } from "node:path";

/** Native acceptance is deliberately separate from the bounded release-UI scenario. */
export function analyticsOptions(args: string[]) {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (const arg of args) {
    if (
      [
        "--native-telemetry",
        "--observe-rollover",
        "--volume-workload",
        "--slow-startup",
        "--lifecycle",
      ].includes(arg)
    )
      flags.add(arg);
    else if (
      /^--(built-desktop|expected-version|expected-source|native-case|prior-executable|prior-source|installed-pair)=/.test(
        arg,
      )
    ) {
      const split = arg.indexOf("=");
      const name = arg.slice(0, split);
      if (values.has(name) || arg.length === split + 1) throw new Error(`Invalid ${name}`);
      values.set(name, arg.slice(split + 1));
    } else if (arg !== "--") positional.push(arg);
  }
  const [executable, ...appArgs] = positional;
  const native = flags.has("--native-telemetry");
  const nativeCase = values.get("--native-case");
  if (
    nativeCase &&
    ![
      "consent",
      "offline",
      "checkpoint",
      "periodic",
      "seal-send-ack",
      "ambiguous",
      "quit",
      "slow-write",
      "windows-rename",
      "windows-retry",
      "compatibility",
    ].includes(nativeCase)
  )
    throw new Error("Unknown native telemetry case");
  const expectedVersion = values.get("--expected-version");
  const expectedSource = values.get("--expected-source");
  for (const source of [expectedSource, values.get("--prior-source")])
    if (source && !/^[a-f0-9]{40}$/.test(source)) throw new Error("Expected a full source SHA");
  if (executable && (!expectedVersion || !expectedSource))
    throw new Error("Packaged verification requires --expected-version= and --expected-source=");
  if (
    native &&
    (flags.has("--observe-rollover") ||
      flags.has("--volume-workload") ||
      flags.has("--slow-startup") ||
      flags.has("--lifecycle"))
  )
    throw new Error("Native acceptance cannot change the ordinary workload");
  if (
    !native &&
    ["--native-case", "--prior-executable", "--prior-source", "--installed-pair"].some((key) =>
      values.has(key),
    )
  )
    throw new Error("Native options require --native-telemetry");
  if (nativeCase === "windows-retry" && process.platform !== "win32")
    throw new Error("windows-retry requires actual Windows");
  if (values.has("--prior-executable") !== values.has("--prior-source"))
    throw new Error("Prior executable and source must be supplied together");
  if (values.has("--installed-pair") && values.has("--prior-executable"))
    throw new Error("Select an installed Windows pair or separate prior executable");
  return {
    executable: executable ? resolve(executable) : undefined,
    appArgs,
    native,
    expectedVersion,
    expectedSource,
    builtDesktop: values.has("--built-desktop")
      ? resolve(values.get("--built-desktop")!)
      : undefined,
    nativeCase,
    priorExecutable: values.has("--prior-executable")
      ? resolve(values.get("--prior-executable")!)
      : undefined,
    priorSource: values.get("--prior-source"),
    installedPair: values.get("--installed-pair"),
    volume: flags.has("--volume-workload"),
    rollover: flags.has("--observe-rollover"),
    slowStartup: flags.has("--slow-startup"),
    lifecycle: flags.has("--lifecycle"),
  };
}
