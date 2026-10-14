// What a channel that doesn't play says, wherever it says it: the middle of Watch, the mini player,
// the bar at the foot of the pages and the rows of the quality menu. Every word comes from what was
// observed: the kind of failure, the provider's HTTP status, the streams tried, and whether the
// channel never started, broke off, or kept coming back and breaking off. A status names no cause,
// so a refusal is never called a connection limit or a wrong login, and nothing an engine or the
// provider said in words is shown: those can name an address.
import type { AppError } from "@mrstreamer/contracts/errors";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { LivePlaying, StreamFailure } from "@mrstreamer/contracts/playback";
import { t } from "@mrstreamer/core/i18n";
import { describeError } from "../../lib/errors.ts";
import { clockTime } from "../../lib/format.ts";
import { qualityChoices } from "../../lib/quality.ts";
import { outputs } from "../../player/output.ts";
import { STABLE_PLAYBACK_MS, type PlaybackProblem, type PlayerState } from "../../player/player.ts";
import { receiverProblem } from "./Output.tsx";

export type FailedPhase = Extract<PlayerState["phase"], { kind: "failed" }>;
export type ReconnectingPhase = Extract<PlayerState["phase"], { kind: "reconnecting" }>;

/** Which of a channel's streams its last try got to, by the names the quality menu gives them. */
export interface Tried {
  /** In the order tried. */
  readonly names: readonly string[];
  /** How many of the channel's streams it never reached. */
  readonly untried: number;
}

/** The streams `stream` says were tried; null when nothing says, as for a channel a receiver plays. */
export function triedStreams(channel: LiveChannel, stream: LivePlaying | null): Tried | null {
  if (!stream) return null;
  const ids = new Set(stream.failed.map(({ variantId }) => variantId));
  if (stream.variantId) ids.add(stream.variantId);
  const choices = qualityChoices(channel);
  const names = [...ids].flatMap(
    (id) => choices.find(({ variant }) => variant.id === id)?.name ?? [],
  );
  return { names, untried: channel.variants.length - names.length };
}

/**
 * Whether a failure is the stream's own, so another of the channel's streams may play where this
 * one didn't. A refusal isn't counted as one. Its status names no cause, so nothing shows another
 * stream would be let through, and the app stops instead of sending more requests against it. A
 * session that didn't open or a receiver's trouble is no stream's.
 */
export function isStreamsOwn(problem: PlaybackProblem): boolean {
  return problem.kind !== "refused" && problem.kind !== "app" && problem.kind !== "receiver";
}

/** Whether trying the same channel again can help. An unplayable stream stays unplayable. */
export function canRetry(problem: PlaybackProblem): boolean {
  if (problem.kind === "receiver") {
    return receiverProblem(problem.failure, problem.lost, outputs.failedOn(), null).retry;
  }
  if (problem.kind === "app") {
    return !["invalid-login", "needs-secret", "catch-up"].includes(problem.error.kind);
  }
  return problem.kind !== "unsupported";
}

/**
 * The subscription a failed channel is of, as its words need it. `name` stands where "the
 * provider" does once `several` are saved: the same channel may then play from another, so the
 * sentence says whose stream this was. `playlist` is a playlist subscription, which has no
 * connection of its own for another device to hold.
 */
export interface FailedSource {
  readonly name: string;
  readonly playlist: boolean;
  readonly several: boolean;
}

/**
 * A failed channel's title and the sentence under it. `chosen` names the quality picked for the
 * channel when the failure is that stream's own: the pick stays, and the words say so. `source`
 * is the channel's subscription, or null where its words aren't needed.
 */
