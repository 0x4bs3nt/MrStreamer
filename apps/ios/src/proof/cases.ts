// What the iOS app needs from the shared packages, run as plain functions so the same files run on
// Hermes in the app and in Node on the workbench. scripts/proof-server.ts runs them in Node, takes
// the app's report and compares the two: a shared rule proved on iOS gives Node's answer.
//
// The cases live in groups/, one file per area, each loaded when its turn comes: a shared module
// that can't load on Hermes fails its own group instead of the whole app. Groups sit inside the
// app because Metro's development server can't load a shared file outside it lazily.

/** What a case returns: plain data both runtimes can serialise and compare. */
export type Observed =
  null | boolean | number | string | readonly Observed[] | { readonly [key: string]: Observed };

/** Where a case's requests go, and which fetch implementations the runtime has. */
export interface ProofContext {
  /** The proof server's origin, as this runtime reaches it. */
  readonly fixture: string;
  /** Global fetch everywhere; the app adds `expo/fetch`. */
  readonly fetches: Readonly<Record<string, typeof fetch>>;
}

export interface ProofCase {
  readonly name: string;
  /**
   * `same`: the app must observe what Node observes. `record`: the runtimes are expected to
   * differ, and the app's answer is the finding.
   */
  readonly compare: "same" | "record";
  run(context: ProofContext): Observed | Promise<Observed>;
}

/** The groups in the order they run. */
export const groups: readonly {
  readonly name: string;
  load(): Promise<{ readonly cases: readonly ProofCase[] }>;
}[] = [
  { name: "runtime", load: () => import("./groups/runtime.ts") },
  { name: "contracts", load: () => import("./groups/contracts.ts") },
  { name: "playlist", load: () => import("./groups/playlist.ts") },
  { name: "regions", load: () => import("./groups/regions.ts") },
  { name: "catalogue", load: () => import("./groups/catalogue.ts") },
  { name: "i18n", load: () => import("./groups/i18n.ts") },
  { name: "catchup", load: () => import("./groups/catchup.ts") },
  { name: "names", load: () => import("./groups/names.ts") },
  { name: "subtitles", load: () => import("./groups/subtitles.ts") },
  { name: "effect", load: () => import("./groups/effect.ts") },
  { name: "guide", load: () => import("./groups/guide.ts") },
  { name: "fetch", load: () => import("./groups/fetch.ts") },
];

/** JSON round trip: drops undefined and functions the way the report will. */
export const plain = (value: unknown): Observed =>
  JSON.parse(JSON.stringify(value ?? null)) as Observed;

/** What a request came to, without anything that differs per run. */
export async function outcome(request: () => Promise<Response>): Promise<Observed> {
  try {
    const response = await request();
    return {
      status: response.status,
      redirected: response.redirected,
      type: response.type,
      location: response.headers.get("location"),
      body: await response.text(),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.name : typeof error };
  }
}

/** One observation per fetch implementation the runtime has. */
export async function perFetch(
  context: ProofContext,
  observe: (fetchImpl: typeof fetch) => Promise<Observed>,
): Promise<Observed> {
  const results: Record<string, Observed> = {};
  for (const [name, fetchImpl] of Object.entries(context.fetches)) {
    results[name] = await observe(fetchImpl);
  }
  return results;
}
