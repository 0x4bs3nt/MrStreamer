import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import { Failed } from "@mrstreamer/core/failure";
import type { Secrets } from "../src/main/platform/secrets.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import {
  fakeProvider,
  holdableFetch,
  promised,
  runtimeFor,
  tempDir,
  testSecrets,
  userAgent,
} from "./support.ts";

/** The subscription service on a data folder; `create` starts another, as after a restart. */
async function subscriptions(fetchImpl: typeof fetch = fetch) {
  const dataDir = await tempDir();
  const create = (secrets: Secrets = testSecrets) =>
    promised(
      runtimeFor(
        Subscriptions.layer({ dataDir, secrets, providerOptions: { userAgent, fetch: fetchImpl } }),
      ),
      Subscriptions,
    );
  return { dataDir, create, service: await create() };
}

/** A JSON file of the data folder, or null when it isn't there. */
async function saved(dataDir: string, name: string): Promise<unknown> {
  const text = await readFile(join(dataDir, name), "utf8").catch(() => null);
  return text === null ? null : JSON.parse(text);
}

/**
 * What the stable release leaves when it connects `login` in `dataDir`: its subscription.json,
 * which this build writes the same way, and nothing else changed. It knows no registry.
 */
async function stableConnects(dataDir: string, login: Parameters<typeof connectAs>[1]) {
  const elsewhere = await subscriptions();
  await connectAs(elsewhere.service, login);
  await copyFile(join(elsewhere.dataDir, "subscription.json"), join(dataDir, "subscription.json"));
}

type Service = Awaited<ReturnType<typeof subscriptions>>["service"];

function connectAs(
  service: Service,
  login: { readonly server: string; readonly username: string; readonly password: string },
) {
  return service.add(login);
}

/** The one saved subscription, or null with none. */
async function only(service: Service) {
  const saved = await service.list();
  expect(saved.length).toBeLessThan(2);
  return saved[0] ?? null;
}

/** The source of the one saved subscription, or null while it has none. */
async function onlySource(service: Service) {
  const [source = null] = await service.sources();
  return source;
}

const demo = (provider: { readonly url: string }, username = "demo") => ({
  server: provider.url,
  username,
  password: "demo",
});

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  if (!(error instanceof Failed)) throw new Error(`Expected a failure, got ${String(error)}`);
  return error.error;
}

