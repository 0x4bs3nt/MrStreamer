import { Window } from "happy-dom";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Source } from "../src/sources.ts";
import { native } from "./native-files.ts";

// Channel logos and title pictures as the viewer meets them: ChannelLogo and Artwork render with
// React DOM on a happy-dom window, over the files stand-in (native-files.ts, whose DownloadTask
// fetches as the native one does) and a picture server on this machine that counts each request.
// A relaunch imports the app's modules again over the same files. What a picture shows is read
// off the page: its file, the fallback (a monogram, a title's name), or nothing while it loads.

// React DOM resolves from the desktop app's install, which the iOS app's types don't see.
const REACT_DOM = "react-dom/client";
const window = new Window();
Object.assign(globalThis, { window, document: window.document });
const { document } = window;

/** Each picture's Image error handler, by the file it shows: a file that won't draw calls it. */
const drawn = vi.hoisted(() => new Map<string, () => void>());

vi.mock("expo-file-system", () => import("./native-files.ts"));
// Channel rows draw their star with an SF Symbol.
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("../src/loading.tsx", () => ({
  Placeholders: () => null,
  Shape: () => null,
  useDockInset: () => 0,
}));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    ...(await import("./react-native.ts")).reactNative,
    FlatList: () => null,
    Image: ({ source, onError }: { source: { uri: string }; onError: () => void }) => {
      drawn.set(source.uri, onError);
      return createElement("img", { "data-uri": source.uri });
    },
  };
});

const MIB = 1024 * 1024;
const cache = join(native.root, "cache");
const kept = join(cache, "artwork");
const sessionFolder = join(cache, "artwork-session");
const USER = "canary-user";
const PASS = "canary-pass-7f3";

