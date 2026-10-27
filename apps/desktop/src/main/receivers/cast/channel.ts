// A Cast channel: one TLS connection to a receiver, carrying messages that each name a namespace,
// who they are from and for, and a JSON text. On the wire a message is a protobuf `CastMessage`
// behind its length in four bytes. That one message is all the app ever reads or writes, so its
// few fields are coded here by hand instead of with a protobuf library.
//
// The channel keeps the heartbeat too: it pings the receiver, answers the receiver's pings, and
// counts the connection as broken once nothing arrived for a while.
import { connect } from "node:tls";
import { ReceiverFailed } from "../adapter.ts";
import { NAMESPACE, PLATFORM, SENDER, readPlatformMessage } from "./messages.ts";

/** The protocol's limit on one frame's message. */
const MAX_FRAME = 65_535;
/**
 * The most a message sent in several frames may add up to, and the most frames it may take. The
 * app announces protocol version 1.0, which has no such messages, so none should arrive; one that
 * does is put together within these limits, and one beyond them ends the connection.
 */
const MAX_MESSAGE = 4 * MAX_FRAME;
const MAX_FRAGMENTS = 64;
/** How deep groups, protobuf's old nested fields, may go in a field that is skipped. */
const MAX_DEPTH = 16;
/** Milliseconds a closed connection gets to send what was written before it is cut. */
const LINGER = 1000;

export interface CastMessage {
  readonly sourceId: string;
  readonly destinationId: string;
  readonly namespace: string;
  /** The payload's text: JSON on every namespace the app speaks. */
  readonly payload: string;
}

/** One frame's part of a message. */
interface Fragment {
  readonly sourceId: string;
  readonly destinationId: string;
  readonly namespace: string;
  /** The text's bytes, or null for a binary payload, which the app reads none of. */
  readonly payload: Buffer | null;
  /** More of the message follows in the next frame, `remaining` bytes when the receiver says. */
  readonly continued: boolean;
  readonly remaining: number;
}

/** A protobuf varint: seven bits a byte, lowest first, the top bit set on all but the last. */
function varint(value: number): number[] {
  const bytes = [];
  for (; value > 0x7f; value >>>= 7) bytes.push((value & 0x7f) | 0x80);
  return [...bytes, value];
}

/** The varint at `at` and where it ends, or null when it runs off the end or past ten bytes. */
function readVarint(bytes: Buffer, at: number): { value: number; next: number } | null {
  let value = 0;
  for (let index = 0; index < 10; index++) {
    const byte = bytes[at + index];
    if (byte === undefined) return null;
    value += (byte & 0x7f) * 2 ** (7 * index);
    if (byte < 0x80) return { value, next: at + index + 1 };
  }
  return null;
}

/**
 * The value at `at` of the field `tag` announced: a varint's number, a length-delimited field's
 * bytes, or neither for the wire types no field of a `CastMessage` has, and where the next field
 * starts. Null when it runs past the end of the frame or isn't protobuf.
 */
function readField(
  bytes: Buffer,
  at: number,
  tag: number,
  depth = 0,
): { next: number; number?: number; bytes?: Buffer } | null {
  // No field has number 0.
  if (tag < 8) return null;
  switch (tag % 8) {
    case 0: {
      const number = readVarint(bytes, at);
      return number && { next: number.next, number: number.value };
    }
    case 1:
      return at + 8 <= bytes.length ? { next: at + 8 } : null;
    case 2: {
      const length = readVarint(bytes, at);
      if (!length || length.value > bytes.length - length.next) return null;
      const end = length.next + length.value;
      return { next: end, bytes: bytes.subarray(length.next, end) };
    }
    case 3: {
      // A group: fields up to the end tag of its own number, which is its start tag plus one.
      if (depth >= MAX_DEPTH) return null;
      for (let offset = at; ;) {
        const inner = readVarint(bytes, offset);
        if (!inner) return null;
        if (inner.value % 8 === 4) return inner.value === tag + 1 ? { next: inner.next } : null;
        const field = readField(bytes, inner.next, inner.value, depth + 1);
        if (!field) return null;
        offset = field.next;
      }
    }
    case 5:
      return at + 4 <= bytes.length ? { next: at + 4 } : null;
    default:
      return null;
  }
}