describe("subscriptions", () => {
  it("connects with a valid login and reports the account", async () => {
    const provider = await fakeProvider();
    const { service } = await subscriptions();

    const summary = await service.add({
      server: provider.url,
      username: "demo",
      password: "demo",
    });

    expect(summary).toMatchObject({ kind: "xtream", server: provider.url, username: "demo" });
    expect(summary.account.state).toBe("active");
    expect(summary.account.maxConnections).toBe(1);
    expect(Date.parse(summary.account.expiresAt ?? "")).toBeGreaterThan(Date.now());
  });

  it("accepts a pasted M3U link that carries the login", async () => {
    const provider = await fakeProvider();
    const { service } = await subscriptions();

    const summary = await service.add({
      server: `${provider.url}/get.php?username=demo&password=demo&type=m3u_plus&output=ts`,
      username: "",
      password: "",
    });

    expect(summary).toMatchObject({ server: provider.url, username: "demo" });
  });

  it("rejects a wrong password", async () => {
    const provider = await fakeProvider();
    const { service } = await subscriptions();

    const error = await failure(
      service.add({ server: provider.url, username: "demo", password: "wrong" }),
    );

    expect(error).toEqual({ kind: "invalid-login" });
    expect(await service.list()).toEqual([]);
  });

  it("explains an expired account", async () => {
    const provider = await fakeProvider({ accountStatus: "Expired" });
    const { service } = await subscriptions();

    const error = await failure(
      service.add({ server: provider.url, username: "demo", password: "demo" }),
    );

    expect(error).toMatchObject({ kind: "account-inactive", state: "expired" });
  });

  it("reports a server that cannot be reached", async () => {
    const provider = await fakeProvider();
    await provider.close();
    const { service } = await subscriptions();

    const error = await failure(
      service.add({ server: provider.url, username: "demo", password: "demo" }),
    );

    expect(error).toMatchObject({ kind: "unreachable", server: provider.url });
  });

  it("asks for the missing parts of a login", async () => {
    const { service } = await subscriptions();

    const error = await failure(
      service.add({ server: "line.example.tv:8080", username: "demo", password: "" }),
    );

    expect(error.kind).toBe("incomplete-login");
  });

  it("survives a restart without storing the password in plain text", async () => {
    const provider = await fakeProvider({ password: "s3cret-pass" });
    const { dataDir, create, service } = await subscriptions();
    await service.add({
      server: `${provider.url}/`,
      username: "demo",
      password: "s3cret-pass",
    });

    const restarted = await create();
    const saved = await only(restarted);

    expect(saved).toMatchObject({ server: provider.url, username: "demo" });
    expect(await restarted.recheck(saved?.id ?? "")).toMatchObject({
      account: { state: "active" },
    });
    expect(await readFile(join(dataDir, "subscription.json"), "utf8")).not.toContain("s3cret-pass");
  });

  it("keeps a removal when an account check answers afterwards", async () => {
    const provider = await fakeProvider();
    const holdable = holdableFetch();
    const { create, service } = await subscriptions(holdable.fetch);
    const { id } = await service.add({ server: provider.url, username: "demo", password: "demo" });

    const held = holdable.holdNext();
    const check = service.recheck(id);
    await held.arrived;
    await service.remove(id);
    held.release();

    expect(await failure(check)).toEqual({ kind: "no-subscription" });
    expect(await service.list()).toEqual([]);
    expect(await (await create()).list()).toEqual([]);
  });

  it("keeps a password entered again when an account check answers afterwards", async () => {
    const provider = await fakeProvider();
    const holdable = holdableFetch();
    const { create, service } = await subscriptions(holdable.fetch);
    const login = { server: provider.url, username: "demo", password: "demo" };
    const { id } = await service.add(login);
    const before = await onlySource(service);

    const held = holdable.holdNext();
    const check = service.recheck(id);
    await held.arrived;
    await service.update(id, { secret: "demo" });
    held.release();

    // What was asked under the login before changes nothing of the one saved since.
    const stored = await onlySource(service);
    expect(await check).toMatchObject({ id });
    const now = await onlySource(service);
    expect(now?.revision).toBeGreaterThan(before?.revision ?? Infinity);
    expect(now?.revision).toBe(stored?.revision);
    expect((await onlySource(await create()))?.id).toBe(id);
  });

  it("keeps the later of two passwords entered again, whichever the provider answers first", async () => {
    const provider = await fakeProvider();
    const holdable = holdableFetch();
    const { create, service } = await subscriptions(holdable.fetch);
    const { id } = await service.add(demo(provider));

    const held = holdable.holdNext();
    const earlier = service.update(id, { secret: "demo", name: "Earlier" });
    await held.arrived;
    const latest = await service.update(id, { secret: "demo", name: "Latest" });
    const stored = await onlySource(service);
    held.release();

    // The earlier one answers with what is saved, and changes none of it.
    expect(await earlier).toEqual(latest);
    expect(await only(service)).toMatchObject({ id, name: "Latest" });
    expect((await onlySource(service))?.revision).toBe(stored?.revision);
    expect(await only(await create())).toMatchObject({ id, name: "Latest" });
  });

  it("keeps a name given while a password entered again is checked", async () => {
    const provider = await fakeProvider();
    const holdable = holdableFetch();
    const { create, service } = await subscriptions(holdable.fetch);
    const { id } = await service.add(demo(provider));
    const before = await onlySource(service);

    const held = holdable.holdNext();
    const repair = service.update(id, { secret: "demo", name: "Earlier" });
    await held.arrived;
    await service.update(id, { name: "Latest" });
    held.release();

    // The password is saved as it was checked, under the name the viewer gave last.
    expect(await repair).toMatchObject({ id, name: "Latest", needsSecret: false });
    expect((await onlySource(service))?.revision).toBeGreaterThan(before?.revision ?? Infinity);
    expect(await only(await create())).toMatchObject({ id, name: "Latest" });
  });

  it("asks for the password again when the keychain no longer opens it", async () => {
    const provider = await fakeProvider();
    const { create, service } = await subscriptions();
    const login = { server: provider.url, username: "demo", password: "demo" };
    await service.add(login);

    // What a new app signature or a reset keychain looks like to the app.
    const locked = await create({
      seal: testSecrets.seal,
      open: () => {
        throw new AppFailure({ kind: "keychain-refused" });
      },
    });

    const saved = await only(locked);
    expect(saved).toMatchObject({ username: "demo", needsSecret: true });
    // It stays saved, as services know it, with nothing to ask its provider with.
    expect(await locked.saved()).toMatchObject([{ id: saved?.id, original: true }]);
    expect(await locked.sources()).toEqual([]);
    expect(await failure(locked.sourceOf(saved?.id ?? ""))).toEqual({
      kind: "needs-secret",
      subscriptionId: saved?.id,
    });
    expect(await locked.recheck(saved?.id ?? "")).toMatchObject({ needsSecret: true });
    // The password entered again, on its row or as the same login: the same subscription.
    expect(await locked.update(saved?.id ?? "", { secret: "demo" })).toMatchObject({
      id: saved?.id,
      needsSecret: false,
    });
    expect(await locked.add(login)).toMatchObject({ id: saved?.id, needsSecret: false });
  });

  it("forgets the subscription when removed, with its sealed password and its id", async () => {
    const provider = await fakeProvider({ password: "s3cret-pass" });
    const { dataDir, create, service } = await subscriptions();
    const login = { server: provider.url, username: "demo", password: "s3cret-pass" };
    const { id } = await service.add(login);
    const sealed = testSecrets.seal("s3cret-pass");

    await service.remove(id);

    expect(await service.list()).toEqual([]);
    expect(await (await create()).list()).toEqual([]);
    // Nothing of the login is left in the folder, in any file.
    const left = await Promise.all(
      (await readdir(dataDir)).map((name) => readFile(join(dataDir, name), "utf8")),
    );
    for (const text of left) {
      expect(text).not.toContain(sealed);
      expect(text).not.toContain("s3cret-pass");
      expect(text).not.toContain(id);
    }
    await expect(service.sourceOf(id)).rejects.toMatchObject({
      error: { kind: "no-subscription" },
    });
  });
});

