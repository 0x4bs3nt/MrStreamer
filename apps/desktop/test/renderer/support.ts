// Stands in for the main process in the renderer's tests, which run with happy-dom. Every call is
// recorded; a call the test holds answers when the test says, and a method the test gave a
// standing answer, or failure, or a reply made from its input, answers with it each time. The preferences otherwise answer with the defaults
// and what the test says the viewer saved, a subscription's with nothing left in it, how a
// series' episodes stand with nothing played and nothing marked, and anything else never answers.
// Like the main process, it refuses a call whose input the contract doesn't allow, so a view
// can't pass here with a call that fails there. Tests send its events themselves. Import it
// first, before the renderer's modules: it also stands in for Media Source Extensions and full
// screen, which happy-dom lacks, and for a text track's hidden mode, which it refuses.
import { type } from "arktype";
import type { AppError, Result } from "@mrstreamer/contracts/errors";
import {
  ipcInputs,
  type BridgeApi,
  type IpcEvent,
  type IpcEvents,
  type IpcInput,
  type IpcMethod,
  type IpcOutput,
} from "@mrstreamer/contracts/ipc";
import {
  defaultPreferences,
  defaultSubscriptionPreferences,
  type Preferences,
} from "@mrstreamer/contracts/preferences";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";

/** The subscription the tests' channels, titles and episodes are listed by. */
export const SUBSCRIPTION = "3f6c1b5e-2a47-4d0e-9c1f-7b8a5d2e4f10";

/** That subscription as the main process lists it, for a test to give its page as the one saved. */
export const SAVED: SubscriptionSummary = {
  kind: "xtream",
  id: SUBSCRIPTION,
  name: null,
  server: "https://line.example.tv",
  username: "demo",
  account: { state: "active", expiresAt: null, maxConnections: 1, activeConnections: 0 },
  needsSecret: false,
};

const held = new Map<IpcMethod, Promise<Result<unknown>>[]>();
const standing = new Map<IpcMethod, Result<unknown>>();
const replies = new Map<IpcMethod, (args: unknown) => unknown>();
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const calls: { readonly method: IpcMethod; readonly args: unknown }[] = [];
let preferences = defaultPreferences;

export const ipc = {
  /** The arguments of each call to `method` so far, which its contract allowed. */
  argsOf: <M extends IpcMethod>(method: M): IpcInput<M>[] =>
    calls.filter((each) => each.method === method).map((each) => each.args as IpcInput<M>),
  /** The methods called so far, in order. */
  methods: (): IpcMethod[] => calls.map((each) => each.method),
  /** Holds the next call to `method` until the test answers it. */
  hold<M extends IpcMethod>(method: M) {
    let settle: (result: Result<unknown>) => void = () => {};
    const answer = new Promise<Result<unknown>>((resolve) => (settle = resolve));
    held.set(method, [...(held.get(method) ?? []), answer]);
    return {
      resolve: (value: IpcOutput<M>) => settle({ ok: true, value }),
      reject: (error: AppError) => settle({ ok: false, error }),
    };
  },
  /**
   * Answers every call to `method` that isn't held with `value` from now on, as the main process
   * answers a read again and again: what a view reads once more after a change, it finds.
   */
  always<M extends IpcMethod>(method: M, value: IpcOutput<M>): void {
    standing.set(method, { ok: true, value });
  },
  /**
   * Answers every call to `method` that isn't held with what `reply` makes of its input, as the
   * main process answers a read by what it asks for.
   */
  answer<M extends IpcMethod>(method: M, reply: (args: IpcInput<M>) => IpcOutput<M>): void {
    replies.set(method, (args) => reply(args as IpcInput<M>));
  },
  /** Fails every call to `method` that isn't held with `error`, until `always` gives it an answer. */
  refuse(method: IpcMethod, error: AppError): void {
    standing.set(method, { ok: false, error });
  },
  /** Sends an event from the main process. */
  emit<E extends IpcEvent>(event: E, payload: IpcEvents[E]): void {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  },
  /** Answers the preferences with `saved` over the defaults, as after the viewer set them. */
  prefer(saved: Partial<Preferences>): void {
    preferences = { ...defaultPreferences, ...saved };
  },
  /** Forgets the calls, held answers and saved preferences of the test before. */
  reset(): void {
    calls.length = 0;
    held.clear();
    standing.clear();
    replies.clear();
    preferences = defaultPreferences;
  },
};

/** Each method's input check, built once as the main process builds it, not again per call. */
const checks = new Map<IpcMethod, (data: unknown) => unknown>();
const checkOf = (method: IpcMethod) => {
  const known = checks.get(method);
  if (known) return known;
  const schema: () => (data: unknown) => unknown = ipcInputs[method];
  const check = schema();
  checks.set(method, check);
  return check;
};

