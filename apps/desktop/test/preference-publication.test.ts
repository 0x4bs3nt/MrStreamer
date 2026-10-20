import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type { PreferenceSnapshot } from "@mrstreamer/contracts/ipc";
import { preferencePublication } from "../src/main/preference-publication.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { runtimeFor, tempDir, testSecrets, userAgent } from "./support.ts";

async function setup() {
  const dataDir = await tempDir();
  const runtime = runtimeFor(
    Settings.layer(dataDir).pipe(
      Layer.provide(
        Subscriptions.layer({ dataDir, secrets: testSecrets, providerOptions: { userAgent } }),
      ),
    ),
  );
  const settings = await runtime.runPromise(Settings);
  const events: PreferenceSnapshot[] = [];
  const state = {
    consent: true,
    consentGate: Promise.resolve(),
    reconfigureGate: Promise.resolve(),
    writeFailure: false,
    readFailure: false,
    stale: 0,
  };
  const original = new Error("disk write defect");
  const publication = await Effect.runPromise(
    preferencePublication({
      read: Effect.gen(function* () {
        if (state.readFailure) return yield* Effect.die(new Error("composed read defect"));
        return { ...(yield* settings.get), analyticsEnabled: state.consent };
      }),
      write: (patch) => (state.writeFailure ? Effect.die(original) : settings.update(patch)),
      consent: (enabled) =>
        Effect.promise(async () => {
          await state.consentGate;
          state.consent = enabled;
        }),
      reconfigure: Effect.promise(() => state.reconfigureGate),
      publish: (snapshot) => events.push(snapshot),
      stale: () => state.stale++,
    }),
  );
  return { publication, state, events, original, dataDir };
}

describe("composed preference publication", () => {
  it("orders get/update/events, publishes consent-only edits, retains concurrent unrelated fields and stores no revision", async () => {
    const { publication, events, dataDir } = await setup();
    const first = await Effect.runPromise(publication.get);
    expect(first.revision).toBe(1);
    expect(await Effect.runPromise(publication.get)).toEqual(first);
    const consent = await Effect.runPromise(publication.update({ analyticsEnabled: false }));
    expect(consent).toEqual(events.at(-1));
    expect(consent.preferences.analyticsEnabled).toBe(false);
    await Promise.all([
      Effect.runPromise(publication.update({ audioLanguage: "nl" })),
      Effect.runPromise(publication.update({ subtitleLanguage: "fr" })),
    ]);
    const final = await Effect.runPromise(publication.get);
    expect(final.preferences).toMatchObject({
      audioLanguage: "nl",
      subtitleLanguage: "fr",
      analyticsEnabled: false,
    });
    expect(events.map((event) => event.revision)).toEqual(events.map((_, index) => index + 1));
    expect(events.at(-1)).toEqual(final);
    const stored = JSON.parse(await readFile(join(dataDir, "preferences.json"), "utf8"));
    expect(stored).not.toHaveProperty("revision");
    expect(stored).not.toHaveProperty("analyticsEnabled");
  });

  it.each(["consent", "reconfigure"] as const)(
    "keeps reads independent of a slow %s operation",
    async (owner) => {
      const { publication, state } = await setup();
      await Effect.runPromise(publication.get);
      const gate = Promise.withResolvers<void>();
      if (owner === "consent") state.consentGate = gate.promise;
      else state.reconfigureGate = gate.promise;
      const save = Effect.runPromise(
        publication.update(
          owner === "consent" ? { analyticsEnabled: false } : { tmdbKey: "fixture" },
        ),
      );
      try {
        const result = await Effect.runPromise(
          publication.get.pipe(Effect.timeout("1 second")),
        ).then((snapshot) => ({ snapshot }));
        expect(result.snapshot.preferences.volume).toBe(1);
        const other = await Effect.runPromise(publication.update({ muted: true }));
        expect(other.preferences.muted).toBe(true);
      } finally {
        gate.resolve();
        await save;
      }
    },
  );

  it("publishes committed consent before preserving a viewing-write defect", async () => {
    const { publication, state, events, original } = await setup();
    await Effect.runPromise(publication.get);
    state.writeFailure = true;
    const failed = await Effect.runPromiseExit(
      publication.update({ analyticsEnabled: false, muted: true }),
    );
    expect(Exit.isFailure(failed)).toBe(true);
    expect(failed).toEqual(await Effect.runPromiseExit(Effect.die(original)));
    expect(events.at(-1)).toEqual({
      revision: 2,
      preferences: {
        volume: 1,
        muted: false,
        nextEpisodeDelaySeconds: 10,
        analyticsEnabled: false,
      },
    });
  });

  it("publishes a committed key before preserving reconfiguration failure", async () => {
    const { publication, state, events } = await setup();
    await Effect.runPromise(publication.get);
    const gate = Promise.withResolvers<void>();
    state.reconfigureGate = gate.promise;
    void gate.promise.catch(() => {});
    const save = Effect.runPromiseExit(publication.update({ tmdbKey: "fixture" }));
    gate.reject(new Error("worker stop failed"));
    const result = await save;
    expect(Exit.isFailure(result)).toBe(true);
    expect(events.at(-1)?.preferences.tmdbKey).toBe("fixture");
    expect(events.at(-1)?.revision).toBe(2);
  });

  it("marks an unreadable composition stale without inventing a revision, preserving the original failure", async () => {
    const { publication, state, events, original } = await setup();
    const first = await Effect.runPromise(publication.get);
    state.writeFailure = true;
    state.readFailure = true;
    const result = await Effect.runPromiseExit(
      publication.update({ analyticsEnabled: false, muted: true }),
    );
    const expected = await Effect.runPromiseExit(Effect.die(original));
    expect(result).toEqual(expected);
    expect(events).toEqual([first]);
    expect(state.stale).toBe(1);
    state.readFailure = false;
    expect((await Effect.runPromise(publication.get)).preferences.analyticsEnabled).toBe(false);
    expect(events.at(-1)?.revision).toBe(2);
  });
});
