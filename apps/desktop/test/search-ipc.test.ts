import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import type { Result } from "@mrstreamer/contracts/errors";
import type { IpcInput, IpcMethod } from "@mrstreamer/contracts/ipc";
import * as Effect from "effect/Effect";
import { registerIpc, type IpcHandlers } from "../src/main/ipc.ts";

const boundary = vi.hoisted(
  () => new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<Result<unknown>>>(),
);
vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      method: string,
      handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<Result<unknown>>,
    ) => boundary.set(method, handler),
  },
}));

function sender(id: number) {
  const events = new EventEmitter();
  return Object.assign(events, {
    id,
    mainFrame: { processId: id, routingId: 1 },
  }) as unknown as WebContents;
}
function invoke(method: IpcMethod, from: WebContents, input: unknown) {
  return boundary.get(method)!(
    { sender: from, senderFrame: from.mainFrame } as IpcMainInvokeEvent,
    input,
  );
}
const request = (view = "palette", id = "first") => ({ view, id });
const search = (from: WebContents, metadata = request()) =>
  invoke("guide.search", from, { query: "fixture", request: metadata });
const cancel = (from: WebContents, metadata = request()) =>
  invoke("guide.cancelSearch", from, metadata);

beforeEach(() => boundary.clear());
function start(handler: IpcHandlers["guide.search"] = () => Effect.never) {
  // Only these public methods are exercised; registerIpc still registers all contracts.
  const handlers = {
    "guide.search": handler,
    "guide.searchList": handler,
    "guide.cancelSearch": () => Effect.succeed(null),
  } as unknown as IpcHandlers;
  registerIpc(Effect.runPromiseExit, handlers, () => true);
}

describe("owned guide-search IPC", () => {
  it("cancels only the named sender and view, with no failure diagnostics", async () => {
    start();
    const a = sender(1),
      b = sender(2);
    const first = search(a),
      otherView = search(a, request("live")),
      otherWindow = search(b);
    await cancel(a);
    expect(await first).toMatchObject({ ok: false });
    expect(a.listenerCount("destroyed")).toBe(1);
    await cancel(a, request("live"));
    await cancel(b);
    await Promise.all([otherView, otherWindow]);
    expect(a.listenerCount("destroyed")).toBe(0);
    expect(b.listenerCount("destroyed")).toBe(0);
  });

  it("keeps file cleanup held until interrupted work has stopped", async () => {
    let release = () => {};
    const ending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stopped = false;
    start(() => Effect.never.pipe(Effect.onInterrupt(() => Effect.promise(() => ending))));
    const a = sender(1);
    const pending = search(a).then((answer) => {
      stopped = true;
      return answer;
    });
    await cancel(a);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    release();
    await pending;
    expect(stopped).toBe(true);
    expect(a.listenerCount("destroyed")).toBe(0);
  });

  it.each(["destroyed", "render-process-gone", "did-start-navigation"])(
    "settles pending calls on %s and removes its listeners",
    async (event) => {
      start();
      const a = sender(1);
      const pending = [search(a), search(a, request("live"))];
      a.emit(event, { isMainFrame: true, isSameDocument: false });
      await Promise.all(pending);
      for (const name of ["destroyed", "render-process-gone", "did-start-navigation"])
        expect(a.listenerCount(name)).toBe(0);
    },
  );

  it("cleans settled calls, accepts legacy input, and ignores a late cancel of a replacement", async () => {
    start((input) => (input.query === "complete" ? Effect.succeed([]) : Effect.never));
    const a = sender(1);
    expect(await invoke("guide.search", a, { query: "complete" })).toEqual({ ok: true, value: [] });
    expect(await invoke("guide.search", a, { query: "complete", request: request() })).toEqual({
      ok: true,
      value: [],
    });
    expect(a.listenerCount("destroyed")).toBe(0);
    const next = search(a, request("palette", "replacement"));
    await cancel(a);
    expect(a.listenerCount("destroyed")).toBe(1);
    await cancel(a, request("palette", "replacement"));
    await next;
  });

  it("refuses duplicate active identities and subframe cancellation", async () => {
    start();
    const a = sender(1);
    const first = search(a);
    expect(await search(a)).toMatchObject({ ok: false, error: { kind: "invalid-input" } });
    expect(
      await boundary.get("guide.cancelSearch")!(
        { sender: a, senderFrame: { processId: 1, routingId: 2 } } as IpcMainInvokeEvent,
        request(),
      ),
    ).toMatchObject({ ok: false });
    await cancel(a);
    await first;
  });

  it("validates additive request metadata and cancellation input", async () => {
    start();
    const a = sender(1);
    const invalid: IpcInput<"guide.search"> = { query: "fixture", request: { view: "", id: "" } };
    expect(await invoke("guide.search", a, invalid)).toMatchObject({
      ok: false,
      error: { kind: "invalid-input" },
    });
    expect(await invoke("guide.cancelSearch", a, {})).toMatchObject({
      ok: false,
      error: { kind: "invalid-input" },
    });
    expect(a.listenerCount("destroyed")).toBe(0);
  });

  it("limits active searches and releases a slot after cancellation", async () => {
    start();
    const a = sender(1);
    const pending = Array.from({ length: 256 }, (_, i) => search(a, request("palette", `${i}`)));
    expect(await search(a, request("palette", "overflow"))).toMatchObject({
      ok: false,
      error: { kind: "invalid-input" },
    });
    await cancel(a, request("palette", "0"));
    await pending[0];
    const replacement = search(a, request("palette", "replacement"));
    a.emit("render-process-gone");
    expect(await replacement).toMatchObject({ ok: false, error: { detail: "Closing." } });
    await Promise.all(pending);
    expect(a.listenerCount("destroyed")).toBe(0);
  });
});