// The picture server: each path answers its own bytes, unless `routes` says otherwise.
const hits = new Map<string, number>();
const routes = new Map<string, (response: ServerResponse) => void>();
let served = 0;
let server: Server;
let origin = "";
const asked = (path: string) => hits.get(path) ?? 0;
const totalAsked = () => [...hits.values()].reduce((sum, each) => sum + each, 0);
const at = (path: string, query = "") => `${origin}${path}${query}`;
/** Holds a path's answers until each is released; `ended` counts the answers sent whole. */
function hold(path: string) {
  const held: (() => void)[] & { ended: number } = Object.assign([], { ended: 0 });
  routes.set(path, (response) =>
    held.push(() => {
      response.on("finish", () => held.ended++);
      response.writeHead(200, { "Content-Type": "image/png" }).end("late");
    }),
  );
  return held;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://pictures.test").pathname;
    hits.set(path, asked(path) + 1);
    const route = routes.get(path);
    if (route) return route(response);
    const body = Buffer.from(`picture ${path} ${served++}`);
    response.writeHead(200, { "Content-Type": "image/png", "Content-Length": body.length });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("No address");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

type App = Awaited<ReturnType<typeof launch>>;
let app: App;

/** The app as a launch starts it: fresh modules, React with them, over the same files. */
async function launch() {
  vi.resetModules();
  const React = await import("react");
  const { createRoot } = (await import(REACT_DOM)) as {
    createRoot(container: object): { render(node: unknown): void; unmount(): void };
  };
  const { ChannelLogo } = await import("../src/ui.tsx");
  const { Artwork } = await import("../src/titles-ui.tsx");
  const sources = await import("../src/sources.ts");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const shown = () =>
    [...container.querySelectorAll("[data-picture]")].map(
      (each) =>
        each.querySelector("img")?.getAttribute("data-uri") ??
        each.querySelector("span")?.textContent ??
        "",
    );
  return {
    /** Shows a channel logo for each address, in order; anything shown before goes. */
    logos(urls: readonly (string | null)[]) {
      root.render(
        urls.map((url, index) =>
          React.createElement(
            "div",
            { key: `${index}:${url}`, "data-picture": "" },
            React.createElement(ChannelLogo, { channel: { title: "Channel Four", logoUrl: url } }),
          ),
        ),
      );
    },
    /** Shows a title's poster at TMDB's 342 width. */
    poster(url: string | null) {
      root.render(
        React.createElement(
          "div",
          { "data-picture": "" },
          React.createElement(Artwork, { url, name: "Night Train", width: 342 }),
        ),
      );
    },
    /** What each picture shows: its file's address, the fallback's text, or "" while it loads. */
    shown,
    /** Signs a subscription in, or replaces its login, as account.ts does. */
    signIn(id: string, revision: number, login: readonly [string, string]) {
      sources.setSource(id, { revision, provider: {} as Source["provider"], login });
    },
    signOut(id: string) {
      sources.dropSource(id);
    },
    close() {
      root.unmount();
      container.remove();
    },
  };
}

/** Ends this launch once its index is written, as a relaunch would find it. */
async function relaunch(): Promise<App> {
  await vi.advanceTimersByTimeAsync(5_500);
  await new Promise((resolve) => setImmediate(resolve));
  app.close();
  // The last launch's timers end with it; clearing them would also turn the clock back.
  const now = Date.now();
  vi.clearAllTimers();
  vi.setSystemTime(now);
  app = await launch();
  return app;
}

const settled = async (check: () => void) => vi.waitFor(check, { timeout: 5_000, interval: 5 });

/** Every file under Caches/artwork and Caches/artwork-session, with its path and text. */
function stored(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  for (const folder of [kept, sessionFolder]) {
    try {
      for (const name of readdirSync(folder)) {
        const path = join(folder, name);
        if (statSync(path).isFile()) files.push({ path, text: readFileSync(path, "utf8") });
      }
    } catch {
      // No folder.
    }
  }
  return files;
}
const pictureFiles = (folder: string) => {
  try {
    return readdirSync(folder).filter((name) => !name.startsWith("index.json"));
  } catch {
    return [];
  }
};
const isFile = (shown: string | undefined) => shown?.startsWith("file://") ?? false;
const exists = (uri: string | undefined) => {
  try {
    return statSync((uri ?? "").replace(/^file:\/\//, "")).isFile();
  } catch {
    return false;
  }
};

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
  hits.clear();
  routes.clear();
  drawn.clear();
  native.tasks.length = 0;
  native.sizeOf = null;
  native.undeletable = null;
  app = await launch();
});
afterEach(() => {
  app.close();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a picture shown again", () => {
  it("is fetched once, on the session that keeps no URL cache, and shows from its file after a relaunch", async () => {
    let current = app;
    current.logos([at("/logo/1.png"), at("/logo/1.png")]);
    await settled(() => expect(current.shown().filter(isFile)).toHaveLength(2));
    expect(asked("/logo/1.png")).toBe(1);
    expect(native.tasks).toEqual([{ url: at("/logo/1.png"), sessionType: "foreground" }]);

    current = await relaunch();
    current.logos([at("/logo/1.png")]);
    await settled(() => expect(isFile(current.shown()[0])).toBe(true));
    expect(asked("/logo/1.png")).toBe(1);
  });

  it("shows a download's own file as it is, asking for nothing", async () => {
    const file = join(native.root, "documents", "poster");
    writeFileSync(file, "kept");
    app.poster(`file://${file}`);
    await settled(() => expect(app.shown()).toEqual([`file://${file}`]));
    expect(totalAsked()).toBe(0);
  });

  it("keeps each TMDB width apart", async () => {
    const tmdb = (width: string) => `https://image.tmdb.org/t/p/${width}/poster.jpg`;
    // TMDB isn't asked: only the address the cache asks for matters here.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("poster"));
    app.poster(tmdb("original"));
    await settled(() => expect(native.tasks.map((each) => each.url)).toEqual([tmdb("w342")]));
  });

  it("refreshes a picture fetched over 30 days ago while its old file shows", async () => {
    let current = app;
    current.logos([at("/logo/fresh.png")]);
    await settled(() => expect(isFile(current.shown()[0])).toBe(true));
    const old = current.shown()[0];
    current = await relaunch();
    vi.setSystemTime(Date.now() + 31 * 86_400_000);
    const held = hold("/logo/fresh.png");
    current.logos([at("/logo/fresh.png")]);
    await settled(() => expect(current.shown()).toEqual([old]));
    await settled(() => expect(held).toHaveLength(1));
    held[0]?.();
    await settled(() => expect(current.shown()[0]).not.toBe(old));
    expect(isFile(current.shown()[0])).toBe(true);
    expect(exists(old)).toBe(false);
  });

  it("forgets a picture unseen for 60 days", async () => {
    let current = app;
    current.logos([at("/logo/old.png")]);
    await settled(() => expect(isFile(current.shown()[0])).toBe(true));
    current = await relaunch();
    vi.setSystemTime(Date.now() + 61 * 86_400_000);
    current = await relaunch();
    current.logos([at("/logo/old.png")]);
    await settled(() => expect(isFile(current.shown()[0])).toBe(true));
    expect(asked("/logo/old.png")).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await settled(() => expect(pictureFiles(kept)).toHaveLength(1));
  });
});

describe("what isn't a whole picture", () => {
  it("shows the fallback for an error answer, keeps nothing, and asks again after a relaunch", async () => {
    let current = app;
    routes.set("/logo/gone.png", (response) => response.writeHead(404).end("missing"));
    current.logos([at("/logo/gone.png")]);
    await settled(() => expect(current.shown()).toEqual(["CF"]));
    expect(pictureFiles(kept)).toEqual([]);

    current = await relaunch();
    routes.clear();
    current.logos([at("/logo/gone.png")]);
    await settled(() => expect(isFile(current.shown()[0])).toBe(true));
    expect(asked("/logo/gone.png")).toBe(2);
  });

  it("gives a title's name for a poster that fails, and its tint alone while it loads", async () => {
    const held = hold("/poster/1.jpg");
    app.poster(at("/poster/1.jpg"));
    await settled(() => expect(held).toHaveLength(1));
    expect(app.shown()).toEqual([""]);
    routes.set("/poster/2.jpg", (response) => response.writeHead(500).end());
    app.poster(at("/poster/2.jpg"));
    await settled(() => expect(app.shown()).toEqual(["Night Train"]));
  });

  it("drops a fetched file that won't draw, then fetches it again after a relaunch", async () => {
    let current = app;
    current.logos([at("/logo/bad.png")]);
    await settled(() => expect(isFile(current.shown()[0])).toBe(true));
    const file = current.shown()[0] ?? "";
    drawn.get(file)?.();
    await settled(() => expect(current.shown()).toEqual(["CF"]));
    expect(exists(file)).toBe(false);

    current = await relaunch();
    current.logos([at("/logo/bad.png")]);
    await settled(() => expect(isFile(current.shown()[0])).toBe(true));
    expect(asked("/logo/bad.png")).toBe(2);
  });

  it("fetches again a kept file that won't draw, or that is gone", async () => {
    let current = app;
    current.logos([at("/logo/a.png"), at("/logo/b.png")]);
    await settled(() => expect(current.shown().filter(isFile)).toHaveLength(2));
    current = await relaunch();
    current.logos([at("/logo/a.png")]);
    await settled(() => expect(isFile(current.shown()[0])).toBe(true));
    drawn.get(current.shown()[0] ?? "")?.();
    await settled(() => expect(asked("/logo/a.png")).toBe(2));
    await settled(() => expect(isFile(current.shown()[0])).toBe(true));

    for (const name of pictureFiles(kept)) rmSync(join(kept, name));
    current = await relaunch();
    current.logos([at("/logo/b.png")]);
    await settled(() => expect(isFile(current.shown()[0])).toBe(true));
    expect(asked("/logo/b.png")).toBe(2);
  });

  it("reads a broken index as none, and deletes files no index names", async () => {
    let current = app;
    current.logos([at("/logo/1.png")]);
    await settled(() => expect(isFile(current.shown()[0])).toBe(true));
    await vi.advanceTimersByTimeAsync(5_500);
    writeFileSync(join(kept, "index.json"), "{ not json");
    writeFileSync(join(kept, "stray"), "left by a launch that stopped");
    current = await relaunch();
    current.logos([at("/logo/1.png")]);
    await settled(() => expect(isFile(current.shown()[0])).toBe(true));
    expect(asked("/logo/1.png")).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await settled(() => expect(pictureFiles(kept)).toEqual([current.shown()[0]?.split("/").pop()]));
  });

  it("refuses addresses it can't keep: malformed, too long, or with a login of their own", async () => {
    app.logos([
      "not an address",
      "ftp://127.0.0.1/logo.png",
      at("/logo/1.png", `?pad=${"x".repeat(2100)}`),
      at("/logo/1.png").replace("http://", "http://someone:secret@"),
      "",
    ]);
    await settled(() => expect(app.shown()).toEqual(["CF", "CF", "CF", "CF", "CF"]));
    expect(totalAsked()).toBe(0);
  });

  it("stops a picture past 5 MiB, whether announced or not, and keeps nothing of it", async () => {
    routes.set("/logo/announced.png", (response) =>
      response.writeHead(200, { "Content-Length": 6 * MIB }).end(Buffer.alloc(6 * MIB)),
    );
    routes.set("/logo/unannounced.png", (response) => {
      response.writeHead(200, { "Content-Type": "image/png" });
      for (let sent = 0; sent < 6; sent++) response.write(Buffer.alloc(MIB));
      response.end();
    });
    app.logos([at("/logo/announced.png"), at("/logo/unannounced.png")]);
    await settled(() => expect(app.shown()).toEqual(["CF", "CF"]));
    expect(pictureFiles(kept)).toEqual([]);
  });

  it("gives up on a fetch after 15 seconds, and takes the next waiting one", async () => {
    for (const n of [1, 2, 3, 4]) hold(`/logo/slow${n}.png`);
    const slow = [1, 2, 3, 4].map((n) => at(`/logo/slow${n}.png`));
    app.logos([...slow, at("/logo/next.png")]);
    await settled(() => expect(totalAsked()).toBe(4));
    expect(asked("/logo/next.png")).toBe(0);
    await vi.advanceTimersByTimeAsync(15_000);
    await settled(() => expect(app.shown().slice(0, 4)).toEqual(["CF", "CF", "CF", "CF"]));
    await settled(() => expect(isFile(app.shown()[4])).toBe(true));
    expect(pictureFiles(kept)).toHaveLength(1);
  });
});

describe("pictures no one shows any more", () => {
  it("doesn't fetch one that went before its turn, and keeps one whose fetch had started", async () => {
    const held = [1, 2, 3, 4].map((n) => hold(`/logo/busy${n}.png`));
    const busy = [1, 2, 3, 4].map((n) => at(`/logo/busy${n}.png`));
    app.logos([...busy, at("/logo/waiting.png")]);
    await settled(() => expect(totalAsked()).toBe(4));
    // Removing the DOM precedes passive subscription cleanup; finish both before freeing a slot.
    const { act } = await import("react");
    const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => app.logos([]));
    environment.IS_REACT_ACT_ENVIRONMENT = false;
    await settled(() => expect(app.shown()).toEqual([]));
    for (const each of held) each[0]?.();
    await settled(() => expect(pictureFiles(kept)).toHaveLength(4));
    app.logos(busy);
    await settled(() => expect(app.shown().filter(isFile)).toHaveLength(4));
    expect(asked("/logo/waiting.png")).toBe(0);
    expect(totalAsked()).toBe(4);
  });

  it("evicts the least recently shown past 160 MiB, never the ones showing", async () => {
    // Every picture reports 5 MB, so 33 of them pass the budget.
    native.sizeOf = (path) =>
      path.startsWith(kept) && !path.includes("index") ? 5_000_000 : undefined;
    const urls = Array.from({ length: 34 }, (_, n) => at(`/logo/many${n}.png`));
    /** Shows one logo in place of the last, once it shows its own file. */
    const showOne = async (url: string | undefined) => {
      const before = app.shown()[0];
      app.logos([url ?? null]);
      await settled(() => expect(isFile(app.shown()[0]) && app.shown()[0] !== before).toBe(true));
    };
    for (const url of urls.slice(0, 33)) {
      await showOne(url);
      // The first again, after the second: the second is now the least recently shown.
      if (url === urls[1]) await showOne(urls[0]);
    }
    await showOne(urls[33]);
    app.logos([urls[0] ?? null, urls[1] ?? null]);
    await settled(() => expect(app.shown().filter(isFile)).toHaveLength(2));
    expect(asked("/logo/many0.png")).toBe(1);
    expect(asked("/logo/many1.png")).toBe(2);
  });
});

