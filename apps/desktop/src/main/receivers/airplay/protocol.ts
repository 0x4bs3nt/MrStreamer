// What the app and its AirPlay helper say to each other: one JSON object per line, commands down
// the helper's stdin and events up its stdout. The helper's side is apps/desktop/native/airplay.
//
// Every command gets an id here and exactly one `answer` naming it. Everything else the helper
// says is news: what the system sees, what the viewer did with its list of receivers, and what
// the player holds. The helper also says `log` and `error` lines for a person to read, and every
// line carries `t`, milliseconds since it started; neither is read here.
import { type } from "arktype";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";
import type { ScreenRect } from "../adapter.ts";

/** What the helper must name in `hello`. A helper of another build may speak another. */
export const PROTOCOL = 1;

/** A longer line is dropped whole, by the helper and by the app. */
export const MAX_LINE = 64 * 1024;

export type HelperCommand =
  /** Looks for receivers while `on`; `routes` says what it sees. */
  | { readonly cmd: "detect"; readonly on: boolean }
  /**
   * Opens the system's list at `anchor`. The `picker` events that follow name `request`, so a
   * late one of an earlier list is told apart.
   */
  | { readonly cmd: "showPicker"; readonly request: number; readonly anchor: ScreenRect }
  | { readonly cmd: "hidePicker" }
  /** Has the player hold `url` in place of what it held. */
  | {
      readonly cmd: "load";
      readonly generation: number;
      readonly url: string;
      readonly position: number;
      readonly paused: boolean;
      readonly live: boolean;
      readonly subtitles: boolean;
    }
  | { readonly cmd: "play"; readonly generation: number }
  | { readonly cmd: "pause"; readonly generation: number }
  | { readonly cmd: "seek"; readonly generation: number; readonly position: number }
  | { readonly cmd: "subtitles"; readonly generation: number; readonly on: boolean }
  /** Ends the load; a connected receiver stays. */
  | { readonly cmd: "stop"; readonly generation: number }
  /** Has the player hold nothing of the app's, nor a receiver's picture once the list is closed. */
  | { readonly cmd: "unload" }
  | { readonly cmd: "volume"; readonly level?: number; readonly muted?: boolean }
  /** Answered, then the helper exits. It also exits when its stdin closes. */
  | { readonly cmd: "quit" };

/** The helper's events, built on first use rather than while the app starts. */
function defineEvent() {
  return (
    type({ type: "'hello'", protocol: "number" })
      .or({ type: "'answer'", id: "number", ok: "boolean", "error?": "string" })
      .or({ type: "'routes'", available: "boolean" })
      /**
       * `opened`: the list shows. `manual`: it didn't open by itself, and the picker's own button
       * shows at the anchor for the viewer to press. `closed`: the list, or that button, is gone.
       */
      .or({ type: "'picker'", request: "number", state: "'opened' | 'manual' | 'closed'" })
      /** Whether the player plays on a receiver. Only this counts as connected. */
      .or({ type: "'external'", active: "boolean" })
      .or({
        type: "'status'",
        generation: "number",
        /** `ended` only once the media played to its end; `stopped` once the player let go of it. */
        state: "'loading' | 'buffering' | 'playing' | 'paused' | 'ended' | 'stopped'",
        position: "number >= 0",
        duration: "number > 0 | null",
      })
      /** The player couldn't play the load, and holds it no more. */
      .or({ type: "'failed'", generation: "number", message: "string" })
      .or({ type: "'volume'", level: "0 <= number <= 1", muted: "boolean" })
  );
}
const Event = lazy(defineEvent);

export type HelperEvent = Infer<typeof Event>;

/** The event on a line, or null for anything else: other JSON, other types, or no JSON at all. */
export function readEvent(line: string): HelperEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const event = Event()(parsed);
  return event instanceof type.errors ? null : event;
}
