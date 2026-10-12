// This module is also the dependency-free notification CLI shipped by the secret-free build.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Public domain-ownership value, deliberately hosted at /{key}.txt. Never an account token.
export const INDEXNOW_KEY = "b823067292014642b30f35118c733092";
export const INDEXNOW_MARKER = "indexnow-build.json";
const SITE = "https://mrstreamer.app";
const ENDPOINT = "https://api.indexnow.org/indexnow";
const ATTEMPTS = 6;
const REQUEST_TIMEOUT = 5_000;
const READINESS_DELAY = 10_000;

/** Validate the checked artifact before making any network request. */
export function readIndexNowBuild(text: string, revision: string, sitemap: string) {
  const value: unknown = JSON.parse(text);
  if (
    !value ||
    typeof value !== "object" ||
    !("site" in value) ||
    value.site !== SITE ||
    !("revision" in value) ||
    value.revision !== revision ||
    !/^[a-f0-9]{40}$/.test(revision) ||
    !("buildId" in value) ||
    typeof value.buildId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.buildId) ||
    !("key" in value) ||
    typeof value.key !== "string" ||
    !/^[a-zA-Z0-9-]{8,128}$/.test(value.key) ||
    value.key !== INDEXNOW_KEY ||
    !("urlList" in value) ||
    !isStrings(value.urlList)
  )
    throw new Error("Invalid IndexNow build identity or ownership value.");
  const urlList = [...new Set(value.urlList)];
  if (
    urlList.length === 0 ||
    urlList.length > 10_000 ||
    urlList.some((url) => {
      const parsed = new URL(url);
      return (
        parsed.origin !== SITE ||
        parsed.href !== url ||
        parsed.search !== "" ||
        parsed.hash !== "" ||
        parsed.username !== "" ||
        parsed.password !== "" ||
        !/^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/.test(parsed.pathname) ||
        parsed.pathname === "/404"
      );
    })
  )
    throw new Error("IndexNow URLs must be canonical HTTPS mrstreamer.app pages.");
  const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  if (listed.length !== urlList.length || urlList.some((url) => !listed.includes(url)))
    throw new Error("IndexNow URLs do not match the checked sitemap.");
  return {
    site: value.site,
    revision: value.revision,
    buildId: value.buildId,
    key: value.key,
    urlList,
  };
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
}

interface NotificationOptions {
  readonly signal?: AbortSignal;
  /** Loopback HTTP fixtures only; production always uses the literal canonical domain/API. */
  readonly publicOrigin?: string;
  readonly endpoint?: string;
  readonly requestTimeoutMs?: number;
  readonly readinessDelayMs?: number;
}

function fixtureOrProduction(value: string, production: string) {
  const url = new URL(value);
  if (
    value !== production &&
    !(
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    )
  )
    throw new Error("Only the production address or a loopback HTTP fixture is allowed.");
  return value;
}

/** One POST after the public domain matches this exact build. No submission retries. */
export async function notifyIndexNow(
  directory: string,
  revision: string,
  options: NotificationOptions = {},
) {
  const marker = readFileSync(join(directory, INDEXNOW_MARKER), "utf8");
  const build = readIndexNowBuild(
    marker,
    revision,
    readFileSync(join(directory, "sitemap.xml"), "utf8"),
  );
  if (readFileSync(join(directory, `${build.key}.txt`), "utf8") !== build.key)
    throw new Error("Packaged IndexNow ownership file does not match.");
  const publicOrigin = fixtureOrProduction(options.publicOrigin ?? SITE, SITE);
  const endpoint = fixtureOrProduction(options.endpoint ?? ENDPOINT, ENDPOINT);
  const timeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT;
  const wait = options.readinessDelayMs ?? READINESS_DELAY;
  if (
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > REQUEST_TIMEOUT ||
    !Number.isInteger(wait) ||
    wait < 0 ||
    wait > READINESS_DELAY
  )
    throw new Error("Invalid notification time bounds.");
  const signal = AbortSignal.any([
    AbortSignal.timeout(120_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const request = async (url: string, init?: RequestInit) => {
    signal.throwIfAborted();
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      headers: { "Cache-Control": "no-cache", ...init?.headers },
    });
    return response;
  };
  const readPublic = async (file: string) => {
    const response = await request(`${publicOrigin}/${file}`);
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`Public build check returned HTTP ${response.status}.`);
    }
    // Bound response size as well as the complete request/body deadline.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Public build check had no body.");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 65_536) throw new Error("Public build check exceeded 64 KiB.");
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      await reader.cancel();
    }
  };
  let ready = false;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      if ((await readPublic(`${build.key}.txt`)) !== build.key)
        throw new Error("Public IndexNow ownership file does not match.");
      if ((await readPublic(INDEXNOW_MARKER)) !== marker)
        throw new Error(
          "Public domain does not serve the expected build. Check propagation or rollback pinning.",
        );
      ready = true;
      break;
    } catch (error) {
      signal.throwIfAborted();
      if (attempt === ATTEMPTS) throw error;
      await delay(wait, undefined, { signal });
    }
  }
  if (!ready) throw new Error("Public build could not be verified.");
  signal.throwIfAborted();
  const response = await request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: new URL(SITE).host,
      key: build.key,
      keyLocation: `${SITE}/${build.key}.txt`,
      urlList: build.urlList,
    }),
  });
  await response.body?.cancel();
  if (response.status === 200)
    return "IndexNow HTTP 200: URLs received. Indexing is not guaranteed.";
  if (response.status === 202)
    return "IndexNow HTTP 202: URLs received, ownership validation pending. Indexing is not guaranteed.";
  throw new Error(
    `IndexNow rejected the notification with HTTP ${response.status}. No POST retry was made.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  try {
    if (process.argv.length !== 4)
      throw new Error("Usage: node indexnow.ts <packaged-static-directory> <built-commit>");
    const result = await notifyIndexNow(process.argv[2] ?? "", process.argv[3] ?? "", {
      signal: controller.signal,
    });
    console.log(result);
    if (process.env["GITHUB_STEP_SUMMARY"])
      appendFileSync(process.env["GITHUB_STEP_SUMMARY"], `${result}\n`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown notification failure.";
    const message = `The website is already deployed. IndexNow notification failed: ${reason}`;
    console.error(message);
    if (process.env["GITHUB_STEP_SUMMARY"])
      appendFileSync(process.env["GITHUB_STEP_SUMMARY"], `${message}\n`);
    process.exitCode = 1;
  }
}