const bridge = {
  invoke(method: IpcMethod, args?: unknown): Promise<Result<unknown>> {
    const input = checkOf(method)(args);
    if (input instanceof type.errors) {
      return Promise.resolve({
        ok: false,
        error: { kind: "invalid-input", detail: `${method}: ${input.summary}` },
      });
    }
    calls.push({ method, args });
    const answer = held.get(method)?.shift();
    if (answer) return answer;
    const always = standing.get(method);
    if (always) return Promise.resolve(always);
    const reply = replies.get(method);
    if (reply) return Promise.resolve({ ok: true, value: reply(args) });
    if (method.startsWith("analytics.")) return Promise.resolve({ ok: true, value: null });
    if (method === "viewing.episodes") {
      return Promise.resolve({ ok: true, value: { progress: [], marks: [], undoable: null } });
    }
    if (method === "preferences.get") {
      return Promise.resolve({ ok: true, value: preferences });
    }
    if (method === "subscription.preferences") {
      return Promise.resolve({ ok: true, value: defaultSubscriptionPreferences });
    }
    return new Promise(() => {});
  },
  on(event: string, listener: (payload: unknown) => void) {
    const set = listeners.get(event) ?? new Set();
    set.add(listener);
    listeners.set(event, set);
    return () => set.delete(listener);
  },
};

/**
 * happy-dom has no Media Source Extensions. This stand-in opens and takes no data, so a title's
 * run gets as far as its subtitles, and no further. It plays no codec, so live streams keep to
 * the element's own engine rather than hls.js or mpegts.js.
 */
class StandInMediaSource extends EventTarget {
  static isTypeSupported = () => false;
  readyState = "closed";
  constructor() {
    super();
    setTimeout(() => {
      this.readyState = "open";
      this.dispatchEvent(new Event("sourceopen"));
    });
  }
  endOfStream(): void {}
}
Object.assign(globalThis, { MediaSource: StandInMediaSource });
// Nor a MediaError, whose codes the player reads when the element reports an error. A test sends
// that `error` event itself, for a stream that stops.
Object.assign(globalThis, { MediaError: { MEDIA_ERR_SRC_NOT_SUPPORTED: 4 } });
// The element gets an address for it, as it would for a real one.
const objectUrl = URL.createObjectURL.bind(URL);
URL.createObjectURL = (object) =>
  object instanceof StandInMediaSource ? "blob:stand-in" : objectUrl(object);

const fullScreenAnswers = { request: [] as Promise<void>[], exit: [] as Promise<void>[] };

/**
 * happy-dom has no full screen. This is the page's side of it, as a browser has it: the page's
 * requests and exits are granted at once, unless a test holds one. Whether the window itself
 * fills the screen is the main process's word, `window.fullScreen`, which a test sends.
 */
export const fullScreen = {
  /** Whether the page fills the screen, as `document.fullscreenElement` says. */
  on: false,
  /** How often the page asked for full screen. */
  requests: 0,
  /** Holds the page's next request for full screen, or its next exit, until the test answers. */
  hold(what: "request" | "exit") {
    const answer = Promise.withResolvers<void>();
    fullScreenAnswers[what].push(answer.promise);
    return {
      grant: () => answer.resolve(),
      refuse: () => answer.reject(new TypeError("Refused.")),
    };
  },
  /** The page as it starts: not full screen, with nothing asked and nothing held. */
  reset(): void {
    fullScreen.on = false;
    fullScreen.requests = 0;
    fullScreenAnswers.request.length = 0;
    fullScreenAnswers.exit.length = 0;
  },
};
Object.defineProperties(document, {
  fullscreenElement: {
    configurable: true,
    get: () => (fullScreen.on ? document.documentElement : null),
  },
  exitFullscreen: {
    configurable: true,
    value: async () => {
      await fullScreenAnswers.exit.shift();
      fullScreen.on = false;
    },
  },
});
Object.defineProperty(document.documentElement, "requestFullscreen", {
  configurable: true,
  value: async () => {
    fullScreen.requests += 1;
    await fullScreenAnswers.request.shift();
    fullScreen.on = true;
  },
});

/**
 * happy-dom refuses a text track's "hidden" mode, in which a browser times the cues and draws
 * none, and lists the cues of no track it leaves disabled. Showing stands in for it here: the cues
 * are listed, and happy-dom draws nothing either way. It times none, so a test moves the element's
 * clock and sends `seeked` itself.
 */
const inherited: object = Object.getPrototypeOf(TextTrack.prototype);
Object.defineProperty(TextTrack.prototype, "mode", {
  configurable: true,
  get(this: TextTrack): TextTrackMode {
    return Reflect.get(inherited, "mode", this);
  },
  set(this: TextTrack, mode: TextTrackMode) {
    Reflect.set(inherited, "mode", mode === "hidden" ? "showing" : mode, this);
  },
});

// The contract types each method's answer; the stand-in answers whatever the test gives.
const api: BridgeApi = bridge as unknown as BridgeApi;
Object.assign(window, { mrStreamer: api });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
