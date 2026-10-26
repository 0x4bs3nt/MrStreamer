import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Nothing a pull request or a dry run starts may publish: no GitHub release, update feed, Store
// submission, version commit or website. release-plan.ts makes every pull request event a dry run
// (test/release.test.ts holds it to that); this holds the workflows to the rest by evaluating
// their actual `if:` conditions and `with:` mappings.
//
// For every event a release run starts on, every plan output that matters, every result of the
// release run's other jobs and whether the run was cancelled, it works out which of release.yml's
// calls of publish.yml start and, inside each, which of publish.yml's jobs would run, assuming a
// job that runs succeeds unless an outcome says otherwise, with every kill switch on. A
// context path it doesn't model fails the test rather than reading as some value. actionlint
// checks the rest of the YAML; docs/maintainers/ci.md traces each path.

interface Job {
  readonly "continue-on-error"?: boolean | string;
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly outputs?: Record<string, unknown>;
}

interface Input {
  readonly type: string;
  readonly default?: unknown;
}

interface Workflow {
  readonly on: {
    readonly workflow_call?: {
      readonly inputs?: Record<string, Input>;
      readonly outputs?: Record<string, unknown>;
    };
    readonly workflow_dispatch?: { readonly inputs?: Record<string, Input> };
  } & Record<string, unknown>;
  readonly jobs: Record<string, Job>;
}

const parsed = new Map<string, Workflow>();
const read = (name: string): Workflow => {
  if (!parsed.has(name))
    parsed.set(name, parse(readFileSync(`.github/workflows/${name}`, "utf8")) as Workflow);
  return parsed.get(name)!;
};
const PUBLISH = "./.github/workflows/publish.yml";

// A GitHub Actions expression evaluator for the subset these conditions use: string literals,
// true, false and null, context paths such as needs.plan.outputs.dry-run, the status functions,
// !, ==, !=, && and || with parentheses, at GitHub's precedence. Comparisons follow GitHub's loose
// rules: strings compare without case, anything else as numbers, with null and '' as 0. A job's
// `if:` without a status function has GitHub's implicit success().

type Value = string | number | boolean | null;

/** What an expression reads: context paths, and the state the status functions report. */
interface Scope {
  /** A context path's value. Throws for a path the test doesn't model. */
  readonly path: (path: string) => Value;
  /** Every job the job needs succeeded. */
  readonly needsSucceeded: boolean;
  /** A job it needs, directly or through others, failed. */
  readonly ancestorFailed: boolean;
  /** The run was cancelled, which a cancelled job's result alone doesn't say. */
  readonly cancelled: boolean;
}

const TOKEN = /\s*(\(|\)|==|!=|&&|\|\||!|'(?:[^']|'')*'|[A-Za-z_][\w.-]*)/y;

const tokenized = new Map<string, string[]>();

function tokenize(expression: string): string[] {
  const known = tokenized.get(expression);
  if (known) return known;
  const tokens: string[] = [];
  const source = expression.trimEnd();
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.length) {
    const match = TOKEN.exec(source);
    if (!match) throw new Error(`Can't read ${JSON.stringify(expression)} past ${TOKEN.lastIndex}`);
    tokens.push(match[1]!);
  }
  tokenized.set(expression, tokens);
  return tokens;
}

const truthy = (value: Value) => value !== null && value !== false && value !== 0 && value !== "";
const number = (value: Value) =>
  value === null ? 0 : typeof value === "boolean" ? Number(value) : Number(value || 0);
const equal = (a: Value, b: Value) =>
  typeof a === "string" && typeof b === "string"
    ? a.toLowerCase() === b.toLowerCase()
    : number(a) === number(b);

const STATUS = ["success", "failure", "always", "cancelled"];