export function failureCopy(
  { problem, recovery }: FailedPhase,
  channel: LiveChannel,
  context: {
    readonly chosen: string | null;
    readonly source: FailedSource | null;
    readonly tried: Tried | null;
  },
): { readonly title: string; readonly body: string } {
  const { chosen, source, tried } = context;
  const playlist = source?.playlist ?? false;
  /** Whose stream it was: a subscription's name once several are saved, else the provider. */
  const named = source?.several ? source.name : null;
  const name = channel.title;
  const stays = chosen ? ` ${t("Your choice stays {quality}.", { quality: chosen })}` : "";
  const its = chosen
    ? t("{name}'s {quality} stream", { name, quality: chosen })
    : t("{name}'s stream", { name });
  switch (problem.kind) {
    case "unavailable":
      if (chosen) {
        return {
          title: t("No {quality} stream", { quality: chosen }),
          body:
            (named
              ? t("{source} sent no {quality} stream for {name}.", {
                  source: named,
                  quality: chosen,
                  name,
                })
              : t("The provider sent no {quality} stream for {name}.", { quality: chosen, name })) +
            stays,
        };
      }
      if (tried && tried.names.length > 1 && tried.untried === 0) {
        return {
          title: t("No stream right now"),
          body: named
            ? t("{source} lists {name} but sent no stream for any of its qualities.", {
                source: named,
                name,
              })
            : t("The provider lists {name} but sent no stream for any of its qualities.", { name }),
        };
      }
      return {
        title: t("No stream right now"),
        body: named
          ? t("{source} lists {name} but sent no stream for it.", { source: named, name })
          : t("The provider lists {name} but sent no stream for it.", { name }),
      };
    case "refused":
      if (problem.status === 429) {
        return {
          title: t("Provider is limiting requests"),
          body: named
            ? t(
                "{source} answered that it gets too many requests. Wait a moment before trying again.",
                { source: named },
              )
            : t(
                "The provider answered that it gets too many requests. Wait a moment before trying again.",
              ),
        };
      }
      return {
        title: named ? t("Refused by {source}", { source: named }) : t("Refused by the provider"),
        body:
          t("{name}'s stream was turned down.", { name }) + refusalCheck(problem.status, playlist),
      };
    case "provider-error":
      return {
        title: t("Provider error"),
        body:
          (named
            ? t("{source} answered with an error instead of the stream.", { source: named })
            : t("The provider answered with an error instead of the stream.")) + stays,
      };
    case "unsupported":
      return {
        title: chosen
          ? t("Can't play {quality}", { quality: chosen })
          : t("Can't play this stream"),
        body:
          t("{stream} arrived, but Mr. Streamer couldn't play it on this computer.", {
            stream: its,
          }) + stays,
      };
    case "network":
      if (!recovery.played) {
        return problem.unanswered
          ? {
              title: named
                ? t("No answer from {source}", { source: named })
                : t("No answer from the provider"),
              body: t("{stream} never started sending.", { stream: its }) + stays,
            }
          : {
              title: t("No picture arrived"),
              body: t("{stream} sent no picture or sound.", { stream: its }) + stays,
            };
      }
      if (recovery.relapses > 0) {
        const other = !chosen && channel.variants.length > 1;
        const seconds = STABLE_PLAYBACK_MS / 1000;
        const relapses = recovery.relapses;
        return {
          title: t("Keeps dropping"),
          body:
            (relapses === 1
              ? t("{name} came back once and dropped again within {seconds} seconds.", {
                  name,
                  seconds,
                })
              : relapses === 2
                ? t("{name} came back twice and dropped again within {seconds} seconds.", {
                    name,
                    seconds,
                  })
                : t("{name} came back {count} times and dropped again within {seconds} seconds.", {
                    name,
                    count: relapses,
                    seconds,
                  })) + (other ? ` ${t("Another quality may hold better.")}` : stays),
        };
      }
      return {
        title: t("Lost the stream"),
        body:
          (recovery.reconnects > 0
            ? t("{name} stopped arriving and reconnecting didn't bring it back.", { name })
            : t("{name} stopped arriving.", { name })) + stays,
      };
    case "app":
      if (problem.error.kind === "needs-secret") {
        const subscription = source?.name;
        return {
          title: subscription
            ? playlist
              ? t("{name} needs its link again", { name: subscription })
              : t("{name} needs its password again", { name: subscription })
            : playlist
              ? t("This subscription needs its link again")
              : t("This subscription needs its password again"),
          body: t("Its channels play once you enter it. The lists show what it loaded before."),
        };
      }
      return problem.error.kind === "invalid-login"
        ? { title: t("Login not accepted"), body: describeError(problem.error) }
        : { title: t("Can't open this channel"), body: describeOpening(problem.error) };
    case "receiver":
      return receiverProblem(problem.failure, problem.lost, outputs.failedOn(), null);
  }
}

