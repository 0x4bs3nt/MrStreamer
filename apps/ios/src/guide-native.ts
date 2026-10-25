import type { Programme } from "@mrstreamer/contracts/guide";
import { nextProviderRedirect, type GuideRequest } from "@mrstreamer/core/provider";

/** Fixed codes only. Native errors, URLs, headers and Location never enter public state. */
export type GuideProblem =
  | "login"
  | "http"
  | "network"
  | "redirect"
  | "xml"
  | "gzip"
  | "empty"
  | "ended"
  | "body"
  | "element"
  | "depth"
  | "rows"
  | "time"
  | "disk"
  | "reply"
  | "unavailable"
  | "busy";
export interface Generation {
  readonly id: string;
  readonly fetchedAt: number;
  readonly until: number;
}
export interface Activation {
  readonly lease: string;
  readonly generation: Generation | null;
}
export type Result<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "failed"; readonly error: GuideProblem }
  | { readonly kind: "changed" | "cancelled" };
export interface Query {
  readonly guideId: string | null;
  readonly rows: readonly Programme[];
  readonly more: boolean;
}
type Prepared =
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "candidate"; readonly id: string };

/** Private Expo port. Ingest bytes and rows never cross this boundary. */
export interface GuideNative {
  restore(
    ids: readonly string[],
  ): Promise<readonly { readonly subscriptionId: string; readonly activation: Activation }[]>;
  attach(id: string, revision: number): Promise<Activation>;
  revoke(id: string): void;
  forget(id: string): Promise<boolean>;
  begin(lease: string, job: string): boolean;
  cancel(job: string): Promise<void>;
  prepare(
    lease: string,
    job: string,
    url: string,
    headers: Readonly<Record<string, string>>,
    login: readonly string[],
    now: number,
    from: number,
    until: number,
  ): Promise<Result<Prepared>>;
  publish(lease: string, job: string, candidate: string): Promise<Result<Generation>>;
  query(
    lease: string,
    generation: string,
    job: string,
    ids: readonly string[],
    at: number,
    mode: "listing" | "day" | "detail",
    from: number,
    until: number,
    after: number,
  ): Promise<Result<Query>>;
  addListener?(event: "foreground" | "background", listener: () => void): { remove(): void };
}

export class GuideFault extends Error {
  readonly problem: GuideProblem;
  constructor(problem: GuideProblem) {
    super(problem);
    this.problem = problem;
  }
}

/** Expo installs modules before JS starts. Lazy lookup also keeps Node service tests independent. */
export function nativeGuide(): GuideNative {
  const host: { expo?: { modules?: { Guide?: GuideNative } } } = globalThis;
  const found = host.expo?.modules?.Guide;
  if (!found) throw new GuideFault("unavailable");
  return found;
}

/** Each redirect has closed before JS validates the next hop against the ORIGINAL request. */
export async function ingest(
  native: GuideNative,
  lease: string,
  job: string,
  request: Extract<GuideRequest, { kind: "request" }>,
  login: readonly string[],
  now: number,
  wanted: () => boolean,
): Promise<Result<Generation>> {
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  let url = request.url;
  for (let followed = 0; ; followed++) {
    if (!wanted()) return { kind: "cancelled" };
    const result = await native.prepare(
      lease,
      job,
      url,
      request.headers,
      login,
      now,
      yesterday.getTime(),
      now + 7 * 86400_000,
    );
    if (!wanted()) return { kind: "cancelled" };
    if (result.kind !== "ok") return result;
    if (result.value.kind === "candidate") return native.publish(lease, job, result.value.id);
    try {
      url = nextProviderRedirect({
        original: request.url,
        current: url,
        location: result.value.location,
        followed,
        login,
      });
    } catch {
      return { kind: "failed", error: "redirect" };
    }
  }
}