/** The value of `expression` in `scope`. */
function evaluate(expression: string, scope: Scope): Value {
  const tokens = tokenize(expression);
  let at = 0;
  const peek = () => tokens[at];
  const take = (expected?: string) => {
    const token = tokens[at++];
    if (token === undefined || (expected && token !== expected))
      throw new Error(`Expected ${expected ?? "more"} in ${expression}`);
    return token;
  };
  const primary = (): Value => {
    const token = take();
    if (token === "(") {
      const value = or();
      take(")");
      return value;
    }
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (peek() === "(") {
      take("(");
      take(")");
      if (token === "success") return scope.needsSucceeded && !scope.cancelled;
      if (token === "failure") return scope.ancestorFailed;
      if (token === "cancelled") return scope.cancelled;
      if (token === "always") return true;
      throw new Error(`Unknown function ${token}()`);
    }
    if (token === "true" || token === "false") return token === "true";
    if (token === "null") return null;
    return scope.path(token);
  };
  const unary = (): Value => (peek() === "!" ? (take(), !truthy(unary())) : primary());
  const comparison = (): Value => {
    const left = unary();
    const operator = peek();
    if (operator !== "==" && operator !== "!=") return left;
    take();
    const same = equal(left, unary());
    return operator === "==" ? same : !same;
  };
  const and = (): Value => {
    let value = comparison();
    while (peek() === "&&") {
      take();
      const right = comparison();
      value = truthy(value) ? right : value;
    }
    return value;
  };
  const or = (): Value => {
    let value = and();
    while (peek() === "||") {
      take();
      const right = and();
      value = truthy(value) ? value : right;
    }
    return value;
  };
  const value = or();
  if (at !== tokens.length)
    throw new Error(`Unread ${tokens.slice(at).join(" ")} in ${expression}`);
  return value;
}

/** Whether a job with condition `expression` runs, adding GitHub's implicit success(). */
function runs(expression: string | undefined, scope: Scope): boolean {
  const source = expression ?? "success()";
  const tokens = tokenize(source);
  const status = tokens.some((token, index) => STATUS.includes(token) && tokens[index + 1] === "(");
  return truthy(evaluate(source, scope)) && (status || evaluate("success()", scope) === true);
}

/** A `with:` value: a literal, or the expressions inside ${{ }} evaluated in `scope`. */
function resolve(value: unknown, scope: Scope): Value {
  if (typeof value !== "string") return value as Value;
  const whole = /^\$\{\{(.*)\}\}$/s.exec(value.trim());
  if (whole) return evaluate(whole[1]!, scope);
  return value.replace(/\$\{\{(.*?)\}\}/gs, (_, inner: string) =>
    String(evaluate(inner, scope) ?? ""),
  );
}

const needsOf = (job: Job) =>
  job.needs === undefined ? [] : typeof job.needs === "string" ? [job.needs] : job.needs;

/** Every job `name` needs, directly or through the jobs it needs. */
function ancestors(workflow: Workflow, name: string): Set<string> {
  return new Set(
    needsOf(workflow.jobs[name]!).flatMap((need) => [need, ...ancestors(workflow, need)]),
  );
}

type Result = "success" | "failure" | "skipped" | "cancelled";
const RESULTS: readonly Result[] = ["success", "failure", "skipped", "cancelled"];

const unmodelled = (path: string): never => {
  throw new Error(`The guard doesn't model ${path}`);
};

/**
 * The scope of job `name` of `workflow`, given each other job's result and outputs, and `context`
 * for every path outside needs. A needs path for a job it doesn't need, or an output its job
 * doesn't declare, fails.
 */
function jobScope(
  workflow: Workflow,
  name: string,
  results: ReadonlyMap<string, Result>,
  outputs: (job: string, output: string) => Value,
  context: (path: string) => Value,
  cancelled: boolean,
): Scope {
  const needs = needsOf(workflow.jobs[name]!);
  return {
    path: (path) => {
      const [scope, need, kind, output, ...rest] = path.split(".");
      if (scope !== "needs") return context(path);
      if (!need || !needs.includes(need) || rest.length > 0) return unmodelled(path);
      if (kind === "result" && output === undefined) return results.get(need) ?? unmodelled(path);
      if (kind === "outputs" && output !== undefined) return outputs(need, output);
      return unmodelled(path);
    },
    // GitHub's implicit success() skips a job when any job it waits for, however indirectly, didn't
    // succeed: a skipped grandparent skips it even after its own need ran.
    needsSucceeded: [...ancestors(workflow, name)].every((job) => results.get(job) === "success"),
    ancestorFailed: [...ancestors(workflow, name)].some((job) => results.get(job) === "failure"),
    cancelled,
  };
}