/**
 * What a refusal is worth checking, said as a condition and never as its cause. Only 401 and 403
 * get one: what a panel means by 458 or 509 isn't known.
 */
function refusalCheck(status: number, playlist: boolean): string {
  if (status !== 401 && status !== 403) return "";
  return ` ${
    playlist
      ? t("Some playlist channels only play in certain countries.")
      : t("If another device is watching on this subscription, stop it there first.")
  }`;
}

const QUOTES_NOTHING = new Set<AppError["kind"]>([
  "account-inactive",
  "provider-error",
  "no-subscription",
  "needs-secret",
  "keychain-refused",
  "channel-not-found",
  "catch-up",
]);

/** Why a channel's session didn't open, without what an error quotes: a server's name or an engine's words. */
function describeOpening(error: AppError): string {
  if (QUOTES_NOTHING.has(error.kind)) return describeError(error);
  return error.kind === "unreachable"
    ? t("The provider can't be reached.")
    : t("Mr. Streamer couldn't open it.");
}

/**
 * What was observed of a failure, in one short line: the provider's status, the qualities tried,
 * the reconnects made and when it failed. Empty where the failure isn't a stream's.
 */
export function failureEvidence(
  { problem, recovery, at }: FailedPhase,
  channel: LiveChannel,
  context: { readonly chosen: string | null; readonly tried: Tried | null },
): string {
  if (problem.kind === "app" || problem.kind === "receiver") return "";
  const { chosen, tried } = context;
  return [
    "status" in problem ? `HTTP ${problem.status}` : null,
    chosen
      ? t("{quality} only, as chosen", { quality: chosen })
      : channel.variants.length > 1 && tried
        ? tried.names.join(", ")
        : null,
    recovery.reconnects > 0 ? t("{count} reconnects", { count: recovery.reconnects }) : null,
    clockTime(at, at),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A failed channel in a few words, as the mini player says it. */
export function failureTitle(failed: FailedPhase, channel: LiveChannel): string {
  return failureCopy(failed, channel, { chosen: null, source: null, tried: null }).title;
}

/**
 * A failed channel in one line, as the bar at the foot of the pages says it: its title, and the
 * provider's status when it gave one.
 */
export function failureLine(failed: FailedPhase, channel: LiveChannel): string {
  const title = failureTitle(failed, channel);
  return "status" in failed.problem ? `${title} · HTTP ${failed.problem.status}` : title;
}

/** A channel that reconnects, in a title and a sentence. Which attempt it is at stands beside them. */
export function reconnectingCopy(channel: LiveChannel): {
  readonly title: string;
  readonly body: string;
} {
  return {
    title: t("Reconnecting"),
    body: t("{name}'s stream isn't arriving.", { name: channel.title }),
  };
}

/** "Reconnecting · 2 of 4", as the mini player says it. */
export function reconnectingLine({ attempt, of }: ReconnectingPhase): string {
  return `${t("Reconnecting")} · ${t("{attempt} of {of}", { attempt, of })}`;
}

/**
 * What became of one of a channel's streams, as its row of the quality menu says it: "No stream ·
 * 404". Null for what says nothing of a stream.
 */
export function streamNote(result: StreamFailure | PlaybackProblem): string | null {
  switch (result.kind) {
    case "unavailable":
      return `${t("No stream")} · ${result.status}`;
    case "refused":
      return `${t("Refused")} · ${result.status}`;
    case "provider-error":
      return `${t("Error")} · ${result.status}`;
    case "network":
      return "unanswered" in result && !result.unanswered ? t("No picture") : t("No data");
    case "unsupported":
      return t("Can't play");
    case "app":
    case "receiver":
      return null;
  }
}
