import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { Page } from "./e2e/app.ts";
import { browserFacts, probe } from "./e2e/installed-media-observer.ts";

function observer(fetch: typeof globalThis.fetch) {
  // These APIs are never invoked here. This contract checks observation, not codec support.
  class MediaSource {
    static isTypeSupported() {
      throw new Error("No native MSE in this Node contract check");
    }
    addSourceBuffer() {
      throw new Error("No native MSE in this Node contract check");
    }
  }
  const context = createContext({
    fetch,
    MediaSource,
    URL,
    Request,
    Date,
    document: { baseURI: "http://127.0.0.1/", addEventListener() {} },
  });
  runInContext("window=globalThis", context);
  const listeners = new Map<string, (data: unknown) => void>();
  const page = {
    async evaluate<T>(expression: string): Promise<T> {
      return structuredClone(await runInContext(expression, context)) as T;
    },
    on(method: string, listener: (data: unknown) => void) {
      listeners.set(method, listener);
      return () => listeners.delete(method);
    },
    async send() {
      return {};
    },
  } satisfies Pick<Page, "evaluate" | "on" | "send">;
  return { page, context, listeners };
}

describe("installed media response observation", () => {
  it("records the real response before its consumer even when the CDP callback is delayed", async () => {
    const response = new Response("unaltered title bytes", {
      status: 200,
      headers: { "X-Title-Video": "copy", "X-Title-Audio": "copy" },
    });
    Object.defineProperty(response, "url", { value: "http://127.0.0.1/title/actual.mp4?start=0" });
    const original = vi.fn<typeof fetch>().mockResolvedValue(response);
    const { page, context, listeners } = observer(original);
    const seen = await probe(page);
    const window = await seen.beginWindow("offline-short");
    const delivered = await runInContext(
      "fetch('http://127.0.0.1/title/actual.mp4?start=0')",
      context,
    );
    expect(delivered).toBe(response);
    expect(response.bodyUsed).toBe(false);
    // The title consumer has its Response; Node has not received the CDP notification.
    expect((await seen.windowFacts(window)).deliveries).toMatchObject([
      { status: 200, video: "copy", audio: "copy", url: response.url },
    ]);
    listeners.get("Network.responseReceived")?.({
      requestId: "delayed-cdp",
      timestamp: 42,
      response: {
        url: response.url,
        status: response.status,
        headers: { "X-Title-Video": "copy" },
      },
    });
    expect((await seen.windowFacts(window)).deliveries).toHaveLength(1);
    expect(await delivered.text()).toBe("unaltered title bytes");
    expect(seen.network).toMatchObject([
      { nodeReceivedAt: expect.any(Number), data: { requestId: "delayed-cdp", timestamp: 42 } },
    ]);
  });

  it("keeps late previous-window responses and subtitle-only fetches out of the current window", async () => {
    const response = new Response("bytes", { headers: { "x-title-video": "convert" } });
    Object.defineProperty(response, "url", {
      value: "http://127.0.0.1/title/actual.mp4?picture=convert",
    });
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const original = vi.fn<typeof fetch>().mockReturnValueOnce(pending).mockResolvedValue(response);
    const { page, context } = observer(original);
    const seen = await probe(page);
    const prior = await seen.beginWindow("provider-long");
    const late = runInContext("fetch('/title/actual.mp4')", context);
    const current = await seen.beginWindow("offline-short");
    await runInContext("fetch('/title/actual.mp4?only=subtitles')", context);
    expect((await browserFacts(page)).currentDelivery).toBeNull();
    await runInContext("fetch('/title/actual.mp4?picture=convert')", context);
    finish(response);
    expect(await late).toBe(response);
    const facts = await browserFacts(page);
    const previous = facts.deliveries.find((item) => item.requestId === 1)!;
    expect(previous).toMatchObject({
      window: prior.window,
      responseWindow: current.window,
      requestId: 1,
    });
    expect(facts.currentDelivery?.requestId).toBe(2);
    expect(facts.requests).toHaveLength(2);
    const delivery = (await seen.windowFacts(current)).deliveries[0]!;
    expect(delivery).toMatchObject({
      window: current.window,
      responseWindow: current.window,
      requestId: 2,
      video: "convert",
    });
    expect(current.sequence).toBeLessThan(delivery.requestSequence);
    expect(delivery.requestSequence).toBeLessThan(delivery.sequence);
    expect((await seen.windowFacts(current)).deliveries).toHaveLength(1);
  });

  it("passes the same receiver, arguments, Response, unread body and rejection through", async () => {
    const response = new Response("original bytes");
    Object.defineProperty(response, "url", { value: "http://127.0.0.1/title/actual.mp4" });
    const clone = vi.spyOn(response, "clone");
    const read = vi.spyOn(response.body!, "getReader");
    const original = vi.fn<typeof fetch>().mockResolvedValue(response);
    const { page, context } = observer(original);
    await probe(page);
    const request = new Request(response.url);
    const init = { signal: new AbortController().signal };
    const receiver = {};
    Object.assign(context, { request, init, receiver });
    expect(await runInContext("fetch.call(receiver,request,init)", context)).toBe(response);
    expect(original.mock.contexts[0]).toBe(receiver);
    expect(original.mock.calls[0]![0]).toBe(request);
    expect(original.mock.calls[0]![1]).toBe(init);
    expect(response.bodyUsed).toBe(false);
    expect(clone).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    const rejection = new Error("original fetch failure");
    original.mockRejectedValueOnce(rejection);
    await expect(runInContext("fetch.call(receiver,request,init)", context)).rejects.toBe(
      rejection,
    );
    original.mockRejectedValueOnce(rejection);
    await expect(runInContext("fetch('http://[')", context)).rejects.toBe(rejection);
    expect(await response.text()).toBe("original bytes");
  });
});