/**
 * publish.yml's `inputs` for a call that passes `given`: each workflow_call input the call names
 * or its default, and null for an input only a run by hand has. An input publish.yml doesn't
 * declare fails.
 */
function callInputs(publish: Workflow, given: Record<string, Value>) {
  const called = publish.on.workflow_call?.inputs ?? {};
  const byHand = publish.on.workflow_dispatch?.inputs ?? {};
  return (name: string): Value => {
    const input = called[name];
    if (input) {
      if (name in given) return given[name]!;
      if ("default" in input) return input.default as Value;
      // GitHub's own defaults for an omitted input without one.
      return input.type === "boolean" ? false : input.type === "number" ? 0 : "";
    }
    if (name in byHand) return null;
    return unmodelled(`inputs.${name}`);
  };
}

/**
 * The jobs of publish.yml that run for one call, in an order that respects their needs: a job that
 * runs succeeds unless `outcomes` says otherwise, and reports its outputs as "true" on success;
 * one that doesn't run is skipped.
 */
function simulate(
  publish: Workflow,
  given: Record<string, Value>,
  event: string,
  cancelled: boolean,
  outcomes: Readonly<Record<string, Result>> = {},
) {
  const inputs = callInputs(publish, given);
  const context = (path: string): Value => {
    if (path === "github.event_name") return event;
    if (path === "github.ref") return "refs/heads/main";
    if (path.startsWith("inputs.")) return inputs(path.slice("inputs.".length));
    // Every kill switch on: the worst case.
    if (path === "vars.MARKETING_DEPLOY_ENABLED" || path === "vars.STORE_AUTOMATION_ENABLED")
      return "true";
    return unmodelled(path);
  };
  const results = new Map<string, Result>();
  const outputs = (job: string, output: string): Value => {
    if (!(output in (publish.jobs[job]!.outputs ?? {})))
      return unmodelled(`needs.${job}.outputs.${output}`);
    return results.get(job) === "success" ? "true" : "";
  };
  const pending = Object.keys(publish.jobs);
  while (pending.length > 0) {
    const index = pending.findIndex((name) =>
      needsOf(publish.jobs[name]!).every((need) => results.has(need)),
    );
    if (index === -1) throw new Error(`A cycle among ${pending.join(", ")}`);
    const [name] = pending.splice(index, 1);
    const scope = jobScope(publish, name!, results, outputs, context, cancelled);
    results.set(
      name!,
      runs(publish.jobs[name!]!.if, scope) ? (outcomes[name!] ?? "success") : "skipped",
    );
  }
  return [...results].flatMap(([name, result]) => (result === "success" ? [name] : []));
}

/** One release run as the guard sees it. */
type Run = {
  readonly event: string;
  readonly dryRun: "true" | "false";
  readonly channel: "nightly" | "stable";
  /** The nightly a stable run publishes first, or "" for none. */
  readonly firstTag: string;
  readonly cancelled: boolean;
  /** Each job's result but the plan's, which succeeded for there to be a plan. */
  readonly results: Record<string, Result>;
};

/** The plan's outputs for `run`, as release.yml's plan job declares them. */
function planOutputs(run: Run): Record<string, string> {
  return {
    skip: "false",
    "dry-run": run.dryRun,
    channel: run.channel,
    version: run.channel === "stable" ? "0.0.13" : "0.0.14-nightly.20261013.300",
    tag: run.channel === "stable" ? "v0.0.13" : "v0.0.14-nightly.20261013.300",
    sha: "0123456789abcdef0123456789abcdef01234567",
    "previous-tag": run.channel === "stable" ? "v0.0.12" : "v0.0.14-nightly.20261013.200",
    promoted: run.channel === "stable" ? "v0.0.13-nightly.20261012.250" : "",
    "first-version": run.firstTag.slice(1),
    "first-tag": run.firstTag,
    "first-sha": run.firstTag ? "fedcba9876543210fedcba9876543210fedcba98" : "",
    "first-previous-tag": run.firstTag ? "v0.0.13-nightly.20261012.250" : "",
  };
}

