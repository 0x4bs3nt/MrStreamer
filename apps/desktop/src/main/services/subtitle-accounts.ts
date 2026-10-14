// Service keys and account details are sealed before writing. Reading settings never opens them
// and saving settings never contacts either subtitle service, even when search is enabled.
import { join } from "node:path";
import { AppFailure } from "@mrstreamer/contracts/errors";
import {
  OnlineSubtitlePreferences,
  type OnlineSubtitleSettings,
  type SubtitleCredentials,
  type SubtitleService,
} from "@mrstreamer/contracts/online-subtitles";
import { failedWith, Failed } from "@mrstreamer/core/failure";
import { type } from "arktype";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { t } from "@mrstreamer/core/i18n";
import { readJsonFile, writeJsonFile } from "../platform/json-file.ts";
import type { Secrets } from "../platform/secrets.ts";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";

const Stored = lazy(() =>
  OnlineSubtitlePreferences().merge({
    subdl: "string | null",
    opensubtitles: "string | null",
  }),
);
type Stored = Infer<typeof Stored>;
const SubDL = lazy(() => type({ apiKey: "0 < string <= 4096" }));
const OpenSubtitles = lazy(() =>
  type({
    apiKey: "0 < string <= 4096",
    username: "0 < string <= 512",
    password: "0 < string <= 4096",
  }),
);
type Credentials = Infer<typeof SubDL> | Infer<typeof OpenSubtitles>;

export class SubtitleAccounts extends Context.Service<
  SubtitleAccounts,
  {
    readonly get: Effect.Effect<OnlineSubtitleSettings, Failed>;
    update(
      preferences: OnlineSubtitlePreferences,
      credentials?: SubtitleCredentials,
    ): Effect.Effect<OnlineSubtitleSettings, Failed>;
    /** Main-only. Call after opt-in and session checks, never for settings or startup. */
    credentials(service: SubtitleService): Effect.Effect<Credentials | null, Failed>;
  }
>()("mrstreamer/SubtitleAccounts") {
  static readonly layer = (dataDir: string, secrets: Secrets) =>
    Layer.effect(SubtitleAccounts, make(dataDir, secrets));
}

function make(dataDir: string, secrets: Secrets) {
  return Effect.gen(function* () {
    const path = join(dataDir, "subtitle-accounts.json");
    const one = yield* Semaphore.make(1);
    let current: Stored | null = null;
    const stored = Effect.tryPromise({
      try: async () => {
        current ??= (await readJsonFile(path, Stored())) ?? {
          enabled: false,
          languages: ["en"],
          service: "both",
          subdl: null,
          opensubtitles: null,
        };
        return current;
      },
      catch: failedWith,
    });
    const settings = ({
      subdl,
      opensubtitles,
      ...preferences
    }: Stored): OnlineSubtitleSettings => ({
      ...preferences,
      configured: { subdl: subdl !== null, opensubtitles: opensubtitles !== null },
    });
    return {
      get: one.withPermits(1)(Effect.map(stored, settings)),
      update: (preferences: OnlineSubtitlePreferences, credentials: SubtitleCredentials = {}) =>
        one.withPermits(1)(
          Effect.gen(function* () {
            const previous = yield* stored;
            const next = yield* Effect.try({
              try: () => ({
                ...previous,
                ...OnlineSubtitlePreferences().assert(preferences),
                ...(credentials.subdl !== undefined
                  ? {
                      subdl:
                        credentials.subdl === null
                          ? null
                          : secrets.seal(JSON.stringify(SubDL().assert(credentials.subdl))),
                    }
                  : {}),
                ...(credentials.opensubtitles !== undefined
                  ? {
                      opensubtitles:
                        credentials.opensubtitles === null
                          ? null
                          : secrets.seal(
                              JSON.stringify(OpenSubtitles().assert(credentials.opensubtitles)),
                            ),
                    }
                  : {}),
              }),
              catch: secretFailure,
            });
            yield* Effect.tryPromise({ try: () => writeJsonFile(path, next), catch: failedWith });
            current = next;
            return settings(next);
          }),
        ),
      credentials: (service: SubtitleService) =>
        one.withPermits(1)(
          Effect.gen(function* () {
            const saved = (yield* stored)[service];
            if (saved === null) return null;
            return yield* Effect.try({
              try: () => {
                const plain: unknown = JSON.parse(secrets.open(saved));
                return service === "subdl" ? SubDL().assert(plain) : OpenSubtitles().assert(plain);
              },
              catch: secretFailure,
            });
          }),
        ),
    };
  });
}

/** Schema failures must not echo a key, password or decoded credential JSON to the UI. */
function secretFailure(cause: unknown): Failed {
  return cause instanceof AppFailure
    ? failedWith(cause)
    : new Failed({
        error: {
          kind: "unexpected",
          detail: t("Subtitle account details couldn't be read or saved."),
        },
      });
}