describe("a subscription's id", () => {
  it("names the subscription across restarts, and holds nothing of the login", async () => {
    const provider = await fakeProvider({ password: "s3cret-pass" });
    const { dataDir, create, service } = await subscriptions();
    const login = { server: provider.url, username: "demo", password: "s3cret-pass" };

    const { id } = await service.add(login);

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect((await only(await create()))?.id).toBe(id);
    // The registry holds the id and the account it names: no password, sealed or not.
    const registry = await readFile(join(dataDir, "subscriptions.json"), "utf8");
    expect(JSON.parse(registry)).toEqual({
      version: 1,
      subscriptions: [{ id, original: true, key: `${provider.url}|demo` }],
    });
    expect(registry).not.toContain("s3cret-pass");
    expect(registry).not.toContain(testSecrets.seal("s3cret-pass"));
  });

  it("stays when the same login is entered again, and another account gets its own", async () => {
    const [first, second] = [await fakeProvider(), await fakeProvider()];
    const { create, service } = await subscriptions();
    const login = { server: first.url, username: "demo", password: "demo" };
    const { id } = await service.add(login);
    const before = await onlySource(service);

    // The password entered again, as after the keychain lost it.
    expect((await service.add(login)).id).toBe(id);
    const again = await onlySource(service);
    // Neither the provider's own answer about the account nor a name changes the login.
    await service.recheck(id);
    await service.update(id, { name: "Northline" });

    expect(again?.id).toBe(id);
    expect(again?.revision).toBeGreaterThan(before?.revision ?? Infinity);
    expect((await onlySource(service))?.revision).toBe(again?.revision);

    const other = await service.add({ ...login, server: second.url });

    expect(other.id).not.toBe(id);
    expect((await (await create()).list()).map((each) => each.id)).toEqual([id, other.id]);
  });
});