/** Which of publish.yml's jobs run, per release.yml call that starts, for one release run. */
function publishedBy(release: Workflow, publish: Workflow, run: Run) {
  const results = new Map<string, Result>([["plan", "success"], ...Object.entries(run.results)]);
  const plan = planOutputs(run);
  const outputs = (job: string, output: string): Value => {
    const path = `needs.${job}.outputs.${output}`;
    if (job === "plan") {
      const declared = release.jobs["plan"]!.outputs ?? {};
      return output in declared && output in plan ? plan[output]! : unmodelled(path);
    }
    // A job that calls a workflow reports that workflow's outputs, such as package.yml's sources.
    const called = release.jobs[job]!.uses;
    const declared = called
      ? read(called.replace("./.github/workflows/", "")).on.workflow_call?.outputs
      : release.jobs[job]!.outputs;
    if (!declared || !(output in declared)) return unmodelled(path);
    return results.get(job) === "success" ? "x" : "";
  };
  const context = (path: string): Value =>
    path === "github.event_name" ? run.event : unmodelled(path);
  const published: Record<string, string[]> = {};
  for (const [name, job] of Object.entries(release.jobs)) {
    if (job.uses !== PUBLISH) continue;
    const scope = jobScope(release, name, results, outputs, context, run.cancelled);
    if (!runs(job.if, scope)) continue;
    const given = Object.fromEntries(
      Object.entries(job.with ?? {}).map(([input, value]) => [input, resolve(value, scope)]),
    );
    published[name] = simulate(publish, given, run.event, run.cancelled);
  }
  return published;
}

/** Every combination of the values given for each key. */
function* combinations<T>(choices: Record<string, readonly T[]>): Generator<Record<string, T>> {
  const [first, ...rest] = Object.entries(choices);
  if (!first) return yield {};
  for (const value of first[1])
    for (const others of combinations(Object.fromEntries(rest)))
      yield { [first[0]]: value, ...others };
}

/**
 * Every release run a dry run or pull request event could start: each result of every job a
 * publishing call needs, directly or not, but the plan's.
 */
function* guardedRuns(release: Workflow): Generator<Run> {
  const callers = Object.keys(release.jobs).filter((job) => release.jobs[job]!.uses === PUBLISH);
  const others = [...new Set(callers.flatMap((call) => [...ancestors(release, call)]))].filter(
    (job) => job !== "plan",
  );
  for (const results of combinations(Object.fromEntries(others.map((job) => [job, RESULTS])))) {
    for (const event of ["schedule", "workflow_dispatch", "pull_request"])
      for (const dryRun of ["true", "false"] as const)
        for (const channel of ["nightly", "stable"] as const)
          for (const firstTag of ["", "v0.0.13-nightly.20261013.301"])
            for (const cancelled of [false, true])
              if (dryRun === "true" || event === "pull_request")
                yield { event, dryRun, channel, firstTag, cancelled, results };
  }
}

/** The first guarded run that publishes anything, with what it publishes, or null. */
function leaks(release: Workflow, publish: Workflow) {
  for (const run of guardedRuns(release)) {
    const published = publishedBy(release, publish, run);
    if (Object.values(published).some((jobs) => jobs.length > 0)) return { run, published };
  }
  return null;
}

/** `workflow` with `job`'s condition replaced by what `change` makes of it, in memory alone. */
function mutated(workflow: Workflow, job: string, change: (condition: string) => string) {
  const copy = structuredClone(workflow);
  const target = copy.jobs[job] as { if?: string };
  target.if = change(target.if ?? "success()");
  return copy;
}

const release = read("release.yml");
const publish = read("publish.yml");
const passed = (run: Partial<Run>): Run => ({
  event: "schedule",
  dryRun: "false",
  channel: "nightly",
  firstTag: "",
  cancelled: false,
  results: Object.fromEntries(
    Object.keys(release.jobs)
      .filter((job) => job !== "plan")
      .map((job) => [job, "success"]),
  ),
  ...run,
});

