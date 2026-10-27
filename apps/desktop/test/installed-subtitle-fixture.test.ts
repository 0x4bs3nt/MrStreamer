import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { subtitleServiceClient } from "../src/main/subtitles/service-client.ts";
import { connect } from "./e2e/app.ts";
import {
  bootstrapSubtitles,
  pauseMain,
  inspectorOwner,
  resumeMain,
  startSubtitleFixture,
  subtitleFetch,
  subtitleRequests,
  SUBTITLE_CUE,
  SUBTITLE_RELEASE,
} from "./e2e/installed-subtitles.ts";

describe("installed subtitle network boundary", () => {
  it("uses the real service protocol and ZIP parser with a loopback fixture", async () => {
    const fixture = await startSubtitleFixture();
    try {
      const client = subtitleServiceClient({
        userAgent: "installed-upgrade-contract",
        fetch: subtitleFetch(fixture.origin, fetch),
      });
      const signal = new AbortController().signal;
      const candidates = await client.subdlSearch(
        { apiKey: "synthetic-installed-subdl" },
        { tmdbId: 123, kind: "movie", languages: ["en"] },
        signal,
      );
      expect(candidates).toHaveLength(1);
      const downloaded = await client.download(
        candidates[0]!,
        { subdl: { apiKey: "synthetic-installed-subdl" } },
        signal,
      );
      expect(downloaded.subtitle).toEqual({
        service: "subdl",
        language: "en",
        release: SUBTITLE_RELEASE,
        cues: [SUBTITLE_CUE],
      });
      expect(fixture.requests.map(({ host }) => host)).toEqual(["api.subdl.com", "dl.subdl.com"]);
    } finally {
      await fixture.stop();
    }
  });

  it("forwards a Request's method, body, headers and query, and leaves other hosts alone", async () => {
    const server = createServer((request, response) => {
      void (async () => {
        const body = [];
        for await (const chunk of request) body.push(Buffer.from(chunk));
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            path: request.url,
            method: request.method,
            header: request.headers["x-contract"],
            body: Buffer.concat(body).toString(),
          }),
        );
      })();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No echo address");
    const origin = `http://127.0.0.1:${address.port}`;
    const observations: { host: string; path: string }[] = [];
    try {
      const boundary = subtitleFetch(origin, fetch, (request) => observations.push(request));
      const response = await boundary(
        new Request("https://api.subdl.com/api/v1/subtitles?film_name=two+words", {
          method: "POST",
          body: "literal body",
          headers: { "x-contract": "preserved" },
        }),
      );
      expect(await response.json()).toEqual({
        path: "/api.subdl.com/api/v1/subtitles?film_name=two+words",
        method: "POST",
        header: "preserved",
        body: "literal body",
      });
      const delegated = await boundary(`${origin}/unrelated?unchanged=1`);
      expect(await delegated.json()).toMatchObject({
        path: "/unrelated?unchanged=1",
        method: "GET",
      });
      expect(observations).toEqual([
        expect.objectContaining({ host: "api.subdl.com", path: "/api/v1/subtitles" }),
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("preserves cancellation and records failed attempts after the fixture stops", async () => {
    const fixture = await startSubtitleFixture();
    const attempts: string[] = [];
    const request = subtitleFetch(fixture.origin, fetch, (each) => attempts.push(each.host));
    try {
      const controller = new AbortController();
      controller.abort(new Error("contract cancellation"));
      await expect(
        request("https://dl.subdl.com/installed-upgrade.zip", { signal: controller.signal }),
      ).rejects.toThrow("contract cancellation");
      await fixture.stop();
      await expect(request("https://dl.subdl.com/installed-upgrade.zip")).rejects.toThrow();
      expect(attempts).toEqual(["dl.subdl.com", "dl.subdl.com"]);
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.stop();
    }
  });

  it("bootstraps a real paused Node main before code captures fetch", async () => {
    const fixture = await startSubtitleFixture();
    const root = await mkdtemp(join(tmpdir(), "installed-subtitle-inspector-"));
    const entry = join(root, "entry.cjs");
    await writeFile(
      entry,
      `
      (async () => {
      if (!globalThis[Symbol.for('mrstreamer.installedSubtitles')]) throw new Error('Entry ran before network bootstrap');
      // The packaged app replaces fetch at startup before clients capture it.
      const { install, MockAgent, setGlobalDispatcher } = require(${JSON.stringify(createRequire(new URL("../package.json", import.meta.url)).resolve("undici"))});
      const isolated = new MockAgent();
      isolated.disableNetConnect();
      isolated.enableNetConnect(${JSON.stringify(new URL(fixture.origin).host)});
      setGlobalDispatcher(isolated);
      install();
      const request = fetch;
      const response = await request('https://api.subdl.com/api/v1/subtitles?api_key=synthetic-installed-subdl&type=movie&tmdb_id=123&languages=EN');
      const reply = await response.json();
      const zip = await request(reply.subtitles[0].url);
      process.stdout.write(JSON.stringify({pid:process.pid,release:reply.subtitles[0].release_name,zipBytes:(await zip.arrayBuffer()).byteLength}) + '\\n');
      // Stays up, for the test to read what it sent, until the test closes its input.
      await new Promise(resolve => process.stdin.on('end', resolve).resume());
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `,
    );
    const child = spawn(process.execPath, ["--inspect-brk=127.0.0.1:0", entry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "" },
    });
    let main: Awaited<ReturnType<typeof connect>> | undefined;
    const ended = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let stderr = "";
        const deadline = setTimeout(
          () => reject(new Error("Inspector did not announce a loopback port")),
          10_000,
        );
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
          const found = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);
          if (found) {
            clearTimeout(deadline);
            resolve(Number(found[1]));
          }
        });
        child.once("error", (error) => {
          clearTimeout(deadline);
          reject(error);
        });
      });
      main = await connect(port, "node", { pollMs: 10 });
      expect(await inspectorOwner(port, [child.pid!])).toBe(child.pid);
      await expect(inspectorOwner(port, [process.pid])).rejects.toThrow("not an owned launch");
      const paused = await pauseMain(main);
      expect(await paused.evaluate("process.pid")).toBe(child.pid);
      expect(await bootstrapSubtitles(paused, fixture.origin)).toMatchObject({
        pid: child.pid,
        origin: fixture.origin,
      });
      await resumeMain(main);
      const until = Date.now() + 10_000;
      while (!output.includes("\n") && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(JSON.parse(output.trim())).toMatchObject({
        pid: child.pid,
        release: SUBTITLE_RELEASE,
        zipBytes: expect.any(Number),
      });
      expect(await subtitleRequests(main)).toEqual([
        expect.objectContaining({ host: "api.subdl.com", path: "/api/v1/subtitles" }),
        expect.objectContaining({ host: "dl.subdl.com", path: "/installed-upgrade.zip" }),
      ]);
      main.close();
      child.stdin.end();
      expect(await ended).toEqual({ code: 0, signal: null });
    } finally {
      main?.close();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await ended;
      await fixture.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
