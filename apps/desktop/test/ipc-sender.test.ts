// Who the main process answers: the current main frame of the window it trusts. Every method
// checks that before reading its input, so a call from another frame of that window, from a frame
// that has since gone, or from another window changes nothing. Custom lists here are the app's own
// service on a database in a temporary folder; the other handlers note each call they get.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import type { Result } from "@mrstreamer/contracts/errors";
import type { IpcMethod } from "@mrstreamer/contracts/ipc";
import * as Effect from "effect/Effect";
import { customListHandlers } from "../src/main/handlers/custom-lists.ts";
import { registerIpc, type IpcHandlers } from "../src/main/ipc.ts";
import { mainLayer } from "../src/main/runtime.ts";
import { CustomLists } from "../src/main/services/custom-lists.ts";
import { runtimeFor, tempDir, testConfig } from "./support.ts";

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

/** A window's page as Electron gives it to main: the same main frame object on every call. */
function page(processId: number) {
  const mainFrame = { processId, routingId: 1, parent: null };
  return Object.assign(new EventEmitter(), { mainFrame }) as unknown as WebContents;
}

/** A frame inside `of`'s page, as an iframe of it is, in the same renderer process. */
function childOf(of: WebContents) {
  const parent = of.mainFrame;
  return { processId: parent.processId, routingId: 2, parent } as unknown as WebFrameMain;
}

const refused = {
  ok: false,
  error: { kind: "unexpected", detail: "IPC call from an unknown window." },
};

/** The app's custom lists and noting handlers behind the IPC boundary, trusting `window` alone. */
async function start() {
  const runtime = runtimeFor(mainLayer(testConfig(await tempDir())));
  const customLists = await runtime.runPromise(CustomLists);
  const window = page(1);
  const calls: string[] = [];
  const note = (call: string) =>
    Effect.sync(() => {
      calls.push(call);
      return null;
    });
  const handlers: Partial<IpcHandlers> = {
    ...customListHandlers({ customLists }),
    "reminders.cancel": ({ id }) => note(`reminders.cancel ${id}`),
    "downloads.pauseAll": () => note("downloads.pauseAll"),
    "downloads.move": ({ id, by }) => note(`downloads.move ${id} ${by}`),
    "guide.search": ({ query }) => Effect.as(note(`guide.search ${query}`), []),
    "analytics.action": (action) => note(`analytics.action ${action}`),
  };
  // Only these methods are called; registerIpc still registers every contract.
  registerIpc(
    (effect) => runtime.runPromiseExit(effect),
    handlers as IpcHandlers,
    (sender) => sender === window,
  );
  const call = (
    method: IpcMethod,
    senderFrame: WebFrameMain | null,
    input?: unknown,
    sender = window,
  ) => boundary.get(method)!({ sender, senderFrame } as IpcMainInvokeEvent, input);
  return { window, calls, call };
}

const search = { view: "palette", id: "first" };
/** Representative methods, with what their handler notes when one runs. */
const methods: { name: string; method: IpcMethod; input: unknown; noted: string | null }[] = [
  {
    name: "customLists.create",
    method: "customLists.create",
    input: { id: "frame-list", name: "Frame" },
    noted: null,
  },
  {
    name: "reminders.cancel",
    method: "reminders.cancel",
    input: { id: "reminder" },
    noted: "reminders.cancel reminder",
  },
  {
    name: "downloads.pauseAll",
    method: "downloads.pauseAll",
    input: undefined,
    noted: "downloads.pauseAll",
  },
  {
    name: "downloads.move",
    method: "downloads.move",
    input: { id: "download", by: 1 },
    noted: "downloads.move download 1",
  },
  // Without request metadata a search can't be cancelled, and needed no main frame before.
  {
    name: "guide.search without request metadata",
    method: "guide.search",
    input: { query: "legacy" },
    noted: "guide.search legacy",
  },
  {
    name: "guide.search with request metadata",
    method: "guide.search",
    input: { query: "owned", request: search },
    noted: "guide.search owned",
  },
  { name: "guide.cancelSearch", method: "guide.cancelSearch", input: search, noted: null },
  {
    name: "analytics.action",
    method: "analytics.action",
    input: "search_used",
    noted: "analytics.action search_used",
  },
];
const senders = {
  "another frame of the window": (window: WebContents) => ({
    sender: window,
    frame: childOf(window),
  }),
  "a frame of the window that has gone": (window: WebContents) => ({ sender: window, frame: null }),
  "another window": () => {
    const other = page(2);
    return { sender: other, frame: other.mainFrame };
  },
};
const refusals = methods.flatMap((method) =>
  Object.entries(senders).map(([from, sender]) => ({ ...method, from, sender })),
);