/** A message as one frame's bytes. Throws a RangeError for one over the protocol's limit. */
function encodeFrame(message: CastMessage): Buffer {
  const text = (field: number, value: string) => {
    const bytes = Buffer.from(value, "utf8");
    return [Buffer.from([(field << 3) | 2, ...varint(bytes.length)]), bytes];
  };
  const body = Buffer.concat([
    // protocol_version: CASTV2_1_0.
    Buffer.from([1 << 3, 0]),
    ...text(2, message.sourceId),
    ...text(3, message.destinationId),
    ...text(4, message.namespace),
    // payload_type: STRING.
    Buffer.from([5 << 3, 0]),
    ...text(6, message.payload),
  ]);
  if (body.length > MAX_FRAME) throw new RangeError("Cast message over the frame limit");
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length);
  body.copy(frame, 4);
  return frame;
}

/**
 * What one frame holds, or null when it isn't a `CastMessage`: it must be protobuf and name who
 * it is from, who it is for and its namespace. Fields the app doesn't know, of any wire type, are
 * skipped, as are known ones sent as another type. A missing version or payload type is let
 * pass, which a stricter reader of the schema would refuse.
 */
function decodeFrame(body: Buffer): Fragment | null {
  let sourceId = "";
  let destinationId = "";
  let namespace = "";
  let payload: Buffer = Buffer.alloc(0);
  let binary = false;
  let continued = false;
  let remaining = 0;
  for (let offset = 0; offset < body.length;) {
    const tag = readVarint(body, offset);
    const field = tag && readField(body, tag.next, tag.value);
    if (!field) return null;
    offset = field.next;
    const number = Math.floor(tag.value / 8);
    if (field.bytes) {
      if (number === 2) sourceId = field.bytes.toString("utf8");
      else if (number === 3) destinationId = field.bytes.toString("utf8");
      else if (number === 4) namespace = field.bytes.toString("utf8");
      else if (number === 6) payload = field.bytes;
      else if (number === 7) binary = true;
    } else if (field.number !== undefined) {
      if (number === 5) binary ||= field.number !== 0;
      else if (number === 8) continued = field.number !== 0;
      else if (number === 9) remaining = field.number;
    }
  }
  if (!sourceId || !destinationId || !namespace) return null;
  return {
    sourceId,
    destinationId,
    namespace,
    payload: binary ? null : payload,
    continued,
    remaining,
  };
}

/**
 * Turns the bytes a socket delivers into the messages they complete: call it with each chunk.
 * It holds at most one unfinished frame and the parts of one unfinished message, and returns
 * null for what isn't the protocol, after which the connection is of no use: a frame over the
 * limit, a frame that isn't a `CastMessage`, or a message in parts that grows past its limit or
 * is cut into by another.
 */
function messageReader(): (chunk: Buffer) => CastMessage[] | null {
  /** What arrived of the unfinished frame, and how many bytes say how it goes on. */
  let held: Buffer[] = [];
  let size = 0;
  let wanted = 4;
  let parts: { readonly first: Fragment; readonly payloads: Buffer[]; size: number } | null = null;

  return (chunk) => {
    held.push(chunk);
    size += chunk.length;
    const messages: CastMessage[] = [];
    // Chunks are joined only once they hold a length or a whole frame, however small they come.
    if (size < wanted) return messages;
    let buffered = held.length === 1 ? chunk : Buffer.concat(held);
    for (;;) {
      wanted = 4;
      if (buffered.length < wanted) break;
      const length = buffered.readUInt32BE(0);
      if (length > MAX_FRAME) return null;
      wanted += length;
      if (buffered.length < wanted) break;
      const fragment = decodeFrame(buffered.subarray(4, 4 + length));
      buffered = buffered.subarray(4 + length);
      if (!fragment) return null;
      if (fragment.payload === null) continue;

      const { first } = (parts ??= { first: fragment, payloads: [], size: 0 });
      if (
        first.sourceId !== fragment.sourceId ||
        first.destinationId !== fragment.destinationId ||
        first.namespace !== fragment.namespace
      ) {
        return null;
      }
      parts.payloads.push(fragment.payload);
      parts.size += fragment.payload.length;
      const expected = parts.size + (fragment.continued ? fragment.remaining : 0);
      if (expected > MAX_MESSAGE || parts.payloads.length > MAX_FRAGMENTS) return null;
      if (fragment.continued) continue;
      messages.push({
        sourceId: first.sourceId,
        destinationId: first.destinationId,
        namespace: first.namespace,
        payload: Buffer.concat(parts.payloads).toString("utf8"),
      });
      parts = null;
    }
    held = buffered.length > 0 ? [buffered] : [];
    size = buffered.length;
    return messages;
  };
}

export interface Channel {
  /** This computer's address on the connection: the one the receiver reaches it at. */
  readonly localAddress: string | null;
  /**
   * Sends `payload` as JSON on `namespace`. Throws a RangeError for a message over the protocol's
   * limit; does nothing once the channel closed.
   */
  send(destinationId: string, namespace: string, payload: object): void;
  /** Closes the connection once what was sent has gone out. `broken` isn't told. */
  close(): void;
}

