import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import type { OnlineSubtitles } from "../services/online-subtitles.ts";

export function subtitleHandlers({
  onlineSubtitles,
}: {
  readonly onlineSubtitles: OnlineSubtitles["Service"];
}): HandlersFor<"subtitles"> {
  return {
    "subtitles.settings": () => onlineSubtitles.settings,
    "subtitles.configure": ({ preferences, credentials }) =>
      onlineSubtitles.configure(preferences, credentials),
    "subtitles.search": ({ sessionId, languages }) => onlineSubtitles.search(sessionId, languages),
    "subtitles.choose": ({ sessionId, resultId }) => onlineSubtitles.choose(sessionId, resultId),
    "subtitles.saved": ({ sessionId }) => onlineSubtitles.saved(sessionId),
    "subtitles.timing": ({ sessionId, timing, selection }) =>
      onlineSubtitles.timing(sessionId, timing, selection),
    "subtitles.show": ({ sessionId, selection }) =>
      Effect.as(onlineSubtitles.show(sessionId, selection), null),
    "subtitles.hide": ({ sessionId }) => Effect.as(onlineSubtitles.hide(sessionId), null),
    "subtitles.forget": ({ sessionId }) => Effect.as(onlineSubtitles.forget(sessionId), null),
    "subtitles.cancel": ({ sessionId }) => Effect.as(onlineSubtitles.cancel(sessionId), null),
  };
}
