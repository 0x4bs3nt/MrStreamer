// One owner for explicit online requests. Opaque results and requests end with the exact local
// playback session; saved cues and timing outlast it under the current file's durable identity.
import { createHash, randomUUID } from "node:crypto";
import {
  type OnlineSubtitleChoice,
  type OnlineSubtitlePreferences,
  type OnlineSubtitleSearch,
  type OnlineSubtitleSettings,
  type SavedSubtitle,
  type SubtitleCredentials,
  type SubtitleService,
  SubtitleTiming,
} from "@mrstreamer/contracts/online-subtitles";
import { Failed } from "@mrstreamer/core/failure";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { t } from "@mrstreamer/core/i18n";
import type { SubtitleFile } from "../platform/saved-subtitles.ts";
import type { FileProof } from "../playback/source-identity.ts";
import { SavedSubtitles } from "../platform/saved-subtitles.ts";
import {
  subtitleServiceClient,
  SubtitleRequestFailure,
  type SubtitleCandidate,
  type SubtitleQuery,
} from "../subtitles/service-client.ts";
import { SubtitleAccounts } from "./subtitle-accounts.ts";

/** The exact file a local session plays: same session, account and file, none observed replaced. */
export interface PlayingFile {
  readonly file: SubtitleFile;
  readonly signal: AbortSignal;
  readonly standing: Effect.Effect<boolean, Failed>;
  /** Which bytes play, as the file's answers prove them; null when they don't. */
  readonly proof: () => FileProof | null;
}
/** Main's playback and catalogue adapters agree on a currently listed exact file. */
export interface SubtitleSession extends PlayingFile {
  readonly query: SubtitleQuery | null;
}
export class SubtitleSessions extends Context.Service<
  SubtitleSessions,
  {
    resolve(sessionId: string): Effect.Effect<SubtitleSession | null, Failed>;
    /**
     * What playback alone knows, without asking the catalogue whether the file is still listed.
     * Enough to turn the file's saved result off; never to search, save, show or time one.
     */
    playing(sessionId: string): Effect.Effect<PlayingFile | null, Failed>;
  }
>()("mrstreamer/SubtitleSessions") {}

export class OnlineSubtitles extends Context.Service<
  OnlineSubtitles,
  {
    readonly settings: Effect.Effect<OnlineSubtitleSettings, Failed>;
    configure(
      preferences: OnlineSubtitlePreferences,
      credentials?: SubtitleCredentials,
    ): Effect.Effect<OnlineSubtitleSettings, Failed>;
    search(
      sessionId: string,
      languages?: readonly string[],
    ): Effect.Effect<OnlineSubtitleSearch, Failed>;
    choose(sessionId: string, resultId: string): Effect.Effect<OnlineSubtitleChoice, Failed>;
    saved(sessionId: string): Effect.Effect<SavedSubtitle | null, Failed>;
    timing(
      sessionId: string,
      timing: SubtitleTiming,
      selection?: string,
    ): Effect.Effect<SavedSubtitle, Failed>;
    /** The viewer chose a saved result: by its opaque key, or the selected one without a key. */
    show(sessionId: string, selection?: string): Effect.Effect<void, Failed>;
    /**
     * The viewer chose Off or a file track. Kept for the exact file the session still plays, also
     * when the catalogue can't say just now that it is listed. A session that plays none has
     * nothing to hide.
     */
    hide(sessionId: string): Effect.Effect<void, Failed>;
    forget(sessionId: string): Effect.Effect<void, Failed>;
    cancel(sessionId: string): Effect.Effect<void>;
  }
>()("mrstreamer/OnlineSubtitles") {
  static readonly layer = (deps: Parameters<typeof subtitleServiceClient>[0]) =>
    Layer.effect(OnlineSubtitles, make(deps));
}

interface Search {
  readonly session: SubtitleSession;
  readonly controller: AbortController;
  readonly candidates: Map<string, SubtitleCandidate>;
  readonly removeListener: () => void;
  choice: AbortController | null;
}