describe("pictures whose address carries a login", () => {
  const withLogin = (path: string) =>
    at(path, `?username=${USER}&password=${encodeURIComponent(PASS)}`);

  it("show, but nothing kept on disk names them or survives a relaunch", async () => {
    let current = app;
    current.signIn("a", 1, [USER, PASS]);
    current.logos([withLogin("/logo/private.png"), at("/logo/public.png")]);
    await settled(() => expect(current.shown().filter(isFile)).toHaveLength(2));
    expect(current.shown()[0]?.startsWith(`file://${sessionFolder}/`)).toBe(true);
    expect(native.tasks.every((each) => each.sessionType === "foreground")).toBe(true);

    current = await relaunch();
    current.signIn("a", 1, [USER, PASS]);
    current.logos([at("/logo/public.png")]);
    await settled(() => expect(isFile(current.shown()[0])).toBe(true));
    expect(asked("/logo/public.png")).toBe(1);
    expect(pictureFiles(sessionFolder)).toEqual([]);
    const index = readFileSync(join(kept, "index.json"), "utf8");
    expect(index).toContain("/logo/public.png");
    expect(index).not.toContain("/logo/private.png");

    current.logos([at("/logo/public.png"), withLogin("/logo/private.png")]);
    await settled(() => expect(current.shown().filter(isFile)).toHaveLength(2));
    expect(asked("/logo/private.png")).toBe(2);
    await vi.advanceTimersByTimeAsync(5_500);
    for (const { path, text } of stored()) {
      for (const canary of [USER, PASS]) {
        expect(path).not.toContain(canary);
        expect(text).not.toContain(canary);
      }
    }
  });

  it("go as soon as their login is replaced, and aren't asked for again", async () => {
    app.signIn("a", 1, [USER, PASS]);
    app.logos([withLogin("/logo/private.png")]);
    await settled(() => expect(isFile(app.shown()[0])).toBe(true));
    const file = app.shown()[0];
    app.signIn("a", 2, [USER, "new-password"]);
    await settled(() => expect(app.shown()).toEqual(["CF"]));
    expect(exists(file)).toBe(false);
    app.logos([null]);
    app.logos([withLogin("/logo/private.png")]);
    await settled(() => expect(app.shown()).toEqual(["CF"]));
    expect(asked("/logo/private.png")).toBe(1);
  });

  it("aren't kept when their fetch ends after the login was replaced", async () => {
    const held = hold("/logo/private.png");
    app.signIn("a", 1, [USER, PASS]);
    app.logos([withLogin("/logo/private.png")]);
    await settled(() => expect(held).toHaveLength(1));
    app.signIn("a", 2, ["another-user", "another-password"]);
    held[0]?.();
    await settled(() => expect(app.shown()).toEqual(["CF"]));
    await vi.advanceTimersByTimeAsync(5_500);
    expect(pictureFiles(sessionFolder)).toEqual([]);
    expect(stored().every(({ text }) => !text.includes("private"))).toBe(true);
  });

  it("throw away a fetch of a replaced login that ends once nothing shows it", async () => {
    const held = hold("/logo/private.png");
    app.signIn("a", 1, [USER, PASS]);
    app.logos([withLogin("/logo/private.png")]);
    await settled(() => expect(held).toHaveLength(1));
    app.logos([]);
    await settled(() => expect(app.shown()).toEqual([]));
    app.signIn("a", 2, ["another-user", "another-password"]);
    held[0]?.();
    await settled(() => expect(held.ended).toBe(1));
    await vi.advanceTimersByTimeAsync(5_500);
    expect(pictureFiles(sessionFolder)).toEqual([]);
    expect(pictureFiles(kept)).toEqual([]);
  });

  it("keep a password-only address of a replaced login out of the index, though first shown after", async () => {
    let current = app;
    current.signIn("a", 1, [USER, PASS]);
    current.signIn("a", 2, [USER, "new-password"]);
    // Lists of the first login may still show: neither address is known to be free of it.
    const old = at("/logo/token.png", `?token=${encodeURIComponent(PASS)}`);
    current.logos([old, at("/logo/after.png")]);
    await settled(() => expect(current.shown().filter(isFile)).toHaveLength(2));
    for (const uri of current.shown())
      expect(uri.startsWith(`file://${sessionFolder}/`)).toBe(true);
    await vi.advanceTimersByTimeAsync(5_500);
    for (const { path, text } of stored()) {
      expect(path).not.toContain(PASS);
      expect(text).not.toContain(PASS);
    }

    // After a relaunch, only lists of the logins signed in can show: kept again.
    current = await relaunch();
    current.signIn("a", 1, [USER, "new-password"]);
    current.logos([at("/logo/after.png")]);
    await settled(() => expect(isFile(current.shown()[0])).toBe(true));
    expect(current.shown()[0]?.startsWith(`file://${kept}/`)).toBe(true);
    expect(pictureFiles(sessionFolder)).toEqual([]);
  });

  it("drop a kept address that gives away a login signed in later, shown or only in the index", async () => {
    let current = app;
    const named = at("/logo/named.png", "?user=later-user");
    const listed = at("/logo/listed.png", "?user=later-user");
    current.logos([named, listed]);
    await settled(() => expect(current.shown().filter(isFile)).toHaveLength(2));
    current = await relaunch();
    current.logos([named]);
    await settled(() => expect(isFile(current.shown()[0])).toBe(true));
    const keptFile = current.shown()[0];
    expect(asked("/logo/named.png")).toBe(1);

    current.signIn("b", 1, ["later-user", "later-pass"]);
    await settled(() =>
      expect(current.shown()[0]?.startsWith(`file://${sessionFolder}/`)).toBe(true),
    );
    expect(exists(keptFile)).toBe(false);
    expect(asked("/logo/named.png")).toBe(2);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(readFileSync(join(kept, "index.json"), "utf8")).not.toContain("later-user");
    expect(pictureFiles(kept)).toEqual([]);
  });

  it("never put an index in place that a login signed in while it was written gives away", async () => {
    app.signIn("a", 1, ["different-user", "different-pass"]);
    app.logos([at("/logo/snapshot.png", `?token=${PASS}`)]);
    await settled(() => expect(app.shown().filter(isFile)).toHaveLength(1));
    app.logos([]);
    let go: (() => void) | undefined;
    native.gate = (operation, path) =>
      operation === "write" && path.endsWith("index.json.next")
        ? new Promise<void>((resolve) => {
            go = resolve;
          })
        : undefined;
    await vi.advanceTimersByTimeAsync(5_500);
    await settled(() => expect(go).toBeDefined());
    app.signIn("b", 1, [USER, PASS]);
    native.gate = null;
    go?.();
    // Right after the write that was under way ends, before any later write could repair it.
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
    for (const { text } of stored()) expect(text).not.toContain(PASS);
    await settled(() =>
      expect(readFileSync(join(kept, "index.json"), "utf8")).toContain('"entries":[]'),
    );
    for (const { path, text } of stored()) {
      expect(path).not.toContain(PASS);
      expect(text).not.toContain(PASS);
    }
  });

  it("go when their subscription is removed, leaving pictures without a login", async () => {
    app.signIn("a", 1, [USER, PASS]);
    app.logos([withLogin("/logo/private.png"), at("/logo/public.png")]);
    await settled(() => expect(app.shown().filter(isFile)).toHaveLength(2));
    const [privateFile, publicFile] = app.shown();
    app.signOut("a");
    await settled(() => expect(app.shown()).toEqual(["CF", publicFile]));
    expect(exists(privateFile)).toBe(false);
    expect(exists(publicFile)).toBe(true);
  });
});