describe("a profile other releases share", () => {
  it("keeps subscription.json as the stable release reads and writes it", async () => {
    const provider = await fakeProvider();
    const { dataDir, service } = await subscriptions();

    await service.add(demo(provider));

    expect(await saved(dataDir, "subscription.json")).toEqual({
      version: 1,
      kind: "xtream",
      server: provider.url,
      username: "demo",
      sealedPassword: testSecrets.seal("demo"),
      account: expect.objectContaining({ state: "active" }),
    });
  });

  it("takes up a profile from before the registry without changing its login", async () => {
    const provider = await fakeProvider();
    const { dataDir, create } = await subscriptions();
    await stableConnects(dataDir, demo(provider));
    const before = await readFile(join(dataDir, "subscription.json"), "utf8");

    const upgraded = await create();
    const summary = await only(upgraded);

    expect(summary).toMatchObject({ server: provider.url, username: "demo", needsSecret: false });
    expect(await readFile(join(dataDir, "subscription.json"), "utf8")).toBe(before);
    // The login it holds is the one the provider is asked with.
    expect(await upgraded.recheck(summary?.id ?? "")).toMatchObject({
      account: { state: "active" },
    });
    // The id it got then is the one it keeps.
    expect((await only(await create()))?.id).toBe(summary?.id);
  });

  it("settles a write cut short between the login and the registry", async () => {
    const [first, second] = [await fakeProvider(), await fakeProvider()];
    const { dataDir, create, service } = await subscriptions();
    const { id } = await service.add(demo(first));

    // Another account's login reached the disk, and the registry didn't follow.
    await stableConnects(dataDir, demo(second));
    const replaced = await only(await create());

    expect(replaced).toMatchObject({ server: second.url });
    expect(replaced?.id).not.toBe(id);
    expect((await only(await create()))?.id).toBe(replaced?.id);

    // A removal took the login, and the registry didn't follow.
    await rm(join(dataDir, "subscription.json"));

    expect(await (await create()).list()).toEqual([]);
    expect(await saved(dataDir, "subscriptions.json")).toEqual({ version: 1, subscriptions: [] });
  });

  it.each([
    ["isn't JSON", "{ not json"],
    ["holds something else", JSON.stringify({ version: 1, subscriptions: "none" })],
  ])("carries on with the login when the registry %s", async (_case, text) => {
    const provider = await fakeProvider();
    const { dataDir, create, service } = await subscriptions();
    await service.add(demo(provider));
    await writeFile(join(dataDir, "subscriptions.json"), text);

    const restarted = await create();
    const summary = await only(restarted);

    expect(summary).toMatchObject({ server: provider.url, username: "demo", needsSecret: false });
    expect(await restarted.recheck(summary?.id ?? "")).toMatchObject({
      account: { state: "active" },
    });
    // Written anew, and good from then on.
    expect(await saved(dataDir, "subscriptions.json")).toEqual({
      version: 1,
      subscriptions: [{ id: summary?.id, original: true, key: `${provider.url}|demo` }],
    });
    expect((await only(await create()))?.id).toBe(summary?.id);
  });

  it("follows what the stable release did with the login, and leaves other entries alone", async () => {
    const [first, second] = [
      await fakeProvider({ password: "first-pass" }),
      await fakeProvider({ password: "other-pass" }),
    ];
    const login = { server: first.url, username: "demo", password: "first-pass" };
    const { dataDir, create, service } = await subscriptions();
    const { id } = await service.add(login);
    // An entry this build can't read, as a later one may keep beside these.
    const later = { id: "added-later", server: "https://tv.example", sealedPassword: "c2VhbGVk" };
    const registry = async () =>
      (await saved(dataDir, "subscriptions.json")) as { subscriptions: unknown[] };
    await writeFile(
      join(dataDir, "subscriptions.json"),
      JSON.stringify({ version: 1, subscriptions: [later, ...(await registry()).subscriptions] }),
    );

    // The saved password no longer the account's, and entered again there.
    const stale = { ...((await saved(dataDir, "subscription.json")) as object) };
    await writeFile(
      join(dataDir, "subscription.json"),
      JSON.stringify({ ...stale, sealedPassword: testSecrets.seal("stale-pass") }),
    );
    expect(await failure((await create()).recheck(id))).toEqual({ kind: "invalid-login" });
    await stableConnects(dataDir, login);
    const same = await create();

    expect((await only(same))?.id).toBe(id);
    expect(await same.recheck(id)).toMatchObject({ account: { state: "active" } });

    // Another account connected there.
    await stableConnects(dataDir, { ...login, server: second.url, password: "other-pass" });
    const other = await only(await create());

    expect(other).toMatchObject({ server: second.url });
    expect(other?.id).not.toBe(id);
    expect((await registry()).subscriptions).toEqual([
      later,
      { id: other?.id, original: true, key: `${second.url}|demo` },
    ]);

    // The subscription removed there.
    await rm(join(dataDir, "subscription.json"));

    expect(await (await create()).list()).toEqual([]);
    expect((await registry()).subscriptions).toEqual([later]);

    // And one connected here again joins what the registry kept.
    const back = await (await create()).add(login);

    expect((await registry()).subscriptions).toEqual([
      later,
      { id: back.id, original: true, key: `${first.url}|demo` },
    ]);
  });
});

