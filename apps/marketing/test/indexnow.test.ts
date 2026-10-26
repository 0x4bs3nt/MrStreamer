import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INDEXNOW_KEY, INDEXNOW_MARKER, notifyIndexNow } from "../scripts/indexnow.ts";
import { PAGES, SITE } from "../scripts/pages.ts";

const revision = "a".repeat(40);
const canonical = PAGES.map(({ address }) => SITE + address);
const manifest = {
  site: SITE,
  revision,
  buildId: "11111111-1111-4111-8111-111111111111",
  key: INDEXNOW_KEY,
  urlList: canonical,
};
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(override?: (req: IncomingMessage, res: ServerResponse) => boolean) {
  const folder = mkdtempSync(join(tmpdir(), "mr-indexnow-"));
  cleanup.push(() => rmSync(folder, { recursive: true, force: true }));
  const marker = JSON.stringify(manifest) + "\n";
  writeFileSync(join(folder, INDEXNOW_MARKER), marker);
  writeFileSync(join(folder, `${INDEXNOW_KEY}.txt`), INDEXNOW_KEY);
  writeFileSync(
    join(folder, "sitemap.xml"),
    `<urlset>${canonical.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`,
  );
  const requests: {
    method: string | undefined;
    path: string | undefined;
    body: string;
    contentType: string | undefined;
  }[] = [];
  const server = createServer(async (req, res) => {
    // Counted as it arrives, so a request its sender gave up on while its body came still counts.
    const request = {
      method: req.method,
      path: req.url,
      body: "",
      contentType: req.headers["content-type"],
    };
    requests.push(request);
    for await (const chunk of req) request.body += String(chunk);
    if (override?.(req, res)) return;
    if (req.url === `/${INDEXNOW_KEY}.txt`) res.end(INDEXNOW_KEY);
    else if (req.url === `/${INDEXNOW_MARKER}`)
      res.end(readFileSync(join(folder, INDEXNOW_MARKER)));
    else if (req.url === "/api") res.end();
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  const origin = `http://127.0.0.1:${address.port}`;
  const options = {
    publicOrigin: origin,
    endpoint: `${origin}/api`,
    readinessDelayMs: 0,
    requestTimeoutMs: 500,
  };
  const submit = () => notifyIndexNow(folder, revision, options);
  return { folder, origin, options, submit, requests };
}

describe("IndexNow production notification HTTP contract", () => {
  it.each([200, 202])(
    "reports HTTP %s truthfully after ownership and exact-build checks",
    async (status) => {
      const f = await fixture((req, res) => {
        if (req.url !== "/api") return false;
        res.statusCode = status;
        res.end();
        return true;
      });
      const result = await f.submit();
      expect(result).toContain(`HTTP ${status}`);
      expect(result).toContain("Indexing is not guaranteed");
      expect(result.includes("validation pending")).toBe(status === 202);
      expect(f.requests.map(({ method, path }) => [method, path])).toEqual([
        ["GET", `/${INDEXNOW_KEY}.txt`],
        ["GET", `/${INDEXNOW_MARKER}`],
        ["POST", "/api"],
      ]);
      expect(JSON.parse(f.requests[2]?.body ?? "")).toEqual({
        host: "mrstreamer.app",
        key: INDEXNOW_KEY,
        keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`,
        urlList: canonical,
      });
      expect(f.requests[2]?.contentType).toBe("application/json; charset=utf-8");
    },
  );

  it("deduplicates canonical pages before sending", async () => {
    const f = await fixture();
    writeFileSync(
      join(f.folder, INDEXNOW_MARKER),
      JSON.stringify({ ...manifest, urlList: [...canonical, canonical[0]] }),
    );
    await f.submit();
    expect(JSON.parse(f.requests.at(-1)?.body ?? "").urlList).toEqual(canonical);
  });

  it.each(["key", "revision", "buildId", "domain", "redirect"])(
    "never POSTs when the public %s differs",
    async (mismatch) => {
      const f = await fixture((req, res) => {
        if (mismatch === "key" && req.url?.endsWith(".txt")) {
          res.end("different-public-key");
          return true;
        }
        if (req.url !== `/${INDEXNOW_MARKER}`) return false;
        if (mismatch === "redirect") {
          res.writeHead(302, { Location: "https://example.org/preview" });
          res.end();
        } else
          res.end(
            JSON.stringify({
              ...manifest,
              ...(mismatch === "revision" ? { revision: "b".repeat(40) } : {}),
              ...(mismatch === "buildId"
                ? { buildId: "22222222-2222-4222-8222-222222222222" }
                : {}),
              ...(mismatch === "domain" ? { site: "https://preview.example.org" } : {}),
            }),
          );
        return true;
      });
      await expect(f.submit()).rejects.toThrow();
      expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(0);
      expect(f.requests).toHaveLength(mismatch === "key" ? 6 : 12);
    },
  );

  it("waits for propagation then sends once", async () => {
    let checks = 0;
    const f = await fixture((req, res) => {
      if (req.url !== `/${INDEXNOW_MARKER}` || ++checks > 2) return false;
      res.end("previous-build");
      return true;
    });
    await f.submit();
    expect(checks).toBe(3);
    expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(1);
  });

  it.each([
    "http://mrstreamer.app/docs",
    "https://preview.example.org/docs",
    "https://www.mrstreamer.app/docs",
    `${SITE}/docs?x=1`,
    `${SITE}/docs#section`,
    `${SITE}/404`,
    `${SITE}/404.html`,
    `${SITE}/assets/main.js`,
    `${SITE}/docs/index.html`,
    `${SITE}/docs/`,
    `${SITE}/not-in-sitemap`,
    `https://user@mrstreamer.app/docs`,
    "not-a-url",
  ])("rejects invalid/non-registry URL %s before HTTP", async (url) => {
    const f = await fixture();
    writeFileSync(join(f.folder, INDEXNOW_MARKER), JSON.stringify({ ...manifest, urlList: [url] }));
    await expect(f.submit()).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
  });

  it.each(["ownership", "revision", "site", "key", "empty"])(
    "rejects invalid packaged %s before HTTP",
    async (invalid) => {
      const f = await fixture();
      if (invalid === "ownership") writeFileSync(join(f.folder, `${INDEXNOW_KEY}.txt`), "wrong");
      else
        writeFileSync(
          join(f.folder, INDEXNOW_MARKER),
          JSON.stringify({
            ...manifest,
            ...(invalid === "revision" ? { revision: "b".repeat(40) } : {}),
            ...(invalid === "site" ? { site: "https://preview.example.org" } : {}),
            ...(invalid === "key" ? { key: "bad" } : {}),
            ...(invalid === "empty" ? { urlList: [] } : {}),
          }),
        );
      await expect(f.submit()).rejects.toThrow();
      expect(f.requests).toHaveLength(0);
    },
  );

  it.each([429, 503])(
    "reports HTTP %s and never retries POST or waits for Retry-After",
    async (status) => {
      const f = await fixture((req, res) => {
        if (req.url !== "/api") return false;
        res.writeHead(status, { "Retry-After": "999999" });
        res.end("untrusted upstream body");
        return true;
      });
      await expect(f.submit()).rejects.toThrow(`HTTP ${status}`);
      expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(1);
    },
  );

  it.each(["public-headers", "public-body", "api", "disconnect"])(
    "bounds %s network failures without submission spam",
    async (failure) => {
      const f = await fixture((req, res) => {
        if (failure.startsWith("public") && req.url?.endsWith(".txt")) {
          if (failure === "public-body") {
            res.writeHead(200);
            res.write("partial");
          }
          return true;
        }
        if (req.url !== "/api") return false;
        if (failure === "disconnect") res.destroy();
        return true;
      });
      // Each request gets long enough to reach the fixture under a busy suite before its deadline
      // ends it, and the public reads, tried six times, stay quick. A disconnect ends at once.
      const requestTimeoutMs = failure === "disconnect" ? 2000 : failure === "api" ? 500 : 100;
      const started = Date.now();
      await expect(
        notifyIndexNow(f.folder, revision, { ...f.options, requestTimeoutMs }),
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(3000);
      expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(
        failure.startsWith("public") ? 0 : 1,
      );
      expect(f.requests.filter(({ path }) => path?.endsWith(".txt"))).toHaveLength(
        failure.startsWith("public") ? 6 : 1,
      );
    },
  );

  it("cancels during readiness without POST", async () => {
    const controller = new AbortController();
    const f = await fixture((req, res) => {
      if (!req.url?.endsWith(".txt")) return false;
      controller.abort();
      res.end("old-key");
      return true;
    });
    await expect(
      notifyIndexNow(f.folder, revision, { ...f.options, signal: controller.signal }),
    ).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
  });

  it("rejects oversized public proof and bounds readiness requests", async () => {
    const f = await fixture((req, res) => {
      if (!req.url?.endsWith(".txt")) return false;
      res.end("x".repeat(65_537));
      return true;
    });
    await expect(f.submit()).rejects.toThrow("64 KiB");
    expect(f.requests).toHaveLength(6);
  });
});

async function runCLI(folder: string, origin: string, onStart?: (cancel: () => void) => void) {
  // Exercise the unmodified production CLI. This external preload routes fetches only to the
  // loopback HTTP fixture and rejects any unexpected URL, so it cannot reach the real API.
  const preload = join(folder, "fixture.mjs");
  writeFileSync(
    preload,
    `const original = globalThis.fetch; globalThis.fetch = (input, init) => {
    const url = new URL(input);
    if (url.origin === "https://mrstreamer.app") return original(${JSON.stringify(origin)} + url.pathname, init);
    if (url.href === "https://api.indexnow.org/indexnow") return original(${JSON.stringify(origin)} + "/api", init);
    throw new Error("Unexpected external request in CLI fixture");
  };`,
  );
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", preload, join(import.meta.dirname, "../scripts/indexnow.ts"), folder, revision],
      {
        env: { PATH: process.env["PATH"], GITHUB_STEP_SUMMARY: join(folder, "summary.md") },
      },
    );
    onStart?.(() => {
      child.kill("SIGTERM");
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("IndexNow notification CLI", () => {
  it("cancels the real CLI during readiness with a nonzero exit and no POST", async () => {
    let cancel: (() => void) | undefined;
    const f = await fixture((req, res) => {
      if (!req.url?.endsWith(".txt")) return false;
      res.end("previous-key");
      cancel?.();
      return true;
    });
    const result = await runCLI(f.folder, f.origin, (stop) => {
      cancel = stop;
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("website is already deployed");
    expect(f.requests).toHaveLength(1);
  });
  // One accepted and one refused submission: how each status reads is the library's, above.
  it.each([200, 429])("retains the real exit and summary for HTTP %s", async (status) => {
    const f = await fixture((req, res) => {
      if (req.url !== "/api") return false;
      res.statusCode = status;
      res.end();
      return true;
    });
    const result = await runCLI(f.folder, f.origin);
    expect(result.code).toBe(status === 200 ? 0 : 1);
    const summary = readFileSync(join(f.folder, "summary.md"), "utf8");
    expect(summary).toContain(`HTTP ${status}`);
    if (status > 202) {
      expect(result.stderr).toContain("website is already deployed");
      expect(summary).toContain("website is already deployed");
    }
    expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(1);
  });
});