function unavailable(detail: string): Failed {
  return new Failed({ error: { kind: "unexpected", detail } });
}
function requestFailure(cause: unknown): Failed {
  return unavailable(
    cause instanceof SubtitleRequestFailure
      ? t("Subtitle service: {reason}.", { reason: cause.reason })
      : t("Subtitle request ended. Try again while this file plays."),
  );
}

function make(deps: Parameters<typeof subtitleServiceClient>[0]) {
  return Effect.gen(function* () {
    const accounts = yield* SubtitleAccounts;
    const storage = yield* SavedSubtitles;
    const sessions = yield* SubtitleSessions;
    const client = subtitleServiceClient(deps);
    const searches = new Map<string, Search>();
    let revision = 0;
    const cancel = (id: string) => {
      const previous = searches.get(id);
      searches.delete(id);
      previous?.controller.abort();
      previous?.choice?.abort();
      previous?.removeListener();
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const id of searches.keys()) cancel(id);
      }),
    );
    const current = (id: string) =>
      Effect.gen(function* () {
        const session = yield* sessions.resolve(id);
        if (!session || session.signal.aborted || !(yield* session.standing))
          return yield* unavailable(t("This exact file is no longer playing here."));
        return session;
      });
    const guarded = (session: SubtitleSession) =>
      Effect.gen(function* () {
        if (session.signal.aborted || !(yield* session.standing))
          return yield* unavailable(t("This exact file changed or stopped playing here."));
      });
    const selectedServices = (settings: OnlineSubtitleSettings): readonly SubtitleService[] =>
      settings.service === "both" ? ["subdl", "opensubtitles"] : [settings.service];
    const configure = (preferences: OnlineSubtitlePreferences, credentials?: SubtitleCredentials) =>
      Effect.gen(function* () {
        const saved = yield* accounts.update(preferences, credentials);
        revision++;
        for (const id of searches.keys()) cancel(id);
        return saved;
      });
    const search = (id: string, languages?: readonly string[]) =>
      Effect.gen(function* () {
        const settings = yield* accounts.get;
        if (!settings.enabled) return yield* unavailable(t("Online subtitle search is off."));
        const session = yield* current(id);
        if (!session.query)
          return yield* unavailable(
            t("This file has no current title identity for subtitle search."),
          );
        cancel(id);
        const controller = new AbortController();
        const abort = () => cancel(id);
        session.signal.addEventListener("abort", abort, { once: true });
        const request: Search = {
          session,
          controller,
          candidates: new Map(),
          choice: null,
          removeListener: () => session.signal.removeEventListener("abort", abort),
        };
        searches.set(id, request);
        const generation = revision;
        const query = { ...session.query, languages: languages ?? settings.languages };
        const signal = AbortSignal.any([session.signal, controller.signal]);
        const answers = yield* Effect.forEach(
          selectedServices(settings),
          (service) =>
            Effect.gen(function* () {
              if (!settings.configured[service])
                return { service, reason: "not-configured" as const };
              const keys = yield* accounts.credentials(service);
              if (!keys) return { service, reason: "not-configured" as const };
              return yield* Effect.tryPromise({
                try: async () => ({
                  service,
                  candidates:
                    service === "subdl"
                      ? await client.subdlSearch(keys, query, signal)
                      : "username" in keys
                        ? await client.openSearch(keys, query, signal)
                        : [],
                }),
                catch: (cause) => cause,
              }).pipe(
                Effect.catch((cause) =>
                  Effect.succeed({
                    service,
                    reason:
                      cause instanceof SubtitleRequestFailure
                        ? cause.reason
                        : ("unavailable" as const),
                  }),
                ),
              );
            }).pipe(
              Effect.catch(() => Effect.succeed({ service, reason: "credentials" as const })),
            ),
          { concurrency: 2 },
        );
        yield* guarded(session);
        if (generation !== revision || signal.aborted || searches.get(id) !== request)
          return yield* unavailable(t("Subtitle search was replaced."));
        const results: OnlineSubtitleSearch["results"][number][] = [];
        const failures: OnlineSubtitleSearch["failures"][number][] = [];
        for (const answer of answers) {
          if ("reason" in answer) {
            failures.push(answer);
            continue;
          }
          for (const candidate of answer.candidates) {
            const key = randomUUID();
            request.candidates.set(key, candidate);
            const { service, language, release, hearingImpaired, downloads } = candidate;
            results.push({ id: key, service, language, release, hearingImpaired, downloads });
          }
        }
        return { results, failures };
      });
    const choose = (id: string, resultId: string) =>
      Effect.gen(function* () {
        const settings = yield* accounts.get;
        if (!settings.enabled) return yield* unavailable(t("Online subtitle search is off."));
        const request = searches.get(id);
        const candidate = request?.candidates.get(resultId);
        if (!request || !candidate || !selectedServices(settings).includes(candidate.service))
          return yield* unavailable(t("Search again for this file before choosing a subtitle."));
        request.choice?.abort();
        const choice = new AbortController();
        request.choice = choice;
        yield* guarded(request.session);
        if (choice.signal.aborted) return yield* unavailable(t("Subtitle choice was replaced."));
        // The fingerprint supplies a cache identity without storing a service download address.
        const key = createHash("sha256")
          .update(
            JSON.stringify([
              candidate.service,
              candidate.service === "subdl" ? candidate.url : candidate.fileId,
            ]),
          )
          .digest("hex");
        const generation = revision;
        const signal = AbortSignal.any([
          request.session.signal,
          request.controller.signal,
          choice.signal,
        ]);
        const cached = yield* storage.result(request.session.file, key);
        if (cached?.subtitle) {
          yield* guarded(request.session);
          if (generation !== revision || signal.aborted || searches.get(id) !== request)
            return yield* unavailable(t("Subtitle choice was replaced."));
          // Saved for the bytes this playback proved, so a download of them takes it along.
          yield* storage.remember(
            request.session.file,
            cached.subtitle,
            key,
            cached.timing,
            request.session.proof(),
          );
          return { saved: cached, quota: null };
        }
        const keys = yield* accounts.credentials(candidate.service);
        if (!keys) return yield* unavailable(t("Set up this subtitle service in Settings."));

        const answer = yield* Effect.tryPromise({
          try: () =>
            client.download(
              candidate,
              candidate.service === "subdl"
                ? { subdl: keys }
                : "username" in keys
                  ? { opensubtitles: keys }
                  : {},
              signal,
            ),
          catch: requestFailure,
        });
        yield* guarded(request.session);
        if (generation !== revision || signal.aborted || searches.get(id) !== request)
          return yield* unavailable(t("Subtitle choice was replaced."));
        yield* storage.remember(
          request.session.file,
          answer.subtitle,
          key,
          undefined,
          request.session.proof(),
        );
        const saved = yield* storage.read(request.session.file);
        if (!saved) return yield* unavailable(t("The downloaded subtitle couldn't be saved."));
        return {
          saved,
          quota: answer.quota ? { service: candidate.service, ...answer.quota } : null,
        };
      });
    return {
      settings: accounts.get,
      configure,
      search,
      choose,
      saved: (id: string) => Effect.flatMap(current(id), (session) => storage.read(session.file)),
      timing: (id: string, timing: SubtitleTiming, selection?: string) =>
        Effect.gen(function* () {
          const session = yield* current(id);
          yield* storage.timing(
            session.file,
            SubtitleTiming().assert(timing),
            selection,
            session.proof(),
          );
          return (yield* storage.read(session.file))!;
        }),
      show: (id: string, selection?: string) =>
        Effect.flatMap(current(id), (session) => storage.show(session.file, selection)),
      hide: (id: string) =>
        Effect.gen(function* () {
          const session = yield* sessions.playing(id);
          if (session && !session.signal.aborted && (yield* session.standing))
            yield* storage.hide(session.file);
        }),
      forget: (id: string) =>
        Effect.gen(function* () {
          cancel(id);
          const session = yield* current(id);
          yield* storage.forget(session.file);
        }),
      cancel: (id: string) => Effect.sync(() => cancel(id)),
    };
  });
}