describe("several subscriptions", () => {
  const login = (provider: { readonly url: string }, password = "demo") => ({
    server: provider.url,
    username: "demo",
    password,
  });
  const folderOf = (dataDir: string, id: string) => join(dataDir, "subscriptions", id);
  const registryOf = async (dataDir: string) =>
    ((await saved(dataDir, "subscriptions.json")) as { subscriptions: unknown[] }).subscriptions;
  const ids = async (service: Service) => (await service.list()).map((each) => each.id);

  /** Two subscriptions saved one after the other: the original, and one added beside it. */
  async function two(fetchImpl?: typeof fetch) {
    const [first, second] = [
      await fakeProvider({ password: "first-pass" }),
      await fakeProvider({ password: "other-pass" }),
    ];
    const profile = await subscriptions(fetchImpl);
    const original = await profile.service.add(login(first, "first-pass"));
    const beside = await profile.service.add({
      ...login(second, "other-pass"),
      name: " Holiday house ",
    });
    return { ...profile, first, second, original, beside };
  }

  it("saves each beside the others, in the order added, with its login in a place of its own", async () => {
    const { dataDir, create, service, first, second, original, beside } = await two();

    expect(await service.list()).toMatchObject([
      { id: original.id, name: null, server: first.url, needsSecret: false },
      { id: beside.id, name: "Holiday house", server: second.url, needsSecret: false },
    ]);
    // The first is where every release looks for a login; the other keeps the same file in its own folder.
    expect(await saved(dataDir, "subscription.json")).toMatchObject({
      server: first.url,
      sealedPassword: testSecrets.seal("first-pass"),
    });
    expect(await saved(folderOf(dataDir, beside.id), "subscription.json")).toEqual({
      version: 1,
      kind: "xtream",
      server: second.url,
      username: "demo",
      sealedPassword: testSecrets.seal("other-pass"),
      account: expect.objectContaining({ state: "active" }),
    });
    // The registry orders them and names them, and holds no secret, sealed or not.
    const registry = await readFile(join(dataDir, "subscriptions.json"), "utf8");
    expect(JSON.parse(registry)).toEqual({
      version: 1,
      subscriptions: [
        { id: original.id, original: true, key: `${first.url}|demo` },
        { id: beside.id, key: `${second.url}|demo`, name: "Holiday house" },
      ],
    });
    for (const secret of ["first-pass", "other-pass"]) {
      expect(registry).not.toContain(secret);
      expect(registry).not.toContain(testSecrets.seal(secret));
    }
    expect(await service.saved()).toMatchObject([
      { id: original.id, original: true, dir: dataDir, kind: "xtream" },
      { id: beside.id, original: false, dir: folderOf(dataDir, beside.id), kind: "xtream" },
    ]);

    const restarted = await create();

    expect(await ids(restarted)).toEqual([original.id, beside.id]);
    expect(await restarted.recheck(beside.id)).toMatchObject({ account: { state: "active" } });
    expect((await restarted.sourceOf(original.id)).key).toBe(`${first.url}|demo`);
  });

  it("renames and repairs one, and leaves the other as it was", async () => {
    const { dataDir, create, service, original, beside } = await two();
    const [untouched, before] = await service.sources();

    expect(await service.update(original.id, { name: "Northline" })).toMatchObject({
      id: original.id,
      name: "Northline",
    });
    // A password the provider refuses changes nothing.
    expect(await failure(service.update(beside.id, { secret: "wrong" }))).toEqual({
      kind: "invalid-login",
    });
    expect(await saved(folderOf(dataDir, beside.id), "subscription.json")).toMatchObject({
      sealedPassword: testSecrets.seal("other-pass"),
    });
    expect(await service.update(beside.id, { secret: "other-pass", name: null })).toMatchObject({
      id: beside.id,
      name: null,
      needsSecret: false,
    });

    const [first, repaired] = await service.sources();
    // Only the one whose secret was stored anew counts as another login.
    expect(first).toMatchObject({ id: original.id, revision: untouched?.revision });
    expect(repaired?.id).toBe(beside.id);
    expect(repaired?.revision).toBeGreaterThan(before?.revision ?? Infinity);
    expect(await service.stands(before!)).toBe(false);
    expect(await service.stands(untouched!)).toBe(true);
    expect(await (await create()).list()).toMatchObject([
      { id: original.id, name: "Northline" },
      { id: beside.id, name: null },
    ]);
    expect(await failure(service.update("no-such-subscription", { name: "x" }))).toEqual({
      kind: "no-subscription",
    });
  });

  it("removes one with its folder, and the others stay", async () => {
    const { dataDir, create, service, first, original, beside } = await two();
    const third = await service.add(login(await fakeProvider()));

    await service.remove(beside.id);

    expect(await ids(service)).toEqual([original.id, third.id]);
    expect(await readdir(join(dataDir, "subscriptions"))).toEqual([third.id]);
    expect(await failure(service.sourceOf(beside.id))).toEqual({ kind: "no-subscription" });
    expect(await ids(await create())).toEqual([original.id, third.id]);

    // The original goes like any other: the login every release reads, and its entry.
    await service.remove(original.id);

    expect(await saved(dataDir, "subscription.json")).toBeNull();
    expect(await registryOf(dataDir)).toEqual([
      { id: third.id, key: expect.stringContaining("|demo") },
    ]);
    expect(await ids(await create())).toEqual([third.id]);
    // One added while others are saved joins them, and takes no other's place.
    const back = await (await create()).add(login(first, "first-pass"));
    expect(back.id).not.toBe(original.id);
    expect(await saved(dataDir, "subscription.json")).toBeNull();
    expect(await ids(await create())).toEqual([third.id, back.id]);
  });

  it("gives an account one subscription, however often its login is added", async () => {
    const { service, second, original, beside } = await two();

    const again = await service.add({ ...login(second, "other-pass"), name: "Renamed" });

    expect(again).toMatchObject({ id: beside.id, name: "Renamed" });
    expect(await ids(service)).toEqual([original.id, beside.id]);
  });

  it("keeps the added ones through what the stable release does to the login", async () => {
    const { dataDir, create, first, second, original, beside } = await two();
    const third = await fakeProvider();

    // Another account connected there, in the one place it knows.
    await stableConnects(dataDir, login(third));
    const replaced = await (await create()).list();

    expect(replaced).toMatchObject([{ server: third.url }, { id: beside.id, server: second.url }]);
    expect(replaced[0]?.id).not.toBe(original.id);
    expect(await (await create()).recheck(beside.id)).toMatchObject({
      account: { state: "active" },
    });

    // The subscription removed there: the added one is all that is left, and stays.
    await rm(join(dataDir, "subscription.json"));
    expect(await ids(await create())).toEqual([beside.id]);

    // And the first one connected there again, which the stable release takes for its only one.
    await stableConnects(dataDir, login(first, "first-pass"));
    const back = await (await create()).list();
    expect(back).toMatchObject([{ id: beside.id }, { server: first.url }]);
  });

  it("shows an account once when the stable release connects an added one's, and keeps the added one as it was", async () => {
    const { dataDir, create, second, beside } = await two();
    const folder = folderOf(dataDir, beside.id);
    // What the viewer left it at, and a file a later build keeps beside it.
    await writeFile(join(folder, "preferences.json"), JSON.stringify({ lastChannelId: "2014" }));
    await writeFile(join(folder, "later.json"), "{}");
    const kept = async () =>
      Promise.all(
        (await readdir(folder)).sort().map(async (name) => [name, await saved(folder, name)]),
      );
    const before = await kept();

    await stableConnects(dataDir, login(second, "other-pass"));
    const once = await (await create()).list();

    // Where every release finds it, under an id of its own, with the folder untouched.
    expect(once).toMatchObject([{ server: second.url, name: null }]);
    expect(once[0]?.id).not.toBe(beside.id);
    expect(await kept()).toEqual(before);
    expect(await ids(await create())).toEqual(once.map((each) => each.id));

    // Another account connected there: the added one shows again, as it was.
    const third = await fakeProvider();
    await stableConnects(dataDir, login(third));
    expect(await (await create()).list()).toMatchObject([
      { server: third.url },
      { id: beside.id, server: second.url, name: "Holiday house" },
    ]);
    expect(await kept()).toEqual(before);

    // Removed while it shows once, the account goes from both places, and stays gone.
    await stableConnects(dataDir, login(second, "other-pass"));
    const shown = await create();
    await shown.remove((await only(shown))?.id ?? "");

    expect(await ids(await create())).toEqual([]);
    expect(await readdir(join(dataDir, "subscriptions"))).toEqual([]);
    expect(await registryOf(dataDir)).toEqual([]);
  });

  it("lists the added ones again when the registry is damaged or an add was cut short", async () => {
    const { dataDir, create, original, beside } = await two();

    await writeFile(join(dataDir, "subscriptions.json"), "{ not json");
    const recovered = await (await create()).list();

    // The folder names an added one; the original gets an id anew, as without a registry.
    expect(recovered.map((each) => each.server)).toEqual(
      [original, beside].map((each) => each.server),
    );
    expect(recovered[1]?.id).toBe(beside.id);
    expect(await ids(await create())).toEqual(recovered.map((each) => each.id));

    // A login that reached its folder, and an entry that didn't follow.
    const [first] = await registryOf(dataDir);
    await writeFile(
      join(dataDir, "subscriptions.json"),
      JSON.stringify({ version: 1, subscriptions: [first] }),
    );

    expect(await ids(await create())).toEqual(recovered.map((each) => each.id));
  });

  it("settles a removal cut short, and leaves alone what it can't read", async () => {
    const { dataDir, create, original, beside } = await two();
    const unread = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const left = "ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb";
    // A login from a later build, with an entry of its own kind; and lists a removal left behind.
    await mkdir(folderOf(dataDir, unread), { recursive: true });
    await writeFile(join(folderOf(dataDir, unread), "subscription.json"), '{"version":2}');
    await mkdir(folderOf(dataDir, left), { recursive: true });
    await writeFile(join(folderOf(dataDir, left), "catalogue.json"), "{}");
    const registry = await registryOf(dataDir);
    const later = { id: unread, plan: "family" };
    await writeFile(
      join(dataDir, "subscriptions.json"),
      JSON.stringify({ version: 1, subscriptions: [...registry, later] }),
    );
    // The sealed login went, and neither its lists nor the entry that named it followed.
    await writeFile(join(folderOf(dataDir, beside.id), "catalogue.json"), "{}");
    await rm(join(folderOf(dataDir, beside.id), "subscription.json"));

    expect(await ids(await create())).toEqual([original.id]);
    expect(await registryOf(dataDir)).toEqual([registry[0], later]);
    expect((await readdir(join(dataDir, "subscriptions"))).sort()).toEqual([unread]);
    expect(await readFile(join(folderOf(dataDir, unread), "subscription.json"), "utf8")).toBe(
      '{"version":2}',
    );
  });

  it("keeps every subscription when the keychain opens no secret, and repairs one at a time", async () => {
    const { create, original, beside } = await two();
    let opens = false;
    const locked = await create({
      seal: testSecrets.seal,
      open: (sealed) => {
        if (!opens) throw new AppFailure({ kind: "keychain-refused" });
        return testSecrets.open(sealed);
      },
    });

    expect(await locked.list()).toMatchObject([
      { id: original.id, needsSecret: true },
      { id: beside.id, needsSecret: true },
    ]);
    expect(await locked.sources()).toEqual([]);

    opens = true;
    expect(await locked.update(beside.id, { secret: "other-pass" })).toMatchObject({
      id: beside.id,
      needsSecret: false,
    });

    expect((await locked.sources()).map((each) => each.id)).toEqual([beside.id]);
    expect(await failure(locked.sourceOf(original.id))).toEqual({
      kind: "needs-secret",
      subscriptionId: original.id,
    });
  });

  it.each(["on its row", "as the same login added again"])(
    "keeps a removal when a password entered again %s is checked afterwards",
    async (where) => {
      const holdable = holdableFetch();
      const { create, service, second, original, beside } = await two(holdable.fetch);

      const held = holdable.holdNext();
      const repair =
        where === "on its row"
          ? service.update(beside.id, { secret: "other-pass" })
          : service.add(login(second, "other-pass"));
      await held.arrived;
      await service.remove(beside.id);
      held.release();

      expect(await failure(repair)).toEqual({ kind: "no-subscription" });
      expect(await ids(service)).toEqual([original.id]);
      expect(await ids(await create())).toEqual([original.id]);
    },
  );

  it("keeps a password entered on a row when the same login added again is checked afterwards", async () => {
    const holdable = holdableFetch();
    const { service, second, original, beside } = await two(holdable.fetch);

    const held = holdable.holdNext();
    const again = service.add({ ...login(second, "other-pass"), name: "Earlier" });
    await held.arrived;
    const repaired = await service.update(beside.id, { secret: "other-pass", name: "Latest" });
    const [, stored] = await service.sources();
    held.release();

    expect(await again).toEqual(repaired);
    expect(await service.list()).toMatchObject([
      { id: original.id },
      { id: beside.id, name: "Latest" },
    ]);
    expect((await service.sources())[1]?.revision).toBe(stored?.revision);
  });
});