describe("the disk budget", () => {
  /** Every picture the cache keeps reports 5 MiB: 32 fill it. */
  const fiveMib = (path: string) =>
    path.startsWith(kept) && !basename(path).startsWith("index") ? 5 * MIB : undefined;
  const indexed = () =>
    (
      JSON.parse(readFileSync(join(kept, "index.json"), "utf8")) as {
        entries: [string, string, number][];
      }
    ).entries;

  it("never holds more than 160 MiB, even while every picture shows, and makes room once they go", async () => {
    native.sizeOf = fiveMib;
    app.logos(Array.from({ length: 36 }, (_, n) => at(`/logo/big${n}.png`)));
    await settled(() => {
      expect(app.shown().filter(isFile)).toHaveLength(32);
      expect(app.shown().filter((each) => each === "CF")).toHaveLength(4);
    });
    expect(pictureFiles(kept)).toHaveLength(32);

    app.logos([]);
    await settled(() => expect(app.shown()).toEqual([]));
    app.logos(Array.from({ length: 4 }, (_, n) => at(`/logo/next${n}.png`)));
    await settled(() => expect(app.shown().filter(isFile)).toHaveLength(4));
    expect(pictureFiles(kept)).toHaveLength(32);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(indexed()).toHaveLength(32);
    expect(indexed().reduce((sum, [, , bytes]) => sum + bytes, 0)).toBe(160 * MIB);
  });

  it("starts no fetch it has no room for while the disk refuses deletions, so the disk stops growing", async () => {
    native.sizeOf = fiveMib;
    app.logos(Array.from({ length: 32 }, (_, n) => at(`/logo/base${n}.png`)));
    await settled(() => expect(app.shown().filter(isFile)).toHaveLength(32));
    app.logos([]);
    await settled(() => expect(app.shown()).toEqual([]));
    native.undeletable = (path) => !basename(path).startsWith("index");

    app.logos(Array.from({ length: 12 }, (_, n) => at(`/logo/pressure${n}.png`)));
    await settled(() => expect(app.shown()).toEqual(Array<string>(12).fill("CF")));
    expect(totalAsked()).toBe(32);
    expect(pictureFiles(kept)).toHaveLength(32);

    // Deletions work again: a picture shown again is fetched, in the room one made.
    native.undeletable = null;
    app.logos([]);
    await settled(() => expect(app.shown()).toEqual([]));
    app.logos([at("/logo/pressure0.png")]);
    await settled(() => expect(isFile(app.shown()[0])).toBe(true));
    expect(pictureFiles(kept)).toHaveLength(32);
  });

  it("counts a file the disk won't delete until it goes", async () => {
    native.sizeOf = fiveMib;
    app.logos(Array.from({ length: 32 }, (_, n) => at(`/logo/full${n}.png`)));
    await settled(() => expect(app.shown().filter(isFile)).toHaveLength(32));
    app.logos([]);
    await settled(() => expect(app.shown()).toEqual([]));
    const full = new Set(pictureFiles(kept));
    native.undeletable = (path) => full.has(basename(path));

    app.logos([at("/logo/one-more.png")]);
    await settled(() => expect(app.shown()).toEqual(["CF"]));
    expect(pictureFiles(kept)).toHaveLength(32);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(indexed()).toHaveLength(31);

    native.undeletable = null;
    app.logos([at("/logo/another.png")]);
    await settled(() => expect(isFile(app.shown()[0])).toBe(true));
    expect(pictureFiles(kept)).toHaveLength(32);
  });
});