export interface ChannelOptions {
  readonly host: string;
  readonly port: number;
  /** Milliseconds the connection may take to open. */
  readonly deadline: number;
  /** Milliseconds between pings, and how long nothing may arrive before it counts as broken. */
  readonly ping: number;
  readonly silence: number;
  /** Gives up opening when it aborts. An open channel is closed with `close`. */
  readonly signal: AbortSignal;
  /** Hears every message but the heartbeat's; a thrown reply failure breaks the channel. */
  readonly message: (message: CastMessage) => void;
  /**
   * The open connection is gone: the socket failed, the receiver went silent, or it sent what
   * isn't the protocol, or a reply could not be sent. Told once, and never after `close`.
   */
  readonly broken: () => void;
}

/** Opens a channel to a receiver. Rejects with `ReceiverFailed` when it doesn't open. */
export function openChannel(options: ChannelOptions): Promise<Channel> {
  const { promise, resolve, reject } = Promise.withResolvers<Channel>();
  let state: "opening" | "open" | "closed" = "opening";
  let heartbeat: NodeJS.Timeout | undefined;
  let heard = 0;
  let quiet = false;
  const read = messageReader();

  // The receiver's certificate is not verified, and the connection proves nothing about who
  // answers. A Cast receiver presents a self-signed certificate that chains to no public CA, so
  // ordinary TLS verification has nothing to check it against. What tells a real receiver from
  // an impostor is Cast's device authentication (urn:x-cast:com.google.cast.tv.deviceauth): the
  // receiver signs a challenge with a key that Google's device CA certified. Verifying that
  // takes the CA's certificates and the exchange itself, which a sender outside Google's SDK
  // would have to ship, and this one doesn't: it never asks. So TLS here only keeps the channel
  // from being read in passing, and whatever answers the browse on the local network is taken
  // for the receiver. It gets what a receiver gets: an address on this computer with a token
  // for one load, and the title's name and picture. No provider address and no login goes to a
  // receiver.
  const socket = connect({ host: options.host, port: options.port, rejectUnauthorized: false });
  socket.setNoDelay(true);

  const settle = () => {
    state = "closed";
    clearTimeout(opening);
    clearInterval(heartbeat);
    options.signal.removeEventListener("abort", fail);
  };
  /** Cuts the connection: it didn't open, or what it carries is of no use any more. */
  const fail = () => {
    if (state === "closed") return;
    const opened = state === "open";
    settle();
    socket.destroy();
    if (opened) options.broken();
    else reject(new ReceiverFailed({ kind: "unreachable" }));
  };
  const send: Channel["send"] = (destinationId, namespace, payload) => {
    if (state !== "open") return;
    socket.write(
      encodeFrame({ sourceId: SENDER, destinationId, namespace, payload: JSON.stringify(payload) }),
    );
  };

  const opening = setTimeout(fail, options.deadline);
  options.signal.addEventListener("abort", fail);
  if (options.signal.aborted) fail();

  socket.on("error", fail);
  socket.on("close", fail);
  socket.once("secureConnect", () => {
    if (state !== "opening") return;
    state = "open";
    clearTimeout(opening);
    options.signal.removeEventListener("abort", fail);
    heard = performance.now();
    heartbeat = setInterval(() => {
      // A timer that runs late, after this process stood still, can find the silence over while
      // what the receiver sent waits to be read: the silence must outlast one more ping.
      const silent = performance.now() - heard > options.silence;
      if (silent && quiet) return fail();
      quiet = silent;
      send(PLATFORM, NAMESPACE.heartbeat, { type: "PING" });
    }, options.ping);
    resolve({
      localAddress: socket.localAddress ?? null,
      send,
      close() {
        if (state === "closed") return;
        settle();
        socket.end();
        setTimeout(() => socket.destroy(), LINGER).unref();
      },
    });
  });
  socket.on("data", (chunk: Buffer) => {
    if (state !== "open") return;
    const messages = read(chunk);
    if (!messages) return fail();
    heard = performance.now();
    for (const message of messages) {
      // A message may have closed the channel: the ones behind it are for nobody.
      if (state !== "open") return;
      try {
        if (message.namespace !== NAMESPACE.heartbeat) options.message(message);
        else if (readPlatformMessage(message.payload)?.type === "PING") {
          send(message.sourceId, NAMESPACE.heartbeat, { type: "PONG" });
        }
      } catch {
        // Receiver identifiers can fit incoming messages but leave no room for our reply.
        return fail();
      }
    }
  });
  return promise;
}
