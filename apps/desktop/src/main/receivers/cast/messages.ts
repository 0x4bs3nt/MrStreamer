// What a Cast receiver says, read where it arrives. Each message is JSON on a namespace; the
// schemas name only the fields the app uses and let everything else pass unread, so a newer
// receiver's extra fields and message types are ignored rather than trusted. A receiver may send
// null for a field it has nothing to say in, so every optional field takes it.
import { type } from "arktype";
import { lazy } from "@mrstreamer/contracts/lazy";

/** Who the app is on a channel, and the receiver itself, as opposed to an app running on it. */
export const SENDER = "sender-0";
export const PLATFORM = "receiver-0";

export const NAMESPACE = {
  /** Opens and closes the link to the receiver and to an app on it: CONNECT, CLOSE. */
  connection: "urn:x-cast:com.google.cast.tp.connection",
  /** PING and PONG. */
  heartbeat: "urn:x-cast:com.google.cast.tp.heartbeat",
  /** The receiver's apps and volume: LAUNCH, STOP, GET_STATUS, SET_VOLUME, RECEIVER_STATUS. */
  receiver: "urn:x-cast:com.google.cast.receiver",
  /** What the media app plays: LOAD, PLAY, PAUSE, SEEK, STOP, EDIT_TRACKS_INFO, MEDIA_STATUS. */
  media: "urn:x-cast:com.google.cast.media",
} as const;

/** The schemas, built on the first message rather than while the app starts. */
function defineMessages() {
  /** What every answer carries: its type, the request it answers, and why when it refuses. */
  const answer = { type: "string", "requestId?": "number", "reason?": "string | null" } as const;
  const Application = type({
    "appId?": "string | null",
    "sessionId?": "string | null",
    "transportId?": "string | null",
  });
  const Track = type({ trackId: "number", "type?": "string | null" });
  const MediaStatus = type({
    mediaSessionId: "number",
    "playerState?": "string | null",
    "idleReason?": "string | null",
    "currentTime?": "number | null",
    "activeTrackIds?": "number[] | null",
    "media?": type({
      "contentId?": "string | null",
      "duration?": "number | null",
      "tracks?": Track.array().or("null"),
    }).or("null"),
  });
  return {
    Platform: type({ type: "string" }),
    Receiver: type({
      ...answer,
      "status?": type({
        "applications?": Application.array().or("null"),
        "volume?": type({ "level?": "number | null", "muted?": "boolean | null" }).or("null"),
      }).or("null"),
    }),
    Media: type({
      ...answer,
      "detailedErrorCode?": "number | null",
      "status?": MediaStatus.array().or("null"),
    }),
  };
}
const Messages = lazy(defineMessages);
type Messages = ReturnType<typeof Messages>;

export type ReceiverMessage = Messages["Receiver"]["infer"];
export type ReceiverStatus = NonNullable<ReceiverMessage["status"]>;
export type MediaMessage = Messages["Media"]["infer"];
export type MediaStatus = NonNullable<MediaMessage["status"]>[number];

/** A payload's JSON, or undefined when it isn't JSON, which no schema takes. */
function json(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

/** A message on the connection or heartbeat namespace, or null when it isn't one. */
export function readPlatformMessage(payload: string): { readonly type: string } | null {
  const message = Messages().Platform(json(payload));
  return message instanceof type.errors ? null : message;
}

/** A message on the receiver namespace, or null when it isn't one. */
export function readReceiverMessage(payload: string): ReceiverMessage | null {
  const message = Messages().Receiver(json(payload));
  return message instanceof type.errors ? null : message;
}

/** A message on the media namespace, or null when it isn't one. */
export function readMediaMessage(payload: string): MediaMessage | null {
  const message = Messages().Media(json(payload));
  return message instanceof type.errors ? null : message;
}
