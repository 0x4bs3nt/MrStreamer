import { groups, type Observed, type ProofContext } from "./cases.ts";

/** One case's outcome. A case that throws is a finding too, with what it threw. */
export interface CaseResult {
  readonly name: string;
  readonly compare: "same" | "record";
  readonly ms: number;
  readonly value?: Observed;
  readonly thrown?: string;
}

const describe = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * Runs every case in order, each to its end, so one failure doesn't hide the rest. A group that
 * can't load counts as one failed `same` case named after it.
 */
export async function runCases(context: ProofContext): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const group of groups) {
    const started = Date.now();
    const name = `${group.name}: loads`;
    let loaded;
    try {
      loaded = await group.load();
    } catch (error) {
      results.push({ name, compare: "same", ms: Date.now() - started, thrown: describe(error) });
      continue;
    }
    // A development build reports a module that throws while it loads to the error overlay and
    // resolves its import without exports, instead of rejecting it.
    if (!Array.isArray(loaded.cases)) {
      const thrown = "loaded without exports: a module threw while loading";
      results.push({ name, compare: "same", ms: Date.now() - started, thrown });
      continue;
    }
    for (const proof of loaded.cases) {
      const begun = Date.now();
      try {
        const value = await proof.run(context);
        results.push({ name: proof.name, compare: proof.compare, ms: Date.now() - begun, value });
      } catch (error) {
        const thrown = describe(error);
        results.push({ name: proof.name, compare: proof.compare, ms: Date.now() - begun, thrown });
      }
    }
  }
  return results;
}