describe("publishing", { timeout: 120_000 }, () => {
  it("never starts on a pull request event of its own", () => {
    expect(Object.keys(publish.on)).toEqual(["workflow_call", "push", "workflow_dispatch"]);
  });

  it("runs no job of a release's call for a dry run or a pull request event, whatever else happened", () => {
    expect(leaks(release, publish)).toBeNull();
  });

  it("does publish a scheduled nightly and a stable release once everything they wait for passed", () => {
    expect(publishedBy(release, publish, passed({}))["publish"]).toEqual([
      "release",
      "discord",
      "feed",
    ]);
    const stable = publishedBy(
      release,
      publish,
      passed({
        event: "workflow_dispatch",
        channel: "stable",
        firstTag: "v0.0.13-nightly.20261013.301",
      }),
    );
    expect(stable["nightly-first-publish"]).toEqual(["release", "discord", "feed"]);
    expect(stable["publish"]).toEqual(
      expect.arrayContaining([
        "release",
        "discord",
        "feed",
        "store",
        "finalize",
        "website-publish",
        "indexnow",
      ]),
    );
  });

  it("announces only a successful publication, independently of feed failures, without failing its caller", () => {
    const given = {
      channel: "nightly",
      version: "0.0.21-nightly.20261026.400",
      tag: "v0.0.21-nightly.20261026.400",
    };
    for (const result of ["failure", "skipped", "cancelled"] as const)
      expect(simulate(publish, given, "schedule", false, { release: result })).not.toContain(
        "discord",
      );
    expect(simulate(publish, given, "schedule", false, { feed: "failure" })).toContain("discord");
    expect(publish.jobs["discord"]?.["continue-on-error"]).toBe(true);
  });

  it("publishes the website alone after a push to main that changes it", () => {
    expect(simulate(publish, {}, "push", false)).toEqual([
      "website",
      "website-publish",
      "indexnow",
    ]);
    expect(simulate(publish, {}, "push", true)).toEqual([]);
  });

  it("publishes nothing once the run is cancelled, or the package call failed", () => {
    const jobs = (run: Run) => Object.values(publishedBy(release, publish, run)).flat();
    const ok = passed({});
    expect(jobs(passed({ cancelled: true }))).toEqual([]);
    expect(jobs({ ...ok, results: { ...ok.results, package: "failure" } })).toEqual([]);
  });

  // Each probe is a condition that once got past an earlier version of this guard. They mutate a
  // copy of the parsed workflow, never the file.
  it.each([
    ["ignores the plan's dry-run output", (condition: string) => `(${condition}) || true`],
    [
      "publishes after a failed dry run",
      (condition: string) => `${condition} || (failure() && needs.plan.outputs.dry-run == 'true')`,
    ],
    [
      "publishes a nightly dry run",
      (condition: string) =>
        `${condition} || (always() && needs.plan.outputs.channel == 'nightly' && needs.plan.outputs.dry-run == 'true')`,
    ],
  ])("would catch a publish call that %s", (_, change) => {
    for (const call of ["publish", "nightly-first-publish"]) {
      expect(leaks(mutated(release, call, change), publish), call).not.toBeNull();
    }
  });

  it("would catch a release job that takes a pull request event", () => {
    const taking = mutated(publish, "release", () => "inputs.tag != ''");
    expect(leaks(release, taking)).toMatchObject({
      run: { event: "pull_request", dryRun: "false" },
    });
  });

  it("refuses to guess at a context it doesn't model", () => {
    const guessing = mutated(release, "publish", (condition) => `${condition} && vars.ANYTHING`);
    expect(() => publishedBy(guessing, publish, passed({}))).toThrow(
      "The guard doesn't model vars.ANYTHING",
    );
    const output = mutated(release, "publish", (c) => `${c} && needs.plan.outputs.unknown == ''`);
    expect(() => publishedBy(output, publish, passed({}))).toThrow(
      "The guard doesn't model needs.plan.outputs.unknown",
    );
  });

  it("is called by no other workflow", () => {
    for (const name of ["checks.yml", "package.yml", "upgrade-check.yml"]) {
      expect(Object.values(read(name).jobs).map((job) => job.uses)).not.toContain(PUBLISH);
    }
  });
});
