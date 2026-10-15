// The workbench side of the iOS runtime proof. It answers the proof cases' requests, takes the
// app's report, runs the same cases in Node and writes what both observed to
// .local/ios-proof/<time>.json, saying which shared rules gave Hermes another answer than Node.
//
//   node scripts/proof-server.ts [port]     (default 8790)
//
// Build or start the app with EXPO_PUBLIC_PROOF_URL=http://127.0.0.1:<port> and forward the port
// to the simulator (`onmac tunnel <port>`). Each launch of the app sends one report.
import { createServer, type IncomingMessage } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { runCases, type CaseResult } from "../src/proof/run.ts";

const port = Number(process.argv[2] ?? 8790);
const origin = `http://127.0.0.1:${port}`;
const receipts = join(import.meta.dirname, "../../../.local/ios-proof");

interface Report {
  readonly runtime: unknown;
  readonly uncaught: readonly string[];
  readonly results: readonly CaseResult[];
}

/** What the server saw of the app's requests, for the cases whose finding is on this side. */
const seen = { echo: [] as unknown[], holdsClosedByClient: 0 };

const body = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

async function compare(report: Report) {
  const node = await runCases({ fixture: origin, fetches: { global: fetch } });
  const byName = new Map(node.map((result) => [result.name, result]));
  const verdicts = report.results.map((app) => {
    const reference = byName.get(app.name);
    const verdict =
      app.compare === "record"
        ? app.thrown
          ? "threw"
          : "recorded"
        : reference && !app.thrown && isDeepStrictEqual(app.value, reference.value)
          ? "same"
          : "differs";
    return { name: app.name, verdict, app, node: reference ?? null };
  });
  return verdicts;
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", origin).pathname;
  switch (path) {
    case "/redirect":
      response.writeHead(302, { Location: "/ok" }).end();
      return;
    case "/ok":
      response.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    case "/echo": {
      const headers = {
        userAgent: request.headers["user-agent"],
        referer: request.headers.referer,
      };
      seen.echo.push(headers);
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(headers));
      return;
    }
    case "/chunks": {
      response.writeHead(200, { "Content-Type": "text/plain" });
      for (const part of ["one\n", "two\n", "three\n"]) {
        response.write(part);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      response.end();
      return;
    }
    case "/hold":
      // Never answered: the case aborts it, and the closed socket shows the abort reached here.
      request.socket.once("close", () => seen.holdsClosedByClient++);
      return;
    case "/report": {
      const report = JSON.parse(await body(request)) as Report;
      response.writeHead(204).end();
      const verdicts = await compare(report);
      const at = new Date().toISOString();
      await mkdir(receipts, { recursive: true });
      const file = join(receipts, `${at.replaceAll(":", "-")}.json`);
      await writeFile(
        file,
        JSON.stringify(
          { at, runtime: report.runtime, uncaught: report.uncaught, seen, verdicts },
          null,
          2,
        ),
      );
      for (const { name, verdict } of verdicts) console.log(`${verdict.padEnd(8)} ${name}`);
      console.log(`receipt ${file}`);
      return;
    }
    default:
      response.writeHead(404).end();
  }
});

server.listen(port, "127.0.0.1", () => console.log(`proof server on ${origin}`));
