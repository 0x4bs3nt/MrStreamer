import { beforeEach, describe, expect, it, vi } from "vitest";

// What a launch asks of the provider, in order: the saved login is checked again before the movie
// and series lists start, channels load at once, and the lists start once the check answers,
// fails or runs out of time, unless the viewer disconnected or connected another subscription
// meanwhile. The app's own account, titles and core Xtream adapter run; `fetch` is the boundary,
// recording each request and holding the login checks until a test answers them.

const SERVER = "http://panel.test";

interface Asked {
  readonly action: string;
  readonly username: string;
}
const asked: Asked[] = [];
/** Login checks waiting for an answer, oldest first. */
const checks: Array<{ username: string; answer: (ok: boolean) => void }> = [];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

vi.stubGlobal(
  "fetch",
  (input: string) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input);
      const username = url.searchParams.get("username") ?? "";
      const action = url.searchParams.get("action") ?? "login";
      asked.push({ action, username });
      if (action !== "login") return resolve(json([]));
      checks.push({
        username,
        answer: (ok) =>
          ok
            ? resolve(json({ user_info: { auth: 1, status: "Active" }, server_info: {} }))
            : reject(new TypeError("Network request failed")),
      });
    }),
);

const saved = { id: "xtream-saved", server: SERVER, username: "saved user" };

vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("expo-video", () => ({
  createVideoPlayer: () => ({
    addListener: () => undefined,
    replaceAsync: async () => undefined,
    play: () => undefined,
    pause: () => undefined,
  }),
}));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "/cache", document: "/documents" },
  File: class {
    exists = false;
    create() {}
    async text() {
      return "";
    }
    async write() {}
  },
}));
vi.mock("../src/secrets.ts", () => ({
  keychainSecrets: {
    read: async () => "saved pass",
    write: async () => undefined,
    remove: async () => undefined,
    clear: async () => undefined,
  },
}));
vi.mock("../src/storage.ts", () => ({
  firstLaunch: () => false,
  readState: () => ({ subscription: saved, recent: [], region: null }),
  writeState: () => undefined,
  rememberChannel: () => undefined,
}));
vi.mock("../src/viewing.ts", () => ({
  connectViewing: () => undefined,
  disconnectViewing: async () => undefined,
}));
vi.mock("../src/watchlist.ts", () => ({
  alignWatchlist: () => undefined,
  connectWatchlist: () => undefined,
  disconnectWatchlist: () => undefined,
}));

const { connect, disconnect, restore } = await import("../src/account.ts");

const settle = () => new Promise((done) => setTimeout(done, 0));
const TITLE_LISTS = [
  "get_vod_categories",
  "get_series_categories",
  "get_vod_streams",
  "get_series",
];
/** Who asked for the movie and series lists, in order, once per list. */
const titleLists = () =>
  asked.flatMap(({ action, username }) => (TITLE_LISTS.includes(action) ? [username] : []));

beforeEach(async () => {
  await disconnect();
  asked.length = 0;
  checks.length = 0;
});

describe("restoring the saved subscription at launch", () => {
  it("checks the login and loads channels first, and the movie and series lists once it answers", async () => {
    void restore();
    await settle();
    expect(asked.map(({ action }) => action).toSorted()).toEqual(
      ["get_live_categories", "get_live_streams", "login"].toSorted(),
    );
    checks.shift()?.answer(true);
    await settle();
    expect(titleLists()).toEqual(Array(4).fill("saved user"));
  });

  it("starts the lists after a failed check too", async () => {
    void restore();
    await settle();
    checks.shift()?.answer(false);
    await settle();
    expect(titleLists()).toEqual(Array(4).fill("saved user"));
  });

  it("starts no lists for a subscription disconnected while its check was waiting", async () => {
    void restore();
    await settle();
    await disconnect();
    checks.shift()?.answer(true);
    await settle();
    expect(titleLists()).toEqual([]);
  });

  it("leaves a newer Connect's lists alone when the old check answers late", async () => {
    void restore();
    await settle();
    await disconnect();
    const connected = connect({ server: SERVER, username: "new user", password: "new pass" });
    await settle();
    checks.find(({ username }) => username === "new user")?.answer(true);
    await connected;
    await settle();
    expect(titleLists()).toEqual(Array(4).fill("new user"));
    checks.find(({ username }) => username === "saved user")?.answer(true);
    await settle();
    expect(titleLists()).toEqual(Array(4).fill("new user"));
  });
});

describe("connecting", () => {
  it("starts the lists with the channels, its login just checked once", async () => {
    const connected = connect({ server: SERVER, username: "new user", password: "new pass" });
    await settle();
    checks.shift()?.answer(true);
    await connected;
    await settle();
    expect(asked.filter(({ action }) => action === "login")).toHaveLength(1);
    expect(titleLists()).toEqual(Array(4).fill("new user"));
  });
});