describe("IPC sender ownership", () => {
  beforeEach(() => boundary.clear());

  it("makes a list for the window's main frame only, and shows only that one", async () => {
    const { window, call } = await start();
    const other = page(2);
    const create = (name: string) => ({ id: randomUUID(), name });
    expect(await call("customLists.create", window.mainFrame, create("Main"))).toMatchObject({
      ok: true,
      value: [{ name: "Main" }],
    });
    expect(await call("customLists.create", childOf(window), create("Frame"))).toEqual(refused);
    expect(await call("customLists.create", null, create("Gone"))).toEqual(refused);
    expect(await call("customLists.create", other.mainFrame, create("Other"), other)).toEqual(
      refused,
    );
    expect(await call("customLists.get", childOf(window))).toEqual(refused);
    expect(await call("customLists.get", window.mainFrame)).toMatchObject({
      ok: true,
      value: [{ name: "Main" }],
    });
  });

  it.each(refusals)(
    "refuses $name from $from before it runs",
    async ({ method, input, sender: from }) => {
      const { window, calls, call } = await start();
      const { sender, frame } = from(window);
      expect(await call(method, frame, input, sender)).toEqual(refused);
      expect(calls).toEqual([]);
      expect(await call("customLists.get", window.mainFrame)).toEqual({ ok: true, value: [] });
    },
  );

  it("refuses another frame before reading its input", async () => {
    const { window, call } = await start();
    expect(await call("customLists.create", childOf(window), { id: "" })).toEqual(refused);
    expect(await call("guide.search", null, { query: 1 })).toEqual(refused);
  });

  it("refuses a former main frame after the window's current frame changes", async () => {
    const { window, call } = await start();
    const former = window.mainFrame;
    Object.assign(window, { mainFrame: page(3).mainFrame });
    expect(await call("customLists.create", former, { id: "former", name: "Former" })).toEqual(
      refused,
    );
    expect(await call("customLists.get", window.mainFrame)).toEqual({ ok: true, value: [] });
  });

  it("preserves the service's typed refusal for an authorized call", async () => {
    const { window, call } = await start();
    expect(
      await call("customLists.create", window.mainFrame, { id: "one", name: "One" }),
    ).toMatchObject({ ok: true });
    expect(
      await call("customLists.create", window.mainFrame, { id: "two", name: "One" }),
    ).toMatchObject({ ok: false, error: { kind: "list-name-taken" } });
    expect(await call("customLists.get", window.mainFrame)).toMatchObject({
      ok: true,
      value: [{ id: "one", name: "One" }],
    });
  });

  it.each(methods)("runs $name for the window's main frame", async ({ method, input, noted }) => {
    const { window, calls, call } = await start();
    expect(await call(method, window.mainFrame, input)).toMatchObject({ ok: true });
    expect(calls).toEqual(noted ? [noted] : []);
  });

  it.each([
    ["customLists.create", { id: "", name: "No id" }],
    ["reminders.cancel", { id: "" }],
    ["downloads.move", { id: "download", by: 2 }],
    ["guide.search", { query: 1 }],
    ["analytics.action", "made_up"],
  ] as const)("answers %s from the main frame with invalid input", async (method, input) => {
    const { window, calls, call } = await start();
    expect(await call(method, window.mainFrame, input)).toMatchObject({
      ok: false,
      error: { kind: "invalid-input" },
    });
    expect(calls).toEqual([]);
    expect(await call("customLists.get", window.mainFrame)).toEqual({ ok: true, value: [] });
  });
});
