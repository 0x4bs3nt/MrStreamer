// Main's fetch, as main/index.ts installs it before anything else. A server that declares more
// content codings than fetch takes and closes before the body fails that request like an
// unreachable one; nothing escapes afterwards, and the next request is answered.
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import "../src/main/fetch.ts";

describe("Main's fetch", () => {
  it("fails an answer with more than five content codings that ends before its body, and goes on", async () => {
    // One request per connection: /codings gets six content codings, a length and no body.
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", (head) => {
        socket.end(
          head.toString("latin1").startsWith("GET /codings ")
            ? "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Encoding: gzip,gzip,gzip,gzip,gzip,gzip\r\nConnection: close\r\n\r\n"
            : "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK",
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await expect(fetch(`${origin}/codings`)).rejects.toThrow(TypeError);
      // What a stream left behind would throw as the socket closes, a moment later.
      await delay(250);
      expect(await (await fetch(`${origin}/`)).text()).toBe("OK");
    } finally {
      server.close();
    }
  });
});
